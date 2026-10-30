"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runDaily } = require("../src/daily");
const { projectPublicAttempt } = require("../src/collector-attempt");

const START = "2026-10-30T01:59:30.000Z", END = "2026-10-30T01:59:40.000Z";
const ID = "local-11111111-1111-4111-8111-111111111111";
const COMMIT = "a".repeat(40);
const ZERO = '<div id="vue-container" data="{&quot;searchResult&quot;:{&quot;job_offers&quot;:[]}}"></div>';

// Fail any unexpected in-process HTTP through the same mock mechanism used by
// the existing synthetic tests. CLI child processes install their own preload.
test.beforeEach((t) => t.mock.method(global, "fetch", async () => { throw new Error("synthetic_network_disabled"); }));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-state-integration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, outputDir: path.join(dir, "site"), evidenceDir: path.join(dir, "evidence"), records: path.join(dir, "records") };
}

function options(f) {
  return { outputDir: f.outputDir, evidenceDir: f.evidenceDir, keywords: ["synthetic", "next"],
    now: new Date(START), clock: () => new Date(END), attemptClock: () => new Date(END),
    attemptRecord: { directory: f.records, runId: ID, runAttempt: 1, sourceCommit: COMMIT, workflowPath: "local" },
    fetchSearchPage: async () => ({ ok: true, status: 200, html: ZERO }),
    fetchJobDetail: async () => { throw new Error("unexpected_synthetic_detail_request"); } };
}

function record(f) {
  const files = fs.readdirSync(f.records).filter((file) => file.endsWith(".json"));
  assert.equal(files.length, 1);
  return projectPublicAttempt(JSON.parse(fs.readFileSync(path.join(f.records, files[0]), "utf8")));
}

for (const [status, warning, reason] of [[403, "", "access_denied"], [200, "CAPTCHA required", "captcha_required"]]) {
  test(`opt-in records ${reason} separately and preserves the saved summary`, async (t) => {
    const f = fixture(t);
    fs.mkdirSync(f.outputDir);
    const previous = '{"syntheticPrevious":"unchanged"}\n';
    fs.writeFileSync(path.join(f.outputDir, "latest.json"), previous);
    let calls = 0;
    await assert.rejects(runDaily({ ...options(f), fetchSearchPage: async () => { calls++;
      return { ok: status === 200, status, html: warning }; } }), (error) => error.name === "CollectionAbortedError");
    const value = record(f);
    assert.equal(calls, 1);
    assert.equal(value.collectionState, "ABORTED");
    assert.equal(value.diagnostics.events[0].reason, reason);
    assert.equal(value.diagnostics.search.notAttempted, 1);
    assert.equal(value.localPersistence, "NOT_ATTEMPTED");
    assert.equal(value.repositoryPersistence, "NOT_ATTEMPTED");
    assert.equal(value.publication, "NOT_ATTEMPTED");
    assert.equal(value.startedAt, START);
    assert.equal(value.finishedAt, END);
    assert.equal(fs.readFileSync(path.join(f.outputDir, "latest.json"), "utf8"), previous);
    assert.equal(fs.existsSync(f.evidenceDir), false);
    assert.doesNotMatch(JSON.stringify(value), /syntheticPrevious|next|keywords|html|description/);
  });
}

test("retrieval completed, local save, Git save and deployment are independent states", async (t) => {
  const f = fixture(t);
  const report = await runDaily(options(f));
  const value = record(f);
  assert.equal(report.totalJobs, 0);
  assert.equal(value.collectionState, "COMPLETED");
  assert.equal(value.localPersistence, "SUCCEEDED");
  assert.equal(value.repositoryPersistence, "NOT_ATTEMPTED");
  assert.equal(value.publication, "NOT_ATTEMPTED");
  assert.equal(value.diagnostics.search.succeeded, 2);
});

test("completed unknown retrieval never becomes a verified successful collection", async (t) => {
  const f = fixture(t);
  const report = await runDaily({ ...options(f), fetchSearchPage: async () => ({ ok: false, status: 500, html: "" }) });
  const value = record(f);
  assert.equal(report.totalJobs, null);
  assert.equal(value.collectionState, "COMPLETED");
  assert.equal(value.diagnostics.search.failed, 2);
  assert.equal(value.localPersistence, "SUCCEEDED");
  assert.equal(Object.hasOwn(value, "verifiedSuccess"), false);
});

test("a different detail identity remains an extraction failure with unknown HTTP status", async (t) => {
  const f = fixture(t);
  const payload = { searchResult: { job_offers: [{ job_offer: { id: 123, title: "Python CSV JSON API",
    description_digest: "Python CSV processing with Excel output", expired_on: "2099-12-31" },
    payment: { fixed_price_payment: { min_budget: 10000 } } }] } };
  const html = `<div id="vue-container" data="${JSON.stringify(payload).replace(/"/g, "&quot;")}"></div>`;
  const report = await runDaily({ ...options(f), fetchSearchPage: async () => ({ ok: true, status: 200, html }),
    fetchJobDetail: async () => ({ id: "999", url: "https://crowdworks.jp/public/jobs/999",
      detailFetch: { ok: true, status: 200, outcome: "success" }, description: "unrelated", detailCheckedAt: END }) });
  assert.equal(report.recommendation, null);
  const value = record(f);
  assert.equal(value.collectionState, "COMPLETED");
  assert.equal(value.localPersistence, "SUCCEEDED");
  assert.equal(value.diagnostics.details.failed, 1);
  assert.deepEqual(value.diagnostics.events.at(-1), { stage: "detail", httpStatus: null, reason: "extraction_failed" });
});

test("local persistence failure is recorded without replacing the previous summary", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.outputDir);
  const target = path.join(f.outputDir, "latest.json");
  fs.writeFileSync(target, "previous bytes");
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    if (file === target) throw new Error("SYNTHETIC_PRIVATE_SAVE_MARKER");
    return write(file, ...args);
  });
  await assert.rejects(runDaily(options(f)));
  const value = record(f);
  assert.equal(value.collectionState, "COMPLETED");
  assert.equal(value.localPersistence, "FAILED");
  assert.equal(value.reasonCode, "local_persistence_failed");
  assert.equal(value.repositoryPersistence, "NOT_ATTEMPTED");
  assert.equal(value.publication, "NOT_ATTEMPTED");
  assert.equal(fs.readFileSync(target, "utf8"), "previous bytes");
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_SAVE|Error|stack|cause/);
});

test("post-retrieval failure before persistence saves a terminal failure rather than a running record", async (t) => {
  const f = fixture(t);
  await assert.rejects(runDaily({ ...options(f), onDiagnostics: () => { throw new Error("SYNTHETIC_PRIVATE_CALLBACK"); } }));
  const value = record(f);
  assert.equal(value.collectionState, "FAILED");
  assert.equal(value.reasonCode, "collector_failed");
  assert.equal(value.finishedAt, END);
  assert.equal(value.diagnostics.search.succeeded, 2);
  assert.equal(value.localPersistence, "NOT_ATTEMPTED");
  assert.equal(value.repositoryPersistence, "NOT_ATTEMPTED");
  assert.equal(value.publication, "NOT_ATTEMPTED");
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_CALLBACK/);
  assert.equal(fs.existsSync(f.outputDir), false);
  assert.equal(fs.existsSync(f.evidenceDir), false);
});

test("record destination failure prevents the first collection request", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.records, "not a directory");
  let calls = 0;
  await assert.rejects(runDaily({ ...options(f), fetchSearchPage: async () => { calls++; return {}; } }));
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(f.records, "utf8"), "not a directory");
  assert.equal(fs.existsSync(f.outputDir), false);
});

test("terminal record write failure preserves the original stop and is not retried", async (t) => {
  const f = fixture(t);
  const rename = fs.renameSync;
  let writes = 0;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (String(to).startsWith(f.records) && ++writes === 2) throw new Error("SYNTHETIC_PRIVATE_RECORD_MARKER");
    return rename(from, to);
  });
  await assert.rejects(runDaily({ ...options(f), fetchSearchPage: async () => ({ ok: false, status: 403, html: "" }) }),
    (error) => error.name === "CollectionAbortedError" && error.diagnostics.events[0].reason === "access_denied");
  assert.equal(writes, 2);
  assert.equal(record(f).collectionState, "RUNNING");
  assert.equal(record(f).finishedAt, null);
  assert.equal(fs.existsSync(f.outputDir), false);
});

test("a completed identity cannot start another collection or silently change its source", async (t) => {
  const f = fixture(t);
  await runDaily(options(f));
  const before = record(f);
  let calls = 0;
  const request = async () => { calls++; return { ok: true, status: 200, html: ZERO }; };
  await assert.rejects(runDaily({ ...options(f), fetchSearchPage: request }));
  await assert.rejects(runDaily({ ...options(f), attemptRecord: { ...options(f).attemptRecord, sourceCommit: "b".repeat(40) }, fetchSearchPage: request }));
  assert.equal(calls, 0);
  assert.deepEqual(record(f), before);
});

test("invalid terminal clock remains incomplete rather than inventing a finish", async (t) => {
  const f = fixture(t);
  await assert.rejects(runDaily({ ...options(f), attemptClock: () => new Date("invalid") }), /attempt_record_failed/);
  assert.equal(record(f).finishedAt, null);
  assert.equal(record(f).collectionState, "RUNNING");
  let calls = 0;
  await assert.rejects(runDaily({ ...options(f), fetchSearchPage: async () => { calls++; return {}; } }), /attempt_already_recorded/);
  assert.equal(calls, 0);
});

test("attempt output may not overlap public, evidence or repository snapshot paths", async (t) => {
  const f = fixture(t);
  let calls = 0;
  for (const directory of [f.outputDir, path.join(f.outputDir, "state"), f.evidenceDir, f.dir,
    path.join(__dirname, "../collector-data/state")]) {
    await assert.rejects(runDaily({ ...options(f), attemptRecord: { ...options(f).attemptRecord, directory },
      fetchSearchPage: async () => { calls++; return {}; } }));
  }
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test("attempt options reject accessors without reading them", async (t) => {
  const f = fixture(t);
  let reads = 0;
  const settings = { ...options(f).attemptRecord };
  Object.defineProperty(settings, "directory", { enumerable: true, get() { reads++; throw new Error("PRIVATE"); } });
  await assert.rejects(runDaily({ ...options(f), attemptRecord: settings }), /invalid_attempt_record_options/);
  assert.equal(reads, 0);
  const proxy = new Proxy({}, { getPrototypeOf() { reads++; throw new Error("PRIVATE"); },
    ownKeys() { reads++; throw new Error("PRIVATE"); }, get() { reads++; throw new Error("PRIVATE"); } });
  await assert.rejects(runDaily({ ...options(f), attemptRecord: proxy }), /invalid_attempt_record_options/);
  assert.equal(reads, 0);
});

test("real CLI with explicit attempt output records a stop without any live network", (t) => {
  const f = fixture(t);
  const preload = path.join(f.dir, "synthetic-fetch.cjs");
  fs.writeFileSync(preload, 'global.fetch = async () => ({ok:false,status:403,text:async()=>{throw new Error("PRIVATE_BODY");}});\n');
  const result = spawnSync(process.execPath, ["--require", preload, path.join(__dirname, "../src/daily.js"),
    "--output", f.outputDir, "--evidence-output", f.evidenceDir, "--attempt-output", f.records,
    "--attempt-run-id", ID, "--source-commit", COMMIT], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).events[0].reason, "access_denied");
  assert.equal(record(f).collectionState, "ABORTED");
  assert.equal(record(f).diagnostics.search.notAttempted, 12);
  assert.doesNotMatch(result.stderr, /PRIVATE_BODY|[A-Z]:\\|Error:/);
});
