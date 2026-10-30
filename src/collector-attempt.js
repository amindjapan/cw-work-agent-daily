"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { types } = require("node:util");
const { parseStrictJsonBytes } = require("./strict-json");

const COLLECTION_STATES = new Set(["NOT_STARTED", "RUNNING", "ABORTED", "COMPLETED", "FAILED", "UNKNOWN"]);
const PERSISTENCE_STATES = new Set(["NOT_ATTEMPTED", "SUCCEEDED", "FAILED", "UNKNOWN"]);
const STOP_REASONS = new Set(["access_denied", "authentication_required", "rate_limited", "captcha_required", "access_congestion", "protection_warning"]);
const HTTP_STOP_REASONS = new Map([[401, "authentication_required"], [403, "access_denied"], [429, "rate_limited"]]);
const EVENT_REASONS = new Set([...STOP_REASONS, "success", "http_failed", "network_failed", "extraction_failed", "unsupported_response", "not_attempted", "collector_failed"]);
const REASON_CODES = new Set([...STOP_REASONS, "attempt_started", "not_started", "collection_completed", "collection_aborted", "collector_failed", "local_persistence_failed", "repository_persistence_failed", "publication_failed", "unknown"]);
const IDENTITY_KEYS = ["runId", "runAttempt", "sourceCommit", "workflowPath"];
const RECORD_KEYS = ["schemaVersion", "kind", ...IDENTITY_KEYS, "startedAt", "finishedAt", "collectionState", "diagnostics", "localPersistence", "repositoryPersistence", "publication", "reasonCode", "recordSha256"];
const REPOSITORY = path.resolve(__dirname, "..");
const MAX_RECORD_BYTES = 1024 * 1024;
const OWN_ERRORS = new WeakSet();

function fail(code) {
  const error = new Error(`collector_attempt_${code}`);
  error.code = error.message;
  OWN_ERRORS.add(error);
  throw error;
}

function requireThat(condition, code = "invalid_record") { if (!condition) fail(code); }
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const timestamp = (value) => matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function dataObject(value, required, optional = []) {
  requireThat(!types.isProxy(value));
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value));
  const prototype = Object.getPrototypeOf(value);
  requireThat(prototype === Object.prototype || prototype === null);
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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function seal(value) { return { ...value, recordSha256: hash(stableJson(value)) }; }

function validateIdentity(value) {
  requireThat(matches(/^(?:[1-9][0-9]{0,31}|local-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/, value.runId)
    && integer(value.runAttempt) && value.runAttempt >= 1
    && matches(/^[a-f0-9]{40}$/, value.sourceCommit)
    && [".github/workflows/daily.yml", "local"].includes(value.workflowPath));
}

function projectCounts(value, totalKey) {
  const fields = [totalKey, "attempted", "succeeded", "failed", "notAttempted"];
  const counts = dataObject(value, fields);
  requireThat(fields.every((key) => integer(counts[key]))
    && counts.attempted === counts.succeeded + counts.failed
    && counts[totalKey] === counts.attempted + counts.notAttempted);
  return Object.fromEntries(fields.map((key) => [key, counts[key]]));
}

function projectDiagnostics(value) {
  if (value === null) return null;
  const diagnostics = dataObject(value, ["kind", "schemaVersion", "aborted", "search", "details", "events"]);
  requireThat(diagnostics.kind === "collector_diagnostics" && diagnostics.schemaVersion === 1
    && typeof diagnostics.aborted === "boolean");
  const search = projectCounts(diagnostics.search, "planned");
  const details = projectCounts(diagnostics.details, "observed");
  const events = dataArray(diagnostics.events).map((value) => {
    const event = dataObject(value, ["stage", "httpStatus", "reason"]);
    requireThat(["search", "detail", "collector"].includes(event.stage)
      && (event.httpStatus === null || integer(event.httpStatus) && event.httpStatus >= 100 && event.httpStatus <= 599)
      && EVENT_REASONS.has(event.reason)
      && (event.reason !== "success" || event.httpStatus !== null && event.httpStatus >= 200 && event.httpStatus < 300));
    const httpStop = HTTP_STOP_REASONS.get(event.httpStatus);
    requireThat((!httpStop || event.reason === httpStop)
      && (event.reason !== "not_attempted" || event.httpStatus === null)
      && (event.stage !== "collector" || event.httpStatus === null && ["collector_failed", "not_attempted"].includes(event.reason))
      && (!["extraction_failed", "unsupported_response"].includes(event.reason)
        || event.httpStatus === null || event.httpStatus >= 200 && event.httpStatus < 300));
    return { stage: event.stage, httpStatus: event.httpStatus, reason: event.reason };
  });
  let detailsStarted = false, stopped = false;
  for (const event of events) {
    requireThat(event.stage !== "search" || !detailsStarted);
    if (event.stage === "detail") detailsStarted = true;
    // Explicit skipped markers may describe remaining work, but cannot report
    // another contact or failure after the first access stop.
    requireThat(!stopped || event.reason === "not_attempted" && event.httpStatus === null);
    if (STOP_REASONS.has(event.reason)) stopped = true;
  }
  for (const [stage, counts] of [["search", search], ["detail", details]]) {
    const relevant = events.filter((event) => event.stage === stage);
    requireThat(relevant.filter((event) => event.reason === "success").length === counts.succeeded
      && relevant.filter((event) => !["success", "not_attempted"].includes(event.reason)).length === counts.failed
      && relevant.filter((event) => event.reason === "not_attempted").length <= counts.notAttempted);
  }
  const stops = events.filter((event) => STOP_REASONS.has(event.reason));
  requireThat(stops.length <= 1 && diagnostics.aborted === (stops.length > 0)
    && (!diagnostics.aborted || search.failed + details.failed > 0));
  return { kind: "collector_diagnostics", schemaVersion: 1, aborted: diagnostics.aborted, search, details, events };
}

function projectRecord(value) {
  const record = dataObject(value, RECORD_KEYS);
  validateIdentity(record);
  requireThat(record.schemaVersion === 1 && record.kind === "collector_attempt"
    && timestamp(record.startedAt) && (record.finishedAt === null || timestamp(record.finishedAt) && record.finishedAt >= record.startedAt)
    && COLLECTION_STATES.has(record.collectionState) && PERSISTENCE_STATES.has(record.localPersistence)
    && PERSISTENCE_STATES.has(record.repositoryPersistence) && PERSISTENCE_STATES.has(record.publication)
    && REASON_CODES.has(record.reasonCode) && matches(/^[a-f0-9]{64}$/, record.recordSha256));
  const diagnostics = projectDiagnostics(record.diagnostics);
  const pending = ["RUNNING", "NOT_STARTED"].includes(record.collectionState);
  requireThat(pending === (record.finishedAt === null)
    && (!pending || diagnostics === null && [record.localPersistence, record.repositoryPersistence, record.publication].every((state) => state === "NOT_ATTEMPTED")
      && record.reasonCode === (record.collectionState === "RUNNING" ? "attempt_started" : "not_started"))
    && (pending || !["attempt_started", "not_started"].includes(record.reasonCode))
    && (diagnostics === null || diagnostics.aborted === (record.collectionState === "ABORTED"))
    && (record.collectionState !== "ABORTED" || record.reasonCode === "collection_aborted" || STOP_REASONS.has(record.reasonCode))
    && (!STOP_REASONS.has(record.reasonCode) || record.collectionState === "ABORTED")
    && (record.reasonCode !== "collection_aborted" || record.collectionState === "ABORTED")
    && (record.collectionState !== "ABORTED" || record.localPersistence !== "SUCCEEDED")
    && (!STOP_REASONS.has(record.reasonCode) || diagnostics === null || diagnostics.events.some((event) => event.reason === record.reasonCode))
    && (record.reasonCode !== "local_persistence_failed" || record.localPersistence === "FAILED")
    && (record.reasonCode !== "repository_persistence_failed" || record.repositoryPersistence === "FAILED")
    && (record.reasonCode !== "publication_failed" || record.publication === "FAILED")
    && (record.reasonCode !== "collection_completed" || record.collectionState === "COMPLETED")
    && (record.reasonCode !== "collector_failed" || record.collectionState === "FAILED"));
  const result = Object.fromEntries(RECORD_KEYS.filter((key) => key !== "recordSha256").map((key) => [key, key === "diagnostics" ? diagnostics : record[key]]));
  requireThat(hash(stableJson(result)) === record.recordSha256, "hash_mismatch");
  return { ...result, recordSha256: record.recordSha256 };
}

function projectPublicAttempt(value) {
  try { return projectRecord(value); }
  catch (error) {
    if (OWN_ERRORS.has(error)) throw error;
    fail("invalid_record");
  }
}

function createAttempt(value) {
  try {
    const input = dataObject(value, [...IDENTITY_KEYS, "startedAt"]);
    validateIdentity(input);
    requireThat(timestamp(input.startedAt));
    return seal({ schemaVersion: 1, kind: "collector_attempt", ...input, finishedAt: null, collectionState: "RUNNING",
      diagnostics: null, localPersistence: "NOT_ATTEMPTED", repositoryPersistence: "NOT_ATTEMPTED", publication: "NOT_ATTEMPTED", reasonCode: "attempt_started" });
  } catch { fail("invalid_record"); }
}

function finishAttempt(value, fields) {
  const current = projectPublicAttempt(value);
  let update;
  try { update = dataObject(fields, ["finishedAt", "collectionState", "reasonCode"], ["diagnostics", "localPersistence", "repositoryPersistence", "publication"]); }
  catch { fail("invalid_record"); }
  // Validate caller-owned nested values before hashing can enumerate them.
  requireThat(timestamp(update.finishedAt) && COLLECTION_STATES.has(update.collectionState) && REASON_CODES.has(update.reasonCode));
  for (const key of ["localPersistence", "repositoryPersistence", "publication"]) {
    requireThat(!Object.hasOwn(update, key) || PERSISTENCE_STATES.has(update[key]));
  }
  if (Object.hasOwn(update, "diagnostics")) update.diagnostics = projectDiagnostics(update.diagnostics);
  const { recordSha256, ...content } = current;
  const result = projectPublicAttempt(seal({ ...content, ...update }));
  requireThat(result.finishedAt !== null && !["RUNNING", "NOT_STARTED"].includes(result.collectionState));
  if (current.finishedAt !== null && result.recordSha256 !== current.recordSha256) fail("identity_collision");
  return result;
}

const logicalIdentity = (record) => stableJson({ workflowPath: record.workflowPath, runId: record.runId, runAttempt: record.runAttempt });
const sameBeginning = (a, b) => [...IDENTITY_KEYS, "startedAt"].every((key) => a[key] === b[key]);

function selectLatestAttempt(values, options = {}) {
  const unavailable = (status, reasonCode) => ({ status, attempt: null, reasonCode });
  try {
    values = dataArray(values);
    const input = dataObject(options, [], ["expectedIdentity"]);
    let expected = null;
    if (input.expectedIdentity !== undefined) {
      expected = dataObject(input.expectedIdentity, [], IDENTITY_KEYS);
      requireThat(Object.keys(expected).length > 0);
      const complete = { runId: "local-11111111-1111-4111-8111-111111111111", runAttempt: 1, sourceCommit: "a".repeat(40), workflowPath: "local", ...expected };
      validateIdentity(complete);
    }
    const groups = new Map();
    for (const value of values) {
      const record = projectPublicAttempt(value);
      const key = logicalIdentity(record);
      const prior = groups.get(key);
      if (prior && (!sameBeginning(prior, record)
        || prior.finishedAt !== null && record.finishedAt !== null && prior.recordSha256 !== record.recordSha256
        || prior.finishedAt === null && record.finishedAt === null && prior.recordSha256 !== record.recordSha256)) {
        return unavailable("conflict", "identity_conflict");
      }
      if (!prior || record.finishedAt !== null) groups.set(key, record);
    }
    let records = [...groups.values()];
    if (expected) records = records.filter((record) => Object.entries(expected).every(([key, value]) => record[key] === value));
    if (!records.length) return unavailable(values.length ? "unknown" : "missing", values.length ? "identity_mismatch" : "attempt_missing");
    for (const a of records) for (const b of records) {
      if (a.workflowPath === b.workflowPath && a.runId === b.runId && a.runAttempt < b.runAttempt && a.startedAt > b.startedAt) {
        return unavailable("conflict", "ordering_conflict");
      }
    }
    records.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runAttempt - a.runAttempt);
    const latest = records[0];
    if (records.some((record) => record !== latest && record.startedAt === latest.startedAt
      && (record.runId !== latest.runId || record.workflowPath !== latest.workflowPath))) return unavailable("conflict", "ordering_conflict");
    return { status: "available", attempt: latest, reasonCode: "latest_attempt" };
  } catch { return unavailable("unknown", "invalid_record"); }
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function physicalLocation(directory) {
  let current = directory;
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    requireThat(parent !== current, "unsafe_path");
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.resolve(fs.realpathSync(current), ...suffix);
}

function assertDirectory(directory, publicOutputDir, evidenceOutputDir) {
  let ancestor = directory;
  while (true) {
    try {
      const stat = fs.lstatSync(ancestor);
      requireThat(!stat.isSymbolicLink() && stat.isDirectory(), "unsafe_path");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  requireThat(!contains(directory, REPOSITORY)
    && (!contains(REPOSITORY, directory) || contains(path.join(REPOSITORY, "data"), directory)), "unsafe_path");
  const protectedPaths = ["site", "public", "collector-data", ".github"].map((name) => path.join(REPOSITORY, name));
  protectedPaths.push(publicOutputDir || path.join(REPOSITORY, "site"), evidenceOutputDir || path.join(REPOSITORY, "data", "collector"));
  for (const protectedPath of protectedPaths) {
    const location = physicalLocation(protectedPath);
    requireThat(!contains(directory, location) && !contains(location, directory), "unsafe_path");
  }
}

function regularFile(file) {
  const stat = fs.lstatSync(file);
  requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_RECORD_BYTES, "invalid_store");
}
function fileExists(file) {
  try { regularFile(file); return true; }
  catch (error) { if (error && Object.getOwnPropertyDescriptor(error, "code")?.value === "ENOENT") return false; throw error; }
}
const serialize = (record) => Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");

function createAttemptStore(value) {
  let options;
  try {
    options = dataObject(value, ["directory"], ["publicOutputDir", "evidenceOutputDir"]);
    requireThat(typeof options.directory === "string" && path.isAbsolute(options.directory), "unsafe_path");
    for (const key of ["publicOutputDir", "evidenceOutputDir"]) requireThat(options[key] === undefined
      || typeof options[key] === "string" && path.isAbsolute(options[key]), "unsafe_path");
  } catch (error) { if (OWN_ERRORS.has(error) && error.code === "collector_attempt_unsafe_path") throw error; fail("invalid_record"); }
  const directory = path.resolve(options.directory);
  try { assertDirectory(directory, options.publicOutputDir, options.evidenceOutputDir); }
  catch (error) { if (OWN_ERRORS.has(error) && error.code === "collector_attempt_unsafe_path") throw error; fail("storage_failed"); }
  return {
    save(value) {
      const record = projectPublicAttempt(value);
      const bytes = serialize(record);
      requireThat(bytes.length <= MAX_RECORD_BYTES, "record_limit");
      const target = path.join(directory, `${hash(logicalIdentity(record))}.json`);
      const lock = path.join(directory, ".write-lock");
      const temporary = path.join(lock, "record.tmp");
      let locked = false, descriptor;
      try {
        assertDirectory(directory, options.publicOutputDir, options.evidenceOutputDir);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        assertDirectory(directory, options.publicOutputDir, options.evidenceOutputDir);
        try { fs.mkdirSync(lock, { mode: 0o700 }); }
        catch (error) { if (error.code === "EEXIST") fail("store_locked"); throw error; }
        locked = true;
        if (fileExists(target)) {
          const original = fs.readFileSync(target);
          const prior = projectPublicAttempt(parseStrictJsonBytes(original, { maxBytes: MAX_RECORD_BYTES }).value);
          requireThat(original.equals(serialize(prior)), "invalid_store");
          requireThat(sameBeginning(prior, record), "identity_collision");
          if (prior.recordSha256 === record.recordSha256) return { status: "idempotent" };
          if (prior.finishedAt !== null && record.finishedAt === null) fail("state_regression");
          requireThat(prior.finishedAt === null && record.finishedAt !== null, "identity_collision");
        }
        descriptor = fs.openSync(temporary, "wx", 0o600);
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fileExists(target);
        fs.renameSync(temporary, target);
        return { status: "saved" };
      } catch (error) {
        if (OWN_ERRORS.has(error)) throw error;
        fail("storage_failed");
      } finally {
        if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch { /* Preserve the fixed primary failure. */ } }
        if (locked) {
          let failed = false;
          try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { failed = true; }
          try { fs.rmdirSync(lock); } catch { failed = true; }
          if (failed) fail("cleanup_failed");
        }
      }
    }
  };
}

module.exports = { createAttempt, finishAttempt, projectPublicAttempt, createAttemptStore, selectLatestAttempt, projectDiagnostics };
