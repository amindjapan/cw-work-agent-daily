"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { PREFIX, prepareDriveRecord, assertFolderMetadata, assessInventory, verifyDriveReadback,
  verifyStoredDriveRecord, createConnectedPrivateCandidateAdapter } = require("../src/private-candidate-drive");

const FOLDER = "synthetic_private_folder_12345";
const ID = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-10-13T03:18:00.000Z";
const EXPIRES = "2026-11-12T03:18:00.000Z";
const SENTINEL = "synthetic-contact@example.invalid synthetic-secret-value";
const ORIGINAL_CI = { CI: process.env.CI, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS };
delete process.env.CI;
delete process.env.GITHUB_ACTIONS;
test.after(() => {
  for (const [key, value] of Object.entries(ORIGINAL_CI)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function hash(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function seal(record) {
  const { recordSha256, ...content } = record;
  return { ...content, recordSha256: hash(stableJson(content)) };
}
function record(n = 1, options = {}) {
  const value = {
    kind: "private_machine_candidates", schemaVersion: 1, executionId: ID,
    generatedAt: NOW, extractedAt: NOW,
    collector: { version: "private-candidates-v1", sourceSha256: "2".repeat(64) },
    snapshotSha256: "0".repeat(64), summarySha256: "1".repeat(64),
    assessment: "machine_extraction_only",
    counts: { summaryCandidateCount: n, listCount: n, retrievedJobCount: n, reconciliation: "matched" },
    candidates: Array.from({ length: n }, (_, i) => ({ id: String(i + 1),
      url: `https://crowdworks.jp/public/jobs/${i + 1}`, fetchedAt: NOW,
      reasonCodes: ["machine_candidate"] })), ...options
  };
  value.runId = `${value.generatedAt.replace(/[-:.]/g, "")}-${value.snapshotSha256.slice(0, 16)}`;
  return seal(value);
}
function prepared(value = record()) { return prepareDriveRecord({ record: value, synthetic: true }); }
function folder(extra = {}) {
  return { id: FOLDER, mime_type: "application/vnd.google-apps.folder", shared: false,
    permissions: [{ type: "user", role: "owner" }], ...extra };
}
function metadata(plan = prepared(), extra = {}) {
  return { id: "synthetic_file_1", name: plan.fileName, mime_type: "application/json",
    parent_ids: [FOLDER], size: plan.bytes.length, shared: false,
    permissions: [{ type: "user", role: "owner" }], ...extra };
}
function failure(code, action) {
  return assert.rejects(async () => action(), (error) => {
    assert.equal(error.code, `private_candidate_drive_${code}`);
    assert.equal(error.message, error.code);
    assert.equal(error.message.includes(SENTINEL), false);
    return true;
  });
}
function service(plan = prepared(), existing = []) {
  const files = new Map(existing.map((item, i) => [item.metadata.id, item]));
  const calls = [];
  const transport = {
    async getFolderMetadata(id) { calls.push(["folder", id]); return folder(); },
    async listRecords(id, options) {
      calls.push(["list", id, options]);
      return { complete: true, files: [...files.values()].map((item) => ({ ...item.metadata })) };
    },
    async verifyUploadSource({ file_uri, bytesSha256, byteLength }) {
      calls.push(["source", file_uri]);
      return { verified: file_uri === "private-staged-file" && bytesSha256 === hash(plan.bytes)
        && byteLength === plan.bytes.length };
    },
    async uploadFile(args) {
      calls.push(["upload", args]);
      const item = { metadata: metadata(plan), bytes: plan.bytes };
      files.set(item.metadata.id, item);
      return { id: item.metadata.id };
    },
    async readFile(id) { calls.push(["read", id]); return files.get(id).bytes; },
    async getFileMetadata(id) { calls.push(["metadata", id]); return files.get(id).metadata; }
  };
  return { transport, files, calls, creates: () => calls.filter((call) => call[0] === "upload") };
}
function adapter(transport) {
  return createConnectedPrivateCandidateAdapter({ enabled: true, folderId: FOLDER, transport });
}
function save(store, value = record(), options = {}) {
  return store.save({ record: value, synthetic: true, now: NOW, fileUri: "private-staged-file", ...options });
}

test("disabled adapter is inert and does not inspect credentials, transport or record", async () => {
  const poisonous = { enabled: false };
  for (const key of ["folderId", "transport", "policy"]) {
    Object.defineProperty(poisonous, key, { get() { throw new Error("disabled access"); } });
  }
  for (const options of [undefined, {}, poisonous]) {
    assert.deepEqual(await createConnectedPrivateCandidateAdapter(options).save(null), { status: "disabled" });
  }
});

test("synthetic preparation reconciles counts and seals exact UTF8 payload and envelope", () => {
  const plan = prepared(record(2));
  assert.equal(plan.fileName, `${PREFIX}SYNTHETIC_TEST__${ID}.json`);
  assert.equal(plan.expiresAt, EXPIRES);
  assert.equal(plan.count, 2);
  assert.equal(plan.envelope.synthetic, true);
  assert.equal(plan.envelope.purpose, "synthetic_storage_probe");
  assert.match(plan.envelope.label, /合成.*SYNTHETIC.*実案件取得記録ではありません/);
  assert.equal(plan.payloadSha256, hash(JSON.stringify(plan.envelope.payload)));
  const { envelopeSha256, ...content } = plan.envelope;
  assert.equal(envelopeSha256, hash(stableJson(content)));
  assert.equal(plan.bytesSha256, hash(plan.bytes));
  assert.equal(plan.bytes.length, Buffer.byteLength(plan.bytes.toString("utf8")));
});

test("preparation snapshots caller data before later mutation", () => {
  const source = record();
  const plan = prepared(source);
  source.candidates[0].id = "2";
  assert.equal(plan.envelope.payload.candidates[0].id, "1");
});

test("verified zero and UNKNOWN remain different", () => {
  assert.equal(prepared(record(0)).envelope.payload.counts.reconciliation, "matched");
  const unknown = record(0, { counts: { summaryCandidateCount: null, listCount: 0,
    retrievedJobCount: null, reconciliation: "unknown" } });
  assert.equal(prepared(unknown).envelope.payload.counts.reconciliation, "unknown");
});

test("current authorization admits synthetic probes only", async () => {
  for (const synthetic of [undefined, false, "true"]) {
    await failure("synthetic_only", () => prepareDriveRecord({ record: record(), synthetic }));
  }
});

test("resealed extra private fields are rejected at every nested allowlist", async () => {
  for (const mutate of [
    (value) => { value.privateMessage = SENTINEL; },
    (value) => { value.collector.token = SENTINEL; },
    (value) => { value.counts.notes = SENTINEL; },
    (value) => { value.candidates[0].title = SENTINEL; },
    (value) => { value.candidates[0].reasonCodes = ["machine_candidate", SENTINEL]; },
    (value) => { value.collector.version = SENTINEL; }
  ]) {
    const value = record(); mutate(value);
    await failure("invalid_record", () => prepared(seal(value)));
  }
});

test("serialization hooks cannot substitute unvalidated private data", async () => {
  const value = record();
  value.candidates.toJSON = () => [{ privateMessage: SENTINEL }];
  // The ordinary record hash is unchanged by array properties; postserialization
  // validation must reject the substituted payload before any upload can occur.
  await failure("invalid_record", () => prepared(value));
});

test("malformed ids, URL decoration, time, reason duplicate, count and identity are rejected", async () => {
  for (const mutate of [
    (value) => { value.executionId = "not-a-uuid"; },
    (value) => { value.candidates[0].url += "?contact=secret"; },
    (value) => { value.candidates[0].fetchedAt = "2026-02-30T00:00:00.000Z"; },
    (value) => { value.candidates[0].reasonCodes.push("machine_candidate"); },
    (value) => { value.runId = "bad-run"; },
    (value) => { value.collector.sourceSha256 = "bad-hash"; }
  ]) {
    const value = record(); mutate(value);
    await failure("invalid_record", () => prepared(seal(value)));
  }
  const duplicate = record(2); duplicate.candidates[1] = { ...duplicate.candidates[0] };
  await failure("invalid_record", () => prepared(seal(duplicate)));
  const mismatch = record(); mismatch.counts.summaryCandidateCount = 2;
  await failure("candidate_count_mismatch", () => prepared(seal(mismatch)));
  const unsealed = record(); unsealed.recordSha256 = "f".repeat(64);
  await failure("identity_mismatch", () => prepared(unsealed));
});

test("100 candidate boundary is enforced without truncation", async () => {
  assert.equal(prepared(record(100)).count, 100);
  await failure("candidate_limit", () => prepared(record(101)));
});

test("privacy must be explicit and owner only", async () => {
  assert.deepEqual(assertFolderMetadata(folder(), FOLDER), { status: "private_folder_verified" });
  for (const extra of [
    { shared: true }, { shared: undefined }, { permissions: undefined }, { permissions: [] },
    { permissions: [{ role: "reader", type: "user" }] },
    { permissions: [{ role: "owner", type: "anyone" }] },
    { permissions: [{ role: "owner" }] }
  ]) await failure("privacy_unverified", () => assertFolderMetadata(folder(extra), FOLDER));
  await failure("invalid_destination", () => assertFolderMetadata(folder({ id: "other_folder" }), FOLDER));
});

test("inventory requires complete namespace enumeration and known names", async () => {
  const plan = prepared();
  for (const inventory of [undefined, { files: [] }, { complete: false, files: [] },
    { complete: true, files: [null] }, { complete: true, files: [{ id: "file" }] }]) {
    await failure("incomplete_inventory", () => assessInventory({ inventory, folderId: FOLDER, prepared: plan }));
  }
  assert.equal(assessInventory({ inventory: { complete: true, files: [{ id: "unrelated", name: "general-record" }] },
    folderId: FOLDER, prepared: plan }).recordCount, 0);
});

test("duplicate Drive names or ids reject ambiguous identity", async () => {
  const plan = prepared();
  const file = metadata(plan);
  for (const duplicate of [{ ...file, id: "other_file" }, { ...file }]) {
    await failure("identity_collision", () => assessInventory({ inventory: { complete: true, files: [file, duplicate] },
      folderId: FOLDER, prepared: plan }));
  }
});

test("wrong MIME, multiple parents, missing size, or shared record blocks inventory", async () => {
  const plan = prepared();
  for (const [extra, code] of [
    [{ mime_type: "text/plain" }, "invalid_store"], [{ parent_ids: [FOLDER, "public-folder"] }, "invalid_store"],
    [{ parent_ids: ["public-folder"] }, "invalid_store"], [{ size: undefined }, "incomplete_inventory"],
    [{ size: "-1" }, "incomplete_inventory"], [{ shared: true }, "privacy_unverified"]
  ]) await failure(code, () => assessInventory({ inventory: { complete: true, files: [metadata(plan, extra)] },
    folderId: FOLDER, prepared: plan }));
});

test("run and byte limits include all preserved records and never silently discard", async () => {
  const plan = prepared();
  const files = Array.from({ length: 60 }, (_, i) => metadata(plan, { id: `file_${i}`,
    name: `${PREFIX}SYNTHETIC_TEST__${String(i + 2).padStart(8, "0")}-1111-4111-8111-111111111111.json` }));
  await failure("run_limit", () => assessInventory({ inventory: { complete: true, files }, folderId: FOLDER, prepared: plan }));
  const large = metadata(prepared(record(1, { executionId: SECOND })), { size: 5 * 1024 * 1024 });
  await failure("byte_limit", () => assessInventory({ inventory: { complete: true, files: [large] }, folderId: FOLDER, prepared: plan }));
  // Matching an existing execution consumes no additional record or bytes.
  assert.equal(assessInventory({ inventory: { complete: true, files: [metadata(plan, { size: 5 * 1024 * 1024 })] },
    folderId: FOLDER, prepared: plan }).status, "read_existing");
});

test("full readback verifies bytes, count, hashes, destination and privacy without returning payload", () => {
  const plan = prepared(record(2));
  const result = verifyDriveReadback({ prepared: plan, bytes: plan.bytes, metadata: metadata(plan), folderId: FOLDER, now: NOW });
  assert.equal(result.status, "verified");
  assert.equal(result.count, 2);
  assert.equal(result.envelopeSha256, plan.envelopeSha256);
  assert.equal(result.bytesSha256, hash(plan.bytes));
  assert.equal("payload" in result, false);
  assert.equal("candidates" in result, false);
  assert.equal(JSON.stringify(result).includes("crowdworks"), false);
});

test("partial UTF8, partial read, altered payload and wrong prepared record are explicit failures", async () => {
  const plan = prepared();
  await failure("incomplete_readback", () => verifyDriveReadback({ prepared: plan,
    bytes: plan.bytes.subarray(0, -1), metadata: metadata(plan), folderId: FOLDER, now: NOW }));
  await failure("incomplete_readback", () => verifyDriveReadback({ prepared: plan,
    bytes: { text: plan.bytes.toString("utf8"), truncated: true }, metadata: metadata(plan), folderId: FOLDER, now: NOW }));
  await failure("incomplete_readback", () => verifyDriveReadback({ prepared: plan,
    bytes: Buffer.from([0xff]), metadata: metadata(plan, { size: 1 }), folderId: FOLDER, now: NOW }));
  const altered = Buffer.from(plan.bytes.toString("utf8").replace('"listCount": 1', '"listCount": 2'));
  await failure("candidate_count_mismatch", () => verifyDriveReadback({ prepared: plan,
    bytes: altered, metadata: metadata(plan, { size: altered.length }), folderId: FOLDER, now: NOW }));
  const second = prepared(record(2));
  await failure("identity_mismatch", () => verifyDriveReadback({ prepared: plan,
    bytes: second.bytes, metadata: metadata(second), folderId: FOLDER, now: NOW }));
});

test("expiry is exact elapsed 30 days; references stop and records are preserved", () => {
  const plan = prepared();
  assert.equal(verifyStoredDriveRecord({ bytes: plan.bytes, metadata: metadata(plan), folderId: FOLDER,
    now: "2026-11-12T03:17:59.999Z" }).status, "verified");
  const result = verifyDriveReadback({ prepared: plan, bytes: plan.bytes, metadata: metadata(plan), folderId: FOLDER, now: EXPIRES });
  assert.equal(result.status, "expired");
  assert.equal(result.requiresReview, true);
  assert.equal("payload" in result, false);
});

test("synthetic connected save creates once, reads entire file, rechecks private folder and inventory", async () => {
  const plan = prepared();
  const f = service(plan);
  const result = await save(adapter(f.transport));
  assert.equal(result.status, "verified");
  assert.equal(f.creates().length, 1);
  assert.deepEqual(f.creates()[0][1], { file_uri: "private-staged-file", file_name: plan.fileName,
    mime_type: "application/json", parent_folder_id: FOLDER });
  assert.equal(f.calls.filter((call) => call[0] === "read").length, 1);
  assert.equal(f.calls.filter((call) => call[0] === "folder").length, 2);
  assert.equal(f.calls.filter((call) => call[0] === "list").length, 2);
  assert.deepEqual([...f.files.values()][0].bytes, plan.bytes);
});

test("identical preexisting execution is verified with no create, overwrite or delete", async () => {
  const plan = prepared();
  const f = service(plan, [{ metadata: metadata(plan), bytes: plan.bytes }]);
  const result = await save(adapter(f.transport));
  assert.equal(result.status, "idempotent");
  assert.equal(f.creates().length, 0);
  assert.equal(f.files.size, 1);
});

test("existing same execution with different identity stops without overwrite", async () => {
  const first = prepared();
  const different = prepared(record(2));
  const f = service(first, [{ metadata: metadata(different), bytes: different.bytes }]);
  await failure("identity_mismatch", () => save(adapter(f.transport)));
  assert.equal(f.creates().length, 0);
  assert.equal([...f.files.values()][0].bytes, different.bytes);
});

test("expired inventory prevents additional saving without deletion", async () => {
  const prior = prepared(record(1, { executionId: SECOND }));
  const nextTime = "2026-11-13T03:18:00.000Z";
  const next = record(1, { generatedAt: nextTime, extractedAt: nextTime });
  const f = service(prepared(next), [{ metadata: metadata(prior, { id: "prior_file" }), bytes: prior.bytes }]);
  await failure("retention_review_required", () => save(adapter(f.transport), next, { now: nextTime }));
  assert.equal(f.creates().length, 0);
  assert.equal(f.files.size, 1);
});

test("a stored expired execution returns review-required reference with no payload or new upload", async () => {
  const plan = prepared();
  const f = service(plan, [{ metadata: metadata(plan), bytes: plan.bytes }]);
  const result = await save(adapter(f.transport), record(), { now: EXPIRES });
  assert.equal(result.status, "expired");
  assert.equal(result.requiresReview, true);
  assert.equal("payload" in result, false);
  assert.equal(f.creates().length, 0);
});

test("changed existing size invalidates capacity assessment before upload", async () => {
  const prior = prepared(record(1, { executionId: SECOND }));
  const f = service(prepared(), [{ metadata: metadata(prior, { id: "prior_file" }), bytes: prior.bytes }]);
  const original = f.transport.getFileMetadata;
  f.transport.getFileMetadata = async (id) => ({ ...await original(id), size: 5 * 1024 * 1024 });
  await failure("inventory_changed", () => save(adapter(f.transport)));
  assert.equal(f.creates().length, 0);
});

test("wrong returned upload identity is rejected before reading an unrelated file", async () => {
  const f = service();
  const original = f.transport.getFileMetadata;
  f.transport.getFileMetadata = async (id) => ({ ...await original(id), id: "unrelated_file" });
  await failure("identity_mismatch", () => save(adapter(f.transport)));
  assert.equal(f.calls.filter((call) => call[0] === "read").length, 0);
  assert.equal(f.creates().length, 1);
});

test("unverified staged source cannot upload arbitrary file URI", async () => {
  const plan = prepared();
  for (const mode of ["missing", "false", "badHash", "badLength"]) {
    const f = service(plan);
    if (mode === "missing") delete f.transport.verifyUploadSource;
    else f.transport.verifyUploadSource = async (expected) => ({ verified: mode === "false" ? false
      : expected.bytesSha256 === (mode === "badHash" ? "f".repeat(64) : plan.bytesSha256)
        && expected.byteLength === (mode === "badLength" ? 1 : plan.bytes.length) });
    await failure(mode === "missing" ? "source_verification_required" : "invalid_upload_source",
      () => save(adapter(f.transport)));
    assert.equal(f.creates().length, 0);
  }
});

test("unknown upload outcome is sanitized and cannot be retried by adapter", async () => {
  const f = service();
  f.transport.uploadFile = async (args) => { f.calls.push(["upload", args]); throw new Error(SENTINEL); };
  const store = adapter(f.transport);
  await failure("upload_outcome_unknown", () => save(store));
  await failure("attempt_consumed", () => save(store));
  assert.equal(f.creates().length, 1);
});

test("connection errors before upload are sanitized without exposing arbitrary service errors", async () => {
  const f = service();
  // A transport cannot bypass sanitization by copying the internal error prefix.
  f.transport.listRecords = async () => { const error = new Error(SENTINEL);
    error.code = `private_candidate_drive_${SENTINEL}`; throw error; };
  await failure("connection_failed", () => save(adapter(f.transport)));
  assert.equal(f.creates().length, 0);
});

test("changed sharing and duplicate postcreate identity prevent a false success", async () => {
  for (const mode of ["sharing", "duplicate"]) {
    const f = service();
    let folders = 0;
    f.transport.getFolderMetadata = async () => folder({ shared: mode === "sharing" && ++folders > 1 });
    const original = f.transport.listRecords;
    let lists = 0;
    f.transport.listRecords = async (...args) => {
      const result = await original(...args);
      if (mode === "duplicate" && ++lists > 1) result.files.push({ ...result.files[0], id: "duplicate_file" });
      return result;
    };
    await failure(mode === "sharing" ? "privacy_unverified" : "identity_collision", () => save(adapter(f.transport)));
    assert.equal(f.creates().length, 1);
    assert.equal(f.files.size, 1);
  }
});

test("both CI indicators refuse activation and late environment changes before service access", async () => {
  const f = service();
  const store = adapter(f.transport);
  for (const key of ["CI", "GITHUB_ACTIONS"]) {
    process.env[key] = "true";
    try {
      await failure("ci_forbidden", () => adapter(f.transport));
      await failure("ci_forbidden", () => save(store));
      assert.deepEqual(await createConnectedPrivateCandidateAdapter({ enabled: false }).save(), { status: "disabled" });
    } finally { delete process.env[key]; }
  }
  assert.equal(f.calls.length, 0);
});

test("a CI change during source verification still blocks the create attempt", async () => {
  const f = service();
  f.transport.verifyUploadSource = async () => { process.env.GITHUB_ACTIONS = "true"; return { verified: true }; };
  try { await failure("ci_forbidden", () => save(adapter(f.transport))); }
  finally { delete process.env.GITHUB_ACTIONS; }
  assert.equal(f.creates().length, 0);
});

test("adapter has no network fallback and rejects incomplete connected transport", async (t) => {
  t.mock.method(global, "fetch", () => { throw new Error("unexpected network access"); });
  await failure("connection_required", () => adapter({}));
  const f = service();
  await save(adapter(f.transport));
  assert.equal(f.creates().length, 1);
});
