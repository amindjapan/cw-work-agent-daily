"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { classifyJob, normalizeText } = require("./model");
const { normalizePublicJobRef, normalizePublicProfileRef, normalizePublicTimestamp } = require("./public-evidence");
const { sanitizeClientHistoryReview } = require("./client-history");

const CONTENT_FIELDS = ["title", "description", "budget", "category", "status", "expiresAt", "applications"];
const OUTCOMES = new Set(["success", "fetch_failed", "extraction_failed", "not_attempted"]);
const HASH = /^[a-f0-9]{64}$/;
const SCOPE = /^scope-[a-f0-9]{64}$/;

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function timestamp(value, fallback = null) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : fallback;
  return normalizePublicTimestamp(value) || fallback;
}

function nonnegativeInteger(value, fallback = null) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function ids(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" || typeof value === "number")
    .map(String).filter((value) => /^\d+$/.test(value)))].sort();
}

function searchScopeId({ keyword = "", page = 1, categoryId = "", platform = "crowdworks" } = {}) {
  // A query may contain contact information. Persist only the hash of its scope.
  return `scope-${hash(stableJson({ platform, keyword: String(keyword), page, categoryId: String(categoryId) }))}`;
}

function normalizeSearchAttempt(attempt = {}) {
  if (!attempt || typeof attempt !== "object") attempt = {};
  const scopeId = SCOPE.test(attempt.scopeId) ? attempt.scopeId : searchScopeId(attempt);
  const hasIds = Array.isArray(attempt.observedIds) || Array.isArray(attempt.jobIds);
  const observedIds = ids(attempt.observedIds || attempt.jobIds);
  const status = nonnegativeInteger(attempt.status);
  const httpSucceeded = status === null || (status >= 200 && status < 300);
  let outcome = OUTCOMES.has(attempt.outcome) ? attempt.outcome : attempt.ok ? "success" : "fetch_failed";
  if (outcome === "success" && (attempt.ok !== true || !httpSucceeded)) outcome = "fetch_failed";
  if (outcome === "success" && (!hasIds || nonnegativeInteger(attempt.imported) === null)) outcome = "extraction_failed";
  const complete = outcome === "success" && hasIds && attempt.complete !== false
    && attempt.imported >= observedIds.length;
  return {
    scopeId,
    page: nonnegativeInteger(attempt.page, 1),
    ok: outcome === "success",
    status,
    outcome,
    complete,
    imported: outcome === "success" ? nonnegativeInteger(attempt.imported) : null,
    observedIds
  };
}

function normalizeDetailAttempt(attempt = {}) {
  if (!attempt || typeof attempt !== "object") return null;
  const jobId = ids([attempt.jobId || attempt.id])[0];
  if (!jobId) return null;
  const status = nonnegativeInteger(attempt.status);
  let outcome = OUTCOMES.has(attempt.outcome) ? attempt.outcome : attempt.ok ? "success" : "fetch_failed";
  if (outcome === "success" && (attempt.ok !== true || (status !== null && (status < 200 || status >= 300)))) {
    outcome = "fetch_failed";
  }
  return { jobId, ok: outcome === "success", status, outcome };
}

function machineJudgment(job) {
  // Recompute: never preserve caller-provided analysis, reasons, or free text.
  const analysis = classifyJob(job);
  return {
    canExecute: analysis.canExecute,
    score: analysis.score,
    level: analysis.level,
    matchedSkills: [...analysis.matchedSkills].sort(),
    strongSignals: [...analysis.strongSignals].sort(),
    riskFlags: [...analysis.riskFlags].sort(),
    budgetYen: analysis.budgetYen,
    reasonCodes: [
      ...(analysis.matchedSkills.length ? ["matched_skill"] : []),
      ...(analysis.strongSignals.length ? ["strong_signal"] : []),
      ...(analysis.riskFlags.length ? ["risk_keyword"] : []),
      ...(analysis.budgetYen !== null ? ["budget_detected"] : []),
      analysis.canExecute ? "machine_candidate" : "machine_not_candidate"
    ].sort()
  };
}

function buildSnapshot({ jobs = [], candidateIds = [], attempts = [], detailAttempts = [], now = new Date(), clientReview } = {}) {
  const generatedAt = timestamp(now);
  if (!generatedAt) throw new TypeError("Collector snapshot requires a valid collection time");
  const search = attempts.map(normalizeSearchAttempt).sort((a, b) => a.scopeId.localeCompare(b.scopeId));
  const details = detailAttempts.map(normalizeDetailAttempt).filter(Boolean)
    .sort((a, b) => a.jobId.localeCompare(b.jobId));
  const records = new Map();
  const duplicateIds = new Set();
  const conflictingDuplicateIds = new Set();
  let invalidJobCount = 0;
  for (const job of jobs) {
    const ref = job && normalizePublicJobRef({ platform: job.platform || "crowdworks", id: job.id, url: job.url });
    // This Collector's search and candidate-ID contracts are CrowdWorks-only.
    if (!ref || ref.platform !== "crowdworks") { invalidJobCount++; continue; }
    const contentHashes = Object.fromEntries(CONTENT_FIELDS.map((field) => [field, hash(normalizeText(job[field]))]));
    const fetchedAt = timestamp(job.detailCheckedAt, timestamp(job.importedAt, generatedAt));
    const relevantDetails = details.filter((attempt) => attempt.jobId === ref.jobId);
    const detailStatus = relevantDetails.length ? relevantDetails[relevantDetails.length - 1].outcome : "not_attempted";
    const detailObserved = timestamp(job.detailCheckedAt) && detailStatus === "success";
    const profileRef = normalizePublicProfileRef(job.publicClient);
    const record = {
      platform: ref.platform,
      id: ref.jobId,
      url: ref.url,
      fetchedAt,
      observedIn: search.filter((attempt) => attempt.observedIds.includes(ref.jobId)).map((attempt) => attempt.scopeId),
      contentHashes,
      contentSources: Object.fromEntries(CONTENT_FIELDS.map((field) => [field,
        ["description", "budget"].includes(field) && job.contentSources && ["detail", "search"].includes(job.contentSources[field])
          ? job.contentSources[field] : detailObserved && ["description", "budget"].includes(field) ? "detail" : "search"])),
      machineJudgment: machineJudgment(job),
      detailStatus,
      candidate: false
    };
    if (profileRef && profileRef.platform === ref.platform) record.profileRef = profileRef;
    record.observedIn = [...new Set(record.observedIn)].sort();
    const existing = records.get(record.id);
    if (existing) {
      duplicateIds.add(record.id);
      if (stableJson(existing.contentHashes) !== stableJson(contentHashes)
        || stableJson(existing.profileRef || null) !== stableJson(record.profileRef || null)) conflictingDuplicateIds.add(record.id);
      // Select one actual observation; do not synthesize a merged job body.
      if (record.fetchedAt < existing.fetchedAt
        || (record.fetchedAt === existing.fetchedAt && stableJson(record) < stableJson(existing))) continue;
    }
    records.set(record.id, record);
  }
  const requestedCandidates = ids(candidateIds);
  const selectedCandidates = requestedCandidates.filter((id) => records.has(id) && records.get(id).machineJudgment.canExecute);
  for (const id of selectedCandidates) records.get(id).candidate = true;
  const outputJobs = [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const attempt of search) {
    if (attempt.observedIds.some((id) => !records.has(id))) attempt.complete = false;
  }
  const successful = search.filter((attempt) => attempt.ok);
  const observed = outputJobs.length > 0 || (successful.length > 0 && invalidJobCount === 0);
  const snapshot = {
    schemaVersion: 1,
    kind: "collector_snapshot",
    platform: "crowdworks",
    generatedAt,
    jobs: outputJobs,
    candidateIds: selectedCandidates,
    retrieval: { search, details },
    coverage: {
      status: !search.length ? "not_attempted" : !successful.length ? "failed"
        : search.every((attempt) => attempt.complete) ? "complete" : "partial",
      retrievedJobCount: observed ? outputJobs.length : null,
      candidateCount: observed ? selectedCandidates.length : null,
      scopeMeaning: "configured_search_pages_only"
    },
    quality: {
      duplicateIds: [...duplicateIds].sort(),
      conflictingDuplicateIds: [...conflictingDuplicateIds].sort(),
      invalidJobCount,
      unobservedCandidateIds: requestedCandidates.filter((id) => !records.has(id)),
      rejectedCandidateIds: requestedCandidates.filter((id) => records.has(id) && !records.get(id).machineJudgment.canExecute)
    }
  };
  if (clientReview !== undefined) snapshot.clientReview = sanitizeClientHistoryReview(clientReview);
  return finalize(snapshot);
}

function finalize(snapshot) {
  const runId = `${snapshot.generatedAt.replace(/[-:.]/g, "")}-${hash(stableJson(snapshot)).slice(0, 16)}`;
  return { ...snapshot, runId };
}

function knownKeywords(values, field) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string"
    && classifyJob({ title: value })[field].includes(value)))].sort();
}

function sanitizeSavedSnapshot(value) {
  if (!value || value.kind !== "collector_snapshot" || value.schemaVersion !== 1
    || !timestamp(value.generatedAt) || !Array.isArray(value.jobs)
    || !value.retrieval || !Array.isArray(value.retrieval.search) || !Array.isArray(value.retrieval.details)
    || [...value.retrieval.search, ...value.retrieval.details].some((attempt) => !attempt || typeof attempt !== "object")) return null;
  const jobs = [];
  for (const job of value.jobs) {
    if (!job || typeof job !== "object") return null;
    const ref = normalizePublicJobRef({ platform: job.platform, id: job.id, url: job.url });
    if (!ref || ref.platform !== "crowdworks" || !job.contentHashes || CONTENT_FIELDS.some((field) => !HASH.test(job.contentHashes[field]))
      || !job.machineJudgment || !timestamp(job.fetchedAt)) return null;
    const judgment = job.machineJudgment;
    const record = {
      platform: ref.platform, id: ref.jobId, url: ref.url, fetchedAt: timestamp(job.fetchedAt),
      observedIn: [...new Set((Array.isArray(job.observedIn) ? job.observedIn : []).filter((scope) => SCOPE.test(scope)))].sort(),
      contentHashes: Object.fromEntries(CONTENT_FIELDS.map((field) => [field, job.contentHashes[field]])),
      contentSources: Object.fromEntries(CONTENT_FIELDS.map((field) => [field,
        job.contentSources && ["search", "detail"].includes(job.contentSources[field]) ? job.contentSources[field] : "unknown"])),
      machineJudgment: {
        canExecute: judgment.canExecute === true,
        score: Number.isFinite(judgment.score) ? Math.min(100, Math.max(0, judgment.score)) : 0,
        level: ["high", "medium", "low"].includes(judgment.level) ? judgment.level : "low",
        matchedSkills: knownKeywords(judgment.matchedSkills, "matchedSkills"),
        strongSignals: knownKeywords(judgment.strongSignals, "strongSignals"),
        riskFlags: knownKeywords(judgment.riskFlags, "riskFlags"),
        budgetYen: nonnegativeInteger(judgment.budgetYen),
        reasonCodes: [...new Set((Array.isArray(judgment.reasonCodes) ? judgment.reasonCodes : [])
          .filter((code) => ["matched_skill", "strong_signal", "risk_keyword", "budget_detected", "machine_candidate", "machine_not_candidate"].includes(code)))].sort()
      },
      detailStatus: OUTCOMES.has(job.detailStatus) ? job.detailStatus : "not_attempted",
      candidate: job.candidate === true
    };
    const profileRef = normalizePublicProfileRef(job.profileRef);
    if (profileRef && profileRef.platform === ref.platform) record.profileRef = profileRef;
    jobs.push(record);
  }
  if (new Set(jobs.map((job) => job.id)).size !== jobs.length) return null;
  const search = value.retrieval.search.map(normalizeSearchAttempt);
  const details = value.retrieval.details.map(normalizeDetailAttempt).filter(Boolean);
  const quality = value.quality || {};
  const invalidJobCount = nonnegativeInteger(quality.invalidJobCount, 0);
  for (const attempt of search) {
    if (attempt.observedIds.some((id) => !jobs.some((job) => job.id === id))) attempt.complete = false;
  }
  const observed = jobs.length > 0 || (search.some((attempt) => attempt.ok) && invalidJobCount === 0);
  const snapshot = {
    schemaVersion: 1, kind: "collector_snapshot", platform: "crowdworks", generatedAt: timestamp(value.generatedAt),
    jobs: jobs.sort((a, b) => a.id.localeCompare(b.id)), candidateIds: ids(value.candidateIds).filter((id) => jobs.some((job) => job.id === id && job.candidate)),
    retrieval: { search, details },
    coverage: {
      status: !search.length ? "not_attempted" : !search.some((attempt) => attempt.ok) ? "failed"
        : search.every((attempt) => attempt.complete) ? "complete" : "partial",
      retrievedJobCount: observed ? jobs.length : null,
      candidateCount: observed ? ids(value.candidateIds).filter((id) => jobs.some((job) => job.id === id && job.candidate)).length : null,
      scopeMeaning: "configured_search_pages_only"
    },
    quality: {
      duplicateIds: ids(quality.duplicateIds), conflictingDuplicateIds: ids(quality.conflictingDuplicateIds),
      invalidJobCount, unobservedCandidateIds: ids(quality.unobservedCandidateIds), rejectedCandidateIds: ids(quality.rejectedCandidateIds)
    }
  };
  if (value.clientReview !== undefined) snapshot.clientReview = sanitizeClientHistoryReview(value.clientReview);
  return finalize(snapshot);
}

function baselineStatus(previous) {
  if (!previous) return { status: "missing", snapshot: null };
  if (previous.status && previous.status !== "available") {
    return { status: ["missing", "invalid", "legacy_summary"].includes(previous.status) ? previous.status : "invalid", snapshot: null };
  }
  const snapshot = sanitizeSavedSnapshot(previous.snapshot || previous);
  if (snapshot) return { status: "available", snapshot };
  if (previous.totalJobs !== undefined || previous.safeCandidates !== undefined) return { status: "legacy_summary", snapshot: null };
  return { status: "invalid", snapshot: null };
}

function compareSnapshots(previous, current) {
  const after = sanitizeSavedSnapshot(current);
  if (!after) throw new TypeError("Invalid current Collector snapshot");
  const baseline = baselineStatus(previous);
  const diff = {
    schemaVersion: 1, kind: "collector_diff", runId: after.runId, generatedAt: after.generatedAt,
    baselineStatus: baseline.status,
    previousRunId: baseline.snapshot ? baseline.snapshot.runId : null,
    added: [], firstObserved: [], changed: [], comparisonInsufficient: [], disappeared: [], notObserved: [],
    retrievalFailures: [
      ...after.retrieval.search.filter((attempt) => !attempt.ok && attempt.outcome !== "not_attempted")
        .map((attempt) => ({ type: "search", scopeId: attempt.scopeId, outcome: attempt.outcome, status: attempt.status })),
      ...after.retrieval.details.filter((attempt) => !attempt.ok && attempt.outcome !== "not_attempted")
        .map((attempt) => ({ type: "detail", jobId: attempt.jobId, outcome: attempt.outcome, status: attempt.status }))
    ],
    limitations: ["disappearance_does_not_establish_closure_or_violation", "coverage_is_configured_search_pages_only"]
  };
  if (!baseline.snapshot) {
    diff.limitations.push("baseline_insufficient_for_change_detection");
    return diff;
  }
  const beforeJobs = new Map(baseline.snapshot.jobs.map((job) => [job.id, job]));
  const afterJobs = new Map(after.jobs.map((job) => [job.id, job]));
  for (const job of after.jobs) {
    const before = beforeJobs.get(job.id);
    if (!before) {
      const priorScopes = job.observedIn.map((scopeId) => baseline.snapshot.retrieval.search.filter((attempt) => attempt.scopeId === scopeId));
      const presenceWasObservable = baseline.snapshot.quality.invalidJobCount === 0 && priorScopes.length > 0
        && priorScopes.every((attempts) => attempts.length > 0 && attempts.every((attempt) => attempt.complete && !attempt.observedIds.includes(job.id)));
      if (presenceWasObservable) diff.added.push({ id: job.id, url: job.url });
      else diff.firstObserved.push({ id: job.id, url: job.url, reason: "previous_presence_unknown" });
      continue;
    }
    const incomparable = CONTENT_FIELDS.filter((field) => before.contentSources[field] === "unknown"
      || job.contentSources[field] === "unknown" || before.contentSources[field] !== job.contentSources[field]);
    const fields = CONTENT_FIELDS.filter((field) => !incomparable.includes(field) && before.contentHashes[field] !== job.contentHashes[field]);
    const machineComparable = !["title", "description", "budget", "category"].some((field) => incomparable.includes(field));
    if (machineComparable && stableJson(before.machineJudgment) !== stableJson(job.machineJudgment)) fields.push("machineJudgment");
    if (machineComparable && before.candidate !== job.candidate) fields.push("candidate");
    if (!machineComparable) incomparable.push("machineJudgment", "candidate");
    if (incomparable.length) diff.comparisonInsufficient.push({ id: job.id, url: job.url, fields: incomparable, reason: "source_level_changed_or_unknown" });
    if (fields.length) diff.changed.push({ id: job.id, url: job.url, fields });
  }
  for (const job of baseline.snapshot.jobs) {
    if (afterJobs.has(job.id)) continue;
    const scopeAttempts = job.observedIn.map((scopeId) => after.retrieval.search.filter((attempt) => attempt.scopeId === scopeId));
    const covered = after.quality.invalidJobCount === 0 && job.observedIn.length > 0
      && scopeAttempts.every((attempts) => attempts.length > 0 && attempts.every((attempt) => attempt.complete && !attempt.observedIds.includes(job.id)));
    if (covered) diff.disappeared.push({ id: job.id, url: job.url, observedIn: job.observedIn, meaning: "absent_from_retrieved_list" });
    else diff.notObserved.push({ id: job.id, url: job.url, reason: !job.observedIn.length ? "baseline_source_unknown" : "coverage_insufficient" });
  }
  return diff;
}

function readBaseline(outputDir, { baselinePath } = {}) {
  const latestPath = path.join(outputDir, "latest.snapshot.json");
  for (const file of [latestPath, ...(baselinePath ? [baselinePath] : [])]) {
    let value;
    try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      return { status: "invalid", snapshot: null };
    }
    return baselineStatus(value);
  }
  return { status: "missing", snapshot: null };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sanitizeSavedDiff(value, snapshot) {
  if (!value || value.kind !== "collector_diff" || value.schemaVersion !== 1 || value.runId !== snapshot.runId) {
    throw new TypeError("Invalid saved Collector diff");
  }
  const state = ["available", "missing", "invalid", "legacy_summary"].includes(value.baselineStatus) ? value.baselineStatus : "invalid";
  const refs = (entries, decorate) => (Array.isArray(entries) ? entries : []).flatMap((entry) => {
    const ref = entry && normalizePublicJobRef({ platform: "crowdworks", id: entry.id, url: entry.url });
    return ref ? [{ id: ref.jobId, url: ref.url, ...decorate(entry) }] : [];
  });
  const fields = (values) => [...new Set((Array.isArray(values) ? values : [])
    .filter((field) => [...CONTENT_FIELDS, "machineJudgment", "candidate"].includes(field)))];
  return {
    schemaVersion: 1, kind: "collector_diff", runId: snapshot.runId, generatedAt: snapshot.generatedAt,
    baselineStatus: state,
    previousRunId: /^\d{8}T\d{9}Z-[a-f0-9]{16}$/.test(value.previousRunId) ? value.previousRunId : null,
    added: refs(value.added, () => ({})),
    firstObserved: refs(value.firstObserved, () => ({ reason: "previous_presence_unknown" })),
    changed: refs(value.changed, (entry) => ({ fields: fields(entry.fields) })),
    comparisonInsufficient: refs(value.comparisonInsufficient, (entry) => ({ fields: fields(entry.fields), reason: "source_level_changed_or_unknown" })),
    disappeared: refs(value.disappeared, (entry) => ({ observedIn: [...new Set((Array.isArray(entry.observedIn) ? entry.observedIn : []).filter((scope) => SCOPE.test(scope)))], meaning: "absent_from_retrieved_list" })),
    notObserved: refs(value.notObserved, (entry) => ({ reason: entry.reason === "baseline_source_unknown" ? "baseline_source_unknown" : "coverage_insufficient" })),
    retrievalFailures: (Array.isArray(value.retrievalFailures) ? value.retrievalFailures : []).flatMap((entry) => {
      if (!entry || !["fetch_failed", "extraction_failed"].includes(entry.outcome)) return [];
      const evidence = { outcome: entry.outcome, status: nonnegativeInteger(entry.status) };
      if (entry.type === "search" && SCOPE.test(entry.scopeId)) return [{ type: "search", scopeId: entry.scopeId, ...evidence }];
      const jobId = ids([entry.jobId])[0];
      return entry.type === "detail" && jobId ? [{ type: "detail", jobId, ...evidence }] : [];
    }),
    limitations: ["disappearance_does_not_establish_closure_or_violation", "coverage_is_configured_search_pages_only",
      ...(state !== "available" ? ["baseline_insufficient_for_change_detection"] : [])]
  };
}

function saveSnapshot(outputDir, snapshot, options = {}) {
  const clean = sanitizeSavedSnapshot(snapshot);
  if (!clean) throw new TypeError("Invalid Collector snapshot");
  const paths = {
    snapshot: path.join(outputDir, "snapshots", `${clean.runId}.json`),
    diff: path.join(outputDir, "diffs", `${clean.runId}.json`),
    latestSnapshot: path.join(outputDir, "latest.snapshot.json"),
    latestDiff: path.join(outputDir, "latest.diff.json")
  };
  // Re-saving the same run preserves its original predecessor and original diff.
  if (fs.existsSync(paths.snapshot) && fs.existsSync(paths.diff)) {
    const savedSnapshot = JSON.parse(fs.readFileSync(paths.snapshot, "utf8"));
    const existing = sanitizeSavedSnapshot(savedSnapshot);
    if (!existing || stableJson(existing) !== stableJson(clean)) throw new Error("Collector run identity collision");
    const savedDiff = JSON.parse(fs.readFileSync(paths.diff, "utf8"));
    const diff = sanitizeSavedDiff(savedDiff, clean);
    if (stableJson(savedSnapshot) !== stableJson(clean)) writeJson(paths.snapshot, clean);
    if (stableJson(savedDiff) !== stableJson(diff)) writeJson(paths.diff, diff);
    return { snapshot: clean, diff, idempotent: true, paths };
  }
  const baseline = readBaseline(outputDir, options);
  const diff = compareSnapshots(baseline, clean);
  writeJson(paths.snapshot, clean);
  writeJson(paths.diff, diff);
  writeJson(paths.latestSnapshot, clean);
  writeJson(paths.latestDiff, diff);
  return { snapshot: clean, diff, idempotent: false, paths };
}

module.exports = { buildSnapshot, compareSnapshots, readBaseline, saveSnapshot, searchScopeId };
