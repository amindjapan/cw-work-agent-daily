"use strict";
const fs = require("node:fs");
const path = require("node:path");

function summarize(raw) {
  const diagnostics = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const value = JSON.parse(line);
      if (value.kind === "collector_diagnostics" && value.schemaVersion === 1) diagnostics.push(value);
    } catch {}
  }
  const d = diagnostics.length === 1 ? diagnostics[0] : null;
  const num = (value) => Number.isSafeInteger(value) && value >= 0 ? String(value) : "unknown";
  if (!d) return "### Collector diagnostics\n\nNo unique diagnostics record; collection status unknown.\n";
  const knownStop = new Set(["authentication_required", "access_denied", "rate_limited", "captcha_required", "access_congestion", "protection_warning"]);
  const stops = Array.isArray(d.events) ? d.events.filter(e => knownStop.has(e?.reason)) : [];
  const lines = [
    "### Collector diagnostics",
    "",
    d.aborted === true ? "Collection stopped; remaining requests were not attempted." :
      d.aborted === false ? "Collection did not signal an access stop; see the workflow conclusion." :
      "Collection status unknown.",
    "",
    "| Stage | Succeeded | Failed | Not attempted |",
    "| --- | ---: | ---: | ---: |",
    ...[["Search",d.search],["Details",d.details]].map(([label, o]) =>
      `| ${label} | ${num(o?.succeeded)} | ${num(o?.failed)} | ${num(o?.notAttempted)} |`)
  ];
  for (const e of stops) {
    const stage = e.stage === "search" ? "search" : e.stage === "detail" ? "detail" : "unknown";
    lines.push("", `Stop: ${stage} / ${e.reason} (HTTP ${num(e.httpStatus)}).`);
  }
  return lines.join("\n") + "\n";
}

if (require.main === module) {
  const [capture, summary] = process.argv.slice(2);
  if (!capture || !summary || path.resolve(capture) === path.resolve(summary)) process.exit(2);
  const missing = !fs.existsSync(capture);
  const note = missing
    ? "### Collector diagnostics\n\nCollection capture missing; no retrieval result verified.\n"
    : summarize(fs.readFileSync(capture, "utf8"));
  fs.appendFileSync(summary, note, "utf8");
}
module.exports = { summarize };
