# Collector status connection

The status view separates a completed workflow observation, stored collection material, and a verified successful collection. A stopped workflow does not replace the stored summary or add a collection date. The legacy summary containing thirteen HTTP 403 results is failed material; it does not establish a last successful collection. Unproven success remains `UNKNOWN`.

## Public inputs

`collector-status/attempts/` contains explicitly reviewed observations of the two already completed public workflow runs. Each record identifies the repository, workflow path, run and attempt, source commit, public run/job links, workflow timestamps, fixed diagnostics, and original step results. The collector's own start and finish remain null because those times were not recorded. Later metadata persistence does not change the original snapshot, commit or publication steps from `SKIPPED` to success. The hash binds canonical fields; it does not authenticate a GitHub response or prove raw log contents.

The initial adapter accepts stopped daily-workflow observations only. It reads supplied bytes or objects and never retrieves logs. Conflicting records with the same identity, changed hashes and ambiguous ordering are rejected. Latest selection uses workflow start time and attempt, rather than file order or import time.

`public-patrol/latest.json` is the disconnected public export, `UNAVAILABLE`, with unknown counts. No Return text or private application or hold history is imported. The initial structured opportunity contract supports CrowdWorks; other services are explicitly unsupported. Condition matching and security review remain separate, and neither authorizes an application.

## Shared offline builder

`build-collector-site.js` reads explicit local inputs once, validates them, and passes memory snapshots to the overview composer. It does not import the collector or scraper, invoke Git, call APIs or publish anything. Only validated public fields are rendered. The current summary and existing date archives retain their bytes and SHA256 hashes. The builder does not create a date archive or increment DAY. Invalid or overlapping inputs fail before writing output. The final public-artifact projector validates the staging directory again and rebuilds HTML and Markdown from the strict public JSON contract.

Both the daily workflow's publication preparation and the manual status-view workflow use this builder and projector. The daily collection command, stop gate, snapshot commit, permissions and schedule are unchanged. The status-view workflow is main-only and manual, with read-only contents permission, no persisted checkout credentials, and the existing Pages deployment permissions. It has no collection command, repository write, log retrieval, retry or schedule.

## Preservation and publication gates

Publication is blocked until a complete, restorable copy of the current Pages artifact is acquired through the existing authorized path. Reconstructing files from repository data is not a substitute for preserving the deployed artifact. The historical artifact download currently returns 404 and the artifact collection is empty. Complete restoration has therefore **not** been established; this connection must stay out of main and must not be published yet.

The workflows expect a separately reviewed `collector-preservation/manifest.json`, with kind `collector_preservation`, schema version 1, artifact ID, original artifact ZIP SHA256, and exact extracted file paths, byte lengths and SHA256 values. `collector-preservation/current/` must contain exactly `artifact.zip` and its `extracted/` files. The verifier checks actual bytes, complete enumeration, regular files, limits, path safety and concurrent changes. It does not extract the ZIP, authenticate the artifact source or prove ZIP-to-directory correspondence. Those provenance and restoration checks remain explicit release prerequisites. Before storing an actual backup in this public repository, separately verify the entire ZIP and all extracted contents are approved public material; the Pages allowlist does not restrict what a Git commit publishes. No production manifest or replacement backup is fabricated by tests.

Tests and preservation checks must succeed before build, upload and deploy. After projection, every date archive from the preserved deployed artifact must still have identical bytes and hashes in the new artifact. The status-only path also requires identical `latest.json` and exactly the same archive path set, so a repository-only date cannot silently become a newly published DAY. The daily path permits a new latest summary and date archives but cannot drop or alter a preserved archive. Both publishers share the existing Pages concurrency group. They compare the checked-out commit against current main before building and immediately before deployment; a stale checkout fails. The daily publisher uses actual Git HEAD, which includes its successful snapshot commit. A final independent Actions/artifact/public-page check is still required after a future authorized deployment. An uploaded artifact alone does not establish publication success.

## Validation and rollback

Artificial fixtures cover stopped searches and details, unknown timestamps, ordering and identity conflicts, strict projection, disconnected patrol, preservation mismatch and links, unchanged summary/archive hashes, and the common build-to-artifact path. No external job site is contacted. The test-only pull-request workflow runs Node 22, syntax checks and the complete test suite; it does not deploy or collect.

Before release, retain the exact original ZIP, a validated extracted baseline, restoration evidence and source commit. Rollback is a reviewed revert of the connection commit followed by re-publication of that preserved static artifact through the existing authorized Pages path. Reverting source alone does not restore the currently served Pages artifact. Do not expand permissions, bypass protections or collect new data to recover. The current missing backup blocks both release and a claim that rollback is ready.
