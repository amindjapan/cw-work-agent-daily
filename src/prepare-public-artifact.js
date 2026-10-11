"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const PUBLIC_FILES = ["index.html", "latest.json", "latest.md", ".nojekyll"];
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

// Keep the legacy public summary, including unknown (null) counts, separate from
// candidate observations, employer history, relationships, and review inferences.
function projectPublicSummary(value) {
  const result = projectFields(value, {
    generatedAt: scalar(isString), generatedAtJst: scalar(isString), keywords: strings,
    attempts: (attempts) => Array.isArray(attempts)
      ? attempts.map(projectAttempt).filter((attempt) => attempt !== undefined) : undefined,
    totalJobs: scalar(nullableNumber), safeCandidates: scalar(nullableNumber),
    recommendation: projectRecommendation
  });
  const required = ["generatedAt", "generatedAtJst", "keywords", "attempts",
    "totalJobs", "safeCandidates", "recommendation"];
  if (!result || required.some((key) => !Object.hasOwn(result, key))) {
    throw new Error("invalid_public_summary");
  }
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

function preparePublicArtifact({ sourceDir, outputDir } = {}) {
  if (typeof sourceDir !== "string" || typeof outputDir !== "string") {
    throw new Error("public_artifact_paths_required");
  }
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
    try { summary = JSON.parse(original.toString("utf8")); }
    catch { throw new Error("invalid_public_summary"); }
    const projected = projectPublicSummary(summary);
    return { relative, content: isDeepStrictEqual(summary, projected) ? original
      : Buffer.from(`${JSON.stringify(projected, null, 2)}\n`, "utf8") };
  });
  fs.mkdirSync(output, { recursive: true });
  for (const { relative, content } of copies) {
    const destination = path.join(output, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  return { copiedFiles: selected.map((relative) => relative.split(path.sep).join("/")) };
}

if (require.main === module) {
  try {
    const sourceIndex = process.argv.indexOf("--source"), outputIndex = process.argv.indexOf("--output");
    const result = preparePublicArtifact({
      sourceDir: sourceIndex < 0 ? undefined : process.argv[sourceIndex + 1],
      outputDir: outputIndex < 0 ? undefined : process.argv[outputIndex + 1]
    });
    console.log(JSON.stringify({ status: "public_artifact_prepared", ...result }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { preparePublicArtifact, projectPublicSummary };
