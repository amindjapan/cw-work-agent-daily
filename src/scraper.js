"use strict";

const { classifyJob, normalizeText } = require("./model");
const { normalizePublicJobRef, normalizePublicProfileRef } = require("./public-evidence");

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
    // Never follow an authentication redirect or make a second request here.
    redirect: "manual",
    headers: {
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ja,en-US;q=0.8,en;q=0.6",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
    }
  });
  const { html, stopReason } = await inspectAccessResponse(response, url);
  return {
    ok: response.ok === true,
    status: response.status,
    url: url.toString(),
    html,
    needsManualImport: stopReason !== null || isBlockedOrUnsupported(response.status, html, response.url),
    stopReason
  };
}

async function fetchJobDetail(job) {
  if (!job || !job.url) return job;
  const ref = normalizePublicJobRef({ platform: "crowdworks", id: job.id, url: job.url });
  if (!ref) return { ...job, detailFetch: { ok: false, status: null, outcome: "not_attempted", stopReason: null } };
  const response = await fetch(ref.url, { headers: requestHeaders(), redirect: "manual" });
  const { html, stopReason } = await inspectAccessResponse(response, ref.url);
  if (response.ok !== true || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300
    || stopReason || isBlockedOrUnsupported(response.status, html, response.url)) {
    return { ...job, detailFetch: { ok: false, status: response.status, outcome: "fetch_failed", stopReason } };
  }

  const description = extractJobDescription(html);
  if (!description) {
    return { ...job, detailFetch: { ok: false, status: response.status, outcome: "extraction_failed", stopReason: null } };
  }
  const detailBudget = description ? extractBudget(description) : "";
  const detailed = {
    ...job,
    budget: detailBudget || job.budget,
    description: description || job.description,
    detailCheckedAt: new Date().toISOString(),
    detailFetch: { ok: true, status: response.status, outcome: "success", stopReason: null },
    contentSources: { description: "detail", budget: detailBudget ? "detail" : "search" },
    publicClient: extractJobPublicClient(html)
  };
  return { ...detailed, analysis: classifyJob(detailed) };
}

// A recognized empty array is observed zero; unrelated/malformed HTML is unknown.
function inspectSearchResult(html, sourceUrl = "") {
  const match = String(html || "").match(
    /<div\b[^>]*\bid=["']vue-container["'][^>]*\bdata=["']([\s\S]*?)["'][^>]*>/i
  );
  if (match) {
    try {
      const data = JSON.parse(decodeHtmlEntities(match[1]));
      const offers = data && data.searchResult && data.searchResult.job_offers;
      if (Array.isArray(offers)) {
        const jobs = extractJobsFromEmbeddedData(html, sourceUrl);
        const complete = offers.every((offer) => offer && offer.job_offer
          && /^\d+$/.test(String(offer.job_offer.id)) && offer.job_offer.title)
          && jobs.length === offers.length;
        return { jobs, complete, outcome: complete ? "success" : "extraction_failed" };
      }
    } catch {
      return { jobs: [], complete: false, outcome: "extraction_failed" };
    }
  }
  return { jobs: extractJobs(html, sourceUrl), complete: false, outcome: "extraction_failed" };
}

function extractJobPublicClient(html) {
  const refs = [];
  for (const match of String(html || "").matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      const posting = JSON.parse(match[1]);
      if (posting["@type"] !== "JobPosting") continue;
      const url = posting.hiringOrganization && posting.hiringOrganization.url;
      const id = typeof url === "string" && url.match(/^https:\/\/crowdworks\.jp\/public\/employers\/(\d+)(?:[?#].*)?$/);
      if (!id) continue;
      const ref = normalizePublicProfileRef({ platform: "crowdworks", profileId: id[1], url });
      if (ref) refs.push(ref);
    } catch {
      // An absent or ambiguous explicit profile link stays unconfirmed.
    }
  }
  const unique = [...new Map(refs.map((ref) => [ref.profileId, ref])).values()];
  return unique.length === 1 ? unique[0] : null;
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

function decodeAccessEntities(html) {
  // Decode each original entity once. A decoded ampersand must not create a
  // second numeric entity for the legacy decoder to process without a bound.
  const named = { quot: "\"", apos: "'", lt: "<", gt: ">", amp: "&", nbsp: " " };
  return (typeof html === "string" ? html : "").replace(/&(?:#x([a-f0-9]+)|#([0-9]+)|(quot|apos|lt|gt|amp|nbsp));/gi,
    (_, hex, decimal, name) => {
      if (name) return named[name.toLowerCase()];
      const point = Number.parseInt(hex || decimal, hex ? 16 : 10);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point) : " ";
    });
}

function accessWarningText(html) {
  return normalizeText(decodeAccessEntities(html));
}

function activeCaptchaWidget(html) {
  // Only active DOM markers qualify. Library scripts, comments, inert templates,
  // escaped examples and ordinary job text do not establish a challenge.
  const markup = (typeof html === "string" ? html : "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ");
  const attribute = (tag, name) => {
    const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i"));
    return match ? decodeAccessEntities(match[1] ?? match[2] ?? match[3]).trim() : null;
  };
  for (const [tag] of markup.matchAll(/<(?:div|span|form|section)\b[^>]*>/gi)) {
    const classes = attribute(tag, "class");
    if (classes && /(?:^|\s)(?:g-recaptcha|h-captcha)(?:\s|$)/i.test(classes) && attribute(tag, "data-sitekey")) return true;
  }
  for (const [tag] of markup.matchAll(/<iframe\b[^>]*>/gi)) {
    const source = attribute(tag, "src");
    if (!source) continue;
    try {
      const url = new URL(source, "https://crowdworks.jp");
      if (url.protocol !== "https:") continue;
      if (["www.google.com", "www.recaptcha.net", "recaptcha.google.com"].includes(url.hostname)
        && /^\/recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)(?:\/|$)/.test(url.pathname)) return true;
      if (["newassets.hcaptcha.com", "www.hcaptcha.com", "hcaptcha.com"].includes(url.hostname)
        && /^\/captcha\/.+\/hcaptcha\.html$/.test(url.pathname)) return true;
      if (url.hostname === "challenges.cloudflare.com" && /^\/cdn-cgi\/challenge-platform\//.test(url.pathname)) return true;
    } catch { /* Invalid sources do not trigger a request or escape as diagnostics. */ }
  }
  return false;
}

function loginDestination(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const pathname = decodeURIComponent(url.pathname);
    return /(?:^|\/)(?:log[_-]?in|sign[_-]?in|sessions\/new)(?:\/|$)/i.test(pathname);
  } catch { return false; }
}

function captchaRequirement(text) {
  // A CAPTCHA mentioned as an integration/development topic is job content.
  // Require a challenge label, an explicit requirement, or an instruction.
  return /^(?:re)?captcha(?:\s+(?:challenge|verification|認証))?[.!。:：]?$/i.test(text)
    || /\b(?:re)?captcha\b\s*[:：-]?\s*(?:(?:challenge|verification)\s+)?(?:is\s+)?(?:required|must\s+be\s+(?:completed|solved))/i.test(text)
    || /\b(?:complete|solve|enter|pass)\s+(?:the\s+|a\s+)?(?:re)?captcha\b/i.test(text)
    || /(?:re)?captcha\s*(?:を)?\s*(?:認証|確認|入力|完了|解決|チェック)(?:を)?\s*(?:して(?:ください|下さい)|する必要|が必要|行って(?:ください|下さい))/i.test(text)
    || /(?:画像|文字)認証(?:が必要|(?:を)?(?:入力|完了|確認)(?:して(?:ください|下さい)|が必要)|(?:を)?行って(?:ください|下さい))/.test(text)
    || /私はロボットではありません|ロボットではないことを(?:確認|認証)(?:して(?:ください|下さい)|する必要)|人間であることを(?:確認|認証)(?:して(?:ください|下さい)|する必要)|verify\s+(?:that\s+)?you(?:'re|\s+are)\s+(?:a\s+)?human/i.test(text);
}

// Fixed classifications only: no URL, response body, or caller exception is
// returned. A normal JavaScript fallback alone is not an access-stop signal.
function classifyAccessStop(status, html, responseUrl) {
  if (status === 403) return "access_denied";
  if (status === 401) return "authentication_required";
  if (status === 429) return "rate_limited";
  if (loginDestination(responseUrl)) return "authentication_required";
  if (activeCaptchaWidget(html)) return "captcha_required";
  const text = accessWarningText(html);
  if (captchaRequirement(text)) {
    return "captcha_required";
  }
  if (/ログイン(?:してください|して下さい|が必要|する必要|して(?:から|続行|閲覧))|please\s+(?:log|sign)[ _-]?in|(?:login|log[ _-]?in|sign[ _-]?in|authentication)\s+(?:is\s+)?required|(?:log|sign)[ _-]?in\s+to\s+(?:continue|access|view)|you\s+(?:must|need\s+to)\s+(?:log|sign)[ _-]?in/i.test(text)) {
    return "authentication_required";
  }
  if (/too\s+many\s+requests|rate[ -]?limit\s+(?:exceeded|reached)|リクエストが多すぎ|アクセス回数.{0,12}(?:制限|超過)/i.test(text)) {
    return "rate_limited";
  }
  if (/アクセスが集中|(?:ただいま|現在).{0,16}(?:混み合|混雑)|temporarily\s+(?:busy|overloaded)|(?:service|server)\s+(?:is\s+)?(?:busy|overloaded)|heavy\s+traffic|high\s+(?:traffic|load)/i.test(text)) {
    return "access_congestion";
  }
  if (/アクセス(?:が|を)(?:一時的に)?(?:制限|ブロック)|不正(?:な)?アクセス|自動(?:化された|的な)?アクセス.{0,20}(?:検知|検出|制限)|セキュリティ(?:上|保護|チェック)|access\s+(?:(?:has\s+been|is|temporarily)\s+)?(?:denied|blocked|restricted)|request\s+(?:blocked|rejected)|you\s+have\s+been\s+blocked|unusual\s+traffic|automated\s+(?:access|requests?).{0,25}(?:blocked|detected|not\s+allowed)|security\s+(?:check|verification)|checking\s+your\s+browser|just\s+a\s+moment|enable\s+javascript\s+and\s+cookies\s+to\s+continue|JavaScript.{0,8}(?:Cookie|クッキー).{0,12}(?:有効|続行|許可)/i.test(text)) {
    return "protection_warning";
  }
  return null;
}

async function inspectAccessResponse(response, requestUrl) {
  let stopReason = classifyAccessStop(response.status, "", response.url);
  if (!stopReason && response.status >= 300 && response.status < 400) {
    try {
      const location = response.headers && typeof response.headers.get === "function" && response.headers.get("location");
      if (typeof location === "string") stopReason = classifyAccessStop(response.status, "", new URL(location, requestUrl).toString());
    } catch { /* Header parsing never exposes arbitrary values or causes another request. */ }
  }
  // Preserve explicit HTTP/redirect stops even if the body cannot be read.
  if (stopReason) return { html: "", stopReason };
  try {
    const html = await response.text();
    return { html, stopReason: classifyAccessStop(response.status, html, response.url) };
  } catch {
    const error = new Error("response_body_read_failed");
    if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) error.status = response.status;
    throw error;
  }
}

function isBlockedOrUnsupported(status, html, responseUrl) {
  const text = accessWarningText(html);
  return classifyAccessStop(status, html, responseUrl) !== null
    // Normal pages carry fallback notices even outside noscript. Require verified content.
    || (/JavaScriptを有効|ページを正しく表示できません|(?:enable|turn\s+on)\s+javascript|javascript\s+(?:is\s+)?(?:required|disabled)/i.test(text)
      && !inspectSearchResult(html).complete && !extractJobDescription(html));
}

module.exports = {
  absoluteCrowdWorksUrl,
  classifyAccessStop,
  decodeHtmlEntities,
  extractJobs,
  extractJobDescription,
  extractJobPublicClient,
  extractJobsFromHtml,
  extractJobsFromEmbeddedData,
  extractJobsFromPlainText,
  fetchJobDetail,
  fetchSearchPage,
  formatPayment,
  isBlockedOrUnsupported,
  inspectSearchResult
};
