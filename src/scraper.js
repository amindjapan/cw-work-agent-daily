"use strict";

const { classifyJob, normalizeText } = require("./model");

const CATEGORY_NAMES = {
  37: "記事・Webコンテンツ作成",
  39: "編集・校正・リライト",
  40: "データ入力",
  226: "リサーチ"
};

function absoluteCrowdWorksUrl(href) {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `https://crowdworks.jp${href}`;
  return `https://crowdworks.jp/${href}`;
}

function extractJobsFromHtml(html, sourceUrl = "") {
  const jobs = new Map();
  const anchorRegex = /<a\b[^>]*href=["']([^"']*\/public\/jobs\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRegex.exec(html))) {
    const href = match[1];
    const id = match[2];
    const anchorText = normalizeText(match[3]);
    if (!anchorText || anchorText.length < 3) continue;

    const windowStart = Math.max(0, match.index - 1200);
    const windowEnd = Math.min(html.length, match.index + 2600);
    const windowHtml = html.slice(windowStart, windowEnd);
    const windowText = normalizeText(windowHtml);
    const title = cleanTitle(anchorText);
    if (!title) continue;

    const budget = extractBudget(windowText);
    const category = extractCategory(windowText);
    const description = extractDescription(windowText, title);
    const job = {
      id,
      title,
      url: absoluteCrowdWorksUrl(href),
      budget,
      category,
      description,
      sourceUrl,
      importedAt: new Date().toISOString()
    };
    jobs.set(id, { ...job, analysis: classifyJob(job) });
  }
  return [...jobs.values()];
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractJobsFromEmbeddedData(html, sourceUrl = "") {
  const match = String(html || "").match(
    /<div\b[^>]*\bid=["']vue-container["'][^>]*\bdata=["']([\s\S]*?)["'][^>]*>/i
  );
  if (!match) return [];

  let data;
  try {
    data = JSON.parse(decodeHtmlEntities(match[1]));
  } catch {
    return [];
  }

  const entries = data && data.searchResult && Array.isArray(data.searchResult.job_offers)
    ? data.searchResult.job_offers
    : [];

  return entries.flatMap((entry) => {
    const offer = entry && entry.job_offer;
    if (!offer || !offer.id || !offer.title) return [];
    const job = {
      id: String(offer.id),
      title: normalizeText(offer.title),
      url: `https://crowdworks.jp/public/jobs/${offer.id}`,
      budget: formatPayment(entry.payment),
      category: CATEGORY_NAMES[offer.category_id] || offer.genre || "",
      description: normalizeText(offer.description_digest || ""),
      sourceUrl,
      status: offer.status || "",
      expiresAt: offer.expired_on || "",
      applications: extractApplicationCount(entry.entry),
      importedAt: new Date().toISOString()
    };
    return [{ ...job, analysis: classifyJob(job) }];
  });
}

function formatPayment(payment) {
  const values = [];
  collectPaymentValues(payment, values);
  const yen = [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))]
    .sort((a, b) => a - b);
  if (!yen.length) return "";
  if (yen.length === 1) return `${yen[0].toLocaleString("ja-JP")}円`;
  return `${yen[0].toLocaleString("ja-JP")}円〜${yen[yen.length - 1].toLocaleString("ja-JP")}円`;
}

function collectPaymentValues(value, output, key = "") {
  if (value === null || value === undefined) return;
  if (typeof value === "number" && /price|budget|amount|payment|hourly/i.test(key)) {
    output.push(value);
    return;
  }
  if (typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    collectPaymentValues(childValue, output, childKey);
  }
}

function extractApplicationCount(entry) {
  const project = entry && entry.project_entry;
  if (!project) return null;
  const value = Number(project.num_application_conditions);
  return Number.isFinite(value) ? value : null;
}

function extractJobsFromPlainText(text, sourceUrl = "") {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const blocks = normalized.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const jobs = [];
  for (const [index, block] of blocks.entries()) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const urlLine = lines.find((line) => /https?:\/\/\S+/.test(line));
    const url = urlLine ? urlLine.match(/https?:\/\/\S+/)[0] : "";
    const idMatch = url.match(/\/jobs\/(\d+)/);
    const title = cleanTitle(lines.find((line) => !/^https?:\/\//.test(line)) || `貼り付け案件 ${index + 1}`);
    const job = {
      id: idMatch ? idMatch[1] : `manual-${Date.now()}-${index + 1}`,
      title,
      url,
      budget: extractBudget(block),
      category: extractCategory(block),
      description: normalizeText(block).slice(0, 700),
      sourceUrl,
      importedAt: new Date().toISOString()
    };
    jobs.push({ ...job, analysis: classifyJob(job) });
  }
  return jobs;
}

function extractJobs(input, sourceUrl = "") {
  const value = String(input || "");
  const embeddedJobs = extractJobsFromEmbeddedData(value, sourceUrl);
  if (embeddedJobs.length) return embeddedJobs;
  const htmlJobs = extractJobsFromHtml(value, sourceUrl);
  if (htmlJobs.length) return htmlJobs;
  if (/<!doctype\s+html|<html\b|<body\b|<div\b/i.test(value)) return [];
  return extractJobsFromPlainText(value, sourceUrl);
}

function cleanTitle(value) {
  return normalizeText(value)
    .replace(/^募集中\s*/, "")
    .replace(/\s*詳細を見る$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function extractBudget(text) {
  const normalized = normalizeText(text);
  const patterns = [
    /(固定報酬制|時間単価制|予算|報酬|契約金額)[^。]{0,80}?([0-9０-９,，]+)\s*円(?:\s*[~〜-]\s*[0-9０-９,，]+\s*円)?/,
    /([0-9０-９,，]+)\s*円\s*[~〜-]\s*([0-9０-９,，]+)\s*円/,
    /([0-9０-９,，]+)\s*円/
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return normalizeText(match[0]).slice(0, 120);
  }
  return "";
}

function extractCategory(text) {
  const normalized = normalizeText(text);
  const categories = [
    "ライティング", "記事作成", "データ入力", "事務", "リサーチ", "翻訳",
    "システム開発", "Web制作", "ホームページ制作", "デザイン", "動画",
    "音声", "マーケティング", "資料作成"
  ];
  return categories.find((category) => normalized.includes(category)) || "";
}

function extractDescription(text, title) {
  const normalized = normalizeText(text);
  const withoutTitle = normalized.replace(title, "").trim();
  return withoutTitle.slice(0, 700);
}

async function fetchSearchPage({ keywords, page = 1, categoryId = "" }) {
  const url = new URL("https://crowdworks.jp/public/jobs/search");
  if (keywords) url.searchParams.set("search[keywords]", keywords);
  if (categoryId) url.searchParams.set("search[category_id]", categoryId);
  if (page > 1) url.searchParams.set("page", String(page));

  const response = await fetch(url, {
    headers: {
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ja,en-US;q=0.8,en;q=0.6",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
    }
  });
  const html = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    url: url.toString(),
    html,
    needsManualImport: isBlockedOrUnsupported(response.status, html)
  };
}

async function fetchJobDetail(job) {
  if (!job || !job.url) return job;
  const response = await fetch(job.url, { headers: requestHeaders() });
  const html = await response.text();
  if (!response.ok) return job;

  const description = extractJobDescription(html);
  const detailBudget = description ? extractBudget(description) : "";
  const detailed = {
    ...job,
    budget: detailBudget || job.budget,
    description: description || job.description,
    detailCheckedAt: new Date().toISOString()
  };
  return { ...detailed, analysis: classifyJob(detailed) };
}

function extractJobDescription(html) {
  const scripts = String(html || "").matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const match of scripts) {
    try {
      const data = JSON.parse(match[1]);
      if (data && data["@type"] === "JobPosting" && data.description) {
        return normalizeText(decodeHtmlEntities(data.description));
      }
    } catch {
      // Ignore unrelated or malformed structured-data blocks.
    }
  }
  return "";
}

function requestHeaders() {
  return {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "ja,en-US;q=0.8,en;q=0.6",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
  };
}

function isBlockedOrUnsupported(status, html) {
  const text = normalizeText(html);
  return status === 401
    || status === 403
    || /JavaScriptを有効|ページを正しく表示できません|アクセスが集中|captcha/i.test(text)
    || (/ログインしてください/.test(text) && !/searchResult|job_offers/.test(html));
}

module.exports = {
  absoluteCrowdWorksUrl,
  decodeHtmlEntities,
  extractJobs,
  extractJobDescription,
  extractJobsFromHtml,
  extractJobsFromEmbeddedData,
  extractJobsFromPlainText,
  fetchJobDetail,
  fetchSearchPage,
  formatPayment,
  isBlockedOrUnsupported
};
