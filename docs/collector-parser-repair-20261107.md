# Offline JobPosting parser repair, 2026-11-07

## Incident and limits

Production source before this repair: `f65261817aeae8b280b65b5d4fd5d2ecc7653f77`.
[Daily run 42326858310](https://github.com/amindjapan/cw-work-agent-daily/actions/runs/42326858310)
passed all 558 tests, completed 13 searches, and observed 551 listings. Detail
retrieval recorded four successes, nineteen extraction failures, and then a
CAPTCHA stop on attempt 24. Snapshot persistence and Pages deployment were skipped.
The raw response bodies are not retained. Consequently, neither the extraction
failure format nor the actual CAPTCHA cause is established by this repair.

This is a demonstrated offline parser correctness repair, **not a verified live
collection recovery**. It does not authorize a retry, new access, authentication,
CAPTCHA solving, publication, or any change to service terms or permissions.
Standards describe data syntax; they do not grant access to a website.

## Changes and reason

- Recognize a bounded JSON-LD subset: a root object or array, explicit `@graph`
  containers, and string/type-array JobPosting forms. Accept the literal
  `JobPosting`, `https://schema.org/JobPosting`, and `http://schema.org/JobPosting`.
- Bind selection to the already validated requested CrowdWorks job URL. Explicit
  `url` and `@id` fields must be canonicalizable public job URLs and agree. A
  mismatching sole posting, multiple matches, invalid identity or ambiguous
  identity-less mixture remains unconfirmed. A sole identity-less posting retains
  legacy compatibility. No identity is inferred from arbitrary `identifier` fields.
- Take description and employer from the **same** selected posting. Do not coerce
  object, array, numeric, boolean or empty descriptions into successful content.
- Consume complete HTML tags and quoted attributes before identifying JSON-LD.
  Ignore script-looking examples in attributes, comments and inert/raw-text
  containers. Reject duplicate JSON keys and unsupported context remapping.

The subset accepts an absent context or the standard HTTP/HTTPS schema.org context
URL, with optional trailing slash. It does not fetch contexts, execute JavaScript,
dereference links, follow redirects or recurse through arbitrary properties.
TextObject descriptions, aliases, relative posting identities and custom contexts
remain unsupported. Bounds are 1 MiB HTML, 32 JSON-LD scripts, 256 visited nodes and
16 traversal levels. Ambiguity and exceeded bounds fail closed; this can retain
extraction failures for otherwise valid unsupported formats.

Official syntax references:
- [W3C JSON-LD 1.1 types](https://www.w3.org/TR/json-ld11/#specifying-the-type)
- [W3C JSON-LD 1.1 graphs](https://www.w3.org/TR/json-ld11/#named-graphs)
- [Schema.org JobPosting](https://schema.org/JobPosting)
- [Google JobPosting description guidance](https://developers.google.com/search/docs/appearance/structured-data/job-posting)

## Validation

The baseline suite passed 558/558 locally. Running the initial eleven new tests
against the unchanged baseline reproduced ten failures, including format
handling, identity/employer mixing and non-string description acceptance.
Independent review found fake attributes/inert markup and nested organization
context gaps; both were repaired and covered by additional cases.

Final local syntax checks and all **571 tests** passed, with zero failures or
skips (Node 24.22.1). These tests use synthetic responses only. The existing
pull-request CI checks Node 22 and the exact PR commit; its result must be checked separately
before release. No live CrowdWorks request or production workflow was dispatched.
The final independent review reran all 571 tests and found no blocking issue for
this bounded draft-PR scope. It retained the scanner and live-verification limits.

Tests retain explicit CAPTCHA, authentication, rate-limit and access-denial stops,
manual redirect handling, fixed diagnostics, no post-stop requests and unchanged
previous outputs. No workflow, schedule, permission, data snapshot, public export
allowlist, storage path, credential or dependency is changed.

## Release and rollback

The repair is prepared on a separate branch for a draft PR. PR submission and CI
are pending. This document does not establish main integration, Pages deployment
or successful live collection. Review CI and independent findings before any
separately authorized production integration.

Rollback is a source revert of this repair's commit. No data migration or deletion
is needed. Existing snapshots and the accepted reconstruction remain untouched.
A source revert is not a Pages rollback, and this repair does not authorize an
extra collection or deployment run to validate or reverse it.
