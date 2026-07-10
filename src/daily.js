"use strict";

const fs = require("fs");
const path = require("path");
const { classifyJob } = require("./model");
const { extractJobs, fetchJobDetail, fetchSearchPage } = require("./scraper");
const { ensureDir, upsertJobs, writeJson } = require("./store");

const DEFAULT_KEYWORDS = [
  "Python データ整理",
  "ChatGPT リサーチ",
  "CSV データ整理",
  "記事 リライト",
  "Python スクレイピング"
];

async function runDaily(options = {}) {
  const keywords = options.keywords || DEFAULT_KEYWORDS;
  const outputDir = options.outputDir || path.join(__dirname, "..", "site");
  const now = options.now || new Date();
  const searchPage = options.fetchSearchPage || fetchSearchPage;
  const jobDetail = options.fetchJobDetail || fetchJobDetail;
  const attempts = [];
  let jobs = [];

  for (const keyword of keywords) {
    try {
      const result = await searchPage({ keywords: keyword, page: 1 });
      const imported = extractJobs(result.html, result.url);
      jobs = upsertJobs(jobs, imported);
      attempts.push({
        keyword,
        ok: result.ok && imported.length > 0,
        status: result.status,
        imported: imported.length
      });
    } catch (error) {
      attempts.push({ keyword, ok: false, status: 0, imported: 0, error: error.message });
    }
  }

  const preliminary = jobs
    .filter((job) => isValidPublicJob(job) && !(job.analysis.riskFlags || []).length)
    .sort(compareJobs)
    .slice(0, 50);

  const detailed = [];
  for (const job of preliminary) {
    try {
      detailed.push(await jobDetail(job));
    } catch {
      detailed.push(job);
    }
  }

  const candidates = detailed
    .map((job) => ({ ...job, analysis: classifyJob(job) }))
    .filter((job) => job.analysis.canExecute && !isExpired(job, now))
    .sort(compareJobs);
  const recommendation = candidates[0] || null;
  const report = {
    generatedAt: now.toISOString(),
    generatedAtJst: formatJst(now),
    keywords,
    attempts,
    totalJobs: jobs.length,
    safeCandidates: candidates.length,
    recommendation: recommendation ? decorateRecommendation(recommendation) : null
  };

  writeReport(outputDir, report);
  return report;
}

function isValidPublicJob(job) {
  return Boolean(job && /^\d+$/.test(job.id) && /crowdworks\.jp\/public\/jobs\/\d+/.test(job.url));
}

function isExpired(job, now) {
  if (!job.expiresAt) return false;
  const end = new Date(`${job.expiresAt}T23:59:59+09:00`);
  return Number.isFinite(end.getTime()) && end < now;
}

function compareJobs(a, b) {
  const scoreA = a.analysis ? a.analysis.score : 0;
  const scoreB = b.analysis ? b.analysis.score : 0;
  if (scoreA !== scoreB) return scoreB - scoreA;
  return Number(b.analysis && b.analysis.budgetYen || 0)
    - Number(a.analysis && a.analysis.budgetYen || 0);
}

function decorateRecommendation(job) {
  const reasons = [];
  const analysis = job.analysis || {};
  if ((analysis.strongSignals || []).length) {
    reasons.push(`自動化と相性のよい要素: ${analysis.strongSignals.slice(0, 4).join("、")}`);
  }
  if (analysis.budgetYen) reasons.push(`募集文から確認できた報酬上限: ${analysis.budgetYen.toLocaleString("ja-JP")}円`);
  reasons.push("危険キーワードとAI利用禁止表現は検出されませんでした");
  if (job.detailCheckedAt) reasons.push("案件詳細ページの本文でも再判定済みです");
  return { ...job, selectionReasons: reasons };
}

function writeReport(outputDir, report) {
  ensureDir(outputDir);
  writeJson(path.join(outputDir, "latest.json"), report);
  fs.writeFileSync(path.join(outputDir, "index.html"), renderHtml(report), "utf8");
  fs.writeFileSync(path.join(outputDir, "latest.md"), renderMarkdown(report), "utf8");
  fs.writeFileSync(path.join(outputDir, ".nojekyll"), "", "utf8");
}

function renderHtml(report) {
  const job = report.recommendation;
  const attemptsOk = report.attempts.filter((attempt) => attempt.ok).length;
  const content = job ? `
    <article class="recommendation">
      <div class="score" aria-label="自動化適性スコア ${job.analysis.score}">
        <span>${job.analysis.score}</span><small>/ 100</small>
      </div>
      <div class="job-body">
        <p class="eyebrow">本日のおすすめ</p>
        <h2>${escapeHtml(job.title)}</h2>
        <div class="facts">
          ${job.budget ? `<span>${escapeHtml(job.budget)}</span>` : ""}
          ${job.category ? `<span>${escapeHtml(job.category)}</span>` : ""}
          ${Number.isFinite(job.applications) ? `<span>応募 ${job.applications}件</span>` : ""}
          ${job.expiresAt ? `<span>掲載期限 ${escapeHtml(job.expiresAt)}</span>` : ""}
        </div>
        <p class="description">${escapeHtml(job.description || "案件詳細を開いて内容を確認してください。")}</p>
        <h3>選定理由</h3>
        <ul>${job.selectionReasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
        <a class="primary" href="${escapeAttr(job.url)}" target="_blank" rel="noreferrer">クラウドワークスで確認</a>
      </div>
    </article>` : `
    <div class="empty">
      <h2>安全におすすめできる案件が見つかりませんでした</h2>
      <p>検索処理は完了しました。条件を緩めず、次回の更新を待ちます。</p>
    </div>`;

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#176b5b">
  <title>CloudWorks Daily Pick</title>
  <style>
    :root { color-scheme: light; --ink:#182126; --muted:#617078; --line:#d8e0df; --bg:#eef3f1; --panel:#fff; --teal:#176b5b; --teal-dark:#105044; --amber:#a85f08; }
    * { box-sizing:border-box; }
    body { margin:0; color:var(--ink); background:var(--bg); font-family:"Segoe UI",system-ui,-apple-system,sans-serif; line-height:1.6; }
    header { background:#fff; border-bottom:1px solid var(--line); }
    .topbar, main { width:min(100% - 32px, 900px); margin:0 auto; }
    .topbar { min-height:72px; display:flex; align-items:center; justify-content:space-between; gap:16px; }
    h1 { margin:0; font-size:20px; letter-spacing:0; }
    .header-actions { display:flex; align-items:center; gap:12px; }
    .updated { color:var(--muted); font-size:12px; text-align:right; }
    .refresh { display:inline-flex; min-height:36px; align-items:center; justify-content:center; padding:7px 10px; color:var(--teal); background:#fff; border:1px solid var(--teal); border-radius:7px; font-size:13px; font-weight:700; text-decoration:none; white-space:nowrap; }
    .refresh:hover { color:#fff; background:var(--teal); }
    main { padding:24px 0 44px; }
    .summary { display:flex; gap:18px; margin-bottom:18px; color:var(--muted); font-size:13px; }
    .summary strong { color:var(--ink); font-size:16px; }
    .recommendation { display:grid; grid-template-columns:112px minmax(0,1fr); gap:24px; padding:24px; background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    .score { width:96px; height:96px; display:grid; place-content:center; text-align:center; color:#fff; background:var(--teal); border-radius:8px; }
    .score span { font-size:34px; font-weight:800; line-height:1; }
    .score small { margin-top:4px; font-size:12px; }
    .eyebrow { margin:0 0 5px; color:var(--amber); font-weight:700; font-size:13px; }
    h2 { margin:0; font-size:22px; line-height:1.4; letter-spacing:0; overflow-wrap:anywhere; }
    h3 { margin:20px 0 6px; font-size:14px; }
    .facts { display:flex; flex-wrap:wrap; gap:6px; margin-top:12px; }
    .facts span { padding:4px 8px; border:1px solid var(--line); border-radius:6px; color:var(--muted); font-size:12px; }
    .description { margin:18px 0 0; color:#46545a; display:-webkit-box; -webkit-line-clamp:7; -webkit-box-orient:vertical; overflow:hidden; }
    ul { margin:0; padding-left:20px; }
    .primary { display:inline-flex; min-height:44px; margin-top:22px; padding:9px 16px; align-items:center; justify-content:center; color:#fff; background:var(--teal); border-radius:7px; font-weight:700; text-decoration:none; }
    .primary:hover { background:var(--teal-dark); }
    .empty { padding:32px; background:#fff; border:1px solid var(--line); border-radius:8px; }
    footer { width:min(100% - 32px, 900px); margin:0 auto 28px; color:var(--muted); font-size:12px; }
    @media (max-width:640px) {
      .topbar { padding:14px 0; align-items:flex-start; flex-direction:column; }
      .header-actions { width:100%; justify-content:space-between; }
      .updated { text-align:left; }
      main { padding-top:18px; }
      .summary { gap:12px; justify-content:space-between; }
      .recommendation { grid-template-columns:1fr; gap:16px; padding:18px; }
      .score { width:88px; height:72px; }
      h2 { font-size:19px; }
      .primary { width:100%; }
    }
  </style>
</head>
<body>
  <header><div class="topbar"><h1>CloudWorks Daily Pick</h1><div class="header-actions"><a class="refresh" href="https://github.com/amindjapan/cw-work-agent-daily/actions/workflows/daily.yml" target="_blank" rel="noreferrer">今すぐ更新</a><div class="updated">最終更新<br>${escapeHtml(report.generatedAtJst)}</div></div></div></header>
  <main>
    <div class="summary"><span><strong>${attemptsOk}</strong> 検索成功</span><span><strong>${report.totalJobs}</strong> 件取得</span><span><strong>${report.safeCandidates}</strong> 件候補</span></div>
    ${content}
  </main>
  <footer>応募・契約・送信は自動実行しません。案件本文、規約、AI利用条件を本人が確認してから進めてください。</footer>
</body>
</html>`;
}

function renderMarkdown(report) {
  const job = report.recommendation;
  if (!job) return `# 本日のおすすめ\n\n${report.generatedAtJst}: 安全におすすめできる案件はありませんでした。\n`;
  return [
    "# 本日のおすすめ",
    "",
    `## ${job.title}`,
    "",
    `- スコア: ${job.analysis.score}/100`,
    job.budget ? `- 報酬: ${job.budget}` : "",
    job.expiresAt ? `- 掲載期限: ${job.expiresAt}` : "",
    `- URL: ${job.url}`,
    "",
    ...job.selectionReasons.map((reason) => `- ${reason}`)
  ].filter(Boolean).join("\n") + "\n";
}

function formatJst(date) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

if (require.main === module) {
  const outputIndex = process.argv.indexOf("--output");
  const outputDir = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : undefined;
  runDaily({ outputDir })
    .then((report) => {
      console.log(JSON.stringify({
        generatedAt: report.generatedAt,
        totalJobs: report.totalJobs,
        safeCandidates: report.safeCandidates,
        recommendation: report.recommendation && {
          id: report.recommendation.id,
          title: report.recommendation.title,
          score: report.recommendation.analysis.score,
          url: report.recommendation.url
        }
      }, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_KEYWORDS,
  compareJobs,
  renderHtml,
  runDaily
};
