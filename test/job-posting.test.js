"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { extractJobDescription, extractJobPublicClient, fetchJobDetail } = require("../src/scraper");
const { runDaily } = require("../src/daily");

const URL = "https://crowdworks.jp/public/jobs/123";
const OTHER = "https://crowdworks.jp/public/jobs/456";
const EMPLOYER = "https://crowdworks.jp/public/employers/789";
const NOTICE = "<noscript>JavaScriptを有効にしてください。</noscript>";
const posting = (extra = {}) => ({ "@type": "JobPosting", url: URL,
  description: "Python CSV整理&lt;br&gt;AI利用可 報酬10,000円", hiringOrganization: { url: EMPLOYER }, ...extra });
const script = (data) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

test("supported root, graph and type arrays yield the same posting without network", (t) => {
  t.mock.method(global, "fetch", () => { throw new Error("unexpected_network"); });
  const p = posting();
  for (const data of [p, [p], { "@context": "https://schema.org", "@graph": [p] },
    { "@graph": p }, { "@graph": [{ "@type": "WebPage" }, { "@graph": [p] }] },
    posting({ "@type": ["Thing", "JobPosting"] }), posting({ "@type": "https://schema.org/JobPosting" }),
    posting({ "@type": "http://schema.org/JobPosting" })]) {
    assert.equal(extractJobDescription(script(data), URL), "Python CSV整理 AI利用可 報酬10,000円");
    assert.equal(extractJobPublicClient(script(data), URL).profileId, "789");
  }
});

test("detail extraction binds description and employer to the same requested posting", async (t) => {
  const unrelated = posting({ url: OTHER, description: "Unrelated description", hiringOrganization: { url: "https://crowdworks.jp/public/employers/456" } });
  const html = NOTICE + script({ "@graph": [unrelated, posting()] });
  let calls = 0;
  t.mock.method(global, "fetch", async (url, options) => {
    calls++; assert.equal(url, URL); assert.equal(options.redirect, "manual");
    return { ok: true, status: 200, url: URL, text: async () => html };
  });
  const result = await fetchJobDetail({ id: "123", url: URL, description: "search digest" });
  assert.equal(calls, 1);
  assert.equal(result.detailFetch.outcome, "success");
  assert.equal(result.description, "Python CSV整理 AI利用可 報酬10,000円");
  assert.equal(result.publicClient.profileId, "789");
  assert.equal(extractJobDescription(html), "");
  assert.equal(extractJobPublicClient(html), null);
});

test("a selected posting cannot borrow an employer from a different posting", () => {
  const html = script([posting({ url: OTHER }), posting({ hiringOrganization: undefined })]);
  assert.match(extractJobDescription(html, URL), /Python CSV/);
  assert.equal(extractJobPublicClient(html, URL), null);
});

test("single legacy posting without identity remains supported but multiple identity-less postings fail closed", () => {
  const legacy = posting({ url: undefined });
  assert.match(extractJobDescription(script(legacy), URL), /Python CSV/);
  for (const html of [script([legacy, posting()]), script(legacy) + script(legacy), script([legacy, posting({ url: OTHER })])]) {
    assert.equal(extractJobDescription(html, URL), "");
    assert.equal(extractJobPublicClient(html, URL), null);
  }
});

test("explicit mismatches, conflicting identities and duplicate matching postings are never confirmed", () => {
  const bad = [posting({ url: OTHER }), posting({ "@id": OTHER }), posting({ url: null }),
    posting({ url: "https://crowdworks.jp.evil.invalid/public/jobs/123" }),
    posting({ url: "https://crowdworks.jp/public/jobs/456/../123" }),
    [posting(), posting()], [posting(), posting({ url: null })]];
  for (const data of bad) {
    assert.equal(extractJobDescription(script(data), URL), "");
    assert.equal(extractJobPublicClient(script(data), URL), null);
  }
  assert.match(extractJobDescription(script(posting({ "@id": URL + "#posting" })), URL), /Python CSV/);
});

test("non-string, empty or unsupported description values never become detail success", async (t) => {
  for (const description of [null, true, 123, {}, { "@value": "Python" }, ["Python"], "", "   ", "<p></p>", "&#x110000;"]) {
    const html = script(posting({ description }));
    const mock = t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, url: URL, text: async () => html }));
    const result = await fetchJobDetail({ id: "123", url: URL, description: "search digest" });
    assert.equal(result.detailFetch.outcome, "extraction_failed");
    assert.equal(result.detailCheckedAt, undefined);
    assert.equal(result.description, "search digest");
    mock.mock.restore();
  }
});

test("malformed JSON, duplicate fields and misleading script attributes are not evidence", () => {
  for (const html of [
    '<script type="application/ld+json">{broken}</script>',
    '<script type="application/ld+json">{"@type":"JobPosting","description":"first","description":"second"}</script>',
    script(posting()).replace('type=', 'data-type='),
    script(posting()).replace('type=', 'type="text/plain" type='),
    `<!-- ${script(posting())} -->`, `<template>${script(posting())}</template>`,
    `<noscript>${script(posting())}</noscript>`
  ]) assert.equal(extractJobDescription(html, URL), "");
  assert.match(extractJobDescription('<script type="application/ld+json">broken</script>' + script(posting()), URL), /Python CSV/);
  assert.match(extractJobDescription(script(posting()).replace('type="application/ld+json"', "TYPE = 'application/ld+json'"), URL), /Python CSV/);
});

test("unsupported contexts, arbitrary nested properties and external references are not resolved", (t) => {
  t.mock.method(global, "fetch", () => { throw new Error("unexpected_network"); });
  for (const data of [
    { embedded: posting() }, { "@id": "https://example.invalid/posting" },
    posting({ "@context": "https://example.invalid/context" }),
    posting({ "@context": { "JobPosting": "https://example.invalid/Other" } }),
    posting({ "@context": null }), posting({ "@type": ["JobPosting", {}] })
  ]) assert.equal(extractJobDescription(script(data), URL), "");
});

test("quoted fake attributes and script-looking text in attributes or inert elements are not evidence", () => {
  const body = JSON.stringify(posting());
  const fake = `<script data-note=' type="application/ld+json"'>${body}</script>`;
  const samples = [fake, `<div data-example='${script(posting())}'></div>`,
    `<!DOCTYPE html PUBLIC '${script(posting())}'>`, `<![CDATA[${script(posting())}]]>`,
    ...["textarea", "style", "title", "xmp", "iframe", "noembed", "noframes", "svg", "math"]
      .map((tag) => `<${tag}>${script(posting())}</${tag}>`),
    `<template><template>${script(posting())}</template>${script(posting())}</template>`,
    `<div data-note='unclosed ${script(posting())}`,
    `<plaintext>${script(posting())}`];
  for (const html of samples) {
    assert.equal(extractJobDescription(html, URL), "", html);
    assert.equal(extractJobPublicClient(html, URL), null);
  }
  assert.match(extractJobDescription(`<div title='ordinary > < tag text'></div>${script(posting())}`, URL), /Python CSV/);
  assert.match(extractJobDescription(`<!DOCTYPE html>${script(posting())}`, URL), /Python CSV/);
  assert.match(extractJobDescription(script(posting({ description: "Python <!-- comment --> CSV" })), URL), /Python CSV/);
});

test("an organization context cannot redefine a confirmed profile URL", () => {
  for (const context of [null, { url: "https://example.invalid/not-url" }, "https://example.invalid/context", []]) {
    const html = script(posting({ hiringOrganization: { "@context": context, url: EMPLOYER } }));
    assert.match(extractJobDescription(html, URL), /Python CSV/);
    assert.equal(extractJobPublicClient(html, URL), null);
  }
  assert.equal(extractJobPublicClient(script(posting({ hiringOrganization: { "@context": "https://schema.org", url: EMPLOYER } })), URL).profileId, "789");
});

test("resource limits reject the whole input rather than selecting a truncated candidate", () => {
  let deep = posting(); for (let i = 0; i < 18; i++) deep = { "@graph": deep };
  for (const html of [script(deep), script([posting(), ...Array(256).fill({ "@type": "Thing" })]),
    script(posting()) + script({}).repeat(32), script(posting()) + " ".repeat(1024 * 1024)]) {
    assert.equal(extractJobDescription(html, URL), "");
    assert.equal(extractJobPublicClient(html, URL), null);
  }
});

test("CAPTCHA and HTTP access stops still dominate valid graph data with no second request", async (t) => {
  for (const [status, warning, reason] of [[200, '<div class="g-recaptcha" data-sitekey="synthetic"></div>', "captcha_required"],
    [401, "", "authentication_required"], [403, "", "access_denied"], [429, "", "rate_limited"]]) {
    let calls = 0;
    const mock = t.mock.method(global, "fetch", async (_, options) => {
      calls++; assert.equal(options.redirect, "manual");
      return { ok: status === 200, status, url: URL, text: async () => script({ "@graph": [posting()] }) + warning };
    });
    const result = await fetchJobDetail({ id: "123", url: URL });
    assert.equal(calls, 1);
    assert.equal(result.detailFetch.stopReason, reason);
    assert.equal(result.detailCheckedAt, undefined);
    mock.mock.restore();
  }
});

test("graph parsing does not change whole-run CAPTCHA stop, diagnostics or output preservation", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-parser-stop-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const subdir of ["site", "internal"]) {
    fs.mkdirSync(path.join(dir, subdir));
    fs.writeFileSync(path.join(dir, subdir, "latest.json"), '{"previous":"valid"}\n');
  }
  const search = `<div id="vue-container" data="${JSON.stringify({ searchResult: { job_offers: [123, 456, 789].map((id) => ({
    job_offer: { id, title: "Python CSV JSON API", description_digest: "Python CSV処理", expired_on: "2099-12-31" },
    payment: { fixed_price_payment: { min_budget: 10000 } }
  })) } }).replace(/"/g, "&quot;")}"></div>`;
  let calls = 0;
  t.mock.method(global, "fetch", async (url) => {
    calls++;
    return { ok: true, status: 200, url: String(url), text: async () => calls === 1 ? search
      : script({ "@graph": [posting({ url: String(url) })] }) + (calls === 3 ? "<p>CAPTCHA required</p>" : "") };
  });
  await assert.rejects(runDaily({ keywords: ["synthetic"], outputDir: path.join(dir, "site"), evidenceDir: path.join(dir, "internal") }), (error) => {
    assert.equal(error.diagnostics.aborted, true);
    assert.equal(error.diagnostics.details.succeeded, 1);
    assert.equal(error.diagnostics.events.at(-1).reason, "captcha_required");
    return true;
  });
  assert.equal(calls, 3);
  for (const subdir of ["site", "internal"]) {
    assert.deepEqual(fs.readdirSync(path.join(dir, subdir)), ["latest.json"]);
    assert.equal(fs.readFileSync(path.join(dir, subdir, "latest.json"), "utf8"), '{"previous":"valid"}\n');
  }
});
