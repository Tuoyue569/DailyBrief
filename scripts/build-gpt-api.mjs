#!/usr/bin/env node
/**
 * Build a read-only, static JSON API for a Custom GPT.
 *
 * The API is published with GitHub Pages and refreshed by GitHub Actions.
 * It fetches the latest distilled Serenity files from GitHub, compares them
 * with the previous published snapshot, and emits compact GPT-friendly JSON.
 *
 * No third-party dependencies are required (Node 20+).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const API_VERSION = "1.0.0";
const OUT_ROOT = process.env.GPT_API_OUTPUT_DIR || "daily_reports";
const API_ROOT = path.join(OUT_ROOT, "api", "v1");
const STATE_PATH = path.join(OUT_ROOT, "api", "state.json");
const SOURCE_REPO = process.env.SERENITY_REPO || "yan-labs/serenity-aleabitoreddit";
const SOURCE_REF = process.env.SERENITY_REF || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const FIXTURE_DIR = process.env.GPT_API_FIXTURE_DIR || "";
const GENERATED_AT = new Date().toISOString();

const SOURCE_FILES = {
  skill: "serenity-aleabitoreddit/SKILL.md",
  methodology: "serenity-aleabitoreddit/references/methodology.md",
  theses: "serenity-aleabitoreddit/references/theses.md",
  articles: "serenity-aleabitoreddit/references/articles.md",
  trackRecord: "serenity-aleabitoreddit/references/track-record.md",
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function normalizeUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function deriveBaseUrl() {
  if (process.env.PUBLIC_BASE_URL) return normalizeUrl(process.env.PUBLIC_BASE_URL);
  const slug = process.env.GITHUB_REPOSITORY || "";
  const [owner, repo] = slug.split("/");
  if (owner && repo) {
    if (repo.toLowerCase() === `${owner.toLowerCase()}.github.io`) {
      return `https://${owner}.github.io`;
    }
    return `https://${owner}.github.io/${repo}`;
  }
  return "https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPOSITORY";
}

const BASE_URL = deriveBaseUrl();

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function compactWhitespace(value) {
  return String(value || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
}

function truncate(value, max = 8000) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} characters]`;
}

function markdownLinksToText(text) {
  return String(text || "").replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1 ($2)");
}

function extractMarkdownUrl(text) {
  return String(text || "").match(/\((https?:\/\/[^)]+)\)/)?.[1]
    || String(text || "").match(/https?:\/\/\S+/)?.[0]?.replace(/[),.;]+$/, "")
    || null;
}

async function githubJson(url) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "dailybrief-serenity-gpt-api",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (GH_TOKEN) headers.Authorization = `Bearer ${GH_TOKEN}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${url}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

async function fetchSource(alias, sourcePath) {
  if (FIXTURE_DIR) {
    const fixturePath = path.join(FIXTURE_DIR, `${alias}.md`);
    const content = fs.readFileSync(fixturePath, "utf8");
    return {
      alias,
      path: sourcePath,
      content,
      sha: sha256(content),
      htmlUrl: `fixture://${alias}`,
      lastCommitAt: GENERATED_AT,
      lastCommitSha: sha256(content).slice(0, 40),
    };
  }

  const encodedPath = sourcePath.split("/").map(encodeURIComponent).join("/");
  const contentsUrl = `https://api.github.com/repos/${SOURCE_REPO}/contents/${encodedPath}?ref=${encodeURIComponent(SOURCE_REF)}`;
  const data = await githubJson(contentsUrl);
  if (Array.isArray(data) || !data.content) throw new Error(`Expected file content for ${sourcePath}`);
  const content = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");

  let lastCommitAt = null;
  let lastCommitSha = null;
  try {
    const commitsUrl = `https://api.github.com/repos/${SOURCE_REPO}/commits?path=${encodeURIComponent(sourcePath)}&sha=${encodeURIComponent(SOURCE_REF)}&per_page=1`;
    const commits = await githubJson(commitsUrl);
    const commit = Array.isArray(commits) ? commits[0] : null;
    lastCommitAt = commit?.commit?.committer?.date || commit?.commit?.author?.date || null;
    lastCommitSha = commit?.sha || null;
  } catch (error) {
    console.warn(`[gpt-api] commit metadata unavailable for ${sourcePath}: ${error.message}`);
  }

  return {
    alias,
    path: sourcePath,
    content,
    sha: data.sha || sha256(content),
    htmlUrl: data.html_url || `https://github.com/${SOURCE_REPO}/blob/${SOURCE_REF}/${sourcePath}`,
    lastCommitAt,
    lastCommitSha,
  };
}

function fieldFromBlock(block, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`^- \\*\\*${escaped}\\*\\*:\\s*(.+)$`, "mi"));
  return match ? compactWhitespace(markdownLinksToText(match[1])) : null;
}

function parseTheses(markdown) {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const entries = [];
  let current = null;

  function finish() {
    if (!current) return;
    const block = current.body.join("\n").trim();
    const tickerMatch = current.heading.match(/^\$?([A-Z0-9.\-:]+)/i);
    if (!tickerMatch) {
      current = null;
      return;
    }
    const ticker = tickerMatch[1].toUpperCase();
    const company = current.heading.match(/\(([^)]+)\)/)?.[1] || null;
    const view = fieldFromBlock(block, "View");
    const latestSignal = fieldFromBlock(block, "Latest signal");
    const postRaw = fieldFromBlock(block, "Post");
    const keyQuote = fieldFromBlock(block, "Key quote");
    const thesisType = fieldFromBlock(block, "Thesis type");
    const fingerprint = sha256(JSON.stringify({ ticker, view, latestSignal, thesisType, updatedAt: current.updatedAt }));
    entries.push({
      ticker,
      company,
      updatedAt: current.updatedAt,
      view,
      latestSignal,
      post: postRaw,
      postUrl: extractMarkdownUrl(block.match(/^- \*\*Post\*\*:\s*(.+)$/mi)?.[1] || ""),
      keyQuote,
      thesisType,
      evidenceExcerpt: truncate(markdownLinksToText(block), 4500),
      fingerprint,
    });
    current = null;
  }

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s+[—-]\s+Last updated:\s*(.+?)\s*$/i);
    if (heading) {
      finish();
      current = { heading: heading[1].trim(), updatedAt: heading[2].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  finish();
  return entries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function parseArticles(markdown) {
  const rows = [];
  for (const line of markdown.replace(/\r/g, "").split("\n")) {
    if (!/^\|\s*20\d{2}-\d{2}-\d{2}\s*\|/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((x) => x.trim());
    if (cells.length < 5) continue;
    rows.push({
      date: cells[0],
      shareTweetId: cells[1].replace(/`/g, ""),
      articleUrl: extractMarkdownUrl(cells[2]) || cells[2],
      title: compactWhitespace(cells[3]),
      portfolioRelevance: compactWhitespace(cells.slice(4).join(" | ")),
    });
  }

  const sections = [];
  const chunks = markdown.split(/^###\s+/m).slice(1);
  for (const chunk of chunks) {
    const [titleLine, ...body] = chunk.split("\n");
    sections.push({
      title: titleLine.trim(),
      summary: truncate(markdownLinksToText(body.join("\n").trim()), 7000),
    });
  }
  return { index: rows, sections };
}

function parseMethodology(markdown) {
  const principles = [];
  const chunks = markdown.split(/^##\s+/m).slice(1);
  for (const chunk of chunks) {
    const [titleLine, ...bodyLines] = chunk.split("\n");
    const title = titleLine.trim();
    if (!/^\d+\./.test(title) && !/checklist/i.test(title)) continue;
    principles.push({
      title,
      content: truncate(markdownLinksToText(bodyLines.join("\n").trim()), 8000),
    });
  }
  return principles;
}

function parseTrackRecord(markdown) {
  const calibrationStart = markdown.search(/^##\s+Calibration note/im);
  const calibration = calibrationStart >= 0 ? markdown.slice(calibrationStart) : markdown.slice(-30000);
  const reversalsStart = calibration.search(/\*\*Calls that were wrong, reversed/i);
  const caveatsStart = calibration.search(/\*\*The unavoidable caveats/i);
  return {
    calibration: truncate(markdownLinksToText(calibration), 30000),
    reversals: reversalsStart >= 0 ? truncate(markdownLinksToText(calibration.slice(reversalsStart, caveatsStart > reversalsStart ? caveatsStart : undefined)), 12000) : null,
    caveats: caveatsStart >= 0 ? truncate(markdownLinksToText(calibration.slice(caveatsStart)), 12000) : null,
  };
}

function readPreviousState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function compareState(previous, sources, theses) {
  const previousFiles = previous?.files || {};
  const previousTheses = previous?.thesesByTicker || {};
  const currentTheses = Object.fromEntries(theses.map((x) => [x.ticker, x]));

  const fileChanges = Object.values(sources).map((source) => ({
    key: source.alias,
    path: source.path,
    changed: previousFiles[source.alias]?.sha !== source.sha,
    previousSha: previousFiles[source.alias]?.sha || null,
    currentSha: source.sha,
    lastCommitAt: source.lastCommitAt,
    sourceUrl: source.htmlUrl,
  }));

  const thesisChanges = [];
  for (const [ticker, thesis] of Object.entries(currentTheses)) {
    const old = previousTheses[ticker];
    if (!old) {
      thesisChanges.push({ type: "new_ticker", ticker, currentView: thesis.view, updatedAt: thesis.updatedAt, latestSignal: thesis.latestSignal });
      continue;
    }
    if (old.fingerprint !== thesis.fingerprint) {
      const viewChanged = compactWhitespace(old.view).toLowerCase() !== compactWhitespace(thesis.view).toLowerCase();
      thesisChanges.push({
        type: viewChanged ? "view_changed" : "thesis_updated",
        ticker,
        previousView: old.view || null,
        currentView: thesis.view || null,
        updatedAt: thesis.updatedAt,
        latestSignal: thesis.latestSignal,
      });
    }
  }
  for (const [ticker, old] of Object.entries(previousTheses)) {
    if (!currentTheses[ticker]) thesisChanges.push({ type: "removed_ticker", ticker, previousView: old.view || null });
  }

  const durableFilesChanged = fileChanges.some((x) => x.changed && ["skill", "methodology", "articles", "trackRecord"].includes(x.key));
  const viewChanged = thesisChanges.some((x) => x.type === "view_changed" || x.type === "removed_ticker");
  const requiresKnowledgeRefresh = Boolean(previous) && (durableFilesChanged || viewChanged);

  return {
    initialSnapshot: !previous,
    anyChange: fileChanges.some((x) => x.changed) || thesisChanges.length > 0,
    fileChanges,
    thesisChanges,
    requiresKnowledgeRefresh,
    recommendedAction: !previous
      ? "Initial snapshot created. No historical diff is available yet."
      : requiresKnowledgeRefresh
        ? "Review changed methodology/articles/track-record or stance reversals, then refresh the Custom GPT Knowledge files."
        : thesisChanges.length
          ? "Use the live API for the new ticker-level evidence; a static Knowledge refresh is optional."
          : "No durable Serenity distillation change detected.",
  };
}

function latestDailyBrief() {
  if (!fs.existsSync(OUT_ROOT)) return null;
  const dates = fs.readdirSync(OUT_ROOT)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .filter((d) => fs.existsSync(path.join(OUT_ROOT, d, `${d}.html`)))
    .sort((a, b) => b.localeCompare(a));
  if (!dates.length) return null;
  const date = dates[0];
  const file = path.join(OUT_ROOT, date, `${date}.html`);
  const html = fs.readFileSync(file, "utf8");
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return {
    date,
    reportUrl: `${BASE_URL}/${date}/${date}.html`,
    textExcerpt: truncate(text, 24000),
  };
}

function buildOpenApi(baseUrl) {
  const endpoint = (operationId, summary, description) => `
    get:
      operationId: ${operationId}
      summary: ${summary}
      description: ${description}
      x-openai-isConsequential: false
      responses:
        '200':
          description: Successful response
          content:
            application/json:
              schema:
                type: object
                additionalProperties: true`;

  return `openapi: 3.1.0
info:
  title: Serenity Daily Intelligence API
  version: ${API_VERSION}
  description: Read-only live context for a Custom GPT using Serenity's public supply-chain research distillation and the latest DailyBrief report.
servers:
  - url: ${baseUrl}
paths:
  /api/v1/context.json:${endpoint("getSerenityRealtimeContext", "Get compact live Serenity context", "Call this first for current Serenity thesis changes, source freshness, compact ticker theses, and the latest daily brief excerpt.")}
  /api/v1/status.json:${endpoint("getSerenityApiStatus", "Get API freshness and source status", "Returns generation time, source commit dates, hashes, and endpoint links.")}
  /api/v1/changes.json:${endpoint("getSerenityChanges", "Get changes since the previous API snapshot", "Returns changed source files, new or revised ticker theses, stance changes, and whether static GPT Knowledge should be refreshed.")}
  /api/v1/theses.json:${endpoint("getSerenityTickerTheses", "Get latest distilled ticker theses", "Returns the latest public distilled Serenity view per ticker, with dates, evidence excerpts, and source links. These are historical/public views and still require current company fact verification.")}
  /api/v1/articles.json:${endpoint("getSerenityArticleSummaries", "Get distilled long-form article summaries", "Returns the public repository's compact article index and durable article-backed thesis summaries.")}
  /api/v1/methodology.json:${endpoint("getSerenityMethodology", "Get Serenity's reusable methodology", "Returns the current reusable supply-chain principles and checklist distilled from public content.")}
  /api/v1/track-record.json:${endpoint("getSerenityTrackRecordCalibration", "Get track-record calibration and reversals", "Returns calibration notes, caveats, reversals, and selection-bias warnings. Do not treat self-reported returns as verified.")}
  /api/v1/latest-brief.json:${endpoint("getLatestDailyBrief", "Get the latest DailyBrief excerpt", "Returns the latest generated DailyBrief date, report URL, and a compact plain-text excerpt.")}
`;
}

function buildApiIndex(endpoints) {
  const links = endpoints.map((x) => `<li><a href="${x.href}">${x.name}</a><br><small>${x.description}</small></li>`).join("\n");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Serenity Daily Intelligence API</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;line-height:1.6}code{background:#f3f3f3;padding:2px 5px;border-radius:4px}li{margin:16px 0}small{color:#666}</style></head>
<body><h1>Serenity Daily Intelligence API</h1>
<p>只读静态 JSON 接口，由 GitHub Actions 定时刷新。生成时间：<code>${GENERATED_AT}</code></p>
<p><a href="../openapi.yaml">OpenAPI Schema</a> · <a href="../privacy.html">Privacy</a></p>
<ul>${links}</ul>
<p><strong>注意：</strong>接口中的 Serenity 观点来自公开蒸馏仓库，不等于当前公司事实，也不构成投资建议。分析前仍需核验最新财报、融资、价格和监管文件。</p>
</body></html>`;
}

function buildPrivacyPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy Policy</title></head><body style="font-family:system-ui;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.6"><h1>Privacy Policy</h1><p>Last updated: ${GENERATED_AT.slice(0, 10)}</p><p>This read-only API serves public, derived research files and a public DailyBrief report through GitHub Pages. It does not request login credentials, accept user input, place trades, or intentionally store ChatGPT conversation content.</p><p>Standard hosting logs may be processed by GitHub Pages and related infrastructure under their own policies. Do not send secrets or personal data to these endpoints.</p><p>This service is independent and is not affiliated with Serenity, X, OpenAI, or the upstream repositories.</p></body></html>`;
}

async function main() {
  ensureDir(API_ROOT);
  console.log(`[gpt-api] source=${SOURCE_REPO}@${SOURCE_REF}`);
  console.log(`[gpt-api] base=${BASE_URL}`);

  const fetched = await Promise.all(Object.entries(SOURCE_FILES).map(([alias, p]) => fetchSource(alias, p)));
  const sources = Object.fromEntries(fetched.map((x) => [x.alias, x]));
  const theses = parseTheses(sources.theses.content);
  const articles = parseArticles(sources.articles.content);
  const methodology = parseMethodology(sources.methodology.content);
  const trackRecord = parseTrackRecord(sources.trackRecord.content);
  const previousState = readPreviousState();
  const changes = compareState(previousState, sources, theses);
  const latestBrief = latestDailyBrief();
  const sourceDates = fetched.map((x) => x.lastCommitAt).filter(Boolean).sort();
  const knowledgeAsOf = sourceDates.at(-1) || null;

  const sourceMetadata = Object.fromEntries(fetched.map((x) => [x.alias, {
    path: x.path,
    sha: x.sha,
    lastCommitAt: x.lastCommitAt,
    lastCommitSha: x.lastCommitSha,
    sourceUrl: x.htmlUrl,
  }]));

  const status = {
    ok: true,
    apiVersion: API_VERSION,
    generatedAt: GENERATED_AT,
    knowledgeAsOf,
    sourceRepository: `https://github.com/${SOURCE_REPO}`,
    sourceRef: SOURCE_REF,
    publicBaseUrl: BASE_URL,
    sourceFiles: sourceMetadata,
    disclaimer: "Public distilled research and decision support only. Not financial advice; current company facts must be independently verified.",
    endpoints: {
      context: `${BASE_URL}/api/v1/context.json`,
      changes: `${BASE_URL}/api/v1/changes.json`,
      theses: `${BASE_URL}/api/v1/theses.json`,
      methodology: `${BASE_URL}/api/v1/methodology.json`,
      articles: `${BASE_URL}/api/v1/articles.json`,
      trackRecord: `${BASE_URL}/api/v1/track-record.json`,
      latestBrief: `${BASE_URL}/api/v1/latest-brief.json`,
      openapi: `${BASE_URL}/api/openapi.yaml`,
      privacy: `${BASE_URL}/api/privacy.html`,
    },
  };

  const thesisPayload = {
    generatedAt: GENERATED_AT,
    knowledgeAsOf,
    source: sourceMetadata.theses,
    count: theses.length,
    theses,
    usageRule: "Treat each item as Serenity's latest view found in the public distilled repository as of its timestamp, not as a verified current recommendation. Recheck company facts and whether a newer public post exists.",
  };

  const methodologyPayload = {
    generatedAt: GENERATED_AT,
    knowledgeAsOf,
    source: sourceMetadata.methodology,
    principles: methodology,
    skillExcerpt: truncate(markdownLinksToText(sources.skill.content), 35000),
  };

  const articlesPayload = {
    generatedAt: GENERATED_AT,
    knowledgeAsOf,
    source: sourceMetadata.articles,
    ...articles,
  };

  const trackPayload = {
    generatedAt: GENERATED_AT,
    knowledgeAsOf,
    source: sourceMetadata.trackRecord,
    ...trackRecord,
  };

  const changePayload = {
    generatedAt: GENERATED_AT,
    comparedWithPreviousSnapshotAt: previousState?.generatedAt || null,
    ...changes,
  };

  const briefPayload = latestBrief || {
    date: null,
    reportUrl: `${BASE_URL}/index.html`,
    textExcerpt: "No DailyBrief HTML report was present when the API snapshot was built.",
  };

  const contextPayload = {
    generatedAt: GENERATED_AT,
    knowledgeAsOf,
    sourceFreshness: Object.fromEntries(Object.entries(sourceMetadata).map(([k, v]) => [k, v.lastCommitAt])),
    changeSummary: {
      initialSnapshot: changes.initialSnapshot,
      anyChange: changes.anyChange,
      requiresKnowledgeRefresh: changes.requiresKnowledgeRefresh,
      recommendedAction: changes.recommendedAction,
      thesisChanges: changes.thesisChanges.slice(0, 30),
      changedFiles: changes.fileChanges.filter((x) => x.changed).map((x) => ({ key: x.key, path: x.path, lastCommitAt: x.lastCommitAt })),
    },
    latestTickerTheses: theses.slice(0, 80).map(({ evidenceExcerpt, fingerprint, ...rest }) => ({ ...rest, evidenceExcerpt: truncate(evidenceExcerpt, 1800) })),
    latestDailyBrief: { ...briefPayload, textExcerpt: truncate(briefPayload.textExcerpt, 12000) },
    analystInstructions: [
      "Separate Serenity historical/public views from currently verified company facts and your own inference.",
      "Before a buy/sell/hold conclusion, verify current price, market cap, filings, GAAP margins, dilution, debt, contracts, customer status, and macro risks from primary sources.",
      "Use methodology.json for durable principles; use changes.json to detect stance reversals or files that justify refreshing static GPT Knowledge.",
      "Never claim affiliation with Serenity and never treat self-reported returns as audited.",
    ],
  };

  writeJson(path.join(API_ROOT, "status.json"), status);
  writeJson(path.join(API_ROOT, "context.json"), contextPayload);
  writeJson(path.join(API_ROOT, "changes.json"), changePayload);
  writeJson(path.join(API_ROOT, "theses.json"), thesisPayload);
  writeJson(path.join(API_ROOT, "methodology.json"), methodologyPayload);
  writeJson(path.join(API_ROOT, "articles.json"), articlesPayload);
  writeJson(path.join(API_ROOT, "track-record.json"), trackPayload);
  writeJson(path.join(API_ROOT, "latest-brief.json"), briefPayload);

  const state = {
    generatedAt: GENERATED_AT,
    files: Object.fromEntries(fetched.map((x) => [x.alias, { sha: x.sha, lastCommitAt: x.lastCommitAt }])),
    thesesByTicker: Object.fromEntries(theses.map((x) => [x.ticker, { fingerprint: x.fingerprint, view: x.view, updatedAt: x.updatedAt }])),
  };
  writeJson(STATE_PATH, state);

  const apiDir = path.join(OUT_ROOT, "api");
  fs.writeFileSync(path.join(apiDir, "openapi.yaml"), buildOpenApi(BASE_URL), "utf8");
  fs.writeFileSync(path.join(apiDir, "privacy.html"), buildPrivacyPage(), "utf8");
  fs.writeFileSync(path.join(apiDir, "index.html"), buildApiIndex([
    { name: "context.json", href: "./v1/context.json", description: "GPT 首选：精简实时上下文" },
    { name: "status.json", href: "./v1/status.json", description: "数据新鲜度与来源状态" },
    { name: "changes.json", href: "./v1/changes.json", description: "相对上一快照的观点与文件变化" },
    { name: "theses.json", href: "./v1/theses.json", description: "最新个股蒸馏观点" },
    { name: "methodology.json", href: "./v1/methodology.json", description: "可复用方法论" },
    { name: "articles.json", href: "./v1/articles.json", description: "长文摘要" },
    { name: "track-record.json", href: "./v1/track-record.json", description: "历史校准、反转与风险" },
    { name: "latest-brief.json", href: "./v1/latest-brief.json", description: "最新 DailyBrief 摘要文本" },
  ]), "utf8");
  fs.writeFileSync(path.join(OUT_ROOT, ".nojekyll"), "", "utf8");

  console.log(`[gpt-api] wrote ${API_ROOT}`);
  console.log(`[gpt-api] theses=${theses.length} changes=${changes.thesisChanges.length} refresh=${changes.requiresKnowledgeRefresh}`);
  console.log(`[gpt-api] schema=${BASE_URL}/api/openapi.yaml`);
}

main().catch((error) => {
  console.error(`[gpt-api] fatal: ${error.stack || error.message}`);
  process.exit(1);
});
