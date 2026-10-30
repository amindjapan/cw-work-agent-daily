"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createReconstructionManifest, projectReconstructionManifest, verifyReconstructedBaseline,
  RECONSTRUCTION_LIMITS: LIMITS } = require("../src/reconstructed-baseline");

const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const blob = (bytes) => crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
const PRIVATE = "SYNTHETIC_PRIVATE@example.invalid";
function content() {
  return { "index.html": Buffer.from("<!doctype html><p>GIT_RECONSTRUCTION</p>"),
    "latest.json": Buffer.from('{"synthetic":"legacy saved bytes"}\n'), "latest.md": Buffer.from("# Git reconstruction\n"),
    ".nojekyll": Buffer.alloc(0), "collector-status.json": Buffer.from('{"synthetic":"unavailable"}\n'),
    "public-patrol.json": Buffer.from('{"synthetic":"not connected"}\n'),
    "archive/2026-10-29.json": Buffer.from('{"synthetic":"archive bytes"}\n') };
}
function payload(contents = content()) {
  const files = Object.entries(contents).map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }));
  const sourceInputs = Object.entries(contents).filter(([name]) => name === "latest.json" || name.startsWith("archive/"))
    .map(([name, bytes]) => ({ repositoryPath: name === "latest.json" ? "collector-data/latest.json" : `collector-data/${name.slice(8)}`,
      baselinePath: name, gitBlobSha: blob(bytes), bytes: bytes.length, sha256: hash(bytes) }));
  return { kind: "collector_git_reconstruction", schemaVersion: 1, repository: "amindjapan/cw-work-agent-daily",
    inputCommit: "a".repeat(40), sourceCodeBaseCommit: "b".repeat(40), reconstructedAt: "2026-10-30T03:00:00.000Z",
    originalArtifact: { runId: "11111111", runAttempt: 1, artifactName: "github-pages", artifactId: "22222222",
      availability: "UNAVAILABLE", exactMatch: "NOT_VERIFIED" },
    missingMaterial: ["ORIGINAL_ARTIFACT_BYTES", "ORIGINAL_DELIVERY_FILE_HASHES", "ORIGINAL_COLLECTOR_TIMESTAMPS"], sourceInputs, files };
}
function fixture(t) {
  const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, "cw-reconbaseline-test-"));
  t.after(() => {
    const relative = path.relative(temp, path.resolve(root));
    assert.ok(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
      && path.basename(root).startsWith("cw-reconbaseline-test-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const directory = path.join(root, "baseline"), manifestFile = path.join(root, "manifest.json"), contents = content();
  fs.mkdirSync(path.join(directory, "archive"), { recursive: true });
  for (const [name, bytes] of Object.entries(contents)) fs.writeFileSync(path.join(directory, ...name.split("/")), bytes);
  const manifest = createReconstructionManifest(payload(contents));
  function save(value = manifest) { const bytes = `${JSON.stringify(value, null, 2)}\n`;
    fs.writeFileSync(manifestFile, bytes); fs.writeFileSync(path.join(directory, "reconstruction.json"), bytes); }
  save();
  return { root, directory, manifestFile, contents, manifest, save,
    verify: () => verifyReconstructedBaseline({ directory, manifestFile }) };
}
function published(f) {
  const directory = path.join(f.root, "published"); fs.mkdirSync(path.join(directory, "archive"), { recursive: true });
  for (const [name, bytes] of Object.entries(f.contents)) fs.writeFileSync(path.join(directory, ...name.split("/")), bytes);
  fs.writeFileSync(path.join(directory, "reconstruction.json"), JSON.stringify(f.manifest)); return directory;
}
const publishOptions = (f, publishedDirectory, mode) => ({ directory: f.directory, manifestFile: f.manifestFile, publishedDirectory, mode });
function fails(action, code = "invalid_manifest") {
  assert.throws(action, (error) => error.message === `collector_reconstruction_${code}` && error.code === error.message
    && !error.message.includes(PRIVATE));
}

test("pure creation seals an explicit Git reconstruction and never claims the unavailable original", () => {
  const value = createReconstructionManifest(payload());
  assert.match(value.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(value.originalArtifact.availability, "UNAVAILABLE");
  assert.equal(value.originalArtifact.exactMatch, "NOT_VERIFIED");
  assert.deepEqual(projectReconstructionManifest(value), value);
  assert.equal(value.files.some((file) => file.path === "reconstruction.json"), false);
  fails(() => projectReconstructionManifest(payload()));
  const changed = clone(value); changed.inputCommit = "c".repeat(40); fails(() => projectReconstructionManifest(changed), "hash_mismatch");
  fails(() => createReconstructionManifest(changed), "hash_mismatch");
});

test("canonical creation normalizes source and file order without changing the content identity", () => {
  const input = payload(), a = createReconstructionManifest(input);
  input.sourceInputs.reverse(); input.files.reverse();
  assert.deepEqual(createReconstructionManifest(input), a);
  const serialized = clone(a); serialized.files.reverse(); serialized.sourceInputs.reverse();
  assert.deepEqual(projectReconstructionManifest(serialized), a);
});

test("repository, commits, explicit real UTC clock and original-material limits are strict", () => {
  const mutations = [v => { v.repository = "other/repo"; }, v => { v.kind = "old_backup"; }, v => { v.schemaVersion = 2; },
    v => { v.inputCommit = "A".repeat(40); }, v => { v.sourceCodeBaseCommit = "missing"; },
    v => { v.reconstructedAt = "2026-02-30T03:00:00.000Z"; }, v => { v.reconstructedAt = "2026-10-30T12:00:00+09:00"; },
    v => { v.originalArtifact.runId = 11111111; }, v => { v.originalArtifact.runAttempt = 0; },
    v => { v.originalArtifact.availability = "AVAILABLE"; }, v => { v.originalArtifact.exactMatch = "VERIFIED"; },
    v => { v.missingMaterial.pop(); }, v => { v.missingMaterial.reverse(); }, v => { v.privateNote = PRIVATE; }];
  for (const mutate of mutations) { const input = payload(); mutate(input); fails(() => createReconstructionManifest(input)); }
});

test("source identities and hashes cover exactly latest plus every archive", () => {
  const mutations = [v => { v.sourceInputs.pop(); }, v => { v.sourceInputs.push({ ...v.sourceInputs[0] }); },
    v => { v.sourceInputs[0].repositoryPath = "collector-data/2026-10-29.json"; },
    v => { v.sourceInputs[0].baselinePath = "index.html"; }, v => { v.sourceInputs[0].sha256 = "0".repeat(64); },
    v => { v.sourceInputs[0].bytes++; }, v => { v.sourceInputs[0].gitBlobSha = ["a".repeat(40)]; },
    v => { v.sourceInputs[0].privateNote = PRIVATE; }];
  for (const mutate of mutations) { const input = payload(); mutate(input); fails(() => createReconstructionManifest(input)); }
});

test("manifest paths reject mirrors, private files, duplicates, traversal and invalid dates", () => {
  for (const name of ["reconstruction.json", "private.json", "../latest.json", "archive/../latest.json",
    "archive\\2026-10-29.json", "/latest.json", "archive/2026-02-30.json", "archive/2026-1-01.json"]) {
    const input = payload(); input.files[0].path = name; fails(() => createReconstructionManifest(input));
  }
  const duplicate = payload(); duplicate.files.push({ ...duplicate.files[0] }); fails(() => createReconstructionManifest(duplicate));
  const missing = payload(); missing.files = missing.files.filter((file) => file.path !== "collector-status.json");
  fails(() => createReconstructionManifest(missing));
});

test("pure manifest APIs reject accessors, Proxy arrays, holes and inherited claims without evaluating them", () => {
  let reads = 0; const input = payload();
  Object.defineProperty(input, "inputCommit", { enumerable: true, get() { reads++; throw PRIVATE; } });
  fails(() => createReconstructionManifest(input));
  const proxy = (value) => new Proxy(value, { getPrototypeOf() { reads++; throw PRIVATE; }, ownKeys() { reads++; throw PRIVATE; }, get() { reads++; throw PRIVATE; } });
  for (const value of [proxy(payload()), { ...payload(), sourceInputs: proxy([]) }, { ...payload(), originalArtifact: proxy({}) },
    { ...payload(), files: new Array(7) }, Object.create(payload())]) fails(() => createReconstructionManifest(value));
  assert.equal(reads, 0);
});

test("pure creation and projection perform no I/O, credential access or implicit clock read", (t) => {
  const input = payload(), mocks = [];
  for (const name of ["lstatSync", "readFileSync", "openSync", "readSync", "readdirSync", "writeFileSync", "mkdirSync"])
    mocks.push(t.mock.method(fs, name, () => { throw new Error("unexpected_io"); }));
  mocks.push(t.mock.method(global, "fetch", () => { throw new Error("unexpected_network"); }));
  mocks.push(t.mock.method(Date, "now", () => { throw new Error("unexpected_clock"); }));
  try { const value = createReconstructionManifest(input); assert.deepEqual(projectReconstructionManifest(value), value); }
  finally { mocks.forEach((mock) => mock.mock.restore()); }
});

test("a complete synthetic Git reconstruction verifies all bytes, mirrors and actual Git blob identities", (t) => {
  const f = fixture(t), result = f.verify();
  assert.equal(result.status, "reconstructed_baseline_verified"); assert.equal(result.provenance, "GIT_RECONSTRUCTION");
  assert.equal(result.originalExactMatch, "NOT_VERIFIED"); assert.equal(result.contentSha256, f.manifest.contentSha256);
  assert.equal(result.fileCount, 7); assert.equal(result.inventoryFileCount, 8); assert.equal(result.sourceInputCount, 2);
  assert.equal(result.manifestSha256, hash(fs.readFileSync(f.manifestFile)));
});

test("missing material never produces a fabricated baseline or manifest", (t) => {
  const f = fixture(t); fs.unlinkSync(f.manifestFile); fails(f.verify, "unavailable");
  assert.equal(fs.existsSync(f.manifestFile), false);
  fails(() => verifyReconstructedBaseline({ directory: path.join(f.root, "absent"), manifestFile: f.manifestFile }), "unavailable");
  assert.equal(fs.existsSync(path.join(f.root, "absent")), false);
});

test("actual source byte hashes, sizes and Git blob SHA1 must all agree", (t) => {
  for (const mode of ["file", "size", "blob"]) {
    const f = fixture(t);
    if (mode === "file") { const target = path.join(f.directory, "latest.json"), bytes = fs.readFileSync(target); bytes[1] ^= 1; fs.writeFileSync(target, bytes); }
    if (mode === "size") { fs.appendFileSync(path.join(f.directory, "archive", "2026-10-29.json"), "changed"); }
    if (mode === "blob") { const input = clone(f.manifest); delete input.contentSha256; input.sourceInputs[0].gitBlobSha = "0".repeat(40); f.save(createReconstructionManifest(input)); }
    fails(f.verify, mode === "blob" ? "git_blob_mismatch" : "byte_mismatch");
  }
});

test("the mandatory baseline mirror must be final, valid and identical to the outside manifest", (t) => {
  for (const mode of ["missing", "changed", "unsealed"]) {
    const f = fixture(t), mirror = path.join(f.directory, "reconstruction.json");
    if (mode === "missing") fs.unlinkSync(mirror);
    if (mode === "changed") { const input = payload(); input.sourceCodeBaseCommit = "c".repeat(40); fs.writeFileSync(mirror, JSON.stringify(createReconstructionManifest(input))); }
    if (mode === "unsealed") fs.writeFileSync(mirror, JSON.stringify(payload()));
    fails(f.verify, mode === "missing" ? "inventory_mismatch" : mode === "changed" ? "mirror_mismatch" : "invalid_manifest");
  }
});

test("strict manifest bytes reject malformed UTF8, BOM and decoded duplicate keys", (t) => {
  const f = fixture(t), original = fs.readFileSync(f.manifestFile);
  for (const bytes of [Buffer.from([0xff]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]),
    Buffer.from('{"kind":"collector_git_reconstruction","k\\u0069nd":"other"}')]) {
    fs.writeFileSync(f.manifestFile, bytes); fails(f.verify);
  }
});

test("baseline and final inventories reject unknown, missing, nested and synthetic linked files", (t) => {
  for (const mode of ["extra", "missing", "nested", "link"]) {
    const f = fixture(t); let mocked;
    if (mode === "extra") fs.writeFileSync(path.join(f.directory, "artifact.zip"), "unavailable original is not this mode");
    if (mode === "missing") fs.unlinkSync(path.join(f.directory, "latest.md"));
    if (mode === "nested") fs.mkdirSync(path.join(f.directory, "archive", "nested"));
    if (mode === "link") { const stat = fs.lstatSync, target = path.join(f.directory, "latest.json");
      mocked = t.mock.method(fs, "lstatSync", (file, ...args) => path.resolve(file) === target ? { isSymbolicLink: () => true } : stat(file, ...args)); }
    try { fails(f.verify, mode === "missing" ? "inventory_mismatch" : mode === "link" ? "unsafe_path" : "invalid_file"); }
    finally { mocked?.mock.restore(); }
  }
});

test("status-only preserves exact archive dates and latest while daily permits additions and new latest", (t) => {
  const f = fixture(t), directory = published(f);
  assert.equal(verifyReconstructedBaseline(publishOptions(f, directory, "status-only")).publishedPreservation.latestPreserved, true);
  fs.writeFileSync(path.join(directory, "archive", "2026-10-30.json"), '{"synthetic":"new archive"}');
  fails(() => verifyReconstructedBaseline(publishOptions(f, directory, "status-only")), "archive_set_mismatch");
  fs.writeFileSync(path.join(directory, "latest.json"), '{"synthetic":"new latest"}');
  const result = verifyReconstructedBaseline(publishOptions(f, directory, "daily"));
  assert.equal(result.publishedPreservation.latestPreserved, false); assert.equal(result.publishedPreservation.preservedArchiveCount, 1);
});

test("both publication modes refuse changed or missing old archives and mismatched mirrors", (t) => {
  for (const mode of ["status-only", "daily"]) for (const change of ["missing", "changed", "mirror"]) {
    const f = fixture(t), directory = published(f), archive = path.join(directory, "archive", "2026-10-29.json");
    if (change === "missing") fs.unlinkSync(archive);
    if (change === "changed") fs.appendFileSync(archive, "changed");
    if (change === "mirror") { const input = payload(); input.inputCommit = "c".repeat(40); fs.writeFileSync(path.join(directory, "reconstruction.json"), JSON.stringify(createReconstructionManifest(input))); }
    fails(() => verifyReconstructedBaseline(publishOptions(f, directory, mode)), change === "mirror" ? "mirror_mismatch"
      : change === "changed" ? "byte_mismatch" : mode === "status-only" ? "archive_set_mismatch" : "inventory_mismatch");
  }
  const f = fixture(t), directory = published(f); fs.appendFileSync(path.join(directory, "latest.json"), "changed");
  fails(() => verifyReconstructedBaseline(publishOptions(f, directory, "status-only")), "byte_mismatch");
});

test("explicit paths are local, separated, paired with a known mode and reject user traps", (t) => {
  const f = fixture(t), base = { directory: f.directory, manifestFile: f.manifestFile }; let reads = 0;
  for (const value of [{ ...base, mode: "daily" }, { ...base, publishedDirectory: f.root }, publishOptions(f, f.root, "unknown"),
    { ...base, directory: "//server/share" }, { ...base, manifestFile: "https://example.invalid/manifest" },
    new Proxy({}, { getPrototypeOf() { reads++; throw PRIVATE; } })]) fails(() => verifyReconstructedBaseline(value), "invalid_options");
  for (const value of [{ ...base, manifestFile: path.join(f.directory, "manifest.json") }, publishOptions(f, f.root, "daily")])
    fails(() => verifyReconstructedBaseline(value), "unsafe_path");
  assert.equal(reads, 0);
});

test("drive-relative inputs are refused before any filesystem lookup", (t) => {
  const f = fixture(t), base = { directory: f.directory, manifestFile: f.manifestFile };
  const mocked = t.mock.method(fs, "lstatSync", () => { throw new Error("unexpected_filesystem_lookup"); });
  try {
    for (const value of [{ ...base, directory: "C:relative" }, { ...base, directory: "D:" },
      { ...base, manifestFile: "C:manifest.json" }, { ...base, publishedDirectory: "C:published", mode: "daily" }]) {
      fails(() => verifyReconstructedBaseline(value), "invalid_options");
    }
    assert.equal(mocked.mock.calls.length, 0);
  } finally { mocked.mock.restore(); }
});

test("input bounds and changing files fail closed rather than truncating or completing provisional data", (t) => {
  const oversized = payload(); oversized.files = Array.from({ length: LIMITS.maxFiles + 1 }, () => oversized.files[0]);
  fails(() => createReconstructionManifest(oversized), "limit_exceeded");
  const large = payload(); large.files[0].bytes = LIMITS.maxFileBytes + 1; fails(() => createReconstructionManifest(large), "limit_exceeded");
  const f = fixture(t); fs.writeFileSync(f.manifestFile, " ".repeat(LIMITS.maxManifestBytes + 1)); fails(f.verify, "limit_exceeded");
  f.save(); const readDir = fs.readdirSync; let walks = 0;
  t.mock.method(fs, "readdirSync", (directory, ...args) => {
    if (directory === f.directory && ++walks === 2) fs.appendFileSync(path.join(f.directory, "latest.md"), "changed after hash");
    return readDir(directory, ...args);
  });
  fails(f.verify, "input_changed");
});

test("local verification has no network or write effects on reconstructed or published inputs", (t) => {
  const f = fixture(t), directory = published(f), before = fs.readFileSync(f.manifestFile), mocks = [];
  mocks.push(t.mock.method(global, "fetch", () => { throw new Error("network_forbidden"); }));
  for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync", "rmSync"])
    mocks.push(t.mock.method(fs, name, () => { throw new Error("write_forbidden"); }));
  try { assert.equal(verifyReconstructedBaseline(publishOptions(f, directory, "status-only")).provenance, "GIT_RECONSTRUCTION"); }
  finally { mocks.forEach((mock) => mock.mock.restore()); }
  assert.deepEqual(fs.readFileSync(f.manifestFile), before);
});

test("fresh CLI succeeds for synthetic reconstruction and emits only fixed output on refusal", (t) => {
  const f = fixture(t), directory = published(f), preload = path.join(f.root, "deny-network.cjs");
  fs.writeFileSync(preload, 'global.fetch = () => { throw new Error("network_forbidden"); };\n');
  const command = ["--require", preload, path.join(__dirname, "../src/reconstructed-baseline.js")];
  const run = (args) => spawnSync(process.execPath, [...command, ...args], { encoding: "utf8" });
  const basic = ["--directory", f.directory, "--manifest", f.manifestFile];
  for (const args of [basic, [...basic, "--published-directory", directory, "--mode", "status-only"]]) {
    const result = run(args); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout); assert.equal(output.provenance, "GIT_RECONSTRUCTION"); assert.equal(output.originalExactMatch, "NOT_VERIFIED");
  }
  for (const args of [[], ["--directory", f.directory, "--manifest", path.join(f.root, PRIVATE)], [...basic, "--mode", "daily"]]) {
    const result = run(args); assert.equal(result.status, 1); assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "collector_reconstruction_failed"); assert.doesNotMatch(result.stderr, /SYNTHETIC_PRIVATE|example|Error:|[A-Z]:\\/);
  }
});
