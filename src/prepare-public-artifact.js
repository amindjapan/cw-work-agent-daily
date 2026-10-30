"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual, types: { isProxy } } = require("node:util");
const { normalizePublicJobRef, normalizePublicTimestamp } = require("./public-evidence");
const { normalizeText } = require("./model");
const { parseStrictJsonBytes } = require("./strict-json");
const { projectPublicAttempt } = require("./collector-attempt");
const { projectPublicPatrol } = require("./public-patrol-import");

const PUBLIC_FILES = ["index.html", "latest.json", "latest.md", ".nojekyll"];
const OVERVIEW_FILES = ["collector-status.json", "public-patrol.json"];
const isString = (value) => typeof value === "string";
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isBoolean = (value) => typeof value === "boolean";
const nullableNumber = (value) => value === null || isNumber(value);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value) => Array.isArray(value) ? value.filter(isString) : undefined;

function projectFields(value, fields) {
  if (!isObject(value)) return undefined;
  const result = {};
  for (const [key, project] of Object.entries(fields)) {
    if (!Object.hasOwn(value, key)) continue;
    const projected = project(value[key]);
    if (projected !== undefined) result[key] = projected;
  }
  return result;
}

const scalar = (accept) => (value) => accept(value) ? value : undefined;
const projectAnalysis = (value) => projectFields(value, {
  score: scalar(isNumber), level: scalar(isString), verdict: scalar(isString),
  canExecute: scalar(isBoolean), matchedSkills: strings, strongSignals: strings,
  riskFlags: strings, budgetYen: scalar(nullableNumber)
});
const projectRecommendation = (value) => value === null ? null : projectFields(value, {
  id: scalar((id) => isString(id) || Number.isSafeInteger(id)),
  title: scalar(isString), url: scalar(isString), budget: scalar(isString),
  category: scalar(isString), description: scalar(isString), sourceUrl: scalar(isString),
  status: scalar(isString), expiresAt: scalar(isString), applications: scalar(isNumber),
  importedAt: scalar(isString), detailCheckedAt: scalar(isString),
  analysis: projectAnalysis, selectionReasons: strings
});
const projectAttempt = (value) => projectFields(value, {
  keyword: scalar(isString), ok: scalar(isBoolean), status: scalar(nullableNumber),
  imported: scalar(nullableNumber), error: scalar(isString)
});

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isTimestamp = (value) => isString(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const countFields = (names) => Object.fromEntries(names.map((name) => [name, scalar(isCount)]));

function projectCollection(value) {
  const result = projectFields(value, {
    schemaVersion: scalar((version) => version === 1),
    status: scalar((status) => status === "attempts_completed"),
    startedAt: scalar(isTimestamp), attemptsCompletedAt: scalar(isTimestamp),
    decisionAsOf: scalar(isTimestamp),
    search: (search) => projectFields(search,
      countFields(["planned", "attempted", "succeeded", "failed", "notAttempted"])),
    details: (details) => projectFields(details,
      countFields(["observed", "attempted", "succeeded", "failed", "notAttempted"])),
    candidates: (candidates) => projectFields(candidates, {
      machine: scalar((count) => count === null || isCount(count)),
      detailConfirmed: scalar((count) => count === null || isCount(count)),
      detailUnconfirmed: scalar((count) => count === null || isCount(count))
    })
  });
  const complete = (object, keys) => isObject(object) && keys.every((key) => Object.hasOwn(object, key));
  if (!complete(result, ["schemaVersion", "status", "startedAt", "attemptsCompletedAt", "decisionAsOf",
    "search", "details", "candidates"])
    || !complete(result.search, ["planned", "attempted", "succeeded", "failed", "notAttempted"])
    || !complete(result.details, ["observed", "attempted", "succeeded", "failed", "notAttempted"])
    || !complete(result.candidates, ["machine", "detailConfirmed", "detailUnconfirmed"])) {
    throw new Error("invalid_public_collection");
  }
  const { search, details, candidates } = result;
  if (Date.parse(result.attemptsCompletedAt) < Date.parse(result.startedAt)
    || result.decisionAsOf !== result.startedAt
    || search.attempted !== search.succeeded + search.failed
    || search.planned !== search.attempted + search.notAttempted
    || details.attempted !== details.succeeded + details.failed
    || details.observed !== details.attempted + details.notAttempted
    || (candidates.machine === null
      ? candidates.detailConfirmed !== null || candidates.detailUnconfirmed !== null
      : !isCount(candidates.detailConfirmed) || !isCount(candidates.detailUnconfirmed)
        || candidates.machine !== candidates.detailConfirmed + candidates.detailUnconfirmed
        || candidates.detailConfirmed > details.succeeded || candidates.machine > details.observed)) {
    throw new Error("invalid_public_collection");
  }
  return result;
}

function validateNewSummary(input, summary) {
  const { collection, totalJobs, safeCandidates, attempts, keywords, recommendation } = summary;
  const validAttempt = (attempt) => isString(attempt.keyword) && isBoolean(attempt.ok)
    && (attempt.status === null || isCount(attempt.status) && attempt.status <= 599)
    && (attempt.imported === null || isCount(attempt.imported))
    && (!attempt.ok || attempt.imported !== null && Number.isInteger(attempt.status)
      && attempt.status >= 200 && attempt.status < 300);
  if ((totalJobs === null) !== (safeCandidates === null)
    || (totalJobs === null && (recommendation !== null || collection.search.succeeded > 0))
    || attempts.length !== collection.search.planned || keywords.length !== collection.search.planned
    || attempts.some((attempt) => !validAttempt(attempt))
    || attempts.filter((attempt) => attempt.ok).length !== collection.search.succeeded) {
    throw new Error("invalid_public_collection");
  }
  if (recommendation === null) return;
  const ref = normalizePublicJobRef({ platform: "crowdworks", id: recommendation.id, url: recommendation.url });
  const checkedAt = normalizePublicTimestamp(recommendation.detailCheckedAt);
  const analysis = recommendation.analysis;
  if (collection.candidates.detailConfirmed < 1 || !ref || ref.url !== recommendation.url || !checkedAt
    || checkedAt < collection.startedAt || checkedAt > collection.attemptsCompletedAt
    || !normalizeText(recommendation.description) || !analysis || !Number.isInteger(analysis.score)
    || analysis.score < 0 || analysis.score > 100 || analysis.canExecute !== true
    || !["low", "medium", "high"].includes(analysis.level)
    || (Object.hasOwn(input.recommendation, "applications") && !isCount(recommendation.applications))) {
    throw new Error("invalid_public_collection");
  }
  if (Object.hasOwn(input.recommendation, "expiresAt")) {
    const expiresAt = recommendation.expiresAt;
    if (expiresAt === "") return;
    const midnight = typeof expiresAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(expiresAt)
      ? new Date(`${expiresAt}T00:00:00Z`) : null;
    if (!midnight || !Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== expiresAt
      // Match the legacy decision cutoff; do not move expiry from generatedAt to completion.
      || Date.parse(`${expiresAt}T23:59:59+09:00`) < Date.parse(collection.decisionAsOf)) {
      throw new Error("invalid_public_collection");
    }
  }
}

// Keep the legacy public summary, including unknown (null) counts, separate from
// candidate observations, employer history, relationships, and review inferences.
function projectPublicSummary(value) {
  const result = projectFields(value, {
    generatedAt: scalar(isString), generatedAtJst: scalar(isString), keywords: strings,
    attempts: (attempts) => Array.isArray(attempts)
      ? attempts.map(projectAttempt).filter((attempt) => attempt !== undefined) : undefined,
    totalJobs: scalar(nullableNumber), safeCandidates: scalar(nullableNumber),
    recommendation: projectRecommendation,
    collection: projectCollection
  });
  const required = ["generatedAt", "generatedAtJst", "keywords", "attempts",
    "totalJobs", "safeCandidates", "recommendation"];
  if (!result || required.some((key) => !Object.hasOwn(result, key))) {
    throw new Error("invalid_public_summary");
  }
  if (result.collection && (result.collection.startedAt !== result.generatedAt
    || result.collection.candidates.machine !== result.safeCandidates
    || (result.totalJobs === null ? result.collection.details.observed !== 0
      : result.collection.details.observed !== result.totalJobs))) {
    throw new Error("invalid_public_collection");
  }
  if (result.collection) validateNewSummary(value, result);
  return result;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".."
    && !relative.startsWith(`..${path.sep}`));
}

function physicalPath(target) {
  let ancestor = path.resolve(target);
  const missing = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("invalid_public_artifact_path");
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...missing);
}

function regularFile(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("invalid_public_artifact_file");
}

function archiveFilename(name) {
  const match = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
  if (!match) return false;
  const date = new Date(`${match[1]}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1];
}

function projectCollectorStatus(value) {
  if (isProxy(value) || !isObject(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some((key) => !["kind", "schemaVersion", "availability", "attempt", "asOf"].includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !Object.hasOwn(descriptor, "value"))
    || value.kind !== "collector_status" || value.schemaVersion !== 1
    || !isTimestamp(value.asOf)
    || !["AVAILABLE", "UNAVAILABLE"].includes(value.availability)
    || (value.availability === "UNAVAILABLE" ? value.attempt !== null : value.attempt === null)) {
    throw new Error("invalid_collector_status");
  }
  const attempt = value.attempt === null ? null : projectPublicAttempt(value.attempt);
  if (attempt && (attempt.startedAt > value.asOf || attempt.finishedAt !== null && attempt.finishedAt > value.asOf)) {
    throw new Error("invalid_collector_status");
  }
  return { kind: "collector_status", schemaVersion: 1, availability: value.availability, asOf: value.asOf, attempt };
}

function overviewMarkdown(view) {
  return ["# Collector status", "", `As of: ${view.asOf}`, "Last verified success: UNKNOWN", "",
    "See index.html for the separately attributed attempt, saved material and patrol evidence.", ""].join("\n");
}

function preparePublicArtifact({ sourceDir, outputDir, includeOverview = false } = {}) {
  if (typeof sourceDir !== "string" || typeof outputDir !== "string") {
    throw new Error("public_artifact_paths_required");
  }
  if (typeof includeOverview !== "boolean") throw new Error("invalid_overview_option");
  const source = path.resolve(sourceDir), output = path.resolve(outputDir);
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error("invalid_public_artifact_source");
  }
  const sourcePhysical = physicalPath(source), outputPhysical = physicalPath(output);
  if (isWithin(sourcePhysical, outputPhysical) || isWithin(outputPhysical, sourcePhysical)) {
    throw new Error("public_artifact_paths_overlap");
  }
  if (fs.existsSync(output)) {
    const stat = fs.lstatSync(output);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(output).length) {
      throw new Error("public_artifact_output_must_be_empty");
    }
  }

  const selected = [...PUBLIC_FILES];
  if (includeOverview) selected.push(...OVERVIEW_FILES);
  const archive = path.join(source, "archive");
  if (fs.existsSync(archive)) {
    const stat = fs.lstatSync(archive);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("invalid_public_artifact_archive");
    selected.push(...fs.readdirSync(archive).filter(archiveFilename).sort()
      .map((name) => path.join("archive", name)));
  }
  // Validate every selected input before creating output. Unknown paths are never
  // traversed, and an existing staging directory cannot retain stale observations.
  const copies = selected.map((relative) => {
    const file = path.join(source, relative);
    regularFile(file);
    const original = fs.readFileSync(file);
    if (!relative.endsWith(".json")) return { relative, content: original };
    let summary;
    try { summary = parseStrictJsonBytes(original).value; }
    catch { throw new Error("invalid_public_summary"); }
    const projected = relative === "collector-status.json" ? projectCollectorStatus(summary)
      : relative === "public-patrol.json" ? projectPublicPatrol(summary) : projectPublicSummary(summary);
    return { relative, content: isDeepStrictEqual(summary, projected) ? original
      : Buffer.from(`${JSON.stringify(projected, null, 2)}\n`, "utf8") };
  });
  if (includeOverview) {
    const json = (name) => parseStrictJsonBytes(copies.find((copy) => copy.relative === name).content).value;
    const status = json("collector-status.json");
    // Resolve only when composing after this module has loaded; overview uses
    // the existing public summary projector and has no I/O on import.
    const { buildCollectorOverview, renderCollectorOverview } = require("./collector-overview");
    const view = buildCollectorOverview({ latestAttempt: status.attempt, savedSummary: json("latest.json"),
      verifiedSuccess: null, patrol: json("public-patrol.json"), asOf: status.asOf });
    // New overview mode always renders from projected data. It never copies
    // arbitrary HTML/Markdown from a staging directory into a public artifact.
    copies.find((copy) => copy.relative === "index.html").content = Buffer.from(renderCollectorOverview(view), "utf8");
    copies.find((copy) => copy.relative === "latest.md").content = Buffer.from(overviewMarkdown(view), "utf8");
    copies.find((copy) => copy.relative === ".nojekyll").content = Buffer.alloc(0);
  }
  fs.mkdirSync(output, { recursive: true });
  for (const { relative, content } of copies) {
    const destination = path.join(output, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  return { copiedFiles: selected.map((relative) => relative.split(path.sep).join("/")) };
}

// Export the projectors before the CLI can lazily load the overview renderer,
// which uses this module's existing public-summary projection.
module.exports = { preparePublicArtifact, projectPublicSummary, projectCollectorStatus, overviewMarkdown };

if (require.main === module) {
  try {
    const sourceIndex = process.argv.indexOf("--source"), outputIndex = process.argv.indexOf("--output");
    const result = preparePublicArtifact({
      sourceDir: sourceIndex < 0 ? undefined : process.argv[sourceIndex + 1],
      outputDir: outputIndex < 0 ? undefined : process.argv[outputIndex + 1],
      includeOverview: process.argv.includes("--overview")
    });
    console.log(JSON.stringify({ status: "public_artifact_prepared", ...result }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
