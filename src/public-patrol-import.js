"use strict";

const crypto = require("node:crypto");
const { isDeepStrictEqual, types } = require("node:util");
const { parseStrictJsonBytes } = require("./strict-json");
const { normalizePublicJobRef, normalizePublicTimestamp } = require("./public-evidence");

// Import bounds only. These do not alter any private-retention policy or enable I/O.
const LIMITS = Object.freeze({ maxBytes: 262144, maxSources: 32, maxEntries: 100, maxObservations: 300 });
const PLATFORMS = ["crowdworks", "lancers", "coconala", "outlier", "telus", "clickworker", "other_public"];
const CONDITIONS = ["AI_PERMISSION", "COMPENSATION", "ELIGIBILITY", "DATA_RIGHTS", "DELIVERY_SCOPE",
  "ACCEPTANCE", "RECRUITMENT_OPEN", "ACCESS_TERMS"];
const FIT_REASONS = ["fit_not_reviewed", "public_requirements_match", "public_requirements_mismatch",
  "eligibility_unconfirmed", "effort_unconfirmed", "compensation_unconfirmed", "scope_unconfirmed"];
const SECURITY_REASONS = ["security_not_reviewed", "ai_permission_unconfirmed", "data_rights_unconfirmed",
  "terms_unconfirmed", "identity_unconfirmed", "external_contact_required", "prohibited_activity", "access_restricted"];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const SCOPE = /^scope-[a-f0-9]{64}$/;

class PatrolImportError extends Error {
  constructor(code) { super(`public_patrol_${code}`); this.code = this.message; }
}
const requireThat = (condition, code) => { if (!condition) throw new PatrolImportError(code); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const timestamp = (value) => typeof value === "string" && normalizePublicTimestamp(value) === value;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function exact(value, required, optional = []) {
  return object(value) && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function enums(values, allowed, code) {
  requireThat(Array.isArray(values) && values.every((value) => typeof value === "string" && allowed.includes(value))
    && new Set(values).size === values.length, code);
  return [...values].sort();
}

// Snapshot own data properties without invoking accessors or toJSON. No implicit
// clock, filesystem, source lookup, credentials, or transport is used anywhere.
function explicitObject(input) {
  let nodes = 0, size = 0;
  const active = new Set();
  function copy(value, depth) {
    requireThat(++nodes <= 50000 && depth <= 20, "input_invalid");
    requireThat(!types.isProxy(value), "input_invalid");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") { requireThat(Number.isFinite(value), "input_invalid"); return value; }
    if (typeof value === "string") {
      size += Buffer.byteLength(value, "utf8");
      requireThat(size <= LIMITS.maxBytes, "input_limit");
      return value;
    }
    requireThat(value && typeof value === "object" && !active.has(value), "input_invalid");
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    requireThat(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null, "input_invalid");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    requireThat(keys.every((key) => typeof key === "string" && Object.hasOwn(descriptors[key], "value")), "input_invalid");
    active.add(value);
    let result;
    if (array) {
      const length = descriptors.length.value;
      requireThat(count(length) && length <= 1000 && keys.length === length + 1
        && keys.every((key) => key === "length" || /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < length), "input_invalid");
      result = Array.from({ length }, (_, index) => copy(descriptors[index].value, depth + 1));
    } else {
      result = Object.fromEntries(keys.map((key) => {
        size += Buffer.byteLength(key, "utf8");
        requireThat(size <= LIMITS.maxBytes, "input_limit");
        return [key, copy(descriptors[key].value, depth + 1)];
      }));
    }
    active.delete(value);
    return result;
  }
  const result = copy(input, 0);
  return parseStrictJsonBytes(JSON.stringify(result), { maxBytes: LIMITS.maxBytes }).value;
}

function explicitBytes(value) {
  if (typeof value === "string") return value;
  requireThat(!types.isProxy(value) && Buffer.isBuffer(value) && Object.getPrototypeOf(value) === Buffer.prototype, "input_invalid");
  const typed = Object.getPrototypeOf(Uint8Array.prototype);
  const length = Object.getOwnPropertyDescriptor(typed, "byteLength").get.call(value);
  const offset = Object.getOwnPropertyDescriptor(typed, "byteOffset").get.call(value);
  const backing = Object.getOwnPropertyDescriptor(typed, "buffer").get.call(value);
  requireThat(length > 0 && length <= LIMITS.maxBytes && !types.isSharedArrayBuffer(backing), "input_invalid");
  requireThat(Reflect.ownKeys(value).every((key) => typeof key === "string"
    && /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < length), "input_invalid");
  return Buffer.from(Buffer.from(backing, offset, length));
}

function unavailable() {
  return seal({ kind: "public_patrol", schemaVersion: 1, assessment: "PUBLIC_EVIDENCE_ONLY", availability: "UNAVAILABLE",
    run: null, scope: { declaredPlatforms: [], unsupportedSources: [] }, sources: [], entries: [],
    counts: { sources: null, observations: null, uniqueJobs: null, unsupportedSources: null },
    limitationCodes: ["not_connected", "public_evidence_only"] });
}

function seal(value) { return { ...value, contentSha256: sha256(stableJson(value)) }; }

function canonicalReference(value) {
  requireThat(exact(value, ["platform", "jobId", "url"]) && value.platform === "crowdworks" && typeof value.jobId === "string", "reference_invalid");
  const ref = normalizePublicJobRef(value);
  requireThat(ref && ref.jobId === value.jobId && ref.url === value.url, "reference_invalid");
  return { platform: "crowdworks", jobId: ref.jobId, url: ref.url };
}

function sourceRecord(value) {
  requireThat(exact(value, ["sourceId", "platform", "sourceKind", "availability"], ["url", "scopeId", "observedCount"])
    && Number.isSafeInteger(value.sourceId) && value.sourceId >= 1 && value.sourceId <= LIMITS.maxSources
    && PLATFORMS.includes(value.platform), "source_invalid");
  const result = { sourceId: value.sourceId, platform: value.platform, sourceKind: value.sourceKind, availability: value.availability };
  if (value.platform !== "crowdworks") {
    requireThat(value.sourceKind === "PUBLIC_PLATFORM" && value.availability === "UNAVAILABLE"
      && !Object.hasOwn(value, "url") && !Object.hasOwn(value, "scopeId")
      && (!Object.hasOwn(value, "observedCount") || value.observedCount === null), "source_unsupported");
    return { ...result, observedCount: null };
  }
  requireThat(["PUBLIC_SEARCH", "PUBLIC_JOB_DETAIL"].includes(value.sourceKind)
    && ["AVAILABLE", "UNAVAILABLE"].includes(value.availability) && matches(SCOPE, value.scopeId), "source_invalid");
  requireThat(!Object.hasOwn(value, "observedCount") || (value.availability === "AVAILABLE"
    ? count(value.observedCount) : value.observedCount === null), "source_count_mismatch");
  if (value.sourceKind === "PUBLIC_SEARCH") requireThat(value.url === "https://crowdworks.jp/public/jobs/search", "source_reference_invalid");
  else {
    const id = typeof value.url === "string" && value.url.match(/^https:\/\/crowdworks\.jp\/public\/jobs\/([1-9][0-9]{0,31})$/);
    requireThat(id, "source_reference_invalid");
    canonicalReference({ platform: "crowdworks", jobId: id[1], url: value.url });
  }
  return { ...result, url: value.url, scopeId: value.scopeId };
}

function assessment(value, type) {
  if (value === undefined) return type === "fit" ? { status: "UNKNOWN", reasonCodes: ["fit_not_reviewed"] }
    : { status: "UNKNOWN", reasonCodes: ["security_not_reviewed"] };
  const statuses = type === "fit" ? ["UNKNOWN", "POTENTIAL_FIT", "NOT_FIT"] : ["UNKNOWN", "REVIEW_REQUIRED", "BLOCKED"];
  requireThat(exact(value, ["status", "reasonCodes"]) && statuses.includes(value.status), "assessment_invalid");
  const reasonCodes = enums(value.reasonCodes, type === "fit" ? FIT_REASONS : SECURITY_REASONS, "assessment_invalid");
  requireThat(reasonCodes.length > 0, "assessment_invalid");
  if (type === "fit") {
    requireThat(value.status !== "POTENTIAL_FIT" || reasonCodes.includes("public_requirements_match"), "assessment_invalid");
    requireThat(value.status !== "NOT_FIT" || reasonCodes.includes("public_requirements_mismatch"), "assessment_invalid");
    requireThat(!(reasonCodes.includes("public_requirements_match") && reasonCodes.includes("public_requirements_mismatch")), "assessment_invalid");
    requireThat(value.status !== "UNKNOWN" || !reasonCodes.some((code) => ["public_requirements_match", "public_requirements_mismatch"].includes(code)), "assessment_invalid");
  }
  return { status: value.status, reasonCodes };
}

function observation(value, reference, source, run) {
  requireThat(exact(value, ["sourceId", "observedAt", "level"], ["conditions", "fit", "securityReview", "unconfirmedConditions", "decision", "evidence"])
    && timestamp(value.observedAt) && value.observedAt >= run.startedAt && value.observedAt <= run.attemptsCompletedAt
    && ["SEARCH_SUMMARY", "JOB_DETAIL"].includes(value.level) && source.platform === "crowdworks" && source.availability === "AVAILABLE", "observation_invalid");
  requireThat(value.level === (source.sourceKind === "PUBLIC_JOB_DETAIL" ? "JOB_DETAIL" : "SEARCH_SUMMARY")
    && (source.sourceKind !== "PUBLIC_JOB_DETAIL" || source.url === reference.url), "observation_source_mismatch");
  const inputConditions = value.conditions === undefined ? [] : value.conditions;
  requireThat(Array.isArray(inputConditions) && inputConditions.length <= CONDITIONS.length, "conditions_invalid");
  const conditions = new Map();
  for (const condition of inputConditions) {
    requireThat(exact(condition, ["code", "state"]) && CONDITIONS.includes(condition.code)
      && ["SUPPORTED", "CONTRADICTED", "UNKNOWN"].includes(condition.state) && !conditions.has(condition.code), "conditions_invalid");
    conditions.set(condition.code, condition.state);
  }
  const completeConditions = CONDITIONS.map((code) => ({ code, state: conditions.get(code) || "UNKNOWN" })).sort((a, b) => a.code.localeCompare(b.code));
  const unconfirmedConditions = completeConditions.filter((item) => item.state === "UNKNOWN").map((item) => item.code);
  if (Object.hasOwn(value, "unconfirmedConditions")) requireThat(isDeepStrictEqual(enums(value.unconfirmedConditions, CONDITIONS, "conditions_invalid"), unconfirmedConditions), "conditions_invalid");
  requireThat(!Object.hasOwn(value, "decision") || value.decision === "STOP_REQUIRED", "assessment_invalid");
  const result = { sourceId: source.sourceId, observedAt: value.observedAt, level: value.level,
    conditions: completeConditions, fit: assessment(value.fit, "fit"), securityReview: assessment(value.securityReview, "security"),
    unconfirmedConditions, decision: "STOP_REQUIRED" };
  const evidence = { kind: "CANONICAL_PUBLIC_OBSERVATION", sha256: sha256(stableJson({ reference, source, observation: result })) };
  if (Object.hasOwn(value, "evidence")) requireThat(exact(value.evidence, ["kind", "sha256"])
    && isDeepStrictEqual(value.evidence, evidence), "evidence_mismatch");
  return { ...result, evidence };
}

function validated(value) {
  requireThat(exact(value, ["kind", "schemaVersion", "run", "scope", "sources", "entries"],
    ["assessment", "availability", "counts", "limitationCodes", "contentSha256"])
    && value.kind === "public_patrol" && value.schemaVersion === 1, "schema_invalid");
  requireThat(!Object.hasOwn(value, "assessment") || value.assessment === "PUBLIC_EVIDENCE_ONLY", "schema_invalid");
  if (value.run === null) {
    const empty = unavailable();
    requireThat(isDeepStrictEqual(value.scope, empty.scope) && Array.isArray(value.sources) && !value.sources.length
      && Array.isArray(value.entries) && !value.entries.length, "unavailable_invalid");
    for (const field of ["assessment", "availability", "counts", "limitationCodes", "contentSha256"]) {
      if (Object.hasOwn(value, field)) requireThat(isDeepStrictEqual(value[field], empty[field]), "unavailable_invalid");
    }
    return empty;
  }
  const run = value.run;
  requireThat(exact(run, ["patrolRunId", "startedAt", "attemptsCompletedAt", "decisionAsOf", "status"])
    && matches(UUID, run.patrolRunId) && timestamp(run.startedAt) && timestamp(run.attemptsCompletedAt) && timestamp(run.decisionAsOf)
    && run.startedAt <= run.decisionAsOf && run.decisionAsOf <= run.attemptsCompletedAt
    && ["COMPLETED", "PARTIAL", "ABORTED", "FAILED"].includes(run.status), "run_invalid");
  requireThat(Array.isArray(value.sources) && value.sources.length <= LIMITS.maxSources
    && Array.isArray(value.entries) && value.entries.length <= LIMITS.maxEntries, "input_limit");
  const sources = value.sources.map(sourceRecord).sort((a, b) => a.sourceId - b.sourceId);
  requireThat(new Set(sources.map((item) => item.sourceId)).size === sources.length, "source_duplicate");
  const platforms = [...new Set(sources.map((item) => item.platform))].sort();
  const unsupportedSources = platforms.filter((platform) => platform !== "crowdworks");
  requireThat(exact(value.scope, ["declaredPlatforms", "unsupportedSources"])
    && isDeepStrictEqual(enums(value.scope.declaredPlatforms, PLATFORMS, "scope_invalid"), platforms)
    && isDeepStrictEqual(enums(value.scope.unsupportedSources, PLATFORMS, "scope_invalid"), unsupportedSources), "scope_invalid");
  const bySource = new Map(sources.map((item) => [item.sourceId, item]));
  const jobs = new Map(), urls = new Map(), observationKeys = new Map();
  let observationCount = 0;
  for (const entry of value.entries) {
    requireThat(exact(entry, ["platform", "jobId", "url", "observations"])
      && Array.isArray(entry.observations) && entry.observations.length > 0, "entry_invalid");
    const reference = canonicalReference({ platform: entry.platform, jobId: entry.jobId, url: entry.url });
    const key = `${reference.platform}:${reference.jobId}`;
    requireThat(!urls.has(reference.url) || urls.get(reference.url) === key, "identity_conflict");
    requireThat(!jobs.has(key) || jobs.get(key).url === reference.url, "identity_conflict");
    if (!jobs.has(key)) jobs.set(key, { ...reference, observations: [] });
    urls.set(reference.url, key);
    for (const item of entry.observations) {
      requireThat(object(item) && bySource.has(item.sourceId), "observation_source_mismatch");
      const observed = observation(item, reference, bySource.get(item.sourceId), run);
      const observationKey = `${key}:${observed.sourceId}:${observed.observedAt}`;
      const fingerprint = stableJson(observed);
      requireThat(!observationKeys.has(observationKey) || observationKeys.get(observationKey) === fingerprint, "observation_conflict");
      if (!observationKeys.has(observationKey)) {
        requireThat(++observationCount <= LIMITS.maxObservations, "input_limit");
        observationKeys.set(observationKey, fingerprint);
        jobs.get(key).observations.push(observed);
      }
    }
  }
  const entries = [...jobs.values()].sort((a, b) => a.jobId.localeCompare(b.jobId));
  entries.forEach((entry) => entry.observations.sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.sourceId - b.sourceId));
  for (const source of sources) {
    const total = entries.reduce((sum, entry) => sum + entry.observations.filter((item) => item.sourceId === source.sourceId).length, 0);
    if (source.platform === "crowdworks") {
      source.observedCount = source.availability === "AVAILABLE" ? total : null;
      requireThat(source.sourceKind !== "PUBLIC_JOB_DETAIL" || source.availability !== "AVAILABLE" || total > 0, "source_observation_missing");
    }
    const original = value.sources.find((item) => item.sourceId === source.sourceId);
    if (Object.hasOwn(original, "observedCount")) requireThat(original.observedCount === source.observedCount, "source_count_mismatch");
  }
  const connected = sources.some((item) => item.platform === "crowdworks" && item.availability === "AVAILABLE");
  const limitationCodes = ["public_evidence_only"];
  if (unsupportedSources.length) limitationCodes.push("source_contract_unavailable");
  if (sources.some((item) => item.availability === "UNAVAILABLE")) limitationCodes.push("sources_unavailable");
  if (!sources.length) limitationCodes.push("not_connected");
  if (run.status !== "COMPLETED") limitationCodes.push(`run_${run.status.toLowerCase()}`);
  limitationCodes.sort();
  const result = seal({ kind: "public_patrol", schemaVersion: 1, assessment: "PUBLIC_EVIDENCE_ONLY",
    availability: !connected ? "UNAVAILABLE" : unsupportedSources.length || sources.some((item) => item.availability !== "AVAILABLE") || run.status !== "COMPLETED" ? "LIMITED" : "AVAILABLE",
    run: { ...run }, scope: { declaredPlatforms: platforms, unsupportedSources }, sources, entries,
    counts: { sources: sources.length, observations: connected ? observationCount : null,
      uniqueJobs: connected ? entries.length : null, unsupportedSources: unsupportedSources.length }, limitationCodes });
  requireThat(Buffer.byteLength(JSON.stringify(result), "utf8") <= LIMITS.maxBytes, "input_limit");
  for (const field of ["availability", "counts", "limitationCodes"]) {
    if (Object.hasOwn(value, field)) requireThat(isDeepStrictEqual(value[field], result[field]), "derived_mismatch");
  }
  if (Object.hasOwn(value, "contentSha256")) requireThat(matches(HASH, value.contentSha256) && value.contentSha256 === result.contentSha256, "content_hash_mismatch");
  return result;
}

function importPublicPatrol(input) {
  try {
    if (input === null || input === undefined) return unavailable();
    requireThat(!types.isProxy(input), "input_invalid");
    const value = typeof input === "string" || Buffer.isBuffer(input)
      ? parseStrictJsonBytes(explicitBytes(input), { maxBytes: LIMITS.maxBytes }).value : explicitObject(input);
    return validated(value);
  } catch (error) {
    if (error instanceof PatrolImportError) throw error;
    throw new PatrolImportError("input_invalid");
  }
}

function projectPublicPatrol(value) { return importPublicPatrol(value); }

function mergePublicPatrol(existing, incoming) {
  const previous = importPublicPatrol(existing), next = importPublicPatrol(incoming);
  if (!previous.run) return next;
  if (!next.run) return previous;
  if (previous.run.patrolRunId === next.run.patrolRunId) {
    requireThat(previous.contentSha256 === next.contentSha256, "run_identity_conflict");
    return previous;
  }
  requireThat(previous.run.decisionAsOf !== next.run.decisionAsOf, "run_time_conflict");
  return next.run.decisionAsOf > previous.run.decisionAsOf ? next : previous;
}

module.exports = { importPublicPatrol, projectPublicPatrol, mergePublicPatrol, stableJson,
  PUBLIC_PATROL_LIMITS: LIMITS, PUBLIC_PATROL_PLATFORMS: Object.freeze([...PLATFORMS]),
  PUBLIC_PATROL_CONDITIONS: Object.freeze([...CONDITIONS]) };
