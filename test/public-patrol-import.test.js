"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { importPublicPatrol, projectPublicPatrol, mergePublicPatrol, stableJson,
  PUBLIC_PATROL_LIMITS, PUBLIC_PATROL_CONDITIONS } = require("../src/public-patrol-import");

const START = "2026-10-30T01:00:00.000Z";
const OBSERVED = "2026-10-30T01:01:00.000Z";
const END = "2026-10-30T01:02:00.000Z";
const RUN = "11111111-1111-4111-8111-111111111111";
const NEXT_RUN = "22222222-2222-4222-8222-222222222222";
const SENTINEL = "SYNTHETIC_PRIVATE_VALUE@example.invalid";
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function fixture() {
  return { kind: "public_patrol", schemaVersion: 1,
    run: { patrolRunId: RUN, startedAt: START, attemptsCompletedAt: END, decisionAsOf: START, status: "COMPLETED" },
    scope: { declaredPlatforms: ["crowdworks"], unsupportedSources: [] },
    sources: [{ sourceId: 1, platform: "crowdworks", sourceKind: "PUBLIC_SEARCH", availability: "AVAILABLE",
      url: "https://crowdworks.jp/public/jobs/search", scopeId: `scope-${"a".repeat(64)}` }],
    entries: [{ platform: "crowdworks", jobId: "123", url: "https://crowdworks.jp/public/jobs/123",
      observations: [{ sourceId: 1, observedAt: OBSERVED, level: "SEARCH_SUMMARY" }] }] };
}

function rejects(value, code) {
  assert.throws(() => importPublicPatrol(value), (error) => {
    assert.equal(error.message, error.code);
    assert.match(error.code, /^public_patrol_[a-z_]+$/);
    if (code) assert.equal(error.code, `public_patrol_${code}`);
    assert.equal(error.message.includes(SENTINEL), false);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test("missing explicit input is UNAVAILABLE with unknown counts and no invented run", () => {
  for (const value of [undefined, null]) {
    const result = importPublicPatrol(value);
    assert.equal(result.availability, "UNAVAILABLE");
    assert.equal(result.run, null);
    assert.deepEqual(result.counts, { sources: null, observations: null, uniqueJobs: null, unsupportedSources: null });
    assert.deepEqual(result.entries, []);
    assert.deepEqual(projectPublicPatrol(result), result);
    assert.deepEqual(projectPublicPatrol(null), result);
  }
});

test("explicit public records preserve scope, sources and per-observation provenance", () => {
  const original = fixture(), before = clone(original);
  const result = importPublicPatrol(original);
  assert.equal(result.availability, "AVAILABLE");
  assert.equal(result.assessment, "PUBLIC_EVIDENCE_ONLY");
  assert.deepEqual(result.run, original.run);
  assert.deepEqual(result.scope, original.scope);
  assert.deepEqual(result.counts, { sources: 1, observations: 1, uniqueJobs: 1, unsupportedSources: 0 });
  const observation = result.entries[0].observations[0];
  assert.equal(observation.sourceId, 1);
  assert.equal(observation.observedAt, OBSERVED);
  assert.equal(observation.level, "SEARCH_SUMMARY");
  assert.equal(observation.fit.status, "UNKNOWN");
  assert.equal(observation.securityReview.status, "UNKNOWN");
  assert.equal(observation.decision, "STOP_REQUIRED");
  assert.deepEqual([...observation.unconfirmedConditions].sort(), [...PUBLIC_PATROL_CONDITIONS].sort());
  assert.equal(observation.evidence.kind, "CANONICAL_PUBLIC_OBSERVATION");
  assert.deepEqual(original, before);
});

test("canonical input hash covers the complete validated envelope and round-trips", () => {
  const result = importPublicPatrol(fixture());
  const { contentSha256, ...content } = result;
  assert.equal(contentSha256, hash(stableJson(content)));
  assert.deepEqual(importPublicPatrol(JSON.stringify(result)), result);
  assert.deepEqual(importPublicPatrol(Buffer.from(JSON.stringify(result), "utf8")), result);
  assert.deepEqual(projectPublicPatrol(result), result);
});

test("evidence hashes only the supplied canonical public observation, never absent HTML", () => {
  const result = importPublicPatrol(fixture());
  const entry = result.entries[0], observed = entry.observations[0];
  const { evidence, ...observation } = observed;
  const { observedCount, ...source } = result.sources[0];
  assert.equal(evidence.sha256, hash(stableJson({ reference: { platform: entry.platform, jobId: entry.jobId, url: entry.url }, source, observation })));
  const changed = clone(result);
  changed.entries[0].observations[0].evidence.sha256 = "b".repeat(64);
  rejects(changed, "evidence_mismatch");
  const rawHash = fixture();
  rawHash.entries[0].observations[0].htmlSha256 = hash("unavailable synthetic HTML");
  rejects(rawHash, "observation_invalid");
});

test("fit never grants permission and security assessment stays independent", () => {
  const input = fixture();
  Object.assign(input.entries[0].observations[0], {
    conditions: [{ code: "AI_PERMISSION", state: "SUPPORTED" }],
    fit: { status: "POTENTIAL_FIT", reasonCodes: ["public_requirements_match"] },
    securityReview: { status: "REVIEW_REQUIRED", reasonCodes: ["data_rights_unconfirmed"] }
  });
  const result = importPublicPatrol(input).entries[0].observations[0];
  assert.equal(result.fit.status, "POTENTIAL_FIT");
  assert.equal(result.securityReview.status, "REVIEW_REQUIRED");
  assert.equal(result.decision, "STOP_REQUIRED");
  assert.ok(!result.unconfirmedConditions.includes("AI_PERMISSION"));
  assert.ok(result.unconfirmedConditions.includes("COMPENSATION"));
  for (const status of ["APPROVED", "CLEAR", "SAFE"]) {
    const bad = fixture();
    bad.entries[0].observations[0].securityReview = { status, reasonCodes: ["security_not_reviewed"] };
    rejects(bad, "assessment_invalid");
  }
});

test("same canonical job is deduplicated for display while distinct observations remain", () => {
  const input = fixture();
  input.sources.push({ sourceId: 2, platform: "crowdworks", sourceKind: "PUBLIC_JOB_DETAIL", availability: "AVAILABLE",
    url: "https://crowdworks.jp/public/jobs/123", scopeId: `scope-${"b".repeat(64)}` });
  input.entries.push({ platform: "crowdworks", jobId: "123", url: "https://crowdworks.jp/public/jobs/123",
    observations: [{ sourceId: 2, observedAt: OBSERVED, level: "JOB_DETAIL",
      conditions: [{ code: "AI_PERMISSION", state: "CONTRADICTED" }] }] });
  input.entries[0].observations[0].conditions = [{ code: "AI_PERMISSION", state: "SUPPORTED" }];
  const result = importPublicPatrol(input);
  assert.equal(result.entries.length, 1);
  assert.equal(result.counts.uniqueJobs, 1);
  assert.equal(result.counts.observations, 2);
  assert.deepEqual(result.entries[0].observations.map((item) => item.sourceId), [1, 2]);
  assert.deepEqual(result.entries[0].observations.map((item) => item.conditions.find((condition) => condition.code === "AI_PERMISSION").state),
    ["SUPPORTED", "CONTRADICTED"]);
  assert.deepEqual(projectPublicPatrol(result), result);
});

test("exact duplicate observations are idempotent but changed conditions at the same origin conflict", () => {
  const input = fixture();
  input.entries.push(clone(input.entries[0]));
  const result = importPublicPatrol(input);
  assert.equal(result.counts.observations, 1);
  input.entries[1].observations[0].conditions = [{ code: "DATA_RIGHTS", state: "CONTRADICTED" }];
  rejects(input, "observation_conflict");
});

test("ID and canonical URL must agree with each other rather than just have the same count", () => {
  for (const extra of [{ jobId: "456" }, { url: "https://crowdworks.jp/public/jobs/456" },
    { jobId: 123 }, { url: "https://crowdworks.jp/public/jobs/123?secret=synthetic" },
    { url: "https://crowdworks.jp/public/jobs/123/" }, { url: "https://crowdworks.jp.evil.invalid/public/jobs/123" }]) {
    const input = fixture(); Object.assign(input.entries[0], extra); rejects(input, "reference_invalid");
  }
});

test("unsupported public platforms are declared without pretending that all patrols are CrowdWorks", () => {
  const input = fixture();
  input.sources.push({ sourceId: 2, platform: "lancers", sourceKind: "PUBLIC_PLATFORM", availability: "UNAVAILABLE" });
  input.scope = { declaredPlatforms: ["lancers", "crowdworks"], unsupportedSources: ["lancers"] };
  const result = importPublicPatrol(input);
  assert.equal(result.availability, "LIMITED");
  assert.deepEqual(result.scope.unsupportedSources, ["lancers"]);
  assert.equal(result.sources[1].observedCount, null);
  assert.ok(result.limitationCodes.includes("source_contract_unavailable"));
  assert.deepEqual(projectPublicPatrol(result), result);
  const onlyUnsupported = clone(input);
  onlyUnsupported.sources = [onlyUnsupported.sources[1]];
  onlyUnsupported.entries = [];
  onlyUnsupported.scope = { declaredPlatforms: ["lancers"], unsupportedSources: ["lancers"] };
  const unknown = importPublicPatrol(onlyUnsupported);
  assert.equal(unknown.availability, "UNAVAILABLE");
  assert.equal(unknown.counts.uniqueJobs, null);
  assert.equal(unknown.counts.observations, null);
  assert.equal(unknown.counts.unsupportedSources, 1);
});

test("unsupported platforms cannot carry arbitrary URLs, raw data or a success declaration", () => {
  for (const extra of [{ url: "https://example.invalid/private" }, { availability: "AVAILABLE" }, { sourceKind: "PUBLIC_SEARCH" },
    { notes: SENTINEL }, { fileId: SENTINEL }]) {
    const input = fixture();
    input.sources = [{ sourceId: 2, platform: "other_public", sourceKind: "PUBLIC_PLATFORM", availability: "UNAVAILABLE", ...extra }];
    input.entries = []; input.scope = { declaredPlatforms: ["other_public"], unsupportedSources: ["other_public"] };
    rejects(input);
  }
});

test("known zero is distinct from unavailable sources and partial or aborted runs", () => {
  const input = fixture(); input.entries = [];
  const zero = importPublicPatrol(input);
  assert.equal(zero.availability, "AVAILABLE");
  assert.equal(zero.counts.uniqueJobs, 0);
  const unavailable = clone(input); unavailable.sources[0].availability = "UNAVAILABLE";
  assert.equal(importPublicPatrol(unavailable).counts.uniqueJobs, null);
  for (const status of ["PARTIAL", "ABORTED", "FAILED"]) {
    const partial = fixture(); partial.run.status = status;
    const result = importPublicPatrol(partial);
    assert.equal(result.availability, "LIMITED");
    assert.ok(result.limitationCodes.includes(`run_${status.toLowerCase()}`));
    assert.equal(result.entries[0].observations[0].decision, "STOP_REQUIRED");
  }
});

test("sources and observation levels cannot be swapped or invented", () => {
  for (const mutate of [
    (f) => { f.entries[0].observations[0].sourceId = 2; },
    (f) => { f.entries[0].observations[0].level = "JOB_DETAIL"; },
    (f) => { f.sources[0].availability = "UNAVAILABLE"; },
    (f) => { f.sources[0].sourceKind = "PUBLIC_JOB_DETAIL"; f.sources[0].url = "https://crowdworks.jp/public/jobs/456"; },
    (f) => { f.sources.push(clone(f.sources[0])); }
  ]) { const input = fixture(); mutate(input); rejects(input); }
});

test("a detail source must contain its actual public observation, not a verified zero claim", () => {
  const input = fixture(); input.entries = [];
  input.sources[0].sourceKind = "PUBLIC_JOB_DETAIL"; input.sources[0].url = "https://crowdworks.jp/public/jobs/123";
  rejects(input, "source_observation_missing");
});

test("unknown fields at every public boundary reject private information rather than strip it", () => {
  const mutations = [
    (f) => { f.privateReturn = SENTINEL; }, (f) => { f.run.operator = SENTINEL; },
    (f) => { f.scope.notes = SENTINEL; }, (f) => { f.sources[0].driveFileId = SENTINEL; },
    (f) => { f.entries[0].title = SENTINEL; }, (f) => { f.entries[0].description = SENTINEL; },
    (f) => { f.entries[0].applicationStatus = "UNKNOWN"; }, (f) => { f.entries[0].hold = true; },
    (f) => { f.entries[0].observations[0].name = SENTINEL; },
    (f) => { f.entries[0].observations[0].conditions = [{ code: "AI_PERMISSION", state: "UNKNOWN", text: SENTINEL }]; },
    (f) => { f.entries[0].observations[0].fit = { status: "UNKNOWN", reasonCodes: [SENTINEL] }; }
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); rejects(input); }
});

test("timestamp fields require canonical real dates and observations stay inside the declared run", () => {
  for (const stamp of [null, false, 0, [], {}, "2026-02-30T01:00:00.000Z", "2026-10-30T01:00:00", "2026-10-30T10:00:00+09:00"]) {
    const input = fixture(); input.run.startedAt = stamp; rejects(input, "run_invalid");
  }
  for (const stamp of ["2026-10-30T00:59:59.000Z", "2026-10-30T01:02:00.001Z"]) {
    const input = fixture(); input.entries[0].observations[0].observedAt = stamp; rejects(input, "observation_invalid");
  }
  const invalid = fixture(); invalid.run.decisionAsOf = "2026-10-30T01:03:00.000Z"; rejects(invalid, "run_invalid");
});

test("arrays and other non-string values cannot pass identifier or scope hash checks", () => {
  for (const mutate of [(f) => { f.run.patrolRunId = [RUN]; },
    (f) => { f.sources[0].scopeId = [f.sources[0].scopeId]; }, (f) => { f.entries[0].jobId = ["123"]; }]) {
    const input = fixture(); mutate(input); rejects(input);
  }
});

test("caller-provided derived counts, scope, evidence and content hashes must agree", () => {
  const good = importPublicPatrol(fixture());
  for (const mutate of [(f) => { f.counts.uniqueJobs = 99; }, (f) => { f.sources[0].observedCount = 0; },
    (f) => { f.scope.declaredPlatforms = ["lancers"]; }, (f) => { f.availability = "UNAVAILABLE"; },
    (f) => { f.contentSha256 = "b".repeat(64); }, (f) => { f.limitationCodes = []; },
    (f) => { f.entries[0].observations[0].unconfirmedConditions = []; }]) {
    const input = clone(good); mutate(input); rejects(input);
  }
});

test("known observedCount fields accept only the correct typed count, never a hidden payload", () => {
  for (const value of [{ secret: SENTINEL }, [1], "1", false, null, -1, 1.5]) {
    const input = fixture(); input.sources[0].observedCount = value; rejects(input, "source_count_mismatch");
  }
  const valid = fixture(); valid.sources[0].observedCount = 1;
  assert.deepEqual(projectPublicPatrol(importPublicPatrol(valid)), importPublicPatrol(valid));
  const unavailable = fixture(); unavailable.entries = []; unavailable.sources[0].availability = "UNAVAILABLE";
  unavailable.sources[0].observedCount = 0; rejects(unavailable, "source_count_mismatch");
});

test("strict bytes reject malformed UTF-8, BOM and duplicate decoded JSON keys", () => {
  const text = JSON.stringify(fixture());
  rejects(Buffer.from([0xff, 0xfe])); rejects(`\ufeff${text}`);
  rejects(text.replace('"kind":"public_patrol"', '"kind":"private","\\u006bind":"public_patrol"'));
  rejects(text.replace('"jobId":"123"', '"jobId":"456","jobId":"123"'));
  const shared = Buffer.from(new SharedArrayBuffer(Buffer.byteLength(text)));
  shared.write(text); rejects(shared);
});

test("object accessors, custom prototypes and cycles are rejected without evaluating values", () => {
  let reads = 0;
  const input = fixture(); Object.defineProperty(input.entries[0], "title", { enumerable: true, get() { reads++; throw SENTINEL; } });
  rejects(input); assert.equal(reads, 0);
  rejects(Object.assign(Object.create({ privateValue: SENTINEL }), fixture()));
  const cycle = fixture(); cycle.entries[0].cycle = cycle; rejects(cycle);
  const toJSON = fixture(); toJSON.toJSON = () => { reads++; return fixture(); }; rejects(toJSON); assert.equal(reads, 0);
  const symbol = fixture(); symbol[Symbol("synthetic")] = SENTINEL; rejects(symbol);
});

test("Proxy traps and custom Buffer accessors cannot execute at the input boundary", () => {
  let reads = 0;
  const input = new Proxy(fixture(), { getOwnPropertyDescriptor() { reads++; throw SENTINEL; }, getPrototypeOf() { reads++; throw SENTINEL; } });
  rejects(input); assert.equal(reads, 0);
  const nested = fixture(); nested.run = new Proxy(nested.run, { ownKeys() { reads++; throw SENTINEL; } });
  rejects(nested); assert.equal(reads, 0);
  const buffer = Buffer.from(JSON.stringify(fixture()));
  Object.defineProperty(buffer, "buffer", { get() { reads++; throw SENTINEL; } });
  rejects(buffer); assert.equal(reads, 0);
});

test("import bounds reject oversized bytes, source lists and entry lists without truncation", () => {
  rejects(" ".repeat(PUBLIC_PATROL_LIMITS.maxBytes + 1), "input_invalid");
  const sources = fixture(); sources.sources = Array.from({ length: PUBLIC_PATROL_LIMITS.maxSources + 1 }, () => sources.sources[0]); rejects(sources, "input_limit");
  const entries = fixture(); entries.entries = Array.from({ length: PUBLIC_PATROL_LIMITS.maxEntries + 1 }, () => entries.entries[0]); rejects(entries, "input_limit");
});

test("normalization expansion is bounded and a large accepted result remains re-importable", () => {
  function withObservations(total) {
    const input = fixture();
    input.entries[0].observations = Array.from({ length: total }, (_, index) => ({ sourceId: 1,
      observedAt: new Date(Date.parse(START) + index + 1).toISOString(), level: "SEARCH_SUMMARY" }));
    return input;
  }
  const accepted = importPublicPatrol(withObservations(150));
  assert.equal(accepted.counts.observations, 150);
  assert.ok(Buffer.byteLength(JSON.stringify(accepted), "utf8") < PUBLIC_PATROL_LIMITS.maxBytes);
  assert.deepEqual(projectPublicPatrol(accepted), accepted);
  assert.deepEqual(importPublicPatrol(Buffer.from(JSON.stringify(accepted))), accepted);
  rejects(withObservations(300), "input_limit");
});

test("same run and canonical content are idempotent even after harmless object ordering changes", () => {
  const input = fixture(), current = importPublicPatrol(input);
  const differentlyOrdered = { entries: input.entries, sources: input.sources, scope: input.scope, run: input.run,
    schemaVersion: input.schemaVersion, kind: input.kind };
  assert.deepEqual(mergePublicPatrol(current, differentlyOrdered), current);
  const copy = mergePublicPatrol(current, current); copy.entries[0].url = "mutated";
  assert.notEqual(current.entries[0].url, copy.entries[0].url);
});

test("changed content or an invalid supplied hash cannot reuse a patrol run identity", () => {
  const input = fixture(), current = importPublicPatrol(input);
  input.entries[0].observations[0].conditions = [{ code: "AI_PERMISSION", state: "CONTRADICTED" }];
  assert.throws(() => mergePublicPatrol(current, input), { code: "public_patrol_run_identity_conflict" });
  const altered = clone(current); altered.contentSha256 = "b".repeat(64);
  assert.throws(() => mergePublicPatrol(current, altered), { code: "public_patrol_content_hash_mismatch" });
});

test("merge chooses a newer explicit decision, preserves late older input and rejects equal clocks", () => {
  const current = importPublicPatrol(fixture());
  const next = fixture(); next.run.patrolRunId = NEXT_RUN; next.run.decisionAsOf = OBSERVED;
  const newer = mergePublicPatrol(current, next);
  assert.equal(newer.run.patrolRunId, NEXT_RUN);
  assert.deepEqual(mergePublicPatrol(newer, current), newer);
  const equal = fixture(); equal.run.patrolRunId = NEXT_RUN;
  assert.throws(() => mergePublicPatrol(current, equal), { code: "public_patrol_run_time_conflict" });
  assert.deepEqual(mergePublicPatrol(current, null), current);
  assert.deepEqual(mergePublicPatrol(null, current), current);
});

test("the importer performs no filesystem, network, transport or implicit clock operation", () => {
  const input = fixture();
  const methods = ["readFileSync", "writeFileSync", "mkdirSync", "readdirSync", "openSync", "linkSync", "unlinkSync"];
  const originals = Object.fromEntries(methods.map((name) => [name, fs[name]]));
  const originalFetch = global.fetch, originalClock = Date.now;
  try {
    methods.forEach((name) => { fs[name] = () => { throw new Error("unexpected filesystem call"); }; });
    global.fetch = () => { throw new Error("unexpected network call"); };
    Date.now = () => { throw new Error("unexpected clock call"); };
    const result = importPublicPatrol(input);
    assert.deepEqual(projectPublicPatrol(result), result);
    assert.deepEqual(mergePublicPatrol(null, result), result);
  } finally {
    methods.forEach((name) => { fs[name] = originals[name]; }); global.fetch = originalFetch; Date.now = originalClock;
  }
});
