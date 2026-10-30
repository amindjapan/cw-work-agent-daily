"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createReconstructionManifest, verifyReconstructedBaseline } = require("../src/reconstructed-baseline");
const { buildCollectorOverview, renderCollectorOverview } = require("../src/collector-overview");
const { prepareCollectorOverview } = require("../src/prepare-collector-overview");
const { preparePublicArtifact, overviewMarkdown } = require("../src/prepare-public-artifact");
const { buildCollectorSite } = require("../src/build-collector-site");
const { importWorkflowObservation } = require("../src/workflow-observation");

const AS_OF = "2026-10-30T05:00:00.000Z", RECONSTRUCTED_AT = "2026-10-30T04:30:00.000Z";
const ROOTS = ["index.html", "latest.json", "latest.md", ".nojekyll", "collector-status.json", "public-patrol.json"];
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const blob = (bytes) => crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const summary = { generatedAt: "2026-10-29T01:00:00.000Z", generatedAtJst: "synthetic saved start",
  keywords: ["synthetic"], attempts: [{ keyword: "synthetic", ok: false, status: 403, imported: null, error: "fetch_failed" }],
  totalJobs: null, safeCandidates: null, recommendation: null };
const SUMMARY_BYTES = Buffer.from(`${JSON.stringify(summary, null, 2)}\n`);

function observation() {
  const runId = "123", jobId = "1234", runUrl = `https://github.com/amindjapan/cw-work-agent-daily/actions/runs/${runId}`;
  return importWorkflowObservation({ kind: "workflow_observation", schemaVersion: 1,
    repository: "amindjapan/cw-work-agent-daily", workflowPath: ".github/workflows/daily.yml", runId, runAttempt: 1, jobId,
    sourceCommit: "a".repeat(40), runUrl, jobUrl: `${runUrl}/job/${jobId}`,
    workflowStartedAt: "2026-10-30T01:00:00.000Z", workflowUpdatedAt: "2026-10-30T01:01:00.000Z",
    observedAt: "2026-10-30T02:00:00.000Z", collectorStartedAt: null, collectorFinishedAt: null, diagnosticLoggedAt: null,
    diagnostics: { kind: "collector_diagnostics", schemaVersion: 1, aborted: true,
      search: { planned: 13, attempted: 1, succeeded: 0, failed: 1, notAttempted: 12 },
      details: { observed: 0, attempted: 0, succeeded: 0, failed: 0, notAttempted: 0 },
      events: [{ stage: "search", httpStatus: 403, reason: "access_denied" }] },
    stepResults: { tests: "SUCCEEDED", collection: "FAILED", snapshot: "SKIPPED", repositoryPersistence: "SKIPPED", publication: "SKIPPED" } });
}

function manifest({ archives = [], latestBytes = SUMMARY_BYTES, ...overrides } = {}) {
  const jsonInputs = [{ path: "latest.json", bytes: latestBytes }, ...archives];
  const files = [...ROOTS.map((name) => ({ path: name,
    bytes: name === "latest.json" ? latestBytes : name === ".nojekyll" ? Buffer.alloc(0) : Buffer.from(`synthetic-${name}`) })), ...archives];
  return createReconstructionManifest({ kind: "collector_git_reconstruction", schemaVersion: 1,
    repository: "amindjapan/cw-work-agent-daily", inputCommit: "b".repeat(40), sourceCodeBaseCommit: "c".repeat(40),
    reconstructedAt: RECONSTRUCTED_AT,
    originalArtifact: { runId: "100", runAttempt: 1, artifactName: "github-pages", artifactId: "200",
      availability: "UNAVAILABLE", exactMatch: "NOT_VERIFIED" },
    missingMaterial: ["ORIGINAL_ARTIFACT_BYTES", "ORIGINAL_DELIVERY_FILE_HASHES", "ORIGINAL_COLLECTOR_TIMESTAMPS"],
    sourceInputs: jsonInputs.map((input) => ({ repositoryPath: input.path === "latest.json" ? "collector-data/latest.json"
      : `collector-data/${input.path.slice("archive/".length)}`, baselinePath: input.path,
    gitBlobSha: blob(input.bytes), bytes: input.bytes.length, sha256: digest(input.bytes) })),
    files: files.map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: digest(file.bytes) })), ...overrides });
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-reconstruction-view-synthetic-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const summaryFile = path.join(dir, "summary.json"), archiveDir = path.join(dir, "saved"), observationFile = path.join(dir, "123-1.json");
  fs.writeFileSync(summaryFile, SUMMARY_BYTES);
  fs.mkdirSync(archiveDir);
  fs.writeFileSync(path.join(archiveDir, "2026-10-29.json"), SUMMARY_BYTES);
  fs.writeFileSync(observationFile, JSON.stringify(observation()));
  const reconstructionFile = path.join(dir, "manifest.json");
  const record = manifest({ archives: [{ path: "archive/2026-10-29.json", bytes: SUMMARY_BYTES }] });
  fs.writeFileSync(reconstructionFile, `${JSON.stringify(record, null, 2)}\n`);
  return { dir, record, reconstructionFile, summaryFile, archiveDir,
    options: { summaryFile, archiveDir, observationFiles: [observationFile], reconstructionFile,
      outputDir: path.join(dir, "site"), asOf: AS_OF } };
}

function finalizedBaseline(f) {
  buildCollectorSite(f.options);
  const body = { ...f.record, files: f.record.files.map((file) => {
    const bytes = fs.readFileSync(path.join(f.options.outputDir, ...file.path.split("/")));
    return { path: file.path, bytes: bytes.length, sha256: digest(bytes) };
  }) };
  delete body.contentSha256;
  const record = createReconstructionManifest(body);
  fs.writeFileSync(f.reconstructionFile, `${JSON.stringify(record, null, 2)}\n`);
  const directory = path.join(f.dir, "baseline-final");
  buildCollectorSite({ ...f.options, outputDir: directory });
  verifyReconstructedBaseline({ directory, manifestFile: f.reconstructionFile });
  return { directory, record };
}

function currentBytes() {
  const started = "2026-10-31T01:00:00.000Z", finished = "2026-10-31T01:01:00.000Z";
  return Buffer.from(`${JSON.stringify({ generatedAt: started, generatedAtJst: "synthetic current start",
    keywords: ["synthetic"], attempts: [{ keyword: "synthetic", ok: true, status: 200, imported: 0 }],
    totalJobs: 0, safeCandidates: 0, recommendation: null,
    collection: { schemaVersion: 1, status: "attempts_completed", startedAt: started, attemptsCompletedAt: finished,
      decisionAsOf: started, search: { planned: 1, attempted: 1, succeeded: 1, failed: 0, notAttempted: 0 },
      details: { observed: 0, attempted: 0, succeeded: 0, failed: 0, notAttempted: 0 },
      candidates: { machine: 0, detailConfirmed: 0, detailUnconfirmed: 0 } } }, null, 2)}\n`);
}

test("the reconstruction badge reports only explicit Git inputs without claiming old delivery identity or collection success", (t) => {
  const record = manifest();
  t.mock.method(global, "fetch", () => { throw new Error("unexpected_network"); });
  t.mock.method(Date, "now", () => { throw new Error("unexpected_clock"); });
  const view = buildCollectorOverview({ savedSummary: summary, workflowObservation: observation(), reconstruction: record, asOf: AS_OF });
  assert.equal(view.savedMaterial.status, "FAILED_LEGACY");
  assert.equal(view.lastAttempt.startedAt, null);
  assert.equal(view.lastAttempt.finishedAt, null);
  assert.equal(view.lastAttempt.repositoryPersistence, "SKIPPED");
  assert.equal(view.lastAttempt.publication, "SKIPPED");
  assert.equal(view.lastVerifiedSuccess.status, "UNKNOWN");
  assert.equal(view.patrol.availability, "UNAVAILABLE");
  for (const rendered of [renderCollectorOverview(view), overviewMarkdown(view)]) {
    assert.match(rendered, /Git保存資料からの再構成/);
    assert.match(rendered, /当時の配信物との完全一致は未検証/);
    assert.match(rendered, new RegExp(record.inputCommit));
    assert.match(rendered, new RegExp(record.sourceCodeBaseCommit));
    assert.match(rendered, new RegExp(record.reconstructedAt));
    assert.match(rendered, new RegExp(record.sourceInputs[0].sha256));
    assert.match(rendered, /ORIGINAL_ARTIFACT_BYTES/);
    assert.doesNotMatch(rendered, new RegExp(record.contentSha256));
    assert.doesNotMatch(rendered, new RegExp(record.files.find((file) => file.path === "index.html").sha256));
  }
});

test("updating generated-file hashes and the manifest self-hash cannot change HTML or Markdown bytes", () => {
  const first = manifest();
  const body = { ...first, files: first.files.map((file) => ["index.html", "latest.md"].includes(file.path)
    ? { ...file, bytes: file.bytes + 1, sha256: "d".repeat(64) } : file) };
  delete body.contentSha256;
  const final = createReconstructionManifest(body);
  assert.notEqual(first.contentSha256, final.contentSha256);
  const input = { savedSummary: summary, workflowObservation: observation(), asOf: AS_OF };
  const a = buildCollectorOverview({ ...input, reconstruction: first }), b = buildCollectorOverview({ ...input, reconstruction: final });
  assert.equal(renderCollectorOverview(a), renderCollectorOverview(b));
  assert.equal(overviewMarkdown(a), overviewMarkdown(b));
});

test("a future or altered reconstruction record fails before a new overview directory is created", (t) => {
  const f = fixture(t);
  assert.throws(() => buildCollectorOverview({ reconstruction: manifest({ reconstructedAt: "2099-01-01T00:00:00.000Z" }), asOf: AS_OF }));
  for (const reconstruction of [{ ...f.record, privateNotes: "SYNTHETIC_PRIVATE" }, { ...f.record, inputCommit: "d".repeat(40) }]) {
    const outputDir = path.join(f.dir, `invalid-${Object.keys(reconstruction).length}`);
    assert.throws(() => prepareCollectorOverview({ summaryBytes: SUMMARY_BYTES, reconstruction, outputDir, asOf: AS_OF }));
    assert.equal(fs.existsSync(outputDir), false);
  }
});

test("composer verifies the actual saved JSON SHA256, byte count and Git blob identity", (t) => {
  const f = fixture(t), changed = Buffer.from(`${SUMMARY_BYTES.toString()} `);
  assert.throws(() => prepareCollectorOverview({ summaryBytes: SUMMARY_BYTES, reconstruction: manifest({ latestBytes: changed }),
    outputDir: f.options.outputDir, asOf: AS_OF }), /overview_reconstruction_source_mismatch/);
  assert.equal(fs.existsSync(f.options.outputDir), false);
});

test("builder reads the reconstruction once and adds only its explicit mirror while preserving every Git JSON byte", (t) => {
  const f = fixture(t), opened = fs.openSync;
  let reads = 0;
  t.mock.method(fs, "openSync", (file, ...args) => { if (file === f.reconstructionFile) reads++; return opened(file, ...args); });
  const result = buildCollectorSite(f.options);
  assert.equal(reads, 1);
  assert.equal(result.manifest.publicFileCount, 8);
  assert.equal(result.manifest.archiveCount, 1);
  assert.equal(result.files.includes("reconstruction.json"), true);
  assert.deepEqual(fs.readFileSync(path.join(f.options.outputDir, "latest.json")), SUMMARY_BYTES);
  assert.deepEqual(fs.readFileSync(path.join(f.options.outputDir, "archive", "2026-10-29.json")), SUMMARY_BYTES);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.options.outputDir, "reconstruction.json"), "utf8")), f.record);
});

test("builder rejects mismatching source identities and an incomplete reconstruction input set before output", (t) => {
  for (const mode of ["git_blob", "archive_set", "future"]) {
    const f = fixture(t);
    let record = f.record;
    if (mode === "archive_set") record = manifest();
    else {
      const body = { ...record };
      delete body.contentSha256;
      if (mode === "git_blob") body.sourceInputs = body.sourceInputs.map((item) => ({ ...item, gitBlobSha: "f".repeat(40) }));
      else body.reconstructedAt = "2099-01-01T00:00:00.000Z";
      record = createReconstructionManifest(body);
    }
    fs.writeFileSync(f.reconstructionFile, JSON.stringify(record));
    assert.throws(() => buildCollectorSite(f.options), /collector_site_reconstruction_/);
    assert.equal(fs.existsSync(f.options.outputDir), false);
  }
});

test("only overview staging exports a strictly projected reconstruction mirror and rebuilds its badge", (t) => {
  const f = fixture(t);
  buildCollectorSite(f.options);
  const ordinary = preparePublicArtifact({ sourceDir: f.options.outputDir, outputDir: path.join(f.dir, "ordinary") });
  assert.equal(ordinary.copiedFiles.includes("reconstruction.json"), false);
  fs.writeFileSync(path.join(f.options.outputDir, "index.html"), "<script>untrusted()</script>");
  const outputDir = path.join(f.dir, "public");
  const selected = preparePublicArtifact({ sourceDir: f.options.outputDir, outputDir, includeOverview: true });
  assert.equal(selected.copiedFiles.includes("reconstruction.json"), true);
  const html = fs.readFileSync(path.join(outputDir, "index.html"), "utf8");
  assert.match(html, /Git保存資料からの再構成/);
  assert.doesNotMatch(html, /<script|untrusted\(/);
  const bad = { ...f.record, hiddenPrivateField: "SYNTHETIC_PRIVATE" };
  fs.writeFileSync(path.join(f.options.outputDir, "reconstruction.json"), JSON.stringify(bad));
  const rejected = path.join(f.dir, "rejected");
  assert.throws(() => preparePublicArtifact({ sourceDir: f.options.outputDir, outputDir: rejected, includeOverview: true }));
  assert.equal(fs.existsSync(rejected), false);
});

test("the placeholder, badge, final-hash and final-verification sequence has no manifest self-reference", (t) => {
  const f = fixture(t);
  buildCollectorSite(f.options);
  const body = { ...f.record, files: f.record.files.map((file) => {
    const bytes = fs.readFileSync(path.join(f.options.outputDir, ...file.path.split("/")));
    return { path: file.path, bytes: bytes.length, sha256: digest(bytes) };
  }) };
  delete body.contentSha256;
  const final = createReconstructionManifest(body);
  fs.writeFileSync(f.reconstructionFile, `${JSON.stringify(final, null, 2)}\n`);
  const second = path.join(f.dir, "final");
  buildCollectorSite({ ...f.options, outputDir: second });
  for (const name of ["index.html", "latest.md"]) {
    assert.deepEqual(fs.readFileSync(path.join(second, name)), fs.readFileSync(path.join(f.options.outputDir, name)));
  }
  verifyReconstructedBaseline({ directory: second, manifestFile: f.reconstructionFile });
  const publishedDirectory = path.join(f.dir, "published");
  preparePublicArtifact({ sourceDir: second, outputDir: publishedDirectory, includeOverview: true });
  verifyReconstructedBaseline({ directory: second, manifestFile: f.reconstructionFile, publishedDirectory, mode: "status-only" });
});

test("the builder CLI accepts only an explicit local reconstruction file and performs no collection", (t) => {
  const f = fixture(t), preload = path.join(f.dir, "deny-network.cjs");
  fs.writeFileSync(preload, 'global.fetch = () => { throw new Error("unexpected_network"); };\n');
  const result = spawnSync(process.execPath, ["--require", preload, path.join(__dirname, "../src/build-collector-site.js"),
    "--summary", f.summaryFile, "--archives", f.archiveDir, "--reconstruction", f.reconstructionFile,
    "--output", f.options.outputDir, "--as-of", AS_OF], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).manifest.publicFileCount, 8);
  assert.equal(result.stderr, "");
});

test("an injected reconstruction mirror cannot be overwritten after output validation", (t) => {
  const f = fixture(t), mkdir = fs.mkdirSync, write = fs.writeFileSync;
  let inserted = false;
  t.mock.method(fs, "mkdirSync", (directory, ...args) => {
    const result = mkdir(directory, ...args);
    if (!inserted && path.resolve(directory) === f.options.outputDir) {
      inserted = true;
      write(path.join(f.options.outputDir, "reconstruction.json"), "SYNTHETIC_COMPETING_MANIFEST", { flag: "wx" });
    }
    return result;
  });
  assert.throws(() => prepareCollectorOverview({ summaryBytes: SUMMARY_BYTES, reconstruction: f.record,
    outputDir: f.options.outputDir, asOf: AS_OF }), { code: "EEXIST" });
  assert.equal(fs.readFileSync(path.join(f.options.outputDir, "reconstruction.json"), "utf8"), "SYNTHETIC_COMPETING_MANIFEST");
});

test("daily mode updates current latest and adds a date while preserving the separate reconstructed baseline", (t) => {
  const f = fixture(t), baseline = finalizedBaseline(f), bytes = currentBytes();
  const summaryFile = path.join(f.dir, "current.json");
  fs.writeFileSync(summaryFile, bytes);
  fs.writeFileSync(path.join(f.archiveDir, "2026-10-31.json"), bytes);
  const outputDir = path.join(f.dir, "daily"), publishedDirectory = path.join(f.dir, "daily-public");
  const options = { ...f.options, summaryFile, outputDir, asOf: "2026-10-31T05:00:00.000Z", reconstructionMode: "daily" };
  buildCollectorSite(options);
  preparePublicArtifact({ sourceDir: outputDir, outputDir: publishedDirectory, includeOverview: true });
  const verified = verifyReconstructedBaseline({ directory: baseline.directory, manifestFile: f.reconstructionFile,
    publishedDirectory, mode: "daily" });
  assert.equal(verified.publishedPreservation.latestPreserved, false);
  assert.equal(verified.publishedPreservation.preservedArchiveCount, 1);
  assert.deepEqual(fs.readFileSync(path.join(publishedDirectory, "latest.json")), bytes);
  assert.deepEqual(fs.readFileSync(path.join(publishedDirectory, "archive", "2026-10-29.json")), SUMMARY_BYTES);
  assert.deepEqual(fs.readFileSync(path.join(publishedDirectory, "archive", "2026-10-31.json")), bytes);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(publishedDirectory, "reconstruction.json"), "utf8")), baseline.record);
  for (const name of ["index.html", "latest.md"]) {
    const text = fs.readFileSync(path.join(publishedDirectory, name), "utf8");
    assert.match(text, /復元基準：Git保存資料からの再構成/);
    assert.match(text, /最新保存資料・表示時刻とは分離/);
    assert.match(text, /同じ inputCommit に由来するという認定ではありません/);
    assert.match(text, new RegExp(baseline.record.sourceInputs.find((source) => source.baselinePath === "latest.json").sha256));
    assert.doesNotMatch(text, new RegExp(digest(bytes)));
  }
  const currentStatus = JSON.parse(fs.readFileSync(path.join(publishedDirectory, "collector-status.json"), "utf8"));
  assert.equal(currentStatus.workflowObservation.stepResults.repositoryPersistence, "SKIPPED");
  assert.throws(() => verifyReconstructedBaseline({ directory: baseline.directory, manifestFile: f.reconstructionFile,
    publishedDirectory, mode: "status-only" }));
  const rejected = path.join(f.dir, "status-only-rejected");
  assert.throws(() => buildCollectorSite({ ...options, outputDir: rejected, reconstructionMode: "status-only" }), /reconstruction_source_mismatch/);
  assert.equal(fs.existsSync(rejected), false);
  fs.writeFileSync(path.join(publishedDirectory, "archive", "2026-10-29.json"), Buffer.from(`${SUMMARY_BYTES.toString()} `));
  assert.throws(() => verifyReconstructedBaseline({ directory: baseline.directory, manifestFile: f.reconstructionFile,
    publishedDirectory, mode: "daily" }), /byte_mismatch/);
});

test("status-only defaults reject changed current latest even when the archive set is unchanged", (t) => {
  const f = fixture(t), summaryFile = path.join(f.dir, "current.json");
  fs.writeFileSync(summaryFile, currentBytes());
  assert.throws(() => buildCollectorSite({ ...f.options, summaryFile }), /reconstruction_source_mismatch/);
  assert.equal(fs.existsSync(f.options.outputDir), false);
  assert.throws(() => prepareCollectorOverview({ summaryBytes: currentBytes(), reconstruction: f.record,
    outputDir: path.join(f.dir, "composed"), asOf: "2026-10-31T05:00:00.000Z" }), /overview_reconstruction_source_mismatch/);
});

test("daily mode cannot change or drop any archive from the retained reconstruction", (t) => {
  for (const operation of ["change", "remove"]) {
    const f = fixture(t), target = path.join(f.archiveDir, "2026-10-29.json");
    if (operation === "change") fs.writeFileSync(target, Buffer.from(`${SUMMARY_BYTES.toString()} `));
    else fs.unlinkSync(target);
    assert.throws(() => buildCollectorSite({ ...f.options, reconstructionMode: "daily" }), /reconstruction_source_mismatch/);
    assert.equal(fs.existsSync(f.options.outputDir), false);
  }
});

test("builder and composer CLIs accept an explicit daily reconstruction mode without collecting", (t) => {
  const f = fixture(t), summaryFile = path.join(f.dir, "current.json"), preload = path.join(f.dir, "deny-mode-network.cjs");
  fs.writeFileSync(summaryFile, currentBytes());
  fs.writeFileSync(preload, 'global.fetch = () => { throw new Error("unexpected_network"); };\n');
  for (const [script, output] of [["build-collector-site.js", "cli-daily"], ["prepare-collector-overview.js", "cli-composed"]]) {
    const outputDir = path.join(f.dir, output);
    const args = ["--require", preload, path.join(__dirname, `../src/${script}`), "--summary", summaryFile,
      "--reconstruction", f.reconstructionFile, "--reconstruction-mode", "daily", "--output", outputDir,
      "--as-of", "2026-10-31T05:00:00.000Z"];
    if (script === "build-collector-site.js") args.push("--archives", f.archiveDir);
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(path.join(outputDir, "latest.json")), currentBytes());
    assert.equal(result.stderr, "");
  }
});

test("unknown reconstruction modes and duplicate manifest inputs are rejected before output", (t) => {
  const f = fixture(t);
  for (const reconstructionMode of [null, "unknown", true]) {
    assert.throws(() => buildCollectorSite({ ...f.options, reconstructionMode }), /invalid_reconstruction_mode/);
    assert.throws(() => prepareCollectorOverview({ summaryBytes: SUMMARY_BYTES, reconstruction: f.record, reconstructionMode,
      outputDir: f.options.outputDir, asOf: AS_OF }), /overview_invalid_reconstruction_mode/);
    assert.equal(fs.existsSync(f.options.outputDir), false);
  }
  assert.throws(() => prepareCollectorOverview({ summaryBytes: SUMMARY_BYTES, reconstructionFile: f.reconstructionFile,
    reconstruction: f.record, outputDir: f.options.outputDir, asOf: AS_OF }), /overview_ambiguous_input/);
});
