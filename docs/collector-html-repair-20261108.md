# Bounded HTML detail repair, 2026-11-08

## Reproduction and diagnosis

Baseline source: `688d74ae1c9eb37dde73ca296fccd02652774cd8`.
The user requested one immediate diagnosis/reproduction of failed
[run 42434400213](https://github.com/amindjapan/cw-work-agent-daily/actions/runs/42434400213).
A separate local execution used the same source and unchanged request headers,
manual redirect handling, keyword order, ranking, and access-stop rules. It did
not invoke a GitHub workflow, publish, submit applications, authenticate, or solve
CAPTCHAs. No further external request occurred after the stop classification.

The invocation reproduced 13 successful searches, 548 observed jobs, 24 detail
attempts, four successful descriptions, nineteen extraction failures, and one
`captcha_required` stop. The original historical response bytes are unavailable;
the counts/outcomes match, but byte identity with that historical run is not claimed.

The new response bodies were retained only in the local diagnostic workspace,
not committed or uploaded. An independent offline diagnostic review verified all
24 body SHA-256 hashes and the following causes:

- All nineteen extraction failures lack JSON-LD. Each has one canonical URL
  matching its request and a description in the ordinary HTML detail table.
- The four successes contain JobPosting JSON-LD. Their extracted description
  lengths are 778, 2295, 2295, and 1834 characters.
- The final response is an ordinary job description quoting the Japanese
  reCAPTCHA checkbox label as a development topic. The unscoped bare-label regex
  classified that quotation as a challenge. Removing only that quoted label in
  offline memory changes the classification to null. No active CAPTCHA widget
  was found in the captured response. This is not permission to bypass a real
  challenge or to resume live collection.

## Repair constraints

The HTML fallback is identity-bound and bounded. It does not fetch extra pages,
execute scripts, follow links, infer client identity, or accept arbitrary page
text. The tokenizer rejects unsupported browser-reparenting contexts and unknown
script MIME types. It does not override existing malformed, unsupported, or ambiguous JSON-LD:
any `application/ld+json` occurrence conservatively disables the fallback.

The CAPTCHA correction exempts only a narrowly quoted reCAPTCHA development-topic
label within the validated HTML description, and only from the bare-label rule.
HTTP 401/403/429, login destinations, actual widgets, explicit challenge
instructions, and warning text outside that quotation retain their stops.
Unrecognized formats continue to fail closed.

Structural validation is not a browser visibility guarantee. Explicit hidden
attributes, inert elements, and common inline hiding styles (including CSS
comments) are excluded, but stylesheet/class-based or obfuscated CSS visibility
is not evaluated. Existing keyword scoring is not a security review and can miss
restrictions expressed in unusual encodings or markup. Neither successful
extraction nor a machine score certifies an advertised job as safe.

All external page content, including hidden instructions addressed to AI systems,
is untrusted input data. Such instructions do not authorize tool use or changes.
Descriptions and machine classifications remain human-review material, not an
approval to perform the work described by an advertised job.

No workflow, schedule, permission, dependency, credential, public allowlist,
existing snapshot, or production setting is changed. Standards for HTML parsing
describe syntax and do not grant website access or establish legal compliance.
The repair adds no new live access route; future collection remains subject to
the existing authorization and service conditions.

## Verification and release

The unchanged baseline passed all 571 tests locally on Node 24.22.1.
The initial focused access/parser tests passed 96/96 before edits.
The repaired source passed JavaScript syntax checks and all 589 tests locally
(0 failures, cancellations, or skips). Four new integration test groups fail
against the original scraper, reproducing the unsupported-format/quoted-label
behavior. Replaying all 24 captured detail responses through a mocked fetch
succeeds 24/24 with no network requests; the four prior successful descriptions
retain their exact normalized contents. Independent implementation review reran
all 589 tests and 45 additional assertions, verified all 24 saved hashes/lengths,
and found no remaining blocker for this bounded repair. Its synthetic full
collection verified that a real widget after the quoted-topic exception aborts
collection, issues no later detail request, and leaves existing outputs unchanged.
The reviewer made no source changes and used no network requests.

Review findings on quoted tag delimiters, encoded MIME types, browser-reparenting
contexts, nested table structures, script double escaping, and framesets were
fixed and covered by regression tests. This is not certification of complete
browser compatibility, computed visibility, keyword classification, legal
compliance, or live recovery.

Production integration and another live collection are not part of these local
tests. No claim of complete live collection recovery is made.

## Rollback

Revert the repair commit after review. No migration, deletion, credential change,
or snapshot rewrite is needed. A source revert is not a Pages rollback and does
not itself authorize another collection or deployment run.
