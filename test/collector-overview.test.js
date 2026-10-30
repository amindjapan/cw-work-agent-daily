"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { buildCollectorOverview, renderCollectorOverview } = require("../src/collector-overview");
const { createAttempt, finishAttempt } = require("../src/collector-attempt");
const { importPublicPatrol } = require("../src/public-patrol-import");

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
