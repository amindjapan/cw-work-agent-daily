"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { preparePublicArtifact, projectPublicSummary } = require("../src/prepare-public-artifact");

function directories(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cw-public-artifact-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, "site"), outputDir = path.join(root, "public");
  fs.mkdirSync(sourceDir);
  return { root, sourceDir, outputDir };
}

function summary() {
  return {
    generatedAt: "2026-10-11T02:00:00Z", generatedAtJst: "2026/10/11 11:00",
    keywords: ["CSV"], attempts: [{ keyword: "CSV", ok: true, status: 200, imported: 1 }],
    totalJobs: 1, safeCandidates: 1,
    recommendation: { id: "123", title: "Python CSV", url: "https://crowdworks.jp/public/jobs/123",
      description: "Public work description", applications: 0,
      analysis: { score: 75, level: "high", verdict: "candidate", canExecute: true,
        matchedSkills: ["python"], strongSignals: ["csv"], riskFlags: [], budgetYen: null },
      selectionReasons: ["Public existing reason"] }
  };
}

function writeSite(sourceDir, data = summary()) {
  fs.writeFileSync(path.join(sourceDir, "latest.json"), `${JSON.stringify(data, null, 4)}\n`);
  fs.writeFileSync(path.join(sourceDir, "index.html"), "<!doctype html>\r\n<p>Existing public summary</p>\r\n");
  fs.writeFileSync(path.join(sourceDir, "latest.md"), "# Existing public summary\r\n");
  fs.writeFileSync(path.join(sourceDir, ".nojekyll"), "");
}

function json(directory, relative) {
  return JSON.parse(fs.readFileSync(path.join(directory, relative), "utf8"));
}

function collectionSummary() {
  const data = summary();
  data.generatedAt = "2026-10-11T02:00:00.000Z";
  data.recommendation.detailCheckedAt = "2026-10-11T02:00:02.000Z";
  data.collection = {
    schemaVersion: 1, status: "attempts_completed",
    startedAt: data.generatedAt, attemptsCompletedAt: "2026-10-11T02:00:03.000Z",
    decisionAsOf: data.generatedAt,
    search: { planned: 1, attempted: 1, succeeded: 1, failed: 0, notAttempted: 0 },
    details: { observed: 1, attempted: 1, succeeded: 1, failed: 0, notAttempted: 0 },
    candidates: { machine: 1, detailConfirmed: 1, detailUnconfirmed: 0 }
  };
  return data;
}

test("collection aggregates survive public projection without changing authenticated JSON bytes", (t) => {
  const dirs = directories(t), data = collectionSummary();
  writeSite(dirs.sourceDir, data);
  preparePublicArtifact(dirs);
  assert.deepEqual(json(dirs.outputDir, "latest.json"), data);
  assert.deepEqual(fs.readFileSync(path.join(dirs.outputDir, "latest.json")),
    fs.readFileSync(path.join(dirs.sourceDir, "latest.json")));
});

test("collection projection excludes nested candidate records and arbitrary secret fields", () => {
  const original = collectionSummary(), injected = structuredClone(original);
  for (const target of [injected, injected.collection, injected.collection.search,
    injected.collection.details, injected.collection.candidates]) {
    target.privateRecord = { candidates: ["INTERNAL_CANDIDATE_MARKER"], secret: "INTERNAL_SECRET_MARKER" };
    target.candidateIds = ["INTERNAL_CANDIDATE_MARKER"];
  }
  assert.deepEqual(projectPublicSummary(injected), original);
  assert.doesNotMatch(JSON.stringify(projectPublicSummary(injected)), /INTERNAL_|privateRecord|candidateIds/);
});

test("legacy summaries never acquire inferred collection completion", () => {
  const original = summary(), projected = projectPublicSummary(original);
  assert.deepEqual(projected, original);
  assert.equal(Object.hasOwn(projected, "collection"), false);
});

test("invalid aggregate types, dates and contradictory counts fail before staging", (t) => {
  const mutations = [
    (data) => { data.collection.startedAt = "INTERNAL_SECRET_MARKER"; },
    (data) => { data.collection.status = "INTERNAL_SECRET_MARKER"; },
    (data) => { data.collection.attemptsCompletedAt = "2026-02-30T02:00:03.000Z"; },
    (data) => { data.collection.attemptsCompletedAt = "2026-10-10T02:00:03.000Z"; },
    (data) => { data.collection.decisionAsOf = "2026-10-11T02:00:01.000Z"; },
    (data) => { data.collection.details.succeeded = 0; },
    (data) => { data.collection.details.observed = 2; },
    (data) => { data.collection.search.attempted = -1; },
    (data) => { data.collection.search.failed = 0.5; },
    (data) => { data.collection.search.planned = Number.MAX_SAFE_INTEGER + 1; },
    (data) => { data.collection.candidates.machine = 2; },
    (data) => { data.collection.candidates.detailConfirmed = null; },
    (data) => { delete data.collection.details.notAttempted; }
  ];
  for (const mutate of mutations) {
    const dirs = directories(t), data = collectionSummary();
    mutate(data);
    writeSite(dirs.sourceDir, data);
    assert.throws(() => preparePublicArtifact(dirs), /invalid_public_collection/);
    assert.equal(fs.existsSync(dirs.outputDir), false);
  }
});

test("aggregate projection distinguishes unobserved candidates from confirmed zero", () => {
  const data = collectionSummary();
  data.totalJobs = null;
  data.safeCandidates = null;
  data.recommendation = null;
  data.collection.search = { planned: 1, attempted: 1, succeeded: 0, failed: 1, notAttempted: 0 };
  data.attempts = [{ keyword: "CSV", ok: false, status: 403, imported: null, error: "fetch_failed" }];
  data.collection.details = { observed: 0, attempted: 0, succeeded: 0, failed: 0, notAttempted: 0 };
  data.collection.candidates = { machine: null, detailConfirmed: null, detailUnconfirmed: null };
  assert.deepEqual(projectPublicSummary(data), data);
  data.totalJobs = 0;
  data.safeCandidates = 0;
  data.collection.search = { planned: 1, attempted: 1, succeeded: 1, failed: 0, notAttempted: 0 };
  data.attempts = [{ keyword: "CSV", ok: true, status: 200, imported: 0 }];
  data.collection.candidates = { machine: 0, detailConfirmed: 0, detailUnconfirmed: 0 };
  assert.deepEqual(projectPublicSummary(data), data);
});

test("v2 new collection rejects unknown and confirmed count mixtures", () => {
  for (const mutate of [
    (data) => { data.totalJobs = null; data.safeCandidates = 0; data.recommendation = null;
      data.collection.details = { observed: 0, attempted: 0, succeeded: 0, failed: 0, notAttempted: 0 };
      data.collection.candidates = { machine: 0, detailConfirmed: 0, detailUnconfirmed: 0 }; },
    (data) => { data.totalJobs = 0; data.safeCandidates = null; data.recommendation = null;
      data.collection.details = { observed: 0, attempted: 0, succeeded: 0, failed: 0, notAttempted: 0 };
      data.collection.candidates = { machine: null, detailConfirmed: null, detailUnconfirmed: null }; }
  ]) {
    const data = collectionSummary(); mutate(data);
    assert.throws(() => projectPublicSummary(data), /invalid_public_collection/);
  }
});

test("v2 new collection agrees with public search attempts", () => {
  for (const mutate of [
    (data) => { data.attempts[0].ok = false; },
    (data) => { data.attempts[0].status = 403; },
    (data) => { data.attempts[0].imported = -1; },
    (data) => { data.attempts = []; },
    (data) => { data.keywords = []; }
  ]) {
    const data = collectionSummary(); mutate(data);
    assert.throws(() => projectPublicSummary(data), /invalid_public_collection/);
  }
});

test("v2 new recommendation needs a confirmed candidate, canonical reference and valid in-run time", () => {
  for (const mutate of [
    (data) => { data.collection.candidates = { machine: 1, detailConfirmed: 0, detailUnconfirmed: 1 }; },
    (data) => { data.recommendation.url = "https://crowdworks.jp/public/jobs/999"; },
    (data) => { delete data.recommendation.detailCheckedAt; },
    (data) => { data.recommendation.detailCheckedAt = "2026-10-11T01:59:59.999Z"; },
    (data) => { data.recommendation.detailCheckedAt = "2026-10-11T02:00:03.001Z"; },
    (data) => { data.recommendation.detailCheckedAt = "2026-02-30T02:00:02Z"; }
  ]) {
    const data = collectionSummary(); mutate(data);
    assert.throws(() => projectPublicSummary(data), /invalid_public_collection/);
  }
  const offset = collectionSummary();
  offset.recommendation.detailCheckedAt = "2026-10-11T11:00:02+09:00";
  assert.deepEqual(projectPublicSummary(offset), offset);
});

test("v2 new recommendation rejects invalid deadlines and deadlines expired at the decision time", () => {
  for (const expiresAt of ["2000-01-01", "2026-02-30", "not-a-date", "2026-10-11T23:59:59Z", 123]) {
    const data = collectionSummary(); data.recommendation.expiresAt = expiresAt;
    assert.throws(() => projectPublicSummary(data), /invalid_public_collection/);
  }
  const data = collectionSummary();
  data.recommendation.expiresAt = "2026-10-11";
  assert.deepEqual(projectPublicSummary(data), data);
});

test("v2 new recommendation rejects malformed score, body and application count fields", () => {
  for (const mutate of [
    (data) => { data.recommendation.analysis.score = 999; },
    (data) => { data.recommendation.analysis.score = 75.5; },
    (data) => { data.recommendation.analysis.canExecute = false; },
    (data) => { data.recommendation.applications = -10; },
    (data) => { data.recommendation.applications = 1.5; },
    (data) => { data.recommendation.description = "<p> </p>"; }
  ]) {
    const data = collectionSummary(); mutate(data);
    assert.throws(() => projectPublicSummary(data), /invalid_public_collection/);
  }
});

test("v2 malformed UTF-8 JSON cannot be silently decoded and copied to public staging", (t) => {
  const dirs = directories(t);
  writeSite(dirs.sourceDir);
  const bytes = Buffer.from(JSON.stringify(summary()));
  const position = bytes.indexOf(Buffer.from("Public work description"));
  bytes[position] = 0xff;
  fs.writeFileSync(path.join(dirs.sourceDir, "latest.json"), bytes);
  assert.throws(() => preparePublicArtifact(dirs), /invalid_public_summary/);
  assert.equal(fs.existsSync(dirs.outputDir), false);
});

test("v2 inconsistent new recommendation stops staging without modifying the source", (t) => {
  const dirs = directories(t), data = collectionSummary();
  data.recommendation.expiresAt = "2000-01-01";
  writeSite(dirs.sourceDir, data);
  const before = fs.readFileSync(path.join(dirs.sourceDir, "latest.json"));
  assert.throws(() => preparePublicArtifact(dirs), /invalid_public_collection/);
  assert.equal(fs.existsSync(dirs.outputDir), false);
  assert.deepEqual(fs.readFileSync(path.join(dirs.sourceDir, "latest.json")), before);
});

test("v2 duplicate JSON keys cannot hide internal raw bytes behind the projected value", (t) => {
  const dirs = directories(t);
  writeSite(dirs.sourceDir);
  const original = JSON.stringify(summary()).replace('"description":"Public work description"',
    '"description":"INTERNAL_DUPLICATE_MARKER","descrip\\u0074ion":"Public work description"');
  fs.writeFileSync(path.join(dirs.sourceDir, "latest.json"), original);
  assert.equal(JSON.parse(original).recommendation.description, "Public work description");
  assert.throws(() => preparePublicArtifact(dirs), /invalid_public_summary/);
  assert.equal(fs.existsSync(dirs.outputDir), false);
});

test("public artifact preserves legacy public files byte for byte", (t) => {
  const dirs = directories(t);
  writeSite(dirs.sourceDir);
  const archive = path.join(dirs.sourceDir, "archive");
  fs.mkdirSync(archive);
  fs.writeFileSync(path.join(archive, "2026-10-11.json"), JSON.stringify(summary()));
  const { copiedFiles } = preparePublicArtifact(dirs);
  assert.deepEqual(copiedFiles, ["index.html", "latest.json", "latest.md", ".nojekyll", "archive/2026-10-11.json"]);
  for (const relative of copiedFiles) {
    assert.deepEqual(fs.readFileSync(path.join(dirs.outputDir, relative)),
      fs.readFileSync(path.join(dirs.sourceDir, relative)));
  }
});

test("public copy excludes internally observed candidates, differences, profiles, and inferences", (t) => {
  const dirs = directories(t);
  writeSite(dirs.sourceDir);
  fs.mkdirSync(path.join(dirs.sourceDir, "collector"));
  for (const name of ["latest.snapshot.json", "latest.diff.json", "latest.client-review.json"]) {
    fs.writeFileSync(path.join(dirs.sourceDir, "collector", name), JSON.stringify({ internal: "INTERNAL_OBSERVATION_MARKER" }));
  }
  fs.writeFileSync(path.join(dirs.sourceDir, "public-history.json"), "INTERNAL_OBSERVATION_MARKER");
  fs.writeFileSync(path.join(dirs.sourceDir, "unknown.html"), "INTERNAL_OBSERVATION_MARKER");
  preparePublicArtifact(dirs);
  assert.deepEqual(fs.readdirSync(dirs.outputDir).sort(), [".nojekyll", "index.html", "latest.json", "latest.md"]);
  for (const name of fs.readdirSync(dirs.outputDir)) {
    assert.doesNotMatch(fs.readFileSync(path.join(dirs.outputDir, name), "utf8"), /INTERNAL_OBSERVATION_MARKER/);
  }
});

test("public summary recursively drops new employer and inference fields from allowed JSON files", (t) => {
  const dirs = directories(t), data = summary();
  const marker = { profileId: "fixture-employer", inferences: ["INTERNAL_REVIEW_MARKER"] };
  data.clientReview = marker;
  data.candidateIds = ["INTERNAL_REVIEW_MARKER"];
  data.attempts[0].observedIds = ["INTERNAL_REVIEW_MARKER"];
  data.recommendation.publicClient = marker;
  data.recommendation.clientReview = marker;
  data.recommendation.analysis.inferences = marker;
  data.recommendation.analysis.matchedSkills.push(marker);
  data.recommendation.selectionReasons.push(marker);
  writeSite(dirs.sourceDir, data);
  fs.mkdirSync(path.join(dirs.sourceDir, "archive"));
  fs.writeFileSync(path.join(dirs.sourceDir, "archive", "2026-10-10.json"), JSON.stringify(data));
  preparePublicArtifact(dirs);
  for (const relative of ["latest.json", "archive/2026-10-10.json"]) {
    assert.deepEqual(json(dirs.outputDir, relative), summary());
    assert.doesNotMatch(fs.readFileSync(path.join(dirs.outputDir, relative), "utf8"), /INTERNAL_REVIEW_MARKER|fixture-employer/);
  }
  assert.match(fs.readFileSync(path.join(dirs.sourceDir, "latest.json"), "utf8"), /INTERNAL_REVIEW_MARKER/);
});

test("unknown summary counts remain null and confirmed empty counts remain zero", (t) => {
  const dirs = directories(t), data = summary();
  data.totalJobs = null;
  data.safeCandidates = null;
  data.recommendation = null;
  data.attempts = [{ keyword: "CSV", ok: false, status: 403, imported: null, error: "fetch_failed" }];
  writeSite(dirs.sourceDir, data);
  fs.mkdirSync(path.join(dirs.sourceDir, "archive"));
  const empty = { ...data, totalJobs: 0, safeCandidates: 0,
    attempts: [{ keyword: "CSV", ok: true, status: 200, imported: 0 }] };
  fs.writeFileSync(path.join(dirs.sourceDir, "archive", "2026-10-10.json"), JSON.stringify(empty));
  preparePublicArtifact(dirs);
  assert.equal(json(dirs.outputDir, "latest.json").totalJobs, null);
  assert.equal(json(dirs.outputDir, "latest.json").safeCandidates, null);
  assert.equal(json(dirs.outputDir, "latest.json").attempts[0].imported, null);
  assert.equal(json(dirs.outputDir, "archive/2026-10-10.json").totalJobs, 0);
  assert.equal(json(dirs.outputDir, "archive/2026-10-10.json").safeCandidates, 0);
});

test("archive allowlist excludes other names, invalid dates, and nested observations", (t) => {
  const dirs = directories(t);
  writeSite(dirs.sourceDir);
  const archive = path.join(dirs.sourceDir, "archive");
  fs.mkdirSync(archive);
  for (const name of ["latest.snapshot.json", "2026-10-11.client-review.json", "2026-02-30.json", "2026-13-01.json", "2026-1-1.json"]) {
    fs.writeFileSync(path.join(archive, name), "INTERNAL_ARCHIVE_MARKER");
  }
  fs.mkdirSync(path.join(archive, "internal"));
  fs.writeFileSync(path.join(archive, "internal", "2026-10-11.json"), "INTERNAL_ARCHIVE_MARKER");
  fs.writeFileSync(path.join(archive, "2026-10-11.json"), JSON.stringify(summary()));
  preparePublicArtifact(dirs);
  assert.deepEqual(fs.readdirSync(path.join(dirs.outputDir, "archive")), ["2026-10-11.json"]);
});

test("overlapping source and staging paths are rejected without deleting input", (t) => {
  const dirs = directories(t);
  writeSite(dirs.sourceDir);
  for (const outputDir of [dirs.sourceDir, path.join(dirs.sourceDir, "public"), dirs.root]) {
    assert.throws(() => preparePublicArtifact({ sourceDir: dirs.sourceDir, outputDir }), /public_artifact_paths_overlap/);
  }
  assert.deepEqual(json(dirs.sourceDir, "latest.json"), summary());
});

test("nonempty staging cannot carry stale internal evidence into publication", (t) => {
  const dirs = directories(t);
  writeSite(dirs.sourceDir);
  fs.mkdirSync(dirs.outputDir);
  fs.writeFileSync(path.join(dirs.outputDir, "latest.client-review.json"), "INTERNAL_STALE_MARKER");
  assert.throws(() => preparePublicArtifact(dirs), /public_artifact_output_must_be_empty/);
  assert.equal(fs.readFileSync(path.join(dirs.outputDir, "latest.client-review.json"), "utf8"), "INTERNAL_STALE_MARKER");
});

test("malformed or non-summary JSON prevents preparation before writing output", (t) => {
  const dirs = directories(t);
  writeSite(dirs.sourceDir);
  for (const content of ["{bad json}", JSON.stringify({ clientReview: "INTERNAL_ONLY_MARKER" })]) {
    fs.writeFileSync(path.join(dirs.sourceDir, "latest.json"), content);
    assert.throws(() => preparePublicArtifact(dirs), /invalid_public_summary/);
    assert.equal(fs.existsSync(dirs.outputDir), false);
  }
});

test("allowed filenames cannot read through symlinks", (t) => {
  const dirs = directories(t);
  writeSite(dirs.sourceDir);
  const internal = path.join(dirs.root, "internal.json");
  fs.writeFileSync(internal, JSON.stringify(summary()));
  fs.unlinkSync(path.join(dirs.sourceDir, "latest.json"));
  try { fs.symlinkSync(internal, path.join(dirs.sourceDir, "latest.json"), "file"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) return t.skip("Symlink creation is unavailable in this environment");
    throw error;
  }
  assert.throws(() => preparePublicArtifact(dirs), /invalid_public_artifact_file/);
  assert.equal(fs.existsSync(dirs.outputDir), false);
});

test("synthetic symlink metadata rejects selected files even when symlink creation is unavailable", (t) => {
  const dirs = directories(t);
  writeSite(dirs.sourceDir);
  const target = path.join(dirs.sourceDir, "latest.json"), original = fs.lstatSync;
  fs.lstatSync = (file, ...args) => path.resolve(file) === target
    ? { isSymbolicLink: () => true, isFile: () => true }
    : original(file, ...args);
  try { assert.throws(() => preparePublicArtifact(dirs), /invalid_public_artifact_file/); }
  finally { fs.lstatSync = original; }
  assert.equal(fs.existsSync(dirs.outputDir), false);
});

test("offline public-artifact CLI uses the same allowlist", (t) => {
  const dirs = directories(t);
  writeSite(dirs.sourceDir);
  fs.writeFileSync(path.join(dirs.sourceDir, "latest.client-review.json"), "INTERNAL_CLI_MARKER");
  const output = execFileSync(process.execPath,
    [path.join(__dirname, "..", "src", "prepare-public-artifact.js"),
      "--source", dirs.sourceDir, "--output", dirs.outputDir], { encoding: "utf8" });
  assert.equal(JSON.parse(output).status, "public_artifact_prepared");
  assert.equal(fs.existsSync(path.join(dirs.outputDir, "latest.client-review.json")), false);
});
