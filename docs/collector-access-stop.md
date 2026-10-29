# Collector access stops and diagnostics

The Collector stops the entire invocation when a search or detail response reports
HTTP 401, 403 or 429, a login requirement, CAPTCHA, access congestion or an explicit
access protection warning. These conditions use fixed reason codes:
`authentication_required`, `access_denied`, `rate_limited`, `captcha_required`,
`access_congestion` and `protection_warning`.

No subsequent search or detail request is made after a stop is detected. The
Collector does not switch routes or user agents, sleep, or retry. HTTP redirects
are not followed automatically. A recognized login redirect is an authentication
stop; other redirects remain unsuccessful HTTP responses. Verified listings or
JobPosting data can coexist with an ordinary JavaScript fallback notice. Such a
notice alone does not constitute an access stop, and unverified content still
cannot establish a successful or empty search.

An access stop throws before saving any report, snapshot, client review or private
candidate record. The CLI prints sanitized diagnostics and exits with status 1.
The existing production workflow requires this step to succeed before snapshot
copying, Git commits and Pages publication. Previous valid output files therefore
remain unchanged on an access stop. No workflow schedule or permission changes
are required.

CLI diagnostics contain only fixed kind/schema/stage/reason values, HTTP status,
an aborted flag and numeric attempt counters. They exclude HTML, page text,
identifiers, titles, queries, URLs, cookies, tokens and arbitrary exception text
or stack traces. Search counters include all planned keywords. Detail counters
refer only to jobs observed before the stop; jobs from unattempted searches are
unknown, not zero. The difference between the total and attempted count is
`notAttempted`. No aborted summary is published, and its partial observations
must not be treated as a complete collection.

Normal observed zero, failed extraction, ordinary unsuccessful HTTP responses
and network exceptions remain distinct diagnostic outcomes. Those conditions
retain the existing partial/unknown collection behavior. An unexpected CLI error
uses the fixed `collector_failed` reason. A diagnostics line emitted before a
later persistence failure describes retrieval only; the CLI exit status remains
the authority for completion.

Tests use synthetic responses and isolated temporary directories, including real
CLI subprocesses whose fetch function is replaced before loading the Collector.
The workflow gate is checked from its source; no production run is started by
these tests. Offline/CI success does not prove live site behavior or operational
access. Private storage opt-in, CI prohibition, retention caps, synthetic-only
Drive adapter, recommendation evidence and public projection remain unchanged.
Warning detection uses explicit text and known challenge markup, rather than a
live browser. New site warning formats and possible conservative false positives
remain operational limitations. A stop must be reviewed without automatic retry.

Rollback consists of reverting this change commit after review. No existing
snapshots or past evidence need to be deleted, and no settings need to be changed.
