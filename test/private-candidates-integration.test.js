"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { runDaily } = require("../src/daily");
const { preparePublicArtifact } = require("../src/prepare-public-artifact");
const { verifyPrivateCandidateHandoff } = require("../src/verify-private-candidates");

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

// Model a local caller only inside this isolated synthetic test process.
const originalCi = { CI: process.env.CI, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS };
delete process.env.CI;
delete process.env.GITHUB_ACTIONS;
test.after(() => {
  for (const [key, value] of Object.entries(originalCi)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function ciEnvironment(t) {
  const previous = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previous;
  });
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cw-private-integration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const data = { searchResult: { job_offers: [101, 202].map((id) => ({
    job_offer: { id, title: "Python CSV データ整理", description_digest: "Python CSV 整理",
      category_id: 40, status: "released", expired_on: "2099-12-31" },
    payment: { fixed_price_payment: { min_budget: 10000 } }
  })) } };
  // Forbid accidental real fetches; all collection uses caller-supplied synthetic adapters.
  t.mock.method(global, "fetch", () => { throw new Error("unexpected_network_fetch"); });
  const opts = { outputDir: path.join(root, "site"), evidenceDir: path.join(root, "internal"),
    keywords: ["CSV"], now: new Date("2026-10-13T02:00:00Z"),
    clock: () => new Date("2026-10-13T02:00:02Z"),
    fetchSearchPage: async () => {
      calls++;
      return { ok: true, status: 200, url: "https://crowdworks.jp/public/jobs/search",
        html: `<div id="vue-container" data="${JSON.stringify(data).replace(/"/g, "&quot;")}"></div>` };
    },
    fetchJobDetail: async (job) => ({ ...job, detailCheckedAt: "2026-10-13T02:00:01Z",
      detailFetch: { ok: true, status: 200, outcome: "success" } }) };
  const privateOption = { enabled: true, outputDir: path.join(root, "private"), executionId: FIRST,
    extractedAt: "2026-10-13T02:00:02Z",
    policy: { maxCandidates: 100, maxRuns: 60, maxTotalBytes: 5 * 1024 * 1024, retentionDays: 30 } };
  return { root, opts, privateOption, calls: () => calls };
}

test("private retention reconciles every candidate and preserves legacy fields plus allowed aggregates", async (t) => {
  const { root, opts, privateOption } = setup(t);
  const report = await runDaily({ ...opts, privateCandidateStore: privateOption });
  const record = JSON.parse(fs.readFileSync(path.join(privateOption.outputDir, `${FIRST}.json`), "utf8"));
  assert.equal(report.safeCandidates, 2);
  assert.deepEqual(record.candidates.map((candidate) => candidate.id), ["101", "202"]);
  assert.equal(record.counts.summaryCandidateCount, report.safeCandidates);
  assert.equal(record.counts.listCount, 2);
  assert.equal(record.counts.reconciliation, "matched");
  assert.equal(record.extractedAt, "2026-10-13T02:00:02.000Z");
  assert.equal(record.summarySha256, crypto.createHash("sha256")
    .update(fs.readFileSync(path.join(opts.outputDir, "latest.json"))).digest("hex"));
  assert.deepEqual(Object.keys(report).sort(), ["generatedAt", "generatedAtJst", "keywords", "attempts",
    "totalJobs", "safeCandidates", "recommendation", "collection"].sort());
  const publicDir = path.join(root, "staging");
  preparePublicArtifact({ sourceDir: opts.outputDir, outputDir: publicDir });
  // Retained aggregates must not change the exact summary bytes authenticated by the private record.
  assert.deepEqual(fs.readFileSync(path.join(publicDir, "latest.json")),
    fs.readFileSync(path.join(opts.outputDir, "latest.json")));
  assert.equal(record.summarySha256, crypto.createHash("sha256")
    .update(fs.readFileSync(path.join(publicDir, "latest.json"))).digest("hex"));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(publicDir, "latest.json"))).collection, report.collection);
  const verification = verifyPrivateCandidateHandoff({
    recordBytes: fs.readFileSync(path.join(privateOption.outputDir, `${FIRST}.json`)),
    snapshotBytes: fs.readFileSync(path.join(opts.evidenceDir, "latest.snapshot.json")),
    summaryBytes: fs.readFileSync(path.join(publicDir, "latest.json")),
    now: "2026-10-13T02:00:03Z", expectedExecutionId: FIRST
  });
  assert.equal(verification.status, "verified");
  assert.equal(verification.collectionCompletion, report.collection.attemptsCompletedAt);
  assert.deepEqual(fs.readdirSync(publicDir).sort(), [".nojekyll", "index.html", "latest.json", "latest.md"]);
  for (const file of fs.readdirSync(publicDir)) {
    assert.doesNotMatch(fs.readFileSync(path.join(publicDir, file), "utf8"),
      /private_machine_candidates|recordSha256|snapshotSha256|executionId|"id": "202"|\/jobs\/202\b/);
  }
  assert.equal(record.assessment, "machine_extraction_only");
});

test("disabled retention follows the previous aggregate behavior even in CI", async (t) => {
  const { root, opts, privateOption } = setup(t);
  ciEnvironment(t);
  const report = await runDaily({ ...opts, privateCandidateStore: { ...privateOption, enabled: false } });
  assert.equal(report.totalJobs, 2);
  assert.equal(report.safeCandidates, 2);
  assert.equal(fs.existsSync(path.join(root, "private")), false);
});

test("enabled CI, invalid policy and a public destination stop before any retrieval", async (t) => {
  const { opts, privateOption, calls } = setup(t);
  await assert.rejects(runDaily({ ...opts, privateCandidateStore: { ...privateOption, policy: undefined } }),
    { code: "private_candidates_policy_required" });
  await assert.rejects(runDaily({ ...opts, privateCandidateStore: { ...privateOption, outputDir: opts.outputDir } }),
    { code: "private_candidates_unsafe_path" });
  for (const outputDir of [opts.evidenceDir, path.join(opts.evidenceDir, "candidate-runs"),
    path.join(opts.evidenceDir, "snapshots"), path.dirname(opts.evidenceDir)]) {
    await assert.rejects(runDaily({ ...opts, privateCandidateStore: { ...privateOption, outputDir } }),
      { code: "private_candidates_unsafe_path" });
  }
  ciEnvironment(t);
  await assert.rejects(runDaily({ ...opts, privateCandidateStore: privateOption }),
    { code: "private_candidates_ci_forbidden" });
  assert.equal(calls(), 0);
  assert.equal(fs.existsSync(opts.outputDir), false);
});

test("limit and storage failures preserve previous outputs and disabling retention restores aggregates", async (t) => {
  const { opts, privateOption } = setup(t);
  await runDaily({ ...opts, privateCandidateStore: privateOption });
  const publicFile = path.join(opts.outputDir, "latest.json");
  const internalFile = path.join(opts.evidenceDir, "latest.snapshot.json");
  const candidateFile = path.join(privateOption.outputDir, `${FIRST}.json`);
  const previous = [publicFile, internalFile, candidateFile].map((file) => fs.readFileSync(file));
  const later = { ...opts, now: new Date("2026-10-13T03:00:00Z"),
    clock: () => new Date("2026-10-13T03:00:02Z") };
  const nextStore = { ...privateOption, executionId: SECOND, extractedAt: "2026-10-13T03:00:02Z" };
  await assert.rejects(runDaily({ ...later, privateCandidateStore: { ...nextStore,
    policy: { ...privateOption.policy, maxCandidates: 1 } } }), { code: "private_candidates_candidate_limit" });
  const link = t.mock.method(fs, "linkSync", () => { throw new Error("token=private-fixture-secret path=private-person"); });
  await assert.rejects(runDaily({ ...later, privateCandidateStore: nextStore }),
    { code: "private_candidates_storage_failed", message: "private_candidates_storage_failed" });
  link.mock.restore();
  for (const [index, file] of [publicFile, internalFile, candidateFile].entries()) {
    assert.deepEqual(fs.readFileSync(file), previous[index]);
  }
  assert.deepEqual(fs.readdirSync(privateOption.outputDir), [`${FIRST}.json`]);
  const restored = await runDaily({ ...later, privateCandidateStore: { ...nextStore, enabled: false } });
  assert.equal(restored.safeCandidates, 2);
  assert.equal(restored.generatedAt, "2026-10-13T03:00:00.000Z");
  assert.deepEqual(fs.readFileSync(candidateFile), previous[2]);
});
