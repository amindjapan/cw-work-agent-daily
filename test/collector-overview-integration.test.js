"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { prepareCollectorOverview } = require("../src/prepare-collector-overview");
const { preparePublicArtifact, projectCollectorStatus } = require("../src/prepare-public-artifact");
const { createAttempt, finishAttempt } = require("../src/collector-attempt");

const START = "2026-10-30T01:59:30.000Z", END = "2026-10-30T01:59:40.000Z", AS_OF = "2026-10-30T02:00:00.000Z";
const PRIVATE = "SYNTHETIC_PRIVATE@example.invalid";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-overview-integration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const summaryFile = path.join(dir, "summary.json");
  const summary = { generatedAt: "2026-10-29T01:50:50.000Z", generatedAtJst: "2026/10/29 10:50",
    keywords: Array(13).fill("synthetic"), attempts: Array.from({ length: 13 }, () => ({ keyword: "synthetic", ok: false,
      status: 403, imported: null, error: "fetch_failed" })), totalJobs: null, safeCandidates: null, recommendation: null };
  fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
  return { dir, summaryFile, summary, outputDir: path.join(dir, "site"), asOf: AS_OF };
}

function attempt() {
  const begun = createAttempt({ runId: "local-11111111-1111-4111-8111-111111111111", runAttempt: 1,
    sourceCommit: "a".repeat(40), workflowPath: "local", startedAt: START });
  return finishAttempt(begun, { finishedAt: END, collectionState: "ABORTED", reasonCode: "collection_aborted",
    localPersistence: "NOT_ATTEMPTED", repositoryPersistence: "NOT_ATTEMPTED", publication: "NOT_ATTEMPTED",
    diagnostics: { kind: "collector_diagnostics", schemaVersion: 1, aborted: true,
      search: { planned: 13, attempted: 1, succeeded: 0, failed: 1, notAttempted: 12 },
      details: { observed: 0, attempted: 0, succeeded: 0, failed: 0, notAttempted: 0 },
      events: [{ stage: "search", httpStatus: 403, reason: "access_denied" }] } });
}

function patrol() {
  return { kind: "public_patrol", schemaVersion: 1,
    run: { patrolRunId: "22222222-2222-4222-8222-222222222222", startedAt: START, attemptsCompletedAt: END,
      decisionAsOf: START, status: "COMPLETED" }, scope: { declaredPlatforms: ["crowdworks", "lancers"], unsupportedSources: ["lancers"] },
    sources: [{ sourceId: 1, platform: "crowdworks", sourceKind: "PUBLIC_SEARCH", availability: "AVAILABLE",
      url: "https://crowdworks.jp/public/jobs/search", scopeId: `scope-${"a".repeat(64)}` },
    { sourceId: 2, platform: "lancers", sourceKind: "PUBLIC_PLATFORM", availability: "UNAVAILABLE" }],
    entries: [{ platform: "crowdworks", jobId: "123", url: "https://crowdworks.jp/public/jobs/123",
      observations: [{ sourceId: 1, observedAt: END, level: "SEARCH_SUMMARY" }] }] };
}

test("offline composition separates failed saved material, missing attempt, unknown success and unavailable patrol", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.summaryFile);
  const fetch = t.mock.method(global, "fetch", () => { throw new Error("network_forbidden"); });
  const result = prepareCollectorOverview(f);
  assert.equal(result.view.savedMaterial.status, "FAILED_LEGACY");
  assert.equal(result.view.lastAttempt.availability, "UNAVAILABLE");
  assert.equal(result.view.lastVerifiedSuccess.status, "UNKNOWN");
  assert.equal(result.view.patrol.availability, "UNAVAILABLE");
  assert.equal(result.view.patrol.counts.uniqueJobs, null);
  assert.equal(fetch.mock.calls.length, 0);
  assert.deepEqual(fs.readFileSync(f.summaryFile), before);
  assert.deepEqual(fs.readFileSync(path.join(f.outputDir, "latest.json")), before);
  const html = fs.readFileSync(path.join(f.outputDir, "index.html"), "utf8");
  assert.match(html, /FAILED_LEGACY/);
  assert.match(html, /UNAVAILABLE/);
  assert.doesNotMatch(html, /<script\b|<iframe\b|<img\b|<link\b|url\s*\(|fetch\s*\(/i);
});

test("explicit attempt and limited patrol compose with public citations and fixed UNKNOWN gates", (t) => {
  const f = fixture(t);
  f.attemptFile = path.join(f.dir, "attempt.json");
  f.patrolFile = path.join(f.dir, "patrol.json");
  fs.writeFileSync(f.attemptFile, JSON.stringify(attempt()));
  fs.writeFileSync(f.patrolFile, JSON.stringify(patrol()));
  const before = [f.summaryFile, f.attemptFile, f.patrolFile].map((p) => fs.readFileSync(p));
  const result = prepareCollectorOverview(f);
  assert.equal(result.view.lastAttempt.reportedState, "ABORTED");
  assert.equal(result.view.lastAttempt.diagnostics.search.notAttempted, 12);
  assert.equal(result.view.patrol.availability, "LIMITED");
  assert.deepEqual(result.view.patrol.scope.unsupportedSources, ["lancers"]);
  assert.equal(result.view.displayJobs.length, 1);
  assert.equal(result.view.displayJobs[0].origins[0].decision, "STOP_REQUIRED");
  for (const [index, file] of [f.summaryFile, f.attemptFile, f.patrolFile].entries()) assert.deepEqual(fs.readFileSync(file), before[index]);
  const html = fs.readFileSync(path.join(f.outputDir, "index.html"), "utf8");
  assert.match(html, /access_denied/);
  assert.match(html, /https:\/\/crowdworks\.jp\/public\/jobs\/search/);
  assert.match(html, /lancers/);
  assert.match(html, /STOP_REQUIRED/);
});

test("overview JSON files require explicit staging opt-in and strict projection", (t) => {
  const f = fixture(t);
  prepareCollectorOverview(f);
  const normal = preparePublicArtifact({ sourceDir: f.outputDir, outputDir: path.join(f.dir, "normal") });
  assert.equal(normal.copiedFiles.includes("collector-status.json"), false);
  assert.equal(normal.copiedFiles.includes("public-patrol.json"), false);
  const selected = preparePublicArtifact({ sourceDir: f.outputDir, outputDir: path.join(f.dir, "selected"), includeOverview: true });
  assert.equal(selected.copiedFiles.length, 6);
  const file = path.join(f.outputDir, "collector-status.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.applicationHistory = PRIVATE;
  fs.writeFileSync(file, JSON.stringify(data));
  const outputDir = path.join(f.dir, "rejected");
  assert.throws(() => preparePublicArtifact({ sourceDir: f.outputDir, outputDir, includeOverview: true }));
  assert.equal(fs.existsSync(outputDir), false);
});

test("overview staging rebuilds HTML, Markdown and marker from projected inputs only", (t) => {
  const f = fixture(t);
  prepareCollectorOverview(f);
  fs.writeFileSync(path.join(f.outputDir, "index.html"), `<script>fetch('https://example.invalid')</script>${PRIVATE}`);
  fs.writeFileSync(path.join(f.outputDir, "latest.md"), PRIVATE);
  fs.writeFileSync(path.join(f.outputDir, ".nojekyll"), PRIVATE);
  const outputDir = path.join(f.dir, "safe");
  preparePublicArtifact({ sourceDir: f.outputDir, outputDir, includeOverview: true });
  for (const name of ["index.html", "latest.md", ".nojekyll"]) {
    const content = fs.readFileSync(path.join(outputDir, name), "utf8");
    assert.doesNotMatch(content, /SYNTHETIC_PRIVATE|example.invalid|<script\b|fetch\(/);
  }
});

test("partial staging write failure leaves original inputs intact and cannot pass staging validation", (t) => {
  const f = fixture(t);
  const original = fs.readFileSync(f.summaryFile);
  const write = fs.writeFileSync;
  const mock = t.mock.method(fs, "writeFileSync", (file, ...args) => {
    if (file === path.join(f.outputDir, "index.html")) throw new Error(PRIVATE);
    return write(file, ...args);
  });
  assert.throws(() => prepareCollectorOverview(f));
  mock.mock.restore();
  assert.deepEqual(fs.readFileSync(f.summaryFile), original);
  const selected = path.join(f.dir, "unsafe");
  assert.throws(() => preparePublicArtifact({ sourceDir: f.outputDir, outputDir: selected, includeOverview: true }));
  assert.equal(fs.existsSync(selected), false);
});

test("input mutation, missing file, unknown private data and duplicate JSON keys fail before output", (t) => {
  for (const mode of ["summary_private", "attempt_private", "patrol_private", "duplicate", "hash", "missing", "utf8"]) {
    const f = fixture(t);
    if (mode === "summary_private") fs.writeFileSync(f.summaryFile, JSON.stringify({ ...f.summary, internalMemo: PRIVATE }));
    if (mode === "attempt_private" || mode === "hash") {
      const data = attempt();
      if (mode === "attempt_private") data.returnBody = PRIVATE; else data.sourceCommit = "b".repeat(40);
      f.attemptFile = path.join(f.dir, "attempt.json");
      fs.writeFileSync(f.attemptFile, JSON.stringify(data));
    }
    if (mode === "patrol_private") {
      const data = patrol(); data.entries[0].observations[0].privateMemo = PRIVATE;
      f.patrolFile = path.join(f.dir, "patrol.json"); fs.writeFileSync(f.patrolFile, JSON.stringify(data));
    }
    if (mode === "duplicate") fs.writeFileSync(f.summaryFile, '{"generatedAt":"old","generatedAt":"new"}');
    if (mode === "missing") f.patrolFile = path.join(f.dir, "missing.json");
    if (mode === "utf8") fs.writeFileSync(f.summaryFile, Buffer.from([0xff, 0xfe]));
    assert.throws(() => prepareCollectorOverview(f));
    assert.equal(fs.existsSync(f.outputDir), false);
  }
});

test("an existing nonempty output or input overlap is never replaced", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.outputDir);
  fs.writeFileSync(path.join(f.outputDir, "previous"), "preserved");
  assert.throws(() => prepareCollectorOverview(f));
  assert.equal(fs.readFileSync(path.join(f.outputDir, "previous"), "utf8"), "preserved");
  assert.throws(() => prepareCollectorOverview({ ...f, outputDir: f.dir }));
});

test("public status projection refuses Proxy input before any user trap", () => {
  let traps = 0;
  const input = new Proxy({}, { getPrototypeOf() { traps++; throw new Error(PRIVATE); },
    ownKeys() { traps++; throw new Error(PRIVATE); }, get() { traps++; throw new Error(PRIVATE); } });
  assert.throws(() => projectCollectorStatus(input), /invalid_collector_status/);
  assert.equal(traps, 0);
});

test("the real composition CLI is offline and emits no input content on rejection", (t) => {
  const f = fixture(t);
  const preload = path.join(f.dir, "deny-network.cjs");
  fs.writeFileSync(preload, 'global.fetch = async () => { throw new Error("network_forbidden"); };\n');
  const args = ["--require", preload, path.join(__dirname, "../src/prepare-collector-overview.js"),
    "--summary", f.summaryFile, "--output", f.outputDir, "--as-of", f.asOf];
  let result = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).status, "overview_prepared");
  assert.equal(result.stderr, "");
  fs.writeFileSync(f.summaryFile, PRIVATE);
  result = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "collector_overview_failed");
  assert.doesNotMatch(result.stderr, /PRIVATE|example|[A-Z]:\\/);
});

test("the real public staging CLI loads overview projectors in a fresh offline process", (t) => {
  const f = fixture(t);
  prepareCollectorOverview(f);
  const preload = path.join(f.dir, "deny-network.cjs");
  fs.writeFileSync(preload, 'global.fetch = async () => { throw new Error("network_forbidden"); };\n');
  const outputDir = path.join(f.dir, "staged");
  const result = spawnSync(process.execPath, ["--require", preload, path.join(__dirname, "../src/prepare-public-artifact.js"),
    "--source", f.outputDir, "--output", outputDir, "--overview"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const reported = JSON.parse(result.stdout);
  assert.equal(reported.status, "public_artifact_prepared");
  assert.equal(reported.copiedFiles.length, 6);
  assert.match(fs.readFileSync(path.join(outputDir, "index.html"), "utf8"), /FAILED_LEGACY/);
});
