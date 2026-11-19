"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { summarize } = require("../scripts/collector-log-summary.cjs");

const diagnostic = {
  kind: "collector_diagnostics", schemaVersion: 1, aborted: true,
  search: { succeeded: 13, failed: 0, notAttempted: 0 },
  details: { succeeded: 67, failed: 2, notAttempted: 497 },
  events: [{ stage: "detail", httpStatus: 200, reason: "authentication_required" }]
};
test("report blocked state and skipped details without retaining arbitrary fields", () => {
  const report = summarize(JSON.stringify({ ...diagnostic, url: "sensitive", events: [
    ...diagnostic.events, { stage: "<script>", httpStatus: "sensitive", reason: "arbitrary" }
  ] }));
  assert.match(report, /Collection stopped/);
  assert.match(report, /\| Search \| 13 \| 0 \| 0 \|/);
  assert.match(report, /\| Details \| 67 \| 2 \| 497 \|/);
  assert.match(report, /authentication_required \(HTTP 200\)/);
  assert.doesNotMatch(report, /sensitive|<script>|arbitrary/);
});
test("missing and conflicting diagnostics remain unknown", () => {
  assert.match(summarize(""), /status unknown/);
  assert.match(summarize([diagnostic, diagnostic].map(x => JSON.stringify(x)).join("\n")), /status unknown/);
});
test("a run without an access stop is not called a complete collection", () => {
  assert.match(summarize(JSON.stringify({ ...diagnostic, aborted: false })), /see the workflow conclusion/);
});
