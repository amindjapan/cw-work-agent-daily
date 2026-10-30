# Collector state and public patrol: isolated implementation

This implementation is local and opt-in. Neither existing workflow is changed.
It does not activate status commits, Pages updates, real collection, authentication,
private operational records, private retention, Drive, new schedules or services.
The ordinary CLI path retains its existing outputs when attempt recording is not
explicitly configured. Production activation requires separate review and approval.

## Separate evidence

The overview has separate sections for the latest supplied attempt, saved public
material, last independently verified successful collection, and public patrol.
A legacy summary with all failed searches and null counts is `FAILED_LEGACY`, not
the last successful result. `generatedAt` remains a collection start timestamp.
Missing finish times are not derived from it. The initial implementation has no
adapter proving a successful collection from independent source/byte evidence:
last verified success is always `UNKNOWN`, and positive success claims are rejected.

`COMPLETED` means retrieval attempts finished. It can include ordinary HTTP,
network or extraction failures and unknown counts. `SUCCEEDED` in a persistence
field is only that separately reported stage; it proves neither collection quality
nor another stage. An input hash checks structured record integrity and identity,
not authenticity, network access, original page bytes or truth of supplied facts.

## Local attempt recording

`runDaily` accepts an explicit `attemptRecord` object with absolute `directory`,
`runId`, `runAttempt`, `sourceCommit` and `workflowPath`. Run IDs are numeric GitHub
run IDs or `local-` followed by a UUIDv4. The workflow path is the existing daily
workflow or `local`; the commit is an explicitly supplied 40-digit hexadecimal
value. No environment variable or secret enables this path automatically.

Diagnostic events must follow search-before-detail order. Known HTTP 401, 403
and 429 statuses require their corresponding authentication, access-denied and
rate-limit reason codes. At most one access stop is allowed; after it, only
explicit unattempted entries with no HTTP status can appear. A recomputed hash
does not make an internally contradictory event stream valid.

The CLI exposes this only through `--attempt-output`, `--attempt-run-id`, optional
`--attempt-number`, and `--source-commit`. Running the daily CLI still performs its
normal collection, so it must not be used as an offline test. Tests replace every
HTTP function or preload a synthetic fetch before loading the real CLI.

The record separates collection, local persistence, repository persistence and
publication. The local wrapper never sets Git or publication to success; both
remain `NOT_ATTEMPTED`. Pure lifecycle functions can validate independently
supplied failed Git/publish outcomes, without performing either operation.
If retrieval finishes but pre-save processing fails, the terminal collection
state is `FAILED` while completed retrieval counters remain available. Local
persistence stays `NOT_ATTEMPTED`, rather than leaving a stale running record.

Start and terminal records use a fixed schema and canonical content hash. The
explicit store uses a lock, exclusive temporary file, fsync and rename. Files
outside the declared directory, symlinks, public/evidence output overlap, unexpected
bytes, identity collisions and terminal regressions are rejected. Importing the
same record is idempotent. Starting collection again with an existing start or
terminal identity is refused before fetching; an incomplete attempt is not resumed.

An access stop is recorded before rethrowing the original stop. Failure to complete
the record never becomes a successful collection and is not retried elsewhere.
If the start is retained without a finish, the overview says completion is
unconfirmed; it does not prove that a job is still running.

The wrapper starts inside `runDaily`. Argument/history preflight failures before
that boundary, checkout/setup/tests, runner loss and unavailable storage can leave
no record. Treat those cases as `UNAVAILABLE`/`UNKNOWN`. There is no workflow-level
driver or durable Git/Pages acknowledgement path in this version. Existing local
collection saves span multiple files and do not gain a rollback transaction here;
a partial save is a failed stage, not a verified current artifact.

## Public patrol

See [the public patrol contract](public-patrol-contract.md). It is a separate run,
not Collector coverage or a contribution to `safeCandidates` or recommendation.
The declaration may include multiple platforms. Only the CrowdWorks job-reference
contract is implemented initially; other declared platforms remain explicitly
unsupported/UNAVAILABLE. This limitation must not be described as the scope of all
independent patrol work.

No private report body, title list, application/hold history, individual identity,
contact detail, arbitrary note, secret or private document ID is an input field.
Unknown fields are rejected rather than carried through. Public evidence uses
canonical links and fixed condition/reason codes. Fit and security review are
separate, and the current output is always `STOP_REQUIRED`, never application
permission. The public page only has a fixed private-management-unconnected label.

Same ID and URL observations preserve their individual source and confirmation
time. Display grouping does not merge conditions or establish a new confirmed
description. Same run/content import is idempotent; conflicting hashes/identities
are rejected. A later run can be selected by explicit time without replacing a
newer run with late old input. Selection is not historical retention; original
records must be preserved separately, and this code deletes none of them.

## Offline static composition and staging

`prepare-collector-overview.js` reads only explicit local summary/attempt/patrol
files. Missing optional inputs become unavailable, never a successful zero. Its
inputs are validated before a new, empty output directory is created. The saved
public summary bytes are copied unchanged; its source is never overwritten.
Unknown fields in that summary are rejected at this new composition boundary.
An explicit `--as-of` is a display cutoff, not a newly observed time.

Synthetic example only:

```text
node src/prepare-collector-overview.js --summary synthetic-summary.json --attempt synthetic-attempt.json --patrol synthetic-patrol.json --as-of 2026-10-30T02:00:00.000Z --output new-empty-directory
```

The output is `index.html`, `latest.json`, `latest.md`, `.nojekyll`,
`collector-status.json` and `public-patrol.json`. The new status envelope includes
its display cutoff. Static HTML has no script, iframe, image, stylesheet request
or network function. Public source hyperlinks are references for manual review,
not automatically requested resources. Status counters and null/unknown values,
stop stage/status/reason, source scope, evidence level/hash and unconfirmed
conditions are rendered separately.

`preparePublicArtifact` defaults to its old file list. Its new `includeOverview:
true` option (CLI `--overview`) explicitly selects and validates the two new JSON
files. In this mode HTML and Markdown are regenerated from projected inputs;
arbitrary staging HTML/Markdown and marker contents are never copied. It does not
upload or publish anything. A failed or partially created staging directory must
not be treated as prepared. All original inputs remain intact.

`buildCollectorOverview` is a pure function. `renderCollectorOverview` accepts
only a frozen view issued by that builder in the same process. Serialized/cloned
views and arbitrary externally supplied view objects are deliberately unsupported.
The public JSON contracts are the status and patrol records, not a renderer view.

## Next approval and rollback

Later approval must name the production Git changes, workflow-level record
collection, metadata-only Git persistence and any metadata-only Pages update.
The existing access-stop snapshot/publication gate is not relaxed by this local
implementation. Real collection and private operational record saving remain separate.
Pages publication failure cannot make a static old page show a newer attempt:
display cutoffs and independently checked Actions evidence remain necessary.

Rollback is to omit the local options/overview flag or revert this change.
Do not delete historical summaries, attempt records, patrol inputs or evidence.
