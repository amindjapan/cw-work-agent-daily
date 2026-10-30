"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { projectWorkflowObservation, selectLatestWorkflowObservation } = require("../src/workflow-observation");
const { projectPublicPatrol } = require("../src/public-patrol-import");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");
const daily = read(".github/workflows/daily.yml");
const status = read(".github/workflows/collector-status-view.yml");
const steps = (text) => text.split(/^      - name: /m).slice(1).map((step) => ({ name: step.split("\n")[0], text: step }));
const named = (text, name) => steps(text).find((step) => step.name === name).text;

test("connection: daily collection, snapshot, gate and schedule prefix stays unchanged", () => {
  const prefix = daily.slice(0, daily.indexOf("      - name: Prepare public files"));
  assert.equal(crypto.createHash("sha256").update(prefix).digest("hex"),
    "8982ab9f08c5dd48d00a2a91cb931138464427f93abb0ee33f937122c9fa2a02");
  assert.equal((daily.match(/npm run daily/g) || []).length, 1);
  assert.doesNotMatch(daily, /\balways\(\)|continue-on-error|pull_request_target/);
});

test("connection: status view is manual main only, without collection or repository writes", () => {
  assert.equal(status.slice(status.indexOf("on:\n"), status.indexOf("\npermissions:")), "on:\n  workflow_dispatch:\n");
  assert.match(status, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(status, /contents: read\n  pages: write\n  id-token: write/);
  assert.match(status, /ref: \$\{\{ github\.sha \}\}\n          persist-credentials: false/);
  assert.match(status, /node-version: 22/);
  assert.doesNotMatch(status, /schedule:|pull_request:|push:|pull_request_target|secrets\.|npm run daily|src\/(?:daily|scraper)\.js|git (?:push|commit|config)|curl |wget |gh |actions\/github-script|\balways\(\)|continue-on-error/);
  assert.deepEqual([...status.matchAll(/uses: (.*)/g)].map((match) => match[1]), [
    "actions/checkout@v4", "actions/setup-node@v4", "actions/configure-pages@v5",
    "actions/upload-pages-artifact@v3", "actions/deploy-pages@v4"
  ]);
});

test("connection: both publishers verify preservation and build through the same strict projector", () => {
  for (const workflow of [daily, status]) {
    assert.match(workflow, /group: pages\n  cancel-in-progress: false/);
    const gate = workflow.indexOf("node src/verify-preserved-site.js");
    const build = workflow.indexOf("node src/build-collector-site.js");
    const project = workflow.indexOf("node src/prepare-public-artifact.js");
    const upload = workflow.indexOf("uses: actions/upload-pages-artifact@v3");
    const deploy = workflow.indexOf("uses: actions/deploy-pages@v4");
    assert.ok(gate > 0 && gate < build && build < project && project < upload && upload < deploy);
    assert.match(workflow, /--directory collector-preservation\/current --manifest collector-preservation\/manifest\.json/);
    assert.match(workflow, /--archives collector-data --observations collector-status\/attempts --patrol public-patrol\/latest\.json/);
    assert.match(workflow, /--source "\$RUNNER_TEMP\/cw-site-source" --output "\$RUNNER_TEMP\/cw-public-artifact" --overview/);
    assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/cw-public-artifact/);
    const retention = workflow.indexOf('--published-directory "$RUNNER_TEMP/cw-public-artifact"');
    assert.ok(project < retention && retention < upload);
    assert.doesNotMatch(workflow.slice(gate), /\balways\(\)|continue-on-error/);
  }
  assert.match(daily, /--summary site\/latest\.json/);
  assert.match(status, /--summary collector-data\/latest\.json/);
  assert.match(daily, /--published-directory "\$RUNNER_TEMP\/cw-public-artifact" --mode daily/);
  assert.match(status, /--published-directory "\$RUNNER_TEMP\/cw-public-artifact" --mode status-only/);
});

test("connection: stale source is checked before build and again immediately before deploy", () => {
  for (const workflow of [daily, status]) {
    assert.equal((workflow.match(/EXPECTED_SOURCE="\$\(git rev-parse HEAD\)"/g) || []).length, 2);
    assert.equal((workflow.match(/REMOTE_SOURCE="\$\(git ls-remote origin refs\/heads\/main \| cut -f1\)"/g) || []).length, 2);
    assert.equal((workflow.match(/test "\$EXPECTED_SOURCE" = "\$REMOTE_SOURCE"/g) || []).length, 2);
    const step = named(workflow, "Recheck source before publication");
    assert.match(step, /set -euo pipefail/);
    const all = steps(workflow);
    assert.equal(all.at(-2).name, "Recheck source before publication");
    assert.equal(all.at(-1).name, "Deploy Pages");
    assert.ok(workflow.indexOf("test \"$EXPECTED_SOURCE\" = \"$REMOTE_SOURCE\"") < workflow.indexOf("node src/build-collector-site.js"));
  }
});

test("connection: approved observations keep source, stopped counts and unknown collector clocks", () => {
  const files = ["40820005840-1.json", "40989042359-1.json"];
  const observations = files.map((file) => projectWorkflowObservation(JSON.parse(read(`collector-status/attempts/${file}`))));
  for (const record of observations) {
    assert.equal(record.sourceCommit, "b6cad17aeac34681e94114d8b25df2e44e4908f8");
    assert.equal(record.collectorStartedAt, null);
    assert.equal(record.collectorFinishedAt, null);
    assert.equal(record.diagnostics.aborted, true);
    assert.deepEqual(record.stepResults, { tests: "SUCCEEDED", collection: "FAILED", snapshot: "SKIPPED", repositoryPersistence: "SKIPPED", publication: "SKIPPED" });
  }
  assert.equal(observations[0].diagnostics.search.succeeded, 13);
  assert.equal(observations[0].diagnostics.details.attempted, 23);
  assert.equal(observations[0].diagnostics.details.succeeded, 4);
  assert.equal(observations[1].diagnostics.search.attempted, 1);
  assert.equal(observations[1].diagnostics.search.notAttempted, 12);
  const result = selectLatestWorkflowObservation([...observations].reverse());
  assert.equal(result.status, "AVAILABLE");
  assert.equal(result.observation.runId, "40989042359");
});

test("connection: disconnected public patrol stays unavailable instead of zero or inferred history", () => {
  const input = JSON.parse(read("public-patrol/latest.json"));
  const projected = projectPublicPatrol(input);
  assert.equal(projected.availability, "UNAVAILABLE");
  assert.deepEqual(projected, input);
  assert.doesNotMatch(JSON.stringify(projected), /Return|C:\\\\|Sentinel_|applicationHistory|holdHistory/);
});
