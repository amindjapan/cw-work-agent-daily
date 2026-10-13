"use strict";

// This adapter receives an already connected service. It never discovers credentials,
// performs HTTP requests, changes sharing, deletes records, or runs the Collector.
const crypto = require("node:crypto");
const { normalizePublicJobRef, normalizePublicTimestamp } = require("./public-evidence");
const { APPROVED_POLICY } = require("./private-candidate-policy");

const PREFIX = "CW_PRIVATE_MACHINE_CANDIDATES_V1__";
const SYNTHETIC_PREFIX = `${PREFIX}SYNTHETIC_TEST__`;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const REASONS = new Set(["matched_skill", "strong_signal", "risk_keyword", "budget_detected",
  "machine_candidate", "machine_not_candidate"]);
const LABEL = "合成保存接続試験 / SYNTHETIC STORAGE PROBE — 実案件取得記録ではありません";
const INTERNAL_ERRORS = new WeakSet();

function fail(code) {
  const error = new Error(`private_candidate_drive_${code}`);
  error.code = error.message;
  INTERNAL_ERRORS.add(error);
  throw error;
}

function hash(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function exactKeys(value, keys) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function timestamp(value) { return normalizePublicTimestamp(value) === value; }
function assertPolicy() {
  if (!APPROVED_POLICY || APPROVED_POLICY.maxCandidates !== 100 || APPROVED_POLICY.maxRuns !== 60
    || APPROVED_POLICY.maxTotalBytes !== 5 * 1024 * 1024 || APPROVED_POLICY.retentionDays !== 30) {
    fail("invalid_policy");
  }
}

function validateRecord(record) {
  assertPolicy();
  if (!exactKeys(record, ["schemaVersion", "kind", "executionId", "runId", "generatedAt", "extractedAt",
    "collector", "snapshotSha256", "summarySha256", "assessment", "counts", "candidates", "recordSha256"])
    || record.schemaVersion !== 1 || record.kind !== "private_machine_candidates"
    || record.assessment !== "machine_extraction_only" || !UUID.test(record.executionId)
    || !timestamp(record.generatedAt) || !timestamp(record.extractedAt)
    || !exactKeys(record.collector, ["version", "sourceSha256"])
    || record.collector.version !== "private-candidates-v1"
    || ![record.collector.sourceSha256, record.snapshotSha256, record.summarySha256, record.recordSha256]
      .every((value) => typeof value === "string" && HASH.test(value))
    || record.runId !== `${record.generatedAt.replace(/[-:.]/g, "")}-${record.snapshotSha256.slice(0, 16)}`
    || !exactKeys(record.counts, ["summaryCandidateCount", "listCount", "retrievedJobCount", "reconciliation"])
    || !Array.isArray(record.candidates)) fail("invalid_record");
  if (record.candidates.length > APPROVED_POLICY.maxCandidates) fail("candidate_limit");
  const ids = new Set();
  for (const item of record.candidates) {
    if (!exactKeys(item, ["id", "url", "fetchedAt", "reasonCodes"]) || typeof item.id !== "string"
      || !timestamp(item.fetchedAt) || !Array.isArray(item.reasonCodes)
      || !item.reasonCodes.includes("machine_candidate")
      || item.reasonCodes.some((reason) => !REASONS.has(reason))
      || new Set(item.reasonCodes).size !== item.reasonCodes.length || ids.has(item.id)) fail("invalid_record");
    const ref = normalizePublicJobRef({ platform: "crowdworks", id: item.id, url: item.url });
    if (!ref || ref.url !== item.url) fail("invalid_record");
    ids.add(item.id);
  }
  const { summaryCandidateCount, listCount, retrievedJobCount, reconciliation } = record.counts;
  const unknown = summaryCandidateCount === null && retrievedJobCount === null;
  if (listCount !== record.candidates.length || (unknown
    ? listCount !== 0 || reconciliation !== "unknown"
    : !count(summaryCandidateCount) || !count(retrievedJobCount) || summaryCandidateCount !== listCount
      || retrievedJobCount < listCount || reconciliation !== "matched")) fail("candidate_count_mismatch");
  const { recordSha256, ...content } = record;
  if (hash(stableJson(content)) !== recordSha256) fail("identity_mismatch");
}

function prepareDriveRecord({ record, synthetic } = {}) {
  if (synthetic !== true) fail("synthetic_only");
  validateRecord(record);
  // Serialize and parse only after validation so caller mutation cannot alter a prepared upload.
  const payloadJson = JSON.stringify(record);
  const payload = JSON.parse(payloadJson);
  validateRecord(payload);
  const expiresAt = new Date(new Date(payload.extractedAt).getTime()
    + APPROVED_POLICY.retentionDays * 86400000).toISOString();
  const content = {
    kind: "private_machine_candidate_drive_record", schemaVersion: 1,
    purpose: "synthetic_storage_probe", synthetic: true, label: LABEL,
    expiresAt, payload, payloadSha256: hash(payloadJson)
  };
  const envelopeSha256 = hash(stableJson(content));
  const envelope = { ...content, envelopeSha256 };
  const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  if (bytes.length > APPROVED_POLICY.maxTotalBytes) fail("byte_limit");
  return { fileName: `${SYNTHETIC_PREFIX}${record.executionId}.json`, bytes, envelope,
    payloadSha256: content.payloadSha256, envelopeSha256, bytesSha256: hash(bytes),
    expiresAt, count: payload.candidates.length, executionId: payload.executionId };
}

function assertFolderId(folderId) {
  if (typeof folderId !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(folderId)) fail("invalid_destination");
}
function assertPrivateMetadata(metadata) {
  if (!metadata || metadata.shared !== false || !Array.isArray(metadata.permissions)
    || metadata.permissions.length === 0 || metadata.permissions.some((permission) =>
      !permission || permission.role !== "owner" || permission.type !== "user")) fail("privacy_unverified");
}
function assertFolderMetadata(metadata, folderId) {
  assertFolderId(folderId);
  if (!metadata || metadata.id !== folderId || metadata.mime_type !== "application/vnd.google-apps.folder") {
    fail("invalid_destination");
  }
  assertPrivateMetadata(metadata);
  return { status: "private_folder_verified" };
}
function fileSize(value) {
  const number = typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
  if (!count(number)) fail("incomplete_inventory");
  return number;
}
function assertFileMetadata(metadata, folderId) {
  if (!metadata || typeof metadata.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(metadata.id)
    || metadata.mime_type !== "application/json" || !Array.isArray(metadata.parent_ids)
    || metadata.parent_ids.length !== 1 || metadata.parent_ids[0] !== folderId
    || typeof metadata.name !== "string" || !metadata.name.startsWith(SYNTHETIC_PREFIX)
    || !metadata.name.endsWith(".json")
    || !UUID.test(metadata.name.slice(SYNTHETIC_PREFIX.length, -5))) fail("invalid_store");
  assertPrivateMetadata(metadata);
  return fileSize(metadata.size);
}

function canonicalPrepared(prepared) {
  if (!prepared || !prepared.envelope) fail("invalid_record");
  const expected = prepareDriveRecord({ record: prepared.envelope.payload, synthetic: true });
  if (prepared.fileName !== expected.fileName || stableJson(prepared.envelope) !== stableJson(expected.envelope)
    || !Buffer.isBuffer(prepared.bytes) || !prepared.bytes.equals(expected.bytes)) fail("identity_mismatch");
  return expected;
}

function assessInventory({ inventory, folderId, prepared } = {}) {
  assertFolderId(folderId);
  const expected = canonicalPrepared(prepared);
  if (!inventory || inventory.complete !== true || !Array.isArray(inventory.files)) fail("incomplete_inventory");
  if (inventory.files.some((file) => !file || typeof file.name !== "string" || typeof file.id !== "string")) {
    fail("incomplete_inventory");
  }
  const files = inventory.files.filter((file) => file.name.startsWith(PREFIX));
  const names = new Set();
  const ids = new Set();
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += assertFileMetadata(file, folderId);
    if (names.has(file.name) || ids.has(file.id)) fail("identity_collision");
    names.add(file.name);
    ids.add(file.id);
  }
  if (files.length > APPROVED_POLICY.maxRuns) fail("run_limit");
  if (!Number.isSafeInteger(totalBytes) || totalBytes > APPROVED_POLICY.maxTotalBytes) fail("byte_limit");
  const existing = files.find((file) => file.name === expected.fileName);
  if (!existing && files.length >= APPROVED_POLICY.maxRuns) fail("run_limit");
  if (!existing && totalBytes + expected.bytes.length > APPROVED_POLICY.maxTotalBytes) fail("byte_limit");
  return { status: existing ? "read_existing" : "ready_for_new_record", existing: existing || null,
    files, recordCount: files.length, totalBytes };
}

function decodeBytes(value) {
  if (!(Buffer.isBuffer(value) || typeof value === "string")) fail("incomplete_readback");
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (bytes.length > APPROVED_POLICY.maxTotalBytes) fail("byte_limit");
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("incomplete_readback"); }
  return bytes;
}

function storedRecord({ bytes, metadata, folderId, now = new Date().toISOString() } = {}) {
  assertFolderId(folderId);
  if (!timestamp(now)) fail("invalid_timestamp");
  const actual = decodeBytes(bytes);
  if (assertFileMetadata(metadata, folderId) !== actual.length) fail("incomplete_readback");
  let envelope;
  try { envelope = JSON.parse(actual.toString("utf8")); } catch { fail("incomplete_readback"); }
  if (!exactKeys(envelope, ["kind", "schemaVersion", "purpose", "synthetic", "label", "expiresAt",
    "payload", "payloadSha256", "envelopeSha256"])) fail("invalid_store");
  const expected = prepareDriveRecord({ record: envelope.payload, synthetic: envelope.synthetic });
  if (metadata.name !== expected.fileName || !actual.equals(expected.bytes)) fail("identity_mismatch");
  const expired = new Date(now).getTime() >= new Date(expected.expiresAt).getTime();
  return { expected, expired };
}

function safeReference(expected, metadata, expired) {
  return { status: expired ? "expired" : "verified", requiresReview: expired,
    ref: { fileId: metadata.id }, count: expected.count, executionId: expected.executionId,
    payloadSha256: expected.payloadSha256, envelopeSha256: expected.envelopeSha256,
    bytesSha256: expected.bytesSha256, expiresAt: expected.expiresAt };
}

function verifyStoredDriveRecord(options) {
  const { expected, expired } = storedRecord(options);
  return safeReference(expected, options.metadata, expired);
}

function verifyDriveReadback({ prepared, bytes, metadata, folderId, now } = {}) {
  const planned = canonicalPrepared(prepared);
  const { expected, expired } = storedRecord({ bytes, metadata, folderId, now });
  if (!expected.bytes.equals(planned.bytes)) fail("identity_mismatch");
  return safeReference(expected, metadata, expired);
}

function noCi() { if (process.env.CI || process.env.GITHUB_ACTIONS) fail("ci_forbidden"); }

function createConnectedPrivateCandidateAdapter(options = {}) {
  if (options.enabled === undefined || options.enabled === false) return { save: async () => ({ status: "disabled" }) };
  if (options.enabled !== true) fail("invalid_configuration");
  noCi();
  assertPolicy();
  const { folderId, transport } = options;
  assertFolderId(folderId);
  if (!transport || ["getFolderMetadata", "listRecords", "uploadFile", "readFile", "getFileMetadata"]
    .some((name) => typeof transport[name] !== "function")) fail("connection_required");
  let uploading = false;
  let uploadAttempted = false;
  return {
    async save({ record, fileUri, synthetic, now = new Date().toISOString() } = {}) {
      noCi();
      if (uploading || uploadAttempted) fail("attempt_consumed");
      const prepared = prepareDriveRecord({ record, synthetic });
      if (!timestamp(now)) fail("invalid_timestamp");
      uploading = true;
      try {
        assertFolderMetadata(await transport.getFolderMetadata(folderId), folderId);
        const plan = assessInventory({ inventory: await transport.listRecords(folderId, { prefix: PREFIX }),
          folderId, prepared });
        // Existing records retain their bytes and count toward both capacity limits.
        for (const file of plan.files) {
          const metadata = await transport.getFileMetadata(file.id);
          if (!metadata || metadata.id !== file.id || metadata.name !== file.name) fail("identity_mismatch");
          if (assertFileMetadata(metadata, folderId) !== fileSize(file.size)) fail("inventory_changed");
          const bytes = await transport.readFile(file.id);
          const result = file.name === prepared.fileName
            ? verifyDriveReadback({ prepared, bytes, metadata, folderId, now })
            : verifyStoredDriveRecord({ bytes, metadata, folderId, now });
          if (file.name === prepared.fileName) return { ...result, status: result.status === "expired" ? "expired" : "idempotent" };
          if (result.status === "expired") fail("retention_review_required");
        }
        if (new Date(now) >= new Date(prepared.expiresAt)) fail("retention_review_required");
        if (typeof fileUri !== "string" || fileUri.length === 0 || fileUri.length > 4096
          || /[\r\n\0]/.test(fileUri)) fail("invalid_upload_source");
        // A connected transport must stage this exact prepared byte sequence. Its source
        // verifier may only read the existing staged URI; it must never retrieve credentials.
        if (typeof transport.verifyUploadSource !== "function") fail("source_verification_required");
        const source = await transport.verifyUploadSource({ file_uri: fileUri,
          bytesSha256: prepared.bytesSha256, byteLength: prepared.bytes.length });
        if (!source || source.verified !== true) fail("invalid_upload_source");
        noCi();
        // Consume the one create attempt before awaiting; uncertain outcomes never retry.
        uploadAttempted = true;
        const uploaded = await transport.uploadFile({ file_uri: fileUri, file_name: prepared.fileName,
          mime_type: "application/json", parent_folder_id: folderId });
        if (!uploaded || typeof uploaded.id !== "string") fail("upload_outcome_unknown");
        const metadata = await transport.getFileMetadata(uploaded.id);
        if (!metadata || metadata.id !== uploaded.id) fail("identity_mismatch");
        assertFileMetadata(metadata, folderId);
        const bytes = await transport.readFile(uploaded.id);
        const result = verifyDriveReadback({ prepared, bytes, metadata, folderId, now });
        // Recheck the folder: a changed sharing state invalidates this verification.
        assertFolderMetadata(await transport.getFolderMetadata(folderId), folderId);
        const finalPlan = assessInventory({ inventory: await transport.listRecords(folderId, { prefix: PREFIX }),
          folderId, prepared });
        if (!finalPlan.existing || finalPlan.existing.id !== uploaded.id) fail("identity_mismatch");
        return result;
      } catch (error) {
        if (INTERNAL_ERRORS.has(error)) throw error;
        fail(uploadAttempted ? "upload_outcome_unknown" : "connection_failed");
      } finally { uploading = false; }
    }
  };
}

module.exports = { PREFIX, prepareDriveRecord, assertFolderMetadata, assessInventory,
  verifyDriveReadback, verifyStoredDriveRecord, createConnectedPrivateCandidateAdapter };
