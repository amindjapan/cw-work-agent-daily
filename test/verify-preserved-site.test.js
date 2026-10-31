"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { verifyPreservedSite, PRESERVATION_LIMITS: LIMITS } = require("../src/verify-preserved-site");

const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const PRIVATE = "SYNTHETIC_PRIVATE@example.invalid";
function fixture(t) {
  const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, "cw-preserve-test-"));
  t.after(() => {
    const relative = path.relative(temp, path.resolve(root));
    assert.ok(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
      && path.basename(root).startsWith("cw-preserve-test-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const directory = path.join(root, "backup"), extracted = path.join(directory, "extracted");
  const manifestFile = path.join(root, "manifest.json");
  fs.mkdirSync(path.join(extracted, "archive"), { recursive: true });
  // Deliberately synthetic bytes: this verifier does not unzip or validate ZIP
  // container syntax. It checks the reviewed manifest and the supplied files.
  const zip = Buffer.from("SYNTHETIC_ARTIFACT_BYTES_ONLY");
  fs.writeFileSync(path.join(directory, "artifact.zip"), zip);
  const contents = { "index.html": Buffer.from("<!doctype html><p>Synthetic previous page</p>"),
    "latest.json": Buffer.from('{"synthetic":"saved public bytes"}\n'), "latest.md": Buffer.from("# Synthetic saved material\n"),
    ".nojekyll": Buffer.alloc(0), "archive/2026-10-29.json": Buffer.from('{"synthetic":"archive bytes"}\n') };
  for (const [name, bytes] of Object.entries(contents)) fs.writeFileSync(path.join(extracted, ...name.split("/")), bytes);
  const manifest = { kind: "collector_preservation", schemaVersion: 1, artifactId: "123456789",
    artifactZipSha256: hash(zip), files: Object.entries(contents).map(([name, bytes]) => ({ path: name, sha256: hash(bytes), bytes: bytes.length })) };
  const save = () => fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  save();
  return { root, directory, extracted, manifestFile, manifest, contents, save,
    verify: () => verifyPreservedSite({ directory, manifestFile }) };
}
function fails(action, code) {
  assert.throws(action, (error) => error.message === `collector_preservation_${code}` && error.code === error.message
    && !error.message.includes(PRIVATE));
}

function publication(f) {
  const directory = path.join(f.root, "published");
  fs.mkdirSync(path.join(directory, "archive"), { recursive: true });
  for (const [name, bytes] of Object.entries(f.contents)) fs.writeFileSync(path.join(directory, ...name.split("/")), bytes);
  // This verifier inventories the fixed public names; the existing public
  // projector separately validates these metadata schemas before staging.
  for (const name of ["collector-status.json", "public-patrol.json"]) fs.writeFileSync(path.join(directory, name), '{"synthetic":"metadata"}\n');
  return directory;
}
const publishedOptions = (f, publishedDirectory, mode) => ({ directory: f.directory, manifestFile: f.manifestFile, publishedDirectory, mode });

test("synthetic reviewed ZIP and extracted byte hashes verify without claiming authenticity", (t) => {
  const f = fixture(t), before = fs.readFileSync(f.manifestFile);
  const result = f.verify();
  assert.equal(result.status, "preservation_integrity_verified");
  assert.equal(result.artifactId, f.manifest.artifactId);
  assert.equal(result.artifactZipSha256, f.manifest.artifactZipSha256);
  assert.equal(result.manifestSha256, hash(before));
  assert.equal(result.fileCount, 5);
  assert.equal(result.totalFileBytes, Object.values(f.contents).reduce((sum, bytes) => sum + bytes.length, 0));
  assert.equal(result.authenticity, "NOT_VERIFIED");
  assert.equal(result.zipExtractionCorrespondence, "NOT_VERIFIED");
  assert.deepEqual(fs.readFileSync(f.manifestFile), before);
  for (const [name, bytes] of Object.entries(f.contents)) assert.deepEqual(fs.readFileSync(path.join(f.extracted, ...name.split("/"))), bytes);
});

test("a missing real manifest or backup is an error with no fallback or generated output", (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.manifestFile);
  fails(f.verify, "unavailable");
  assert.equal(fs.existsSync(f.manifestFile), false);
  fails(() => verifyPreservedSite({ directory: path.join(f.root, "absent"), manifestFile: f.manifestFile }), "unavailable");
  assert.equal(fs.existsSync(path.join(f.root, "absent")), false);
});

test("ZIP bytes and every extracted hash and byte length must match", (t) => {
  for (const mode of ["zip", "file", "hash", "size"]) {
    const f = fixture(t);
    if (mode === "zip") fs.appendFileSync(path.join(f.directory, "artifact.zip"), "changed");
    if (mode === "file") {
      const target = path.join(f.extracted, "latest.json"), bytes = fs.readFileSync(target);
      bytes[1] ^= 1; fs.writeFileSync(target, bytes);
    }
    if (mode === "hash") f.manifest.files[0].sha256 = "0".repeat(64);
    if (mode === "size") f.manifest.files[0].bytes++;
    f.save();
    fails(f.verify, "byte_mismatch");
  }
});

test("all required root files and exact manifest membership are mandatory", (t) => {
  for (const mode of ["required", "missing", "extra_manifest", "unlisted_archive"]) {
    const f = fixture(t);
    if (mode === "required") f.manifest.files = f.manifest.files.filter((entry) => entry.path !== ".nojekyll");
    if (mode === "missing") fs.unlinkSync(path.join(f.extracted, "latest.md"));
    if (mode === "extra_manifest") f.manifest.files.push({ path: "archive/2026-10-28.json", sha256: "0".repeat(64), bytes: 0 });
    if (mode === "unlisted_archive") fs.writeFileSync(path.join(f.extracted, "archive", "2026-10-28.json"), "unlisted");
    f.save();
    fails(f.verify, "manifest_incomplete");
  }
});

test("duplicate, traversing, alternate and invalid calendar paths are rejected", (t) => {
  for (const name of ["../latest.json", "archive/../latest.json", "archive\\2026-10-29.json", "/latest.json",
    "C:/private.json", "https://example.invalid/file", "INDEX.HTML", "archive/2026-02-30.json", "archive/2026-1-01.json"]) {
    const f = fixture(t); f.manifest.files[4].path = name; f.save(); fails(f.verify, "invalid_manifest");
  }
  const f = fixture(t); f.manifest.files.push({ ...f.manifest.files[0] }); f.save(); fails(f.verify, "invalid_manifest");
});

test("unknown files, directories and backup-root entries are never ignored", (t) => {
  for (const mode of ["file", "nested", "root"]) {
    const f = fixture(t);
    if (mode === "file") fs.writeFileSync(path.join(f.extracted, "private.json"), PRIVATE);
    if (mode === "nested") fs.mkdirSync(path.join(f.extracted, "archive", "nested"));
    if (mode === "root") fs.writeFileSync(path.join(f.directory, "unexpected"), PRIVATE);
    fails(f.verify, "invalid_backup");
  }
});

test("the manifest has a strict schema, numeric artifact identity and exact field types", (t) => {
  const changes = [f => { f.manifest.privateNote = PRIVATE; }, f => { f.manifest.kind = "other"; },
    f => { f.manifest.schemaVersion = 2; }, f => { f.manifest.artifactId = 123; }, f => { f.manifest.artifactId = "01"; },
    f => { f.manifest.artifactZipSha256 = "A".repeat(64); }, f => { f.manifest.files[0].privateNote = PRIVATE; },
    f => { f.manifest.files[0].bytes = "1"; }, f => { f.manifest.files[0].bytes = -1; },
    f => { f.manifest.files[0].bytes = 1.5; }, f => { f.manifest.files[0].sha256 = ["0".repeat(64)]; }];
  for (const change of changes) { const f = fixture(t); change(f); f.save(); fails(f.verify, "invalid_manifest"); }
});

test("malformed UTF-8, BOM and duplicate decoded manifest keys fail closed", (t) => {
  const f = fixture(t), original = fs.readFileSync(f.manifestFile);
  for (const bytes of [Buffer.from([0xff]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]),
    Buffer.from('{"kind":"collector_preservation","k\\u0069nd":"other"}')]) {
    fs.writeFileSync(f.manifestFile, bytes); fails(f.verify, "invalid_manifest");
  }
});

test("manifest, count, per-file, ZIP and aggregate limits reject without truncation", (t) => {
  const oversizedManifest = fixture(t);
  fs.writeFileSync(oversizedManifest.manifestFile, " ".repeat(LIMITS.maxManifestBytes + 1));
  fails(oversizedManifest.verify, "limit_exceeded");
  for (const mode of ["count", "file", "total"]) {
    const f = fixture(t);
    if (mode === "count") f.manifest.files = Array.from({ length: LIMITS.maxFiles + 1 }, () => f.manifest.files[0]);
    if (mode === "file") f.manifest.files[0].bytes = LIMITS.maxFileBytes + 1;
    if (mode === "total") f.manifest.files = [...f.manifest.files, ...Array.from({ length: 4 }, (_, i) =>
      ({ path: `archive/2026-10-${String(i + 1).padStart(2, "0")}.json`, sha256: "0".repeat(64), bytes: 0 }))]
      .map((entry) => ({ ...entry, bytes: LIMITS.maxFileBytes }));
    f.save(); fails(f.verify, "limit_exceeded");
  }
  const f = fixture(t), open = fs.openSync, stat = fs.fstatSync, entry = fs.lstatSync;
  let zipDescriptor;
  const zipPath = path.join(f.directory, "artifact.zip");
  const oversized = (value) => {
    const copy = Object.create(value); Object.defineProperty(copy, "size", { value: LIMITS.maxZipBytes + 1 }); return copy;
  };
  t.mock.method(fs, "openSync", (file, ...args) => { const fd = open(file, ...args); if (file === path.join(f.directory, "artifact.zip")) zipDescriptor = fd; return fd; });
  t.mock.method(fs, "lstatSync", (file, ...args) => path.resolve(file) === zipPath ? oversized(entry(file, ...args)) : entry(file, ...args));
  t.mock.method(fs, "fstatSync", (fd) => {
    const value = stat(fd);
    if (fd !== zipDescriptor) return value;
    return oversized(value);
  });
  fails(f.verify, "limit_exceeded");
});

test("a changing file is not accepted as a complete preserved input", (t) => {
  const f = fixture(t), open = fs.openSync, stat = fs.fstatSync;
  let zipDescriptor, calls = 0;
  t.mock.method(fs, "openSync", (file, ...args) => { const fd = open(file, ...args); if (file === path.join(f.directory, "artifact.zip")) zipDescriptor = fd; return fd; });
  t.mock.method(fs, "fstatSync", (fd) => {
    const value = stat(fd);
    if (fd !== zipDescriptor || ++calls === 1) return value;
    const copy = Object.create(value); Object.defineProperty(copy, "mtimeMs", { value: value.mtimeMs + 1 }); return copy;
  });
  fails(f.verify, "input_changed");
});

test("late changes to an already hashed ZIP, file or root inventory cannot pass final verification", (t) => {
  for (const mode of ["zip", "file", "root"]) {
    const f = fixture(t), read = fs.readdirSync;
    let rootWalks = 0;
    const mocked = t.mock.method(fs, "readdirSync", (directory, ...args) => {
      if (directory === f.extracted && ++rootWalks === 2) {
        if (mode === "zip") fs.appendFileSync(path.join(f.directory, "artifact.zip"), "changed after hashing");
        if (mode === "file") fs.appendFileSync(path.join(f.extracted, "latest.json"), "changed after hashing");
        if (mode === "root") fs.writeFileSync(path.join(f.directory, "unexpected"), "changed after initial inventory");
      }
      return read(directory, ...args);
    });
    fails(f.verify, "input_changed"); mocked.mock.restore();
  }
});

test("synthetic lstat link flags reject backup, ancestor, manifest and extracted aliases", (t) => {
  for (const location of ["directory", "ancestor", "manifest", "extracted", "file"]) {
    const f = fixture(t), stat = fs.lstatSync;
    const target = location === "directory" ? f.directory : location === "ancestor" ? f.root
      : location === "manifest" ? f.manifestFile : location === "extracted" ? f.extracted : path.join(f.extracted, "index.html");
    const mocked = t.mock.method(fs, "lstatSync", (file, ...args) => path.resolve(file) === target
      ? { isSymbolicLink: () => true } : stat(file, ...args));
    fails(f.verify, "unsafe_path"); mocked.mock.restore();
  }
});

test("nonregular entries and hardlinked aliases are rejected", (t) => {
  for (const mode of ["nonregular", "hardlink"]) {
    const f = fixture(t), stat = fs.lstatSync, target = path.join(f.extracted, "latest.json");
    const mocked = t.mock.method(fs, "lstatSync", (file, ...args) => {
      const value = stat(file, ...args);
      if (path.resolve(file) !== target) return value;
      const copy = Object.create(value);
      if (mode === "hardlink") Object.defineProperty(copy, "nlink", { value: 2 });
      else copy.isFile = () => false;
      return copy;
    });
    fails(f.verify, "invalid_backup"); mocked.mock.restore();
  }
});

test("the manifest must stay outside the backup and options never evaluate user accessors", (t) => {
  const f = fixture(t);
  fails(() => verifyPreservedSite({ directory: f.directory, manifestFile: path.join(f.directory, "manifest.json") }), "unsafe_path");
  let accesses = 0;
  const accessor = { manifestFile: f.manifestFile };
  Object.defineProperty(accessor, "directory", { get() { accesses++; throw new Error(PRIVATE); } });
  for (const options of [undefined, {}, { directory: f.directory, manifestFile: f.manifestFile, extra: PRIVATE }, accessor,
    new Proxy({}, { getPrototypeOf() { accesses++; throw PRIVATE; }, ownKeys() { accesses++; throw PRIVATE; } })]) {
    fails(() => verifyPreservedSite(options), "invalid_options");
  }
  assert.equal(accesses, 0);
});

test("UNC, device and URL inputs are rejected before any filesystem access", (t) => {
  const f = fixture(t);
  const mocked = t.mock.method(fs, "lstatSync", () => { throw new Error("unexpected_remote_or_local_lookup"); });
  try {
    for (const location of ["\\\\server\\share\\backup", "//server/share/backup", "\\\\?\\C:\\backup", "https://example.invalid/backup", "file:///backup"]) {
      fails(() => verifyPreservedSite({ directory: location, manifestFile: f.manifestFile }), "invalid_options");
      fails(() => verifyPreservedSite({ directory: f.directory, manifestFile: location }), "invalid_options");
    }
    assert.equal(mocked.mock.calls.length, 0);
  } finally { mocked.mock.restore(); }
});

test("verification performs no network, credential lookup, extraction or filesystem writes", (t) => {
  const f = fixture(t), mocks = [];
  mocks.push(t.mock.method(global, "fetch", () => { throw new Error("unexpected_network"); }));
  for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync", "rmSync"]) {
    mocks.push(t.mock.method(fs, name, () => { throw new Error("unexpected_write"); }));
  }
  try { assert.equal(f.verify().status, "preservation_integrity_verified"); }
  finally { mocks.forEach((mock) => mock.mock.restore()); }
});

test("both final-artifact modes preserve every old archive by actual bytes and hash", (t) => {
  for (const mode of ["status-only", "daily"]) {
    const f = fixture(t), directory = publication(f);
    const result = verifyPreservedSite(publishedOptions(f, directory, mode));
    assert.deepEqual(result.publishedPreservation, { mode, fileCount: 7, preservedArchiveCount: 1, latestPreserved: true });
    assert.equal(result.authenticity, "NOT_VERIFIED");
    assert.equal(result.zipExtractionCorrespondence, "NOT_VERIFIED");
  }
});

test("missing, changed or resized old archives block both publication modes", (t) => {
  for (const mode of ["status-only", "daily"]) for (const change of ["missing", "hash", "size"]) {
    const f = fixture(t), directory = publication(f), target = path.join(directory, "archive", "2026-10-29.json");
    if (change === "missing") fs.unlinkSync(target);
    if (change === "hash") { const bytes = fs.readFileSync(target); bytes[1] ^= 1; fs.writeFileSync(target, bytes); }
    if (change === "size") fs.appendFileSync(target, "changed size");
    fails(() => verifyPreservedSite(publishedOptions(f, directory, mode)), change === "missing"
      ? mode === "status-only" ? "archive_set_mismatch" : "manifest_incomplete" : "byte_mismatch");
  }
});

test("status-only cannot replace saved latest bytes and daily can update latest without changing old archives", (t) => {
  const f = fixture(t), directory = publication(f), latest = path.join(directory, "latest.json");
  fs.writeFileSync(latest, '{"synthetic":"newly generated public summary"}\n');
  fails(() => verifyPreservedSite(publishedOptions(f, directory, "status-only")), "byte_mismatch");
  fs.writeFileSync(path.join(directory, "archive", "2026-10-30.json"), '{"synthetic":"new daily archive"}\n');
  const result = verifyPreservedSite(publishedOptions(f, directory, "daily"));
  assert.deepEqual(result.publishedPreservation, { mode: "daily", fileCount: 8, preservedArchiveCount: 1, latestPreserved: false });
  assert.deepEqual(fs.readFileSync(path.join(directory, "archive", "2026-10-29.json")), f.contents["archive/2026-10-29.json"]);
});

test("status-only keeps the exact old archive path set while daily permits a superset", (t) => {
  const f = fixture(t), directory = publication(f);
  fs.writeFileSync(path.join(directory, "archive", "2026-10-28.json"), '{"synthetic":"repository-only archive"}\n');
  fails(() => verifyPreservedSite(publishedOptions(f, directory, "status-only")), "archive_set_mismatch");
  const result = verifyPreservedSite(publishedOptions(f, directory, "daily"));
  assert.deepEqual(result.publishedPreservation, { mode: "daily", fileCount: 8, preservedArchiveCount: 1, latestPreserved: true });
});

test("final artifact inventory refuses missing roots, extra files, nested paths and synthetic links", (t) => {
  for (const change of ["missing", "extra", "nested", "link"]) {
    const f = fixture(t), directory = publication(f);
    let mocked;
    if (change === "missing") fs.unlinkSync(path.join(directory, "index.html"));
    if (change === "extra") fs.writeFileSync(path.join(directory, "private.json"), PRIVATE);
    if (change === "nested") fs.mkdirSync(path.join(directory, "archive", "nested"));
    if (change === "link") {
      const stat = fs.lstatSync, target = path.join(directory, "collector-status.json");
      mocked = t.mock.method(fs, "lstatSync", (file, ...args) => path.resolve(file) === target
        ? { isSymbolicLink: () => true } : stat(file, ...args));
    }
    try { fails(() => verifyPreservedSite(publishedOptions(f, directory, "status-only")),
      change === "missing" ? "manifest_incomplete" : change === "link" ? "unsafe_path" : "invalid_backup"); }
    finally { mocked?.mock.restore(); }
  }
});

test("final artifact options require an explicit paired mode and isolated local directory", (t) => {
  const f = fixture(t), directory = publication(f), base = { directory: f.directory, manifestFile: f.manifestFile };
  for (const options of [{ ...base, publishedDirectory: directory }, { ...base, mode: "daily" },
    publishedOptions(f, directory, "unknown"), publishedOptions(f, "//server/share", "daily")]) {
    fails(() => verifyPreservedSite(options), "invalid_options");
  }
  for (const overlap of [f.directory, f.extracted, f.root]) fails(() => verifyPreservedSite(publishedOptions(f, overlap, "status-only")), "unsafe_path");
});

test("final artifact verification changes no input, staged bytes or filesystem state", (t) => {
  const f = fixture(t), directory = publication(f);
  const names = ["index.html", "latest.json", "latest.md", ".nojekyll", "collector-status.json", "public-patrol.json", "archive/2026-10-29.json"];
  const before = names.map((name) => fs.readFileSync(path.join(directory, ...name.split("/"))));
  const manifest = fs.readFileSync(f.manifestFile), zip = fs.readFileSync(path.join(f.directory, "artifact.zip"));
  const mocks = [t.mock.method(global, "fetch", () => { throw new Error("unexpected_network"); })];
  for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync", "rmSync"])
    mocks.push(t.mock.method(fs, name, () => { throw new Error("unexpected_write"); }));
  try { assert.equal(verifyPreservedSite(publishedOptions(f, directory, "status-only")).status, "preservation_integrity_verified"); }
  finally { mocks.forEach((mock) => mock.mock.restore()); }
  assert.deepEqual(fs.readFileSync(f.manifestFile), manifest);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, "artifact.zip")), zip);
  names.forEach((name, index) => assert.deepEqual(fs.readFileSync(path.join(directory, ...name.split("/"))), before[index]));
});

test("real verifier CLI uses only synthetic local inputs and fixed success or error output", (t) => {
  const f = fixture(t), preload = path.join(f.root, "deny-network.cjs");
  fs.writeFileSync(preload, 'global.fetch = () => { throw new Error("network_forbidden"); };\n');
  const command = ["--require", preload, path.join(__dirname, "../src/verify-preserved-site.js")];
  const run = (args) => spawnSync(process.execPath, [...command, ...args], { encoding: "utf8" });
  const result = run(["--directory", f.directory, "--manifest", f.manifestFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: "preservation_integrity_verified", fileCount: 5 });
  assert.equal(result.stderr, "");
  const directory = publication(f);
  const published = run(["--directory", f.directory, "--manifest", f.manifestFile, "--published-directory", directory, "--mode", "status-only"]);
  assert.equal(published.status, 0, published.stderr);
  assert.deepEqual(JSON.parse(published.stdout), { status: "preservation_integrity_verified", fileCount: 5,
    mode: "status-only", publishedFileCount: 7 });
  assert.equal(published.stderr, "");
  for (const args of [[], ["--directory", f.directory, "--directory", f.directory],
    ["--directory", f.directory, "--manifest", path.join(f.root, PRIVATE)],
    ["--directory", f.directory, "--manifest", f.manifestFile, "--other", PRIVATE]]) {
    const failed = run(args);
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, "");
    assert.equal(failed.stderr.trim(), "collector_preservation_failed");
    assert.doesNotMatch(failed.stderr, /SYNTHETIC_PRIVATE|example|Error:|[A-Z]:\\/);
  }
});
