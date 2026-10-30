"use strict";

// Explicit local public inputs only. No collection, credentials, remote service,
// workflow invocation, publication or repository mutation is performed here.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual, types } = require("node:util");
const { parseStrictJsonBytes } = require("./strict-json");
const { normalizePublicTimestamp } = require("./public-evidence");
const { projectPublicSummary } = require("./prepare-public-artifact");
const { projectPublicPatrol } = require("./public-patrol-import");
const { projectWorkflowObservation, selectLatestWorkflowObservation } = require("./workflow-observation");
const { prepareCollectorOverview } = require("./prepare-collector-overview");

const PUBLIC_FILES = ["index.html", "latest.json", "latest.md", ".nojekyll", "collector-status.json", "public-patrol.json"];
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_ARCHIVES = 400;
const MAX_OBSERVATIONS = 256;
const OWN_ERRORS = new WeakSet();
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function fail(code) {
  const error = new Error(`collector_site_${code}`);
  error.code = error.message;
  OWN_ERRORS.add(error);
  throw error;
}
function requireThat(condition, code) { if (!condition) fail(code); }

function optionsSnapshot(value) {
  requireThat(value && typeof value === "object" && !Array.isArray(value) && !types.isProxy(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), "invalid_options");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = ["summaryFile", "archiveDir", "observationFiles", "patrolFile", "outputDir", "asOf"];
  requireThat(Reflect.ownKeys(descriptors).every((key) => typeof key === "string" && allowed.includes(key)
    && Object.hasOwn(descriptors[key], "value")), "invalid_options");
  const result = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
  const observations = result.observationFiles === undefined ? [] : result.observationFiles;
  requireThat(Array.isArray(observations) && !types.isProxy(observations) && Object.getPrototypeOf(observations) === Array.prototype, "invalid_options");
  const arrayDescriptors = Object.getOwnPropertyDescriptors(observations);
  requireThat(observations.length <= MAX_OBSERVATIONS
    && Reflect.ownKeys(arrayDescriptors).length === observations.length + 1
    && Reflect.ownKeys(arrayDescriptors).every((key) => key === "length" || typeof key === "string"
      && /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < observations.length
      && Object.hasOwn(arrayDescriptors[key], "value")), "invalid_options");
  result.observationFiles = Array.from({ length: observations.length }, (_, index) => arrayDescriptors[index].value);
  return result;
}

function explicitPath(value) {
  requireThat(typeof value === "string" && value.length > 0 && !value.includes("\0")
    && !/^[\\/]{2}/.test(value) && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)
    && !/^[A-Za-z]:(?![\\/])/.test(value), "invalid_path");
  return path.resolve(value);
}

function noLinks(target) {
  for (let current = path.resolve(target);;) {
    try { requireThat(!fs.lstatSync(current).isSymbolicLink(), "unsafe_path"); }
    catch (error) { if (OWN_ERRORS.has(error) || error.code !== "ENOENT") throw error; }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function physicalPath(target) {
  let ancestor = path.resolve(target);
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    requireThat(parent !== ancestor, "invalid_path");
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.resolve(fs.realpathSync(ancestor), ...suffix);
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function separate(output, input) {
  const a = physicalPath(output), b = physicalPath(input);
  requireThat(!inside(a, b) && !inside(b, a), "paths_overlap");
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function readInput(file) {
  const target = explicitPath(file);
  noLinks(target);
  const before = fs.lstatSync(target);
  requireThat(before.isFile() && !before.isSymbolicLink() && before.size <= MAX_INPUT_BYTES, "invalid_input_file");
  let descriptor;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    requireThat(opened.isFile() && sameFile(before, opened), "input_changed");
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    noLinks(target);
    const located = fs.lstatSync(target);
    requireThat(sameFile(opened, after) && sameFile(after, located) && bytes.length === before.size, "input_changed");
    return { path: target, bytes, sha256: hash(bytes), stat: located };
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function parsePublicSummary(input) {
  let value, projected;
  try {
    value = parseStrictJsonBytes(input.bytes, { maxBytes: MAX_INPUT_BYTES }).value;
    projected = projectPublicSummary(value);
  } catch { fail("invalid_public_summary"); }
  requireThat(isDeepStrictEqual(value, projected), "nonpublic_summary");
  return projected;
}

function dateFilename(name) {
  const matched = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
  if (!matched) return false;
  const date = new Date(`${matched[1]}T00:00:00Z`);
  requireThat(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === matched[1], "invalid_archive_date");
  return true;
}

function readArchives(directory) {
  if (directory === undefined) return [];
  const target = explicitPath(directory);
  noLinks(target);
  requireThat(fs.lstatSync(target).isDirectory(), "invalid_archive_directory");
  const names = fs.readdirSync(target).filter(dateFilename).sort();
  requireThat(names.length <= MAX_ARCHIVES, "archive_limit");
  return names.map((name) => {
    const input = readInput(path.join(target, name));
    parsePublicSummary(input);
    return { ...input, relative: `archive/${name}` };
  });
}

function observationName(name) {
  const match = /^([1-9][0-9]{0,31})-([1-9][0-9]{0,15})\.json$/.exec(name);
  if (!match) return null;
  const attempt = Number(match[2]);
  requireThat(Number.isSafeInteger(attempt) && String(attempt) === match[2], "invalid_observation_filename");
  return { runId: match[1], runAttempt: attempt };
}

function readObservation(file) {
  const input = readInput(file);
  let record;
  try { record = projectWorkflowObservation(parseStrictJsonBytes(input.bytes, { maxBytes: MAX_INPUT_BYTES }).value); }
  catch { fail("invalid_workflow_observation"); }
  const identity = observationName(path.basename(input.path));
  if (identity) requireThat(record.runId === identity.runId && record.runAttempt === identity.runAttempt, "observation_filename_mismatch");
  return { ...input, record };
}

function inputUnchanged(input) {
  noLinks(input.path);
  requireThat(sameFile(input.stat, fs.lstatSync(input.path)), "input_changed");
}

function fileManifest(relative, bytes) { return { path: relative, bytes: bytes.length, sha256: hash(bytes) }; }

function buildCollectorSite(options = {}) {
  try {
    const { summaryFile, archiveDir, observationFiles, patrolFile, outputDir, asOf } = optionsSnapshot(options);
    requireThat(typeof asOf === "string" && normalizePublicTimestamp(asOf) === asOf, "invalid_as_of");
    const output = explicitPath(outputDir), summaryPath = explicitPath(summaryFile);
    const declaredPaths = [summaryPath, ...observationFiles.map(explicitPath),
      ...(archiveDir === undefined ? [] : [explicitPath(archiveDir)]), ...(patrolFile === undefined ? [] : [explicitPath(patrolFile)])];
    noLinks(output);
    declaredPaths.forEach((target) => { noLinks(target); separate(output, target); });
    requireThat(new Set(observationFiles.map(explicitPath)).size === observationFiles.length, "duplicate_input_path");
    if (fs.existsSync(output)) requireThat(fs.lstatSync(output).isDirectory() && fs.readdirSync(output).length === 0, "output_must_be_empty");
    const summary = readInput(summaryPath);
    parsePublicSummary(summary);
    const archives = readArchives(archiveDir);
    const observations = observationFiles.map(readObservation);
    const selected = selectLatestWorkflowObservation(observations.map((item) => item.record));
    requireThat(selected.status === "AVAILABLE" || selected.status === "UNAVAILABLE" && selected.reasonCode === "observation_missing", "workflow_observation_conflict");
    let patrol;
    if (patrolFile !== undefined) {
      patrol = readInput(patrolFile);
      try {
        const original = parseStrictJsonBytes(patrol.bytes, { maxBytes: MAX_INPUT_BYTES }).value;
        const projected = projectPublicPatrol(original);
        requireThat(isDeepStrictEqual(original, projected), "noncanonical_public_patrol");
        patrol.value = projected;
      } catch (error) { if (OWN_ERRORS.has(error)) throw error; fail("invalid_public_patrol"); }
    }
    [summary, ...archives, ...observations, ...(patrol ? [patrol] : [])].forEach(inputUnchanged);
    // Hand the composer only validated snapshots. It must not re-read the paths
    // after archive validation, nor create a temporary input record.
    prepareCollectorOverview({ summaryBytes: summary.bytes, workflowObservation: selected.observation,
      ...(patrol ? { patrolInput: patrol.value } : {}), outputDir: output, asOf });
    requireThat(isDeepStrictEqual(fs.readdirSync(output).sort(), [...PUBLIC_FILES].sort()), "unexpected_output_files");
    const manifestFiles = PUBLIC_FILES.map((relative) => {
      const produced = readInput(path.join(output, relative));
      if (relative === "latest.json") requireThat(produced.sha256 === summary.sha256 && produced.bytes.equals(summary.bytes), "summary_bytes_changed");
      return fileManifest(relative, produced.bytes);
    });
    if (archives.length) fs.mkdirSync(path.join(output, "archive"));
    for (const archive of archives) {
      const destination = path.join(output, ...archive.relative.split("/"));
      fs.writeFileSync(destination, archive.bytes, { flag: "wx" });
      const produced = readInput(destination);
      requireThat(produced.sha256 === archive.sha256 && produced.bytes.equals(archive.bytes), "archive_bytes_changed");
      manifestFiles.push(fileManifest(archive.relative, produced.bytes));
    }
    return { status: "collector_site_built", files: manifestFiles.map((item) => item.path),
      manifest: { schemaVersion: 1, publicFileCount: manifestFiles.length, archiveCount: archives.length,
        observationFileCount: observations.length, selectedObservationSha256: selected.observation ? selected.observation.contentSha256 : null,
        summary: { bytes: summary.bytes.length, sha256: summary.sha256 },
        archives: archives.map((item) => fileManifest(item.relative, item.bytes)), files: manifestFiles } };
  } catch (error) { if (OWN_ERRORS.has(error)) throw error; fail("build_failed"); }
}

function buildCollectorSiteCli(args = process.argv.slice(2)) {
  try {
    requireThat(Array.isArray(args), "invalid_arguments");
    const flags = new Map(), allowed = ["--summary", "--archives", "--observations", "--patrol", "--output", "--as-of"];
    for (let index = 0; index < args.length; index += 2) {
      requireThat(allowed.includes(args[index]) && !flags.has(args[index]) && typeof args[index + 1] === "string"
        && args[index + 1].length > 0 && !args[index + 1].startsWith("--"), "invalid_arguments");
      flags.set(args[index], args[index + 1]);
    }
    let observationFiles = [];
    const observationDirectory = flags.get("--observations");
    if (observationDirectory !== undefined) {
      const directory = explicitPath(observationDirectory), output = explicitPath(flags.get("--output"));
      noLinks(directory); separate(output, directory);
      requireThat(fs.lstatSync(directory).isDirectory(), "invalid_observation_directory");
      observationFiles = fs.readdirSync(directory).filter((name) => observationName(name) !== null).sort().map((name) => path.join(directory, name));
      requireThat(observationFiles.length <= MAX_OBSERVATIONS, "observation_limit");
    }
    const result = buildCollectorSite({ summaryFile: flags.get("--summary"), archiveDir: flags.get("--archives"),
      observationFiles, patrolFile: flags.get("--patrol"), outputDir: flags.get("--output"), asOf: flags.get("--as-of") });
    console.log(JSON.stringify(result));
    return 0;
  } catch {
    console.error("collector_site_build_failed");
    return 1;
  }
}

if (require.main === module) process.exitCode = buildCollectorSiteCli();

module.exports = { buildCollectorSite, buildCollectorSiteCli };
