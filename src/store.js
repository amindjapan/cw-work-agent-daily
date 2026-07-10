"use strict";

const fs = require("fs");
const path = require("path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function upsertJobs(existing, incoming) {
  const map = new Map(existing.map((job) => [job.id, job]));
  for (const job of incoming) {
    map.set(job.id, { ...(map.get(job.id) || {}), ...job });
  }
  return [...map.values()].sort((a, b) => {
    const scoreA = a.analysis ? a.analysis.score : 0;
    const scoreB = b.analysis ? b.analysis.score : 0;
    return scoreB - scoreA;
  });
}

module.exports = {
  ensureDir,
  readJson,
  upsertJobs,
  writeJson
};
