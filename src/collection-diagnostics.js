"use strict";

// Only fixed codes and numeric counters cross the CLI log boundary. Never copy
// an adapter response, exception, URL, query, identifier or page text into it.
const STOP_REASONS = new Set(["access_denied", "authentication_required", "rate_limited",
  "captcha_required", "access_congestion", "protection_warning"]);
const REASONS = new Set([...STOP_REASONS, "success", "http_failed", "network_failed",
  "extraction_failed", "unsupported_response", "not_attempted", "collector_failed"]);

function httpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function stopReason(value) {
  return STOP_REASONS.has(value) ? value : null;
}

function diagnosticEvent(stage, status, reason) {
  return { stage: stage === "search" || stage === "detail" ? stage : "collector",
    httpStatus: httpStatus(status), reason: REASONS.has(reason) ? reason : "collector_failed" };
}

function counts(attempts, total, totalKey) {
  const attempted = attempts.filter((attempt) => attempt.outcome !== "not_attempted").length;
  const succeeded = attempts.filter((attempt) => attempt.ok === true).length;
  return { [totalKey]: total, attempted, succeeded, failed: attempted - succeeded, notAttempted: total - attempted };
}

function collectionDiagnostics({ aborted, events, search, details, planned, observed }) {
  return { kind: "collector_diagnostics", schemaVersion: 1, aborted: aborted === true,
    search: counts(search, planned, "planned"), details: counts(details, observed, "observed"),
    events: events.map((event) => diagnosticEvent(event.stage, event.httpStatus, event.reason)) };
}

class CollectionAbortedError extends Error {
  constructor(diagnostics) {
    super("collector_access_aborted");
    this.name = "CollectionAbortedError";
    this.diagnostics = diagnostics;
  }
}

module.exports = { CollectionAbortedError, collectionDiagnostics, diagnosticEvent, httpStatus, stopReason };
