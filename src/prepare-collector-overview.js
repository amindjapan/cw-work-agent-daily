"use strict";

// Explicit local composition only: this module never collects, authenticates,
// commits, deploys, searches for inputs, or reads private operational records.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual, types: { isProxy } } = require("node:util");
const { parseStrictJsonBytes } = require("./strict-json");
const { projectPublicSummary, projectCollectorStatus, overviewMarkdown } = require("./prepare-public-artifact");
const { projectPublicAttempt } = require("./collector-attempt");
const { importPublicPatrol } = require("./public-patrol-import");
const { buildCollectorOverview, renderCollectorOverview } = require("./collector-overview");
const { projectWorkflowObservation } = require("./workflow-observation");
const { projectReconstructionManifest } = require("./reconstructed-baseline");

function inside(parent, target) {
  const relative = path.relative(parent, target);
  return !relative || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function noLinks(target) {
  let current = path.resolve(target);
  for (;;) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("overview_unsafe_path");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function inputBytes(file) {
  if (typeof file !== "string" || !file) throw new Error("overview_input_required");
  noLinks(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("overview_invalid_input");
  return fs.readFileSync(file);
}

function prepareCollectorOverview(input = {}) {
  const allowed = ["summaryFile", "summaryBytes", "attemptFile", "workflowObservationFile", "workflowObservation",
    "patrolFile", "patrolInput", "reconstructionFile", "reconstruction", "reconstructionMode", "outputDir", "asOf"];
  if (isProxy(input) || input === null || typeof input !== "object" || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error("overview_invalid_options");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some((key) => !allowed.includes(key) || !Object.hasOwn(descriptors[key], "value"))) {
    throw new Error("overview_invalid_options");
  }
  const options = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
  const { summaryFile, summaryBytes, attemptFile, workflowObservationFile, workflowObservation,
    patrolFile, patrolInput, reconstructionFile, reconstruction: reconstructionInput,
    reconstructionMode = "status-only", outputDir, asOf } = options;
  if (!["status-only", "daily"].includes(reconstructionMode)) throw new Error("overview_invalid_reconstruction_mode");
  for (const [file, memory] of [[summaryFile, summaryBytes], [workflowObservationFile, workflowObservation], [patrolFile, patrolInput], [reconstructionFile, reconstructionInput]]) {
    if (file !== undefined && memory !== undefined) throw new Error("overview_ambiguous_input");
  }
  if (summaryFile === undefined && summaryBytes === undefined) throw new Error("overview_input_required");
  if (attemptFile !== undefined && (workflowObservationFile !== undefined || workflowObservation != null)) {
    throw new Error("overview_ambiguous_input");
  }
  if (typeof outputDir !== "string" || !outputDir) throw new Error("overview_output_required");
  const output = path.resolve(outputDir);
  noLinks(output);
  for (const file of [summaryFile, attemptFile, workflowObservationFile, patrolFile, reconstructionFile].filter((value) => value !== undefined)) {
    if (typeof file !== "string" || inside(output, path.resolve(file))) throw new Error("overview_paths_overlap");
  }
  if (fs.existsSync(output) && (!fs.lstatSync(output).isDirectory() || fs.readdirSync(output).length)) {
    throw new Error("overview_output_must_be_empty");
  }
  // The byte parser copies caller-owned buffers. Prevalidated snapshots can be
  // passed directly without rereading a file or creating a temporary input.
  const parsed = parseStrictJsonBytes(summaryFile === undefined ? summaryBytes : inputBytes(summaryFile), { maxBytes: 1024 * 1024 });
  const original = parsed.bytes, summary = parsed.value;
  const projected = projectPublicSummary(summary);
  // Existing saved material is an explicit, already-public input, not an
  // opportunity to silently export hidden fields from an internal document.
  if (!isDeepStrictEqual(summary, projected)) throw new Error("overview_nonpublic_summary");
  const attempt = attemptFile === undefined ? null
    : projectPublicAttempt(parseStrictJsonBytes(inputBytes(attemptFile), { maxBytes: 1024 * 1024 }).value);
  const observation = workflowObservationFile === undefined ? workflowObservation == null ? null : projectWorkflowObservation(workflowObservation)
    : projectWorkflowObservation(parseStrictJsonBytes(inputBytes(workflowObservationFile), { maxBytes: 1024 * 1024 }).value);
  const status = projectCollectorStatus({ kind: "collector_status", schemaVersion: 2,
    availability: attempt === null && observation === null ? "UNAVAILABLE" : "AVAILABLE", asOf, attempt, workflowObservation: observation });
  const patrol = importPublicPatrol(patrolFile === undefined ? patrolInput ?? null : inputBytes(patrolFile));
  const reconstruction = reconstructionFile === undefined ? reconstructionInput == null ? null : projectReconstructionManifest(reconstructionInput)
    : projectReconstructionManifest(parseStrictJsonBytes(inputBytes(reconstructionFile), { maxBytes: 1024 * 1024 }).value);
  if (reconstruction && reconstructionMode === "status-only") {
    const source = reconstruction.sourceInputs.find((item) => item.baselinePath === "latest.json");
    const sha256 = crypto.createHash("sha256").update(original).digest("hex");
    const gitBlobSha = crypto.createHash("sha1").update(`blob ${original.length}\0`).update(original).digest("hex");
    if (!source || source.bytes !== original.length || source.sha256 !== sha256 || source.gitBlobSha !== gitBlobSha) {
      throw new Error("overview_reconstruction_source_mismatch");
    }
  }
  const view = buildCollectorOverview({ latestAttempt: status.attempt, workflowObservation: status.workflowObservation, savedSummary: projected,
    verifiedSuccess: null, patrol, reconstruction, asOf });
  const html = renderCollectorOverview(view);
  const markdown = overviewMarkdown(view);
  // All inputs and projections are checked before the first output is created.
  // Consumers must stage this new directory; no existing saved file is replaced.
  fs.mkdirSync(output, { recursive: true });
  const files = [["latest.json", original], ["index.html", html], ["latest.md", markdown],
    [".nojekyll", ""], ["collector-status.json", `${JSON.stringify(status, null, 2)}\n`],
    ["public-patrol.json", `${JSON.stringify(patrol, null, 2)}\n`],
    ...(reconstruction ? [["reconstruction.json", `${JSON.stringify(reconstruction, null, 2)}\n`]] : [])];
  for (const [name, bytes] of files) {
    fs.writeFileSync(path.join(output, name), bytes, { flag: "wx" });
  }
  return { status: "overview_prepared", files: ["index.html", "latest.json", "latest.md", ".nojekyll",
    "collector-status.json", "public-patrol.json", ...(reconstruction ? ["reconstruction.json"] : [])], view };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const argument = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
    const result = prepareCollectorOverview({ summaryFile: argument("--summary"), attemptFile: argument("--attempt"),
      workflowObservationFile: argument("--workflow-observation"), patrolFile: argument("--patrol"),
      reconstructionFile: argument("--reconstruction"), reconstructionMode: argument("--reconstruction-mode"),
      outputDir: argument("--output"), asOf: argument("--as-of") });
    console.log(JSON.stringify({ status: result.status, files: result.files }));
  } catch {
    console.error("collector_overview_failed");
    process.exitCode = 1;
  }
}

module.exports = { prepareCollectorOverview };
