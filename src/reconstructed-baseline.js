"use strict";

// This is an explicitly accepted Git reconstruction, never an exact backup of
// the unavailable served artifact. Projection is pure; verification reads only
// explicit local inputs and performs no fetch, extraction, write or publication.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { types, isDeepStrictEqual } = require("node:util");
const { parseStrictJsonBytes } = require("./strict-json");

const LIMITS = Object.freeze({ maxManifestBytes: 256 * 1024, maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024, maxFiles: 512 });
const ROOT_FILES = ["index.html", "latest.json", "latest.md", ".nojekyll", "collector-status.json", "public-patrol.json"];
const MIRROR = "reconstruction.json";
const MISSING = ["ORIGINAL_ARTIFACT_BYTES", "ORIGINAL_DELIVERY_FILE_HASHES", "ORIGINAL_COLLECTOR_TIMESTAMPS"];
const KEYS = ["kind", "schemaVersion", "repository", "inputCommit", "sourceCodeBaseCommit", "reconstructedAt",
  "originalArtifact", "missingMaterial", "sourceInputs", "files"];

class ReconstructionError extends Error {
  constructor(code) { super(`collector_reconstruction_${code}`); this.code = this.message; }
}
function check(condition, code = "invalid_manifest") { if (!condition) throw new ReconstructionError(code); }
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function ownObject(value, required, optional = [], code = "invalid_manifest") {
  check(!types.isProxy(value) && value !== null && typeof value === "object" && !Array.isArray(value), code);
  check([Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
  check(required.every((key) => Object.hasOwn(descriptors, key)) && names.every((key) => typeof key === "string"
    && (required.includes(key) || optional.includes(key)) && Object.hasOwn(descriptors[key], "value") && descriptors[key].enumerable), code);
  return Object.fromEntries(names.map((key) => [key, descriptors[key].value]));
}

function array(value, maximum = LIMITS.maxFiles) {
  check(!types.isProxy(value) && Array.isArray(value) && [Array.prototype, null].includes(Object.getPrototypeOf(value)));
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors), length = descriptors.length.value;
  check(count(length) && length <= maximum, "limit_exceeded");
  check(names.length === length + 1 && names.every((key) => key === "length" || typeof key === "string"
    && /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < length && Object.hasOwn(descriptors[key], "value") && descriptors[key].enumerable));
  return Array.from({ length }, (_, index) => descriptors[String(index)].value);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function archiveName(value) {
  if (typeof value !== "string") return false;
  const matched = /^archive\/(\d{4}-\d{2}-\d{2})\.json$/.exec(value);
  if (!matched) return false;
  const date = new Date(`${matched[1]}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === matched[1];
}

function normalize(value, requireHash) {
  const input = ownObject(value, [...KEYS, ...(requireHash ? ["contentSha256"] : [])], requireHash ? [] : ["contentSha256"]);
  check(input.kind === "collector_git_reconstruction" && input.schemaVersion === 1
    && input.repository === "amindjapan/cw-work-agent-daily"
    && matches(/^[a-f0-9]{40}$/, input.inputCommit) && matches(/^[a-f0-9]{40}$/, input.sourceCodeBaseCommit)
    && matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, input.reconstructedAt)
    && Number.isFinite(Date.parse(input.reconstructedAt)) && new Date(input.reconstructedAt).toISOString() === input.reconstructedAt);
  const artifact = ownObject(input.originalArtifact, ["runId", "runAttempt", "artifactName", "artifactId", "availability", "exactMatch"]);
  check(matches(/^[1-9][0-9]{0,31}$/, artifact.runId) && count(artifact.runAttempt) && artifact.runAttempt > 0
    && artifact.artifactName === "github-pages" && matches(/^[1-9][0-9]{0,31}$/, artifact.artifactId)
    && artifact.availability === "UNAVAILABLE" && artifact.exactMatch === "NOT_VERIFIED");
  const missing = array(input.missingMaterial, MISSING.length);
  check(isDeepStrictEqual(missing, MISSING));
  const seen = new Set(); let total = 0;
  const files = array(input.files).map((value) => {
    const entry = ownObject(value, ["path", "bytes", "sha256"]);
    check((ROOT_FILES.includes(entry.path) || archiveName(entry.path)) && !seen.has(entry.path)
      && count(entry.bytes) && matches(/^[a-f0-9]{64}$/, entry.sha256));
    check(entry.bytes <= LIMITS.maxFileBytes && (total += entry.bytes) <= LIMITS.maxTotalBytes, "limit_exceeded");
    seen.add(entry.path); return entry;
  }).sort((a, b) => order(a.path, b.path));
  check(ROOT_FILES.every((name) => seen.has(name)));
  const sourcePaths = new Set();
  const sources = array(input.sourceInputs).map((value) => {
    const entry = ownObject(value, ["repositoryPath", "baselinePath", "gitBlobSha", "bytes", "sha256"]);
    const corresponding = files.find((file) => file.path === entry.baselinePath);
    const expectedRepositoryPath = entry.baselinePath === "latest.json" ? "collector-data/latest.json"
      : archiveName(entry.baselinePath) ? `collector-data/${entry.baselinePath.slice("archive/".length)}` : null;
    check(expectedRepositoryPath !== null && entry.repositoryPath === expectedRepositoryPath && !sourcePaths.has(entry.baselinePath)
      && matches(/^[a-f0-9]{40}$/, entry.gitBlobSha) && count(entry.bytes) && matches(/^[a-f0-9]{64}$/, entry.sha256)
      && corresponding && entry.bytes === corresponding.bytes && entry.sha256 === corresponding.sha256);
    sourcePaths.add(entry.baselinePath); return entry;
  }).sort((a, b) => order(a.baselinePath, b.baselinePath));
  check(sourcePaths.has("latest.json") && sources.length === 1 + files.filter((file) => archiveName(file.path)).length);
  const content = { kind: input.kind, schemaVersion: input.schemaVersion, repository: input.repository,
    inputCommit: input.inputCommit, sourceCodeBaseCommit: input.sourceCodeBaseCommit, reconstructedAt: input.reconstructedAt,
    originalArtifact: artifact, missingMaterial: missing, sourceInputs: sources, files };
  const contentSha256 = sha256(stable(content));
  if (Object.hasOwn(input, "contentSha256")) check(matches(/^[a-f0-9]{64}$/, input.contentSha256)
    && input.contentSha256 === contentSha256, "hash_mismatch");
  check(Buffer.byteLength(JSON.stringify({ ...content, contentSha256 }), "utf8") <= LIMITS.maxManifestBytes, "limit_exceeded");
  return { ...content, contentSha256 };
}

function pure(value, required) {
  try { return normalize(value, required); }
  catch (error) { if (error instanceof ReconstructionError) throw error; throw new ReconstructionError("invalid_manifest"); }
}
function createReconstructionManifest(value) { return pure(value, false); }
function projectReconstructionManifest(value) { return pure(value, true); }

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}
function localPath(value) {
  check(typeof value === "string" && value.length > 0 && !value.includes("\0")
    && !/^(?:[/\\]{2}|[a-z][a-z0-9+.-]*:\/\/)/i.test(value)
    && !/^[A-Za-z]:(?![\\/])/.test(value), "invalid_options");
  return path.resolve(value);
}
function noLinks(file) {
  let current = path.resolve(file);
  for (;;) {
    check(!fs.lstatSync(current).isSymbolicLink(), "unsafe_path");
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}
const sameFile = (a, b) => ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) => a[key] === b[key]);

function read(file, maximum, retain = false) {
  noLinks(file); const entry = fs.lstatSync(file);
  check(entry.isFile() && entry.nlink === 1, "invalid_file"); let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd);
    check(before.isFile() && before.nlink === 1 && sameFile(entry, before), "input_changed");
    check(count(before.size) && before.size <= maximum, "limit_exceeded");
    const digest = crypto.createHash("sha256"), blob = crypto.createHash("sha1").update(`blob ${before.size}\0`);
    const chunk = Buffer.alloc(64 * 1024), parts = []; let bytes = 0;
    for (;;) {
      const amount = fs.readSync(fd, chunk, 0, Math.min(chunk.length, maximum - bytes + 1), bytes);
      if (!amount) break; bytes += amount; check(bytes <= maximum, "limit_exceeded");
      const data = chunk.subarray(0, amount); digest.update(data); blob.update(data); if (retain) parts.push(Buffer.from(data));
    }
    noLinks(file); const after = fs.fstatSync(fd), final = fs.lstatSync(file);
    check(after.isFile() && final.isFile() && after.nlink === 1 && final.nlink === 1 && bytes === before.size
      && sameFile(before, after) && sameFile(after, final), "input_changed");
    return { sha256: digest.digest("hex"), gitBlobSha: blob.digest("hex"), bytes, identity: final,
      ...(retain ? { content: Buffer.concat(parts) } : {}) };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function inventory(directory) {
  const files = [];
  function walk(relative = "") {
    const current = path.join(directory, relative); noLinks(current); check(fs.lstatSync(current).isDirectory(), "invalid_file");
    for (const name of fs.readdirSync(current)) {
      const relativeName = relative ? `${relative}/${name}` : name, entry = fs.lstatSync(path.join(current, name));
      check(!entry.isSymbolicLink(), "unsafe_path");
      if (entry.isDirectory()) { check(relativeName === "archive", "invalid_file"); walk(relativeName); }
      else {
        check(entry.isFile() && entry.nlink === 1 && (ROOT_FILES.includes(relativeName) || relativeName === MIRROR || archiveName(relativeName)), "invalid_file");
        files.push(relativeName); check(files.length <= LIMITS.maxFiles + 2, "limit_exceeded");
      }
    }
  }
  walk(); return files.sort(order);
}
function parsedManifest(data) {
  try { return projectReconstructionManifest(parseStrictJsonBytes(data, { maxBytes: LIMITS.maxManifestBytes }).value); }
  catch (error) { if (error instanceof ReconstructionError) throw error; throw new ReconstructionError("invalid_manifest"); }
}

function verifyReconstructedBaseline(options) {
  try {
    const input = ownObject(options, ["directory", "manifestFile"], ["publishedDirectory", "mode"], "invalid_options");
    const publish = Object.hasOwn(input, "publishedDirectory");
    check(publish === Object.hasOwn(input, "mode") && (!publish || ["status-only", "daily"].includes(input.mode)), "invalid_options");
    const directory = localPath(input.directory), manifestFile = localPath(input.manifestFile);
    const published = publish ? localPath(input.publishedDirectory) : null;
    check(!inside(directory, manifestFile) && (!publish || !inside(published, directory) && !inside(directory, published)
      && !inside(published, manifestFile)), "unsafe_path");
    const raw = read(manifestFile, LIMITS.maxManifestBytes, true), manifest = parsedManifest(raw.content), checks = [[manifestFile, raw.identity]];
    const actual = inventory(directory), expected = [...manifest.files.map((file) => file.path), MIRROR].sort(order);
    check(isDeepStrictEqual(actual, expected), "inventory_mismatch");
    const mirror = read(path.join(directory, MIRROR), LIMITS.maxManifestBytes, true);
    check(isDeepStrictEqual(parsedManifest(mirror.content), manifest), "mirror_mismatch"); checks.push([path.join(directory, MIRROR), mirror.identity]);
    for (const entry of manifest.files) {
      const location = path.join(directory, ...entry.path.split("/")), file = read(location, LIMITS.maxFileBytes);
      check(file.sha256 === entry.sha256 && file.bytes === entry.bytes, "byte_mismatch");
      const source = manifest.sourceInputs.find((item) => item.baselinePath === entry.path);
      if (source) check(file.gitBlobSha === source.gitBlobSha, "git_blob_mismatch");
      checks.push([location, file.identity]);
    }
    let publishedFiles, publishedPreservation;
    if (publish) {
      publishedFiles = inventory(published);
      check([...ROOT_FILES, MIRROR].every((name) => publishedFiles.includes(name)), "inventory_mismatch");
      const records = new Map(); let total = 0;
      for (const name of publishedFiles) {
        const location = path.join(published, ...name.split("/")), file = read(location,
          name === MIRROR ? LIMITS.maxManifestBytes : LIMITS.maxFileBytes, name === MIRROR);
        total += file.bytes; check(total <= LIMITS.maxTotalBytes + LIMITS.maxManifestBytes, "limit_exceeded");
        records.set(name, file); checks.push([location, file.identity]);
      }
      check(isDeepStrictEqual(parsedManifest(records.get(MIRROR).content), manifest), "mirror_mismatch");
      const archives = manifest.files.filter((file) => archiveName(file.path)), archivePaths = archives.map((file) => file.path);
      if (input.mode === "status-only") check(isDeepStrictEqual(publishedFiles.filter(archiveName), archivePaths), "archive_set_mismatch");
      for (const entry of [...archives, ...(input.mode === "status-only" ? manifest.files.filter((file) => file.path === "latest.json") : [])]) {
        const file = records.get(entry.path); check(file !== undefined, "inventory_mismatch");
        check(file.sha256 === entry.sha256 && file.bytes === entry.bytes, "byte_mismatch");
      }
      const latest = manifest.files.find((file) => file.path === "latest.json"), finalLatest = records.get("latest.json");
      publishedPreservation = { mode: input.mode, fileCount: publishedFiles.length, preservedArchiveCount: archives.length,
        latestPreserved: finalLatest.sha256 === latest.sha256 && finalLatest.bytes === latest.bytes };
    }
    check(isDeepStrictEqual(inventory(directory), actual) && (!publish || isDeepStrictEqual(inventory(published), publishedFiles)), "input_changed");
    for (const [file, identity] of checks) { noLinks(file); const final = fs.lstatSync(file);
      check(final.isFile() && final.nlink === 1 && sameFile(identity, final), "input_changed"); }
    return { status: "reconstructed_baseline_verified", provenance: "GIT_RECONSTRUCTION", originalExactMatch: "NOT_VERIFIED",
      inputCommit: manifest.inputCommit, sourceCodeBaseCommit: manifest.sourceCodeBaseCommit, contentSha256: manifest.contentSha256,
      manifestSha256: raw.sha256, fileCount: manifest.files.length, inventoryFileCount: actual.length,
      sourceInputCount: manifest.sourceInputs.length, archiveCount: manifest.files.filter((file) => archiveName(file.path)).length,
      files: manifest.files, ...(publish ? { publishedPreservation } : {}) };
  } catch (error) { if (error instanceof ReconstructionError) throw error; throw new ReconstructionError("unavailable"); }
}

module.exports = { createReconstructionManifest, projectReconstructionManifest, verifyReconstructedBaseline,
  RECONSTRUCTION_LIMITS: LIMITS };

if (require.main === module) {
  try {
    const args = process.argv.slice(2), values = {};
    check(args.length === 4 || args.length === 8, "invalid_options");
    for (let index = 0; index < args.length; index += 2) {
      check(["--directory", "--manifest", "--published-directory", "--mode"].includes(args[index])
        && !Object.hasOwn(values, args[index]) && typeof args[index + 1] === "string" && !args[index + 1].startsWith("--"), "invalid_options");
      values[args[index]] = args[index + 1];
    }
    const result = verifyReconstructedBaseline({ directory: values["--directory"], manifestFile: values["--manifest"],
      ...(Object.hasOwn(values, "--published-directory") ? { publishedDirectory: values["--published-directory"] } : {}),
      ...(Object.hasOwn(values, "--mode") ? { mode: values["--mode"] } : {}) });
    console.log(JSON.stringify({ status: result.status, provenance: result.provenance, originalExactMatch: result.originalExactMatch,
      fileCount: result.fileCount, ...(result.publishedPreservation ? { mode: result.publishedPreservation.mode } : {}) }));
  } catch { console.error("collector_reconstruction_failed"); process.exitCode = 1; }
}
