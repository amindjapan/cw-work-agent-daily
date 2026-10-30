"use strict";

const fs = require("fs");
const path = require("path");
const { types: { isProxy } } = require("node:util");
const { classifyJob, normalizeText } = require("./model");
const { fetchJobDetail, fetchSearchPage, inspectSearchResult, classifyAccessStop } = require("./scraper");
const { CollectionAbortedError, collectionDiagnostics, diagnosticEvent, httpStatus, stopReason } = require("./collection-diagnostics");
const { ensureDir, upsertJobs, writeJson } = require("./store");
const { buildSnapshot, saveSnapshot, searchScopeId } = require("./collector");
const { normalizePublicJobRef, normalizePublicTimestamp } = require("./public-evidence");
const { reviewClientHistories } = require("./client-history");
const { createPrivateCandidateStore } = require("./private-candidates");
const { createAttempt, finishAttempt, createAttemptStore } = require("./collector-attempt");

const DEFAULT_KEYWORDS = [
  "Python データ整理",
  "ChatGPT リサーチ",
  "CSV データ整理",
  "記事 リライト",
  "Python スクレイピング",
  "ChatGPT 文章 作成",
  "データ 整理 自動化",
  "営業リスト 作成",
  "Excel VBA",
  "Notion 設計",
  "業務効率化",
  "提案資料 作成",
  "レポート 作成"
];

async function runDaily(options = {}) {
  // Explicit local opt-in only. Existing CLI/workflow callers retain the exact
  // collection path and do not create a second persistence or publication route.
  if (options.attemptRecord === undefined) return runDailyCore(options);
  const settings = options.attemptRecord;
  if (!settings || typeof settings !== "object" || isProxy(settings) || Array.isArray(settings)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(settings))
    || Reflect.ownKeys(Object.getOwnPropertyDescriptors(settings)).some((key) => typeof key !== "string"
      || !["directory", "runId", "runAttempt", "sourceCommit", "workflowPath"].includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(settings, key), "value"))) {
    throw new Error("invalid_attempt_record_options");
  }
  const outputDir = path.resolve(options.outputDir || path.join(__dirname, "..", "site"));
  const evidenceDir = path.resolve(options.evidenceDir || path.join(__dirname, "..", "data", "collector"));
  assertSeparateOutputs(outputDir, evidenceDir);
  const started = options.now || new Date();
  if (!(started instanceof Date) || !Number.isFinite(started.getTime())) throw new Error("invalid_collection_clock");
  const store = createAttemptStore({ directory: settings.directory, publicOutputDir: outputDir, evidenceOutputDir: evidenceDir });
  const initial = createAttempt({ runId: settings.runId, runAttempt: settings.runAttempt,
    sourceCommit: settings.sourceCommit, workflowPath: settings.workflowPath, startedAt: started.toISOString() });
  // A missing status destination fails before the first external request.
  const begun = store.save(initial);
  if (begun.status !== "saved") throw new Error("attempt_already_recorded");
  let diagnostics = null;
  let collectionCompleted = false;
  let persistenceStarted = false;
  let report;
  let failure;
  try {
    report = await runDailyCore(options, {
      collectionCompleted(value) { diagnostics = value; collectionCompleted = true; },
      persistenceStarted() { persistenceStarted = true; }
    });
  } catch (error) {
    failure = error;
    if (error instanceof CollectionAbortedError) diagnostics = error.diagnostics;
  }
  try {
    const ended = options.attemptClock ? options.attemptClock() : new Date();
    if (!(ended instanceof Date) || !Number.isFinite(ended.getTime())) throw new Error("invalid_attempt_clock");
    const aborted = failure instanceof CollectionAbortedError;
    const terminal = finishAttempt(initial, {
      finishedAt: ended.toISOString(),
      collectionState: aborted ? "ABORTED" : failure && !persistenceStarted ? "FAILED"
        : collectionCompleted ? "COMPLETED" : "FAILED",
      diagnostics,
      localPersistence: failure ? persistenceStarted ? "FAILED" : "NOT_ATTEMPTED" : "SUCCEEDED",
      repositoryPersistence: "NOT_ATTEMPTED", publication: "NOT_ATTEMPTED",
      reasonCode: aborted ? "collection_aborted" : failure ? persistenceStarted ? "local_persistence_failed" : "collector_failed"
        : "collection_completed"
    });
    // Never retry a failed/uncertain status write or turn an original failure
    // into success. A retained start record means completion is unconfirmed.
    store.save(terminal);
  } catch {
    // Preserve an observed access stop in the CLI diagnostics even if its
    // dedicated record could not be completed. No fallback store is attempted.
    if (failure) throw failure;
    throw new Error("attempt_record_failed");
  }
  if (failure) throw failure;
  return report;
}

async function runDailyCore(options = {}, lifecycle = null) {
  const keywords = options.keywords || DEFAULT_KEYWORDS;
  const outputDir = path.resolve(options.outputDir || path.join(__dirname, "..", "site"));
  // Observations contain internal profile reviews and must stay outside Pages.
  const evidenceDir = path.resolve(options.evidenceDir || path.join(__dirname, "..", "data", "collector"));
  assertSeparateOutputs(outputDir, evidenceDir);
  // No CLI/environment activation: private retention requires an explicit local caller.
  const privateCandidateStore = createPrivateCandidateStore(options.privateCandidateStore,
    { publicOutputDir: outputDir, evidenceOutputDir: evidenceDir });
  const now = options.now || new Date();
  // Keep generatedAt/expiry decisions at the legacy collection-start time.
  // A separate clock measures completion of retrieval attempts, not persistence.
  const clock = options.clock || (() => new Date());
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("invalid_collection_clock");
  const searchPage = options.fetchSearchPage || fetchSearchPage;
  const jobDetail = options.fetchJobDetail || fetchJobDetail;
  const attempts = [];
  const retrievalAttempts = [];
  const detailAttempts = [];
  const diagnosticEvents = [];
  let aborted = false;
  let jobs = [];

  const diagnostics = () => collectionDiagnostics({ aborted, events: diagnosticEvents,
    search: retrievalAttempts, details: detailAttempts, planned: keywords.length, observed: jobs.length });
  const abortIfRequired = () => { if (aborted) throw new CollectionAbortedError(diagnostics()); };

  for (const keyword of keywords) {
    try {
      const result = await searchPage({ keywords: keyword, page: 1 });
      const status = Number.isInteger(result.status) && result.status >= 0 && result.status <= 599 ? result.status : null;
      const reason = classifyAccessStop(status, result.html, result.url) || stopReason(result.stopReason);
      if (reason) {
        diagnosticEvents.push(diagnosticEvent("search", status, reason));
        retrievalAttempts.push({ ok: false, status, outcome: "fetch_failed" });
        aborted = true;
        break;
      }
      // Do not parse an error/unknown response merely because an adapter's ok
      // field is truthy or contradicts its HTTP status.
      const httpFetched = result.ok === true && status >= 200 && status < 300;
      const fetched = httpFetched && !result.needsManualImport;
      const inspected = fetched ? inspectSearchResult(result.html, result.url)
        : { jobs: [], complete: false, outcome: "fetch_failed" };
      const imported = inspected.jobs.filter(isValidPublicJob);
      // Parsing rows is not complete if their public references fail validation.
      const complete = fetched && inspected.complete && imported.length === inspected.jobs.length;
      const outcome = fetched && !complete ? "extraction_failed" : inspected.outcome;
      jobs = upsertJobs(jobs, imported);
      attempts.push({
        keyword: sanitizeSummaryText(keyword),
        ok: complete,
        status,
        imported: fetched && (complete || imported.length) ? imported.length : null,
        ...(complete ? {} : { error: !httpFetched ? "fetch_failed"
          : result.needsManualImport ? "blocked_or_unsupported" : "extraction_failed" })
      });
      retrievalAttempts.push({
        scopeId: searchScopeId({ keyword, page: 1 }), keyword, page: 1,
        ok: complete, status,
        imported: fetched ? imported.length : null,
        observedIds: imported.map((job) => job.id),
        complete,
        outcome
      });
      diagnosticEvents.push(diagnosticEvent("search", status, complete ? "success"
        : !httpFetched ? "http_failed" : result.needsManualImport ? "unsupported_response" : "extraction_failed"));
    } catch (error) {
      const status = httpStatus(error && error.status);
      const reason = classifyAccessStop(status, "");
      attempts.push({ keyword: sanitizeSummaryText(keyword), ok: false, status: status || 0, imported: null, error: "fetch_failed" });
      retrievalAttempts.push({ scopeId: searchScopeId({ keyword, page: 1 }), keyword,
        page: 1, ok: false, complete: false, status: status || 0, imported: null,
        observedIds: [], outcome: "fetch_failed" });
      diagnosticEvents.push(diagnosticEvent("search", status, reason || "network_failed"));
      if (reason) { aborted = true; break; }
    }
  }
  abortIfRequired();

  const preliminary = jobs
    .filter((job) => isValidPublicJob(job) && !(job.analysis.riskFlags || []).length)
    .sort(compareJobs)
    .slice(0, 80);

  const detailed = [];
  for (const job of preliminary) {
    const requestedRef = normalizePublicJobRef({ platform: "crowdworks", id: job.id, url: job.url });
    try {
      // An adapter must not be able to rewrite the search observation or the
      // requested identity before the returned identity is checked.
      const result = await jobDetail(structuredClone(job));
      // Access stops apply to the whole invocation even if the adapter returned
      // a different identity. No further detail request may follow that signal.
      const responseFetch = result && result.detailFetch;
      const responseStatus = responseFetch && responseFetch.status;
      const reason = classifyAccessStop(responseStatus, "") || stopReason(responseFetch && responseFetch.stopReason);
      if (reason) {
        diagnosticEvents.push(diagnosticEvent("detail", responseStatus, reason));
        detailAttempts.push({ jobId: job.id, ok: false, status: responseStatus, outcome: "fetch_failed" });
        aborted = true;
        break;
      }
      // A detail adapter returning a different job is not evidence for this job.
      const returnedRef = normalizePublicJobRef({ platform: "crowdworks", id: result && result.id, url: result && result.url });
      const sameJob = returnedRef && returnedRef.jobId === requestedRef.jobId;
      const detailFetch = sameJob && result.detailFetch;
      const status = detailFetch && Number.isInteger(detailFetch.status)
        && detailFetch.status >= 0 && detailFetch.status <= 599 ? detailFetch.status : null;
      // A timestamp copied from a search/previous record is insufficient. The
      // current invocation must explicitly report HTTP and description success.
      const detailStamp = sameJob ? normalizePublicTimestamp(result.detailCheckedAt) : null;
      const detailTime = detailStamp ? Date.parse(detailStamp) : NaN;
      const descriptionSource = sameJob && result.contentSources && result.contentSources.description;
      const success = detailFetch && detailFetch.ok === true && detailFetch.outcome === "success"
        && status >= 200 && status < 300 && Number.isFinite(detailTime) && detailTime >= now.getTime()
        && typeof result.description === "string" && normalizeText(result.description).length > 0
        && (descriptionSource === undefined || descriptionSource === "detail");
      const outcome = success ? "success" : detailFetch && detailFetch.outcome === "not_attempted" ? "not_attempted"
        : detailFetch && (detailFetch.outcome === "fetch_failed" || (status !== null && (status < 200 || status >= 300)))
          ? "fetch_failed" : "extraction_failed";
      // Canonical string IDs prevent the later upsert from treating 123 and
      // "123" as two observations of the same public job.
      const observedJob = sameJob ? { ...result, id: requestedRef.jobId, url: requestedRef.url } : { ...job };
      if (success) observedJob.detailCheckedAt = detailStamp;
      else delete observedJob.detailCheckedAt;
      detailed.push(observedJob);
      detailAttempts.push({ jobId: job.id, ok: outcome === "success",
        status, outcome });
      diagnosticEvents.push(diagnosticEvent("detail", status, success ? "success"
        : outcome === "not_attempted" ? "not_attempted"
          : outcome === "extraction_failed" ? "extraction_failed" : "http_failed"));
    } catch (error) {
      const status = httpStatus(error && error.status);
      const reason = classifyAccessStop(status, "");
      detailed.push(job);
      detailAttempts.push({ jobId: job.id, ok: false, status: status || 0, outcome: "fetch_failed" });
      diagnosticEvents.push(diagnosticEvent("detail", status, reason || "network_failed"));
      if (reason) { aborted = true; break; }
    }
  }
  abortIfRequired();

  const attemptsCompletedAt = clock();
  if (!(attemptsCompletedAt instanceof Date) || !Number.isFinite(attemptsCompletedAt.getTime())
    || attemptsCompletedAt < now) throw new Error("invalid_collection_clock");
  for (const [index, attempt] of detailAttempts.entries()) {
    if (attempt.ok && Date.parse(detailed[index].detailCheckedAt) > attemptsCompletedAt.getTime()) {
      attempt.ok = false;
      attempt.outcome = "extraction_failed";
      const event = diagnosticEvents[retrievalAttempts.length + index];
      if (event) event.reason = "extraction_failed";
      delete detailed[index].detailCheckedAt;
    }
  }
  const confirmedIds = new Set(detailAttempts.filter((attempt) => attempt.ok).map((attempt) => String(attempt.jobId)));
  const candidates = detailed
    .map((job) => ({ ...job, analysis: classifyJob(job) }))
    .filter((job) => job.analysis.canExecute && !isExpired(job, now))
    .sort(compareJobs);
  const confirmedCandidates = candidates.filter((job) => confirmedIds.has(String(job.id)));
  const recommendation = confirmedCandidates.find(hasValidExpiry) || null;
  const collectionObserved = retrievalAttempts.some((attempt) => attempt.complete)
    || jobs.length > 0;
  const report = {
    generatedAt: now.toISOString(),
    generatedAtJst: formatJst(now),
    keywords: keywords.map(sanitizeSummaryText),
    attempts,
    totalJobs: collectionObserved ? jobs.length : null,
    safeCandidates: collectionObserved ? candidates.length : null,
    recommendation: recommendation ? decorateRecommendation(recommendation) : null,
    collection: {
      schemaVersion: 1,
      status: "attempts_completed",
      startedAt: now.toISOString(),
      attemptsCompletedAt: attemptsCompletedAt.toISOString(),
      decisionAsOf: now.toISOString(),
      search: attemptCounts(retrievalAttempts, keywords.length, "planned"),
      details: attemptCounts(detailAttempts, jobs.length, "observed"),
      candidates: {
        machine: collectionObserved ? candidates.length : null,
        detailConfirmed: collectionObserved ? confirmedCandidates.length : null,
        detailUnconfirmed: collectionObserved ? candidates.length - confirmedCandidates.length : null
      }
    }
  };

  if (lifecycle) lifecycle.collectionCompleted(diagnostics());
  if (typeof options.onDiagnostics === "function") options.onDiagnostics(diagnostics());

  const currentJobs = upsertJobs(jobs, detailed);
  const clientReview = reviewClientHistories(options.publicHistories || [], {
    currentJobs: currentJobs.filter((job) => job.publicClient).map((job) => ({
      platform: "crowdworks", profileId: job.publicClient.profileId,
      profileUrl: job.publicClient.url, jobId: job.id, url: job.url,
      visibility: "public", phase: "current", observedAt: now.toISOString()
    }))
  });
  const snapshot = buildSnapshot({ jobs: currentJobs,
    candidateIds: candidates.map((job) => job.id), attempts: retrievalAttempts,
    detailAttempts, now, clientReview });
  if (lifecycle) lifecycle.persistenceStarted();
  privateCandidateStore.save({ snapshot, summary: report });
  const saved = saveSnapshot(evidenceDir, snapshot, {
    baselinePath: options.baselinePath || path.join(__dirname, "..", "collector-data", "latest.json")
  });
  writeJson(path.join(evidenceDir, "latest.client-review.json"), clientReview);
  writeJson(path.join(evidenceDir, "client-reviews", `${saved.snapshot.runId}.json`), clientReview);
  writeReport(outputDir, report);
  return report;
}

function attemptCounts(attempts, total, totalKey) {
  const attempted = attempts.filter((attempt) => attempt.outcome !== "not_attempted").length;
  const succeeded = attempts.filter((attempt) => attempt.ok).length;
  return { [totalKey]: total, attempted, succeeded, failed: attempted - succeeded, notAttempted: total - attempted };
}

function resolvedLocation(directory) {
  let ancestor = directory;
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.resolve(fs.realpathSync(ancestor), ...suffix);
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function assertSeparateOutputs(outputDir, evidenceDir) {
  const publicOutput = resolvedLocation(outputDir);
  const internalOutput = resolvedLocation(evidenceDir);
  const repositorySummaries = resolvedLocation(path.join(__dirname, "..", "collector-data"));
  if (containsPath(publicOutput, internalOutput) || containsPath(internalOutput, publicOutput)
    || containsPath(repositorySummaries, internalOutput) || containsPath(internalOutput, repositorySummaries)) {
    throw new Error("internal_evidence_must_be_separate_from_public_outputs");
  }
}

function isValidPublicJob(job) {
  return Boolean(normalizePublicJobRef({ platform: "crowdworks", id: job && job.id, url: job && job.url }));
}

function isExpired(job, now) {
  if (!job.expiresAt) return false;
  const end = new Date(`${job.expiresAt}T23:59:59+09:00`);
  return Number.isFinite(end.getTime()) && end < now;
}

function hasValidExpiry(job) {
  // Keep legacy machine counts and the start-time expiry rule. An invalid
  // calendar date cannot establish a valid deadline for a recommendation.
  return job.expiresAt === undefined || job.expiresAt === null || job.expiresAt === ""
    || (typeof job.expiresAt === "string"
    && normalizePublicTimestamp(`${job.expiresAt}T23:59:59+09:00`) !== null);
}

function compareJobs(a, b) {
  const scoreA = a.analysis ? a.analysis.score : 0;
  const scoreB = b.analysis ? b.analysis.score : 0;
  if (scoreA !== scoreB) return scoreB - scoreA;
  return Number(b.analysis && b.analysis.budgetYen || 0)
    - Number(a.analysis && a.analysis.budgetYen || 0);
}

function decorateRecommendation(job) {
  const reasons = [];
  const analysis = job.analysis || {};
  if ((analysis.strongSignals || []).length) {
    reasons.push(`自動化と相性のよい要素: ${analysis.strongSignals.slice(0, 4).join("、")}`);
  }
  if (analysis.budgetYen) reasons.push(`募集文から確認できた報酬上限: ${analysis.budgetYen.toLocaleString("ja-JP")}円`);
  reasons.push("危険キーワードとAI利用禁止表現は検出されませんでした");
  if (job.detailCheckedAt) reasons.push("案件詳細ページの本文でも再判定済みです");
  reasons.push("機械判定の結果です。AI利用許可・採算・応募資格・安全性は別途確認が必要です");
  const allowed = ["id", "title", "budget", "category", "description", "status", "expiresAt",
    "applications", "importedAt", "detailCheckedAt"];
  const result = Object.fromEntries(allowed.filter((key) => typeof job[key] === "string"
    || (key === "applications" && Number.isFinite(job[key])) || (key === "id" && Number.isSafeInteger(job[key])))
    .map((key) => [key, typeof job[key] === "string" ? sanitizeSummaryText(job[key]) : job[key]]));
  result.url = normalizePublicJobRef({ platform: "crowdworks", id: job.id, url: job.url }).url;
  const source = typeof job.sourceUrl === "string" && job.sourceUrl.match(/^https:\/\/crowdworks\.jp\/public\/jobs\/search(?:[?#].*)?$/);
  result.sourceUrl = source ? "https://crowdworks.jp/public/jobs/search" : "";
  return { ...result, analysis: classifyJob(job), selectionReasons: reasons };
}

function sanitizeSummaryText(value) {
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[連絡先省略]")
    .replace(/(?:\+81[-\s]?)?0\d{1,4}[-\s]\d{1,4}[-\s]\d{3,4}/g, "[連絡先省略]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|AKIA[A-Z0-9]{16})\b/g, "[秘密情報省略]")
    .replace(/(?:氏名|本名|住所|電話番号|メール(?:アドレス)?|LINE\s*ID|password|secret|token|api[_ -]?key|authorization)\s*[:：=]\s*[^\n。;,]+/gi, "[個人・秘密情報省略]");
}

function writeReport(outputDir, report) {
  ensureDir(outputDir);
  writeJson(path.join(outputDir, "latest.json"), report);
  fs.writeFileSync(path.join(outputDir, "index.html"), renderHtml(report), "utf8");
  fs.writeFileSync(path.join(outputDir, "latest.md"), renderMarkdown(report), "utf8");
  fs.writeFileSync(path.join(outputDir, ".nojekyll"), "", "utf8");
}

function renderHtml(report) {
  const job = report.recommendation;
  const attemptsOk = report.attempts.filter((attempt) => attempt.ok).length;
  const unconfirmedCandidates = report.safeCandidates !== null && report.safeCandidates > 0;
  const detailCount = report.collection && report.collection.candidates.detailConfirmed;
  const content = job ? `
    <article class="recommendation">
      <div class="score" aria-label="自動化適性スコア ${job.analysis.score}">
        <span>${job.analysis.score}</span><small>/ 100</small>
      </div>
      <div class="job-body">
        <p class="eyebrow">本日のおすすめ</p>
        <h2>${escapeHtml(job.title)}</h2>
        <div class="facts">
          ${job.budget ? `<span>${escapeHtml(job.budget)}</span>` : ""}
          ${job.category ? `<span>${escapeHtml(job.category)}</span>` : ""}
          ${Number.isFinite(job.applications) ? `<span>応募 ${job.applications}件</span>` : ""}
          ${job.expiresAt ? `<span>掲載期限 ${escapeHtml(job.expiresAt)}</span>` : ""}
        </div>
        <p class="description">${escapeHtml(job.description || "案件詳細を開いて内容を確認してください。")}</p>
        <h3>選定理由</h3>
        <ul>${job.selectionReasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
        <a class="primary" href="${escapeAttr(job.url)}" target="_blank" rel="noreferrer">クラウドワークスで確認</a>
      </div>
    </article>` : `
    <div class="empty">
      <h2>${report.totalJobs === null ? "取得状況を確認してください" : unconfirmedCandidates ? detailCount > 0 ? "推薦条件を確認してください" : "詳細確認済みの推薦候補はありません" : "機械判定の候補が見つかりませんでした"}</h2>
      <p>${report.totalJobs === null ? "資料を取得できず、案件数は未確認です。" : unconfirmedCandidates ? detailCount > 0 ? "詳細確認済みの機械候補はありますが、掲載期限などの推薦条件を確認できませんでした。" : "機械候補はありますが、この実行で詳細本文を確認できていないため推薦していません。" : "取得範囲内の判定です。公開履歴や規約を本人が確認してください。"}</p>
    </div>`;

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#176b5b">
  <title>CloudWorks Daily Pick</title>
  <style>
    :root { color-scheme: light; --ink:#182126; --muted:#617078; --line:#d8e0df; --bg:#eef3f1; --panel:#fff; --teal:#176b5b; --teal-dark:#105044; --amber:#a85f08; }
    * { box-sizing:border-box; }
    body { margin:0; color:var(--ink); background:var(--bg); font-family:"Segoe UI",system-ui,-apple-system,sans-serif; line-height:1.6; }
    header { background:#fff; border-bottom:1px solid var(--line); }
    .topbar, main { width:min(100% - 32px, 900px); margin:0 auto; }
    .topbar { min-height:72px; display:flex; align-items:center; justify-content:space-between; gap:16px; }
    h1 { margin:0; font-size:20px; letter-spacing:0; }
    .header-actions { display:flex; align-items:center; gap:12px; }
    .updated { color:var(--muted); font-size:12px; text-align:right; }
    .refresh { display:inline-flex; min-height:36px; align-items:center; justify-content:center; padding:7px 10px; color:var(--teal); background:#fff; border:1px solid var(--teal); border-radius:7px; font-size:13px; font-weight:700; text-decoration:none; white-space:nowrap; }
    .refresh:hover { color:#fff; background:var(--teal); }
    main { padding:24px 0 44px; }
    .summary { display:flex; gap:18px; margin-bottom:18px; color:var(--muted); font-size:13px; }
    .summary strong { color:var(--ink); font-size:16px; }
    .recommendation { display:grid; grid-template-columns:112px minmax(0,1fr); gap:24px; padding:24px; background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    .score { width:96px; height:96px; display:grid; place-content:center; text-align:center; color:#fff; background:var(--teal); border-radius:8px; }
    .score span { font-size:34px; font-weight:800; line-height:1; }
    .score small { margin-top:4px; font-size:12px; }
    .eyebrow { margin:0 0 5px; color:var(--amber); font-weight:700; font-size:13px; }
    h2 { margin:0; font-size:22px; line-height:1.4; letter-spacing:0; overflow-wrap:anywhere; }
    h3 { margin:20px 0 6px; font-size:14px; }
    .facts { display:flex; flex-wrap:wrap; gap:6px; margin-top:12px; }
    .facts span { padding:4px 8px; border:1px solid var(--line); border-radius:6px; color:var(--muted); font-size:12px; }
    .description { margin:18px 0 0; color:#46545a; display:-webkit-box; -webkit-line-clamp:7; -webkit-box-orient:vertical; overflow:hidden; }
    ul { margin:0; padding-left:20px; }
    .primary { display:inline-flex; min-height:44px; margin-top:22px; padding:9px 16px; align-items:center; justify-content:center; color:#fff; background:var(--teal); border-radius:7px; font-weight:700; text-decoration:none; }
    .primary:hover { background:var(--teal-dark); }
    .empty { padding:32px; background:#fff; border:1px solid var(--line); border-radius:8px; }
    footer { width:min(100% - 32px, 900px); margin:0 auto 28px; color:var(--muted); font-size:12px; }
    @media (max-width:640px) {
      .topbar { padding:14px 0; align-items:flex-start; flex-direction:column; }
      .header-actions { width:100%; justify-content:space-between; }
      .updated { text-align:left; }
      main { padding-top:18px; }
      .summary { gap:12px; justify-content:space-between; }
      .recommendation { grid-template-columns:1fr; gap:16px; padding:18px; }
      .score { width:88px; height:72px; }
      h2 { font-size:19px; }
      .primary { width:100%; }
    }
  </style>
</head>
<body>
  <header><div class="topbar"><h1>CloudWorks Daily Pick</h1><div class="header-actions"><a class="refresh" href="https://github.com/amindjapan/cw-work-agent-daily/actions/workflows/daily.yml" target="_blank" rel="noreferrer">今すぐ更新</a><div class="updated">最終更新<br>${escapeHtml(report.generatedAtJst)}</div></div></div></header>
  <main>
    <div class="summary"><span><strong>${attemptsOk}</strong> 検索成功</span><span><strong>${report.totalJobs === null ? "未確認" : report.totalJobs}</strong> 件取得</span><span><strong>${report.safeCandidates === null ? "未確認" : report.safeCandidates}</strong> 件機械候補</span><span><strong>${detailCount === null || detailCount === undefined ? "UNKNOWN" : detailCount}</strong> 件詳細確認済み候補</span></div>
    <p class="updated">収集開始: ${escapeHtml(report.collection ? report.collection.startedAt : report.generatedAt)} / 取得試行完了: ${escapeHtml(report.collection ? report.collection.attemptsCompletedAt : "UNKNOWN")} / 判定基準: ${escapeHtml(report.collection ? report.collection.decisionAsOf : report.generatedAt)}</p>
    ${content}
  </main>
  <footer>応募・契約・送信は自動実行しません。案件本文、規約、AI利用条件を本人が確認してから進めてください。</footer>
</body>
</html>`;
}

function renderMarkdown(report) {
  const job = report.recommendation;
  if (!job) return `# 本日のおすすめ\n\n${report.generatedAtJst}: ${report.totalJobs === null ? "資料を取得できず、件数は未確認です。" : report.safeCandidates > 0 ? report.collection && report.collection.candidates.detailConfirmed > 0 ? "詳細確認済みの機械候補はありますが、掲載期限などの推薦条件を確認できませんでした。" : "機械候補はありますが、この実行で詳細確認済みの推薦候補はありません。" : "取得範囲内で機械判定の候補はありませんでした。"}\n`;
  return [
    "# 本日のおすすめ",
    "",
    `## ${job.title}`,
    "",
    `- スコア: ${job.analysis.score}/100`,
    job.budget ? `- 報酬: ${job.budget}` : "",
    job.expiresAt ? `- 掲載期限: ${job.expiresAt}` : "",
    `- URL: ${job.url}`,
    "",
    ...job.selectionReasons.map((reason) => `- ${reason}`)
  ].filter(Boolean).join("\n") + "\n";
}

function formatJst(date) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

async function runCli(args = process.argv.slice(2)) {
  try {
    const argumentPath = (flag) => {
      const index = args.indexOf(flag);
      return index >= 0 ? path.resolve(args[index + 1]) : undefined;
    };
    const outputDir = argumentPath("--output");
    const evidenceDir = argumentPath("--evidence-output");
    const historyPath = argumentPath("--public-histories");
    const attemptDirectory = argumentPath("--attempt-output");
    const argumentValue = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
    const attemptRecord = attemptDirectory === undefined ? undefined : {
      directory: attemptDirectory, runId: argumentValue("--attempt-run-id"),
      runAttempt: argumentValue("--attempt-number") === undefined ? 1 : Number(argumentValue("--attempt-number")),
      sourceCommit: argumentValue("--source-commit"), workflowPath: "local"
    };
    let publicHistories = [];
    if (historyPath) {
      const evidence = JSON.parse(fs.readFileSync(historyPath, "utf8"));
      publicHistories = Array.isArray(evidence) ? evidence : evidence.histories;
      if (!Array.isArray(publicHistories)) throw new Error("invalid_public_history_input");
    }
    await runDaily({ outputDir, evidenceDir, publicHistories, attemptRecord,
      onDiagnostics: (diagnostics) => console.log(JSON.stringify(diagnostics)) });
    return 0;
  } catch (error) {
    console.error(JSON.stringify(error instanceof CollectionAbortedError ? error.diagnostics
      : { kind: "collector_error", stage: "collector", httpStatus: null, reason: "collector_failed" }));
    return 1;
  }
}

if (require.main === module) {
  runCli().then((code) => { process.exitCode = code; });
}

module.exports = {
  DEFAULT_KEYWORDS,
  compareJobs,
  renderHtml,
  runDaily
};
