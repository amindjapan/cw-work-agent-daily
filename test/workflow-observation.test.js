"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { importWorkflowObservation, projectWorkflowObservation, selectLatestWorkflowObservation } = require("../src/workflow-observation");

// All job IDs, commits and timestamps below are synthetic; no service is queried.
const FIRST = "40820005840", SECOND = "40989042359";
const SOURCE = "a".repeat(40);
const SECRET = "synthetic-private-contact@example.invalid token=synthetic-secret";
function diagnostics(reason = "access_denied", status = 403) {
  return { kind: "collector_diagnostics", schemaVersion: 1, aborted: true,
    search: { planned: 13, attempted: 1, succeeded: 0, failed: 1, notAttempted: 12 },
    details: { observed: 0, attempted: 0, succeeded: 0, failed: 0, notAttempted: 0 },
    events: [{ stage: "search", httpStatus: status, reason }] };
}
function metadata(extra = {}) {
  const runId = extra.runId ?? FIRST;
  const jobId = extra.jobId ?? (runId === FIRST ? "100001" : "100002");
  const runUrl = `https://github.com/amindjapan/cw-work-agent-daily/actions/runs/${runId}`;
  return { kind: "workflow_observation", schemaVersion: 1, repository: "amindjapan/cw-work-agent-daily",
    workflowPath: ".github/workflows/daily.yml", runId, runAttempt: 1, jobId, sourceCommit: SOURCE,
    runUrl, jobUrl: `${runUrl}/job/${jobId}`, workflowStartedAt: "2026-10-29T01:00:00.000Z",
    workflowUpdatedAt: "2026-10-29T01:01:00.000Z", observedAt: "2026-10-30T03:00:00.000Z",
    collectorStartedAt: null, collectorFinishedAt: null, diagnosticLoggedAt: "2026-10-29T01:00:30.000Z",
    diagnostics: diagnostics(), stepResults: { tests: "SUCCEEDED", collection: "FAILED", snapshot: "SKIPPED",
      repositoryPersistence: "SKIPPED", publication: "SKIPPED" }, ...extra };
}
function later(extra = {}) {
  return metadata({ runId: SECOND, sourceCommit: "b".repeat(40), workflowStartedAt: "2026-10-30T01:00:00.000Z",
    workflowUpdatedAt: "2026-10-30T01:01:00.000Z", diagnosticLoggedAt: "2026-10-30T01:00:30.000Z", ...extra });
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function reseal(record) {
  const { contentSha256, ...body } = record;
  return { ...body, contentSha256: crypto.createHash("sha256").update(stableJson(body)).digest("hex") };
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function fails(code, action) {
  assert.throws(action, (error) => {
    assert.equal(error.message, `workflow_observation_${code}`);
    assert.equal(error.code, error.message);
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
}

test("explicit metadata imports without manufacturing collector clocks or skipped downstream outcomes", () => {
  const input = metadata(), original = copy(input);
  const record = importWorkflowObservation(input);
  assert.deepEqual(input, original);
  assert.equal(record.collectorStartedAt, null);
  assert.equal(record.collectorFinishedAt, null);
  assert.equal(record.stepResults.snapshot, "SKIPPED");
  assert.equal(record.stepResults.repositoryPersistence, "SKIPPED");
  assert.equal(record.stepResults.publication, "SKIPPED");
  assert.match(record.contentSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(projectWorkflowObservation(record), record);
  record.diagnostics.events[0].reason = "captcha_required";
  assert.deepEqual(input, original);
});

test("self-consistency covers canonical metadata, and supplied hash is never silently replaced", () => {
  const record = importWorkflowObservation(metadata());
  assert.deepEqual(importWorkflowObservation(Buffer.from(JSON.stringify(record), "utf8")), record);
  assert.deepEqual(importWorkflowObservation(JSON.stringify(metadata())), record);
  const { contentSha256, ...body } = record;
  assert.equal(contentSha256, crypto.createHash("sha256").update(stableJson(body)).digest("hex"));
  fails("invalid_record", () => projectWorkflowObservation(body));
  fails("hash_mismatch", () => importWorkflowObservation({ ...record, observedAt: "2026-10-30T04:00:00.000Z" }));
  fails("hash_mismatch", () => projectWorkflowObservation({ ...record, contentSha256: "0".repeat(64) }));
  fails("hash_mismatch", () => importWorkflowObservation({ ...metadata(), contentSha256: null }));
});

test("fixed repository, workflow, URL host and embedded run/job identity must match", () => {
  for (const extra of [{ repository: "other/repository" }, { workflowPath: ".github/workflows/other.yml" }, { kind: "other" }]) {
    fails("invalid_scope", () => importWorkflowObservation(metadata(extra)));
  }
  for (const extra of [
    { runId: "0" }, { runId: "040820005840" }, { runId: [FIRST] }, { runAttempt: 0 }, { runAttempt: "1" },
    { jobId: ["100001"] }, { sourceCommit: [SOURCE] }, { sourceCommit: SOURCE.toUpperCase() },
    { runUrl: `https://github.com.evil.invalid/amindjapan/cw-work-agent-daily/actions/runs/${FIRST}` },
    { runUrl: `https://github.com/amindjapan/cw-work-agent-daily/actions/runs/${FIRST}?token=x` },
    { jobUrl: `https://github.com/amindjapan/cw-work-agent-daily/actions/runs/${SECOND}/job/100001` },
    { jobUrl: `https://github.com/amindjapan/cw-work-agent-daily/actions/runs/${FIRST}/job/100002` }
  ]) fails("invalid_identity", () => importWorkflowObservation(metadata(extra)));
});

test("workflow and diagnostic timestamps stay explicit canonical UTC instants in source order", () => {
  for (const value of [null, 0, "2026-02-30T01:00:00.000Z", "2026-10-29T01:00:00Z", "2026-10-29T10:00:00+09:00", "invalid"]) {
    fails("invalid_time", () => importWorkflowObservation(metadata({ workflowStartedAt: value })));
  }
  for (const extra of [{ workflowUpdatedAt: "2026-10-29T00:59:59.000Z" }, { observedAt: "2026-10-29T01:00:59.000Z" },
    { diagnosticLoggedAt: "2026-10-29T00:59:59.000Z" }, { diagnosticLoggedAt: "2026-10-29T01:01:01.000Z" }]) {
    fails("invalid_time", () => importWorkflowObservation(metadata(extra)));
  }
  assert.equal(importWorkflowObservation(metadata({ diagnosticLoggedAt: null })).diagnosticLoggedAt, null);
  for (const extra of [{ collectorStartedAt: "2026-10-29T01:00:00.000Z" }, { collectorFinishedAt: "2026-10-29T01:01:00.000Z" }]) {
    fails("unknown_collector_time_required", () => importWorkflowObservation(metadata(extra)));
  }
});

test("provided historical step states cannot claim that skipped snapshot, push or publication succeeded", () => {
  for (const [key, value] of [["tests", "FAILED"], ["collection", "SUCCEEDED"], ["snapshot", "SUCCEEDED"],
    ["repositoryPersistence", "FAILED"], ["publication", "SUCCEEDED"]]) {
    const input = metadata(); input.stepResults[key] = value;
    fails("invalid_steps", () => importWorkflowObservation(input));
  }
  const missing = metadata(); delete missing.stepResults.snapshot;
  fails("invalid_record", () => importWorkflowObservation(missing));
});

test("strict shared diagnostics preserve STOP, null contact status and event-order rules", () => {
  for (const extra of [{ diagnostics: null }, { diagnostics: { ...diagnostics(), aborted: false } },
    { diagnostics: diagnostics("captcha_required", 403) }]) {
    fails("invalid_diagnostics", () => importWorkflowObservation(metadata(extra)));
  }
  const afterStop = metadata();
  afterStop.diagnostics.details = { observed: 1, attempted: 1, succeeded: 1, failed: 0, notAttempted: 0 };
  afterStop.diagnostics.events.push({ stage: "detail", httpStatus: 200, reason: "success" });
  fails("invalid_diagnostics", () => importWorkflowObservation(afterStop));
  const captcha = importWorkflowObservation(metadata({ diagnostics: diagnostics("captcha_required", 200) }));
  assert.equal(captcha.diagnostics.events[0].reason, "captcha_required");
  const unknownStatus = importWorkflowObservation(metadata({ diagnostics: diagnostics("captcha_required", null), diagnosticLoggedAt: null }));
  assert.equal(unknownStatus.diagnostics.events[0].httpStatus, null);
});

test("unknown fields and private free text are rejected instead of projected into public records", () => {
  for (const key of ["rawLogs", "bodySha256", "description", "privatePath", "notes"]) {
    fails("invalid_record", () => importWorkflowObservation({ ...metadata(), [key]: SECRET }));
  }
  const nested = metadata(); nested.diagnostics.events[0].body = SECRET;
  fails("invalid_diagnostics", () => importWorkflowObservation(nested));
  const step = metadata(); step.stepResults.notes = SECRET;
  fails("invalid_record", () => importWorkflowObservation(step));
});

test("strict JSON bytes reject malformed UTF-8, BOM and duplicate decoded fields without I/O", () => {
  for (const input of [Buffer.from([0xff]), "\ufeff{}", "{", JSON.stringify(metadata()).replace('"sourceCommit":', `"sourceCommit":"${SECRET}","sourceCommit":`)]) {
    fails("invalid_json", () => importWorkflowObservation(input));
  }
  fails("invalid_json", () => importWorkflowObservation("C:\\synthetic\\private\\credentials"));
});

test("missing or malformed selection remains UNAVAILABLE without borrowing a previous success", () => {
  assert.deepEqual(selectLatestWorkflowObservation([]), { status: "UNAVAILABLE", observation: null, reasonCode: "observation_missing" });
  assert.deepEqual(selectLatestWorkflowObservation([null]), { status: "UNAVAILABLE", observation: null, reasonCode: "invalid_record" });
});

test("latest selection ignores arrival and observation time while deduplicating identical records", () => {
  const old = importWorkflowObservation(metadata({ observedAt: "2026-11-01T03:00:00.000Z" }));
  const newest = importWorkflowObservation(later());
  for (const records of [[old, newest, old], [newest, old], [newest, newest, old]]) {
    const result = selectLatestWorkflowObservation(records);
    assert.equal(result.status, "AVAILABLE");
    assert.equal(result.observation.runId, SECOND);
    assert.equal(result.observation.collectorFinishedAt, null);
  }
});

test("same run/attempt payload changes conflict even after a valid self-hash is recalculated", () => {
  const record = importWorkflowObservation(metadata());
  for (const changed of [importWorkflowObservation(metadata({ jobId: "100009" })),
    importWorkflowObservation(metadata({ observedAt: "2026-10-30T04:00:00.000Z" }))]) {
    assert.deepEqual(selectLatestWorkflowObservation([record, changed]), { status: "CONFLICT", observation: null, reasonCode: "identity_conflict" });
  }
  assert.equal(selectLatestWorkflowObservation([record, { ...record, contentSha256: "b".repeat(64) }]).status, "UNAVAILABLE");
});

test("clock ambiguity and same-run attempt chronology reversal are explicit conflicts", () => {
  const first = importWorkflowObservation(metadata());
  const sameTime = importWorkflowObservation(metadata({ runId: SECOND }));
  assert.equal(selectLatestWorkflowObservation([first, sameTime]).reasonCode, "time_ambiguity");
  const backwards = importWorkflowObservation(metadata({ runId: SECOND, workflowStartedAt: "2026-10-28T01:00:00.000Z",
    workflowUpdatedAt: "2026-10-28T01:01:00.000Z", diagnosticLoggedAt: "2026-10-28T01:00:30.000Z" }));
  assert.equal(selectLatestWorkflowObservation([first, backwards]).observation.runId, FIRST);
  const backwardsRetry = importWorkflowObservation(metadata({ runAttempt: 2, workflowStartedAt: "2026-10-28T01:00:00.000Z",
    workflowUpdatedAt: "2026-10-28T01:01:00.000Z", diagnosticLoggedAt: "2026-10-28T01:00:30.000Z" }));
  assert.equal(selectLatestWorkflowObservation([first, backwardsRetry]).reasonCode, "ordering_conflict");
  const retry = importWorkflowObservation(metadata({ runAttempt: 2 }));
  assert.equal(selectLatestWorkflowObservation([retry, first]).observation.runAttempt, 2);
  const rewrittenHead = importWorkflowObservation(metadata({ runAttempt: 2, sourceCommit: "b".repeat(40) }));
  assert.equal(selectLatestWorkflowObservation([first, rewrittenHead]).reasonCode, "identity_conflict");
});

test("a later attempt of an older run is selected by workflow start rather than numeric run ID", () => {
  const old = importWorkflowObservation(metadata());
  const higherId = importWorkflowObservation(later());
  const retriedOld = importWorkflowObservation(metadata({ runAttempt: 2, workflowStartedAt: "2026-10-31T01:00:00.000Z",
    workflowUpdatedAt: "2026-10-31T01:01:00.000Z", diagnosticLoggedAt: "2026-10-31T01:00:30.000Z",
    observedAt: "2026-11-01T01:00:00.000Z" }));
  for (const records of [[old, higherId, retriedOld], [retriedOld, higherId, old]]) {
    const result = selectLatestWorkflowObservation(records);
    assert.equal(result.status, "AVAILABLE");
    assert.equal(result.observation.runId, FIRST);
    assert.equal(result.observation.runAttempt, 2);
    assert.equal(result.observation.workflowStartedAt, "2026-10-31T01:00:00.000Z");
  }
});

test("resealed semantic contradictions remain invalid rather than becoming authentic metadata", () => {
  const record = importWorkflowObservation(metadata());
  fails("invalid_identity", () => projectWorkflowObservation(reseal({ ...record, runUrl: `${record.runUrl}/attempts/2` })));
  fails("unknown_collector_time_required", () => projectWorkflowObservation(reseal({ ...record, collectorFinishedAt: record.workflowUpdatedAt })));
  const changed = copy(record); changed.diagnostics.events[0].reason = "http_failed";
  fails("invalid_diagnostics", () => projectWorkflowObservation(reseal(changed)));
});

test("Proxy objects, Proxy arrays and accessors are rejected before traps or private reads", () => {
  let reads = 0;
  const handler = Object.fromEntries(["get", "getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor", "has"]
    .map((key) => [key, () => { reads++; throw SECRET; }]));
  const proxy = (value) => new Proxy(value, handler);
  const record = importWorkflowObservation(metadata());
  for (const action of [() => importWorkflowObservation(proxy(metadata())), () => projectWorkflowObservation(proxy(record))]) fails("invalid_record", action);
  const input = metadata(); Object.defineProperty(input, "sourceCommit", { get() { reads++; throw SECRET; } });
  fails("invalid_record", () => importWorkflowObservation(input));
  const nested = metadata(); nested.diagnostics.events = proxy(nested.diagnostics.events);
  fails("invalid_diagnostics", () => importWorkflowObservation(nested));
  const steps = metadata(); steps.stepResults = proxy(steps.stepResults);
  fails("invalid_record", () => importWorkflowObservation(steps));
  assert.equal(selectLatestWorkflowObservation(proxy([record])).status, "UNAVAILABLE");
  assert.equal(selectLatestWorkflowObservation([proxy(record)]).status, "UNAVAILABLE");
  assert.equal(reads, 0);
});

test("all public APIs are pure explicit-input processing without fetch, filesystem or implicit current clock", (t) => {
  const input = metadata(), record = importWorkflowObservation(input);
  for (const name of ["readFileSync", "writeFileSync", "lstatSync", "realpathSync", "readdirSync", "mkdirSync"]) {
    t.mock.method(fs, name, () => { throw new Error("unexpected filesystem access"); });
  }
  t.mock.method(global, "fetch", () => { throw new Error("unexpected network access"); });
  t.mock.method(Date, "now", () => { throw new Error("unexpected implicit clock"); });
  assert.deepEqual(importWorkflowObservation(JSON.stringify(input)), record);
  assert.deepEqual(projectWorkflowObservation(record), record);
  assert.equal(selectLatestWorkflowObservation([record]).status, "AVAILABLE");
});

test("Buffer own accessors are rejected without reading caller-controlled byte properties", () => {
  for (const key of ["length", "buffer", "byteOffset", "byteLength", "toJSON", "constructor", Symbol.iterator]) {
    let reads = 0;
    const bytes = Buffer.from(JSON.stringify(metadata()), "utf8");
    Object.defineProperty(bytes, key, { get() { reads++; throw SECRET; } });
    fails("invalid_json", () => importWorkflowObservation(bytes));
    assert.equal(reads, 0);
  }
  let traps = 0;
  const bytes = Buffer.from(JSON.stringify(metadata()), "utf8");
  Object.setPrototypeOf(bytes, new Proxy(Buffer.prototype, { getPrototypeOf() { traps++; throw SECRET; } }));
  fails("invalid_json", () => importWorkflowObservation(bytes));
  assert.equal(traps, 0);
});

test("ordinary Buffers are copied through intrinsic byte metadata without backing accessors", () => {
  const text = JSON.stringify(metadata());
  const backing = new ArrayBuffer(Buffer.byteLength(text, "utf8"));
  const bytes = Buffer.from(backing); bytes.write(text, "utf8");
  let reads = 0;
  Object.defineProperty(backing, "byteLength", { get() { reads++; throw SECRET; } });
  assert.deepEqual(importWorkflowObservation(bytes), importWorkflowObservation(metadata()));
  assert.equal(reads, 0);
  const shared = Buffer.from(new SharedArrayBuffer(Buffer.byteLength(text, "utf8"))); shared.write(text, "utf8");
  fails("invalid_json", () => importWorkflowObservation(shared));
});
