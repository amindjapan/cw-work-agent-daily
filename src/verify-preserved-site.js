"use strict";

// Explicit local backup integrity only. Nothing is downloaded, extracted,
// authenticated, collected, changed or published by this module. A reviewed
// manifest is not an authenticity signature or proof of ZIP extraction ancestry.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { types } = require("node:util");
const { parseStrictJsonBytes } = require("./strict-json");

const LIMITS = Object.freeze({ maxManifestBytes: 256 * 1024, maxZipBytes: 64 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024, maxTotalFileBytes: 64 * 1024 * 1024, maxFiles: 512 });
const ROOT_FILES = ["index.html", "latest.json", "latest.md", ".nojekyll"];
const PUBLIC_METADATA_FILES = ["collector-status.json", "public-patrol.json"];
const HASH = /^[a-f0-9]{64}$/;

class PreservationError extends Error {
  constructor(code) { super(`collector_preservation_${code}`); this.code = this.message; }
}
function requireThat(condition, code) { if (!condition) throw new PreservationError(code); }
const count = (value) => Number.isSafeInteger(value) && value >= 0;

function ownObject(value, keys, code, optional = []) {
  requireThat(!types.isProxy(value) && value !== null && typeof value === "object" && !Array.isArray(value), code);
  requireThat([Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
  requireThat(keys.every((key) => Object.hasOwn(descriptors, key))
    && names.every((key) => typeof key === "string" && (keys.includes(key) || optional.includes(key))
      && Object.hasOwn(descriptors[key], "value")), code);
  return Object.fromEntries(names.map((key) => [key, descriptors[key].value]));
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function noLinks(target) {
  let current = path.resolve(target);
  for (;;) {
    const stat = fs.lstatSync(current);
    requireThat(!stat.isSymbolicLink(), "unsafe_path");
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function sameFile(a, b) {
  return ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) => a[key] === b[key]);
}

function readFileIntegrity(file, limit, retainBytes = false) {
  noLinks(file);
  const entry = fs.lstatSync(file);
  requireThat(entry.isFile() && entry.nlink === 1, "invalid_backup");
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    requireThat(before.isFile() && before.nlink === 1 && sameFile(entry, before), "input_changed");
    requireThat(count(before.size) && before.size <= limit, "limit_exceeded");
    const digest = crypto.createHash("sha256"), chunk = Buffer.alloc(64 * 1024), parts = [];
    let bytes = 0;
    for (;;) {
      const read = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, limit - bytes + 1), bytes);
      if (!read) break;
      bytes += read;
      requireThat(bytes <= limit, "limit_exceeded");
      digest.update(chunk.subarray(0, read));
      if (retainBytes) parts.push(Buffer.from(chunk.subarray(0, read)));
    }
    const after = fs.fstatSync(descriptor);
    noLinks(file);
    const finalEntry = fs.lstatSync(file);
    requireThat(after.isFile() && finalEntry.isFile() && after.nlink === 1 && finalEntry.nlink === 1
      && bytes === before.size && sameFile(before, after) && sameFile(after, finalEntry), "input_changed");
    return { bytes, sha256: digest.digest("hex"), identity: finalEntry,
      ...(retainBytes ? { content: Buffer.concat(parts) } : {}) };
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function allowedFile(value) {
  if (ROOT_FILES.includes(value)) return true;
  if (typeof value !== "string") return false;
  const match = /^archive\/(\d{4}-\d{2}-\d{2})\.json$/.exec(value);
  if (!match) return false;
  const date = new Date(`${match[1]}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1];
}

function manifestValue(bytes) {
  let value;
  try { value = parseStrictJsonBytes(bytes, { maxBytes: LIMITS.maxManifestBytes }).value; }
  catch { throw new PreservationError("invalid_manifest"); }
  const manifest = ownObject(value, ["kind", "schemaVersion", "artifactId", "artifactZipSha256", "files"], "invalid_manifest");
  requireThat(manifest.kind === "collector_preservation" && manifest.schemaVersion === 1
    && typeof manifest.artifactId === "string" && /^[1-9][0-9]{0,31}$/.test(manifest.artifactId)
    && typeof manifest.artifactZipSha256 === "string" && HASH.test(manifest.artifactZipSha256)
    && Array.isArray(manifest.files), "invalid_manifest");
  requireThat(manifest.files.length >= ROOT_FILES.length && manifest.files.length <= LIMITS.maxFiles, "limit_exceeded");
  const seen = new Set();
  let totalBytes = 0;
  const files = manifest.files.map((value) => {
    const file = ownObject(value, ["path", "sha256", "bytes"], "invalid_manifest");
    requireThat(allowedFile(file.path) && !seen.has(file.path)
      && typeof file.sha256 === "string" && HASH.test(file.sha256) && count(file.bytes), "invalid_manifest");
    requireThat(file.bytes <= LIMITS.maxFileBytes, "limit_exceeded");
    totalBytes += file.bytes;
    requireThat(totalBytes <= LIMITS.maxTotalFileBytes, "limit_exceeded");
    seen.add(file.path);
    return file;
  }).sort((a, b) => a.path.localeCompare(b.path));
  requireThat(ROOT_FILES.every((name) => seen.has(name)), "manifest_incomplete");
  return { artifactId: manifest.artifactId, artifactZipSha256: manifest.artifactZipSha256, files, totalBytes };
}

function extractedFiles(directory, published = false) {
  const files = [];
  function walk(relative) {
    const current = relative ? path.join(directory, relative) : directory;
    noLinks(current);
    requireThat(fs.lstatSync(current).isDirectory(), "invalid_backup");
    for (const name of fs.readdirSync(current)) {
      const child = relative ? `${relative}/${name}` : name;
      const file = path.join(current, name), stat = fs.lstatSync(file);
      requireThat(!stat.isSymbolicLink(), "unsafe_path");
      if (stat.isDirectory()) {
        requireThat(child === "archive", "invalid_backup");
        walk(child);
      } else {
        requireThat(stat.isFile() && stat.nlink === 1
          && (allowedFile(child) || published && PUBLIC_METADATA_FILES.includes(child)), "invalid_backup");
        files.push(child);
        requireThat(files.length <= LIMITS.maxFiles + (published ? PUBLIC_METADATA_FILES.length + 1 : 0), "limit_exceeded");
      }
    }
  }
  walk("");
  return files.sort((a, b) => a.localeCompare(b));
}

function verifyPreservedSite(options) {
  try {
    const input = ownObject(options, ["directory", "manifestFile"], "invalid_options", ["publishedDirectory", "mode"]);
    const comparePublished = Object.hasOwn(input, "publishedDirectory");
    requireThat(comparePublished === Object.hasOwn(input, "mode")
      && (!comparePublished || ["status-only", "daily"].includes(input.mode)), "invalid_options");
    requireThat([input.directory, input.manifestFile, ...(comparePublished ? [input.publishedDirectory] : [])]
      .every((value) => typeof value === "string" && value.length > 0
      && !value.includes("\0") && !/^(?:[/\\]{2}|[a-z][a-z0-9+.-]*:\/\/)/i.test(value)), "invalid_options");
    const directory = path.resolve(input.directory), manifestFile = path.resolve(input.manifestFile);
    const publishedDirectory = comparePublished ? path.resolve(input.publishedDirectory) : null;
    requireThat(!inside(directory, manifestFile), "unsafe_path");
    requireThat(!comparePublished || !inside(directory, publishedDirectory) && !inside(publishedDirectory, directory)
      && !inside(publishedDirectory, manifestFile), "unsafe_path");
    noLinks(directory);
    requireThat(fs.lstatSync(directory).isDirectory(), "invalid_backup");
    const roots = fs.readdirSync(directory).sort();
    requireThat(roots.length === 2 && roots[0] === "artifact.zip" && roots[1] === "extracted", "invalid_backup");
    const rawManifest = readFileIntegrity(manifestFile, LIMITS.maxManifestBytes, true);
    const manifest = manifestValue(rawManifest.content);
    const zip = readFileIntegrity(path.join(directory, "artifact.zip"), LIMITS.maxZipBytes);
    requireThat(zip.sha256 === manifest.artifactZipSha256, "byte_mismatch");
    const extracted = path.join(directory, "extracted"), actual = extractedFiles(extracted);
    requireThat(actual.length === manifest.files.length && actual.every((name, index) => name === manifest.files[index].path), "manifest_incomplete");
    const identities = [[path.join(directory, "artifact.zip"), zip.identity]];
    for (const entry of manifest.files) {
      const location = path.join(extracted, ...entry.path.split("/"));
      const file = readFileIntegrity(location, LIMITS.maxFileBytes);
      requireThat(file.sha256 === entry.sha256 && file.bytes === entry.bytes, "byte_mismatch");
      identities.push([location, file.identity]);
    }
    let publishedFiles, publishedPreservation;
    if (comparePublished) {
      publishedFiles = extractedFiles(publishedDirectory, true);
      requireThat(ROOT_FILES.every((name) => publishedFiles.includes(name)), "manifest_incomplete");
      const records = new Map();
      let total = 0;
      for (const relative of publishedFiles) {
        const location = path.join(publishedDirectory, ...relative.split("/"));
        const file = readFileIntegrity(location, LIMITS.maxFileBytes);
        total += file.bytes;
        requireThat(total <= LIMITS.maxTotalFileBytes, "limit_exceeded");
        records.set(relative, file);
        identities.push([location, file.identity]);
      }
      const oldArchives = manifest.files.filter((entry) => entry.path.startsWith("archive/"));
      if (input.mode === "status-only") {
        const currentArchives = publishedFiles.filter((name) => name.startsWith("archive/"));
        requireThat(currentArchives.length === oldArchives.length
          && currentArchives.every((name, index) => name === oldArchives[index].path), "archive_set_mismatch");
      }
      for (const entry of [...oldArchives, ...(input.mode === "status-only" ? manifest.files.filter((entry) => entry.path === "latest.json") : [])]) {
        const current = records.get(entry.path);
        requireThat(current !== undefined, "manifest_incomplete");
        requireThat(current.sha256 === entry.sha256 && current.bytes === entry.bytes, "byte_mismatch");
      }
      const latest = manifest.files.find((entry) => entry.path === "latest.json"), currentLatest = records.get("latest.json");
      publishedPreservation = { mode: input.mode, fileCount: publishedFiles.length, preservedArchiveCount: oldArchives.length,
        latestPreserved: currentLatest.sha256 === latest.sha256 && currentLatest.bytes === latest.bytes };
    }
    // Recheck membership and the manifest after hashing so a partial or changing
    // input does not become a verification result. No lock or write is attempted.
    const finalFiles = extractedFiles(extracted);
    const finalManifest = readFileIntegrity(manifestFile, LIMITS.maxManifestBytes);
    requireThat(finalFiles.length === actual.length && finalFiles.every((name, index) => name === actual[index])
      && finalManifest.sha256 === rawManifest.sha256 && sameFile(rawManifest.identity, finalManifest.identity), "input_changed");
    const finalRoots = fs.readdirSync(directory).sort();
    requireThat(finalRoots.length === roots.length && finalRoots.every((name, index) => name === roots[index]), "input_changed");
    if (comparePublished) {
      const finalPublished = extractedFiles(publishedDirectory, true);
      requireThat(finalPublished.length === publishedFiles.length
        && finalPublished.every((name, index) => name === publishedFiles[index]), "input_changed");
    }
    for (const [location, identity] of identities) {
      noLinks(location);
      const finalEntry = fs.lstatSync(location);
      requireThat(finalEntry.isFile() && finalEntry.nlink === 1 && sameFile(identity, finalEntry), "input_changed");
    }
    return { status: "preservation_integrity_verified", artifactId: manifest.artifactId,
      artifactZipSha256: zip.sha256, manifestSha256: rawManifest.sha256, fileCount: actual.length,
      totalFileBytes: manifest.totalBytes, files: manifest.files,
      ...(comparePublished ? { publishedPreservation } : {}),
      authenticity: "NOT_VERIFIED", zipExtractionCorrespondence: "NOT_VERIFIED" };
  } catch (error) {
    if (error instanceof PreservationError) throw error;
    throw new PreservationError("unavailable");
  }
}

module.exports = { verifyPreservedSite, PRESERVATION_LIMITS: LIMITS };

if (require.main === module) {
  try {
    const args = process.argv.slice(2), values = {};
    requireThat(args.length === 4 || args.length === 8, "invalid_options");
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index];
      requireThat(["--directory", "--manifest", "--published-directory", "--mode"].includes(flag) && !Object.hasOwn(values, flag)
        && typeof args[index + 1] === "string" && !args[index + 1].startsWith("--"), "invalid_options");
      values[flag] = args[index + 1];
    }
    const result = verifyPreservedSite({ directory: values["--directory"], manifestFile: values["--manifest"],
      ...(Object.hasOwn(values, "--published-directory") ? { publishedDirectory: values["--published-directory"] } : {}),
      ...(Object.hasOwn(values, "--mode") ? { mode: values["--mode"] } : {}) });
    console.log(JSON.stringify({ status: result.status, fileCount: result.fileCount,
      ...(result.publishedPreservation ? { mode: result.publishedPreservation.mode,
        publishedFileCount: result.publishedPreservation.fileCount } : {}) }));
  } catch {
    console.error("collector_preservation_failed");
    process.exitCode = 1;
  }
}
