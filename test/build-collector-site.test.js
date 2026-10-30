"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { buildCollectorSite } = require("../src/build-collector-site");
const { preparePublicArtifact } = require("../src/prepare-public-artifact");
const { importWorkflowObservation } = require("../src/workflow-observation");
const { importPublicPatrol } = require("../src/public-patrol-import");

const AS_OF = "2026-10-30T05:00:00.000Z";
const PRIVATE_MARKER = "SYNTHETIC_PRIVATE_MARKER@example.invalid";
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const FILES = [".nojekyll", "collector-status.json", "index.html", "latest.json", "latest.md", "public-patrol.json"];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cw-site-builder-synthetic-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const archiveDir = path.join(root, "saved"), observations = path.join(root, "observations");
  fs.mkdirSync(archiveDir); fs.mkdirSync(observations);
  const summaryFile = path.join(root, "summary.json");
  const summary = { generatedAt: "2026-10-29T01:00:00.000Z", generatedAtJst: "synthetic saved time",
    keywords: ["synthetic"], attempts: [{ keyword: "synthetic", ok: false, status: 403, imported: null, error: "fetch_failed" }],
    totalJobs: null, safeCandidates: null, recommendation: null };
  const bytes = Buffer.from(`${JSON.stringify(summary, null, 4)}\r\n`, "utf8");
  fs.writeFileSync(summaryFile, bytes);
  fs.writeFileSync(path.join(archiveDir, "2026-10-29.json"), bytes);
  return { root, archiveDir, observations, summaryFile, summary, bytes,
    options: { summaryFile, archiveDir, observationFiles: [], outputDir: path.join(root, "site"), asOf: AS_OF } };
}

function metadata({ runId = "111", runAttempt = 1, jobId = "1111", started = "2026-10-29T01:00:00.000Z",
  updated = "2026-10-29T01:01:00.000Z", observedAt = "2026-10-30T04:00:00.000Z", sourceCommit = "a".repeat(40) } = {}) {
  const runUrl = `https://github.com/amindjapan/cw-work-agent-daily/actions/runs/${runId}`;
  return importWorkflowObservation({ kind: "workflow_observation", schemaVersion: 1,
    repository: "amindjapan/cw-work-agent-daily", workflowPath: ".github/workflows/daily.yml", runId, runAttempt, jobId,
    sourceCommit, runUrl, jobUrl: `${runUrl}/job/${jobId}`, workflowStartedAt: started, workflowUpdatedAt: updated, observedAt,
    collectorStartedAt: null, collectorFinishedAt: null, diagnosticLoggedAt: null,
    diagnostics: { kind: "collector_diagnostics", schemaVersion: 1, aborted: true,
      search: { planned: 13, attempted: 1, succeeded: 0, failed: 1, notAttempted: 12 },
      details: { observed: 0, attempted: 0, succeeded: 0, failed: 0, notAttempted: 0 },
      events: [{ stage: "search", httpStatus: 403, reason: "access_denied" }] },
    stepResults: { tests: "SUCCEEDED", collection: "FAILED", snapshot: "SKIPPED", repositoryPersistence: "SKIPPED", publication: "SKIPPED" } });
}

function saveObservation(f, record, name = `${record.runId}-${record.runAttempt}.json`) {
  const file = path.join(f.observations, name);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

function json(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function rejected(options, code) {
  assert.throws(() => buildCollectorSite(options), (error) => {
    assert.equal(error.message, error.code);
    assert.match(error.code, /^collector_site_[a-z_]+$/);
    if (code) assert.equal(error.code, `collector_site_${code}`);
    assert.equal(error.message.includes(PRIVATE_MARKER), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(fs.existsSync(options.outputDir), false);
}

test("offline builder writes exactly six files plus existing dated archives and returns their hashes", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.archiveDir, "latest.json"), "ignored alias");
  fs.writeFileSync(path.join(f.archiveDir, "private.json"), PRIVATE_MARKER);
  fs.mkdirSync(path.join(f.archiveDir, "nested"));
  fs.writeFileSync(path.join(f.archiveDir, "nested", "2026-10-28.json"), PRIVATE_MARKER);
  const before = [f.summaryFile, path.join(f.archiveDir, "2026-10-29.json")].map((file) => hash(fs.readFileSync(file)));
  const result = buildCollectorSite(f.options);
  assert.equal(result.status, "collector_site_built");
  assert.equal(result.manifest.publicFileCount, 7);
  assert.equal(result.manifest.archiveCount, 1);
  assert.equal(result.manifest.observationFileCount, 0);
  assert.equal(result.manifest.selectedObservationSha256, null);
  assert.deepEqual(fs.readdirSync(f.options.outputDir).sort(), [...FILES, "archive"].sort());
  assert.deepEqual(fs.readdirSync(path.join(f.options.outputDir, "archive")), ["2026-10-29.json"]);
  assert.deepEqual(fs.readFileSync(path.join(f.options.outputDir, "latest.json")), f.bytes);
  assert.deepEqual(fs.readFileSync(path.join(f.options.outputDir, "archive", "2026-10-29.json")), f.bytes);
  assert.deepEqual([f.summaryFile, path.join(f.archiveDir, "2026-10-29.json")].map((file) => hash(fs.readFileSync(file))), before);
  assert.equal(result.manifest.summary.sha256, hash(f.bytes));
  for (const item of result.manifest.files) {
    const bytes = fs.readFileSync(path.join(f.options.outputDir, ...item.path.split("/")));
    assert.equal(item.bytes, bytes.length); assert.equal(item.sha256, hash(bytes));
  }
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_MARKER|[A-Z]:\\|\/tmp\//);
  assert.equal(json(path.join(f.options.outputDir, "collector-status.json")).availability, "UNAVAILABLE");
  assert.equal(json(path.join(f.options.outputDir, "public-patrol.json")).availability, "UNAVAILABLE");
  assert.ok(!result.files.some((file) => file.includes("2026-10-30") || /DAY/.test(file)));
});

test("archiveDir may be omitted without fabricating a date or adding a manifest file", (t) => {
  const f = fixture(t); const options = { ...f.options, archiveDir: undefined };
  const result = buildCollectorSite(options);
  assert.equal(result.manifest.publicFileCount, 6);
  assert.deepEqual(fs.readdirSync(options.outputDir).sort(), FILES);
});

test("full public projection retains the failed legacy summary, schema2 status and archive bytes", (t) => {
  const f = fixture(t);
  f.summary.keywords = Array.from({ length: 13 }, (_, index) => `synthetic-${index + 1}`);
  f.summary.attempts = f.summary.keywords.map((keyword) => ({ keyword, ok: false, status: 403, imported: null, error: "fetch_failed" }));
  const original = Buffer.from(`${JSON.stringify(f.summary, null, 4)}\r\n`, "utf8");
  fs.writeFileSync(f.summaryFile, original);
  const archiveFile = path.join(f.archiveDir, "2026-10-29.json"); fs.writeFileSync(archiveFile, original);
  const observation = metadata({ runId: "222", jobId: "2222", started: "2026-10-30T01:00:00.000Z",
    updated: "2026-10-30T01:01:00.000Z", sourceCommit: "b".repeat(40) });
  const originalFetch = global.fetch;
  try {
    global.fetch = () => { throw new Error("unexpected network operation"); };
    const built = buildCollectorSite({ ...f.options, observationFiles: [saveObservation(f, observation)] });
    const artifact = path.join(f.root, "public-artifact");
    const projected = preparePublicArtifact({ sourceDir: f.options.outputDir, outputDir: artifact, includeOverview: true });
    assert.equal(built.manifest.publicFileCount, 7);
    assert.equal(projected.copiedFiles.length, 7);
    assert.deepEqual(fs.readdirSync(artifact).sort(), [...FILES, "archive"].sort());
    for (const file of [f.summaryFile, archiveFile, path.join(artifact, "latest.json"), path.join(artifact, "archive", "2026-10-29.json")]) {
      assert.deepEqual(fs.readFileSync(file), original);
      assert.equal(hash(fs.readFileSync(file)), built.manifest.summary.sha256);
    }
    const status = json(path.join(artifact, "collector-status.json"));
    assert.equal(status.schemaVersion, 2);
    assert.deepEqual(status.workflowObservation, observation);
    assert.equal(status.workflowObservation.collectorStartedAt, null);
    assert.equal(status.workflowObservation.collectorFinishedAt, null);
    assert.equal(status.attempt, null);
    assert.deepEqual(status, json(path.join(f.options.outputDir, "collector-status.json")));
    assert.equal(json(path.join(artifact, "public-patrol.json")).availability, "UNAVAILABLE");
    assert.match(fs.readFileSync(path.join(artifact, "index.html"), "utf8"), /FAILED_LEGACY/);
  } finally { global.fetch = originalFetch; }
});

test("latest observation is chosen by workflow start and attempt, not filesystem or arrival time", (t) => {
  const f = fixture(t);
  const older = metadata();
  const newer = metadata({ runId: "222", jobId: "2222", started: "2026-10-30T01:00:00.000Z",
    updated: "2026-10-30T01:01:00.000Z", observedAt: "2026-10-30T03:00:00.000Z", sourceCommit: "b".repeat(40) });
  const first = saveObservation(f, older), second = saveObservation(f, newer);
  fs.utimesSync(first, new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));
  const result = buildCollectorSite({ ...f.options, observationFiles: [second, first] });
  const status = json(path.join(f.options.outputDir, "collector-status.json"));
  assert.equal(status.schemaVersion, 2);
  assert.equal(status.workflowObservation.runId, "222");
  assert.equal(status.workflowObservation.collectorStartedAt, null);
  assert.equal(result.manifest.selectedObservationSha256, newer.contentSha256);
  assert.equal(result.manifest.observationFileCount, 2);
});

test("a newer attempt of the same workflow wins while equal-hash copies are idempotent", (t) => {
  const f = fixture(t);
  const first = metadata(), second = metadata({ runAttempt: 2, jobId: "1112" });
  const files = [saveObservation(f, first), saveObservation(f, second), saveObservation(f, second, "explicit-copy.json")];
  const result = buildCollectorSite({ ...f.options, observationFiles: files });
  assert.equal(result.manifest.selectedObservationSha256, second.contentSha256);
  assert.equal(json(path.join(f.options.outputDir, "collector-status.json")).workflowObservation.runAttempt, 2);
});

test("a lower-ID run with a later-started second attempt wins over a higher-ID run", (t) => {
  const f = fixture(t);
  const lowerFirst = metadata({ runId: "111", runAttempt: 1, started: "2026-10-28T01:00:00.000Z",
    updated: "2026-10-28T01:01:00.000Z" });
  const higher = metadata({ runId: "222", jobId: "2222", sourceCommit: "b".repeat(40) });
  const lowerRetry = metadata({ runId: "111", runAttempt: 2, jobId: "1112", started: "2026-10-30T01:00:00.000Z",
    updated: "2026-10-30T01:01:00.000Z", observedAt: "2026-10-30T03:00:00.000Z" });
  const result = buildCollectorSite({ ...f.options, observationFiles: [saveObservation(f, higher),
    saveObservation(f, lowerRetry), saveObservation(f, lowerFirst)] });
  const selected = json(path.join(f.options.outputDir, "collector-status.json")).workflowObservation;
  assert.equal(selected.runId, "111");
  assert.equal(selected.runAttempt, 2);
  assert.equal(selected.workflowStartedAt, lowerRetry.workflowStartedAt);
  assert.equal(result.manifest.selectedObservationSha256, lowerRetry.contentSha256);
});

test("same workflow identity with altered content is rejected before output creation", (t) => {
  const f = fixture(t), first = metadata(), second = metadata({ jobId: "1112" });
  rejected({ ...f.options, observationFiles: [saveObservation(f, first), saveObservation(f, second, "changed.json")] }, "workflow_observation_conflict");
});

test("ambiguous time and contradictory ordering cannot silently select a workflow", (t) => {
  for (const second of [metadata({ runId: "222", jobId: "2222" }),
    metadata({ runId: "111", runAttempt: 2, jobId: "1112", started: "2026-10-28T01:00:00.000Z", updated: "2026-10-28T01:01:00.000Z" })]) {
    const f = fixture(t);
    rejected({ ...f.options, observationFiles: [saveObservation(f, metadata()), saveObservation(f, second)] }, "workflow_observation_conflict");
  }
});

test("saved observation hashes must already exist and match rather than being manufactured", (t) => {
  for (const mutation of [(record) => { delete record.contentSha256; }, (record) => { record.contentSha256 = "b".repeat(64); },
    (record) => { record.privateNotes = PRIVATE_MARKER; }]) {
    const f = fixture(t), record = metadata(); mutation(record);
    rejected({ ...f.options, observationFiles: [saveObservation(f, record)] }, "invalid_workflow_observation");
  }
});

test("numeric observation filenames must match the record's actual run and attempt", (t) => {
  const f = fixture(t);
  rejected({ ...f.options, observationFiles: [saveObservation(f, metadata(), "222-1.json")] }, "observation_filename_mismatch");
});

test("private or malformed saved summaries and archives fail before any output is created", (t) => {
  for (const target of ["summary", "archive"]) for (const content of ["{broken", Buffer.from([0xff]),
    JSON.stringify({ ...fixtureSummary(), privateReturn: PRIVATE_MARKER }),
    JSON.stringify(fixtureSummary()).replace('"generatedAtJst":', '"generatedAtJst":"hidden","generatedAtJst":')]) {
    const f = fixture(t);
    fs.writeFileSync(target === "summary" ? f.summaryFile : path.join(f.archiveDir, "2026-10-29.json"), content);
    rejected(f.options);
  }
});

function fixtureSummary() {
  return { generatedAt: "2026-10-29T01:00:00.000Z", generatedAtJst: "synthetic", keywords: [], attempts: [],
    totalJobs: null, safeCandidates: null, recommendation: null };
}

test("an invalid date-like archive is rejected without silently dropping it", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.archiveDir, "2026-02-30.json"), f.bytes);
  rejected(f.options, "invalid_archive_date");
});

test("noncanonical patrol data cannot be silently repaired into a public artifact", (t) => {
  for (const input of [{ ...importPublicPatrol(null), privateReturn: PRIVATE_MARKER },
    { kind: "public_patrol", schemaVersion: 1, run: null, scope: { declaredPlatforms: [], unsupportedSources: [] }, sources: [], entries: [] }]) {
    const f = fixture(t), patrolFile = path.join(f.root, "patrol.json"); fs.writeFileSync(patrolFile, JSON.stringify(input));
    rejected({ ...f.options, patrolFile });
  }
  const f = fixture(t), patrolFile = path.join(f.root, "patrol.json");
  fs.writeFileSync(patrolFile, JSON.stringify(importPublicPatrol(null)));
  assert.equal(buildCollectorSite({ ...f.options, patrolFile }).manifest.publicFileCount, 7);
});

test("all input validation finishes before an existing empty output directory is populated", (t) => {
  const f = fixture(t); fs.mkdirSync(f.options.outputDir);
  fs.writeFileSync(path.join(f.archiveDir, "2026-10-28.json"), "invalid");
  assert.throws(() => buildCollectorSite(f.options));
  assert.deepEqual(fs.readdirSync(f.options.outputDir), []);
});

test("output overlap is rejected in both directions without changing inputs", (t) => {
  const f = fixture(t);
  for (const outputDir of [f.root, f.archiveDir, path.join(f.archiveDir, "nested"), f.summaryFile]) {
    assert.throws(() => buildCollectorSite({ ...f.options, outputDir }), { code: "collector_site_paths_overlap" });
    assert.deepEqual(fs.readFileSync(f.summaryFile), f.bytes);
  }
});

test("network, device and drive-relative paths are rejected before filesystem inputs are opened", (t) => {
  const f = fixture(t), original = fs.openSync;
  let opened = 0;
  t.mock.method(fs, "openSync", (...args) => { opened++; return original(...args); });
  for (const summaryFile of ["\\\\synthetic.invalid\\share\\summary.json", "//synthetic.invalid/share/summary.json",
    "\\\\?\\synthetic-device", "https://synthetic.invalid/summary.json", "C:relative-summary.json"]) {
    rejected({ ...f.options, summaryFile }, "invalid_path");
  }
  assert.equal(opened, 0);
});

test("a nonempty destination is preserved rather than overwritten", (t) => {
  const f = fixture(t); fs.mkdirSync(f.options.outputDir);
  fs.writeFileSync(path.join(f.options.outputDir, "old.txt"), PRIVATE_MARKER);
  assert.throws(() => buildCollectorSite(f.options), { code: "collector_site_output_must_be_empty" });
  assert.deepEqual(fs.readdirSync(f.options.outputDir), ["old.txt"]);
  assert.equal(fs.readFileSync(path.join(f.options.outputDir, "old.txt"), "utf8"), PRIVATE_MARKER);
});

test("symbolic file or ancestor metadata fails closed without requiring link privileges", (t) => {
  const f = fixture(t), original = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (target, ...args) => path.resolve(target) === f.summaryFile
    ? { isSymbolicLink: () => true } : original(target, ...args));
  rejected(f.options, "unsafe_path");
});

test("a file changing while its descriptor is read is rejected before output creation", (t) => {
  const f = fixture(t), original = fs.fstatSync;
  let calls = 0;
  t.mock.method(fs, "fstatSync", (...args) => {
    const result = original(...args); calls++;
    return calls === 2 ? { ...result, mtimeMs: result.mtimeMs + 1 } : result;
  });
  rejected(f.options, "input_changed");
});

test("the composer receives frozen input snapshots rather than rereading source files", (t) => {
  const f = fixture(t), original = fs.openSync;
  const reads = [];
  t.mock.method(fs, "openSync", (file, ...args) => { reads.push(path.resolve(file)); return original(file, ...args); });
  buildCollectorSite(f.options);
  assert.equal(reads.filter((file) => file === f.summaryFile).length, 1);
  assert.equal(reads.filter((file) => file === path.join(f.archiveDir, "2026-10-29.json")).length, 1);
});

test("only explicit inputs are used and no implicit clock or network operation is needed", (t) => {
  const f = fixture(t), originalFetch = global.fetch, originalNow = Date.now;
  try {
    global.fetch = () => { throw new Error("unexpected network operation"); };
    Date.now = () => { throw new Error("unexpected clock operation"); };
    assert.equal(buildCollectorSite(f.options).status, "collector_site_built");
  } finally { global.fetch = originalFetch; Date.now = originalNow; }
  for (const file of Object.keys(require.cache)) assert.doesNotMatch(file.replace(/\\/g, "/"), /\/src\/(?:daily|scraper)\.js$/);
});

test("invalid options, getters, duplicate paths and unknown clocks cannot create output", (t) => {
  for (const extra of [{ asOf: "invalid" }, { asOf: null }, { privateReturn: PRIVATE_MARKER }, { observationFiles: null }]) {
    const f = fixture(t); rejected({ ...f.options, ...extra });
  }
  const f = fixture(t); let reads = 0;
  const options = { ...f.options }; Object.defineProperty(options, "patrolFile", { get() { reads++; throw PRIVATE_MARKER; } });
  rejected(options, "invalid_options"); assert.equal(reads, 0);
  const recordFile = saveObservation(f, metadata());
  rejected({ ...f.options, observationFiles: [recordFile, recordFile] }, "duplicate_input_path");
});

test("CLI reads only valid top-level observation names and prints a path-free manifest", (t) => {
  const f = fixture(t); saveObservation(f, metadata());
  fs.writeFileSync(path.join(f.observations, "private.json"), PRIVATE_MARKER);
  fs.writeFileSync(path.join(f.observations, "111-0.json"), PRIVATE_MARKER);
  fs.mkdirSync(path.join(f.observations, "nested"));
  fs.writeFileSync(path.join(f.observations, "nested", "222-1.json"), PRIVATE_MARKER);
  const result = spawnSync(process.execPath, [path.join(__dirname, "../src/build-collector-site.js"),
    "--summary", f.summaryFile, "--archives", f.archiveDir, "--observations", f.observations,
    "--output", f.options.outputDir, "--as-of", AS_OF], { encoding: "utf8" });
  assert.equal(result.error, undefined); assert.equal(result.status, 0); assert.equal(result.stderr, "");
  const data = JSON.parse(result.stdout);
  assert.equal(data.manifest.observationFileCount, 1);
  assert.equal(data.manifest.publicFileCount, 7);
  assert.doesNotMatch(result.stdout, /SYNTHETIC_PRIVATE_MARKER|[A-Z]:\\|\/tmp\//);
});

test("CLI rejects observation-directory overlap and emits only a fixed failure code", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [path.join(__dirname, "../src/build-collector-site.js"),
    "--summary", f.summaryFile, "--observations", f.observations, "--output", path.join(f.observations, "site"),
    "--as-of", AS_OF], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "collector_site_build_failed");
  assert.deepEqual(fs.readdirSync(f.observations), []);
});
