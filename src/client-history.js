"use strict";

const { normalizePublicJobRef, normalizePublicProfileRef, normalizePublicTimestamp } = require("./public-evidence");

const HISTORY_STATUSES = Object.freeze(["fetched", "no_public_history", "private", "fetch_failed", "insufficient_scope", "not_connected"]);
const BUSINESS_TAGS = Object.freeze({
  deliverableTags: Object.freeze(["article", "review", "data", "account", "automation", "research", "design", "translation", "survey", "other_business"]),
  purposeTags: Object.freeze(["information", "marketing", "testing", "research", "data_processing", "review_publication", "ranking_influence", "account_operation", "contact_collection", "other_business"]),
  targetServiceTags: Object.freeze(["crowdworks", "lancers", "search_engine", "review_platform", "social_platform", "ecommerce", "business_system", "google_maps", "google_search", "amazon", "instagram", "facebook", "x", "youtube", "tiktok", "line", "other_service"])
});
const ASSESSMENT_CODES = Object.freeze(["delivery_quality", "communication", "deadline", "payment", "scope_change"]);
const QUESTIONS = Object.freeze({
  combined_review_activity: "Confirm how the combined deliverables will be used for public reviews or ranking, and whether the platform permits that use.",
  combined_account_activity: "Confirm account ownership, authorization, and the combined scope of account operations and automation.",
  overlapping_similar_requests: "Confirm whether these overlapping requests have distinct deliverables and authorized reuse.",
  purpose_change_across_requests: "Confirm why similar deliverables for the same service have different stated purposes.",
  public_rating_concern: "Check whether the public third-party assessment is relevant to the requested business scope."
});
const ISSUE_CODES = Object.freeze(["evidence_not_accepted_for_history_status", "missing_observed_at", "incomplete_public_scope",
  "duplicate_profile_records", "duplicate_job_id_conflict", "duplicate_job_id_deduplicated", "conflicting_job_profile", "conflicting_rating_profile", "business_dimensions_missing"]);

function list(value) { return Array.isArray(value) ? value : []; }
function uniqueSorted(value) { return [...new Set(value)].sort(); }
function tags(value, allowed) { return uniqueSorted(list(value).filter((tag) => typeof tag === "string" && allowed.includes(tag))); }
function coverageOf(value) {
  return { pastJobs: value?.pastJobs === true, currentJobs: value?.currentJobs === true, publicRatings: value?.publicRatings === true };
}
function emptyProfile(ref, status, observedAt, coverage) {
  return { platform: ref.platform, profileId: ref.profileId, profileUrl: ref.url, status,
    sourceStatuses: [status], observedAt, coverage,
    facts: { jobs: [], currentJobRefs: [], officialRelationships: [] }, thirdPartyAssessments: [], inferences: [], questions: [], issues: [] };
}
function sameProfileId(raw, profile) {
  return String(raw?.profileId ?? "") === profile.profileId
    && (raw.platform === undefined || raw.platform === profile.platform);
}
function normalizeJob(raw, profile, current = false) {
  if (!raw || raw.visibility !== "public" || !sameProfileId(raw, profile)) return null;
  const ref = normalizePublicJobRef({ platform: profile.platform, jobId: raw.jobId ?? raw.id, url: raw.url });
  const observedAt = normalizePublicTimestamp(raw.observedAt ?? (current ? raw.fetchedAt : null));
  const phase = current ? "current" : raw.phase;
  if (!ref || !observedAt || !["past", "current"].includes(phase)) return null;
  const result = { ...ref, profileId: profile.profileId, visibility: "public", phase, observedAt };
  result.observations = deduplicateRecords([
    { phase, observedAt },
    ...list(raw.observations).map((entry) => ({ phase: entry?.phase, observedAt: normalizePublicTimestamp(entry?.observedAt) }))
      .filter((entry) => ["past", "current"].includes(entry.phase) && entry.observedAt)
  ]);
  for (const key of Object.keys(BUSINESS_TAGS)) result[key] = tags(raw[key], BUSINESS_TAGS[key]);
  for (const key of ["publishedAt", "deadlineAt"]) {
    const value = normalizePublicTimestamp(raw[key]);
    if (value) result[key] = value;
  }
  if (result.publishedAt && result.deadlineAt && result.deadlineAt < result.publishedAt) return null;
  return result;
}
function normalizeRating(raw, profile) {
  if (!raw || raw.visibility !== "public" || !sameProfileId(raw, profile)) return null;
  const observedAt = normalizePublicTimestamp(raw.observedAt);
  let ref;
  if (raw.jobId !== undefined) ref = normalizePublicJobRef({ platform: profile.platform, jobId: raw.jobId, url: raw.url });
  else ref = normalizePublicProfileRef({ platform: profile.platform, profileId: profile.profileId, url: raw.url });
  if (!ref || !observedAt) return null;
  const result = { ...ref, profileId: profile.profileId, visibility: "public", observedAt, assessmentCodes: tags(raw.assessmentCodes, ASSESSMENT_CODES) };
  if (typeof raw.score === "number" && Number.isFinite(raw.score) && raw.score >= 0 && raw.score <= 5) result.score = raw.score;
  if (["positive", "neutral", "negative"].includes(raw.sentiment)) result.sentiment = raw.sentiment;
  if (result.score === undefined && result.sentiment === undefined && !result.assessmentCodes.length) return null;
  return result;
}
function normalizeRelationship(raw, profile) {
  if (!raw || raw.platform !== profile.platform || raw.relationshipType !== "officially_declared_related_account") return null;
  const account = normalizePublicProfileRef({ platform: raw.platform, profileId: raw.profileId, url: raw.profileUrl });
  const source = raw.evidence;
  const evidence = normalizePublicProfileRef({ platform: source?.platform, profileId: source?.declarerProfileId, url: source?.url });
  const observedAt = normalizePublicTimestamp(source?.observedAt);
  if (!account || account.profileId === profile.profileId || !evidence || evidence.platform !== profile.platform || evidence.profileId !== profile.profileId
    || source.visibility !== "public" || source.kind !== "official_relationship_statement" || source.official !== true || !observedAt) return null;
  return { platform: account.platform, profileId: account.profileId, profileUrl: account.url,
    relationshipType: "officially_declared_related_account",
    identityConclusion: "not_inferred",
    evidence: { platform: evidence.platform, declarerProfileId: evidence.profileId, url: evidence.url,
      visibility: "public", kind: "official_relationship_statement", official: true, observedAt,
      verification: "caller_supplied_public_statement" } };
}
function jobRefs(jobs) {
  return jobs.map(({ platform, jobId, url }) => ({ platform, jobId, url })).sort((a, b) => a.jobId.localeCompare(b.jobId));
}
function intersection(a, b) { return a.filter((value) => b.includes(value)); }
function has(job, key, values) { return job[key].some((tag) => values.includes(tag)); }
function timeOverlap(a, b) {
  return a.publishedAt && a.deadlineAt && b.publishedAt && b.deadlineAt
    && a.publishedAt <= b.deadlineAt && b.publishedAt <= a.deadlineAt;
}
function compareJobs(jobs) {
  const result = [];
  for (let i = 0; i < jobs.length; i++) {
    for (let j = i + 1; j < jobs.length; j++) {
      const a = jobs[i], b = jobs[j];
      const services = intersection(a.targetServiceTags, b.targetServiceTags).filter((tag) => tag !== "other_service");
      if (!services.length) continue;
      const deliverables = intersection(a.deliverableTags, b.deliverableTags).filter((tag) => tag !== "other_business");
      const codes = [];
      const review = (job) => has(job, "deliverableTags", ["review"]) || has(job, "purposeTags", ["review_publication"]);
      const ranking = (job) => has(job, "purposeTags", ["ranking_influence", "marketing"]);
      if ((review(a) && ranking(b)) || (review(b) && ranking(a))) codes.push("combined_review_activity");
      const account = (job) => has(job, "deliverableTags", ["account"]) || has(job, "purposeTags", ["account_operation"]);
      const automated = (job) => has(job, "deliverableTags", ["automation", "data"]) || has(job, "purposeTags", ["contact_collection"]);
      if ((account(a) && automated(b)) || (account(b) && automated(a))) codes.push("combined_account_activity");
      if (deliverables.length && a.purposeTags.length && JSON.stringify(a.purposeTags) === JSON.stringify(b.purposeTags) && timeOverlap(a, b)) codes.push("overlapping_similar_requests");
      if (deliverables.length && a.purposeTags.length && b.purposeTags.length && JSON.stringify(a.purposeTags) !== JSON.stringify(b.purposeTags)
        && (has(a, "purposeTags", ["review_publication", "ranking_influence", "account_operation", "contact_collection"])
          || has(b, "purposeTags", ["review_publication", "ranking_influence", "account_operation", "contact_collection"]))) codes.push("purpose_change_across_requests");
      for (const code of codes) result.push({ code, scope: "same_explicit_profile", jobRefs: jobRefs([a, b]),
        sharedTargetServiceTags: services, timelineCompared: Boolean(a.publishedAt && b.publishedAt),
        conclusion: "human_confirmation_needed" });
    }
  }
  return result;
}
function deduplicateJobs(jobs, issues, rejected) {
  const grouped = new Map();
  for (const job of jobs) {
    const group = grouped.get(job.jobId) || [];
    group.push(job); grouped.set(job.jobId, group);
  }
  const result = [];
  for (const group of grouped.values()) {
    const conflicting = Object.keys(BUSINESS_TAGS).some((field) =>
      new Set(group.filter((job) => job[field].length).map((job) => JSON.stringify(job[field]))).size > 1)
      || ["publishedAt", "deadlineAt"].some((field) => new Set(group.map((job) => job[field]).filter(Boolean)).size > 1);
    if (conflicting) { issues.push("duplicate_job_id_conflict"); rejected.jobs += group.length; }
    else {
      // Preserve a real supplied observation, never manufacture a fully tagged current job.
      const completeness = (job) => Object.keys(BUSINESS_TAGS).filter((field) => job[field].length).length;
      const chosen = [...group].sort((a, b) => completeness(b) - completeness(a)
        || b.observedAt.localeCompare(a.observedAt) || JSON.stringify(a).localeCompare(JSON.stringify(b)))[0];
      result.push({ ...chosen, observations: deduplicateRecords(group.flatMap((job) => job.observations)) });
      if (group.length > 1) issues.push("duplicate_job_id_deduplicated");
    }
  }
  return result.sort((a, b) => a.jobId.localeCompare(b.jobId));
}
function deduplicateRecords(records) {
  return [...new Map(records.map((item) => [JSON.stringify(item), item])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** Review caller-supplied public business evidence. No network or identity enrichment is performed. */
function reviewClientHistories(histories, options = {}) {
  const rejectedRecords = { histories: 0, jobs: 0, ratings: 0, relationships: 0, currentJobs: 0 };
  const profiles = new Map();
  for (const raw of list(histories)) {
    const ref = normalizePublicProfileRef({ platform: raw?.platform, profileId: raw?.profileId, url: raw?.profileUrl });
    if (!ref) { rejectedRecords.histories++; continue; }
    const status = HISTORY_STATUSES.includes(raw.status) ? raw.status : "not_connected";
    const profile = emptyProfile(ref, status, normalizePublicTimestamp(raw.observedAt), coverageOf(raw.coverage));
    const acceptsEvidence = ["fetched", "insufficient_scope"].includes(status);
    if (acceptsEvidence) {
      for (const job of list(raw.jobs)) {
        const value = normalizeJob(job, profile);
        if (value) profile.facts.jobs.push(value); else rejectedRecords.jobs++;
      }
      for (const rating of list(raw.publicRatings)) {
        const value = normalizeRating(rating, profile);
        if (value) profile.thirdPartyAssessments.push(value); else rejectedRecords.ratings++;
      }
      for (const relation of list(raw.relatedAccounts)) {
        const value = normalizeRelationship(relation, profile);
        if (value) profile.facts.officialRelationships.push(value); else rejectedRecords.relationships++;
      }
    } else {
      rejectedRecords.jobs += list(raw.jobs).length;
      rejectedRecords.ratings += list(raw.publicRatings).length;
      rejectedRecords.relationships += list(raw.relatedAccounts).length;
      if (list(raw.jobs).length || list(raw.publicRatings).length || list(raw.relatedAccounts).length) profile.issues.push("evidence_not_accepted_for_history_status");
    }
    if (!profile.observedAt) profile.issues.push("missing_observed_at");
    if (!Object.values(profile.coverage).every(Boolean)) profile.issues.push("incomplete_public_scope");
    const key = `${profile.platform}:${profile.profileId}`;
    if (!profiles.has(key)) profiles.set(key, profile);
    else {
      const previous = profiles.get(key);
      previous.sourceStatuses = uniqueSorted([...previous.sourceStatuses, status]);
      if (previous.status !== status) previous.status = "insufficient_scope";
      if (profile.observedAt && (!previous.observedAt || profile.observedAt > previous.observedAt)) previous.observedAt = profile.observedAt;
      for (const field of Object.keys(previous.coverage)) previous.coverage[field] = previous.coverage[field] && profile.coverage[field];
      previous.facts.jobs.push(...profile.facts.jobs);
      previous.facts.officialRelationships.push(...profile.facts.officialRelationships);
      previous.thirdPartyAssessments.push(...profile.thirdPartyAssessments);
      previous.issues.push(...profile.issues, "duplicate_profile_records");
    }
  }
  for (const raw of list(options?.currentJobs)) {
    const ref = normalizePublicProfileRef({ platform: raw?.platform, profileId: raw?.profileId, url: raw?.profileUrl });
    const key = `${raw?.platform}:${String(raw?.profileId ?? "")}`;
    let profile = profiles.get(key);
    if (raw?.profileUrl !== undefined && !ref) { rejectedRecords.currentJobs++; continue; }
    if (!profile && ref) {
      const prospective = emptyProfile(ref, "not_connected", normalizePublicTimestamp(raw.observedAt ?? raw.fetchedAt), coverageOf(null));
      if (normalizeJob(raw, prospective, true)) {
        prospective.issues.push("incomplete_public_scope");
        profiles.set(key, prospective); profile = prospective;
      }
    }
    const value = profile && normalizeJob(raw, profile, true);
    if (!value) { rejectedRecords.currentJobs++; continue; }
    profile.facts.currentJobRefs.push({ platform: value.platform, jobId: value.jobId, url: value.url,
      profileId: value.profileId, visibility: "public", phase: "current", observedAt: value.observedAt });
    // A current identity observation does not overwrite the dated business tags in supplied history.
    if (!profile.facts.jobs.some((job) => job.jobId === value.jobId)) profile.facts.jobs.push(value);
  }
  // An explicit ownership contradiction is not resolved by guessing an account relationship.
  const owners = new Map();
  for (const profile of profiles.values()) for (const job of profile.facts.jobs) {
    const key = `${job.platform}:${job.jobId}`;
    const set = owners.get(key) || new Set(); set.add(profile.profileId); owners.set(key, set);
  }
  for (const profile of profiles.values()) {
    profile.facts.jobs = profile.facts.jobs.filter((job) => {
      if (owners.get(`${job.platform}:${job.jobId}`).size <= 1) return true;
      rejectedRecords.jobs++; profile.issues.push("conflicting_job_profile"); return false;
    });
    profile.facts.jobs = deduplicateJobs(profile.facts.jobs, profile.issues, rejectedRecords);
    profile.facts.currentJobRefs = deduplicateRecords(profile.facts.currentJobRefs.filter((job) => {
      if (owners.get(`${job.platform}:${job.jobId}`)?.size <= 1) return true;
      profile.issues.push("conflicting_job_profile"); return false;
    }));
    profile.facts.officialRelationships = deduplicateRecords(profile.facts.officialRelationships);
    profile.thirdPartyAssessments = deduplicateRecords(profile.thirdPartyAssessments.filter((assessment) => {
      const knownOwners = assessment.jobId && owners.get(`${assessment.platform}:${assessment.jobId}`);
      if (!knownOwners || (knownOwners.size === 1 && knownOwners.has(profile.profileId))) return true;
      rejectedRecords.ratings++; profile.issues.push("conflicting_rating_profile"); return false;
    }));
    if (profile.facts.jobs.some((job) => Object.keys(BUSINESS_TAGS).some((field) => !job[field].length))) profile.issues.push("business_dimensions_missing");
    profile.inferences = compareJobs(profile.facts.jobs);
    for (const assessment of profile.thirdPartyAssessments) {
      if (assessment.sentiment === "negative" || (assessment.score !== undefined && assessment.score < 3)) profile.inferences.push({
        code: "public_rating_concern", scope: "same_explicit_profile", assessmentRefs: [{ url: assessment.url, observedAt: assessment.observedAt }],
        conclusion: "human_confirmation_needed"
      });
    }
    profile.questions = profile.inferences.map((inference) => ({ ...inference, question: QUESTIONS[inference.code] }));
    profile.issues = uniqueSorted(profile.issues);
    profile.reviewStatus = profile.questions.length ? "safety_review_required"
      : profile.status === "fetched" && profile.facts.jobs.length && Object.values(profile.coverage).every(Boolean)
        && !profile.issues.some((issue) => issue !== "duplicate_job_id_deduplicated")
        ? "no_questions_from_supplied_evidence" : "insufficient_evidence";
    profile.evidenceVerification = "caller_supplied_public_business_evidence";
  }
  return { schemaVersion: 1,
    acquisition: { mode: "explicit_public_evidence_only", automaticHistoryFetch: "not_connected", accessPermission: "unverified" },
    profiles: [...profiles.values()].sort((a, b) => `${a.platform}:${a.profileId}`.localeCompare(`${b.platform}:${b.profileId}`)), rejectedRecords };
}

// Persist only the supported input envelope and recompute questions. Never pass through result text.
function sanitizeClientHistoryReview(review) {
  if (!review || review.schemaVersion !== 1 || !Array.isArray(review.profiles)) return reviewClientHistories([]);
  const result = reviewClientHistories(review.profiles.map((profile) => ({
    platform: profile?.platform, profileId: profile?.profileId, profileUrl: profile?.profileUrl,
    status: profile?.status, observedAt: profile?.observedAt, coverage: profile?.coverage,
    jobs: ["fetched", "insufficient_scope"].includes(profile?.status) ? profile?.facts?.jobs : [], publicRatings: profile?.thirdPartyAssessments,
    relatedAccounts: profile?.facts?.officialRelationships
  })), { currentJobs: review.profiles.flatMap((profile) => list(profile?.facts?.currentJobRefs)
    .map((job) => {
      const observation = list(profile?.facts?.jobs).find((entry) => entry?.jobId === job?.jobId
        && entry?.phase === "current" && entry?.observedAt === job?.observedAt);
      return { ...observation, ...job, profileUrl: profile?.profileUrl };
    })) });
  for (const profile of result.profiles) {
    const previous = review.profiles.find((entry) => entry?.platform === profile.platform && String(entry?.profileId ?? "") === profile.profileId);
    profile.sourceStatuses = tags(previous?.sourceStatuses, HISTORY_STATUSES);
    if (!profile.sourceStatuses.length) profile.sourceStatuses = [profile.status];
    profile.issues = uniqueSorted([...profile.issues, ...tags(previous?.issues, ISSUE_CODES)]);
    if (!profile.questions.length && profile.issues.some((issue) => issue !== "duplicate_job_id_deduplicated")) profile.reviewStatus = "insufficient_evidence";
  }
  for (const key of Object.keys(result.rejectedRecords)) {
    const count = review.rejectedRecords?.[key];
    if (Number.isSafeInteger(count) && count >= 0) result.rejectedRecords[key] = Math.max(result.rejectedRecords[key], count);
  }
  return result;
}

module.exports = { reviewClientHistories, sanitizeClientHistoryReview, HISTORY_STATUSES, BUSINESS_TAGS, ASSESSMENT_CODES };
