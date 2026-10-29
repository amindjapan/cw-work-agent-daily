"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyAccessStop, fetchSearchPage, fetchJobDetail, isBlockedOrUnsupported } = require("../src/scraper");

const JOB = { id: "123", url: "https://crowdworks.jp/public/jobs/123", description: "search digest" };
const SEARCH_URL = "https://crowdworks.jp/public/jobs/search";
const NOTICE = "<noscript>JavaScriptを有効にしてください。ページを正しく表示できません。</noscript>";
const CODES = new Set(["access_denied", "authentication_required", "rate_limited", "captcha_required", "access_congestion", "protection_warning"]);

function searchHtml(ids = [123]) {
  const data = { searchResult: { job_offers: ids.map((id) => ({ job_offer: {
    id, title: "Python CSV データ整理", description_digest: "Python CSVを整理", expired_on: "2099-12-31"
  }, payment: { fixed_price_payment: { min_budget: 10000 } } })) } };
  return `<html>${NOTICE}<div id="vue-container" data="${JSON.stringify(data).replace(/"/g, "&quot;")}"></div></html>`;
}

function detailHtml() {
  return `<html>${NOTICE}<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting",
    description: "Python CSV整理&lt;br&gt;報酬10,000円" })}</script></html>`;
}

function stubResponse({ status = 200, html = "", url, location, throws = false } = {}) {
  let reads = 0;
  return { response: { ok: status >= 200 && status < 300, status, url,
    headers: { get: (name) => name.toLowerCase() === "location" ? location : null },
    text: async () => { reads++; if (throws) throw new Error("private-body-error-token=synthetic-only"); return html; } },
  reads: () => reads };
}

test("HTTP stop classifications are exact fixed codes and take priority over unreadable bodies", () => {
  for (const [status, expected] of [[401, "authentication_required"], [403, "access_denied"], [429, "rate_limited"]]) {
    assert.equal(classifyAccessStop(status, "CAPTCHA required ログインしてください"), expected);
    assert.equal(classifyAccessStop(status, null), expected);
  }
  for (const status of [null, undefined, "403", 403.5, 500, 302, 200]) assert.equal(classifyAccessStop(status, "ordinary page"), null);
});

test("HTTP200 access warnings are recognized in English and Japanese", () => {
  const warnings = [
    ["CAPTCHA required", "captcha_required"], ["CAPTCHA を完了してください", "captcha_required"],
    ["CAPTCHA 認証してください", "captcha_required"], ["CAPTCHA", "captcha_required"],
    ["CAPTCHA challenge", "captcha_required"], ["Please complete the CAPTCHA", "captcha_required"],
    ["画像認証を入力してください", "captcha_required"], ["私はロボットではありません", "captcha_required"],
    ["Verify that you are human", "captcha_required"], ["Please log in", "authentication_required"],
    ["Sign in to continue", "authentication_required"], ["Authentication is required", "authentication_required"],
    ["ログインしてください", "authentication_required"], ["ログインが必要です", "authentication_required"],
    ["Too many requests", "rate_limited"], ["Rate limit exceeded", "rate_limited"],
    ["リクエストが多すぎます", "rate_limited"], ["アクセスが集中しています", "access_congestion"],
    ["現在サーバーが混み合っています", "access_congestion"], ["Service temporarily busy", "access_congestion"],
    ["High traffic", "access_congestion"], ["Access denied", "protection_warning"],
    ["Access temporarily blocked", "protection_warning"], ["Your request blocked", "protection_warning"],
    ["アクセスが一時的に制限されています", "protection_warning"], ["不正アクセスを検知しました", "protection_warning"],
    ["Checking your browser", "protection_warning"], ["Enable JavaScript and cookies to continue", "protection_warning"],
    ["JavaScriptとCookieを有効にして続行してください", "protection_warning"]
  ];
  for (const [html, expected] of warnings) {
    const result = classifyAccessStop(200, `<html><p>${html}</p></html>`);
    assert.equal(result, expected, html);
    assert.equal(CODES.has(result), true);
  }
});

test("warning entity decoding does not expose original text or throw for malformed numeric entities", () => {
  assert.equal(classifyAccessStop(200, "&#67;&#65;&#80;&#84;&#67;&#72;&#65; required"), "captcha_required");
  assert.equal(classifyAccessStop(200, "&#x30ED;&#x30B0;&#x30A4;&#x30F3;してください"), "authentication_required");
  assert.equal(classifyAccessStop(200, "Please&nbsp;log&#32;in"), "authentication_required");
  for (const prefix of ["&amp;#x110000;", "&#38;#x110000;", "&#38;#999999999999999999;", "&#x26;#xD800;"]) {
    assert.equal(classifyAccessStop(200, `${prefix} CAPTCHA required`), "captcha_required");
    assert.equal(classifyAccessStop(200, `${prefix} ログインしてください`), "authentication_required");
  }
  for (const html of ["&#9999999999999999999; ordinary", "&#x110000; ordinary", "&#xD800; ordinary", null, {}]) {
    assert.equal(classifyAccessStop(200, html), null);
  }
});

test("a normal login link or JavaScript fallback alone is not an explicit access stop", () => {
  for (const html of [NOTICE, "Please enable JavaScript", "JavaScript is required", "<a href='/login'>ログイン</a>",
    "<script>const captcha = 'not a visible challenge';</script>", "<p>ordinary job listing</p>"]) {
    assert.equal(classifyAccessStop(200, html), null);
  }
  assert.equal(isBlockedOrUnsupported(200, NOTICE), true);
  assert.equal(isBlockedOrUnsupported(200, "Please enable JavaScript"), true);
  for (const html of [searchHtml([123]), searchHtml([]), detailHtml()]) assert.equal(isBlockedOrUnsupported(200, html), false);
});

test("login destinations are detected from path segments without interpreting query values", () => {
  for (const url of ["https://crowdworks.jp/login", "https://crowdworks.jp/login?return_to=%2Fpublic%2Fjobs",
    "https://crowdworks.jp/users/sign_in", "https://crowdworks.jp/auth/login", "https://crowdworks.jp/sessions/new",
    "https://crowdworks.jp/%6cogin"]) assert.equal(classifyAccessStop(302, "", url), "authentication_required", url);
  for (const url of [SEARCH_URL, `${SEARCH_URL}?next=/login`, "https://crowdworks.jp/public/jobs/123", "malformed url", null]) {
    assert.equal(classifyAccessStop(200, "", url), null);
  }
});

test("search and detail stop HTTP401403429 before reading a throwing response body", async (t) => {
  for (const [status, reason] of [[401, "authentication_required"], [403, "access_denied"], [429, "rate_limited"]]) {
    const fixture = stubResponse({ status, throws: true });
    const requests = [];
    const mock = t.mock.method(global, "fetch", async (url, options) => {
      requests.push({ url: String(url), redirect: options.redirect }); return fixture.response;
    });
    const search = await fetchSearchPage({ keywords: "CSV" });
    assert.equal(search.status, status);
    assert.equal(search.stopReason, reason);
    assert.equal(search.needsManualImport, true);
    assert.equal(search.html, "");
    const detail = await fetchJobDetail(JOB);
    assert.deepEqual(detail.detailFetch, { ok: false, status, outcome: "fetch_failed", stopReason: reason });
    assert.equal(detail.description, JOB.description);
    assert.equal(fixture.reads(), 0);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.redirect === "manual"));
    assert.doesNotMatch(JSON.stringify([search, detail.detailFetch]), /private-body-error-token/);
    mock.mock.restore();
  }
});

test("manual login redirects stop without reading the body or following another URL", async (t) => {
  for (const location of ["/login?private-return=fixture", "https://crowdworks.jp/users/sign_in"]) {
    const fixture = stubResponse({ status: 302, url: SEARCH_URL, location, throws: true });
    const requests = [];
    const mock = t.mock.method(global, "fetch", async (url, options) => {
      requests.push([String(url), options.redirect]); return fixture.response;
    });
    const search = await fetchSearchPage({ keywords: "CSV" });
    const detail = await fetchJobDetail(JOB);
    assert.equal(search.stopReason, "authentication_required");
    assert.equal(search.needsManualImport, true);
    assert.equal(detail.detailFetch.stopReason, "authentication_required");
    assert.equal(fixture.reads(), 0);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(([, redirect]) => redirect === "manual"));
    assert.doesNotMatch(JSON.stringify([search.stopReason, detail.detailFetch]), /private-return/);
    mock.mock.restore();
  }
});

test("an already redirected login response URL is still an authentication stop", async (t) => {
  const fixture = stubResponse({ status: 200, url: "https://crowdworks.jp/login", throws: true });
  t.mock.method(global, "fetch", async () => fixture.response);
  assert.equal((await fetchSearchPage({ keywords: "CSV" })).stopReason, "authentication_required");
  assert.equal((await fetchJobDetail(JOB)).detailFetch.stopReason, "authentication_required");
  assert.equal(fixture.reads(), 0);
});

test("a nonlogin redirect does not cause another request or invent an authentication stop", async (t) => {
  const fixture = stubResponse({ status: 301, location: "/public/jobs/search/", html: "Moved" });
  let calls = 0;
  t.mock.method(global, "fetch", async (_, options) => { calls++; assert.equal(options.redirect, "manual"); return fixture.response; });
  const result = await fetchSearchPage({ keywords: "CSV" });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, null);
  assert.equal(calls, 1);
});

test("normal verified listings, verified zero and detail JobPosting retain JavaScript fallback compatibility", async (t) => {
  for (const html of [searchHtml([123]), searchHtml([])]) {
    const fixture = stubResponse({ html });
    const mock = t.mock.method(global, "fetch", async () => fixture.response);
    const result = await fetchSearchPage({ keywords: "CSV" });
    assert.equal(result.ok, true);
    assert.equal(result.stopReason, null);
    assert.equal(result.needsManualImport, false);
    assert.equal(fixture.reads(), 1);
    mock.mock.restore();
  }
  const fixture = stubResponse({ html: detailHtml() });
  t.mock.method(global, "fetch", async () => fixture.response);
  const result = await fetchJobDetail(JOB);
  assert.deepEqual(result.detailFetch, { ok: true, status: 200, outcome: "success", stopReason: null });
  assert.equal(result.contentSources.description, "detail");
  assert.match(result.description, /Python CSV整理 報酬10,000円/);
});

test("HTTP200 warning pages retain fixed stop codes even alongside valid listing or detail markers", async (t) => {
  for (const [warning, reason] of [["CAPTCHA required", "captcha_required"], ["ログインしてください", "authentication_required"],
    ["アクセスが集中しています", "access_congestion"], ["Access temporarily blocked", "protection_warning"]]) {
    let html = `${searchHtml()}<p>${warning}</p>`;
    const mock = t.mock.method(global, "fetch", async () => stubResponse({ html }).response);
    const search = await fetchSearchPage({ keywords: "CSV" });
    assert.equal(search.stopReason, reason);
    assert.equal(search.needsManualImport, true);
    html = `${detailHtml()}<p>${warning}</p>`;
    const detail = await fetchJobDetail(JOB);
    assert.equal(detail.detailFetch.stopReason, reason);
    assert.equal(detail.detailFetch.outcome, "fetch_failed");
    assert.equal(detail.detailCheckedAt, undefined);
    mock.mock.restore();
  }
});

test("malformed entities cannot downgrade explicit search or detail warnings to read failures", async (t) => {
  for (const prefix of ["&amp;#x110000;", "&#38;#x110000;", "&#38;#999999999999999999;"]) {
    let html = `${searchHtml()}<p>${prefix} CAPTCHA required</p>`;
    const mock = t.mock.method(global, "fetch", async () => stubResponse({ html }).response);
    const search = await fetchSearchPage({ keywords: "CSV" });
    assert.equal(search.stopReason, "captcha_required");
    assert.equal(search.needsManualImport, true);
    html = `${detailHtml()}<p>${prefix} CAPTCHA required</p>`;
    const detail = await fetchJobDetail(JOB);
    assert.equal(detail.detailFetch.stopReason, "captcha_required");
    assert.equal(detail.detailFetch.outcome, "fetch_failed");
    assert.equal(detail.detailCheckedAt, undefined);
    mock.mock.restore();
  }
});

test("active CAPTCHA widgets and provider challenge iframes stop both fetch stages without visible warning text", async (t) => {
  const challenges = [
    '<form><div class="g-recaptcha" data-sitekey="synthetic"></div></form>',
    "<div data-sitekey='synthetic' class='other h-captcha'></div>",
    '<div data-sitekey="synthetic" class="g&#45;recaptcha"></div>',
    '<iframe src="https://www.google.com/recaptcha/api2/anchor?k=synthetic"></iframe>',
    '<iframe src="https://newassets.hcaptcha.com/captcha/v1/synthetic/static/hcaptcha.html"></iframe>',
    '<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/synthetic"></iframe>'
  ];
  for (const challenge of challenges) {
    assert.equal(classifyAccessStop(200, challenge), "captcha_required");
    let html = `${searchHtml()}${challenge}`;
    const mock = t.mock.method(global, "fetch", async () => stubResponse({ html }).response);
    const search = await fetchSearchPage({ keywords: "CSV" });
    assert.equal(search.stopReason, "captcha_required");
    assert.equal(search.needsManualImport, true);
    html = `${detailHtml()}${challenge}`;
    const detail = await fetchJobDetail(JOB);
    assert.equal(detail.detailFetch.stopReason, "captcha_required");
    assert.equal(detail.detailFetch.outcome, "fetch_failed");
    mock.mock.restore();
  }
});

test("passive CAPTCHA libraries, widget examples and unrecognized iframe sources are not active challenges", () => {
  for (const html of [
    '<script src="https://www.google.com/recaptcha/api.js"></script>',
    '<script>const example = `<div class="g-recaptcha" data-sitekey="synthetic"></div>`;</script>',
    '<!-- <div class="h-captcha" data-sitekey="synthetic"></div> -->',
    '<template><div class="h-captcha" data-sitekey="synthetic"></div></template>',
    '&lt;div class="g-recaptcha" data-sitekey="synthetic"&gt;&lt;/div&gt;',
    '<div class="g-recaptcha-example" data-sitekey="synthetic"></div>',
    '<div class="h-captcha"></div>',
    '<iframe src="https://www.google.com.evil.invalid/recaptcha/api2/anchor"></iframe>',
    '<iframe src="https://www.google.com/recaptcha/api.js"></iframe>'
  ]) assert.equal(classifyAccessStop(200, html), null, html);
});

test("normal CAPTCHA integration and login feature job descriptions never become access stops", async (t) => {
  const descriptions = [
    "CAPTCHA integration and login feature development using Python.",
    "Build a CAPTCHA verification component and a login feature.",
    "CAPTCHA challenge page development and authentication UI implementation.",
    "ログイン機能とCAPTCHA認証連携を開発します。Python CSVの整理も含みます。",
    "CAPTCHAの実装と画像認証の入力フォームを開発する案件です。",
    "人間であることを確認する機能の開発とログイン画面の改修。"
  ];
  for (const description of descriptions) {
    assert.equal(classifyAccessStop(200, `<p>${description}</p>`), null, description);
    let html = `${searchHtml()}<p>${description}</p>`;
    const mock = t.mock.method(global, "fetch", async () => stubResponse({ html }).response);
    const search = await fetchSearchPage({ keywords: "CSV" });
    assert.equal(search.stopReason, null);
    assert.equal(search.needsManualImport, false);
    html = `<html>${NOTICE}<p>${description}</p><script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting", description
    })}</script></html>`;
    const detail = await fetchJobDetail(JOB);
    assert.equal(detail.detailFetch.stopReason, null);
    assert.equal(detail.detailFetch.outcome, "success");
    assert.equal(detail.description, description);
    html = `${html}<p>CAPTCHA 認証してください</p>`;
    const challenged = await fetchJobDetail(JOB);
    assert.equal(challenged.detailFetch.stopReason, "captcha_required");
    assert.equal(challenged.detailFetch.outcome, "fetch_failed");
    mock.mock.restore();
  }
});

test("unsupported JavaScript-only pages and ordinary read failures never invent explicit access stops", async (t) => {
  let fixture = stubResponse({ html: NOTICE });
  t.mock.method(global, "fetch", async () => fixture.response);
  const unsupported = await fetchSearchPage({ keywords: "CSV" });
  assert.equal(unsupported.needsManualImport, true);
  assert.equal(unsupported.stopReason, null);
  assert.equal((await fetchJobDetail(JOB)).detailFetch.stopReason, null);
  fixture = stubResponse({ throws: true });
  await assert.rejects(fetchSearchPage({ keywords: "CSV" }), { message: "response_body_read_failed", status: 200 });
  await assert.rejects(fetchJobDetail(JOB), { message: "response_body_read_failed", status: 200 });
});

test("body-read failures preserve only a sanitized known numeric HTTP status", async (t) => {
  for (const status of [100, 200, 299, 302, 500, 599, null, undefined, "200", NaN, 600, 0, -1, 200.5]) {
    const fixture = stubResponse({ throws: true });
    fixture.response.status = status;
    const mock = t.mock.method(global, "fetch", async () => fixture.response);
    const expectedStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    for (const operation of [() => fetchSearchPage({ keywords: "CSV" }), () => fetchJobDetail(JOB)]) {
      await assert.rejects(operation(), (error) => {
        assert.equal(error.message, "response_body_read_failed");
        assert.equal(error.status, expectedStatus);
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(String(error), /private-body-error-token/);
        return true;
      });
    }
    mock.mock.restore();
  }
});
