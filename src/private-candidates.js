"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { normalizePublicJobRef, normalizePublicTimestamp } = require("./public-evidence");
const { APPROVED_POLICY } = require("./private-candidate-policy");

const REPOSITORY = path.resolve(__dirname, "..");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const REASONS = new Set(["matched_skill", "strong_signal", "risk_keyword", "budget_detected",
  "machine_candidate", "machine_not_candidate"]);
const SOURCE_FILES = ["daily.js", "collector.js", "scraper.js", "model.js", "public-evidence.js",
  "store.js", "private-candidates.js", "private-candidate-policy.js"];

function fail(code) {
  // Never expose a filesystem error, arbitrary path, job body or caller-supplied value.
  const error = new Error(`private_candidates_${code}`);
  error.code = error.message;
  throw error;
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function collectorIdentity() {
  try {
    const sources = SOURCE_FILES.map((name) => [name, fs.readFileSync(path.join(__dirname, name), "utf8")
      .replace(/\r\n/g, "\n")]);
    return { version: "private-candidates-v1", sourceSha256: hash(stableJson(sources)) };
  } catch { fail("storage_failed"); }
}

function nonnegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function buildCandidateRecord({ snapshot, summary, executionId, extractedAt }) {
  if (!snapshot || !summary || !UUID.test(executionId) || !normalizePublicTimestamp(extractedAt)
    || snapshot.kind !== "collector_snapshot" || snapshot.schemaVersion !== 1
    || !Array.isArray(snapshot.jobs) || !Array.isArray(snapshot.candidateIds)
    || !snapshot.coverage || snapshot.generatedAt !== summary.generatedAt) fail("invalid_record");
  const generatedAt = normalizePublicTimestamp(snapshot.generatedAt);
  if (!generatedAt) fail("invalid_record");
  const { runId, ...source } = snapshot;
  const snapshotSha256 = hash(stableJson(source));
  const expectedRunId = `${generatedAt.replace(/[-:.]/g, "")}-${snapshotSha256.slice(0, 16)}`;
  if (runId !== expectedRunId) fail("invalid_record");

  const jobMap = new Map();
  for (const job of snapshot.jobs) {
    if (!job || typeof job.id !== "string" || jobMap.has(job.id)) fail("invalid_record");
    jobMap.set(job.id, job);
  }
  if (new Set(snapshot.candidateIds).size !== snapshot.candidateIds.length) fail("invalid_record");
  const candidates = snapshot.candidateIds.map((id) => {
    const job = jobMap.get(id);
    const ref = job && normalizePublicJobRef({ platform: job.platform, id, url: job.url });
    const fetchedAt = job && normalizePublicTimestamp(job.fetchedAt);
    const reasonCodes = job && job.machineJudgment && job.machineJudgment.reasonCodes;
    if (!ref || ref.platform !== "crowdworks" || ref.url !== job.url || !fetchedAt
      || job.candidate !== true || job.machineJudgment.canExecute !== true
      || !Array.isArray(reasonCodes) || !reasonCodes.includes("machine_candidate")
      || reasonCodes.some((code) => !REASONS.has(code))
      || new Set(reasonCodes).size !== reasonCodes.length) fail("invalid_record");
    return { id: ref.jobId, url: ref.url, fetchedAt, reasonCodes: [...reasonCodes].sort() };
  }).sort((a, b) => a.id.localeCompare(b.id));

  const count = summary.safeCandidates;
  const total = summary.totalJobs;
  const unknown = count === null && total === null;
  if ((!unknown && (!nonnegative(count) || !nonnegative(total)))
    || snapshot.coverage.candidateCount !== count || snapshot.coverage.retrievedJobCount !== total
    || (unknown ? candidates.length !== 0 || snapshot.jobs.length !== 0
      : candidates.length !== count || snapshot.jobs.length !== total)
    || snapshot.jobs.filter((job) => job.candidate === true).length !== candidates.length) {
    fail("candidate_count_mismatch");
  }
  const record = {
    schemaVersion: 1, kind: "private_machine_candidates", executionId, runId, generatedAt,
    extractedAt: normalizePublicTimestamp(extractedAt), collector: collectorIdentity(),
    snapshotSha256,
    // Match the exact UTF-8 serialization written by store.writeJson / writeReport.
    summarySha256: hash(JSON.stringify(summary, null, 2)),
    assessment: "machine_extraction_only",
    counts: { summaryCandidateCount: count, listCount: candidates.length,
      retrievedJobCount: total, reconciliation: unknown ? "unknown" : "matched" },
    candidates
  };
  return { ...record, recordSha256: hash(stableJson(record)) };
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function noSymlinkAncestors(directory) {
  let current = directory;
  while (true) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail("unsafe_path");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function resolvedLocation(directory) {
  let current = directory;
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.resolve(fs.realpathSync(current), ...suffix);
}

function assertPrivatePath(directory, publicOutputDir, evidenceOutputDir) {
  noSymlinkAncestors(directory);
  // Inside this public repository only ignored data/ is an eligible local destination.
  if (contains(directory, REPOSITORY)
    || (contains(REPOSITORY, directory) && !contains(path.join(REPOSITORY, "data"), directory))) fail("unsafe_path");
  const publicPaths = ["site", "public", "collector-data", ".github"].map((name) => path.join(REPOSITORY, name));
  if (typeof publicOutputDir === "string") publicPaths.push(path.resolve(publicOutputDir));
  for (const publicPath of publicPaths) {
    const publicLocation = resolvedLocation(publicPath);
    if (contains(directory, publicLocation) || contains(publicLocation, directory)) fail("unsafe_path");
  }
  const evidenceLocation = resolvedLocation(evidenceOutputDir || path.join(REPOSITORY, "data", "collector"));
  if (contains(directory, evidenceLocation) || contains(evidenceLocation, directory)) fail("unsafe_path");
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe_path");
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) fail("unsafe_path");
  }
}

function policyFrom(value) {
  if (!value || typeof value !== "object") fail("policy_required");
  const keys = ["maxCandidates", "maxRuns", "maxTotalBytes", "retentionDays"];
  if (keys.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 1
    || value[key] > APPROVED_POLICY[key])) fail("invalid_policy");
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function readStored(file, policy) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > policy.maxTotalBytes) fail("invalid_store");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) fail("unsafe_path");
  const bytes = fs.readFileSync(file);
  let record;
  try { record = JSON.parse(bytes.toString("utf8")); } catch { fail("invalid_store"); }
  const { recordSha256, ...content } = record || {};
  if (!record || record.kind !== "private_machine_candidates" || record.schemaVersion !== 1
    || !UUID.test(record.executionId) || !normalizePublicTimestamp(record.extractedAt)
    || !HASH.test(recordSha256) || hash(stableJson(content)) !== recordSha256) fail("invalid_store");
  if (path.basename(file) !== `${record.executionId}.json`) fail("invalid_store");
  const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
  if (!exactKeys(record, ["schemaVersion", "kind", "executionId", "runId", "generatedAt", "extractedAt",
    "collector", "snapshotSha256", "summarySha256", "assessment", "counts", "candidates", "recordSha256"])
    || !exactKeys(record.collector, ["version", "sourceSha256"])
    || record.collector.version !== "private-candidates-v1" || !HASH.test(record.collector.sourceSha256)
    || !HASH.test(record.snapshotSha256) || !HASH.test(record.summarySha256)
    || !normalizePublicTimestamp(record.generatedAt) || record.assessment !== "machine_extraction_only"
    || record.runId !== `${record.generatedAt.replace(/[-:.]/g, "")}-${record.snapshotSha256.slice(0, 16)}`
    || !exactKeys(record.counts, ["summaryCandidateCount", "listCount", "retrievedJobCount", "reconciliation"])
    || !Array.isArray(record.candidates) || record.counts.listCount !== record.candidates.length
    || new Set(record.candidates.map((candidate) => candidate && candidate.id)).size !== record.candidates.length) fail("invalid_store");
  const counts = record.counts;
  if (counts.reconciliation === "unknown") {
    if (counts.summaryCandidateCount !== null || counts.retrievedJobCount !== null || counts.listCount !== 0) fail("invalid_store");
  } else if (counts.reconciliation !== "matched" || !nonnegative(counts.summaryCandidateCount)
    || !nonnegative(counts.retrievedJobCount) || counts.summaryCandidateCount !== counts.listCount
    || counts.retrievedJobCount < counts.listCount) fail("invalid_store");
  for (const candidate of record.candidates) {
    const ref = candidate && normalizePublicJobRef({ platform: "crowdworks", id: candidate.id, url: candidate.url });
    if (!exactKeys(candidate, ["id", "url", "fetchedAt", "reasonCodes"]) || !ref
      || ref.jobId !== candidate.id || ref.url !== candidate.url || !normalizePublicTimestamp(candidate.fetchedAt)
      || !Array.isArray(candidate.reasonCodes) || !candidate.reasonCodes.includes("machine_candidate")
      || candidate.reasonCodes.some((code) => !REASONS.has(code))
      || new Set(candidate.reasonCodes).size !== candidate.reasonCodes.length) fail("invalid_store");
  }
  return { record, bytes };
}

function enforceCapacity(directory, policy, record, bytes) {
  const files = fs.readdirSync(directory).filter((name) => name !== ".write-lock");
  let existingBytes = 0;
  for (const name of files) {
    if (!UUID.test(name.replace(/\.json$/, "")) || !name.endsWith(".json")) fail("invalid_store");
    const saved = readStored(path.join(directory, name), policy);
    existingBytes += saved.bytes.length;
    if (new Date(record.extractedAt) - new Date(saved.record.extractedAt) >= policy.retentionDays * 86400000) {
      // Preserve expired observations; operator decides private archival/deletion separately.
      fail("retention_review_required");
    }
  }
  if (files.length >= policy.maxRuns) fail("run_limit");
  if (existingBytes + bytes.length > policy.maxTotalBytes) fail("byte_limit");
}

function createPrivateCandidateStore(options, context = {}) {
  if (!options || options.enabled === false || options.enabled === undefined) {
    return { save: () => ({ status: "disabled" }), read: () => ({ status: "disabled" }) };
  }
  if (options.enabled !== true) fail("invalid_policy");
  const { publicOutputDir, evidenceOutputDir } = context;
  if (process.env.GITHUB_ACTIONS || process.env.CI) fail("ci_forbidden");
  const policy = policyFrom(options.policy);
  if (typeof options.outputDir !== "string" || !path.isAbsolute(options.outputDir)) fail("unsafe_path");
  const directory = path.resolve(options.outputDir);
  const executionId = options.executionId || crypto.randomUUID();
  if (!UUID.test(executionId)) fail("invalid_record");
  let extractedAt = options.extractedAt;
  if (extractedAt !== undefined && !normalizePublicTimestamp(extractedAt)) fail("invalid_record");
  try { assertPrivatePath(directory, publicOutputDir, evidenceOutputDir); }
  catch (error) {
    if (String(error.code).startsWith("private_candidates_")) throw error;
    fail("storage_failed");
  }

  return {
    read({ executionId: requestedId = executionId, now = new Date().toISOString() } = {}) {
      if (process.env.GITHUB_ACTIONS || process.env.CI) fail("ci_forbidden");
      if (!UUID.test(requestedId) || !normalizePublicTimestamp(now)) fail("invalid_record");
      try {
        assertPrivatePath(directory, publicOutputDir, evidenceOutputDir);
        const saved = readStored(path.join(directory, `${requestedId}.json`), policy);
        if (new Date(now) - new Date(saved.record.extractedAt) >= policy.retentionDays * 86400000) {
          return { status: "expired", requiresReview: true };
        }
        return { status: "available", record: saved.record };
      } catch (error) {
        if (String(error.code).startsWith("private_candidates_")) throw error;
        if (error.code === "ENOENT") return { status: "not_found" };
        fail("storage_failed");
      }
    },
    save({ snapshot, summary }) {
      if (process.env.GITHUB_ACTIONS || process.env.CI) fail("ci_forbidden");
      extractedAt = extractedAt || new Date().toISOString();
      let locked = false;
      let descriptor;
      const lock = path.join(directory, ".write-lock");
      const temporary = path.join(lock, "record.tmp");
      try {
        const record = buildCandidateRecord({ snapshot, summary, executionId, extractedAt });
        if (record.candidates.length > policy.maxCandidates) fail("candidate_limit");
        const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
        if (bytes.length > policy.maxTotalBytes) fail("byte_limit");
        assertPrivatePath(directory, publicOutputDir, evidenceOutputDir);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        assertPrivatePath(directory, publicOutputDir, evidenceOutputDir);
        try { fs.mkdirSync(lock, { mode: 0o700 }); }
        catch (error) {
          if (error.code === "EEXIST") fail("store_locked");
          throw error;
        }
        locked = true;
        const target = path.join(directory, `${executionId}.json`);
        if (fs.existsSync(target)) {
          const saved = readStored(target, policy);
          if (!saved.bytes.equals(bytes)) fail("identity_collision");
          // An identical retry creates no observation and remains valid at capacity/expiry.
          return { status: "idempotent", count: record.candidates.length };
        }
        enforceCapacity(directory, policy, record, bytes);
        descriptor = fs.openSync(temporary, "wx", 0o600);
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        // Hard-link publication is atomic and fails if the target already exists.
        fs.linkSync(temporary, target);
        return { status: "saved", count: record.candidates.length };
      } catch (error) {
        if (String(error.code).startsWith("private_candidates_")) throw error;
        fail("storage_failed");
      } finally {
        if (descriptor !== undefined) {
          try { fs.closeSync(descriptor); } catch { /* Primary failure is already explicit. */ }
        }
        if (locked) {
          // Delete only this writer's temporary file/empty lock; never touch saved observations.
          let cleanupFailed = false;
          try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { cleanupFailed = true; }
          try { fs.rmdirSync(lock); } catch { cleanupFailed = true; }
          if (cleanupFailed) fail("cleanup_failed");
        }
      }
    }
  };
}

module.exports = { createPrivateCandidateStore };
