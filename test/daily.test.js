"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runDaily, renderHtml } = require("../src/daily");
const { CollectionAbortedError } = require("../src/collection-diagnostics");
const { inspectSearchResult, extractJobPublicClient, fetchJobDetail } = require("../src/scraper");

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-daily-evidence-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function searchHtml(ids, extra = {}) {
  const data = { searchResult: { job_offers: ids.map((id) => ({
    job_offer: { id, title: "Python CSV データ整理", description_digest: "CSVをPythonで整理しExcel出力。",
      category_id: 40, status: "released", expired_on: "2099-12-31", ...extra },
    payment: { fixed_price_payment: { min_budget: 10000 } }
  })) } };
  return `<div id="vue-container" data="${JSON.stringify(data).replace(/"/g, "&quot;")}"></div>`;
}

function options(dir, ids, now = "2026-10-11T02:00:00Z") {
  return { outputDir: path.join(dir, "site"), evidenceDir: path.join(dir, "internal"), keywords: ["CSV"], now: new Date(now),
    clock: () => new Date(Date.parse(now) + 1000),
    fetchSearchPage: async () => ({ ok: true, status: 200, url: "https://crowdworks.jp/public/jobs/search", html: searchHtml(ids) }),
    fetchJobDetail: async (job) => ({ ...job, detailCheckedAt: now,
      detailFetch: { ok: true, status: 200, outcome: "success" } }) };
}

function json(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, "internal", name), "utf8"));
}

async function abortedWithoutOutputs(opts, stage, status) {
  await assert.rejects(runDaily(opts), (error) => {
    assert.ok(error instanceof CollectionAbortedError);
    assert.equal(error.message, "collector_access_aborted");
    assert.equal(error.diagnostics.aborted, true);
    assert.ok(error.diagnostics.events.some((event) => event.stage === stage && event.httpStatus === status));
    return true;
  });
  assert.equal(fs.existsSync(opts.outputDir), false);
  assert.equal(fs.existsSync(opts.evidenceDir), false);
}

test("daily preserves legacy fields, adds acquisition counts and saves every machine candidate", async (t) => {
  const dir = directory(t);
  const report = await runDaily(options(dir, [123, 456]));
  assert.deepEqual(Object.keys(report).sort(), ["generatedAt", "generatedAtJst", "keywords", "attempts", "totalJobs", "safeCandidates", "recommendation", "collection"].sort());
  assert.equal(report.totalJobs, 2);
  assert.equal(report.safeCandidates, 2);
  const snapshot = json(dir, "latest.snapshot.json");
  assert.deepEqual([...snapshot.candidateIds].sort(), ["123", "456"]);
  assert.equal(snapshot.jobs.length, 2);
  assert.equal(snapshot.jobs[0].url, `https://crowdworks.jp/public/jobs/${snapshot.jobs[0].id}`);
  assert.ok(snapshot.jobs.every((job) => job.fetchedAt && job.machineJudgment));
  assert.equal(json(dir, "latest.client-review.json").acquisition.automaticHistoryFetch, "not_connected");
  assert.deepEqual(snapshot.clientReview, json(dir, "latest.client-review.json"));
});

test("internal employer review is saved separately from the previous public files", async (t) => {
  const dir = directory(t);
  const opts = options(dir, [123]);
  opts.publicHistories = [{ platform: "crowdworks", profileId: "123",
    profileUrl: "https://crowdworks.jp/public/employers/123", status: "fetched",
    observedAt: "2026-10-11T02:00:00Z",
    coverage: { pastJobs: true, currentJobs: true, publicRatings: true },
    jobs: [1, 2].map((id) => ({ platform: "crowdworks", profileId: "123", jobId: String(id),
      url: `https://crowdworks.jp/public/jobs/${id}`, visibility: "public", phase: id === 1 ? "past" : "current",
      observedAt: "2026-10-11T02:00:00Z", deliverableTags: [id === 1 ? "article" : "review"],
      purposeTags: [id === 1 ? "marketing" : "review_publication"], targetServiceTags: ["google_maps"] })) }];
  await runDaily(opts);
  assert.equal(json(dir, "latest.client-review.json").profiles[0].reviewStatus, "safety_review_required");
  assert.deepEqual(fs.readdirSync(opts.outputDir).sort(), [".nojekyll", "index.html", "latest.json", "latest.md"]);
  for (const file of fs.readdirSync(opts.outputDir)) {
    assert.doesNotMatch(fs.readFileSync(path.join(opts.outputDir, file), "utf8"),
      /public\/employers|clientReview|thirdPartyAssessments|inferences|combined_review_activity|google_maps/);
  }
});

test("public and internal output overlaps are rejected before any retrieval", async (t) => {
  const dir = directory(t);
  let calls = 0;
  const opts = options(dir, []);
  opts.fetchSearchPage = async () => { calls++; throw new Error("unexpected retrieval"); };
  for (const evidenceDir of [opts.outputDir, path.join(opts.outputDir, "collector"), dir,
    path.join(__dirname, "..", "collector-data", "observations")]) {
    await assert.rejects(runDaily({ ...opts, evidenceDir }), /internal_evidence_must_be_separate/);
  }
  // The omitted option defaults to the ignored data directory, never site/collector.
  await assert.rejects(runDaily({ ...opts, outputDir: path.join(__dirname, "..", "data"), evidenceDir: undefined }),
    /internal_evidence_must_be_separate/);
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a resolved parent alias cannot bypass internal output separation", async (t) => {
  const dir = directory(t);
  const opts = options(dir, []);
  fs.mkdirSync(opts.outputDir);
  const alias = path.join(dir, "alias");
  fs.mkdirSync(alias);
  const realpath = fs.realpathSync;
  // Model a junction resolution without requesting Windows symlink privileges.
  t.mock.method(fs, "realpathSync", (target) => target === alias ? realpath(opts.outputDir) : realpath(target));
  await assert.rejects(runDaily({ ...opts, evidenceDir: path.join(alias, "collector") }),
    /internal_evidence_must_be_separate/);
});

test("access-denied retrieval aborts before parsing error bodies or saving reports", async (t) => {
  const dir = directory(t);
  const opts = options(dir, [123]);
  opts.fetchSearchPage = async () => ({ ok: false, status: 403, html: searchHtml([999]), url: "https://crowdworks.jp/public/jobs/search" });
  await abortedWithoutOutputs(opts, "search", 403);
});

test("confirmed empty search differs from unknown extraction", async (t) => {
  const dir = directory(t);
  const report = await runDaily(options(dir, []));
  assert.equal(report.totalJobs, 0);
  assert.equal(report.attempts[0].ok, true);
  assert.equal(report.attempts[0].imported, 0);
  const opts = options(dir, [], "2026-10-11T03:00:00Z");
  opts.fetchSearchPage = async () => ({ ok: true, status: 200, html: "<html>unrecognized page</html>", url: "fixture" });
  const failed = await runDaily(opts);
  assert.equal(failed.totalJobs, null);
  assert.equal(failed.attempts[0].imported, null);
});

test("same-day reruns preserve separate observations and detect same-count replacement", async (t) => {
  const dir = directory(t);
  await runDaily(options(dir, [123]));
  await runDaily(options(dir, [456], "2026-10-11T03:00:00Z"));
  const diff = json(dir, "latest.diff.json");
  assert.equal(diff.added.length, 1);
  assert.equal(diff.disappeared.length, 1);
  assert.equal(fs.readdirSync(path.join(dir, "internal", "snapshots")).length, 2);
});

test("failed subsequent search cannot turn disappearance into closure", async (t) => {
  const dir = directory(t);
  await runDaily(options(dir, [123]));
  const opts = options(dir, [], "2026-10-11T03:00:00Z");
  opts.fetchSearchPage = async () => { throw new Error("token=private-fixture-secret name=private-person"); };
  await runDaily(opts);
  const diff = json(dir, "latest.diff.json");
  assert.equal(diff.disappeared.length, 0);
  assert.equal(diff.notObserved.length, 1);
  assert.ok(diff.retrievalFailures.length);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "site", "latest.json"), "utf8"), /private-fixture-secret|private-person/);
});

test("public client identity requires an explicit JobPosting organization profile link", () => {
  const content = (organization) => `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", hiringOrganization: organization })}</script>`;
  assert.equal(extractJobPublicClient('<a href="/public/employers/123">name</a>'), null);
  assert.equal(extractJobPublicClient(content({ url: "https://crowdworks.jp.evil.test/public/employers/123" })), null);
  assert.equal(extractJobPublicClient(content({ url: "https://crowdworks.jp/public/employers/123" })).profileId, "123");
});

test("missing embedded offer fields and duplicated URLs do not claim complete extraction", () => {
  assert.equal(inspectSearchResult('<div id="vue-container" data="{bad}"></div>').complete, false);
  const invalid = searchHtml([123], { id: "https://evil.test" });
  assert.equal(inspectSearchResult(invalid).complete, false);
});

test("detail HTTP failure and missing description stay explicit failures", async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const job = { id: "123", url: "https://crowdworks.jp/public/jobs/123", description: "CSV" };
  global.fetch = async () => ({ ok: false, status: 429, text: async () => "private error body" });
  const failed = await fetchJobDetail(job);
  assert.equal(failed.detailFetch.outcome, "fetch_failed");
  assert.equal(failed.detailFetch.stopReason, "rate_limited");
  assert.equal(failed.detailCheckedAt, undefined);
  global.fetch = async () => ({ ok: true, status: 200, text: async () => "<html>unknown</html>" });
  assert.equal((await fetchJobDetail(job)).detailFetch.outcome, "extraction_failed");
});

test("new outputs omit injected private fields and summary masks labelled contacts", async (t) => {
  const dir = directory(t);
  const opts = options(dir, [123]);
  opts.fetchJobDetail = async (job) => ({ ...job, detailCheckedAt: "2026-10-11T02:00:00Z",
    detailFetch: { ok: true, status: 200, outcome: "success" },
    description: "Python CSV データ整理 メール: fixture@example.invalid。住所: private-address。",
    privateName: "private-person", token: "private-fixture-secret" });
  await runDaily(opts);
  for (const name of ["site/latest.json", "site/index.html", "site/latest.md", "internal/latest.snapshot.json", "internal/latest.client-review.json"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, name), "utf8"), /fixture@example\.invalid|private-address|private-person|private-fixture-secret/);
  }
});

test("a fresh output directory compares with explicitly retained prior structured evidence", async (t) => {
  const first = directory(t), retained = directory(t), second = directory(t);
  await runDaily(options(first, [123]));
  fs.cpSync(path.join(first, "internal"), retained, { recursive: true });
  await runDaily({ ...options(second, [456], "2026-10-11T03:00:00Z"),
    baselinePath: path.join(retained, "latest.snapshot.json") });
  const diff = json(second, "latest.diff.json");
  assert.equal(diff.baselineStatus, "available");
  assert.equal(diff.added[0].id, "456");
  assert.equal(diff.disappeared[0].id, "123");
});

test("the explicit local history CLI saves only supported public evidence and never fetches", (t) => {
  const dir = directory(t);
  const input = path.join(dir, "public-input.json"), output = path.join(dir, "review.json");
  fs.writeFileSync(input, JSON.stringify({ histories: [{ platform: "crowdworks", profileId: "123",
    profileUrl: "https://crowdworks.jp/public/employers/123", status: "not_connected",
    observedAt: "2026-10-11T02:00:00Z", secret: "private-cli-secret", name: "private-cli-person" }] }));
  const { reviewFile } = require("../src/review-public-history");
  const original = global.fetch;
  global.fetch = () => { throw new Error("Unexpected fetch"); };
  try { assert.equal(reviewFile(input, output).profiles[0].status, "not_connected"); }
  finally { global.fetch = original; }
  assert.doesNotMatch(fs.readFileSync(output, "utf8"), /private-cli-secret|private-cli-person/);
  const { execFileSync } = require("node:child_process");
  const result = execFileSync(process.execPath,
    [path.join(__dirname, "..", "src", "review-public-history.js"), "--input", input, "--output", output], { encoding: "utf8" });
  assert.match(result, /public_history_review_saved/);
});

test("collection separates legacy decision time from completion across JST midnight", async (t) => {
  const dir = directory(t);
  const opts = options(dir, [123], "2026-10-11T14:59:59Z");
  opts.clock = () => new Date("2026-10-11T15:00:02Z");
  opts.fetchSearchPage = async () => ({ ok: true, status: 200,
    url: "https://crowdworks.jp/public/jobs/search", html: searchHtml([123], { expired_on: "2026-10-11" }) });
  const report = await runDaily(opts);
  assert.equal(report.generatedAt, "2026-10-11T14:59:59.000Z");
  assert.deepEqual(report.collection, {
    schemaVersion: 1, status: "attempts_completed",
    startedAt: "2026-10-11T14:59:59.000Z", attemptsCompletedAt: "2026-10-11T15:00:02.000Z",
    decisionAsOf: report.generatedAt,
    search: { planned: 1, attempted: 1, succeeded: 1, failed: 0, notAttempted: 0 },
    details: { observed: 1, attempted: 1, succeeded: 1, failed: 0, notAttempted: 0 },
    candidates: { machine: 1, detailConfirmed: 1, detailUnconfirmed: 0 }
  });
  // Completion on the next JST date does not silently change legacy expiry decisions.
  assert.equal(report.safeCandidates, 1);
  assert.equal(report.recommendation.id, "123");
});

test("confirmed zero, access stops, other failed searches and no configured searches remain distinct", async (t) => {
  const empty = await runDaily(options(directory(t), []));
  assert.deepEqual(empty.collection.candidates, { machine: 0, detailConfirmed: 0, detailUnconfirmed: 0 });
  assert.equal(empty.collection.search.succeeded, 1);
  for (const status of [401, 403, 429, 500]) {
    const opts = options(directory(t), []);
    opts.fetchSearchPage = async () => ({ ok: false, status, html: searchHtml([123]) });
    if (status !== 500) {
      await abortedWithoutOutputs(opts, "search", status);
      continue;
    }
    const failed = await runDaily(opts);
    assert.deepEqual(failed.collection.candidates, { machine: null, detailConfirmed: null, detailUnconfirmed: null });
    assert.equal(failed.collection.search.failed, 1);
    assert.equal(failed.totalJobs, null);
  }
  const unattempted = await runDaily({ ...options(directory(t), []), keywords: [] });
  assert.deepEqual(unattempted.collection.search,
    { planned: 0, attempted: 0, succeeded: 0, failed: 0, notAttempted: 0 });
  assert.equal(unattempted.safeCandidates, null);
});

test("partial search retains observed candidates and exposes incomplete retrieval", async (t) => {
  const opts = options(directory(t), [123]);
  opts.fetchSearchPage = async () => ({ ok: true, status: 200,
    url: "https://crowdworks.jp/public/jobs/search",
    html: searchHtml([123, 456]).replace('id&quot;:456', 'id&quot;:&quot;invalid&quot;') });
  const report = await runDaily(opts);
  assert.equal(report.totalJobs, 1);
  assert.equal(report.safeCandidates, 1);
  assert.deepEqual(report.collection.search,
    { planned: 1, attempted: 1, succeeded: 0, failed: 1, notAttempted: 0 });
  assert.equal(report.collection.candidates.detailConfirmed, 1);
});

test("detail access stops abort while other failures never become recommendations", async (t) => {
  for (const kind of ["401", "403", "429", "500", "exception", "another_id", "missing_description", "missing_metadata"]) {
    await t.test(kind, async (t) => {
      const dir = directory(t), opts = options(dir, [123]);
      opts.fetchJobDetail = async (job) => {
        if (kind === "exception") throw new Error("private-detail-error-body");
        if (kind === "another_id") return { ...job, id: "999", url: "https://crowdworks.jp/public/jobs/999",
          detailCheckedAt: opts.now.toISOString(), detailFetch: { ok: true, status: 200, outcome: "success" } };
        if (kind === "missing_description") return { ...job, description: "", detailCheckedAt: opts.now.toISOString(),
          detailFetch: { ok: true, status: 200, outcome: "success" } };
        if (kind === "missing_metadata") return { ...job, detailCheckedAt: opts.now.toISOString() };
        return { ...job, detailCheckedAt: opts.now.toISOString(),
          detailFetch: { ok: false, status: Number(kind), outcome: "fetch_failed" } };
      };
      if (["401", "403", "429"].includes(kind)) {
        await abortedWithoutOutputs(opts, "detail", Number(kind));
        return;
      }
      const report = await runDaily(opts);
      assert.equal(report.recommendation, null);
      // Search fallbacks still count under the existing machine-candidate definition.
      assert.equal(report.safeCandidates, 1);
      assert.deepEqual(report.collection.details,
        { observed: 1, attempted: 1, succeeded: 0, failed: 1, notAttempted: 0 });
      assert.deepEqual(report.collection.candidates, { machine: 1, detailConfirmed: 0, detailUnconfirmed: 1 });
      assert.equal(json(dir, "latest.snapshot.json").retrieval.details[0].ok, false);
      assert.match(fs.readFileSync(path.join(opts.outputDir, "index.html"), "utf8"), /機械候補はありますが/);
      assert.match(fs.readFileSync(path.join(opts.outputDir, "latest.md"), "utf8"), /詳細確認済みの推薦候補はありません/);
      assert.doesNotMatch(fs.readFileSync(path.join(opts.outputDir, "latest.json"), "utf8"), /private-detail-error-body/);
    });
  }
});

test("stale, future and invalid detail timestamps cannot attest this execution", async (t) => {
  for (const stamp of ["2026-10-10T02:00:00Z", "2026-10-11T02:00:02Z", "invalid"]) {
    const opts = options(directory(t), [123]);
    opts.fetchJobDetail = async (job) => ({ ...job, detailCheckedAt: stamp,
      detailFetch: { ok: true, status: 200, outcome: "success" } });
    const report = await runDaily(opts);
    assert.equal(report.recommendation, null);
    assert.equal(report.collection.details.succeeded, 0);
    assert.equal(report.collection.details.failed, 1);
  }
});

test("an explicit not-attempted adapter stays unattempted and unconfirmed", async (t) => {
  const opts = options(directory(t), [123]);
  opts.fetchJobDetail = async (job) => ({ ...job,
    detailFetch: { ok: false, status: null, outcome: "not_attempted" } });
  const report = await runDaily(opts);
  assert.deepEqual(report.collection.details,
    { observed: 1, attempted: 0, succeeded: 0, failed: 0, notAttempted: 1 });
  assert.equal(report.safeCandidates, 1);
  assert.equal(report.recommendation, null);
});

test("partial detail success continues only when the other failure does not require an access stop", async (t) => {
  for (const status of [429, 500]) {
    const opts = options(directory(t), [123, 456]);
    let detailCalls = 0;
    opts.fetchJobDetail = async (job) => { detailCalls++; return { ...job, detailCheckedAt: opts.now.toISOString(),
      detailFetch: String(job.id) === "123" ? { ok: false, status, outcome: "fetch_failed" }
        : { ok: true, status: 200, outcome: "success" } }; };
    if (status === 429) {
      await abortedWithoutOutputs(opts, "detail", status);
      assert.equal(detailCalls, 1);
      continue;
    }
    const report = await runDaily(opts);
    assert.equal(detailCalls, 2);
    assert.equal(report.safeCandidates, 2);
    assert.equal(report.recommendation.id, "456");
    assert.deepEqual(report.collection.candidates, { machine: 2, detailConfirmed: 1, detailUnconfirmed: 1 });
    assert.match(report.recommendation.selectionReasons.join(" "), /AI利用許可・採算・応募資格・安全性は別途確認/);
  }
});

test("detail cap and risk exclusions remain unattempted without expanding collection", async (t) => {
  const opts = options(directory(t), Array.from({ length: 82 }, (_, i) => i + 1));
  let calls = 0;
  opts.fetchJobDetail = async (job) => { calls++; return { ...job, detailCheckedAt: opts.now.toISOString(),
    detailFetch: { ok: true, status: 200, outcome: "success" } }; };
  const report = await runDaily(opts);
  assert.equal(calls, 80);
  assert.equal(report.totalJobs, 82);
  assert.equal(report.safeCandidates, 80);
  assert.deepEqual(report.collection.details,
    { observed: 82, attempted: 80, succeeded: 80, failed: 0, notAttempted: 2 });
  const risky = { ...options(directory(t), []), fetchSearchPage: async () => ({ ok: true, status: 200,
    url: "https://crowdworks.jp/public/jobs/search", html: searchHtml([123], { title: "AI使用禁止 案件" }) }) };
  const riskReport = await runDaily(risky);
  assert.equal(riskReport.collection.details.notAttempted, 1);
  assert.equal(riskReport.collection.details.attempted, 0);
});

test("invalid or backwards completion clocks fail without publishing a fabricated completion", async (t) => {
  for (const clock of [() => new Date("invalid"), () => new Date("2026-10-11T01:59:59Z")]) {
    const dir = directory(t), opts = { ...options(dir, [123]), clock };
    await assert.rejects(runDaily(opts), /invalid_collection_clock/);
    assert.equal(fs.existsSync(opts.outputDir), false);
    assert.equal(fs.existsSync(opts.evidenceDir), false);
  }
});

test("legacy rendering leaves attempt completion UNKNOWN", () => {
  const legacy = { generatedAt: "2026-10-11T02:00:00.000Z", generatedAtJst: "fixture-time", attempts: [],
    totalJobs: 0, safeCandidates: 0, recommendation: null };
  assert.match(renderHtml(legacy), /取得試行完了: UNKNOWN/);
});

test("v2 detail calendar overflow and zone-less timestamps are not current-run evidence", async (t) => {
  for (const stamp of ["2026-02-30T02:00:00Z", "2026-03-02T02:00:00", "2026-03-02T02:00:00.0001Z"]) {
    const dir = directory(t), opts = options(dir, [123], "2026-02-28T00:00:00Z");
    opts.clock = () => new Date("2026-03-03T00:00:00Z");
    opts.fetchJobDetail = async (job) => ({ ...job, importedAt: opts.now.toISOString(), detailCheckedAt: stamp,
      detailFetch: { ok: true, status: 200, outcome: "success" } });
    const report = await runDaily(opts);
    assert.equal(report.recommendation, null, stamp);
    assert.equal(report.safeCandidates, 1);
    assert.equal(report.collection.details.failed, 1);
    assert.equal(json(dir, "latest.snapshot.json").jobs[0].fetchedAt, opts.now.toISOString());
  }
});

test("v2 valid offset detail timestamps are normalized before all outputs", async (t) => {
  const dir = directory(t), opts = options(dir, [123]);
  opts.fetchJobDetail = async (job) => ({ ...job, detailCheckedAt: "2026-10-11T11:00:00+09:00",
    detailFetch: { ok: true, status: 200, outcome: "success" } });
  const report = await runDaily(opts);
  assert.equal(report.recommendation.detailCheckedAt, opts.now.toISOString());
  assert.equal(json(dir, "latest.snapshot.json").jobs[0].fetchedAt, opts.now.toISOString());
  assert.equal(report.collection.candidates.detailConfirmed, 1);
});

test("v2 numerically equivalent detail IDs do not create duplicate snapshot observations", async (t) => {
  const dir = directory(t), opts = options(dir, [123]);
  opts.fetchJobDetail = async (job) => ({ ...job, id: 123, detailCheckedAt: opts.now.toISOString(),
    detailFetch: { ok: true, status: 200, outcome: "success" } });
  const report = await runDaily(opts);
  const snapshot = json(dir, "latest.snapshot.json");
  assert.equal(report.recommendation.id, "123");
  assert.deepEqual(snapshot.quality.duplicateIds, []);
  assert.equal(snapshot.jobs.length, 1);
  assert.deepEqual(snapshot.candidateIds, ["123"]);
});

test("v2 a detail adapter cannot rewrite the requested identity in place", async (t) => {
  const dir = directory(t), opts = options(dir, [123]);
  opts.fetchJobDetail = async (job) => {
    job.id = "999";
    job.url = "https://crowdworks.jp/public/jobs/999";
    job.detailCheckedAt = opts.now.toISOString();
    job.detailFetch = { ok: true, status: 200, outcome: "success" };
    return job;
  };
  const report = await runDaily(opts), snapshot = json(dir, "latest.snapshot.json");
  assert.equal(report.recommendation, null);
  assert.equal(report.safeCandidates, 1);
  assert.deepEqual(snapshot.jobs.map((job) => job.id), ["123"]);
  assert.equal(snapshot.retrieval.details[0].jobId, "123");
  assert.equal(snapshot.retrieval.details[0].ok, false);
});

test("v2 failed or future detail timestamps cannot replace the search observation time", async (t) => {
  for (const ok of [false, true]) {
    const dir = directory(t), opts = options(dir, [123]);
    opts.fetchJobDetail = async (job) => ({ ...job, importedAt: opts.now.toISOString(),
      detailCheckedAt: "2099-01-01T00:00:00Z",
      detailFetch: { ok, status: ok ? 200 : 403, outcome: ok ? "success" : "fetch_failed" } });
    if (!ok) {
      await abortedWithoutOutputs(opts, "detail", 403);
      continue;
    }
    const report = await runDaily(opts), snapshot = json(dir, "latest.snapshot.json");
    assert.equal(report.recommendation, null);
    assert.equal(snapshot.jobs[0].detailStatus, ok ? "extraction_failed" : "fetch_failed");
    assert.equal(snapshot.jobs[0].fetchedAt, opts.now.toISOString());
  }
});

test("v2 contradictory search-only sources and markup-only descriptions are not detail success", async (t) => {
  for (const extra of [{ contentSources: { description: "search" } }, { description: " <p> </p> " }]) {
    const dir = directory(t), opts = options(dir, [123]);
    opts.fetchJobDetail = async (job) => ({ ...job, detailCheckedAt: opts.now.toISOString(),
      detailFetch: { ok: true, status: 200, outcome: "success" }, ...extra });
    const report = await runDaily(opts);
    assert.equal(report.recommendation, null);
    assert.equal(report.collection.details.succeeded, 0);
    assert.equal(report.collection.details.failed, 1);
  }
});

test("v2 invalid recommendation deadlines preserve machine and detail-confirmed counts", async (t) => {
  for (const expiry of ["not-a-date", "2026-02-30", "2026-10-11T00:00:00Z", 123, 0, false]) {
    const dir = directory(t), opts = options(dir, [123], "2026-02-28T02:00:00Z");
    opts.fetchJobDetail = async (job) => ({ ...job, expiresAt: expiry, detailCheckedAt: opts.now.toISOString(),
      detailFetch: { ok: true, status: 200, outcome: "success" } });
    const report = await runDaily(opts);
    assert.equal(report.safeCandidates, 1, String(expiry));
    assert.equal(report.collection.candidates.detailConfirmed, 1);
    assert.equal(report.recommendation, null);
    const html = fs.readFileSync(path.join(opts.outputDir, "index.html"), "utf8");
    const markdown = fs.readFileSync(path.join(opts.outputDir, "latest.md"), "utf8");
    assert.match(html, /掲載期限などの推薦条件を確認できませんでした/);
    assert.match(markdown, /掲載期限などの推薦条件を確認できませんでした/);
    assert.doesNotMatch(html, /この実行で詳細本文を確認できていない/);
  }
});

test("v2 a valid deadline candidate can follow a confirmed candidate with an invalid deadline", async (t) => {
  const opts = options(directory(t), [123, 456]);
  opts.fetchJobDetail = async (job) => ({ ...job, expiresAt: job.id === "123" ? "invalid" : "2099-12-31",
    detailCheckedAt: opts.now.toISOString(), detailFetch: { ok: true, status: 200, outcome: "success" } });
  const report = await runDaily(opts);
  assert.equal(report.safeCandidates, 2);
  assert.equal(report.collection.candidates.detailConfirmed, 2);
  assert.equal(report.recommendation.id, "456");
});

test("v2 only explicitly absent deadlines retain the legacy no-deadline recommendation", async (t) => {
  for (const expiry of [undefined, null, ""]) {
    const opts = options(directory(t), [123]);
    opts.fetchJobDetail = async (job) => ({ ...job, expiresAt: expiry, detailCheckedAt: opts.now.toISOString(),
      detailFetch: { ok: true, status: 200, outcome: "success" } });
    const report = await runDaily(opts);
    assert.equal(report.recommendation.id, "123");
    assert.equal(report.safeCandidates, 1);
    assert.equal(report.collection.candidates.detailConfirmed, 1);
  }
});

test("v2 legacy start-time expiry decisions remain unchanged at the Japanese day-end boundary", async (t) => {
  for (const [stamp, candidates] of [["2026-10-11T14:59:58Z", 1], ["2026-10-11T14:59:59Z", 1],
    ["2026-10-11T14:59:59.001Z", 0], ["2026-10-11T15:00:00Z", 0]]) {
    const opts = options(directory(t), [123], stamp);
    opts.fetchSearchPage = async () => ({ ok: true, status: 200,
      url: "https://crowdworks.jp/public/jobs/search", html: searchHtml([123], { expired_on: "2026-10-11" }) });
    const report = await runDaily(opts);
    assert.equal(report.safeCandidates, candidates, stamp);
    assert.equal(report.collection.candidates.detailConfirmed, candidates);
    assert.equal(report.recommendation !== null, candidates === 1);
    assert.equal(report.collection.decisionAsOf, opts.now.toISOString());
  }
});

test("v2 public-reference filtering cannot turn all-invalid or partial search rows into complete success", async (t) => {
  for (const ids of [[0], ["00"], [123, 0]]) {
    const dir = directory(t), opts = options(dir, ids);
    const report = await runDaily(opts), snapshot = json(dir, "latest.snapshot.json");
    const observed = ids.includes(123);
    assert.equal(report.attempts[0].ok, false);
    assert.equal(report.attempts[0].error, "extraction_failed");
    assert.equal(report.attempts[0].imported, observed ? 1 : null);
    assert.equal(report.collection.search.succeeded, 0);
    assert.equal(report.collection.search.failed, 1);
    assert.equal(report.totalJobs, observed ? 1 : null);
    assert.equal(report.safeCandidates, observed ? 1 : null);
    assert.equal(snapshot.coverage.retrievedJobCount, report.totalJobs);
    assert.equal(snapshot.coverage.candidateCount, report.safeCandidates);
    assert.equal(snapshot.retrieval.search[0].outcome, "extraction_failed");
  }
});

test("v2 search access stops override contradictory adapter success and all other failures remain unparsed", async (t) => {
  for (const [ok, status] of [[true, 401], [true, 403], [true, 429], [true, null], [true, "200"], [true, NaN],
    [true, 200.5], [true, 600], [true, 0], [false, 200], ["true", 200], [1, 200], [null, 200]]) {
    const dir = directory(t), opts = options(dir, [123]);
    let details = 0;
    opts.fetchSearchPage = async () => ({ ok, status, html: searchHtml([123]),
      url: "https://crowdworks.jp/public/jobs/search" });
    opts.fetchJobDetail = async () => { details++; throw new Error("unexpected_detail_after_failed_search"); };
    if ([401, 403, 429].includes(status)) {
      await abortedWithoutOutputs(opts, "search", status);
      assert.equal(details, 0);
      continue;
    }
    const report = await runDaily(opts), snapshot = json(dir, "latest.snapshot.json");
    assert.equal(report.totalJobs, null, `ok=${String(ok)}, status=${String(status)}`);
    assert.equal(report.safeCandidates, null);
    assert.equal(report.recommendation, null);
    assert.equal(report.attempts[0].ok, false);
    assert.equal(report.attempts[0].imported, null);
    assert.equal(report.attempts[0].error, "fetch_failed");
    assert.equal(report.collection.search.failed, 1);
    assert.equal(report.collection.details.observed, 0);
    assert.equal(details, 0);
    assert.deepEqual(snapshot.jobs, []);
    assert.equal(snapshot.retrieval.search[0].outcome, "fetch_failed");
  }
  for (const status of [200, 201, 204, 299]) {
    const opts = options(directory(t), [123]);
    opts.fetchSearchPage = async () => ({ ok: true, status, html: searchHtml([123]),
      url: "https://crowdworks.jp/public/jobs/search" });
    const report = await runDaily(opts);
    assert.equal(report.totalJobs, 1);
    assert.equal(report.collection.search.succeeded, 1);
    assert.equal(report.recommendation.id, "123");
  }
});
