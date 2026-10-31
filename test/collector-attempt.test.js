"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createAttempt, finishAttempt, projectPublicAttempt, createAttemptStore, selectLatestAttempt } = require("../src/collector-attempt");

const START = "2026-10-30T01:00:00.000Z";
const END = "2026-10-30T01:01:00.000Z";
const LOCAL = "local-11111111-1111-4111-8111-111111111111";
const SOURCE = "a".repeat(40);
const SECRET = "synthetic-private-person@example.invalid token=synthetic-secret";
function identity(extra = {}) { return { runId: LOCAL, runAttempt: 1, sourceCommit: SOURCE, workflowPath: "local", startedAt: START, ...extra }; }
function begin(extra) { return createAttempt(identity(extra)); }
function finish(record = begin(), extra = {}) {
  return finishAttempt(record, { finishedAt: END, collectionState: "COMPLETED", diagnostics: null,
    localPersistence: "SUCCEEDED", repositoryPersistence: "NOT_ATTEMPTED", publication: "NOT_ATTEMPTED", reasonCode: "collection_completed", ...extra });
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function reseal(record) {
  const { recordSha256, ...content } = record;
  return { ...content, recordSha256: crypto.createHash("sha256").update(stableJson(content)).digest("hex") };
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function fails(code, action) {
  assert.throws(action, (error) => {
    assert.equal(error.message, `collector_attempt_${code}`);
    assert.equal(error.code, error.message);
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
}
function diagnostics(reason = "access_denied", status = 403) {
  return { kind: "collector_diagnostics", schemaVersion: 1, aborted: true,
    search: { planned: 13, attempted: 1, succeeded: 0, failed: 1, notAttempted: 12 },
    details: { observed: 0, attempted: 0, succeeded: 0, failed: 0, notAttempted: 0 },
    events: [{ stage: "search", httpStatus: status, reason }] };
}
function aborted(reason = "access_denied", status = 403) {
  return finish(begin(), { collectionState: "ABORTED", diagnostics: diagnostics(reason, status),
    localPersistence: "NOT_ATTEMPTED", reasonCode: reason });
}
function eventDiagnostics(events) {
  const counts = (stage, totalKey) => {
    const rows = events.filter((event) => event.stage === stage);
    const attempted = rows.filter((event) => event.reason !== "not_attempted").length;
    const succeeded = rows.filter((event) => event.reason === "success").length;
    return { [totalKey]: rows.length, attempted, succeeded, failed: attempted - succeeded, notAttempted: rows.length - attempted };
  };
  return { kind: "collector_diagnostics", schemaVersion: 1,
    aborted: events.some((event) => ["access_denied", "authentication_required", "rate_limited", "captcha_required", "access_congestion", "protection_warning"].includes(event.reason)),
    search: counts("search", "planned"), details: counts("detail", "observed"), events };
}
function withEvents(events) {
  const value = eventDiagnostics(events);
  return finish(begin(), { diagnostics: value, collectionState: value.aborted ? "ABORTED" : "COMPLETED",
    reasonCode: value.aborted ? "collection_aborted" : "collection_completed",
    localPersistence: value.aborted ? "NOT_ATTEMPTED" : "SUCCEEDED" });
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cw-attempt-test-"));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "attempts");
  const publicOutputDir = path.join(root, "site"), evidenceOutputDir = path.join(root, "evidence");
  return { root, directory, publicOutputDir, evidenceOutputDir,
    store: () => createAttemptStore({ directory, publicOutputDir, evidenceOutputDir }) };
}
function recordFile(f) {
  return path.join(f.directory, fs.readdirSync(f.directory).find((name) => name.endsWith(".json")));
}

test("attempt creation has no invented finish, counts or downstream success", () => {
  const record = begin();
  assert.equal(record.collectionState, "RUNNING");
  assert.equal(record.finishedAt, null);
  assert.equal(record.diagnostics, null);
  for (const key of ["localPersistence", "repositoryPersistence", "publication"]) assert.equal(record[key], "NOT_ATTEMPTED");
  assert.deepEqual(projectPublicAttempt(record), record);
  assert.equal(Object.hasOwn(record, "completedAt"), false);
  assert.equal(Object.hasOwn(record, "totalJobs"), false);
});

test("403 and CAPTCHA stops retain failed acquisition diagnostics instead of becoming zero", () => {
  for (const [reason, status] of [["access_denied", 403], ["captcha_required", 200]]) {
    const record = aborted(reason, status);
    assert.equal(record.collectionState, "ABORTED");
    assert.equal(record.diagnostics.search.failed, 1);
    assert.equal(record.diagnostics.search.notAttempted, 12);
    assert.equal(record.reasonCode, reason);
    assert.equal(record.localPersistence, "NOT_ATTEMPTED");
    assert.deepEqual(projectPublicAttempt(record), record);
  }
  const noDiagnostics = finish(begin(), { collectionState: "ABORTED", diagnostics: null,
    localPersistence: "UNKNOWN", reasonCode: "collection_aborted" });
  assert.equal(noDiagnostics.diagnostics, null);
});

test("collection completion, local save, repository push and publication remain separate reported states", () => {
  const record = finish(begin(), { localPersistence: "SUCCEEDED", repositoryPersistence: "FAILED",
    publication: "SUCCEEDED", reasonCode: "repository_persistence_failed" });
  assert.equal(record.collectionState, "COMPLETED");
  assert.equal(record.repositoryPersistence, "FAILED");
  assert.equal(record.publication, "SUCCEEDED");
  const deploy = finish(begin(), { repositoryPersistence: "SUCCEEDED", publication: "FAILED", reasonCode: "publication_failed" });
  assert.equal(deploy.collectionState, "COMPLETED");
  assert.equal(deploy.publication, "FAILED");
  assert.equal(deploy.diagnostics, null);
});

test("timestamps require explicit real UTC instants and cannot run backwards", () => {
  for (const startedAt of [null, false, 0, "2026-02-30T01:00:00.000Z", "2026-10-30T01:00:00", "2026-10-30T10:00:00+09:00", START.replace(".000", "")]) {
    fails("invalid_record", () => begin({ startedAt }));
  }
  for (const finishedAt of [undefined, null, "invalid", "2026-10-30T00:59:59.000Z"]) fails("invalid_record", () => finish(begin(), { finishedAt }));
  assert.equal(finish(begin(), { finishedAt: START }).finishedAt, START);
});

test("identities accept only GitHub numeric IDs or opaque local UUIDv4 and fixed workflows", () => {
  assert.equal(begin({ runId: "123456", workflowPath: ".github/workflows/daily.yml" }).runId, "123456");
  for (const extra of [{ runId: "local-person-token" }, { runId: [LOCAL] }, { runAttempt: 0 }, { runAttempt: "1" },
    { sourceCommit: [SOURCE] }, { sourceCommit: SOURCE.toUpperCase() }, { workflowPath: ".github/workflows/other.yml" }]) {
    fails("invalid_record", () => begin(extra));
  }
});

test("public projection rejects unknown fields, untrusted reason strings and hash changes", () => {
  for (const value of [{ ...begin(), description: SECRET }, { ...begin(), reasonCode: SECRET }]) fails("invalid_record", () => projectPublicAttempt(value));
  const changed = { ...finish(), finishedAt: "2026-10-30T01:02:00.000Z" };
  fails("hash_mismatch", () => projectPublicAttempt(changed));
  const nested = copy(aborted()); nested.diagnostics.events[0].query = SECRET;
  fails("invalid_record", () => projectPublicAttempt(reseal(nested)));
});

test("diagnostics require consistent counts, stop flags and fixed event metadata", () => {
  for (const change of [
    (d) => { d.search.failed = 0; }, (d) => { d.search.attempted = null; },
    (d) => { d.events[0].reason = SECRET; }, (d) => { d.events[0].httpStatus = "403"; },
    (d) => { d.aborted = false; }, (d) => { d.events = []; }
  ]) {
    const record = copy(aborted()); change(record.diagnostics);
    fails("invalid_record", () => projectPublicAttempt(reseal(record)));
  }
  const wrongState = copy(aborted()); wrongState.collectionState = "FAILED";
  fails("invalid_record", () => projectPublicAttempt(reseal(wrongState)));
  fails("invalid_record", () => finish(begin(), { collectionState: "FAILED", reasonCode: "collection_aborted" }));
  fails("invalid_record", () => finish(begin(), { collectionState: "ABORTED", reasonCode: "collection_aborted", localPersistence: "SUCCEEDED" }));
});

test("terminal finish is idempotent only for the identical lifecycle result", () => {
  const record = finish();
  assert.deepEqual(finish(record), record);
  fails("identity_collision", () => finish(record, { finishedAt: "2026-10-30T01:02:00.000Z" }));
  fails("invalid_record", () => finish(begin(), { collectionState: "RUNNING" }));
});

test("public APIs reject object and array accessors without reading secrets", () => {
  let reads = 0;
  const value = begin();
  Object.defineProperty(value, "diagnostics", { enumerable: true, get() { reads++; throw SECRET; } });
  fails("invalid_record", () => projectPublicAttempt(value));
  const record = copy(aborted());
  Object.defineProperty(record.diagnostics.events, "0", { get() { reads++; throw SECRET; } });
  fails("invalid_record", () => projectPublicAttempt(record));
  const records = [begin()];
  Object.defineProperty(records, "0", { get() { reads++; throw SECRET; } });
  assert.equal(selectLatestAttempt(records).status, "unknown");
  assert.equal(reads, 0);
});

test("latest reducer distinguishes missing records and identity mismatches without synthesizing success", () => {
  assert.deepEqual(selectLatestAttempt([]), { status: "missing", attempt: null, reasonCode: "attempt_missing" });
  const result = selectLatestAttempt([aborted()], { expectedIdentity: { runId: "123456" } });
  assert.deepEqual(result, { status: "unknown", attempt: null, reasonCode: "identity_mismatch" });
  assert.equal(selectLatestAttempt([null]).status, "unknown");
});

test("latest reducer is insensitive to duplicate and out-of-order begin and terminal delivery", () => {
  const start = begin(), end = finish(start);
  for (const records of [[start, end, end], [end, start], [end, end]]) {
    assert.deepEqual(selectLatestAttempt(records), { status: "available", attempt: end, reasonCode: "latest_attempt" });
  }
  const newer = aborted();
  const old = finish(begin({ runId: "123", startedAt: "2026-10-29T01:00:00.000Z" }), { finishedAt: "2026-10-29T01:01:00.000Z" });
  assert.equal(selectLatestAttempt([newer, old]).attempt.collectionState, "ABORTED");
  assert.equal(selectLatestAttempt([old, newer]).attempt.collectionState, "ABORTED");
});

test("latest reducer fails closed for duplicate identities, backwards attempts and ambiguous clocks", () => {
  const a = finish(), b = finish(begin(), { finishedAt: "2026-10-30T01:02:00.000Z" });
  assert.equal(selectLatestAttempt([a, b]).reasonCode, "identity_conflict");
  const hashChanged = { ...a, recordSha256: "b".repeat(64) };
  assert.equal(selectLatestAttempt([a, hashChanged]).reasonCode, "invalid_record");
  const backwards = begin({ runAttempt: 2, startedAt: "2026-10-30T00:59:00.000Z" });
  assert.equal(selectLatestAttempt([a, backwards]).reasonCode, "ordering_conflict");
  assert.equal(selectLatestAttempt([a, begin({ runId: "123456" })]).reasonCode, "ordering_conflict");
  const retry = begin({ runAttempt: 2 });
  assert.equal(selectLatestAttempt([a, retry]).attempt.runAttempt, 2);
});

test("local store atomically advances the same begin to terminal and preserves idempotency", (t) => {
  const f = fixture(t), store = f.store(), start = begin(), end = finish(start);
  assert.equal(fs.existsSync(f.directory), false);
  assert.deepEqual(store.save(start), { status: "saved" });
  assert.deepEqual(store.save(start), { status: "idempotent" });
  assert.deepEqual(store.save(end), { status: "saved" });
  assert.deepEqual(store.save(end), { status: "idempotent" });
  assert.equal(fs.readdirSync(f.directory).length, 1);
  assert.deepEqual(projectPublicAttempt(JSON.parse(fs.readFileSync(recordFile(f), "utf8"))), end);
});

test("local store rejects terminal conflicts and stale begins while preserving previous bytes", (t) => {
  const f = fixture(t), store = f.store(), end = finish(); store.save(end);
  const file = recordFile(f), bytes = fs.readFileSync(file);
  fails("identity_collision", () => store.save(finish(begin(), { publication: "FAILED", reasonCode: "publication_failed" })));
  fails("state_regression", () => store.save(begin()));
  fails("identity_collision", () => store.save(begin({ sourceCommit: "b".repeat(40) })));
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test("partial staging writes and rename failures leave the prior record intact", (t) => {
  const f = fixture(t), store = f.store(); store.save(begin());
  const file = recordFile(f), prior = fs.readFileSync(file), write = fs.writeFileSync;
  const mocked = t.mock.method(fs, "writeFileSync", (target, bytes) => {
    if (typeof target === "number") { write(target, bytes.subarray(0, 12)); throw new Error(SECRET); }
    return write(target, bytes);
  });
  fails("storage_failed", () => store.save(finish()));
  assert.deepEqual(fs.readFileSync(file), prior);
  assert.deepEqual(fs.readdirSync(f.directory), [path.basename(file)]);
  mocked.mock.restore();
  t.mock.method(fs, "renameSync", () => { const error = new Error(SECRET); error.code = "collector_attempt_private-secret"; throw error; });
  fails("storage_failed", () => store.save(finish()));
  assert.deepEqual(fs.readFileSync(file), prior);
});

test("store refuses malformed, noncanonical and nonregular existing records", (t) => {
  const f = fixture(t), store = f.store(); store.save(begin());
  const file = recordFile(f), bytes = fs.readFileSync(file);
  for (const bad of [Buffer.from("{"), Buffer.concat([Buffer.from(" "), bytes])]) {
    fs.writeFileSync(file, bad);
    assert.throws(() => store.save(finish()), /collector_attempt_(?:storage_failed|invalid_store)/);
    assert.deepEqual(fs.readFileSync(file), bad);
  }
  fs.writeFileSync(file, bytes);
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (target) => target === file ? { isFile: () => false, isSymbolicLink: () => true, size: bytes.length } : lstat(target));
  fails("invalid_store", () => store.save(finish()));
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test("store isolation rejects public/evidence paths, ancestors, aliases and relative directories", (t) => {
  const f = fixture(t);
  for (const directory of [f.publicOutputDir, path.join(f.publicOutputDir, "attempts"), f.evidenceOutputDir,
    path.join(f.evidenceOutputDir, "attempts"), f.root, "relative", path.resolve(__dirname, "..", "collector-data", "attempts")]) {
    fails("unsafe_path", () => createAttemptStore({ directory, publicOutputDir: f.publicOutputDir, evidenceOutputDir: f.evidenceOutputDir }));
  }
  const alias = path.join(f.root, "alias"); fs.mkdirSync(alias);
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (target) => target === alias ? { isSymbolicLink: () => true, isDirectory: () => true } : lstat(target));
  fails("unsafe_path", () => createAttemptStore({ directory: path.join(alias, "attempts") }));
});

test("an existing lock is preserved and never bypassed", (t) => {
  const f = fixture(t); fs.mkdirSync(f.directory); fs.mkdirSync(path.join(f.directory, ".write-lock"));
  fails("store_locked", () => f.store().save(begin()));
  assert.deepEqual(fs.readdirSync(f.directory), [".write-lock"]);
});

test("pure lifecycle and projection never fetch, access credentials, files or implicit current time", (t) => {
  for (const name of ["readFileSync", "writeFileSync", "readdirSync", "lstatSync", "realpathSync", "mkdirSync"]) {
    t.mock.method(fs, name, () => { throw new Error("unexpected filesystem access"); });
  }
  t.mock.method(global, "fetch", () => { throw new Error("unexpected fetch"); });
  t.mock.method(Date, "now", () => { throw new Error("unexpected clock"); });
  assert.equal(projectPublicAttempt(finish()).collectionState, "COMPLETED");
  assert.equal(selectLatestAttempt([aborted()]).attempt.collectionState, "ABORTED");
});

test("Proxy objects and arrays are rejected before any trap or property access", () => {
  let traps = 0;
  const handler = Object.fromEntries(["get", "getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor", "has"]
    .map((name) => [name, () => { traps++; throw new Error(SECRET); }]));
  const proxy = (value) => new Proxy(value, handler);
  const record = begin();
  const fields = { finishedAt: END, collectionState: "COMPLETED", reasonCode: "collection_completed" };
  for (const action of [
    () => createAttempt(proxy(identity())),
    () => projectPublicAttempt(proxy(record)),
    () => finishAttempt(proxy(record), fields),
    () => finishAttempt(record, proxy(fields)),
    () => finishAttempt(record, { ...fields, diagnostics: proxy(diagnostics()) }),
    () => finishAttempt(record, { ...fields, diagnostics: { ...diagnostics(), events: proxy(diagnostics().events) } }),
    () => finishAttempt(record, { ...fields, diagnostics: { ...diagnostics(), search: proxy(diagnostics().search) } }),
    () => finishAttempt(record, { ...fields, localPersistence: proxy({}) }),
    () => createAttemptStore(proxy({ directory: path.join(os.tmpdir(), "cw-proxy-must-not-create") }))
  ]) fails("invalid_record", action);
  for (const result of [
    selectLatestAttempt(proxy([record])),
    selectLatestAttempt([proxy(record)]),
    selectLatestAttempt([record], proxy({})),
    selectLatestAttempt([record], { expectedIdentity: proxy({ runId: LOCAL }) })
  ]) assert.deepEqual(result, { status: "unknown", attempt: null, reasonCode: "invalid_record" });
  const revoked = Proxy.revocable(record, handler); revoked.revoke();
  fails("invalid_record", () => projectPublicAttempt(revoked.proxy));
  assert.equal(traps, 0);
});

test("store save refuses a Proxy record before performing filesystem operations", (t) => {
  const f = fixture(t), store = f.store();
  let traps = 0, accesses = 0;
  const record = new Proxy(begin(), { getPrototypeOf() { traps++; throw SECRET; }, ownKeys() { traps++; throw SECRET; } });
  for (const name of ["readFileSync", "writeFileSync", "lstatSync", "realpathSync", "mkdirSync"]) {
    t.mock.method(fs, name, () => { accesses++; throw new Error("unexpected filesystem access"); });
  }
  fails("invalid_record", () => store.save(record));
  assert.equal(traps, 0);
  assert.equal(accesses, 0);
});

test("access stops forbid subsequent attempted events even when all diagnostic counts match", () => {
  const stop = { stage: "search", httpStatus: 403, reason: "access_denied" };
  for (const event of [
    { stage: "detail", httpStatus: 200, reason: "success" },
    { stage: "detail", httpStatus: null, reason: "network_failed" },
    { stage: "search", httpStatus: 500, reason: "http_failed" },
    { stage: "collector", httpStatus: null, reason: "collector_failed" },
    { stage: "detail", httpStatus: 429, reason: "rate_limited" }
  ]) {
    fails("invalid_record", () => withEvents([stop, event]));
    const record = copy(aborted());
    record.diagnostics = eventDiagnostics([stop, event]);
    fails("invalid_record", () => projectPublicAttempt(reseal(record)));
  }
});

test("all search events precede detail events and diagnostics contain at most one stop", () => {
  const search = { stage: "search", httpStatus: 200, reason: "success" };
  const detail = { stage: "detail", httpStatus: 200, reason: "success" };
  fails("invalid_record", () => withEvents([detail, search]));
  fails("invalid_record", () => withEvents([search, detail, { stage: "search", httpStatus: 500, reason: "http_failed" }]));
  fails("invalid_record", () => withEvents([
    { stage: "search", httpStatus: 403, reason: "access_denied" },
    { stage: "search", httpStatus: 403, reason: "access_denied" }
  ]));
});

test("explicit HTTP access-stop statuses require their matching fixed reason", () => {
  const reasons = { 401: "authentication_required", 403: "access_denied", 429: "rate_limited" };
  for (const [status, reason] of Object.entries(reasons)) {
    const correct = { stage: "search", httpStatus: Number(status), reason };
    assert.equal(withEvents([correct]).collectionState, "ABORTED");
    for (const wrong of ["http_failed", "network_failed", "captcha_required", "protection_warning",
      ...Object.values(reasons).filter((value) => value !== reason)]) {
      fails("invalid_record", () => withEvents([{ ...correct, reason: wrong }]));
    }
  }
});

test("known reason and HTTP contradictions cannot claim absence of contact or parsed response", () => {
  for (const event of [
    { stage: "detail", httpStatus: 200, reason: "not_attempted" },
    { stage: "search", httpStatus: 500, reason: "extraction_failed" },
    { stage: "detail", httpStatus: 500, reason: "unsupported_response" },
    { stage: "collector", httpStatus: 200, reason: "success" },
    { stage: "collector", httpStatus: 500, reason: "collector_failed" }
  ]) fails("invalid_record", () => withEvents([event]));
});

test("only explicit no-contact not-attempted markers may follow an access stop", () => {
  const events = [
    { stage: "search", httpStatus: 200, reason: "success" },
    { stage: "detail", httpStatus: 403, reason: "access_denied" },
    { stage: "detail", httpStatus: null, reason: "not_attempted" }
  ];
  const record = withEvents(events);
  assert.equal(record.collectionState, "ABORTED");
  assert.equal(record.diagnostics.details.notAttempted, 1);
  assert.deepEqual(projectPublicAttempt(record), record);
  fails("invalid_record", () => withEvents([...events.slice(0, 2), { stage: "detail", httpStatus: 200, reason: "not_attempted" }]));
});

test("ordinary HTTP failures, partial parsing and unknown contact status remain representable", () => {
  for (const events of [
    [{ stage: "search", httpStatus: 500, reason: "http_failed" },
      { stage: "search", httpStatus: 200, reason: "extraction_failed" },
      { stage: "detail", httpStatus: 200, reason: "extraction_failed" }],
    [{ stage: "search", httpStatus: 200, reason: "success" },
      { stage: "detail", httpStatus: 200, reason: "http_failed" }],
    [{ stage: "search", httpStatus: null, reason: "network_failed" },
      { stage: "search", httpStatus: 200, reason: "success" },
      { stage: "detail", httpStatus: null, reason: "not_attempted" }]
  ]) assert.equal(withEvents(events).collectionState, "COMPLETED");
  assert.equal(withEvents([{ stage: "search", httpStatus: 200, reason: "captcha_required" }]).collectionState, "ABORTED");
  assert.equal(withEvents([{ stage: "search", httpStatus: null, reason: "captcha_required" }]).collectionState, "ABORTED");
});
