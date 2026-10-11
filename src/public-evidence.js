"use strict";

// This module validates references only. It never fetches a URL or resolves identity.
function explicitId(value, pattern) {
  const id = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value) : value;
  return typeof id === "string" && pattern.test(id) ? id : null;
}

function canonicalReference(input, kind) {
  if (!input || typeof input !== "object") return null;
  const platform = input.platform;
  if (platform !== "crowdworks" && platform !== "lancers") return null;
  const value = kind === "job" ? (input.jobId ?? input.id) : input.profileId;
  const id = explicitId(value, kind === "job" || platform === "crowdworks"
    ? /^[1-9][0-9]{0,31}$/ : /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
  if (!id || typeof input.url !== "string") return null;
  // Inspect the original authority/path before URL parsing can normalize deceptive paths.
  const match = input.url.match(/^https:\/\/([^/?#]+)(\/[^?#]*)(?:[?#][^\s]*)?$/);
  if (!match || /[\\\s]/.test(input.url)) return null;
  const host = platform === "crowdworks" ? "crowdworks.jp" : "www.lancers.jp";
  if (match[1].toLowerCase() !== host) return null;
  const paths = kind === "job"
    ? [platform === "crowdworks" ? `/public/jobs/${id}` : `/work/detail/${id}`]
    : platform === "crowdworks" ? [`/public/employers/${id}`]
      : [`/profile/${id}`, `/client/${id}`];
  const path = match[2].endsWith("/") ? match[2].slice(0, -1) : match[2];
  if (!paths.includes(path)) return null;
  return kind === "job" ? { platform, jobId: id, url: `https://${host}${path}` }
    : { platform, profileId: id, url: `https://${host}${path}` };
}

function normalizePublicJobRef(input) {
  return canonicalReference(input, "job");
}

function normalizePublicProfileRef(input) {
  return canonicalReference(input, "profile");
}

function normalizePublicTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return null;
  // Reject calendar overflow (e.g. February 30) rather than silently correcting it.
  const zone = value.match(/(Z|[+-]\d{2}:\d{2})$/)[1];
  const offset = zone === "Z" ? 0 : (zone[0] === "+" ? 1 : -1)
    * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return null;
  const local = new Date(time.getTime() + offset * 60000).toISOString();
  if (local.slice(0, 19) !== value.slice(0, 19)) return null;
  return time.toISOString();
}

module.exports = { normalizePublicJobRef, normalizePublicProfileRef, normalizePublicTimestamp };
