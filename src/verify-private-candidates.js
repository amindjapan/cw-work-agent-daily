"use strict";

const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { normalizePublicJobRef, normalizePublicProfileRef, normalizePublicTimestamp } = require("./public-evidence");
const { sanitizeClientHistoryReview } = require("./client-history");
const { classifyJob, normalizeText } = require("./model");
const { projectPublicSummary } = require("./prepare-public-artifact");
const { APPROVED_POLICY } = require("./private-candidate-policy");
const { parseStrictJsonBytes } = require("./strict-json");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const SCOPE = /^scope-[a-f0-9]{64}$/;
const CONTENT_FIELDS = ["title", "description", "budget", "category", "status", "expiresAt", "applications"];
const OUTCOMES = ["success", "fetch_failed", "extraction_failed", "not_attempted"];
const REASONS = ["matched_skill", "strong_signal", "risk_keyword", "budget_detected", "machine_candidate", "machine_not_candidate"];
const ISSUE_CODES = new Set(["verification_input_invalid", "verification_time_invalid", "execution_id_invalid",
  "record_json_invalid", "snapshot_json_invalid", "summary_json_invalid", "record_schema_invalid", "record_hash_mismatch",
  "record_count_mismatch", "candidate_ids_duplicate", "candidate_schema_invalid", "snapshot_schema_invalid",
  "snapshot_hash_mismatch", "snapshot_ids_duplicate", "retrieval_ids_duplicate", "detail_evidence_mismatch",
  "snapshot_count_mismatch", "snapshot_quality_requires_review", "candidate_ids_mismatch", "candidate_evidence_mismatch",
  "summary_schema_invalid", "summary_hash_mismatch", "summary_count_mismatch", "collection_time_invalid",
  "collection_count_mismatch", "recommendation_detail_unconfirmed", "execution_id_mismatch", "record_time_in_future",
  "current_detail_evidence_invalid", "recommendation_reference_mismatch", "search_evidence_mismatch",
  "observation_scope_mismatch", "coverage_evidence_mismatch", "summary_attempts_mismatch", "machine_judgment_mismatch",
  "recommendation_evidence_mismatch"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const timestamp = (value) => normalizePublicTimestamp(value);
const canonicalTimestamp = (value) => typeof value === "string" && timestamp(value) === value;
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function requireThat(condition, code) {
  if (!condition) throw code;
}

function exactKeys(value, required, optional = []) {
  return object(value) && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function uniqueStrings(value, accept = () => true) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && accept(entry))
    && new Set(value).size === value.length;
}

function parseBytes(value, code) {
  let parsed;
  try { parsed = parseStrictJsonBytes(value, { maxBytes: APPROVED_POLICY.maxTotalBytes }); }
  catch { throw code; }
  requireThat(object(parsed.value), code);
  return parsed;
}

function validRef(value) {
  const ref = normalizePublicJobRef({ platform: "crowdworks", id: value.id, url: value.url });
  return ref && ref.jobId === value.id && ref.url === value.url;
}

function validReasons(value) {
  return uniqueStrings(value, (entry) => REASONS.includes(entry));
}

function validateRecord(record) {
  requireThat(exactKeys(record, ["schemaVersion", "kind", "executionId", "runId", "generatedAt", "extractedAt",
    "collector", "snapshotSha256", "summarySha256", "assessment", "counts", "candidates", "recordSha256"]), "record_schema_invalid");
  requireThat(record.schemaVersion === 1 && record.kind === "private_machine_candidates"
    && matches(UUID, record.executionId) && canonicalTimestamp(record.generatedAt)
    && canonicalTimestamp(record.extractedAt) && record.extractedAt >= record.generatedAt
    && exactKeys(record.collector, ["version", "sourceSha256"])
    && record.collector.version === "private-candidates-v1" && matches(HASH, record.collector.sourceSha256)
    && matches(HASH, record.snapshotSha256) && matches(HASH, record.summarySha256) && matches(HASH, record.recordSha256)
    && record.assessment === "machine_extraction_only"
    && record.runId === `${record.generatedAt.replace(/[-:.]/g, "")}-${record.snapshotSha256.slice(0, 16)}`,
  "record_schema_invalid");
  const { recordSha256, ...content } = record;
  requireThat(sha256(stableJson(content)) === recordSha256, "record_hash_mismatch");
  requireThat(exactKeys(record.counts, ["summaryCandidateCount", "listCount", "retrievedJobCount", "reconciliation"])
    && Array.isArray(record.candidates) && record.candidates.length <= APPROVED_POLICY.maxCandidates
    && record.counts.listCount === record.candidates.length, "record_count_mismatch");
  const counts = record.counts;
  requireThat(counts.reconciliation === "unknown"
    ? counts.summaryCandidateCount === null && counts.retrievedJobCount === null && counts.listCount === 0
    : counts.reconciliation === "matched" && nonnegative(counts.summaryCandidateCount)
      && nonnegative(counts.retrievedJobCount) && counts.summaryCandidateCount === counts.listCount
      && counts.retrievedJobCount >= counts.listCount, "record_count_mismatch");
  requireThat(new Set(record.candidates.map((item) => item && item.id)).size === record.candidates.length,
    "candidate_ids_duplicate");
  for (const item of record.candidates) {
    requireThat(exactKeys(item, ["id", "url", "fetchedAt", "reasonCodes"]) && validRef(item)
      && canonicalTimestamp(item.fetchedAt) && item.fetchedAt <= record.extractedAt
      && validReasons(item.reasonCodes) && item.reasonCodes.includes("machine_candidate"), "candidate_schema_invalid");
  }
}

function validateSnapshot(snapshot, record) {
  requireThat(exactKeys(snapshot, ["schemaVersion", "kind", "platform", "generatedAt", "jobs", "candidateIds",
    "retrieval", "coverage", "quality", "runId"], ["clientReview"])
    && snapshot.schemaVersion === 1 && snapshot.kind === "collector_snapshot" && snapshot.platform === "crowdworks"
    && snapshot.generatedAt === record.generatedAt && snapshot.runId === record.runId
    && Array.isArray(snapshot.jobs) && uniqueStrings(snapshot.candidateIds), "snapshot_schema_invalid");
  const { runId, ...content } = snapshot;
  requireThat(sha256(stableJson(content)) === record.snapshotSha256, "snapshot_hash_mismatch");
  requireThat(new Set(snapshot.jobs.map((job) => job && job.id)).size === snapshot.jobs.length, "snapshot_ids_duplicate");
  for (const job of snapshot.jobs) {
    requireThat(exactKeys(job, ["platform", "id", "url", "fetchedAt", "observedIn", "contentHashes", "contentSources",
      "machineJudgment", "detailStatus", "candidate"], ["profileRef"])
      && job.platform === "crowdworks" && validRef(job) && canonicalTimestamp(job.fetchedAt)
      && job.fetchedAt <= record.extractedAt && typeof job.candidate === "boolean" && OUTCOMES.includes(job.detailStatus)
      && uniqueStrings(job.observedIn, (entry) => matches(SCOPE, entry))
      && exactKeys(job.contentHashes, CONTENT_FIELDS) && CONTENT_FIELDS.every((field) => matches(HASH, job.contentHashes[field]))
      && exactKeys(job.contentSources, CONTENT_FIELDS) && CONTENT_FIELDS.every((field) => ["detail", "search", "unknown"].includes(job.contentSources[field])),
    "snapshot_schema_invalid");
    const judgment = job.machineJudgment;
    requireThat(exactKeys(judgment, ["canExecute", "score", "level", "matchedSkills", "strongSignals", "riskFlags", "budgetYen", "reasonCodes"])
      && typeof judgment.canExecute === "boolean" && Number.isFinite(judgment.score) && judgment.score >= 0 && judgment.score <= 100
      && ["high", "medium", "low"].includes(judgment.level)
      && [judgment.matchedSkills, judgment.strongSignals, judgment.riskFlags].every((value) => uniqueStrings(value))
      && (judgment.budgetYen === null || nonnegative(judgment.budgetYen)) && validReasons(judgment.reasonCodes), "snapshot_schema_invalid");
    const expectedReasons = [
      ...(judgment.matchedSkills.length ? ["matched_skill"] : []),
      ...(judgment.strongSignals.length ? ["strong_signal"] : []),
      ...(judgment.riskFlags.length ? ["risk_keyword"] : []),
      ...(judgment.budgetYen !== null ? ["budget_detected"] : []),
      judgment.canExecute ? "machine_candidate" : "machine_not_candidate"
    ].sort();
    requireThat(Number.isInteger(judgment.score)
      && judgment.level === (judgment.score >= 75 ? "high" : judgment.score >= 55 ? "medium" : "low")
      && judgment.canExecute === (judgment.score >= 60
        && !judgment.riskFlags.some((keyword) => classifyJob({ title: keyword }).verdict === "避ける"))
      && isDeepStrictEqual([...judgment.reasonCodes].sort(), expectedReasons)
      && ["matchedSkills", "strongSignals", "riskFlags"].every((field) => judgment[field].every((keyword) =>
        classifyJob({ title: keyword })[field].includes(keyword))), "machine_judgment_mismatch");
    if (Object.hasOwn(job, "profileRef")) {
      const ref = normalizePublicProfileRef(job.profileRef);
      requireThat(exactKeys(job.profileRef, ["platform", "profileId", "url"]) && ref
        && isDeepStrictEqual(ref, job.profileRef) && ref.platform === "crowdworks", "snapshot_schema_invalid");
    }
  }
  requireThat(exactKeys(snapshot.retrieval, ["search", "details"])
    && Array.isArray(snapshot.retrieval.search) && Array.isArray(snapshot.retrieval.details), "snapshot_schema_invalid");
  requireThat(new Set(snapshot.retrieval.search.map((item) => item && item.scopeId)).size === snapshot.retrieval.search.length
    && new Set(snapshot.retrieval.details.map((item) => item && item.jobId)).size === snapshot.retrieval.details.length,
  "retrieval_ids_duplicate");
  const jobIds = new Set(snapshot.jobs.map((job) => job.id));
  for (const item of snapshot.retrieval.search) {
    requireThat(exactKeys(item, ["scopeId", "page", "ok", "status", "outcome", "complete", "imported", "observedIds"])
      && matches(SCOPE, item.scopeId) && nonnegative(item.page) && item.page > 0 && typeof item.complete === "boolean"
      && (item.imported === null || nonnegative(item.imported)) && uniqueStrings(item.observedIds, (id) => jobIds.has(id)), "snapshot_schema_invalid");
    validateAttempt(item);
    // Saved Collector snapshots normalize failed/partial-search imported to null;
    // partial observed IDs remain available separately without implying success.
    requireThat(item.ok ? item.imported === item.observedIds.length
      : item.imported === null && item.complete === false, "search_evidence_mismatch");
  }
  for (const item of snapshot.retrieval.details) {
    requireThat(exactKeys(item, ["jobId", "ok", "status", "outcome"]) && jobIds.has(item.jobId), "snapshot_schema_invalid");
    validateAttempt(item);
    requireThat(snapshot.jobs.find((job) => job.id === item.jobId).detailStatus === item.outcome, "detail_evidence_mismatch");
  }
  for (const job of snapshot.jobs) {
    const attempt = snapshot.retrieval.details.find((item) => item.jobId === job.id);
    requireThat(job.detailStatus === (attempt ? attempt.outcome : "not_attempted"), "detail_evidence_mismatch");
  }
  requireThat(exactKeys(snapshot.coverage, ["status", "retrievedJobCount", "candidateCount", "scopeMeaning"])
    && ["not_attempted", "failed", "partial", "complete"].includes(snapshot.coverage.status)
    && snapshot.coverage.scopeMeaning === "configured_search_pages_only"
    && snapshot.coverage.retrievedJobCount === record.counts.retrievedJobCount
    && snapshot.coverage.candidateCount === record.counts.summaryCandidateCount, "snapshot_count_mismatch");
  requireThat(exactKeys(snapshot.quality, ["duplicateIds", "conflictingDuplicateIds", "invalidJobCount", "unobservedCandidateIds", "rejectedCandidateIds"])
    && snapshot.quality.invalidJobCount === 0
    && ["duplicateIds", "conflictingDuplicateIds", "unobservedCandidateIds", "rejectedCandidateIds"].every((key) => Array.isArray(snapshot.quality[key]) && snapshot.quality[key].length === 0),
  "snapshot_quality_requires_review");
  for (const job of snapshot.jobs) {
    const scopes = snapshot.retrieval.search.filter((item) => item.observedIds.includes(job.id)).map((item) => item.scopeId).sort();
    requireThat(scopes.length > 0 && isDeepStrictEqual([...job.observedIn].sort(), scopes), "observation_scope_mismatch");
  }
  const searches = snapshot.retrieval.search;
  const observed = snapshot.jobs.length > 0 || searches.some((item) => item.ok);
  const coverageStatus = !searches.length ? "not_attempted" : !searches.some((item) => item.ok) ? "failed"
    : searches.every((item) => item.complete) ? "complete" : "partial";
  requireThat(snapshot.coverage.status === coverageStatus
    && (observed ? snapshot.coverage.retrievedJobCount === snapshot.jobs.length
      : snapshot.coverage.retrievedJobCount === null && snapshot.coverage.candidateCount === null), "coverage_evidence_mismatch");
  if (Object.hasOwn(snapshot, "clientReview")) {
    requireThat(isDeepStrictEqual(snapshot.clientReview, sanitizeClientHistoryReview(snapshot.clientReview)), "snapshot_schema_invalid");
  }
  const expectedIds = record.candidates.map((item) => item.id).sort();
  requireThat(isDeepStrictEqual([...snapshot.candidateIds].sort(), expectedIds)
    && isDeepStrictEqual(snapshot.jobs.filter((job) => job.candidate).map((job) => job.id).sort(), expectedIds), "candidate_ids_mismatch");
  requireThat(record.counts.reconciliation === "unknown" ? snapshot.jobs.length === 0
    : snapshot.jobs.length === record.counts.retrievedJobCount, "snapshot_count_mismatch");
  for (const item of record.candidates) {
    const job = snapshot.jobs.find((entry) => entry.id === item.id);
    requireThat(job && job.machineJudgment.canExecute && job.url === item.url && job.fetchedAt === item.fetchedAt
      && isDeepStrictEqual([...job.machineJudgment.reasonCodes].sort(), [...item.reasonCodes].sort()), "candidate_evidence_mismatch");
  }
}

function validateAttempt(item) {
  requireThat(typeof item.ok === "boolean" && OUTCOMES.includes(item.outcome)
    && (item.status === null || nonnegative(item.status) && item.status <= 599)
    && item.ok === (item.outcome === "success")
    && (!item.ok || item.status === null || item.status >= 200 && item.status < 300), "snapshot_schema_invalid");
}

function countAttempts(attempts) {
  return { attempted: attempts.filter((item) => item.outcome !== "not_attempted").length,
    succeeded: attempts.filter((item) => item.outcome === "success").length,
    failed: attempts.filter((item) => ["fetch_failed", "extraction_failed"].includes(item.outcome)).length,
    notAttempted: attempts.filter((item) => item.outcome === "not_attempted").length };
}

function validatePublicAttempts(summary, snapshot) {
  const expected = [...snapshot.retrieval.search];
  requireThat(summary.attempts.length === expected.length && summary.keywords.length === expected.length,
    "summary_attempts_mismatch");
  // Search scopes are sorted in snapshots while public keywords may be sanitized.
  // Match a multiset instead of assuming positional or keyword identity. Match
  // non-null imports first so an unknown partial count cannot consume their row.
  const attempts = [...summary.attempts].sort((a, b) => Number(a.imported === null) - Number(b.imported === null));
  for (const attempt of attempts) {
    requireThat(attempt.imported === null || nonnegative(attempt.imported), "summary_attempts_mismatch");
    const index = expected.findIndex((item) => item.ok === attempt.ok && item.status === attempt.status
      && (item.ok ? item.imported === attempt.imported
        : attempt.imported === null || attempt.imported === item.observedIds.length));
    requireThat(index >= 0, "summary_attempts_mismatch");
    expected.splice(index, 1);
  }
}

function validateSummary(summary, bytes, snapshot, record, now) {
  let projected;
  try { projected = projectPublicSummary(summary); } catch { throw "summary_schema_invalid"; }
  requireThat(isDeepStrictEqual(summary, projected), "summary_schema_invalid");
  requireThat(sha256(bytes) === record.summarySha256, "summary_hash_mismatch");
  requireThat(summary.generatedAt === record.generatedAt && summary.totalJobs === record.counts.retrievedJobCount
    && summary.safeCandidates === record.counts.summaryCandidateCount, "summary_count_mismatch");
  validatePublicAttempts(summary, snapshot);
  if (!Object.hasOwn(summary, "collection")) return "UNKNOWN";
  const collection = summary.collection;
  requireThat(collection.schemaVersion === 1 && collection.status === "attempts_completed"
    && collection.startedAt === record.generatedAt && collection.decisionAsOf === record.generatedAt
    && canonicalTimestamp(collection.attemptsCompletedAt)
    && collection.attemptsCompletedAt >= collection.startedAt
    && collection.attemptsCompletedAt <= record.extractedAt && collection.attemptsCompletedAt <= now, "collection_time_invalid");
  const search = countAttempts(snapshot.retrieval.search);
  requireThat(isDeepStrictEqual(collection.search, { planned: snapshot.retrieval.search.length, ...search }), "collection_count_mismatch");
  const details = countAttempts(snapshot.retrieval.details);
  details.notAttempted += snapshot.jobs.length - snapshot.retrieval.details.length;
  requireThat(isDeepStrictEqual(collection.details, { observed: snapshot.jobs.length, ...details }), "collection_count_mismatch");
  const confirmed = snapshot.jobs.filter((job) => job.candidate && job.detailStatus === "success"
    && snapshot.retrieval.details.some((item) => item.jobId === job.id && item.ok)).length;
  for (const job of snapshot.jobs.filter((entry) => entry.detailStatus === "success")) {
    const attempt = snapshot.retrieval.details.find((item) => item.jobId === job.id && item.ok);
    requireThat(attempt && Number.isInteger(attempt.status) && attempt.status >= 200 && attempt.status < 300
      && job.fetchedAt >= collection.startedAt && job.fetchedAt <= collection.attemptsCompletedAt
      && job.contentSources.description === "detail" && job.contentHashes.description !== sha256(""),
    "current_detail_evidence_invalid");
  }
  const machine = summary.safeCandidates;
  requireThat(isDeepStrictEqual(collection.candidates, { machine, detailConfirmed: machine === null ? null : confirmed,
    detailUnconfirmed: machine === null ? null : machine - confirmed }), "collection_count_mismatch");
  if (summary.recommendation) {
    const id = String(summary.recommendation.id);
    const reference = { id, url: summary.recommendation.url };
    requireThat(validRef(reference) && snapshot.jobs.some((job) => job.id === id && job.url === reference.url),
      "recommendation_reference_mismatch");
    requireThat(snapshot.candidateIds.includes(id) && snapshot.jobs.some((job) => job.id === id && job.detailStatus === "success")
      && snapshot.retrieval.details.some((item) => item.jobId === id && item.ok), "recommendation_detail_unconfirmed");
    const job = snapshot.jobs.find((item) => item.id === id);
    requireThat(canonicalTimestamp(summary.recommendation.detailCheckedAt) && summary.recommendation.detailCheckedAt === job.fetchedAt
      && sha256(normalizeText(summary.recommendation.expiresAt)) === job.contentHashes.expiresAt, "recommendation_evidence_mismatch");
    if (summary.recommendation.analysis) {
      for (const [key, value] of Object.entries(summary.recommendation.analysis)) {
        if (!Object.hasOwn(job.machineJudgment, key)) continue;
        requireThat(isDeepStrictEqual(Array.isArray(value) ? [...value].sort() : value,
          job.machineJudgment[key]), "recommendation_evidence_mismatch");
      }
    }
  }
  return collection.attemptsCompletedAt;
}

// Explicit saved UTF-8 bytes only. No filesystem, transport, clock, or store call.
// "verified" describes these supplied records, never durable storage or safety.
function verifyPrivateCandidateHandoff(input = {}) {
  const base = { reconciliation: "unknown", collectionCompletion: "UNKNOWN", assessment: "machine_extraction_only" };
  try {
    requireThat(object(input), "verification_input_invalid");
    const prototype = Object.getPrototypeOf(input);
    requireThat(prototype === Object.prototype || prototype === null, "verification_input_invalid");
    const descriptors = Object.getOwnPropertyDescriptors(input);
    requireThat(Reflect.ownKeys(descriptors).every((key) => typeof key === "string" && Object.hasOwn(descriptors[key], "value")),
      "verification_input_invalid");
    input = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
    requireThat(exactKeys(input, ["now"], ["recordBytes", "snapshotBytes", "summaryBytes", "expectedExecutionId"]), "verification_input_invalid");
    const now = timestamp(input.now);
    requireThat(now, "verification_time_invalid");
    if (Object.hasOwn(input, "expectedExecutionId")) requireThat(matches(UUID, input.expectedExecutionId), "execution_id_invalid");
    const missing = ["recordBytes", "snapshotBytes", "summaryBytes"].filter((key) => input[key] === undefined || input[key] === null);
    if (missing.length) return { ...base, status: "incomplete", issues: missing.map((key) => ({ recordBytes: "record_missing", snapshotBytes: "snapshot_missing", summaryBytes: "summary_missing" })[key]) };
    const record = parseBytes(input.recordBytes, "record_json_invalid").value;
    validateRecord(record);
    requireThat(!input.expectedExecutionId || record.executionId === input.expectedExecutionId, "execution_id_mismatch");
    requireThat(record.generatedAt <= now && record.extractedAt <= now, "record_time_in_future");
    if (new Date(now) - new Date(record.extractedAt) >= APPROVED_POLICY.retentionDays * 86400000) {
      return { ...base, status: "expired", requiresReview: true, issues: ["retention_review_required"] };
    }
    const snapshot = parseBytes(input.snapshotBytes, "snapshot_json_invalid").value;
    const summaryInput = parseBytes(input.summaryBytes, "summary_json_invalid");
    validateSnapshot(snapshot, record);
    const completion = validateSummary(summaryInput.value, summaryInput.bytes, snapshot, record, now);
    return { ...base, status: record.counts.reconciliation === "unknown" ? "unknown" : "verified", issues: [],
      reconciliation: record.counts.reconciliation, collectionCompletion: completion };
  } catch (code) {
    // No caller-controlled strings, paths, candidate lists, or parser messages escape.
    const issues = [ISSUE_CODES.has(code) ? code : "verification_input_invalid"];
    return { ...base, status: "invalid", issues };
  }
}

module.exports = { verifyPrivateCandidateHandoff };
