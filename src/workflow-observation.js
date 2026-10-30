"use strict";

const crypto = require("node:crypto");
const { types } = require("node:util");
const { parseStrictJsonBytes } = require("./strict-json");
const { projectDiagnostics } = require("./collector-attempt");

const REPOSITORY = "amindjapan/cw-work-agent-daily";
const WORKFLOW = ".github/workflows/daily.yml";
const RUN_BASE = `https://github.com/${REPOSITORY}/actions/runs/`;
const KEYS = ["kind", "schemaVersion", "repository", "workflowPath", "runId", "runAttempt", "jobId", "sourceCommit",
  "runUrl", "jobUrl", "workflowStartedAt", "workflowUpdatedAt", "observedAt", "collectorStartedAt", "collectorFinishedAt",
  "diagnosticLoggedAt", "diagnostics", "stepResults"];
const STEP_RESULTS = Object.freeze({ tests: "SUCCEEDED", collection: "FAILED", snapshot: "SKIPPED", repositoryPersistence: "SKIPPED", publication: "SKIPPED" });
const OWN_ERRORS = new WeakSet();
const MAX_BYTES = 1024 * 1024;

function fail(code) {
  const error = new Error(`workflow_observation_${code}`);
  error.code = error.message;
  OWN_ERRORS.add(error);
  throw error;
}
function requireThat(condition, code = "invalid_record") { if (!condition) fail(code); }
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const numericId = (value) => matches(/^[1-9][0-9]{0,31}$/, value);
const timestamp = (value) => matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function dataObject(value, required, optional = []) {
  requireThat(!types.isProxy(value));
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value));
  requireThat([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireThat(Reflect.ownKeys(descriptors).every((key) => typeof key === "string"
    && (required.includes(key) || optional.includes(key)) && Object.hasOwn(descriptors[key], "value"))
    && required.every((key) => Object.hasOwn(descriptors, key)));
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function dataArray(value) {
  requireThat(!types.isProxy(value));
  requireThat(Array.isArray(value) && [Array.prototype, null].includes(Object.getPrototypeOf(value)));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length.value;
  requireThat(Reflect.ownKeys(descriptors).length === length + 1
    && Reflect.ownKeys(descriptors).every((key) => key === "length" || typeof key === "string"
      && /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < length && Object.hasOwn(descriptors[key], "value")));
  return Array.from({ length }, (_, index) => descriptors[String(index)].value);
}

function explicitBytes(value) {
  if (typeof value === "string") return value;
  requireThat(!types.isProxy(value) && types.isUint8Array(value)
    && Object.getPrototypeOf(value) === Buffer.prototype, "invalid_json");
  const typed = Object.getPrototypeOf(Uint8Array.prototype);
  const length = Object.getOwnPropertyDescriptor(typed, "byteLength").get.call(value);
  const offset = Object.getOwnPropertyDescriptor(typed, "byteOffset").get.call(value);
  const backing = Object.getOwnPropertyDescriptor(typed, "buffer").get.call(value);
  requireThat(length > 0 && length <= MAX_BYTES && !types.isSharedArrayBuffer(backing), "invalid_json");
  requireThat(Reflect.ownKeys(value).every((key) => typeof key === "string"
    && /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < length), "invalid_json");
  // A fresh intrinsic view avoids caller-owned Buffer or backing-object getters.
  return Buffer.from(new Uint8Array(backing, offset, length));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value) => crypto.createHash("sha256").update(stableJson(value)).digest("hex");

function project(value, allowMissingHash) {
  const input = dataObject(value, allowMissingHash ? KEYS : [...KEYS, "contentSha256"], allowMissingHash ? ["contentSha256"] : []);
  requireThat(input.kind === "workflow_observation" && input.schemaVersion === 1
    && input.repository === REPOSITORY && input.workflowPath === WORKFLOW, "invalid_scope");
  requireThat(numericId(input.runId) && Number.isSafeInteger(input.runAttempt) && input.runAttempt >= 1
    && numericId(input.jobId) && matches(/^[a-f0-9]{40}$/, input.sourceCommit), "invalid_identity");
  const runUrl = `${RUN_BASE}${input.runId}`;
  requireThat(input.runUrl === runUrl && input.jobUrl === `${runUrl}/job/${input.jobId}`, "invalid_identity");
  requireThat(timestamp(input.workflowStartedAt) && timestamp(input.workflowUpdatedAt) && timestamp(input.observedAt)
    && input.workflowStartedAt <= input.workflowUpdatedAt && input.workflowUpdatedAt <= input.observedAt
    && (input.diagnosticLoggedAt === null || timestamp(input.diagnosticLoggedAt)
      && input.diagnosticLoggedAt >= input.workflowStartedAt && input.diagnosticLoggedAt <= input.workflowUpdatedAt), "invalid_time");
  // Workflow and log times do not establish the collector's own start or finish.
  requireThat(input.collectorStartedAt === null && input.collectorFinishedAt === null, "unknown_collector_time_required");
  const steps = dataObject(input.stepResults, Object.keys(STEP_RESULTS));
  requireThat(Object.entries(STEP_RESULTS).every(([key, state]) => steps[key] === state), "invalid_steps");
  let diagnostics;
  try { diagnostics = projectDiagnostics(input.diagnostics); }
  catch { fail("invalid_diagnostics"); }
  requireThat(diagnostics !== null && diagnostics.aborted === true, "invalid_diagnostics");
  const body = Object.fromEntries(KEYS.map((key) => [key,
    key === "diagnostics" ? diagnostics : key === "stepResults" ? { ...STEP_RESULTS } : input[key]]));
  const contentSha256 = hash(body);
  if (Object.hasOwn(input, "contentSha256")) requireThat(matches(/^[a-f0-9]{64}$/, input.contentSha256)
    && input.contentSha256 === contentSha256, "hash_mismatch");
  return { ...body, contentSha256 };
}

function projectWorkflowObservation(value) {
  try { return project(value, false); }
  catch (error) { if (OWN_ERRORS.has(error)) throw error; fail("invalid_record"); }
}

// Explicit supplied metadata only. A generated hash covers canonical metadata,
// not raw log bytes, service authentication, or unobserved collector timestamps.
function importWorkflowObservation(value) {
  try {
    requireThat(!types.isProxy(value));
    if (typeof value === "string" || types.isUint8Array(value)) {
      try { value = parseStrictJsonBytes(explicitBytes(value), { maxBytes: MAX_BYTES }).value; }
      catch { fail("invalid_json"); }
    }
    return project(value, true);
  } catch (error) { if (OWN_ERRORS.has(error)) throw error; fail("invalid_record"); }
}

function selectLatestWorkflowObservation(values) {
  const unavailable = (status, reasonCode) => ({ status, observation: null, reasonCode });
  try {
    const records = dataArray(values).map(projectWorkflowObservation);
    if (!records.length) return unavailable("UNAVAILABLE", "observation_missing");
    const groups = new Map();
    for (const record of records) {
      const key = `${record.runId}:${record.runAttempt}`;
      const previous = groups.get(key);
      if (previous && previous.contentSha256 !== record.contentSha256) return unavailable("CONFLICT", "identity_conflict");
      groups.set(key, record);
    }
    const unique = [...groups.values()];
    for (const a of unique) for (const b of unique) {
      if (a.runId === b.runId) {
        if (a.sourceCommit !== b.sourceCommit) return unavailable("CONFLICT", "identity_conflict");
        if (a.runAttempt < b.runAttempt && a.workflowStartedAt > b.workflowStartedAt) return unavailable("CONFLICT", "ordering_conflict");
      } else if (a.workflowStartedAt === b.workflowStartedAt) return unavailable("CONFLICT", "time_ambiguity");
    }
    unique.sort((a, b) => b.workflowStartedAt.localeCompare(a.workflowStartedAt) || b.runAttempt - a.runAttempt);
    return { status: "AVAILABLE", observation: unique[0], reasonCode: "latest_observation" };
  } catch { return unavailable("UNAVAILABLE", "invalid_record"); }
}

module.exports = { importWorkflowObservation, projectWorkflowObservation, selectLatestWorkflowObservation };
