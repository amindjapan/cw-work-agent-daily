"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildSnapshot } = require("../src/collector");
const { createPrivateCandidateStore } = require("../src/private-candidates");

const FIRST = "2026-10-13T01:23:03.412Z";
const ID = "11111111-1111-4111-8111-111111111111";
const NEXT_ID = "22222222-2222-4222-8222-222222222222";
const POLICY = { maxCandidates: 20, maxRuns: 10, maxTotalBytes: 1000000, retentionDays: 30 };
const SENTINEL = "synthetic-private-contact@example.invalid synthetic-secret-token";
// Each test runs in an isolated test-runner process. Exercise local-only storage using
// synthetic data even in CI, then explicitly test the CI refusal branch below.
const originalCi = { CI: process.env.CI, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS };
delete process.env.CI;
delete process.env.GITHUB_ACTIONS;
test.after(() => {
  for (const [key, value] of Object.entries(originalCi)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function job(id, extra = {}) {
  return { id: String(id), url: `https://crowdworks.jp/public/jobs/${id}`, title: "Python CSV JSON API",
    description: "Python CSV processing with Excel output", category: "system", importedAt: FIRST, ...extra };
}

function observedSnapshot(jobs = [job(1), job(2)], extra = {}) {
  return buildSnapshot({ jobs, candidateIds: jobs.map((item) => item.id), now: FIRST,
    attempts: [{ keyword: "CSV", page: 1, ok: true, status: 200, outcome: "success",
      imported: jobs.length, observedIds: jobs.map((item) => item.id) }], ...extra });
}

function summaryFor(snapshot) {
  return { generatedAt: snapshot.generatedAt, totalJobs: snapshot.coverage.retrievedJobCount,
    safeCandidates: snapshot.coverage.candidateCount };
}

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cw-private-candidates-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "private");
  const publicOutputDir = path.join(root, "public");
  const options = { enabled: true, outputDir, policy: { ...POLICY }, executionId: ID, extractedAt: FIRST, ...overrides };
  return { root, outputDir, publicOutputDir, options,
    store: () => createPrivateCandidateStore(options, { publicOutputDir }) };
}

function recordPath(f, id = ID) { return path.join(f.outputDir, `${id}.json`); }
function readRecord(f, id = ID) { return JSON.parse(fs.readFileSync(recordPath(f, id), "utf8")); }
function records(f) { return fs.existsSync(f.outputDir) ? fs.readdirSync(f.outputDir).filter((file) => file.endsWith(".json")) : []; }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function resealSnapshot(snapshot) {
  const { runId, ...source } = snapshot;
  snapshot.runId = `${snapshot.generatedAt.replace(/[-:.]/g, "")}-${sha256(stableJson(source)).slice(0, 16)}`;
  return snapshot;
}

async function fails(code, action) {
  await assert.rejects(async () => action(), (error) => {
    assert.equal(error.code, `private_candidates_${code}`);
    assert.equal(error.message, error.code);
    assert.equal(error.message.includes(SENTINEL), false);
    return true;
  });
}

test("disabled storage does not read options, validate input, or touch the filesystem", async () => {
  const poisonous = { enabled: false };
  for (const key of ["outputDir", "policy", "executionId", "extractedAt"]) {
    Object.defineProperty(poisonous, key, { get() { throw new Error("disabled option read"); } });
  }
  const forbiddenFs = ["mkdirSync", "readFileSync", "writeFileSync", "lstatSync", "realpathSync", "readdirSync"];
  const original = Object.fromEntries(forbiddenFs.map((name) => [name, fs[name]]));
  try {
    for (const name of forbiddenFs) fs[name] = () => { throw new Error("disabled filesystem access"); };
    for (const options of [undefined, {}, poisonous]) {
      const store = createPrivateCandidateStore(options, { get publicOutputDir() { throw new Error("disabled public path read"); } });
      assert.deepEqual(await store.save({ snapshot: null, summary: null }), { status: "disabled" });
    }
  } finally {
    for (const name of forbiddenFs) fs[name] = original[name];
  }
});

test("all machine candidates are saved with only the minimum allowlisted fields", async (t) => {
  const f = fixture(t);
  const snapshot = observedSnapshot([job(1, { title: `Python CSV JSON API ${SENTINEL}` }), job(2)]);
  snapshot.jobs[0].title = SENTINEL;
  snapshot.jobs[0].contact = SENTINEL;
  snapshot.jobs[0].token = SENTINEL;
  snapshot.jobs[0].assessment = { approved: true, notes: SENTINEL };
  snapshot.privateMessage = SENTINEL;
  resealSnapshot(snapshot);
  const summary = { ...summaryFor(snapshot), title: SENTINEL, contact: SENTINEL, token: SENTINEL };
  const result = await f.store().save({ snapshot, summary });
  assert.equal(result.status, "saved");
  assert.equal(result.count, 2);
  assert.deepEqual(Object.keys(result).sort(), ["count", "status"]);
  const saved = readRecord(f);
  assert.deepEqual(Object.keys(saved).sort(), ["assessment", "candidates", "collector", "counts", "executionId", "extractedAt",
    "generatedAt", "kind", "recordSha256", "runId", "schemaVersion", "snapshotSha256", "summarySha256"]);
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.kind, "private_machine_candidates");
  assert.equal(saved.executionId, ID);
  assert.equal(saved.runId, snapshot.runId);
  assert.equal(saved.generatedAt, FIRST);
  assert.equal(saved.extractedAt, FIRST);
  assert.equal(saved.assessment, "machine_extraction_only");
  assert.deepEqual(saved.counts, { summaryCandidateCount: 2, listCount: 2, retrievedJobCount: 2, reconciliation: "matched" });
  assert.deepEqual(saved.candidates.map((item) => item.id), ["1", "2"]);
  for (const item of saved.candidates) {
    assert.deepEqual(Object.keys(item).sort(), ["fetchedAt", "id", "reasonCodes", "url"]);
    assert.equal(item.url, `https://crowdworks.jp/public/jobs/${item.id}`);
    assert.equal(item.fetchedAt, FIRST);
    assert.ok(item.reasonCodes.includes("machine_candidate"));
  }
  assert.equal(fs.readFileSync(recordPath(f), "utf8").includes(SENTINEL), false);
  assert.match(saved.collector.version, /\S+/);
  for (const digest of [saved.collector.sourceSha256, saved.snapshotSha256, saved.summarySha256, saved.recordSha256]) {
    assert.match(digest, /^[a-f0-9]{64}$/);
  }
  const { runId, ...source } = snapshot;
  const { recordSha256, ...content } = saved;
  assert.equal(saved.snapshotSha256, sha256(stableJson(source)));
  assert.equal(saved.summarySha256, sha256(JSON.stringify(summary, null, 2)));
  assert.equal(recordSha256, sha256(stableJson(content)));
  assert.equal(runId.endsWith(saved.snapshotSha256.slice(0, 16)), true);
  assert.deepEqual(fs.readdirSync(f.outputDir), [`${ID}.json`]);
});

test("candidate reasons are extraction evidence and do not copy independent safety or fit reviews", async (t) => {
  const f = fixture(t);
  const snapshot = observedSnapshot();
  snapshot.clientReview = { verdict: "approved", privateNotes: SENTINEL };
  snapshot.jobs[0].safetyReview = { approved: true, notes: SENTINEL };
  resealSnapshot(snapshot);
  await f.store().save({ snapshot, summary: summaryFor(snapshot) });
  const saved = readRecord(f);
  assert.equal(saved.assessment, "machine_extraction_only");
  assert.equal("clientReview" in saved, false);
  assert.equal("safetyReview" in saved.candidates[0], false);
  assert.equal("canExecute" in saved.candidates[0], false);
});

test("noncandidate jobs count toward retrieval but are absent from the private candidate list", async (t) => {
  const f = fixture(t);
  const snapshot = observedSnapshot([job(1), job(2, { title: "General manual task", description: "General manual task", category: "other" })]);
  assert.deepEqual(snapshot.candidateIds, ["1"]);
  await f.store().save({ snapshot, summary: summaryFor(snapshot) });
  const saved = readRecord(f);
  assert.equal(saved.counts.listCount, 1);
  assert.equal(saved.counts.retrievedJobCount, 2);
  assert.deepEqual(saved.candidates.map((item) => item.id), ["1"]);
});

test("verified zero candidates remains distinguishable from unknown retrieval", async (t) => {
  const empty = fixture(t);
  const snapshot = observedSnapshot([]);
  await empty.store().save({ snapshot, summary: summaryFor(snapshot) });
  const emptyRecord = readRecord(empty);
  assert.deepEqual(emptyRecord.counts, { summaryCandidateCount: 0, listCount: 0, retrievedJobCount: 0, reconciliation: "matched" });
  assert.deepEqual(emptyRecord.candidates, []);
  const unknown = fixture(t);
  const failed = buildSnapshot({ now: FIRST, attempts: [{ keyword: "CSV", page: 1, ok: false,
    status: 200, outcome: "extraction_failed", imported: null, observedIds: [] }] });
  await unknown.store().save({ snapshot: failed, summary: summaryFor(failed) });
  const unknownRecord = readRecord(unknown);
  assert.deepEqual(unknownRecord.counts, { summaryCandidateCount: null, listCount: 0, retrievedJobCount: null, reconciliation: "unknown" });
  assert.deepEqual(unknownRecord.candidates, []);
});

test("unknown retrieval cannot be relabeled as a verified zero in the public summary", async (t) => {
  const f = fixture(t);
  const snapshot = buildSnapshot({ now: FIRST });
  await fails("candidate_count_mismatch", () => f.store().save({ snapshot, summary: { ...summaryFor(snapshot), safeCandidates: 0 } }));
  assert.deepEqual(records(f), []);
});

test("all candidate count contracts must agree before a record is written", async (t) => {
  for (const mutate of [
    (snapshot, summary) => { summary.safeCandidates = 1; },
    (snapshot) => { snapshot.coverage.candidateCount = 1; },
    (snapshot) => { snapshot.candidateIds.pop(); },
    (snapshot, summary) => { summary.totalJobs = 1; }
  ]) {
    const f = fixture(t);
    const snapshot = observedSnapshot();
    const summary = summaryFor(snapshot);
    mutate(snapshot, summary);
    resealSnapshot(snapshot);
    await fails("candidate_count_mismatch", () => f.store().save({ snapshot, summary }));
    assert.deepEqual(records(f), []);
  }
});

test("same-length replacement cannot evade candidate identity reconciliation", async (t) => {
  const f = fixture(t);
  const snapshot = observedSnapshot();
  snapshot.candidateIds = ["1", "999"];
  resealSnapshot(snapshot);
  await fails("invalid_record", () => f.store().save({ snapshot, summary: summaryFor(snapshot) }));
  assert.deepEqual(records(f), []);
});

test("all job candidate flags must match the saved candidate ID list", async (t) => {
  const f = fixture(t);
  const snapshot = observedSnapshot([job(1), job(2, { title: "Manual task", description: "Manual task", category: "other" })]);
  snapshot.jobs[1].candidate = true;
  resealSnapshot(snapshot);
  await fails("candidate_count_mismatch", () => f.store().save({ snapshot, summary: summaryFor(snapshot) }));
  assert.deepEqual(records(f), []);
});

test("snapshot run identity must authenticate the exact supplied evidence", async (t) => {
  const f = fixture(t);
  const snapshot = observedSnapshot();
  snapshot.jobs[0].fetchedAt = "2026-10-13T01:00:00.000Z";
  await fails("invalid_record", () => f.store().save({ snapshot, summary: summaryFor(snapshot) }));
  assert.deepEqual(records(f), []);
});

test("duplicate IDs, invalid references, timestamps and free-text reason codes fail closed", async (t) => {
  for (const mutate of [
    (snapshot) => { snapshot.jobs.push(copy(snapshot.jobs[0])); },
    (snapshot) => { snapshot.candidateIds = ["1", "1"]; },
    (snapshot) => { snapshot.jobs[0].url = "https://example.invalid/public/jobs/1"; },
    (snapshot) => { snapshot.jobs[0].url = "https://crowdworks.jp/public/jobs/99"; },
    (snapshot) => { snapshot.jobs[0].fetchedAt = "2026-02-30T01:00:00.000Z"; },
    (snapshot) => { snapshot.jobs[0].machineJudgment.reasonCodes.push(SENTINEL); },
    (snapshot) => { snapshot.jobs[0].machineJudgment.reasonCodes = ["matched_skill"]; },
    (snapshot) => { snapshot.jobs[0].machineJudgment.canExecute = false; },
    (snapshot) => { snapshot.jobs[0].candidate = false; },
    (snapshot) => { snapshot.generatedAt = SENTINEL; }
  ]) {
    const f = fixture(t);
    const snapshot = observedSnapshot();
    mutate(snapshot);
    resealSnapshot(snapshot);
    await fails("invalid_record", () => f.store().save({ snapshot, summary: summaryFor(snapshot) }));
    assert.deepEqual(records(f), []);
  }
});

test("missing explicit policy refuses storage without creating a directory", async (t) => {
  for (const [policy, code] of [[undefined, "policy_required"], [{}, "invalid_policy"], [{ ...POLICY, retentionDays: undefined }, "invalid_policy"]]) {
    const f = fixture(t, { policy });
    await fails(code, () => f.store().save({ snapshot: observedSnapshot(), summary: summaryFor(observedSnapshot()) }));
    assert.equal(fs.existsSync(f.outputDir), false);
  }
});

test("nonpositive, fractional and unsafe limits are rejected", async (t) => {
  for (const policy of [
    { ...POLICY, maxCandidates: 0 }, { ...POLICY, maxRuns: -1 }, { ...POLICY, maxTotalBytes: 1.5 },
    { ...POLICY, retentionDays: 0 }, { ...POLICY, maxRuns: Infinity }, { ...POLICY, maxTotalBytes: Number.MAX_SAFE_INTEGER + 1 }
  ]) {
    const f = fixture(t, { policy });
    await fails("invalid_policy", () => f.store().save({ snapshot: observedSnapshot(), summary: summaryFor(observedSnapshot()) }));
    assert.equal(fs.existsSync(f.outputDir), false);
  }
});

test("candidate limit is inclusive and excess fails explicitly without truncation", async (t) => {
  const f = fixture(t, { policy: { ...POLICY, maxCandidates: 2 } });
  const snapshot = observedSnapshot();
  await f.store().save({ snapshot, summary: summaryFor(snapshot) });
  const original = fs.readFileSync(recordPath(f));
  const excess = observedSnapshot([job(1), job(2), job(3)]);
  const store = createPrivateCandidateStore({ ...f.options, executionId: NEXT_ID }, { publicOutputDir: f.publicOutputDir });
  await fails("candidate_limit", () => store.save({ snapshot: excess, summary: summaryFor(excess) }));
  assert.deepEqual(records(f), [`${ID}.json`]);
  assert.deepEqual(fs.readFileSync(recordPath(f)), original);
});

test("run quota blocks a new record and preserves the existing immutable record", async (t) => {
  const f = fixture(t, { policy: { ...POLICY, maxRuns: 1 } });
  const snapshot = observedSnapshot();
  await f.store().save({ snapshot, summary: summaryFor(snapshot) });
  const original = fs.readFileSync(recordPath(f));
  const nextStore = createPrivateCandidateStore({ ...f.options, executionId: NEXT_ID }, { publicOutputDir: f.publicOutputDir });
  await fails("run_limit", () => nextStore.save({ snapshot, summary: summaryFor(snapshot) }));
  assert.deepEqual(records(f), [`${ID}.json`]);
  assert.deepEqual(fs.readFileSync(recordPath(f)), original);
});

test("byte quota is checked against actual serialized size and existing records", async (t) => {
  const probe = fixture(t);
  const snapshot = observedSnapshot();
  await probe.store().save({ snapshot, summary: summaryFor(snapshot) });
  const bytes = fs.statSync(recordPath(probe)).size;
  const f = fixture(t, { policy: { ...POLICY, maxTotalBytes: bytes } });
  await f.store().save({ snapshot, summary: summaryFor(snapshot) });
  assert.equal(fs.statSync(recordPath(f)).size, bytes);
  const next = createPrivateCandidateStore({ ...f.options, executionId: NEXT_ID }, { publicOutputDir: f.publicOutputDir });
  await fails("byte_limit", () => next.save({ snapshot, summary: summaryFor(snapshot) }));
  const tooSmall = fixture(t, { policy: { ...POLICY, maxTotalBytes: bytes - 1 } });
  await fails("byte_limit", () => tooSmall.store().save({ snapshot, summary: summaryFor(snapshot) }));
  assert.deepEqual(records(tooSmall), []);
});

test("identical execution retry is idempotent even when the run quota is full", async (t) => {
  const f = fixture(t, { policy: { ...POLICY, maxRuns: 1 } });
  const snapshot = observedSnapshot();
  const store = f.store();
  await store.save({ snapshot, summary: summaryFor(snapshot) });
  const original = fs.readFileSync(recordPath(f));
  const before = fs.statSync(recordPath(f)).mtimeMs;
  const result = await store.save({ snapshot, summary: summaryFor(snapshot) });
  assert.deepEqual(result, { status: "idempotent", count: 2 });
  assert.deepEqual(fs.readFileSync(recordPath(f)), original);
  assert.equal(fs.statSync(recordPath(f)).mtimeMs, before);
  assert.deepEqual(records(f), [`${ID}.json`]);
});

test("different content under the same execution ID is rejected without overwrite", async (t) => {
  const f = fixture(t);
  const snapshot = observedSnapshot();
  await f.store().save({ snapshot, summary: summaryFor(snapshot) });
  const original = fs.readFileSync(recordPath(f));
  const changed = observedSnapshot([job(1), job(3)]);
  await fails("identity_collision", () => f.store().save({ snapshot: changed, summary: summaryFor(changed) }));
  assert.deepEqual(fs.readFileSync(recordPath(f)), original);
});

test("source and payload identities change when evidence changes despite equal counts", async (t) => {
  const f = fixture(t);
  const one = observedSnapshot();
  await f.store().save({ snapshot: one, summary: summaryFor(one) });
  const two = observedSnapshot([job(1), job(3)]);
  const next = createPrivateCandidateStore({ ...f.options, executionId: NEXT_ID }, { publicOutputDir: f.publicOutputDir });
  await next.save({ snapshot: two, summary: summaryFor(two) });
  const firstRecord = readRecord(f);
  const secondRecord = readRecord(f, NEXT_ID);
  assert.notEqual(firstRecord.snapshotSha256, secondRecord.snapshotSha256);
  assert.notEqual(firstRecord.recordSha256, secondRecord.recordSha256);
  assert.equal(firstRecord.summarySha256, secondRecord.summarySha256);
  assert.equal(firstRecord.collector.sourceSha256, secondRecord.collector.sourceSha256);
  assert.notEqual(sha256(fs.readFileSync(recordPath(f))), sha256(fs.readFileSync(recordPath(f, NEXT_ID))));
});

test("retention expiry requires review and never deletes or replaces old records", async (t) => {
  const f = fixture(t, { policy: { ...POLICY, retentionDays: 1 } });
  const snapshot = observedSnapshot();
  await f.store().save({ snapshot, summary: summaryFor(snapshot) });
  const original = fs.readFileSync(recordPath(f));
  const later = createPrivateCandidateStore({ ...f.options, executionId: NEXT_ID,
    extractedAt: "2026-10-15T01:23:03.412Z" }, { publicOutputDir: f.publicOutputDir });
  await fails("retention_review_required", () => later.save({ snapshot, summary: summaryFor(snapshot) }));
  assert.deepEqual(records(f), [`${ID}.json`]);
  assert.deepEqual(fs.readFileSync(recordPath(f)), original);
});

test("preexisting lock refuses another writer without removing its lock", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.outputDir, ".write-lock"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(f.outputDir, ".write-lock", "owner"), "synthetic lock owner", { encoding: "utf8", mode: 0o600 });
  const snapshot = observedSnapshot();
  await fails("store_locked", () => f.store().save({ snapshot, summary: summaryFor(snapshot) }));
  assert.deepEqual(records(f), []);
  assert.equal(fs.readFileSync(path.join(f.outputDir, ".write-lock", "owner"), "utf8"), "synthetic lock owner");
});

test("atomic publish failure leaves no candidate record and removes only its own temporary lock", async (t) => {
  const f = fixture(t);
  const snapshot = observedSnapshot();
  const originalLink = fs.linkSync;
  try {
    fs.linkSync = () => { throw Object.assign(new Error(SENTINEL), { code: "EIO" }); };
    await fails("storage_failed", () => f.store().save({ snapshot, summary: summaryFor(snapshot) }));
  } finally {
    fs.linkSync = originalLink;
  }
  assert.deepEqual(records(f), []);
  assert.equal(fs.existsSync(path.join(f.outputDir, ".write-lock")), false);
  assert.equal(fs.existsSync(f.outputDir) ? fs.readdirSync(f.outputDir).length : 0, 0);
  assert.equal((await f.store().save({ snapshot, summary: summaryFor(snapshot) })).status, "saved");
});

test("storage failure exposes a fixed code and preserves existing data", async (t) => {
  const f = fixture(t);
  const snapshot = observedSnapshot();
  await f.store().save({ snapshot, summary: summaryFor(snapshot) });
  const originalBytes = fs.readFileSync(recordPath(f));
  const originalWrite = fs.writeFileSync;
  const next = createPrivateCandidateStore({ ...f.options, executionId: NEXT_ID }, { publicOutputDir: f.publicOutputDir });
  try {
    fs.writeFileSync = () => { throw Object.assign(new Error(SENTINEL), { code: "EIO" }); };
    await fails("storage_failed", () => next.save({ snapshot, summary: summaryFor(snapshot) }));
  } finally {
    fs.writeFileSync = originalWrite;
  }
  assert.deepEqual(fs.readFileSync(recordPath(f)), originalBytes);
  assert.deepEqual(records(f), [`${ID}.json`]);
  assert.equal(fs.existsSync(path.join(f.outputDir, ".write-lock")), false);
});

test("cleanup failure is explicit and leaves the published record intact with a blocking lock", async (t) => {
  const f = fixture(t);
  const snapshot = observedSnapshot();
  const originalUnlink = fs.unlinkSync;
  try {
    fs.unlinkSync = () => { throw Object.assign(new Error(SENTINEL), { code: "EIO" }); };
    await fails("cleanup_failed", () => f.store().save({ snapshot, summary: summaryFor(snapshot) }));
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.deepEqual(readRecord(f).candidates.map((item) => item.id), ["1", "2"]);
  assert.equal(fs.existsSync(path.join(f.outputDir, ".write-lock", "record.tmp")), true);
  await fails("store_locked", () => f.store().save({ snapshot, summary: summaryFor(snapshot) }));
});

test("tampering with an existing execution record prevents idempotent acceptance", async (t) => {
  const f = fixture(t);
  const snapshot = observedSnapshot();
  await f.store().save({ snapshot, summary: summaryFor(snapshot) });
  const tampered = readRecord(f);
  tampered.candidates[0].id = "99";
  const bytes = JSON.stringify(tampered);
  fs.writeFileSync(recordPath(f), bytes);
  await fails("invalid_store", () => f.store().save({ snapshot, summary: summaryFor(snapshot) }));
  assert.equal(fs.readFileSync(recordPath(f), "utf8"), bytes);
});

test("unexpected files and malformed stored records require explicit repair without deletion", async (t) => {
  for (const file of ["unexpected.txt", `${NEXT_ID}.json`]) {
    const f = fixture(t);
    fs.mkdirSync(f.outputDir, { mode: 0o700 });
    fs.writeFileSync(path.join(f.outputDir, file), SENTINEL, { encoding: "utf8", mode: 0o600 });
    const snapshot = observedSnapshot();
    await fails("invalid_store", () => f.store().save({ snapshot, summary: summaryFor(snapshot) }));
    assert.equal(fs.readFileSync(path.join(f.outputDir, file), "utf8"), SENTINEL);
    assert.equal(fs.existsSync(recordPath(f)), false);
    assert.equal(fs.existsSync(path.join(f.outputDir, ".write-lock")), false);
  }
});

test("a target that appears during atomic publication is never overwritten", async (t) => {
  const f = fixture(t);
  const snapshot = observedSnapshot();
  const originalLink = fs.linkSync;
  try {
    fs.linkSync = (source, target) => {
      fs.writeFileSync(target, "synthetic concurrent writer", { flag: "wx" });
      return originalLink(source, target);
    };
    await fails("storage_failed", () => f.store().save({ snapshot, summary: summaryFor(snapshot) }));
  } finally {
    fs.linkSync = originalLink;
  }
  assert.equal(fs.readFileSync(recordPath(f), "utf8"), "synthetic concurrent writer");
  assert.equal(fs.existsSync(path.join(f.outputDir, ".write-lock")), false);
});

test("saving a supplied snapshot performs no collector fetch or external request", async (t) => {
  const f = fixture(t);
  const snapshot = observedSnapshot();
  const originalFetch = global.fetch;
  let calls = 0;
  try {
    global.fetch = () => { calls++; throw new Error("unexpected external request"); };
    assert.equal((await f.store().save({ snapshot, summary: summaryFor(snapshot) })).status, "saved");
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});

test("public output paths and repository publishable paths are rejected", async (t) => {
  const f = fixture(t);
  const repository = path.resolve(__dirname, "..");
  for (const outputDir of [f.publicOutputDir, path.join(f.publicOutputDir, "nested"),
    path.join(repository, "collector-data", "private-candidates"), path.join(repository, "public", "private-candidates"),
    path.join(repository, "test", "private-candidates"), "relative-private-candidates"]) {
    await fails("unsafe_path", () => createPrivateCandidateStore({ ...f.options, outputDir }, { publicOutputDir: f.publicOutputDir })
      .save({ snapshot: observedSnapshot(), summary: summaryFor(observedSnapshot()) }));
  }
  assert.equal(fs.existsSync(f.publicOutputDir), false);
});

test("storage beneath an output directory symlink is rejected", async (t) => {
  const f = fixture(t);
  const real = path.join(f.root, "real");
  fs.mkdirSync(real);
  try { fs.symlinkSync(real, f.outputDir, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("directory links unavailable without additional permissions"); return; }
    throw error;
  }
  await fails("unsafe_path", () => f.store().save({ snapshot: observedSnapshot(), summary: summaryFor(observedSnapshot()) }));
  assert.deepEqual(fs.readdirSync(real), []);
});

test("storage beneath a symlinked ancestor is rejected", async (t) => {
  const f = fixture(t);
  const real = path.join(f.root, "real");
  const alias = path.join(f.root, "alias");
  fs.mkdirSync(real);
  try { fs.symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("directory links unavailable without additional permissions"); return; }
    throw error;
  }
  await fails("unsafe_path", () => createPrivateCandidateStore({ ...f.options, outputDir: path.join(alias, "nested") },
    { publicOutputDir: f.publicOutputDir }).save({ snapshot: observedSnapshot(), summary: summaryFor(observedSnapshot()) }));
  assert.deepEqual(fs.readdirSync(real), []);
});

test("enabled storage is forbidden in public CI and GitHub Actions", async (t) => {
  for (const key of ["CI", "GITHUB_ACTIONS"]) {
    const old = process.env[key];
    try {
      process.env[key] = "true";
      const f = fixture(t);
      await fails("ci_forbidden", () => f.store().save({ snapshot: observedSnapshot(), summary: summaryFor(observedSnapshot()) }));
      assert.equal(fs.existsSync(f.outputDir), false);
      assert.deepEqual(await createPrivateCandidateStore({ enabled: false }).save({ snapshot: null, summary: null }), { status: "disabled" });
    } finally {
      if (old === undefined) delete process.env[key]; else process.env[key] = old;
    }
  }
});

test("CI refusal is rechecked when saving rather than only at construction", async (t) => {
  const f = fixture(t);
  const store = f.store();
  const old = process.env.GITHUB_ACTIONS;
  try {
    process.env.GITHUB_ACTIONS = "true";
    await fails("ci_forbidden", () => store.save({ snapshot: observedSnapshot(), summary: summaryFor(observedSnapshot()) }));
    assert.equal(fs.existsSync(f.outputDir), false);
  } finally {
    if (old === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = old;
  }
});

test("invalid execution identity and extraction time are rejected without filenames from input", async (t) => {
  for (const overrides of [{ executionId: "../outside" }, { executionId: SENTINEL }, { extractedAt: SENTINEL },
    { extractedAt: "2026-02-30T01:00:00.000Z" }]) {
    const f = fixture(t, overrides);
    await fails("invalid_record", () => f.store().save({ snapshot: observedSnapshot(), summary: summaryFor(observedSnapshot()) }));
    assert.deepEqual(records(f), []);
  }
});

test("approved upper bounds cannot be increased by a caller", async (t) => {
  const { APPROVED_POLICY } = require("../src/private-candidate-policy");
  assert.deepEqual(APPROVED_POLICY, { maxCandidates: 100, maxRuns: 60,
    maxTotalBytes: 5 * 1024 * 1024, retentionDays: 30 });
  assert.equal(Object.isFrozen(APPROVED_POLICY), true);
  for (const key of Object.keys(APPROVED_POLICY)) {
    const f = fixture(t, { policy: { ...APPROVED_POLICY, [key]: APPROVED_POLICY[key] + 1 } });
    await fails("invalid_policy", () => f.store());
    assert.equal(fs.existsSync(f.outputDir), false);
  }
});

test("expiry stops candidate references at the exact boundary without deleting the record", async (t) => {
  const f = fixture(t);
  const store = f.store();
  const snapshot = observedSnapshot();
  store.save({ snapshot, summary: summaryFor(snapshot) });
  const bytes = fs.readFileSync(recordPath(f));
  assert.equal(store.read({ now: "2026-11-12T01:23:03.411Z" }).status, "available");
  assert.deepEqual(store.read({ now: "2026-11-12T01:23:03.412Z" }), { status: "expired", requiresReview: true });
  assert.deepEqual(fs.readFileSync(recordPath(f)), bytes);
  assert.deepEqual(store.read({ executionId: NEXT_ID }), { status: "not_found" });
  assert.deepEqual(createPrivateCandidateStore({ enabled: false }).read({ executionId: SENTINEL }), { status: "disabled" });
});

test("private read rejects re-sealed unknown fields and never returns them", async (t) => {
  const f = fixture(t);
  const store = f.store();
  const snapshot = observedSnapshot();
  store.save({ snapshot, summary: summaryFor(snapshot) });
  const value = readRecord(f);
  value.privateNotes = SENTINEL;
  const { recordSha256, ...content } = value;
  value.recordSha256 = sha256(stableJson(content));
  fs.writeFileSync(recordPath(f), JSON.stringify(value));
  await fails("invalid_store", () => store.read());
});
