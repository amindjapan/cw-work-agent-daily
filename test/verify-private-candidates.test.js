"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { buildSnapshot, searchScopeId } = require("../src/collector");
const { verifyPrivateCandidateHandoff } = require("../src/verify-private-candidates");

const FIRST = "2026-10-29T01:00:00.000Z";
const EXTRACTED = "2026-10-29T01:02:00.000Z";
const NOW = "2026-10-29T01:03:00.000Z";
const ID = "11111111-1111-4111-8111-111111111111";
const SENTINEL = "synthetic-private-value@example.invalid";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function snapshotHash(snapshot) {
  const { runId, ...content } = snapshot;
  return sha256(stableJson(content));
}
function resealSnapshot(snapshot) {
  snapshot.runId = `${snapshot.generatedAt.replace(/[-:.]/g, "")}-${snapshotHash(snapshot).slice(0, 16)}`;
}
function resealRecord(record) {
  const { recordSha256, ...content } = record;
  record.recordSha256 = sha256(stableJson(content));
}
function fixture({ empty = false, unknown = false, collection = false } = {}) {
  const jobs = empty || unknown ? [] : ["1", "2"].map((id) => ({ id, url: `https://crowdworks.jp/public/jobs/${id}`,
    title: "Python CSV JSON API", description: "Python CSV processing with Excel output", category: "system", importedAt: FIRST }));
  const snapshot = buildSnapshot({ jobs, candidateIds: jobs.map((job) => job.id), now: FIRST,
    attempts: [{ keyword: "CSV", page: 1, ok: !unknown, status: unknown ? 403 : 200,
      outcome: unknown ? "fetch_failed" : "success", imported: unknown ? null : jobs.length,
      observedIds: jobs.map((job) => job.id) }] });
  assert.equal(snapshot.candidateIds.length, jobs.length);
  const summary = { generatedAt: FIRST, generatedAtJst: "2026/10/29 10:00", keywords: ["CSV"],
    attempts: [{ keyword: "CSV", ok: !unknown, status: unknown ? 403 : 200,
      imported: unknown ? null : jobs.length, ...(unknown ? { error: "fetch_failed" } : {}) }],
    totalJobs: unknown ? null : jobs.length, safeCandidates: unknown ? null : jobs.length, recommendation: null };
  if (collection) summary.collection = { schemaVersion: 1, status: "attempts_completed", startedAt: FIRST,
    attemptsCompletedAt: "2026-10-29T01:01:00.000Z", decisionAsOf: FIRST,
    search: { planned: 1, attempted: 1, succeeded: unknown ? 0 : 1, failed: unknown ? 1 : 0, notAttempted: 0 },
    details: { observed: jobs.length, attempted: 0, succeeded: 0, failed: 0, notAttempted: jobs.length },
    candidates: { machine: summary.safeCandidates, detailConfirmed: unknown ? null : 0,
      detailUnconfirmed: summary.safeCandidates } };
  const record = { schemaVersion: 1, kind: "private_machine_candidates", executionId: ID,
    runId: snapshot.runId, generatedAt: FIRST, extractedAt: EXTRACTED,
    collector: { version: "private-candidates-v1", sourceSha256: "a".repeat(64) },
    snapshotSha256: snapshotHash(snapshot), summarySha256: sha256(JSON.stringify(summary, null, 2)),
    assessment: "machine_extraction_only", counts: { summaryCandidateCount: summary.safeCandidates,
      listCount: jobs.length, retrievedJobCount: summary.totalJobs, reconciliation: unknown ? "unknown" : "matched" },
    candidates: snapshot.jobs.map((job) => ({ id: job.id, url: job.url, fetchedAt: job.fetchedAt,
      reasonCodes: [...job.machineJudgment.reasonCodes].sort() })) };
  resealRecord(record);
  return { snapshot, summary, record };
}
function bytes(f, override = {}) {
  return { recordBytes: `${JSON.stringify(f.record, null, 2)}\n`, snapshotBytes: `${JSON.stringify(f.snapshot, null, 2)}\n`,
    summaryBytes: JSON.stringify(f.summary, null, 2), now: NOW, ...override };
}
function relink(f) {
  resealSnapshot(f.snapshot);
  f.record.runId = f.snapshot.runId;
  f.record.snapshotSha256 = snapshotHash(f.snapshot);
  f.record.summarySha256 = sha256(JSON.stringify(f.summary, null, 2));
  resealRecord(f.record);
}
function confirmedFixture() {
  const f = fixture({ collection: true });
  const fetchedAt = "2026-10-29T01:00:30.000Z";
  f.snapshot.jobs[0].detailStatus = "success";
  f.snapshot.jobs[0].fetchedAt = fetchedAt;
  f.snapshot.jobs[0].contentSources.description = "detail";
  f.record.candidates[0].fetchedAt = fetchedAt;
  f.snapshot.retrieval.details = [{ jobId: "1", ok: true, status: 200, outcome: "success" }];
  f.summary.collection.details = { observed: 2, attempted: 1, succeeded: 1, failed: 0, notAttempted: 1 };
  f.summary.collection.candidates = { machine: 2, detailConfirmed: 1, detailUnconfirmed: 1 };
  const { score, level, canExecute, matchedSkills, strongSignals, riskFlags, budgetYen } = f.snapshot.jobs[0].machineJudgment;
  f.summary.recommendation = { id: "1", url: "https://crowdworks.jp/public/jobs/1", detailCheckedAt: fetchedAt,
    description: "Python CSV processing with Excel output",
    analysis: { score, level, canExecute, matchedSkills, strongSignals, riskFlags, budgetYen } };
  relink(f);
  return f;
}
function partialSearchFixture() {
  const f = fixture();
  Object.assign(f.snapshot.retrieval.search[0], { ok: false, outcome: "extraction_failed", complete: false, imported: null });
  f.snapshot.coverage.status = "failed";
  Object.assign(f.summary.attempts[0], { ok: false, imported: 2, error: "extraction_failed" });
  relink(f);
  return f;
}
function nonCandidateDetailFixture() {
  const f = confirmedFixture();
  f.snapshot.jobs[0].candidate = false;
  f.snapshot.candidateIds = ["2"];
  f.snapshot.coverage.candidateCount = 1;
  f.summary.safeCandidates = 1;
  f.summary.recommendation = null;
  f.summary.collection.candidates = { machine: 1, detailConfirmed: 0, detailUnconfirmed: 1 };
  f.record.candidates = f.record.candidates.filter((item) => item.id === "2");
  Object.assign(f.record.counts, { summaryCandidateCount: 1, listCount: 1 });
  f.snapshot.jobs[0].contentSources.description = "detail";
  relink(f);
  return f;
}
function invalid(f, code, override) {
  const result = verifyPrivateCandidateHandoff(bytes(f, override));
  assert.equal(result.status, "invalid");
  assert.deepEqual(result.issues, [code]);
  assert.equal(result.collectionCompletion, "UNKNOWN");
  assert.equal(JSON.stringify(result).includes(SENTINEL), false);
  assert.equal(Object.hasOwn(result, "candidates"), false);
}

test("saved bytes reconcile IDs, counts and hashes without inventing legacy completion", () => {
  const f = fixture();
  const original = clone(f);
  const result = verifyPrivateCandidateHandoff(bytes(f, { expectedExecutionId: ID }));
  assert.deepEqual(result, { status: "verified", issues: [], reconciliation: "matched",
    collectionCompletion: "UNKNOWN", assessment: "machine_extraction_only" });
  assert.deepEqual(f, original);
});

test("known zero and failed collection remain different states", () => {
  assert.equal(verifyPrivateCandidateHandoff(bytes(fixture({ empty: true }))).status, "verified");
  assert.equal(verifyPrivateCandidateHandoff(bytes(fixture({ unknown: true }))).status, "unknown");
});

test("new completion reports only its supplied validated timestamp", () => {
  const result = verifyPrivateCandidateHandoff(bytes(fixture({ collection: true })));
  assert.equal(result.status, "verified");
  assert.equal(result.collectionCompletion, "2026-10-29T01:01:00.000Z");
});

test("new unknown collection does not become a verified zero", () => {
  const result = verifyPrivateCandidateHandoff(bytes(fixture({ collection: true, unknown: true })));
  assert.equal(result.status, "unknown");
  assert.equal(result.reconciliation, "unknown");
});

test("missing saved products are incomplete, including a record saved before summary", () => {
  const f = fixture();
  for (const [key, code] of [["recordBytes", "record_missing"], ["snapshotBytes", "snapshot_missing"], ["summaryBytes", "summary_missing"]]) {
    const result = verifyPrivateCandidateHandoff(bytes(f, { [key]: undefined }));
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.issues, [code]);
    assert.equal(result.collectionCompletion, "UNKNOWN");
  }
});

test("truncated record or snapshot or summary is invalid rather than successful", () => {
  const f = fixture();
  for (const [key, code] of [["recordBytes", "record_json_invalid"], ["snapshotBytes", "snapshot_json_invalid"], ["summaryBytes", "summary_json_invalid"]]) {
    invalid(f, code, { [key]: "{\"partial\":" });
  }
  invalid(f, "record_json_invalid", { recordBytes: Buffer.from([0xff, 0xfe]) });
});

test("expired records stop at exactly thirty days and reveal no candidate list", () => {
  const f = fixture();
  const boundary = new Date(new Date(EXTRACTED).getTime() + 30 * 86400000);
  assert.equal(verifyPrivateCandidateHandoff(bytes(f, { now: new Date(boundary - 1).toISOString() })).status, "verified");
  const result = verifyPrivateCandidateHandoff(bytes(f, { now: boundary.toISOString() }));
  assert.deepEqual(result, { status: "expired", requiresReview: true, issues: ["retention_review_required"],
    reconciliation: "unknown", collectionCompletion: "UNKNOWN", assessment: "machine_extraction_only" });
});

test("verification time is explicit and future extraction is rejected", () => {
  invalid(fixture(), "verification_time_invalid", { now: SENTINEL });
  invalid(fixture(), "verification_time_invalid", { now: undefined });
  invalid(fixture(), "record_time_in_future", { now: FIRST });
  const f = fixture();
  f.record.extractedAt = "2026-10-29T00:59:00.000Z";
  resealRecord(f.record);
  invalid(f, "record_schema_invalid");
});

test("wrong execution ID is not mistaken for the same observation", () => {
  invalid(fixture(), "execution_id_mismatch", { expectedExecutionId: "22222222-2222-4222-8222-222222222222" });
});

test("record hash mismatch is rejected before trusting record contents", () => {
  const f = fixture();
  f.record.counts.retrievedJobCount++;
  invalid(f, "record_hash_mismatch");
});

test("snapshot hash mismatch and summary exact-byte mismatch are distinguished", () => {
  const f = fixture();
  f.snapshot.jobs[0].contentHashes.title = "b".repeat(64);
  invalid(f, "snapshot_hash_mismatch");
  const next = fixture();
  invalid(next, "summary_hash_mismatch", { summaryBytes: JSON.stringify(next.summary, null, 2) + "\n" });
});

test("same number of candidates with different IDs fails identity comparison", () => {
  const f = fixture();
  f.record.candidates[0].id = "3";
  f.record.candidates[0].url = "https://crowdworks.jp/public/jobs/3";
  resealRecord(f.record);
  invalid(f, "candidate_ids_mismatch");
});

test("duplicate and missing candidate IDs fail even when input was resealed", () => {
  const f = fixture();
  f.record.candidates[1] = clone(f.record.candidates[0]);
  resealRecord(f.record);
  invalid(f, "candidate_ids_duplicate");
  const next = fixture();
  next.snapshot.candidateIds = ["1", "3"];
  relink(next);
  invalid(next, "candidate_ids_mismatch");
});

test("duplicate snapshot or retrieval IDs are rejected", () => {
  const f = fixture();
  f.snapshot.jobs[1] = clone(f.snapshot.jobs[0]);
  relink(f);
  invalid(f, "snapshot_ids_duplicate");
  const next = fixture();
  next.snapshot.retrieval.search.push(clone(next.snapshot.retrieval.search[0]));
  relink(next);
  invalid(next, "retrieval_ids_duplicate");
});

test("counts must agree with the complete candidate and observation lists", () => {
  const f = fixture();
  f.record.counts.listCount = 1;
  resealRecord(f.record);
  invalid(f, "record_count_mismatch");
  const next = fixture();
  next.snapshot.coverage.candidateCount = 1;
  relink(next);
  invalid(next, "snapshot_count_mismatch");
});

test("unknown fields are rejected from record, candidate, snapshot, and public summary", () => {
  const actions = [
    ["record_schema_invalid", (f) => { f.record.privateMessage = SENTINEL; resealRecord(f.record); }],
    ["candidate_schema_invalid", (f) => { f.record.candidates[0].secret = SENTINEL; resealRecord(f.record); }],
    ["snapshot_schema_invalid", (f) => { f.snapshot.secret = SENTINEL; relink(f); }],
    ["snapshot_schema_invalid", (f) => { f.snapshot.jobs[0].description = SENTINEL; relink(f); }],
    ["summary_schema_invalid", (f) => { f.summary.privateCandidates = [SENTINEL]; relink(f); }]
  ];
  for (const [code, action] of actions) { const f = fixture(); action(f); invalid(f, code); }
});

test("candidate evidence must match the same snapshot job", () => {
  const f = fixture();
  f.record.candidates[0].reasonCodes = ["machine_candidate"];
  resealRecord(f.record);
  invalid(f, "candidate_evidence_mismatch");
  const next = fixture();
  next.record.candidates[0].url = "https://crowdworks.jp/public/jobs/2";
  resealRecord(next.record);
  invalid(next, "candidate_schema_invalid");
});

test("completion cannot precede start or follow extraction or use arbitrary statuses", () => {
  for (const completed of ["2026-10-29T00:59:00.000Z", "2026-10-29T01:02:01.000Z"]) {
    const f = fixture({ collection: true });
    f.summary.collection.attemptsCompletedAt = completed;
    relink(f);
    const result = verifyPrivateCandidateHandoff(bytes(f));
    assert.equal(result.status, "invalid");
    assert.equal(result.collectionCompletion, "UNKNOWN");
    assert.ok(["summary_schema_invalid", "collection_time_invalid"].includes(result.issues[0]));
  }
  const f = fixture({ collection: true });
  f.summary.collection.status = SENTINEL;
  relink(f);
  const result = verifyPrivateCandidateHandoff(bytes(f));
  assert.equal(result.status, "invalid");
  assert.equal(result.collectionCompletion, "UNKNOWN");
  assert.equal(JSON.stringify(result).includes(SENTINEL), false);
});

test("completion counts are compared to snapshot attempt evidence", () => {
  const f = fixture({ collection: true });
  f.summary.collection.details.succeeded = 1;
  relink(f);
  const result = verifyPrivateCandidateHandoff(bytes(f));
  assert.equal(result.status, "invalid");
  assert.equal(result.collectionCompletion, "UNKNOWN");
});

test("new recommendation cannot rely on a candidate without current detail success", () => {
  const f = fixture({ collection: true });
  f.summary.recommendation = { id: "1", url: "https://crowdworks.jp/public/jobs/1" };
  relink(f);
  invalid(f, "summary_schema_invalid");
});

test("partial search can be integrity-verified without claiming complete search coverage", () => {
  const f = fixture();
  f.snapshot.retrieval.search[0].complete = false;
  f.snapshot.coverage.status = "partial";
  relink(f);
  const result = verifyPrivateCandidateHandoff(bytes(f));
  assert.equal(result.status, "verified");
  assert.equal(result.collectionCompletion, "UNKNOWN");
});

test("verifier never reads or writes files, calls transports, or reads an implicit clock", () => {
  const input = bytes(fixture());
  const functions = ["readFileSync", "writeFileSync", "readdirSync", "mkdirSync", "lstatSync", "realpathSync", "openSync", "linkSync", "unlinkSync"];
  const originals = Object.fromEntries(functions.map((name) => [name, fs[name]]));
  const originalFetch = global.fetch;
  const originalDateNow = Date.now;
  try {
    for (const name of functions) fs[name] = () => { throw new Error("unexpected filesystem access"); };
    global.fetch = () => { throw new Error("unexpected network access"); };
    Date.now = () => { throw new Error("unexpected clock access"); };
    assert.equal(verifyPrivateCandidateHandoff(input).status, "verified");
  } finally {
    for (const name of functions) fs[name] = originals[name];
    global.fetch = originalFetch;
    Date.now = originalDateNow;
  }
});

test("arbitrary thrown strings from caller-owned input do not escape as issue codes", () => {
  const input = { get now() { throw SENTINEL; } };
  const result = verifyPrivateCandidateHandoff(input);
  assert.equal(result.status, "invalid");
  assert.deepEqual(result.issues, ["verification_input_invalid"]);
  assert.equal(JSON.stringify(result).includes(SENTINEL), false);
});

test("current successful detail and matching recommendation reference are verified", () => {
  const result = verifyPrivateCandidateHandoff(bytes(confirmedFixture()));
  assert.equal(result.status, "verified");
  assert.equal(result.collectionCompletion, "2026-10-29T01:01:00.000Z");
});

test("resealed old detail success cannot prove a new collection", () => {
  const f = confirmedFixture();
  const stale = "2026-10-29T00:59:00.000Z";
  f.snapshot.jobs[0].fetchedAt = stale;
  f.record.candidates[0].fetchedAt = stale;
  relink(f);
  invalid(f, "current_detail_evidence_invalid");
  const next = confirmedFixture();
  const late = "2026-10-29T01:01:01.000Z";
  next.snapshot.jobs[0].fetchedAt = late;
  next.record.candidates[0].fetchedAt = late;
  relink(next);
  invalid(next, "current_detail_evidence_invalid");
});

test("new confirmed detail needs an explicit successful HTTP status", () => {
  const f = confirmedFixture();
  f.snapshot.retrieval.details[0].status = null;
  relink(f);
  invalid(f, "current_detail_evidence_invalid");
});

test("a resealed recommendation ID with another job URL is rejected", () => {
  const f = confirmedFixture();
  f.summary.recommendation.url = "https://crowdworks.jp/public/jobs/2";
  relink(f);
  invalid(f, "summary_schema_invalid");
});

test("search imported counts cannot differ from the observed ID count", () => {
  const f = fixture();
  f.snapshot.retrieval.search[0].imported = 99;
  relink(f);
  invalid(f, "search_evidence_mismatch");
});

test("every job must have matching search IDs and observation scopes", () => {
  const f = fixture();
  f.snapshot.retrieval.search[0].observedIds = [];
  f.snapshot.retrieval.search[0].imported = 0;
  f.snapshot.jobs.forEach((job) => { job.observedIn = []; });
  relink(f);
  invalid(f, "observation_scope_mismatch");
  const next = fixture();
  next.snapshot.jobs[0].observedIn = [];
  relink(next);
  invalid(next, "observation_scope_mismatch");
});

test("coverage status is recomputed from actual attempt evidence", () => {
  const f = fixture();
  f.snapshot.coverage.status = "failed";
  relink(f);
  invalid(f, "coverage_evidence_mismatch");
});

test("failed or partially parsed saved searches require null imported and cannot be complete", () => {
  const f = partialSearchFixture();
  assert.equal(verifyPrivateCandidateHandoff(bytes(f)).status, "verified");
  f.snapshot.retrieval.search[0].imported = 99;
  relink(f);
  invalid(f, "search_evidence_mismatch");
  const next = partialSearchFixture();
  next.snapshot.retrieval.search[0].complete = true;
  relink(next);
  invalid(next, "search_evidence_mismatch");
});

test("public attempts must match saved search count, status, success and imported counts", () => {
  for (const mutate of [
    (f) => { f.summary.attempts = []; },
    (f) => { f.summary.attempts[0].ok = false; },
    (f) => { f.summary.attempts[0].status = 403; },
    (f) => { f.summary.attempts[0].imported = 99; }
  ]) {
    const f = fixture();
    mutate(f);
    relink(f);
    invalid(f, "summary_attempts_mismatch");
  }
  const partial = partialSearchFixture();
  partial.summary.attempts[0].imported = 99;
  relink(partial);
  invalid(partial, "summary_attempts_mismatch");
});

test("public attempt order may differ from scope order without changing evidence", () => {
  const f = fixture();
  f.snapshot.retrieval.search.push({ scopeId: searchScopeId({ keyword: "EMPTY", page: 1 }), page: 1,
    ok: true, status: 200, outcome: "success", complete: true, imported: 0, observedIds: [] });
  f.summary.keywords.push("EMPTY");
  f.summary.attempts.unshift({ keyword: "EMPTY", ok: true, status: 200, imported: 0 });
  relink(f);
  assert.equal(verifyPrivateCandidateHandoff(bytes(f)).status, "verified");
});

test("partial public import counts may be unknown or equal observed IDs across reordered scopes", () => {
  const f = partialSearchFixture();
  f.snapshot.retrieval.search.push({ scopeId: searchScopeId({ keyword: "EMPTY", page: 1 }), page: 1,
    ok: false, status: 200, outcome: "extraction_failed", complete: false, imported: null, observedIds: [] });
  f.summary.keywords.push("EMPTY");
  f.summary.attempts.unshift({ keyword: "EMPTY", ok: false, status: 200, imported: null, error: "extraction_failed" });
  relink(f);
  assert.equal(verifyPrivateCandidateHandoff(bytes(f)).status, "verified");
  f.summary.attempts[1].imported = null;
  relink(f);
  assert.equal(verifyPrivateCandidateHandoff(bytes(f)).status, "verified");
});

test("v2 regex-shaped identifiers and hashes require strings without coercion", () => {
  for (const [mutate, code] of [
    [(f) => { f.record.executionId = [ID]; }, "record_schema_invalid"],
    [(f) => { f.record.collector.sourceSha256 = ["a".repeat(64)]; }, "record_schema_invalid"],
    [(f) => { f.snapshot.jobs[0].contentHashes.title = [f.snapshot.jobs[0].contentHashes.title]; }, "snapshot_schema_invalid"]
  ]) {
    const f = fixture();
    mutate(f);
    relink(f);
    invalid(f, code);
  }
  invalid(fixture(), "execution_id_invalid", { expectedExecutionId: [ID] });
});

test("v2 null and other non-string timestamp values never become verified evidence", () => {
  for (const value of [null, false, 0, [], {}]) {
    for (const mutate of [
      (f) => { f.record.extractedAt = value; },
      (f) => { f.record.candidates[0].fetchedAt = value; },
      (f) => { f.snapshot.jobs[0].fetchedAt = value; }
    ]) {
      const f = fixture();
      mutate(f);
      relink(f);
      assert.equal(verifyPrivateCandidateHandoff(bytes(f)).status, "invalid");
    }
  }
});

test("v2 every successful detail belongs to this execution even when it is not a candidate", () => {
  const baseline = nonCandidateDetailFixture();
  assert.equal(verifyPrivateCandidateHandoff(bytes(baseline)).status, "verified");
  for (const mutate of [
    (f) => { f.snapshot.jobs[0].fetchedAt = "2026-10-29T00:59:00.000Z"; },
    (f) => { f.snapshot.retrieval.details[0].status = null; },
    (f) => { f.snapshot.jobs[0].contentSources.description = "search"; }
  ]) {
    const f = nonCandidateDetailFixture();
    mutate(f);
    relink(f);
    invalid(f, "current_detail_evidence_invalid");
  }
});

test("v2 job detail state cannot claim a missing retrieval attempt", () => {
  const f = nonCandidateDetailFixture();
  f.snapshot.retrieval.details = [];
  f.summary.collection.details = { observed: 2, attempted: 0, succeeded: 0, failed: 0, notAttempted: 2 };
  relink(f);
  invalid(f, "detail_evidence_mismatch");
});

test("v2 successful parsed description cannot be marked as search or unknown", () => {
  for (const source of ["search", "unknown"]) {
    const f = confirmedFixture();
    f.snapshot.jobs[0].contentSources.description = source;
    relink(f);
    invalid(f, "current_detail_evidence_invalid");
  }
});

test("v2 resealed machine judgment flags cannot contradict their reason codes or score level", () => {
  for (const mutate of [
    (f) => { f.snapshot.jobs[0].machineJudgment.reasonCodes.push("machine_not_candidate"); f.record.candidates[0].reasonCodes.push("machine_not_candidate"); },
    (f) => { f.snapshot.jobs[0].machineJudgment.level = "low"; },
    (f) => { f.snapshot.jobs[0].machineJudgment.score = 80.5; }
  ]) {
    const f = fixture();
    mutate(f);
    relink(f);
    invalid(f, "machine_judgment_mismatch");
  }
});

test("v2 duplicate JSON keys are rejected instead of silently discarding one byte sequence", () => {
  for (const [key, field, code] of [["recordBytes", "executionId", "record_json_invalid"],
    ["snapshotBytes", "platform", "snapshot_json_invalid"], ["summaryBytes", "generatedAtJst", "summary_json_invalid"]]) {
    const f = fixture();
    const input = bytes(f);
    input[key] = input[key].replace(`\"${field}\":`, `\"${field}\":\"${SENTINEL}\",\"${field}\":`);
    if (key === "summaryBytes") {
      f.record.summarySha256 = sha256(input[key]);
      resealRecord(f.record);
      input.recordBytes = JSON.stringify(f.record, null, 2);
    }
    const result = verifyPrivateCandidateHandoff(input);
    assert.equal(result.status, "invalid");
    assert.deepEqual(result.issues, [code]);
    assert.equal(JSON.stringify(result).includes(SENTINEL), false);
  }
});

test("v2 BOM and malformed UTF-8 inputs cannot acquire different parsing semantics", () => {
  for (const [key, code] of [["recordBytes", "record_json_invalid"], ["snapshotBytes", "snapshot_json_invalid"], ["summaryBytes", "summary_json_invalid"]]) {
    const f = fixture();
    const input = bytes(f);
    input[key] = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(input[key], "utf8")]);
    if (key === "summaryBytes") {
      f.record.summarySha256 = sha256(input[key]);
      resealRecord(f.record);
      input.recordBytes = JSON.stringify(f.record, null, 2);
    }
    const result = verifyPrivateCandidateHandoff(input);
    assert.equal(result.status, "invalid");
    assert.deepEqual(result.issues, [code]);
  }
});

test("v2 accessors cannot change expected execution identity between validations", () => {
  let reads = 0;
  const input = bytes(fixture());
  Object.defineProperty(input, "expectedExecutionId", { enumerable: true, get() { return reads++ === 0 ? ID : undefined; } });
  const result = verifyPrivateCandidateHandoff(input);
  assert.equal(result.status, "invalid");
  assert.deepEqual(result.issues, ["verification_input_invalid"]);
  assert.equal(reads, 0);
});

test("v2 successful detail hashes must represent nonempty parsed content", () => {
  const f = confirmedFixture();
  f.snapshot.jobs[0].contentHashes.description = sha256("");
  relink(f);
  invalid(f, "current_detail_evidence_invalid");
});

test("v2 recommendation time, expiry hash and shared analysis match the same snapshot job", () => {
  for (const mutate of [
    (f) => { f.summary.recommendation.detailCheckedAt = "2026-10-29T01:00:31.000Z"; },
    (f) => { f.summary.recommendation.expiresAt = "2099-12-31"; },
    (f) => { f.summary.recommendation.analysis.score = f.summary.recommendation.analysis.score === 100 ? 99 : 100; }
  ]) {
    const f = confirmedFixture();
    mutate(f);
    relink(f);
    invalid(f, "recommendation_evidence_mismatch");
  }
});

test("v2 escaped duplicate nested keys are also ambiguous byte input", () => {
  const f = fixture();
  const input = bytes(f);
  input.recordBytes = input.recordBytes.replace('"version":', '"\\u0076ersion":"ignored","version":');
  const result = verifyPrivateCandidateHandoff(input);
  assert.equal(result.status, "invalid");
  assert.deepEqual(result.issues, ["record_json_invalid"]);
});

test("v2 valid UTF-8 strings, escaped keys, whitespace and bytes retain their documented hash semantics", () => {
  const f = fixture();
  f.summary.generatedAtJst = "人工データ 🐙";
  relink(f);
  const input = bytes(f);
  input.recordBytes = Buffer.from(input.recordBytes.replace('"version":', '"\\u0076ersion":'), "utf8");
  input.snapshotBytes = JSON.stringify(f.snapshot);
  assert.equal(verifyPrivateCandidateHandoff(input).status, "verified");
  assert.equal(verifyPrivateCandidateHandoff({ ...input, summaryBytes: Buffer.from(input.summaryBytes, "utf8") }).status, "verified");
});

test("v2 JSON text with lossy UTF-8 encoding or shared mutable bytes is rejected", () => {
  const f = fixture();
  const input = bytes(f);
  input.summaryBytes = input.summaryBytes.replace("2026/10/29 10:00", "\ud800");
  f.record.summarySha256 = sha256(Buffer.from(input.summaryBytes, "utf8"));
  resealRecord(f.record);
  input.recordBytes = JSON.stringify(f.record);
  invalid(f, "summary_json_invalid", input);
  const shared = new SharedArrayBuffer(Buffer.byteLength(input.recordBytes));
  const recordBytes = Buffer.from(shared);
  recordBytes.write(input.recordBytes);
  invalid(f, "record_json_invalid", { recordBytes });
});

test("v2 blocking risk contradicts executable judgment while low-value flags can remain executable", () => {
  const f = confirmedFixture();
  f.snapshot.jobs[0].machineJudgment.riskFlags = ["AI使用禁止"];
  f.snapshot.jobs[0].machineJudgment.reasonCodes.push("risk_keyword");
  f.record.candidates[0].reasonCodes.push("risk_keyword");
  f.summary.recommendation.analysis.riskFlags = ["AI使用禁止"];
  relink(f);
  invalid(f, "machine_judgment_mismatch");
  const next = confirmedFixture();
  next.snapshot.jobs[0].machineJudgment.riskFlags = ["初心者歓迎のみ"];
  next.snapshot.jobs[0].machineJudgment.reasonCodes.push("risk_keyword");
  next.record.candidates[0].reasonCodes.push("risk_keyword");
  next.summary.recommendation.analysis.riskFlags = ["初心者歓迎のみ"];
  relink(next);
  assert.equal(verifyPrivateCandidateHandoff(bytes(next)).status, "verified");
});

test("v2 inherited verification options cannot be silently ignored", () => {
  const input = Object.assign(Object.create({ expectedExecutionId: "22222222-2222-4222-8222-222222222222" }), bytes(fixture()));
  const result = verifyPrivateCandidateHandoff(input);
  assert.equal(result.status, "invalid");
  assert.deepEqual(result.issues, ["verification_input_invalid"]);
  assert.equal(verifyPrivateCandidateHandoff(Object.assign(Object.create(null), bytes(fixture()))).status, "verified");
});
