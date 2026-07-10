"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyJob, makeApplyDraft, parseBudgetYen } = require("../src/model");
const { extractJobs, extractJobDescription, isBlockedOrUnsupported } = require("../src/scraper");
const { renderHtml, runDaily } = require("../src/daily");

test("classifies executable data work as candidate", () => {
  const job = {
    title: "PythonでCSVデータ整理スクリプト作成",
    description: "CSVを読み込み、重複削除とExcel出力を行う小規模なPythonスクリプトの作成です。",
    budget: "固定報酬制 10,000円",
    category: "システム開発"
  };
  const analysis = classifyJob(job);
  assert.equal(analysis.canExecute, true);
  assert.equal(analysis.verdict, "候補");
  assert.ok(analysis.score >= 65);
});

test("flags review manipulation work as avoid", () => {
  const job = {
    title: "口コミ投稿をお願いします",
    description: "指定サービスに星5レビュー投稿。初心者歓迎です。",
    budget: "500円",
    category: "タスク"
  };
  const analysis = classifyJob(job);
  assert.equal(analysis.canExecute, false);
  assert.equal(analysis.verdict, "避ける");
  assert.ok(analysis.riskFlags.includes("口コミ投稿"));
});

test("flags training or seminar-like recruitment as avoid", () => {
  const job = {
    title: "AI×Python業務ワーク体験",
    description: "参加者を募集しております。体験後に率直なご感想をいただけますと幸いです。学ぶ意欲がある方向けです。",
    budget: "固定報酬制 1,001円",
    category: "その他（カンタン作業）"
  };
  const analysis = classifyJob(job);
  assert.equal(analysis.canExecute, false);
  assert.equal(analysis.verdict, "避ける");
  assert.ok(analysis.riskFlags.includes("業務ワーク体験"));
});

test("flags jobs that explicitly forbid AI use as avoid", () => {
  const job = {
    title: "記事作成 ※AI使用禁止",
    description: "ChatGPT禁止。すべて本人が執筆してください。",
    budget: "固定報酬制 5,000円",
    category: "ライティング"
  };
  const analysis = classifyJob(job);
  assert.equal(analysis.canExecute, false);
  assert.equal(analysis.verdict, "避ける");
  assert.ok(analysis.riskFlags.includes("AI使用禁止"));
});

test("flags off-platform interview and token trial pay as avoid", () => {
  const job = {
    title: "AI生成FAQの編集",
    description: "サービス外連絡申請後、Zoomでオンライン面談を行います。初回の報酬：50円です。",
    budget: "5,000円",
    category: "編集"
  };
  const analysis = classifyJob(job);
  assert.equal(analysis.canExecute, false);
  assert.equal(analysis.verdict, "避ける");
  assert.ok(analysis.riskFlags.includes("サービス外連絡"));
  assert.ok(analysis.riskFlags.includes("報酬：50円"));
});

test("flags excessive personal profile requirements as avoid", () => {
  const job = {
    title: "AI使用可能なWebライター",
    description: "応募時に氏名（本名）、性別、年間売上、在宅ワーク環境を記載してください。",
    budget: "10,000円",
    category: "ライティング"
  };
  const analysis = classifyJob(job);
  assert.equal(analysis.canExecute, false);
  assert.ok(analysis.riskFlags.includes("氏名（本名）"));
  assert.ok(analysis.riskFlags.includes("年間売上"));
});

test("parses budget yen", () => {
  assert.equal(parseBudgetYen("固定報酬制 5,000円 〜 10,000円"), 10000);
});

test("extracts jobs from html links", () => {
  const html = `
    <div>
      <a href="/public/jobs/1234567">Python データ整理</a>
      固定報酬制 10,000円 CSV Excel
    </div>
  `;
  const jobs = extractJobs(html, "fixture");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "1234567");
  assert.match(jobs[0].url, /crowdworks\.jp/);
});

test("makes apply draft with profile", () => {
  const draft = makeApplyDraft({ title: "記事リライト" }, { name: "山田", skills: "校正、リライト" });
  assert.match(draft, /山田/);
  assert.match(draft, /記事リライト/);
  assert.match(draft, /校正/);
});

test("extracts jobs from embedded search data", () => {
  const data = {
    searchResult: {
      job_offers: [{
        job_offer: {
          id: 7654321,
          title: "AI記事のリライト",
          description_digest: "ChatGPTで作成した記事を自然な文章に直します。",
          category_id: 39,
          status: "released",
          expired_on: "2099-12-31"
        },
        payment: { fixed_price_writing_payment: { article_price: 5000 } },
        entry: { project_entry: { num_application_conditions: 4 } }
      }]
    }
  };
  const encoded = JSON.stringify(data).replace(/&/g, "&amp;").replace(/\"/g, "&quot;");
  const jobs = extractJobs(`<div id="vue-container" data="${encoded}"></div>`, "fixture");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "7654321");
  assert.equal(jobs[0].budget, "5,000円");
  assert.equal(jobs[0].applications, 4);
});

test("extracts a detailed job description from structured data", () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting",
    description: "CSV整理&lt;br&gt;AI利用可"
  })}</script>`;
  assert.equal(extractJobDescription(html), "CSV整理 AI利用可");
});

test("does not treat ordinary identity verification text as a block", () => {
  const html = '<div id="vue-container" data="{}">本人認証済み</div>';
  assert.equal(isBlockedOrUnsupported(200, html), false);
});

test("daily run selects one safe recommendation and renders mobile page", async () => {
  const embedded = {
    searchResult: {
      job_offers: [{
        job_offer: {
          id: 1234567,
          title: "PythonでCSVデータ整理スクリプト作成",
          description_digest: "CSVをPythonで整理しExcelへ出力します。AI利用可。",
          category_id: 40,
          status: "released",
          expired_on: "2099-12-31"
        },
        payment: { fixed_price_payment: { min_budget: 10000, max_budget: 20000 } },
        entry: { project_entry: { num_application_conditions: 2 } }
      }]
    }
  };
  const encoded = JSON.stringify(embedded).replace(/&/g, "&amp;").replace(/\"/g, "&quot;");
  const report = await runDaily({
    keywords: ["CSV"],
    outputDir: require("node:os").tmpdir(),
    now: new Date("2026-07-10T00:00:00Z"),
    fetchSearchPage: async () => ({ ok: true, status: 200, url: "fixture", html: `<div id="vue-container" data="${encoded}"></div>` }),
    fetchJobDetail: async (job) => ({ ...job, detailCheckedAt: "2026-07-10T00:00:00Z" })
  });
  assert.equal(report.recommendation.id, "1234567");
  const html = renderHtml(report);
  assert.match(html, /viewport/);
  assert.match(html, /クラウドワークスで確認/);
  assert.match(html, /今すぐ更新/);
  assert.match(html, /actions\/workflows\/daily\.yml/);
});
