"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runDaily, renderHtml } = require("../src/daily");
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
    fetchSearchPage: async () => ({ ok: true, status: 200, url: "https://crowdworks.jp/public/jobs/search", html: searchHtml(ids) }),
    fetchJobDetail: async (job) => ({ ...job, detailCheckedAt: now }) };
}

function json(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, "internal", name), "utf8"));
}

test("daily keeps summary shape and saves every machine candidate with exact references", async (t) => {
  const dir = directory(t);
  const report = await runDaily(options(dir, [123, 456]));
  assert.deepEqual(Object.keys(report).sort(), ["generatedAt", "generatedAtJst", "keywords", "attempts", "totalJobs", "safeCandidates", "recommendation"].sort());
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

test("failed retrieval has unknown counts and does not parse error bodies", async (t) => {
  const dir = directory(t);
  const opts = options(dir, [123]);
  opts.fetchSearchPage = async () => ({ ok: false, status: 403, html: searchHtml([999]), url: "https://crowdworks.jp/public/jobs/search" });
  const report = await runDaily(opts);
  assert.equal(report.totalJobs, null);
  assert.equal(report.safeCandidates, null);
  assert.equal(report.attempts[0].imported, null);
  assert.equal(json(dir, "latest.snapshot.json").jobs.length, 0);
  assert.match(renderHtml(report), /未確認/);
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
  assert.equal(failed.detailCheckedAt, undefined);
  global.fetch = async () => ({ ok: true, status: 200, text: async () => "<html>unknown</html>" });
  assert.equal((await fetchJobDetail(job)).detailFetch.outcome, "extraction_failed");
});

test("new outputs omit injected private fields and summary masks labelled contacts", async (t) => {
  const dir = directory(t);
  const opts = options(dir, [123]);
  opts.fetchJobDetail = async (job) => ({ ...job, detailCheckedAt: "2026-10-11T02:00:00Z",
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
