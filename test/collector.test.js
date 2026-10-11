"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSnapshot, compareSnapshots, readBaseline, saveSnapshot, searchScopeId } = require("../src/collector");

const FIRST = "2026-10-11T01:00:00.000Z";
const SECOND = "2026-10-11T02:00:00.000Z";

function job(id, extra = {}) {
  return { id: String(id), url: `https://crowdworks.jp/public/jobs/${id}`, title: "Python CSV JSON API",
    description: "Python CSV processing with Excel output", budget: "10,000円", category: "system",
    importedAt: FIRST, ...extra };
}

function attempt(observedIds, extra = {}) {
  return { keyword: "CSV", page: 1, ok: true, status: 200, outcome: "success",
    imported: observedIds.length, observedIds: observedIds.map(String), ...extra };
}

function snapshot(jobs, extra = {}) {
  return buildSnapshot({ jobs, candidateIds: jobs.map((job) => job.id),
    attempts: [attempt(jobs.map((job) => job.id))], now: FIRST, ...extra });
}

function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-collector-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("snapshot persists every observed ID and recomputed machine reasons with canonical URLs", () => {
  const result = snapshot([job(1, { url: "https://crowdworks.jp/public/jobs/1?tracking=discard#fragment",
    analysis: { canExecute: false, riskFlags: ["invented"] } }), job(2)]);
  assert.deepEqual(result.jobs.map((job) => job.id), ["1", "2"]);
  assert.deepEqual(result.candidateIds, ["1", "2"]);
  assert.equal(result.jobs[0].url, "https://crowdworks.jp/public/jobs/1");
  assert.equal(result.jobs[0].fetchedAt, FIRST);
  assert.equal(result.jobs[0].machineJudgment.canExecute, true);
  assert.ok(result.jobs[0].machineJudgment.reasonCodes.includes("machine_candidate"));
  assert.ok(result.jobs[0].machineJudgment.strongSignals.includes("python"));
  assert.equal(result.jobs[0].machineJudgment.riskFlags.includes("invented"), false);
  assert.equal(result.coverage.retrievedJobCount, 2);
});

test("same-count replacement is added plus disappeared, never inferred closure", () => {
  const before = snapshot([job(1), job(2)]);
  const after = snapshot([job(2), job(3)], { now: SECOND });
  const diff = compareSnapshots(before, after);
  assert.equal(before.coverage.retrievedJobCount, after.coverage.retrievedJobCount);
  assert.deepEqual(diff.added.map((job) => job.id), ["3"]);
  assert.deepEqual(diff.disappeared.map((job) => job.id), ["1"]);
  assert.equal(diff.disappeared[0].meaning, "absent_from_retrieved_list");
  assert.ok(diff.limitations.includes("disappearance_does_not_establish_closure_or_violation"));
  assert.deepEqual(diff.notObserved, []);
});

test("changes compare content hashes and machine decisions while ignoring fetch timestamps", () => {
  const before = snapshot([job(1)]);
  const unchanged = snapshot([job(1, { importedAt: SECOND })], { now: SECOND });
  assert.deepEqual(compareSnapshots(before, unchanged).changed, []);
  const changed = snapshot([job(1, { description: "CSV revised business output", importedAt: SECOND })], { now: SECOND });
  assert.ok(compareSnapshots(before, changed).changed[0].fields.includes("description"));
  const risky = snapshot([job(1, { description: "レビュー投稿" })], { now: SECOND });
  assert.deepEqual(risky.candidateIds, []);
  assert.deepEqual(risky.quality.rejectedCandidateIds, ["1"]);
  assert.ok(compareSnapshots(before, risky).changed[0].fields.includes("machineJudgment"));
});

test("failed or unattempted acquisition stays null whereas successfully retrieved empty is zero", () => {
  const failed = snapshot([], { attempts: [attempt([], { ok: false, status: 403, outcome: "fetch_failed", imported: 0, error: "secret" })] });
  assert.equal(failed.coverage.status, "failed");
  assert.equal(failed.coverage.retrievedJobCount, null);
  assert.equal(failed.coverage.candidateCount, null);
  assert.equal(failed.retrieval.search[0].imported, null);
  const unattempted = buildSnapshot({ now: FIRST });
  assert.equal(unattempted.coverage.status, "not_attempted");
  assert.equal(unattempted.coverage.retrievedJobCount, null);
  const empty = snapshot([]);
  assert.equal(empty.coverage.status, "complete");
  assert.equal(empty.coverage.retrievedJobCount, 0);
  assert.equal(empty.coverage.candidateCount, 0);
});

test("failed or missing scope yields notObserved and explicit retrieval failure", () => {
  const before = snapshot([job(1)]);
  const failed = snapshot([], { now: SECOND, attempts: [attempt([], { ok: false, status: 500, outcome: "fetch_failed" })] });
  const diff = compareSnapshots(before, failed);
  assert.deepEqual(diff.disappeared, []);
  assert.deepEqual(diff.notObserved.map((job) => job.id), ["1"]);
  assert.equal(diff.notObserved[0].reason, "coverage_insufficient");
  assert.equal(diff.retrievalFailures[0].outcome, "fetch_failed");
  const differentScope = snapshot([], { attempts: [attempt([], { keyword: "HTML" })], now: SECOND });
  assert.equal(compareSnapshots(before, differentScope).notObserved.length, 1);
});

test("all prior source scopes must be complete before reporting disappearance", () => {
  const before = snapshot([job(1)], { attempts: [attempt([1]), attempt([1], { keyword: "Python" })] });
  const partial = snapshot([], { now: SECOND, attempts: [attempt([]), attempt([], { keyword: "Python", ok: false, status: 0, outcome: "fetch_failed" })] });
  assert.equal(partial.coverage.status, "partial");
  assert.equal(compareSnapshots(before, partial).disappeared.length, 0);
  assert.equal(compareSnapshots(before, partial).notObserved.length, 1);
  const incomplete = snapshot([], { attempts: [attempt([], { complete: false })], now: SECOND });
  assert.equal(compareSnapshots(snapshot([job(1)]), incomplete).disappeared.length, 0);
});

test("duplicate attempts cannot hide one failed acquisition of the same scope", () => {
  const before = snapshot([job(1)]);
  const after = snapshot([], { now: SECOND, attempts: [attempt([]), attempt([], { ok: false, status: 500, outcome: "fetch_failed" })] });
  assert.equal(compareSnapshots(before, after).disappeared.length, 0);
});

test("duplicate IDs are deduplicated, conflicts are recorded, and input order is deterministic", () => {
  const duplicates = snapshot([job(1), job(1)]);
  assert.equal(duplicates.jobs.length, 1);
  assert.deepEqual(duplicates.quality.duplicateIds, ["1"]);
  assert.deepEqual(duplicates.quality.conflictingDuplicateIds, []);
  const older = job(1);
  const newer = job(1, { description: "revised CSV output", importedAt: SECOND });
  const forward = snapshot([older, newer]);
  const reverse = snapshot([newer, older]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.jobs[0].fetchedAt, SECOND);
  assert.deepEqual(forward.quality.conflictingDuplicateIds, ["1"]);
});

test("missing jobs, invalid canonical references and legacy attempt metadata do not establish coverage", () => {
  const before = snapshot([job(1)]);
  const after = snapshot([job(2, { url: "https://example.com/public/jobs/2" })], { now: SECOND });
  assert.equal(after.quality.invalidJobCount, 1);
  assert.equal(after.coverage.status, "partial");
  assert.equal(after.coverage.retrievedJobCount, null);
  assert.equal(after.retrieval.search[0].complete, false);
  assert.equal(compareSnapshots(before, after).disappeared.length, 0);
  const missingCandidates = snapshot([], { candidateIds: ["99"] });
  assert.deepEqual(missingCandidates.quality.unobservedCandidateIds, ["99"]);
  const legacyAttempts = snapshot([], { attempts: [{ keyword: "CSV", ok: true, status: 200, imported: 0 }] });
  assert.equal(legacyAttempts.coverage.retrievedJobCount, null);
  assert.equal(legacyAttempts.retrieval.search[0].outcome, "extraction_failed");
  const noSourceBefore = snapshot([job(1)], { attempts: [] });
  assert.equal(compareSnapshots(noSourceBefore, snapshot([])).notObserved[0].reason, "baseline_source_unknown");
});

test("detail failures remain distinct from list disappearance and known observations", () => {
  const result = snapshot([job(1)], { detailAttempts: [{ jobId: "1", ok: false, status: 403, outcome: "fetch_failed", error: "credentials" }] });
  assert.equal(result.jobs[0].detailStatus, "fetch_failed");
  assert.equal(result.coverage.retrievedJobCount, 1);
  const diff = compareSnapshots(snapshot([job(1)]), result);
  assert.deepEqual(diff.disappeared, []);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.retrievalFailures, [{ type: "detail", jobId: "1", outcome: "fetch_failed", status: 403 }]);
});

test("loss of detail coverage does not mislabel fallback search text as a business change", () => {
  const before = snapshot([job(1, { description: "full detailed CSV Python API JSON instructions", detailCheckedAt: FIRST })], {
    detailAttempts: [{ jobId: "1", ok: true, status: 200, outcome: "success" }]
  });
  const after = snapshot([job(1, { description: "short CSV digest" })], { now: SECOND,
    detailAttempts: [{ jobId: "1", ok: false, status: 403, outcome: "fetch_failed" }]
  });
  const diff = compareSnapshots(before, after);
  assert.deepEqual(diff.changed, []);
  assert.equal(diff.comparisonInsufficient.length, 1);
  assert.ok(diff.comparisonInsufficient[0].fields.includes("description"));
  assert.ok(diff.comparisonInsufficient[0].fields.includes("machineJudgment"));
  assert.ok(diff.comparisonInsufficient[0].fields.includes("candidate"));
  assert.equal(diff.retrievalFailures[0].type, "detail");
});

test("successful detail with unchanged search budget preserves field-level provenance", () => {
  const result = snapshot([job(1, { detailCheckedAt: FIRST, contentSources: { description: "detail", budget: "search" } })], {
    detailAttempts: [{ jobId: "1", ok: true, status: 200, outcome: "success" }]
  });
  assert.equal(result.jobs[0].contentSources.description, "detail");
  assert.equal(result.jobs[0].contentSources.budget, "search");
});

test("explicit same-platform profile IDs are kept while cross-platform or inferred associations are dropped", () => {
  const result = snapshot([job(1, { publicClient: { platform: "crowdworks", profileId: "42",
    url: "https://crowdworks.jp/public/employers/42", name: "do not save" } }),
  job(2, { publicClient: { platform: "lancers", profileId: "another", url: "https://www.lancers.jp/client/another" } }),
  job(3, { clientName: "similar name", profileId: "42" })]);
  assert.equal(result.jobs[0].profileRef.profileId, "42");
  assert.equal(Object.hasOwn(result.jobs[0].profileRef, "name"), false);
  assert.equal(Object.hasOwn(result.jobs[1], "profileRef"), false);
  assert.equal(Object.hasOwn(result.jobs[2], "profileRef"), false);
});

test("CrowdWorks-only Collector rejects another platform instead of merging equal numeric IDs", () => {
  const result = snapshot([job(1), job(1, { platform: "lancers", url: "https://www.lancers.jp/work/detail/1" })]);
  assert.equal(result.platform, "crowdworks");
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].platform, "crowdworks");
  assert.equal(result.quality.invalidJobCount, 1);
  assert.deepEqual(result.quality.duplicateIds, []);
});

test("snapshot and diff allowlists discard personal data, secrets and caller-supplied explanations", () => {
  const secret = "PRIVATE_CONTACT_alice@example.test_TOKEN123";
  const result = snapshot([job(1, { title: `Python CSV JSON ${secret}`, description: `API ${secret}`,
    name: secret, contact: secret, profile: secret, password: secret, client: { email: secret },
    sourceUrl: `https://crowdworks.jp/public/jobs/search?q=${secret}`,
    analysis: { strongSignals: [secret], riskFlags: [secret], explanation: secret } })], {
    attempts: [attempt([1], { keyword: secret, error: secret, token: secret })],
    detailAttempts: [{ jobId: "1", ok: false, outcome: "fetch_failed", error: secret }],
    clientReview: { secret, profiles: [{ name: secret, email: secret }] }
  });
  const serialized = JSON.stringify(result) + JSON.stringify(compareSnapshots(null, result));
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("alice@example"), false);
  assert.equal(Object.hasOwn(result.jobs[0], "title"), false);
  assert.equal(Object.hasOwn(result.jobs[0], "description"), false);
  assert.match(result.jobs[0].contentHashes.title, /^[a-f0-9]{64}$/);
  assert.match(result.jobs[0].observedIn[0], /^scope-[a-f0-9]{64}$/);
});

test("scope IDs are stable for equal configured scopes and separate pages", () => {
  assert.equal(searchScopeId({ keyword: "CSV", page: 1 }), searchScopeId({ keyword: "CSV", page: 1 }));
  assert.notEqual(searchScopeId({ keyword: "CSV", page: 1 }), searchScopeId({ keyword: "CSV", page: 2 }));
});

test("synthetic legacy summary remains insufficient and cannot invent the missing candidate IDs", (t) => {
  const dir = temporaryDirectory(t);
  const canonical = path.join(__dirname, "fixtures", "collector-summary-synthetic.json");
  const report = JSON.parse(fs.readFileSync(canonical, "utf8"));
  const baseline = readBaseline(dir, { baselinePath: canonical });
  assert.equal(report.totalJobs, 37);
  assert.equal(report.safeCandidates, 4);
  assert.equal(baseline.status, "legacy_summary");
  assert.equal(baseline.snapshot, null);
  const diff = compareSnapshots(baseline, snapshot([job(1)]));
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.disappeared, []);
  assert.equal(diff.baselineStatus, "legacy_summary");
  assert.ok(diff.limitations.includes("baseline_insufficient_for_change_detection"));
});

test("missing and malformed baselines stay distinct from a successful empty observation", (t) => {
  const dir = temporaryDirectory(t);
  assert.equal(readBaseline(dir).status, "missing");
  assert.equal(compareSnapshots(null, snapshot([])).baselineStatus, "missing");
  fs.writeFileSync(path.join(dir, "latest.snapshot.json"), "{malformed", "utf8");
  assert.equal(readBaseline(dir).status, "invalid");
  assert.equal(compareSnapshots({ schemaVersion: 1 }, snapshot([])).baselineStatus, "invalid");
  assert.equal(compareSnapshots({ ...snapshot([]), jobs: [null] }, snapshot([])).baselineStatus, "invalid");
  assert.equal(compareSnapshots({ ...snapshot([]), retrieval: { search: [null], details: [] } }, snapshot([])).baselineStatus, "invalid");
  const privateStatus = compareSnapshots({ status: "TOKEN123 alice@example.test" }, snapshot([]));
  assert.equal(privateStatus.baselineStatus, "invalid");
  assert.equal(JSON.stringify(privateStatus).includes("TOKEN123"), false);
});

test("recovery after failed run reports unknown prior presence instead of false additions", (t) => {
  const dir = temporaryDirectory(t);
  saveSnapshot(dir, snapshot([job(1)]));
  const failed = saveSnapshot(dir, snapshot([], { now: SECOND, attempts: [attempt([], { ok: false, status: 503, outcome: "fetch_failed" })] }));
  assert.equal(failed.diff.notObserved[0].id, "1");
  const recovered = saveSnapshot(dir, snapshot([job(1), job(2)], { now: "2026-10-11T03:00:00.000Z" }));
  assert.deepEqual(recovered.diff.added, []);
  assert.deepEqual(recovered.diff.firstObserved.map((job) => job.id), ["1", "2"]);
  assert.equal(recovered.diff.previousRunId, failed.snapshot.runId);
  assert.equal(fs.readdirSync(path.join(dir, "snapshots")).length, 3);
});

test("same-day runs have separate history and exact reruns preserve the original diff", (t) => {
  const dir = temporaryDirectory(t);
  const first = saveSnapshot(dir, snapshot([job(1)]));
  const second = saveSnapshot(dir, snapshot([job(2)], { now: SECOND }));
  assert.notEqual(first.snapshot.runId, second.snapshot.runId);
  assert.deepEqual(second.diff.added.map((job) => job.id), ["2"]);
  assert.deepEqual(second.diff.disappeared.map((job) => job.id), ["1"]);
  assert.equal(fs.readdirSync(path.join(dir, "snapshots")).length, 2);
  const rerun = saveSnapshot(dir, second.snapshot);
  assert.equal(rerun.idempotent, true);
  assert.deepEqual(rerun.diff, second.diff);
  assert.equal(fs.readdirSync(path.join(dir, "snapshots")).length, 2);
  assert.equal(readBaseline(dir).snapshot.runId, second.snapshot.runId);
});

test("same timestamp with different actual content is preserved as a different run", (t) => {
  const dir = temporaryDirectory(t);
  const first = saveSnapshot(dir, snapshot([job(1)]));
  const changed = saveSnapshot(dir, snapshot([job(1, { description: "revised CSV output" })]));
  assert.notEqual(first.snapshot.runId, changed.snapshot.runId);
  assert.equal(fs.readdirSync(path.join(dir, "snapshots")).length, 2);
  assert.ok(changed.diff.changed[0].fields.includes("description"));
});

test("saving strips unknown fields and rejects malformed snapshot IDs", (t) => {
  const dir = temporaryDirectory(t);
  const original = snapshot([job(1)]);
  const result = saveSnapshot(dir, { ...original, secret: "TOKEN123", jobs: original.jobs.map((job) => ({ ...job, email: "alice@example.test" })) });
  const serialized = fs.readFileSync(result.paths.snapshot, "utf8");
  assert.equal(serialized.includes("TOKEN123"), false);
  assert.equal(serialized.includes("alice@example.test"), false);
  assert.throws(() => saveSnapshot(dir, { ...original, jobs: [{ ...original.jobs[0], id: "not-an-id" }] }), /Invalid Collector snapshot/);
});

test("idempotent reads strip private free text from an existing stored diff", (t) => {
  const dir = temporaryDirectory(t);
  const first = saveSnapshot(dir, snapshot([job(1)]));
  const contaminated = { ...first.diff, secret: "TOKEN123", baselineStatus: "TOKEN123",
    added: [{ id: "1", url: "https://crowdworks.jp/public/jobs/1", name: "alice@example.test" }],
    notObserved: [{ id: "2", url: "https://crowdworks.jp/public/jobs/2", reason: "TOKEN123" }] };
  fs.writeFileSync(first.paths.diff, JSON.stringify(contaminated), "utf8");
  const reread = saveSnapshot(dir, first.snapshot);
  assert.equal(reread.idempotent, true);
  assert.equal(JSON.stringify(reread.diff).includes("TOKEN123"), false);
  assert.equal(JSON.stringify(reread.diff).includes("alice@example.test"), false);
  assert.equal(reread.diff.baselineStatus, "invalid");
  assert.equal(fs.readFileSync(first.paths.diff, "utf8").includes("TOKEN123"), false);
});
