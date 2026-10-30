"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildCollectorOverview, renderCollectorOverview } = require("../src/collector-overview");
const { createAttempt, finishAttempt } = require("../src/collector-attempt");
const { importPublicPatrol } = require("../src/public-patrol-import");
const { importWorkflowObservation } = require("../src/workflow-observation");
const { projectCollectorStatus, preparePublicArtifact, overviewMarkdown } = require("../src/prepare-public-artifact");
const { prepareCollectorOverview } = require("../src/prepare-collector-overview");

const START = "2026-10-30T01:00:00.000Z";
const FINISH = "2026-10-30T01:01:00.000Z";
const AS_OF = "2026-10-30T02:00:00.000Z";

function legacy({ generatedAt = START, failures = true, recommendation = null } = {}) {
  return { generatedAt, generatedAtJst: "2026/10/30 10:00", keywords: Array(13).fill("synthetic"),
    attempts: Array.from({ length: 13 }, () => ({ keyword: "synthetic", ok: !failures,
      status: failures ? 403 : 200, imported: failures ? null : 1, ...(failures ? { error: "fetch_failed" } : {}) })),
    totalJobs: failures ? null : 1, safeCandidates: failures ? null : 1, recommendation };
}

function newSummary() {
  return { generatedAt: START, generatedAtJst: "2026/10/30 10:00", keywords: ["synthetic"],
    attempts: [{ keyword: "synthetic", ok: true, status: 200, imported: 0 }], totalJobs: 0, safeCandidates: 0,
    recommendation: null, collection: { schemaVersion: 1, status: "attempts_completed", startedAt: START,
      attemptsCompletedAt: FINISH, decisionAsOf: START,
      search: { planned: 1, attempted: 1, succeeded: 1, failed: 0, notAttempted: 0 },
      details: { observed: 0, attempted: 0, succeeded: 0, failed: 0, notAttempted: 0 },
      candidates: { machine: 0, detailConfirmed: 0, detailUnconfirmed: 0 } } };
}

function attempt(fields = {}) {
  const start = createAttempt({ runId: "local-11111111-1111-4111-8111-111111111111", runAttempt: 1, sourceCommit: "a".repeat(40),
    workflowPath: "local", startedAt: START });
  return finishAttempt(start, { finishedAt: FINISH, collectionState: "COMPLETED", diagnostics: null,
    localPersistence: "SUCCEEDED", repositoryPersistence: "NOT_ATTEMPTED", publication: "NOT_ATTEMPTED",
    reasonCode: "collection_completed", ...fields });
}

function patrol() {
  return importPublicPatrol({ kind: "public_patrol", schemaVersion: 1,
    run: { patrolRunId: "11111111-1111-4111-8111-111111111111", startedAt: START,
      attemptsCompletedAt: FINISH, decisionAsOf: START, status: "COMPLETED" },
    scope: { declaredPlatforms: ["crowdworks", "lancers"], unsupportedSources: ["lancers"] },
    sources: [{ sourceId: 1, platform: "crowdworks", sourceKind: "PUBLIC_SEARCH", availability: "AVAILABLE",
      url: "https://crowdworks.jp/public/jobs/search", scopeId: `scope-${"a".repeat(64)}` },
    { sourceId: 2, platform: "crowdworks", sourceKind: "PUBLIC_JOB_DETAIL", availability: "AVAILABLE",
      url: "https://crowdworks.jp/public/jobs/123", scopeId: `scope-${"b".repeat(64)}` },
    { sourceId: 3, platform: "lancers", sourceKind: "PUBLIC_PLATFORM", availability: "UNAVAILABLE" }],
    entries: [{ platform: "crowdworks", jobId: "123", url: "https://crowdworks.jp/public/jobs/123", observations: [
      { sourceId: 1, observedAt: START, level: "SEARCH_SUMMARY" },
      { sourceId: 2, observedAt: FINISH, level: "JOB_DETAIL",
        fit: { status: "POTENTIAL_FIT", reasonCodes: ["public_requirements_match"] } }
    ] }] });
}

function workflowObservation(fields = {}) {
  const runId = "40820005840", jobId = "100200300";
  const runUrl = `https://github.com/amindjapan/cw-work-agent-daily/actions/runs/${runId}`;
  return importWorkflowObservation({ kind: "workflow_observation", schemaVersion: 1,
    repository: "amindjapan/cw-work-agent-daily", workflowPath: ".github/workflows/daily.yml",
    runId, runAttempt: 1, jobId, sourceCommit: "a".repeat(40), runUrl, jobUrl: `${runUrl}/job/${jobId}`,
    workflowStartedAt: START, workflowUpdatedAt: FINISH, observedAt: "2026-10-30T01:02:00.000Z",
    collectorStartedAt: null, collectorFinishedAt: null, diagnosticLoggedAt: "2026-10-30T01:00:20.000Z",
    diagnostics: { kind: "collector_diagnostics", schemaVersion: 1, aborted: true,
      search: { planned: 13, attempted: 1, succeeded: 0, failed: 1, notAttempted: 12 },
      details: { observed: 0, attempted: 0, succeeded: 0, failed: 0, notAttempted: 0 },
      events: [{ stage: "search", httpStatus: 403, reason: "access_denied" }] },
    stepResults: { tests: "SUCCEEDED", collection: "FAILED", snapshot: "SKIPPED",
      repositoryPersistence: "SKIPPED", publication: "SKIPPED" }, ...fields });
}

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-overview-observation-"));
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("missing attempt, saved materials and patrol remain unavailable with unknown last success", () => {
  const view = buildCollectorOverview({ asOf: AS_OF });
  assert.equal(view.lastAttempt.availability, "UNAVAILABLE");
  assert.equal(view.lastAttempt.reportedState, "UNKNOWN");
  assert.equal(view.lastAttempt.finishedAt, null);
  assert.equal(view.savedMaterial.status, "UNAVAILABLE");
  assert.deepEqual(view.savedMaterial.counts, { observedJobs: null, machineCandidates: null, detailConfirmed: null });
  assert.deepEqual(view.lastVerifiedSuccess, { status: "UNKNOWN", completedAt: null });
  assert.equal(view.patrol.availability, "UNAVAILABLE");
  assert.equal(view.patrol.counts.observations, null);
  assert.deepEqual(view.displayJobs, []);
});

test("the legacy thirteen HTTP403 summary is failed material and never a successful collection", () => {
  const view = buildCollectorOverview({ savedSummary: legacy(), asOf: AS_OF });
  assert.equal(view.savedMaterial.status, "FAILED_LEGACY");
  assert.equal(view.savedMaterial.generatedAt, START);
  assert.equal(view.savedMaterial.attemptsCompletedAt, null);
  assert.equal(view.lastVerifiedSuccess.status, "UNKNOWN");
  const html = renderCollectorOverview(view);
  assert.match(html, /FAILED_LEGACY/);
  assert.match(html, /generatedAt（開始時刻）/);
  assert.match(html, /取得試行完了<\/dt><dd>UNKNOWN/);
});

test("zero counts and attempts_completed do not establish a last verified success", () => {
  const view = buildCollectorOverview({ latestAttempt: attempt(), savedSummary: newSummary(), asOf: AS_OF });
  assert.equal(view.savedMaterial.status, "SAVED_UNVERIFIED");
  assert.deepEqual(view.savedMaterial.counts, { observedJobs: 0, machineCandidates: 0, detailConfirmed: 0 });
  assert.equal(view.savedMaterial.attemptsCompletedAt, FINISH);
  assert.equal(view.lastAttempt.reportedState, "COMPLETED");
  assert.equal(view.lastVerifiedSuccess.status, "UNKNOWN");
  assert.equal(view.lastAttempt.diagnostics, null);
});

test("exit zero, nonaborted diagnostics and arbitrary positive claims cannot manufacture success", () => {
  const summary = { ...newSummary(), exitCode: 0, aborted: false, savedFileExists: true };
  assert.equal(buildCollectorOverview({ savedSummary: summary, asOf: AS_OF }).lastVerifiedSuccess.status, "UNKNOWN");
  for (const claim of [{ status: "SUCCESS" }, { verified: true }, { sourceSha256: "a".repeat(64), inputHashesVerified: true }]) {
    assert.throws(() => buildCollectorOverview({ verifiedSuccess: claim, asOf: AS_OF }), /unsupported_verified_success_evidence/);
  }
});

test("collection, local persistence, repository persistence and publication remain independent", () => {
  const view = buildCollectorOverview({ latestAttempt: attempt({ repositoryPersistence: "FAILED", publication: "UNKNOWN" }),
    savedSummary: legacy(), asOf: AS_OF });
  assert.equal(view.lastAttempt.reportedState, "COMPLETED");
  assert.equal(view.lastAttempt.localPersistence, "SUCCEEDED");
  assert.equal(view.lastAttempt.repositoryPersistence, "FAILED");
  assert.equal(view.lastAttempt.publication, "UNKNOWN");
  assert.equal(view.savedMaterial.status, "FAILED_LEGACY");
  assert.equal(view.lastVerifiedSuccess.status, "UNKNOWN");
});

test("saved material ordering uses start times rather than late finish or modified-time claims", () => {
  const older = legacy({ generatedAt: "2026-10-29T23:00:00.000Z" });
  const view = buildCollectorOverview({ latestAttempt: attempt(), savedSummary: older, asOf: AS_OF });
  assert.equal(view.savedMaterial.relationToLatestAttempt, "OLDER_THAN_LATEST_ATTEMPT");
  const later = legacy({ generatedAt: "2026-10-30T01:30:00.000Z" });
  const outOfOrder = buildCollectorOverview({ latestAttempt: attempt(), savedSummary: later, asOf: AS_OF });
  assert.equal(outOfOrder.savedMaterial.relationToLatestAttempt, "NEWER_THAN_LATEST_ATTEMPT");
  assert.equal(outOfOrder.lastVerifiedSuccess.status, "UNKNOWN");
});

test("future and invalid input clocks never become available completion evidence", () => {
  for (const asOf of ["invalid", "2026-02-30T00:00:00Z", "2026-10-30T00:00:00.000Z"]) {
    assert.throws(() => buildCollectorOverview({ latestAttempt: attempt(), asOf }));
  }
  assert.throws(() => buildCollectorOverview({ savedSummary: legacy({ generatedAt: "2099-01-01T00:00:00.000Z" }), asOf: AS_OF }));
  assert.throws(() => buildCollectorOverview({ patrol: patrol(), asOf: "2026-10-30T01:00:30.000Z" }));
});

test("independent patrol preserves unsupported sources and unknown security without adding collector candidates", () => {
  const source = patrol();
  const view = buildCollectorOverview({ savedSummary: legacy(), patrol: source, asOf: AS_OF });
  assert.equal(view.patrol.availability, "LIMITED");
  assert.deepEqual(view.patrol.scope.unsupportedSources, ["lancers"]);
  assert.equal(view.savedMaterial.counts.machineCandidates, null);
  assert.equal(view.patrol.counts.uniqueJobs, 1);
  assert.equal(view.displayJobs[0].origins.length, 2);
  assert.ok(view.displayJobs[0].origins.every((origin) => origin.decision === "STOP_REQUIRED"));
  assert.deepEqual(view.patrol.entries, source.entries);
  const html = renderCollectorOverview(view);
  assert.match(html, /lancers: UNKNOWN（未対応）/);
  assert.match(html, /適合評価は応募承認を意味しません/);
});

test("display-only cross-source grouping preserves all observations by the same canonical ID and URL", () => {
  const summary = legacy({ failures: false, recommendation: { id: "123", url: "https://crowdworks.jp/public/jobs/123" } });
  const view = buildCollectorOverview({ savedSummary: summary, patrol: patrol(), asOf: AS_OF });
  assert.equal(view.displayJobs.length, 1);
  assert.equal(view.displayJobs[0].origins.length, 3);
  assert.equal(view.displayJobs[0].origins[0].kind, "saved_summary");
  assert.equal(view.savedMaterial.counts.machineCandidates, 1);
  assert.equal(view.patrol.counts.observations, 2);
  assert.equal(view.lastVerifiedSuccess.status, "UNKNOWN");
});

test("static rendering makes no fetch, filesystem, or implicit current-time calls", (t) => {
  const input = { savedSummary: legacy(), patrol: patrol(), latestAttempt: attempt(), asOf: AS_OF };
  t.mock.method(global, "fetch", () => { throw new Error("unexpected_network"); });
  for (const method of ["readFileSync", "writeFileSync", "readdirSync", "statSync"]) {
    t.mock.method(fs, method, () => { throw new Error("unexpected_filesystem"); });
  }
  t.mock.method(Date, "now", () => { throw new Error("unexpected_clock"); });
  const html = renderCollectorOverview(buildCollectorOverview(input));
  assert.doesNotMatch(html, /<script\b|<iframe\b|<img\b|<link\b|fetch\s*\(|onload\s*=|onclick\s*=/i);
  assert.match(html, /rel="noreferrer noopener"/);
  assert.match(html, /非公開管理未接続/);
});

test("source free text and unknown private fields cannot inject HTML or private management states", () => {
  const summary = legacy();
  summary.keywords = ["<img src=x onerror=alert(1)>"];
  summary.privateNotes = "private-note-only";
  const view = buildCollectorOverview({ savedSummary: summary, asOf: AS_OF });
  assert.doesNotMatch(renderCollectorOverview(view), /private-note-only|onerror|<img/);
  assert.throws(() => buildCollectorOverview({ asOf: AS_OF, applicationHold: "private-note-only" }), /invalid_collector_overview_input/);
});

test("input accessors and unsupported inherited options are rejected without evaluation", () => {
  let calls = 0;
  const input = { asOf: AS_OF };
  Object.defineProperty(input, "latestAttempt", { enumerable: true, get() { calls++; return null; } });
  assert.throws(() => buildCollectorOverview(input), /invalid_collector_overview_input/);
  assert.equal(calls, 0);
  assert.throws(() => buildCollectorOverview(Object.create({ asOf: AS_OF })), /invalid_collector_overview_input/);
});

test("static overview shows all retrieval counters and the actual stop stage, status and fixed reason", () => {
  const diagnostics = { kind: "collector_diagnostics", schemaVersion: 1, aborted: true,
    search: { planned: 13, attempted: 1, succeeded: 0, failed: 1, notAttempted: 12 },
    details: { observed: 0, attempted: 0, succeeded: 0, failed: 0, notAttempted: 0 },
    events: [{ stage: "search", httpStatus: 403, reason: "access_denied" }] };
  const view = buildCollectorOverview({ latestAttempt: attempt({ collectionState: "ABORTED", diagnostics,
    localPersistence: "NOT_ATTEMPTED", reasonCode: "access_denied" }), asOf: AS_OF });
  assert.deepEqual(view.lastAttempt.lastStop, diagnostics.events[0]);
  const html = renderCollectorOverview(view);
  assert.match(html, /stage=search \/ HTTP=403 \/ reason=access_denied/);
  assert.match(html, /検索: planned=13 \/ attempted=1 \/ succeeded=0 \/ failed=1 \/ notAttempted=12/);
  assert.match(html, /詳細: observed=0 \/ attempted=0 \/ succeeded=0 \/ failed=0 \/ notAttempted=0/);
  assert.match(renderCollectorOverview(buildCollectorOverview({ asOf: AS_OF })),
    /検索: planned=UNKNOWN \/ attempted=UNKNOWN \/ succeeded=UNKNOWN \/ failed=UNKNOWN \/ notAttempted=UNKNOWN/);
});

test("a pending attempt is an unfinished record rather than a claim that a process is currently running", () => {
  const record = createAttempt({ runId: "local-11111111-1111-4111-8111-111111111111", runAttempt: 1,
    sourceCommit: "a".repeat(40), workflowPath: "local", startedAt: START });
  const view = buildCollectorOverview({ latestAttempt: record, asOf: AS_OF });
  assert.equal(view.lastAttempt.finishedAt, null);
  assert.match(renderCollectorOverview(view), /RUNNING（記録上・終了未確認）/);
});

test("the public citation, observation level, hash and unconfirmed conditions accompany each patrol observation", () => {
  const source = patrol(), view = buildCollectorOverview({ patrol: source, asOf: AS_OF });
  const html = renderCollectorOverview(view);
  assert.match(html, /href="https:\/\/crowdworks\.jp\/public\/jobs\/search"/);
  assert.match(html, /href="https:\/\/crowdworks\.jp\/public\/jobs\/123"/);
  assert.match(html, /取得粒度: SEARCH_SUMMARY/);
  assert.match(html, /取得粒度: JOB_DETAIL/);
  assert.match(html, /AI_PERMISSION/);
  assert.match(html, /COMPENSATION/);
  assert.match(html, new RegExp(source.entries[0].observations[0].evidence.sha256));
  assert.match(html, /ハッシュは整合確認用で、実取得や真正性を証明する署名ではありません/);
});

test("renderer accepts only deep-frozen views issued by the builder and rejects forged or cloned states", () => {
  const input = { latestAttempt: attempt(), patrol: patrol(), savedSummary: legacy(), asOf: AS_OF };
  const view = buildCollectorOverview(input);
  assert.ok(Object.isFrozen(view));
  assert.ok(Object.isFrozen(view.lastAttempt));
  assert.ok(Object.isFrozen(view.patrol.entries[0].observations[0]));
  assert.throws(() => { view.lastVerifiedSuccess.status = "SUCCESS"; }, TypeError);
  assert.throws(() => { view.privateNotes = "private-note-only"; }, TypeError);
  assert.throws(() => renderCollectorOverview(JSON.parse(JSON.stringify(view))), /invalid_collector_overview_input/);
  assert.throws(() => renderCollectorOverview({ ...view, applicationHold: "private-note-only" }), /invalid_collector_overview_input/);
  input.savedSummary.generatedAt = "2099-01-01T00:00:00.000Z";
  assert.equal(view.savedMaterial.generatedAt, START);
  assert.doesNotMatch(JSON.stringify(view), /sourceEvidence|privateNotes|applicationHold/);
});

test("proxy objects and arrays are rejected before introspection or property traps can execute", () => {
  let traps = 0;
  const handler = {
    getPrototypeOf() { traps++; throw new Error("unexpected_proxy_effect"); },
    ownKeys() { traps++; throw new Error("unexpected_proxy_effect"); },
    getOwnPropertyDescriptor() { traps++; throw new Error("unexpected_proxy_effect"); },
    get() { traps++; throw new Error("unexpected_proxy_effect"); }
  };
  for (const input of [new Proxy({ asOf: AS_OF }, handler), new Proxy([], handler),
    { asOf: AS_OF, latestAttempt: new Proxy({}, handler) },
    { asOf: AS_OF, savedSummary: new Proxy([], handler) },
    { asOf: AS_OF, patrol: new Proxy({}, handler) }]) {
    assert.throws(() => buildCollectorOverview(input), /invalid_collector_overview_input/);
    assert.equal(traps, 0);
  }
  const issued = buildCollectorOverview({ asOf: AS_OF });
  for (const input of [new Proxy(issued, handler), new Proxy([], handler)]) {
    assert.throws(() => renderCollectorOverview(input), /invalid_collector_overview_input/);
    assert.equal(traps, 0);
  }
});

test("independently observed workflow clocks never establish collector clocks or successful persistence", () => {
  const observation = workflowObservation();
  const view = buildCollectorOverview({ workflowObservation: observation, savedSummary: legacy(), asOf: AS_OF });
  assert.equal(view.lastAttempt.reportedState, "ABORTED");
  assert.equal(view.lastAttempt.startedAt, null);
  assert.equal(view.lastAttempt.finishedAt, null);
  assert.equal(view.lastAttempt.workflowStartedAt, START);
  assert.equal(view.lastAttempt.workflowUpdatedAt, FINISH);
  assert.equal(view.lastAttempt.diagnosticLoggedAt, "2026-10-30T01:00:20.000Z");
  assert.equal(view.lastAttempt.localPersistence, "UNKNOWN");
  assert.equal(view.lastAttempt.repositoryPersistence, "SKIPPED");
  assert.equal(view.lastAttempt.publication, "SKIPPED");
  assert.deepEqual(view.lastAttempt.stepResults, observation.stepResults);
  assert.equal(view.lastVerifiedSuccess.status, "UNKNOWN");
  assert.equal(view.savedMaterial.status, "FAILED_LEGACY");
  assert.equal(view.savedMaterial.relationToLatestAttempt, "UNKNOWN");
  const html = renderCollectorOverview(view);
  assert.match(html, /stage=search \/ HTTP=403 \/ reason=access_denied/);
  assert.match(html, /元 run の Git 保存<\/dt><dd>SKIPPED/);
  assert.match(html, /workflow の時刻と Collector の開始・終了時刻は別/);
  assert.match(html, /Collector Status View \(no collection\)/);
  assert.match(html, /collector-status-view\.yml\?query=branch%3Amain/);
  assert.match(html, new RegExp(observation.runUrl));
  assert.doesNotMatch(html, /actions\/workflows\/daily\.yml/);
});

test("native and independently observed attempt records cannot silently compete for latest state", () => {
  assert.throws(() => buildCollectorOverview({ latestAttempt: attempt(), workflowObservation: workflowObservation(), asOf: AS_OF }),
    /invalid_collector_overview_input/);
  assert.throws(() => buildCollectorOverview({ workflowObservation: workflowObservation(), asOf: START }));
});

test("collector status schema two preserves external evidence and schema one remains byte-compatible", () => {
  const v1 = { kind: "collector_status", schemaVersion: 1, availability: "AVAILABLE", asOf: AS_OF, attempt: attempt() };
  assert.deepEqual(projectCollectorStatus(v1), v1);
  const v2 = { kind: "collector_status", schemaVersion: 2, availability: "AVAILABLE", asOf: AS_OF,
    attempt: null, workflowObservation: workflowObservation() };
  assert.deepEqual(projectCollectorStatus(v2), v2);
  assert.throws(() => projectCollectorStatus({ ...v2, attempt: attempt() }), /invalid_collector_status/);
  assert.throws(() => projectCollectorStatus({ ...v2, asOf: START }), /invalid_collector_status/);
  assert.throws(() => projectCollectorStatus({ ...v2, availability: "UNAVAILABLE" }), /invalid_collector_status/);
  assert.throws(() => projectCollectorStatus({ ...v1, workflowObservation: null }), /invalid_collector_status/);
});

test("explicit in-memory composition avoids input rereads and public staging rebuilds schema two safely", (t) => {
  const dir = directory(t), outputDir = path.join(dir, "site");
  const bytes = Buffer.from(`${JSON.stringify(legacy(), null, 2)}\n`);
  const read = t.mock.method(fs, "readFileSync", () => { throw new Error("unexpected_input_reread"); });
  const prepared = prepareCollectorOverview({ summaryBytes: bytes, workflowObservation: workflowObservation(),
    patrolInput: patrol(), outputDir, asOf: AS_OF });
  assert.equal(read.mock.calls.length, 0);
  read.mock.restore();
  assert.equal(prepared.view.lastAttempt.reportedState, "ABORTED");
  assert.deepEqual(fs.readFileSync(path.join(outputDir, "latest.json")), bytes);
  const status = JSON.parse(fs.readFileSync(path.join(outputDir, "collector-status.json"), "utf8"));
  assert.equal(status.schemaVersion, 2);
  assert.equal(status.attempt, null);
  assert.equal(status.workflowObservation.runId, "40820005840");
  fs.writeFileSync(path.join(outputDir, "index.html"), '<script>throw new Error("untrusted-staged-markup")</script>');
  const staging = path.join(dir, "public");
  preparePublicArtifact({ sourceDir: outputDir, outputDir: staging, includeOverview: true });
  const html = fs.readFileSync(path.join(staging, "index.html"), "utf8");
  assert.match(html, /FAILED_LEGACY/);
  assert.match(html, /元 workflow の独立観測/);
  assert.doesNotMatch(html, /<script|untrusted-staged-markup/);
  assert.deepEqual(fs.readFileSync(path.join(staging, "latest.json")), bytes);
});

test("explicit composition rejects duplicate file and memory sources before output writes", (t) => {
  const dir = directory(t), summaryBytes = Buffer.from(JSON.stringify(legacy()));
  const summaryFile = path.join(dir, "summary.json"), observationFile = path.join(dir, "observation.json");
  fs.writeFileSync(summaryFile, summaryBytes);
  fs.writeFileSync(observationFile, JSON.stringify(workflowObservation()));
  const combinations = [
    { summaryFile, summaryBytes },
    { summaryBytes, workflowObservationFile: observationFile, workflowObservation: workflowObservation() },
    { summaryBytes, patrolFile: path.join(dir, "unused.json"), patrolInput: patrol() },
    { summaryBytes, attemptFile: path.join(dir, "unused-attempt.json"), workflowObservation: workflowObservation() }
  ];
  for (const [index, inputs] of combinations.entries()) {
    const outputDir = path.join(dir, `output-${index}`);
    assert.throws(() => prepareCollectorOverview({ ...inputs, outputDir, asOf: AS_OF }), /overview_ambiguous_input/);
    assert.equal(fs.existsSync(outputDir), false);
  }
});

test("new status and composition options reject accessors and proxies without evaluating claims", () => {
  let calls = 0;
  const status = { kind: "collector_status", schemaVersion: 2, availability: "AVAILABLE", asOf: AS_OF, attempt: null };
  Object.defineProperty(status, "workflowObservation", { enumerable: true, get() { calls++; throw new Error("private-input-effect"); } });
  assert.throws(() => projectCollectorStatus(status), /invalid_collector_status/);
  const options = { outputDir: "unused", asOf: AS_OF };
  Object.defineProperty(options, "summaryBytes", { enumerable: true, get() { calls++; throw new Error("private-input-effect"); } });
  assert.throws(() => prepareCollectorOverview(options), /overview_invalid_options/);
  const proxy = new Proxy({}, { getPrototypeOf() { calls++; throw new Error("private-input-effect"); } });
  assert.throws(() => projectCollectorStatus(proxy), /invalid_collector_status/);
  assert.throws(() => prepareCollectorOverview(proxy), /overview_invalid_options/);
  assert.equal(calls, 0);
});

test("a future display reference does not imply a fresh observation or global latest run", () => {
  const observation = workflowObservation();
  const view = buildCollectorOverview({ workflowObservation: observation, asOf: "2099-01-01T00:00:00.000Z" });
  assert.equal(view.lastAttempt.observationRecordedAt, observation.observedAt);
  const html = renderCollectorOverview(view), markdown = overviewMarkdown(view);
  assert.match(html, /取り込み範囲の最終確認済み試行/);
  assert.match(html, /表示基準時刻: 2099-01-01T00:00:00.000Z/);
  for (const value of [html, markdown]) {
    assert.match(value, /取り込み後の run は自動反映しません/);
    assert.match(value, /Actions の自動監視・取得は行いません/);
    assert.match(value, new RegExp(observation.observedAt));
  }
  assert.equal(view.lastVerifiedSuccess.status, "UNKNOWN");
});
