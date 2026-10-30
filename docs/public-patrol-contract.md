# Explicit public patrol input

`src/public-patrol-import.js` validates an explicitly supplied, separately produced
public patrol record. It performs no collection, network request, filesystem
operation, credential lookup, scheduling, implicit clock read or private-ledger
lookup. Its presence does not establish that a patrol has run.

Private operational notes, private documents and application or hold records are not input
sources. Renaming their fields or attaching a public URL does not declassify them.
This contract accepts newly prepared public-only structured records, not an
arbitrary private text document that is sanitized for publication.

## API

```javascript
const { importPublicPatrol, projectPublicPatrol, mergePublicPatrol } = require("./src/public-patrol-import");
const patrol = importPublicPatrol(explicitBytesOrObject);
const publicValue = projectPublicPatrol(patrol);
const selectedLatest = mergePublicPatrol(previousExplicitRecord, incomingExplicitRecord);
```

Input may be UTF-8 `Buffer`, JSON string or an object containing only own data
properties. Accessors, Proxy objects, custom prototypes, symbols, cycles,
functions, shared byte buffers and custom Buffer properties are rejected. Ordinary
Buffer bytes are copied without reading caller-defined accessors. Malformed
UTF-8, BOM and duplicate decoded JSON keys are rejected. All
errors use fixed `public_patrol_...` codes without input text or exception causes.
Unknown fields are rejected at every level rather than removed.

Missing input (`null` or `undefined`) returns a fixed `UNAVAILABLE` envelope with
`run: null`, empty sources and entries, and all counts `null`. It does not invent
an execution ID or time. `projectPublicPatrol(null)` has the same behavior.

## Envelope

The input requires `kind: public_patrol`, `schemaVersion: 1`, `run`, `scope`,
`sources` and `entries`. The output additionally supplies `assessment:
PUBLIC_EVIDENCE_ONLY`, `availability`, `counts`, `limitationCodes` and
`contentSha256`. If these derived fields are supplied, they must match the
computed values. No Collector counts, recommendation or execution identity are
changed by this import.

`run` contains a public patrol UUID v4 `patrolRunId`, UTC canonical ISO timestamps
`startedAt`, `attemptsCompletedAt`, `decisionAsOf`, and a status of `COMPLETED`,
`PARTIAL`, `ABORTED` or `FAILED`. The required ordering is
`startedAt <= decisionAsOf <= attemptsCompletedAt`. Each observation must fall
between the start and completion timestamps. The validator has no implicit
current time: it validates internal ordering, not present-day freshness or the
truth of a caller's timestamp. A display layer can evaluate freshness using its
separately supplied explicit clock.

`scope` contains `declaredPlatforms` and `unsupportedSources`. Both are unique,
fixed platform-code arrays derived from the source records. The initial platform
codes are `crowdworks`, `lancers`, `coconala`, `outlier`, `telus`, `clickworker`,
and `other_public`. This does not mean that the other source contracts are
implemented or that a whole independent patrol is restricted to CrowdWorks.

Only CrowdWorks records currently have a supported reference contract. A source
contains `sourceId` (integer), `platform`, `sourceKind`, `availability`, canonical
`url` and `scopeId` (a `scope-` SHA256 identifier). `PUBLIC_SEARCH` permits only
the canonical CrowdWorks search path, without a query. `PUBLIC_JOB_DETAIL`
permits a canonical public CrowdWorks job URL. The scope identifier is a supplied
identifier, not proof of a query, permitted access or complete coverage. Raw
queries are not accepted. `observedCount` is computed from retained observations.

Other platform declarations use only `sourceId`, the fixed `platform` code,
`sourceKind: PUBLIC_PLATFORM`, `availability: UNAVAILABLE` and optionally
`observedCount: null`. They cannot carry an arbitrary URL, job data or a success
declaration. Adding a supported public URL contract requires a separate reviewed
change; the importer never discovers or connects one.

`AVAILABLE` means supported structured input exists and all declared sources are
available in a `COMPLETED` record. It does not mean live connectivity or security
approval. `LIMITED` identifies supported observations alongside unavailable or
unsupported sources, or a partial/aborted/failed run. With no available supported
source the envelope is `UNAVAILABLE`, and observation and job counts remain
`null`. An available search source with no observed entries is an explicit zero.
Counts with available sources describe only supplied observations; they are not
site-wide totals. Fixed limitation codes preserve the scope limitations.

## Entries, evidence and decisions

Each entry contains only `platform: crowdworks`, string `jobId`, canonical `url`
and a nonempty `observations` array. The ID and URL must agree. Query strings,
fragments, alternate authorities and inconsistent references are rejected.

Each observation has `sourceId`, `observedAt` and `level` (`SEARCH_SUMMARY` or
`JOB_DETAIL`). Its level must match its source kind, and a detail observation must
refer to that same source job URL. The source must be available. A detail source
cannot claim available observations while supplying none.

Optional conditions use fixed codes `AI_PERMISSION`, `COMPENSATION`,
`ELIGIBILITY`, `DATA_RIGHTS`, `DELIVERY_SCOPE`, `ACCEPTANCE`, `RECRUITMENT_OPEN`
and `ACCESS_TERMS`, with `SUPPORTED`, `CONTRADICTED` or `UNKNOWN` states. Missing
conditions become `UNKNOWN`, and `unconfirmedConditions` is derived from them.
These are caller-supplied structured claims with public source references, not a
verification of the original page text.

Fit and security are independent structured assessments. `fit.status` is
`UNKNOWN`, `POTENTIAL_FIT` or `NOT_FIT`. `securityReview.status` is `UNKNOWN`,
`REVIEW_REQUIRED` or `BLOCKED`. Reasons are fixed code arrays; free-form reasons
and approved/cleared/safe statuses are rejected. Defaults are `UNKNOWN` for both.
Every observation carries `decision: STOP_REQUIRED`: fit is not permission to
apply, and no state authorizes an application, contact or other external action.

`evidence.kind: CANONICAL_PUBLIC_OBSERVATION` and its SHA256 cover the canonical
public job reference, the structured source identity (excluding the derived
observation count), and that normalized observation excluding `evidence` itself.
This is deliberately not an unavailable HTML-byte hash. The importer has no
original HTML and cannot verify its bytes, independent acquisition, public
accessibility, claim truth, authenticity, safety or completeness. A supplied
evidence hash must match this exact structured input; it cannot upgrade these
limitations. The top `contentSha256` similarly hashes the complete canonical
envelope excluding that hash field.

Titles, bodies, names, arbitrary notes, contacts, private identifiers,
application/hold states (including an `UNKNOWN` private state), private record
hashes and private provenance are not accepted. A public display may use a fixed
notice that private management is unconnected; any future private-only join
requires a separate input boundary. Missing private records never mean
unapplied, and this module does not perform that join.

## Deduplication and repeated imports

Entries are grouped by matching canonical platform, ID and URL. All distinct
source/time observations are preserved, including contradictory condition claims.
Conditions from different observations are never fused into one assessment.
An identical source/job/time observation is idempotent; changed evidence or
conditions at that same identity are rejected as an observation conflict.

`mergePublicPatrol` selects a single latest explicit record; it does not retain
history or merge different runs. The same `patrolRunId` and canonical content hash
is idempotent even if input JSON formatting or object order differs. The same ID
with altered canonical content or a mismatched supplied hash is rejected. For
different run IDs, later `decisionAsOf` wins, an older late arrival leaves the
current record selected, and equal decision times conflict. This is decision-time
ordering, not completion-time ordering. Missing input never replaces an existing
record. Callers retain original records separately; this pure operation deletes
or overwrites no artifacts.

## Bounds, compatibility and validation

Import and normalized output are bounded to 262,144 UTF-8 bytes, 32 source
records, 100 entry records and 300 distinct observations. Overflow is rejected
without truncation. These are public import bounds, not changes to any private
retention limit or connection policy. Existing Collector summary bytes, nullable
counts, legacy timestamps, access-stop behavior and private-record hashes are
outside this module and remain unchanged. Other public files are not added to a
publication allowlist by this change.

Synthetic tests cover missing input versus verified zero, unsupported scope,
canonical identity, provenance-preserving deduplication, conflicting observations,
condition and review separation, private-field rejection, canonical timestamps,
derived counts and hashes, malformed bytes, decoded duplicate keys, hostile
object properties, import bounds, idempotency and stale/equal-clock merge cases.
The tests also forbid filesystem, network and implicit-clock calls during import,
projection and selection. No live input is required to run them.
