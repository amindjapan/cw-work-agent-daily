"use strict";

const { projectPublicAttempt } = require("./collector-attempt");
const { projectPublicPatrol } = require("./public-patrol-import");
const { projectPublicSummary } = require("./prepare-public-artifact");
const { projectWorkflowObservation } = require("./workflow-observation");
const { normalizePublicJobRef, normalizePublicTimestamp } = require("./public-evidence");
const { types } = require("node:util");

const UNKNOWN_CONDITIONS = ["AI_PERMISSION", "COMPENSATION", "ELIGIBILITY", "DATA_RIGHTS", "DELIVERY_SCOPE",
  "ACCEPTANCE", "RECRUITMENT_OPEN", "ACCESS_TERMS"];
const STOP_REASONS = new Set(["access_denied", "authentication_required", "rate_limited", "captcha_required",
  "access_congestion", "protection_warning"]);
const issuedViews = new WeakSet();

function fail() { throw new Error("invalid_collector_overview_input"); }

// Explicit parsed data only. Do not evaluate accessors, inherited claims, or
// toJSON hooks while composing a public view.
function plainCopy(value, depth = 0) {
  if (types.isProxy(value)) fail();
  if (depth > 40) fail();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) fail(); return value; }
  if (!value || typeof value !== "object") fail();
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || value.length > 10000) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== value.length + 1) fail();
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail();
      return plainCopy(descriptor.value, depth + 1);
    });
  }
  if (prototype !== Object.prototype && prototype !== null) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Reflect.ownKeys(descriptors).map((key) => {
    const descriptor = descriptors[key];
    if (typeof key !== "string" || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail();
    return [key, plainCopy(descriptor.value, depth + 1)];
  });
  return Object.fromEntries(entries);
}

function time(value) {
  const normalized = normalizePublicTimestamp(value);
  if (!normalized) fail();
  return normalized;
}

function notFuture(value, asOf) {
  if (value !== null && time(value) > asOf) fail();
}

function count(value) { return Number.isSafeInteger(value) && value >= 0; }

function attemptView(record, observationInput, asOf) {
  if (record !== null && observationInput !== null) fail();
  if (observationInput !== null) {
    const observation = projectWorkflowObservation(observationInput);
    for (const stamp of [observation.workflowStartedAt, observation.workflowUpdatedAt, observation.observedAt,
      observation.diagnosticLoggedAt, observation.collectorStartedAt, observation.collectorFinishedAt]) notFuture(stamp, asOf);
    const lastStop = observation.diagnostics.events.filter((event) => STOP_REASONS.has(event.reason)).at(-1) ?? null;
    if (!lastStop) fail();
    return { availability: "AVAILABLE", reportedState: "ABORTED", sourceKind: "WORKFLOW_OBSERVATION",
      runId: observation.runId, runAttempt: observation.runAttempt, sourceCommit: observation.sourceCommit,
      workflowPath: observation.workflowPath, startedAt: observation.collectorStartedAt, finishedAt: observation.collectorFinishedAt,
      diagnostics: observation.diagnostics, localPersistence: "UNKNOWN",
      repositoryPersistence: observation.stepResults.repositoryPersistence, publication: observation.stepResults.publication,
      reasonCode: lastStop.reason, lastStop, workflowStartedAt: observation.workflowStartedAt,
      workflowUpdatedAt: observation.workflowUpdatedAt, observationRecordedAt: observation.observedAt,
      diagnosticLoggedAt: observation.diagnosticLoggedAt, stepResults: observation.stepResults,
      runUrl: observation.runUrl, jobUrl: observation.jobUrl, sourceEvidenceSha256: observation.contentSha256 };
  }
  if (record === null) return { availability: "UNAVAILABLE", reportedState: "UNKNOWN", runId: null, runAttempt: null,
    sourceCommit: null, workflowPath: null, startedAt: null, finishedAt: null, diagnostics: null,
    localPersistence: "UNKNOWN", repositoryPersistence: "UNKNOWN", publication: "UNKNOWN", reasonCode: "attempt_unavailable", lastStop: null };
  const attempt = projectPublicAttempt(record);
  notFuture(attempt.startedAt, asOf);
  notFuture(attempt.finishedAt, asOf);
  return { availability: "AVAILABLE", reportedState: attempt.collectionState, runId: attempt.runId,
    runAttempt: attempt.runAttempt, sourceCommit: attempt.sourceCommit, workflowPath: attempt.workflowPath,
    startedAt: attempt.startedAt, finishedAt: attempt.finishedAt, diagnostics: attempt.diagnostics,
    localPersistence: attempt.localPersistence, repositoryPersistence: attempt.repositoryPersistence,
    publication: attempt.publication, reasonCode: attempt.reasonCode,
    lastStop: attempt.diagnostics?.events.filter((event) => STOP_REASONS.has(event.reason)).at(-1) ?? null };
}

function savedView(value, asOf) {
  if (value === null) return { availability: "UNAVAILABLE", status: "UNAVAILABLE", generatedAt: null,
    attemptsCompletedAt: null, counts: { observedJobs: null, machineCandidates: null, detailConfirmed: null },
    recommendationRef: null, relationToLatestAttempt: "UNKNOWN" };
  const summary = projectPublicSummary(value);
  const generatedAt = time(summary.generatedAt);
  notFuture(generatedAt, asOf);
  if (!Array.isArray(summary.attempts) || !Array.isArray(summary.keywords)
    || !(summary.totalJobs === null || count(summary.totalJobs))
    || !(summary.safeCandidates === null || count(summary.safeCandidates))
    || (summary.totalJobs === null) !== (summary.safeCandidates === null)
    || (summary.totalJobs !== null && summary.safeCandidates > summary.totalJobs)) fail();
  for (const attempt of summary.attempts) {
    if (typeof attempt.ok !== "boolean" || !(attempt.status === null || count(attempt.status) && attempt.status <= 599)
      || !(attempt.imported === null || count(attempt.imported))) fail();
  }
  const attemptsCompletedAt = summary.collection ? time(summary.collection.attemptsCompletedAt) : null;
  notFuture(attemptsCompletedAt, asOf);
  const failed = summary.totalJobs === null && summary.safeCandidates === null && summary.recommendation === null
    && summary.attempts.length > 0 && summary.attempts.every((attempt) => attempt.ok === false);
  let recommendationRef = null;
  if (summary.recommendation !== null) {
    recommendationRef = normalizePublicJobRef({ platform: "crowdworks", id: summary.recommendation.id,
      url: summary.recommendation.url });
    if (!recommendationRef) fail();
  }
  return { availability: "AVAILABLE", status: failed ? summary.collection ? "FAILED" : "FAILED_LEGACY" : "SAVED_UNVERIFIED",
    generatedAt, attemptsCompletedAt,
    counts: { observedJobs: summary.totalJobs, machineCandidates: summary.safeCandidates,
      detailConfirmed: summary.collection ? summary.collection.candidates.detailConfirmed : null },
    recommendationRef, relationToLatestAttempt: "UNKNOWN" };
}

function displayJobs(savedMaterial, patrol) {
  const entries = new Map();
  const add = (ref, origin) => {
    const key = `${ref.platform}:${ref.jobId}:${ref.url}`;
    if (!entries.has(key)) entries.set(key, { platform: ref.platform, jobId: ref.jobId, url: ref.url, origins: [] });
    entries.get(key).origins.push(origin);
  };
  if (savedMaterial.recommendationRef) add(savedMaterial.recommendationRef,
    { kind: "saved_summary", observedAt: null, summaryGeneratedAt: savedMaterial.generatedAt, level: "PUBLIC_SUMMARY_RECOMMENDATION",
      fit: { status: "UNKNOWN" }, securityReview: { status: "UNKNOWN" }, decision: "STOP_REQUIRED",
      unconfirmedConditions: [...UNKNOWN_CONDITIONS] });
  for (const entry of patrol.entries) {
    const ref = normalizePublicJobRef({ platform: entry.platform, jobId: entry.jobId, url: entry.url });
    if (!ref) fail();
    for (const observation of entry.observations) add(ref, { kind: "public_patrol", ...plainCopy(observation) });
  }
  return [...entries.values()].sort((a, b) => a.platform.localeCompare(b.platform)
    || a.jobId.localeCompare(b.jobId) || a.url.localeCompare(b.url));
}

function buildCollectorOverview(input = {}) {
  const options = plainCopy(input);
  const allowed = ["latestAttempt", "workflowObservation", "savedSummary", "verifiedSuccess", "patrol", "asOf"];
  if (!options || Array.isArray(options) || Object.keys(options).some((key) => !allowed.includes(key))) fail();
  const asOf = time(options.asOf);
  // Initial implementation has no adapter that can establish a last successful
  // collection from complete, externally verified source/hash evidence.
  if (options.verifiedSuccess !== undefined && options.verifiedSuccess !== null) {
    throw new Error("unsupported_verified_success_evidence");
  }
  const lastAttempt = attemptView(options.latestAttempt ?? null, options.workflowObservation ?? null, asOf);
  const savedMaterial = savedView(options.savedSummary ?? null, asOf);
  const patrol = projectPublicPatrol(options.patrol ?? null);
  if (patrol.run) {
    notFuture(patrol.run.startedAt, asOf);
    notFuture(patrol.run.attemptsCompletedAt, asOf);
    notFuture(patrol.run.decisionAsOf, asOf);
  }
  for (const entry of patrol.entries) for (const observation of entry.observations) notFuture(observation.observedAt, asOf);
  if (lastAttempt.startedAt && savedMaterial.generatedAt) {
    savedMaterial.relationToLatestAttempt = savedMaterial.generatedAt < lastAttempt.startedAt ? "OLDER_THAN_LATEST_ATTEMPT"
      : savedMaterial.generatedAt > lastAttempt.startedAt ? "NEWER_THAN_LATEST_ATTEMPT" : "SAME_START_TIME_UNVERIFIED";
  }
  const view = { kind: "collector_overview", schemaVersion: 1, asOf, lastAttempt, savedMaterial,
    lastVerifiedSuccess: { status: "UNKNOWN", completedAt: null }, patrol, displayJobs: displayJobs(savedMaterial, patrol),
    limitationCodes: ["LAST_SUCCESS_NOT_ESTABLISHED", "SAVED_MATERIAL_IS_NOT_SUCCESS_EVIDENCE",
      "PATROL_SEPARATE_FROM_COLLECTOR", "FIT_IS_NOT_APPLICATION_APPROVAL", "PUBLICATION_NOT_INDEPENDENTLY_VERIFIED",
      "EXPLICIT_IMPORT_SCOPE_ONLY", "AS_OF_IS_DISPLAY_REFERENCE"] };
  const freeze = (value) => {
    if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
    return value;
  };
  freeze(view);
  issuedViews.add(view);
  return view;
}

function escape(value) {
  return String(value ?? "UNKNOWN").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;",
    "\"": "&quot;", "'": "&#39;" })[character]);
}

function renderCollectorOverview(input) {
  // This API is build -> render in the same process. It intentionally does not
  // import arbitrary serialized views or trust caller-authored success fields.
  if (types.isProxy(input) || !issuedViews.has(input)) fail();
  const view = plainCopy(input);
  if (view.kind !== "collector_overview" || view.schemaVersion !== 1 || !view.lastAttempt || !view.savedMaterial
    || !view.lastVerifiedSuccess || !view.patrol || !Array.isArray(view.displayJobs)) fail();
  const attempt = view.lastAttempt, saved = view.savedMaterial, patrol = view.patrol;
  const counts = saved.counts;
  const sourceById = new Map((patrol.sources || []).map((source) => [source.sourceId, source]));
  const publicLink = (value, label) => {
    const jobId = typeof value === "string" && value.match(/^https:\/\/crowdworks\.jp\/public\/jobs\/([1-9][0-9]{0,31})$/)?.[1];
    const valid = value === "https://crowdworks.jp/public/jobs/search" || jobId
      && normalizePublicJobRef({ platform: "crowdworks", jobId, url: value });
    return valid ? `<a href="${escape(value)}" target="_blank" rel="noreferrer noopener">${escape(label ?? value)}</a>` : "UNKNOWN";
  };
  const counterLine = (label, value, totalKey) => `<p>${label}: ${totalKey}=${escape(value?.[totalKey])} / attempted=${escape(value?.attempted)} / succeeded=${escape(value?.succeeded)} / failed=${escape(value?.failed)} / notAttempted=${escape(value?.notAttempted)}</p>`;
  const jobs = view.displayJobs.map((job) => {
    const ref = normalizePublicJobRef({ platform: job.platform, jobId: job.jobId, url: job.url });
    const label = `${job.platform} / ${job.jobId}`;
    const link = ref ? `<a href="${escape(ref.url)}" target="_blank" rel="noreferrer noopener">${escape(label)}</a>` : escape(label);
    const origins = job.origins.map((origin) => {
      const sourceUrl = origin.kind === "saved_summary" ? job.url : sourceById.get(origin.sourceId)?.url;
      return `<li>出典: ${escape(origin.kind)} / sourceId=${escape(origin.sourceId)} / ${publicLink(sourceUrl)}<br>観測時刻: ${escape(origin.observedAt)} / 資料開始: ${escape(origin.summaryGeneratedAt)} / 取得粒度: ${escape(origin.level)}<br>適合: ${escape(origin.fit?.status)} / 理由: ${escape(origin.fit?.reasonCodes?.join(", "))}<br>安全審査: ${escape(origin.securityReview?.status)} / 理由: ${escape(origin.securityReview?.reasonCodes?.join(", "))} / STOP_REQUIRED<br>未確認条件: ${escape(origin.unconfirmedConditions?.join(", "))}<br>証拠種別: ${escape(origin.evidence?.kind)} / 内容ハッシュ: ${escape(origin.evidence?.sha256)}</li>`;
    }).join("");
    return `<li>${link}<ul>${origins}</ul></li>`;
  }).join("");
  const unsupported = (patrol.scope?.unsupportedSources || []).map((source) => `<li>${escape(source)}: UNKNOWN（未対応）</li>`).join("");
  const sources = (patrol.sources || []).map((source) => `<li>${escape(source.platform)} / ${escape(source.sourceKind)} / ${escape(source.availability)} / 観測数=${escape(source.observedCount)} / ${publicLink(source.url)}</li>`).join("");
  const attemptState = attempt.reportedState === "RUNNING" && attempt.finishedAt === null ? "RUNNING（記録上・終了未確認）" : attempt.reportedState;
  const workflowEvidence = attempt.sourceKind === "WORKFLOW_OBSERVATION" ? `<section><h2>元 workflow の独立観測</h2><p><a href="${escape(attempt.runUrl)}" target="_blank" rel="noreferrer noopener">元 run の記録</a> / <a href="${escape(attempt.jobUrl)}" target="_blank" rel="noreferrer noopener">元 job の記録</a></p><dl><dt>workflow 開始</dt><dd>${escape(attempt.workflowStartedAt)}</dd><dt>workflow 更新</dt><dd>${escape(attempt.workflowUpdatedAt)}</dd><dt>観測記録時刻</dt><dd>${escape(attempt.observationRecordedAt)}</dd><dt>診断ログ時刻</dt><dd>${escape(attempt.diagnosticLoggedAt)}</dd><dt>tests</dt><dd>${escape(attempt.stepResults.tests)}</dd><dt>collection</dt><dd>${escape(attempt.stepResults.collection)}</dd><dt>snapshot</dt><dd>${escape(attempt.stepResults.snapshot)}</dd><dt>元 run の Git 保存</dt><dd>${escape(attempt.stepResults.repositoryPersistence)}</dd><dt>元 run の Pages 公開</dt><dd>${escape(attempt.stepResults.publication)}</dd></dl><p>workflow の時刻と Collector の開始・終了時刻は別です。後の状態表示資料の Git 保存を、元の収集や元 run の保存成功へ読み替えません。</p><p>観測資料の整合ハッシュ: ${escape(attempt.sourceEvidenceSha256)}</p></section>` : "";
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Collector と公開巡回の状態</title>
<style>body{font-family:system-ui,sans-serif;line-height:1.7;color:#172b35;background:#f2f5f6;margin:0}main{max-width:960px;margin:auto;padding:24px}section{background:white;padding:18px;margin:16px 0;border:1px solid #cbd7db;border-radius:8px}h1{font-size:1.6rem}h2{font-size:1.15rem}dl{display:grid;grid-template-columns:minmax(140px,1fr) 2fr;gap:6px}dd{margin:0;overflow-wrap:anywhere}a{color:#145d82}small{color:#455b66}</style></head><body><main>
<h1>Collector と公開巡回の状態</h1><p>表示基準時刻: ${escape(view.asOf)}</p><p>表示は明示的に取り込んだ記録の範囲です。asOf は表示基準であり、新しい観測を行った時刻ではありません。取り込み後の run は自動反映しません。Actions の自動監視・取得は行いません。</p><p>取り込み元の観測時刻: ${escape(attempt.observationRecordedAt)}</p><p><a href="https://github.com/amindjapan/cw-work-agent-daily/actions/workflows/collector-status-view.yml?query=branch%3Amain" target="_blank" rel="noreferrer noopener">Collector Status View (no collection) · main</a></p>
<section><h2>取り込み範囲の最終確認済み試行</h2><dl><dt>記録の有無</dt><dd>${escape(attempt.availability)}</dd><dt>収集状態（記録上）</dt><dd>${escape(attemptState)}</dd><dt>runId / runAttempt</dt><dd>${escape(attempt.runId)} / ${escape(attempt.runAttempt)}</dd><dt>sourceCommit</dt><dd>${escape(attempt.sourceCommit)}</dd><dt>開始</dt><dd>${escape(attempt.startedAt)}</dd><dt>試行終了</dt><dd>${escape(attempt.finishedAt)}</dd><dt>ローカル保存</dt><dd>${escape(attempt.localPersistence)}</dd><dt>Git 保存</dt><dd>${escape(attempt.repositoryPersistence)}</dd><dt>Pages 公開段階</dt><dd>${escape(attempt.publication)}</dd><dt>固定理由コード</dt><dd>${escape(attempt.reasonCode)}</dd><dt>直近の明示停止</dt><dd>stage=${escape(attempt.lastStop?.stage)} / HTTP=${escape(attempt.lastStop?.httpStatus)} / reason=${escape(attempt.lastStop?.reason)}</dd></dl>${counterLine("検索", attempt.diagnostics?.search, "planned")}${counterLine("詳細", attempt.diagnostics?.details, "observed")}<p>各段階は独立した記録です。exit 0・aborted false・試行完了だけでは収集成功を認定しません。</p></section>
${workflowEvidence}<section><h2>保存済み資料</h2><dl><dt>状態</dt><dd>${escape(saved.status)}</dd><dt>generatedAt（開始時刻）</dt><dd>${escape(saved.generatedAt)}</dd><dt>取得試行完了</dt><dd>${escape(saved.attemptsCompletedAt)}</dd><dt>最終試行との開始順</dt><dd>${escape(saved.relationToLatestAttempt)}</dd><dt>取得案件数</dt><dd>${escape(counts.observedJobs)}</dd><dt>機械候補数</dt><dd>${escape(counts.machineCandidates)}</dd><dt>詳細確認済み候補数</dt><dd>${escape(counts.detailConfirmed)}</dd></dl></section>
<section><h2>最終成功として独立に検証できた収集</h2><p>UNKNOWN</p><p>初版では完全な入力ハッシュと取得元証拠を検証する接続がありません。保存資料の存在を成功へ読み替えません。</p></section>
<section><h2>独立した公開巡回</h2><p>状態: ${escape(patrol.availability)} / 観測数: ${escape(patrol.counts?.observations)} / 一意案件数: ${escape(patrol.counts?.uniqueJobs)}</p><p>宣言された対象: ${escape((patrol.scope?.declaredPlatforms || []).join(", ") || "UNKNOWN")}</p><p>巡回は複数の取得元を扱う別の資料です。初版の取込み対応は CrowdWorks のみで、他の取得元は UNKNOWN のままです。Collector の機械候補数や推薦へ合算しません。</p><ul>${sources}</ul><ul>${unsupported}</ul></section>
<section><h2>表示用にまとめた同一 ID・URL の観測</h2><p>出典ごとの観測を保持します。適合や安全審査が UNKNOWN の場合は STOP_REQUIRED。適合評価は応募承認を意味しません。</p><ul>${jobs || "<li>確認できる案件一覧はありません。件数不明を0件とは扱いません。</li>"}</ul></section>
<section><h2>非公開管理未接続</h2><p>このページは非公開管理の記録を読みません。</p></section><small>内容ハッシュは整合確認用で、実取得や真正性を証明する署名ではありません。このページ自身の配信成功も独立確認が必要です。</small>
</main></body></html>`;
}

module.exports = { buildCollectorOverview, renderCollectorOverview };
