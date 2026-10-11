"use strict";

// Explicit, local structured public business evidence only. No network adapter.
const fs = require("node:fs");
const path = require("node:path");
const { reviewClientHistories } = require("./client-history");
const { writeJson } = require("./store");

function reviewFile(input, output) {
  const evidence = JSON.parse(fs.readFileSync(input, "utf8"));
  const histories = Array.isArray(evidence) ? evidence : evidence.histories;
  if (!Array.isArray(histories)) throw new Error("invalid_public_history_input");
  const report = reviewClientHistories(histories);
  writeJson(output, report);
  return report;
}

if (require.main === module) {
  const inputIndex = process.argv.indexOf("--input");
  const outputIndex = process.argv.indexOf("--output");
  if (inputIndex < 0 || outputIndex < 0 || !process.argv[inputIndex + 1] || !process.argv[outputIndex + 1]) {
    console.error("Usage: node src/review-public-history.js --input <public-evidence.json> --output <review.json>");
    process.exitCode = 1;
  } else {
    try {
      reviewFile(path.resolve(process.argv[inputIndex + 1]), path.resolve(process.argv[outputIndex + 1]));
      console.log("public_history_review_saved");
    } catch {
      console.error("public_history_review_failed");
      process.exitCode = 1;
    }
  }
}

module.exports = { reviewFile };
