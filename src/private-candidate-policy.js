"use strict";

// Approved 2026-10-13. Explicit opt-in is still required; these do not activate storage.
const APPROVED_POLICY = Object.freeze({
  maxCandidates: 100,
  maxRuns: 60,
  maxTotalBytes: 5 * 1024 * 1024,
  retentionDays: 30
});

module.exports = { APPROVED_POLICY };
