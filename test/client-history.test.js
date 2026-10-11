"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { reviewClientHistories, sanitizeClientHistoryReview, HISTORY_STATUSES } = require("../src/client-history");
const { normalizePublicJobRef, normalizePublicProfileRef, normalizePublicTimestamp } = require("../src/public-evidence");

const TIME = "2026-10-11T01:02:00.000Z";
const LATER = "2026-10-11T01:05:00.000Z";
const PROFILE = { platform: "crowdworks", profileId: "123", profileUrl: "https://crowdworks.jp/public/employers/123" };
function job(id, extra = {}) {
  return { platform: "crowdworks", profileId: "123", jobId: String(id), url: `https://crowdworks.jp/public/jobs/${id}`,
    visibility: "public", phase: "past", observedAt: TIME,
    deliverableTags: ["article"], purposeTags: ["information"], targetServiceTags: ["business_system"], ...extra };
}
function history(extra = {}) {
  return { ...PROFILE, status: "fetched", observedAt: TIME,
    coverage: { pastJobs: true, currentJobs: true, publicRatings: true }, jobs: [job(1)], ...extra };
}
function officialRelationship(extra = {}) {
  return { platform: "crowdworks", profileId: "456", profileUrl: "https://crowdworks.jp/public/employers/456",
    relationshipType: "officially_declared_related_account", evidence: { platform: "crowdworks", declarerProfileId: "123",
      url: PROFILE.profileUrl, visibility: "public", kind: "official_relationship_statement", official: true, observedAt: TIME }, ...extra };
}
function profileOf(value) { return value.profiles[0]; }

test("public job/profile references require exact hosts, paths and explicit IDs", () => {
  assert.deepEqual(normalizePublicJobRef({ platform: "crowdworks", id: 1, url: "https://crowdworks.jp/public/jobs/1?token=SECRET#contact" }),
    { platform: "crowdworks", jobId: "1", url: "https://crowdworks.jp/public/jobs/1" });
  assert.equal(normalizePublicProfileRef({ platform: "crowdworks", profileId: "123", url: PROFILE.profileUrl }).profileId, "123");
  for (const url of ["http://crowdworks.jp/public/jobs/1", "https://crowdworks.jp.evil/public/jobs/1",
    "https://u:SECRET@crowdworks.jp/public/jobs/1", "https://crowdworks.jp:443/public/jobs/1",
    "https://www.crowdworks.jp/public/jobs/1", "https://crowdworks.jp/public/jobs/2", "https://crowdworks.jp/public/jobs/%31",
    "https://crowdworks.jp/x/../public/jobs/1", "https://crowdworks.jp\\public\\jobs\\1", " https://crowdworks.jp/public/jobs/1"]) {
    assert.equal(normalizePublicJobRef({ platform: "crowdworks", jobId: "1", url }), null, url);
  }
  assert.equal(normalizePublicProfileRef({ platform: "crowdworks", profileId: "123", url: "https://crowdworks.jp/public/users/123" }), null);
  assert.equal(normalizePublicJobRef({ platform: "lancers", jobId: "1", url: "https://www.lancers.jp/work/detail/1" }).jobId, "1");
  assert.equal(normalizePublicProfileRef({ platform: "lancers", profileId: "business_account", url: "https://www.lancers.jp/profile/business_account" }).profileId, "business_account");
  assert.equal(normalizePublicProfileRef({ platform: "lancers", profileId: "business_account", url: "https://www.lancers.jp/profile/other_account" }), null);
});

test("timestamps preserve genuine dates and reject overflow or arbitrary text", () => {
  assert.equal(normalizePublicTimestamp("2026-10-11T10:02:00+09:00"), TIME);
  for (const value of ["2026-02-30T00:00:00Z", "2026-10-11", "contact SECRET", "2026-10-11T00:00:00+25:00", "2026-10-11T00:00:00Z SECRET"]) assert.equal(normalizePublicTimestamp(value), null);
});

test("same explicit public profile combines current and past business evidence into grounded questions", () => {
  const output = reviewClientHistories([history({ jobs: [job(1, { purposeTags: ["marketing"], targetServiceTags: ["google_maps"] }),
    job(2, { phase: "current", deliverableTags: ["review"], purposeTags: ["review_publication"], targetServiceTags: ["google_maps"] })] })]);
  const profile = profileOf(output);
  assert.equal(profile.reviewStatus, "safety_review_required");
  assert.equal(profile.inferences[0].code, "combined_review_activity");
  assert.deepEqual(profile.inferences[0].jobRefs.map((ref) => ref.jobId), ["1", "2"]);
  assert.equal(profile.inferences[0].scope, "same_explicit_profile");
  assert.equal(profile.questions[0].conclusion, "human_confirmation_needed");
  assert.equal(profile.facts.jobs.length, 2);
  assert.deepEqual(profile.thirdPartyAssessments, []);
  assert.equal("illegal" in profile, false);
  assert.equal("safe" in profile, false);
});

test("account and automation requests require human ownership and scope confirmation", () => {
  const profile = profileOf(reviewClientHistories([history({ jobs: [job(1, { deliverableTags: ["account"], purposeTags: ["account_operation"], targetServiceTags: ["social_platform"] }),
    job(2, { deliverableTags: ["automation"], purposeTags: ["data_processing"], targetServiceTags: ["social_platform"] })] })]));
  assert.ok(profile.questions.some((question) => question.code === "combined_account_activity"));
});

test("timeline comparison requires supplied dates and preserves explicit overlap evidence", () => {
  const timed = { publishedAt: "2026-10-01T00:00:00Z", deadlineAt: "2026-10-20T00:00:00Z" };
  const profile = profileOf(reviewClientHistories([history({ jobs: [job(1, timed), job(2, { ...timed, phase: "current" })] })]));
  assert.equal(profile.inferences[0].code, "overlapping_similar_requests");
  assert.equal(profile.inferences[0].timelineCompared, true);
  assert.equal(profileOf(reviewClientHistories([history({ jobs: [job(1), job(2)] })])).questions.length, 0);
  assert.equal(profileOf(reviewClientHistories([history({ jobs: [job(1, timed), job(2, { publishedAt: "2026-10-21T00:00:00Z", deadlineAt: "2026-10-30T00:00:00Z" })] })])).questions.length, 0);
});

test("purpose changes for similar deliverables are separated from factual fields", () => {
  const profile = profileOf(reviewClientHistories([history({ jobs: [job(1), job(2, { purposeTags: ["ranking_influence"] })] })]));
  assert.ok(profile.inferences.some((item) => item.code === "purpose_change_across_requests"));
  assert.deepEqual(profile.facts.jobs[0].purposeTags, ["information"]);
  assert.equal("conclusion" in profile.facts.jobs[0], false);
});

test("different platforms, profile IDs and unspecified target service do not create links", () => {
  const input = [history({ jobs: [job(1, { deliverableTags: ["review"], purposeTags: ["review_publication"] })] }),
    history({ profileId: "456", profileUrl: "https://crowdworks.jp/public/employers/456",
      jobs: [job(2, { profileId: "456", purposeTags: ["marketing"] })] })];
  const output = reviewClientHistories(input);
  assert.ok(output.profiles.every((profile) => !profile.questions.length));
  const unknown = profileOf(reviewClientHistories([history({ jobs: [job(1, { deliverableTags: ["review"], purposeTags: ["review_publication"], targetServiceTags: ["other_service"] }),
    job(2, { purposeTags: ["marketing"], targetServiceTags: ["other_service"] })] })]));
  assert.equal(unknown.questions.length, 0);
});

test("public third-party ratings remain assessments with source refs and no reviewer identity", () => {
  const profile = profileOf(reviewClientHistories([history({ publicRatings: [{ platform: "crowdworks", profileId: "123",
    visibility: "public", url: PROFILE.profileUrl, observedAt: TIME, score: 1.5, sentiment: "negative", assessmentCodes: ["scope_change"],
    reviewerName: "SECRET REVIEWER", comment: "SECRET CONTACT" }] })]));
  assert.equal(profile.thirdPartyAssessments[0].score, 1.5);
  assert.equal(profile.inferences[0].code, "public_rating_concern");
  assert.equal(profile.inferences[0].assessmentRefs[0].url, PROFILE.profileUrl);
  assert.equal("ratings" in profile.facts, false);
  assert.doesNotMatch(JSON.stringify(profile), /SECRET/);
});

test("official related accounts retain public statement evidence without identity merging", () => {
  const input = [history({ jobs: [job(1, { deliverableTags: ["review"], purposeTags: ["review_publication"] })], relatedAccounts: [officialRelationship()] }),
    history({ profileId: "456", profileUrl: "https://crowdworks.jp/public/employers/456", jobs: [job(2, { profileId: "456", purposeTags: ["marketing"] })] })];
  const output = reviewClientHistories(input);
  const relation = profileOf(output).facts.officialRelationships[0];
  assert.equal(relation.identityConclusion, "not_inferred");
  assert.equal(relation.evidence.verification, "caller_supplied_public_statement");
  assert.ok(output.profiles.every((profile) => !profile.questions.length));
  assert.equal(output.profiles.length, 2);
});

test("no unsupported relation is inferred from names, similar work or user-claimed relationships", () => {
  const invalid = [officialRelationship({ evidence: { ...officialRelationship().evidence, official: false } }),
    officialRelationship({ evidence: { ...officialRelationship().evidence, visibility: "private" } }),
    officialRelationship({ evidence: { ...officialRelationship().evidence, kind: "similar_name" } }),
    officialRelationship({ evidence: { ...officialRelationship().evidence, declarerProfileId: "999", url: "https://crowdworks.jp/public/employers/999" } }),
    officialRelationship({ evidence: { ...officialRelationship().evidence, url: "https://example.org/official" } }),
    officialRelationship({ platform: "lancers", profileUrl: "https://www.lancers.jp/profile/456" }),
    officialRelationship({ evidence: { ...officialRelationship().evidence, platform: "lancers", url: "https://www.lancers.jp/profile/123" } })];
  const output = reviewClientHistories([history({ relatedAccounts: invalid, similarClientName: "SECRET" })]);
  assert.equal(profileOf(output).facts.officialRelationships.length, 0);
  assert.equal(output.rejectedRecords.relationships, invalid.length);
});

test("private jobs, mismatched ownership, missing IDs and unsafe URLs are rejected", () => {
  const output = reviewClientHistories([history({ jobs: [job(1, { visibility: "private" }), job(2, { profileId: "456" }),
    job(3, { platform: "lancers" }), job(4, { jobId: undefined }), job(5, { url: "https://crowdworks.jp.evil/public/jobs/5" }),
    job(6, { observedAt: undefined }), job(7, { publishedAt: "2026-10-20T00:00:00Z", deadlineAt: "2026-10-01T00:00:00Z" })] })]);
  assert.equal(profileOf(output).facts.jobs.length, 0);
  assert.equal(output.rejectedRecords.jobs, 7);
  assert.equal(profileOf(output).reviewStatus, "insufficient_evidence");
});

test("history acquisition states remain distinct and never grant safety assurance", () => {
  for (const status of HISTORY_STATUSES) {
    const output = reviewClientHistories([history({ status, jobs: [], coverage: { pastJobs: false, currentJobs: false, publicRatings: false } })]);
    assert.equal(profileOf(output).status, status);
    assert.equal(profileOf(output).reviewStatus, "insufficient_evidence");
    assert.equal(output.acquisition.automaticHistoryFetch, "not_connected");
    assert.equal(output.acquisition.accessPermission, "unverified");
    assert.equal("safe" in profileOf(output), false);
  }
  for (const status of ["no_public_history", "private", "fetch_failed", "not_connected"]) {
    const output = reviewClientHistories([history({ status })]);
    assert.equal(profileOf(output).facts.jobs.length, 0);
    assert.equal(output.rejectedRecords.jobs, 1);
  }
  assert.equal(profileOf(reviewClientHistories([history({ status: "unknown_status" })])).status, "not_connected");
});

test("repeated calls on the same day are deterministic and do not rely on the system clock", () => {
  const input = [history({ jobs: [job(1), job(2, { phase: "current", observedAt: LATER })] })];
  assert.deepEqual(reviewClientHistories(input), reviewClientHistories(input));
  assert.equal(profileOf(reviewClientHistories(input)).observedAt, TIME);
});

test("identical duplicate IDs are deduplicated without losing evidence", () => {
  const profile = profileOf(reviewClientHistories([history({ jobs: [job(1), job(1)] })]));
  assert.equal(profile.facts.jobs.length, 1);
  assert.ok(profile.issues.includes("duplicate_job_id_deduplicated"));
  assert.equal(profile.reviewStatus, "no_questions_from_supplied_evidence");
});

test("dated phase re-observations retain actual provenance without a business conflict", () => {
  const profile = profileOf(reviewClientHistories([history({ jobs: [job(1), job(1, { phase: "current", observedAt: LATER })] })]));
  assert.equal(profile.facts.jobs.length, 1);
  assert.equal(profile.facts.jobs[0].observations.length, 2);
  assert.ok(!profile.issues.includes("duplicate_job_id_conflict"));
});

test("contradictory business fields for one job ID are not arbitrarily resolved", () => {
  const output = reviewClientHistories([history({ jobs: [job(1), job(1, { purposeTags: ["ranking_influence"], observedAt: LATER })] })]);
  assert.equal(profileOf(output).facts.jobs.length, 0);
  assert.ok(profileOf(output).issues.includes("duplicate_job_id_conflict"));
  assert.equal(output.rejectedRecords.jobs, 2);
});

test("same job claimed by two profiles is not evidence of an account relationship", () => {
  const output = reviewClientHistories([history(), history({ profileId: "456", profileUrl: "https://crowdworks.jp/public/employers/456", jobs: [job(1, { profileId: "456" })] })]);
  assert.ok(output.profiles.every((profile) => !profile.facts.jobs.length && profile.issues.includes("conflicting_job_profile") && !profile.facts.officialRelationships.length));
});

test("job-specific public ratings cannot be reassigned contrary to acquired ownership evidence", () => {
  const rating = { platform: "crowdworks", profileId: "456", jobId: "1", url: "https://crowdworks.jp/public/jobs/1",
    visibility: "public", observedAt: TIME, score: 1, sentiment: "negative" };
  const output = reviewClientHistories([history(), history({ profileId: "456", profileUrl: "https://crowdworks.jp/public/employers/456",
    jobs: [], publicRatings: [rating] })]);
  const unrelated = output.profiles.find((profile) => profile.profileId === "456");
  assert.equal(unrelated.thirdPartyAssessments.length, 0);
  assert.equal(unrelated.questions.length, 0);
  assert.ok(unrelated.issues.includes("conflicting_rating_profile"));
  assert.equal(unrelated.reviewStatus, "insufficient_evidence");
  assert.equal(output.rejectedRecords.ratings, 1);
  const matched = profileOf(reviewClientHistories([history({ publicRatings: [{ ...rating, profileId: "123" }] })]));
  assert.equal(matched.thirdPartyAssessments.length, 1);
  assert.equal(matched.questions[0].code, "public_rating_concern");
});

test("current Collector evidence creates an explicitly unconnected profile without historical enrichment", () => {
  const output = reviewClientHistories([], { currentJobs: [{ ...job(1), ...PROFILE, deliverableTags: [], purposeTags: [], targetServiceTags: [] }] });
  const profile = profileOf(output);
  assert.equal(profile.status, "not_connected");
  assert.equal(profile.facts.jobs[0].phase, "current");
  assert.equal(profile.facts.currentJobRefs[0].jobId, "1");
  assert.equal(profile.reviewStatus, "insufficient_evidence");
  assert.ok(profile.issues.includes("business_dimensions_missing"));
  assert.deepEqual(profile.coverage, { pastJobs: false, currentJobs: false, publicRatings: false });
});

test("tagless current re-observation does not delete or redatestamp supplied history tags", () => {
  const output = reviewClientHistories([history()], { currentJobs: [{ ...job(1), ...PROFILE, observedAt: LATER,
    deliverableTags: [], purposeTags: [], targetServiceTags: [] }] });
  const profile = profileOf(output);
  assert.equal(profile.facts.jobs.length, 1);
  assert.equal(profile.facts.jobs[0].observedAt, TIME);
  assert.deepEqual(profile.facts.jobs[0].deliverableTags, ["article"]);
  assert.equal(profile.facts.currentJobRefs[0].observedAt, LATER);
  assert.ok(!profile.issues.includes("duplicate_job_id_conflict"));
});

test("current references require known explicit profile linkage and reject mismatching profile URLs", () => {
  const output = reviewClientHistories([history()], { currentJobs: [job(2), { ...job(3), ...PROFILE, profileUrl: "https://crowdworks.jp/public/employers/999" },
    { ...job(4), platform: "lancers", profileId: "123", profileUrl: "https://www.lancers.jp/profile/123" }] });
  assert.equal(profileOf(output).facts.currentJobRefs.length, 1);
  assert.equal(output.rejectedRecords.currentJobs, 2);
  assert.equal(output.profiles.length, 1);
});

test("only controlled business taxonomy survives free text, contact and secret injection", () => {
  const secret = "SECRET-PERSON-CONTACT-TOKEN";
  const output = reviewClientHistories([history({ personalName: secret, email: secret, credentials: { token: secret },
    jobs: [job(1, { title: secret, description: secret, budget: secret, personName: secret, account: secret,
      url: `https://crowdworks.jp/public/jobs/1?token=${secret}`, deliverableTags: ["article", `article by ${secret}`],
      purposeTags: [secret], targetServiceTags: ["business_system", secret], extra: { phone: secret } })] })]);
  assert.doesNotMatch(JSON.stringify(output), /SECRET/);
  assert.deepEqual(profileOf(output).facts.jobs[0].deliverableTags, ["article"]);
  assert.deepEqual(profileOf(output).facts.jobs[0].purposeTags, []);
  assert.equal(profileOf(output).reviewStatus, "insufficient_evidence");
});

test("stored review sanitization rebuilds questions and strips arbitrary derived fields", () => {
  const review = reviewClientHistories([history({ jobs: [job(1, { deliverableTags: ["review"], purposeTags: ["review_publication"] }), job(2, { purposeTags: ["marketing"] })] })]);
  review.personalInfo = "SECRET";
  review.profiles[0].questions[0].question = "SECRET";
  review.profiles[0].inferences.push({ code: "evil", text: "SECRET" });
  review.profiles[0].facts.jobs[0].description = "SECRET";
  review.profiles[0].issues.push("SECRET");
  const stored = sanitizeClientHistoryReview(review);
  assert.doesNotMatch(JSON.stringify(stored), /SECRET|evil/);
  assert.equal(profileOf(stored).reviewStatus, "safety_review_required");
  assert.equal(profileOf(stored).questions[0].code, "combined_review_activity");
});

test("stored unconnected current facts and historical provenance remain present after sanitization", () => {
  const current = reviewClientHistories([], { currentJobs: [{ ...job(1), ...PROFILE }] });
  const stored = sanitizeClientHistoryReview(current);
  assert.deepEqual(stored, current);
  assert.equal(profileOf(stored).status, "not_connected");
  assert.equal(profileOf(stored).facts.currentJobRefs.length, 1);
  assert.deepEqual(profileOf(stored).facts.jobs[0].deliverableTags, ["article"]);
  const dated = reviewClientHistories([history({ jobs: [job(1), job(1, { phase: "current", observedAt: LATER })] })]);
  assert.equal(profileOf(sanitizeClientHistoryReview(dated)).facts.jobs[0].observations.length, 2);
});

test("missing input and incomplete business scope remain unreviewed rather than empty safety results", () => {
  assert.deepEqual(reviewClientHistories(null).profiles, []);
  const malformed = reviewClientHistories([null, 4, {}, { ...PROFILE, profileUrl: "https://evil.test/123" }]);
  assert.equal(malformed.rejectedRecords.histories, 4);
  const profile = profileOf(reviewClientHistories([history({ observedAt: undefined, jobs: [job(1, { deliverableTags: undefined })] })]));
  assert.equal(profile.reviewStatus, "insufficient_evidence");
  assert.ok(profile.issues.includes("missing_observed_at"));
  assert.ok(profile.issues.includes("business_dimensions_missing"));
  assert.deepEqual(sanitizeClientHistoryReview({ profiles: [] }).profiles, []);
});

test("review core performs no fetch and does not read or change applied-job tracking", () => {
  const previousFetch = global.fetch;
  let requests = 0;
  global.fetch = () => { requests++; throw new Error("network forbidden in fixture test"); };
  const applied = { appliedJobIds: ["1"] };
  try {
    const output = reviewClientHistories([history({ appliedJobIds: ["SECRET"] })], { ...applied });
    assert.equal(requests, 0);
    assert.equal("appliedJobIds" in output, false);
    assert.deepEqual(applied, { appliedJobIds: ["1"] });
  } finally { global.fetch = previousFetch; }
});
