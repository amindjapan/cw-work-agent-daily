"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runDaily } = require("../src/daily");
const { CollectionAbortedError } = require("../src/collection-diagnostics");
const { fetchSearchPage, fetchJobDetail, isBlockedOrUnsupported } = require("../src/scraper");
const { projectPublicSummary } = require("../src/prepare-public-artifact");

const NOTICE = `<noscript class="notice">JavaScriptを有効にしてください。
  ページを正しく表示できません。</noscript>`;

function searchHtml(ids) {
  const data = { searchResult: { job_offers: ids.map((id) => ({
    job_offer: { id, title: "Python CSV データ整理", description_digest: "CSVをPythonで整理します。",
      category_id: 40, status: "released", expired_on: "2099-12-31" },
    payment: { fixed_price_payment: { min_budget: 10000 } }
  })) } };
  return `<html><body>${NOTICE}<div id="vue-container" data="${JSON.stringify(data)
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></div></body></html>`;
}

function detailHtml() {
  return `<html><body>${NOTICE}<script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting", description: "PythonでCSV整理&lt;br&gt;報酬 10,000円。AI利用可。"
  })}</script></body></html>`;
}

async function collect(t, html, status = 200, expectedStop = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-scraper-boundary-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  // Stub only HTTP, so the real block detector, search inspector and detail parser run.
  t.mock.method(global, "fetch", async (url) => {
    const target = new URL(url);
    requests.push(target.pathname);
    const search = target.pathname === "/public/jobs/search";
    return { ok: search ? status >= 200 && status < 300 : true, status: search ? status : 200,
      text: async () => search ? html : detailHtml() };
  });
  const opts = { keywords: ["CSV"], outputDir: path.join(dir, "site"),
    evidenceDir: path.join(dir, "internal"), now: new Date("2026-10-13T01:30:00Z") };
  if (expectedStop) {
    await assert.rejects(runDaily(opts), (error) => {
      assert.ok(error instanceof CollectionAbortedError);
      assert.equal(error.message, "collector_access_aborted");
      assert.equal(error.diagnostics.aborted, true);
      assert.deepEqual(error.diagnostics.events, [{ stage: "search", httpStatus: status, reason: expectedStop }]);
      return true;
    });
    assert.equal(fs.existsSync(opts.outputDir), false);
    assert.equal(fs.existsSync(opts.evidenceDir), false);
    return { requests };
  }
  const report = await runDaily(opts);
  const snapshot = JSON.parse(fs.readFileSync(path.join(dir, "internal", "latest.snapshot.json"), "utf8"));
  return { report, snapshot, requests };
}

test("real fetch boundary accepts embedded listings plus the normal noscript notice", async (t) => {
  const { report, snapshot, requests } = await collect(t, searchHtml([123, 456]));
  assert.equal(report.attempts[0].ok, true);
  assert.equal(report.attempts[0].imported, 2);
  assert.equal(report.attempts[0].error, undefined);
  assert.equal(report.totalJobs, 2);
  assert.equal(report.safeCandidates, 2);
  assert.ok(report.recommendation.detailCheckedAt);
  assert.equal(snapshot.coverage.status, "complete");
  assert.equal(snapshot.retrieval.search[0].outcome, "success");
  assert.ok(snapshot.retrieval.details.every((attempt) => attempt.outcome === "success"));
  assert.deepEqual(requests, ["/public/jobs/search", "/public/jobs/123", "/public/jobs/456"]);
});

test("real fetch boundary preserves verified zero for an empty embedded list plus noscript", async (t) => {
  const { report, snapshot, requests } = await collect(t, searchHtml([]));
  assert.equal(report.attempts[0].ok, true);
  assert.equal(report.attempts[0].imported, 0);
  assert.equal(report.totalJobs, 0);
  assert.equal(report.safeCandidates, 0);
  assert.equal(snapshot.coverage.retrievedJobCount, 0);
  assert.equal(snapshot.retrieval.search[0].complete, true);
  assert.deepEqual(requests, ["/public/jobs/search"]);
});

test("HTTP200 unknown and malformed HTML remain unknown through the real fetch boundary", async (t) => {
  for (const html of ['<html><body>unrecognized page</body></html>',
    '<html><div id="vue-container" data="{bad}"></div></html>',
    '<html><div id="vue-container" data="{&quot;searchResult&quot;:{}}"></div></html>']) {
    await t.test("unrecognized response", async (t) => {
      const { report, snapshot, requests } = await collect(t, html);
      assert.equal(report.attempts[0].status, 200);
      assert.equal(report.attempts[0].ok, false);
      assert.equal(report.attempts[0].imported, null);
      assert.equal(report.attempts[0].error, "extraction_failed");
      assert.equal(report.totalJobs, null);
      assert.equal(report.safeCandidates, null);
      assert.equal(snapshot.coverage.retrievedJobCount, null);
      assert.equal(snapshot.retrieval.search[0].outcome, "extraction_failed");
      assert.deepEqual(projectPublicSummary(report), report);
      assert.deepEqual(requests, ["/public/jobs/search"]);
    });
  }
});

test("real fetch boundary rejects login and CAPTCHA even alongside embedded listing markers", async (t) => {
  for (const block of ["ログインしてください", "CAPTCHA を完了してください",
    "<noscript>ログインしてください</noscript>", "<noscript>CAPTCHA required</noscript>"]) {
    await t.test(block, async (t) => {
      const html = searchHtml([123]).replace("</body>", `<p>${block}</p></body>`);
      const { requests } = await collect(t, html, 200,
        block.includes("CAPTCHA") ? "captcha_required" : "authentication_required");
      assert.deepEqual(requests, ["/public/jobs/search"]);
    });
  }
});

test("HTTP access stops abort before saving while other HTTP errors remain unknown", async (t) => {
  for (const status of [401, 403, 429, 500]) {
    await t.test(String(status), async (t) => {
      if (status !== 500) {
        const reasons = { 401: "authentication_required", 403: "access_denied", 429: "rate_limited" };
        const { requests } = await collect(t, searchHtml([123]), status, reasons[status]);
        assert.deepEqual(requests, ["/public/jobs/search"]);
        return;
      }
      const { report, requests } = await collect(t, searchHtml([123]), status);
      assert.equal(report.attempts[0].ok, false);
      assert.equal(report.attempts[0].error, "fetch_failed");
      assert.equal(report.totalJobs, null);
      assert.deepEqual(requests, ["/public/jobs/search"]);
    });
  }
});

test("display warnings outside noscript and access congestion remain blocked", () => {
  for (const text of ["JavaScriptを有効にしてください", "javascriptを有効にしてください",
    "JAVASCRIPTを有効にしてください", "ページを正しく表示できません", "アクセスが集中しています"]) {
    assert.equal(isBlockedOrUnsupported(200, `<html><p>${text}</p></html>`), true);
  }
  assert.equal(isBlockedOrUnsupported(200, `${searchHtml([])}<NOSCRIPT class="notice">ページを正しく表示できません。</NOSCRIPT>`), false);
});

test("verified listings and empty lists also accept ordinary notices outside noscript", async (t) => {
  for (const ids of [[123], []]) {
    await t.test(ids.length ? "listing" : "verified zero", async (t) => {
      const html = searchHtml(ids).replace("</body>", "<p>ページを正しく表示できません。</p></body>");
      const { report } = await collect(t, html);
      assert.equal(report.attempts[0].ok, true);
      assert.equal(report.totalJobs, ids.length);
      assert.equal(report.attempts[0].imported, ids.length);
    });
  }
});

test("display notices alone cannot turn HTTP200 into verified zero", async (t) => {
  for (const content of ["", '<div id="vue-container" data="{bad}"></div>',
    '<div id="vue-container" data="{&quot;searchResult&quot;:{}}"></div>']) {
    await t.test("no verified structure", async (t) => {
      const { report, snapshot } = await collect(t, `<html><body>${NOTICE}${content}<p>ページを正しく表示できません。</p></body></html>`);
      assert.equal(report.attempts[0].ok, false);
      assert.equal(report.attempts[0].imported, null);
      assert.equal(report.attempts[0].error, "blocked_or_unsupported");
      assert.equal(report.totalJobs, null);
      assert.equal(snapshot.coverage.retrievedJobCount, null);
    });
  }
});

test("real search fetch reports that the normal noscript notice needs no manual import", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, text: async () => searchHtml([123]) }));
  const result = await fetchSearchPage({ keywords: "CSV" });
  assert.equal(result.needsManualImport, false);
});

test("detail JobPosting plus noscript succeeds while real detail login and CAPTCHA stop", async (t) => {
  const job = { id: "123", url: "https://crowdworks.jp/public/jobs/123", description: "search digest" };
  let html = detailHtml();
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, text: async () => html }));
  const detailed = await fetchJobDetail(job);
  assert.equal(detailed.detailFetch.outcome, "success");
  assert.ok(detailed.detailCheckedAt);
  assert.equal(detailed.contentSources.description, "detail");
  assert.match(detailed.description, /CSV整理 報酬/);
  assert.doesNotMatch(detailed.description, /JavaScriptを有効|ページを正しく/);
  html = detailHtml().replace("</body>", "<p>ページを正しく表示できません。</p></body>");
  assert.equal((await fetchJobDetail(job)).detailFetch.outcome, "success");
  for (const block of ["ログインしてください", "CAPTCHA required", "<noscript>CAPTCHA required</noscript>"]) {
    html = detailHtml().replace("</body>", `<p>${block}</p></body>`);
    const blocked = await fetchJobDetail(job);
    assert.equal(blocked.detailFetch.outcome, "fetch_failed");
    assert.equal(blocked.detailFetch.stopReason,
      block.includes("CAPTCHA") ? "captcha_required" : "authentication_required");
    assert.equal(blocked.detailCheckedAt, undefined);
    assert.equal(blocked.description, "search digest");
  }
});
