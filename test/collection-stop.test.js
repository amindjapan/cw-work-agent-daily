"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runDaily } = require("../src/daily");
const { diagnosticEvent } = require("../src/collection-diagnostics");

const SEARCH = `<div id="vue-container" data="${JSON.stringify({ searchResult: { job_offers: [123, 456].map((id) => ({
  job_offer: { id, title: "Python CSV JSON API", description_digest: "Python CSV processing with Excel output",
    expired_on: "2099-12-31" }, payment: { fixed_price_payment: { min_budget: 10000 } }
})) } }).replace(/"/g, "&quot;")}"></div>`;
const EMPTY = '<div id="vue-container" data="{&quot;searchResult&quot;:{&quot;job_offers&quot;:[]}}"></div>';
const DETAIL = '<script type="application/ld+json">{"@type":"JobPosting","description":"Python CSV processing with Excel output"}</script>';
const PRIVATE_TEXT = "SYNTHETIC_PRIVATE_MARKER cookie=fixture-token user@example.invalid";
const STOPS = [
  [401, "", "authentication_required"], [403, "", "access_denied"], [429, "", "rate_limited"],
  [200, "CAPTCHA required", "captcha_required"], [200, "ログインしてください", "authentication_required"],
  [200, "アクセスが集中しています", "access_congestion"],
  [200, "Access temporarily blocked", "protection_warning"],
  [200, "&amp;#x110000; CAPTCHA required", "captcha_required"],
  [200, "&#38;#x110000; CAPTCHA required", "captcha_required"],
  [200, '<form><div class="g-recaptcha" data-sitekey="synthetic"></div></form>', "captcha_required"],
  [200, '<form><div class="h-captcha" data-sitekey="synthetic"></div></form>', "captcha_required"]
];

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-stop-synthetic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const stage of ["search", "detail"]) {
  test(`${stage} stops after partial success without saving partial results`, async (t) => {
    const dir = directory(t);
    seed(dir);
    let searches = 0;
    let details = 0;
    t.mock.method(global, "fetch", async (url) => {
      const target = new URL(url);
      const search = target.pathname === "/public/jobs/search";
      if (search) searches++; else details++;
      const stop = stage === "search" ? searches === 2 : !search && details === 2;
      return { ok: !stop, status: stop ? 403 : 200, url: target.toString(),
        text: async () => search ? SEARCH : DETAIL };
    });
    await assert.rejects(runDaily({ keywords: ["one", "two", "three"], outputDir: path.join(dir, "site"),
      evidenceDir: path.join(dir, "internal") }), (error) => {
      assert.equal(error.diagnostics.aborted, true);
      if (stage === "search") {
        assert.equal(error.diagnostics.search.succeeded, 1);
        assert.equal(error.diagnostics.search.notAttempted, 1);
        assert.equal(error.diagnostics.details.observed, 2);
        assert.equal(error.diagnostics.details.notAttempted, 2);
      } else {
        assert.equal(error.diagnostics.details.succeeded, 1);
        assert.equal(error.diagnostics.details.failed, 1);
      }
      return true;
    });
    assert.equal(searches, stage === "search" ? 2 : 3);
    assert.equal(details, stage === "search" ? 0 : 2);
    assertUnchanged(dir);
  });
}

for (const stage of ["search", "detail"]) {
  for (const status of [401, 403, 429]) {
    test(`${stage} ${status} stops even when reading the response body would throw`, async (t) => {
      const dir = directory(t);
      let requests = 0;
      let blockedBodyReads = 0;
      t.mock.method(global, "fetch", async (url) => {
        const search = new URL(url).pathname === "/public/jobs/search";
        const stop = stage === "search" || !search;
        requests++;
        return { ok: !stop, status: stop ? status : 200, text: async () => {
          if (stop) { blockedBodyReads++; throw new Error(PRIVATE_TEXT); }
          return SEARCH;
        } };
      });
      await assert.rejects(runDaily({ keywords: ["one", "two"], outputDir: path.join(dir, "site"),
        evidenceDir: path.join(dir, "internal") }), (error) => error.name === "CollectionAbortedError");
      assert.equal(requests, stage === "search" ? 1 : 3);
      assert.equal(blockedBodyReads, 0);
      assert.deepEqual(fs.readdirSync(dir), []);
    });
  }
}

function seed(dir) {
  for (const subdir of ["site", "internal"]) {
    fs.mkdirSync(path.join(dir, subdir));
    fs.writeFileSync(path.join(dir, subdir, "latest.json"), '{"previous":"valid"}\n');
  }
}

function assertUnchanged(dir) {
  for (const subdir of ["site", "internal"]) {
    assert.deepEqual(fs.readdirSync(path.join(dir, subdir)), ["latest.json"]);
    assert.equal(fs.readFileSync(path.join(dir, subdir, "latest.json"), "utf8"), '{"previous":"valid"}\n');
  }
}

function assertDiagnostic(diagnostic, stage, status, reason) {
  assert.equal(diagnostic.aborted, true);
  assert.deepEqual(diagnostic.events.at(-1), { stage, httpStatus: status, reason });
  assert.equal(diagnostic.search.planned, 3);
  if (stage === "search") {
    assert.deepEqual(diagnostic.search, { planned: 3, attempted: 1, succeeded: 0, failed: 1, notAttempted: 2 });
    assert.deepEqual(diagnostic.details, { observed: 0, attempted: 0, succeeded: 0, failed: 0, notAttempted: 0 });
  } else {
    assert.deepEqual(diagnostic.search, { planned: 3, attempted: 3, succeeded: 3, failed: 0, notAttempted: 0 });
    assert.deepEqual(diagnostic.details, { observed: 2, attempted: 1, succeeded: 0, failed: 1, notAttempted: 1 });
  }
  assert.doesNotMatch(JSON.stringify(diagnostic), /SYNTHETIC_PRIVATE_MARKER|cookie|token|example|Python|CSV|public\/jobs|stack|cause/);
}

for (const stage of ["search", "detail"]) {
  for (const [status, warning, reason] of STOPS) {
    test(`${stage} ${reason} stops the invocation before the next request or any save`, async (t) => {
      const dir = directory(t);
      seed(dir);
      const requests = [];
      t.mock.method(global, "fetch", async (url) => {
        const target = new URL(url);
        requests.push(target.pathname);
        const isSearch = target.pathname === "/public/jobs/search";
        const stop = stage === "search" || !isSearch;
        return { ok: !stop || status === 200, status: stop ? status : 200, url: target.toString(),
          text: async () => stop ? `<html>${warning} ${PRIVATE_TEXT}</html>` : SEARCH };
      });
      await assert.rejects(runDaily({ keywords: ["one", "two", "three"], outputDir: path.join(dir, "site"),
        evidenceDir: path.join(dir, "internal") }), (error) => {
        assert.equal(error.name, "CollectionAbortedError");
        assert.equal(error.message, "collector_access_aborted");
        assertDiagnostic(error.diagnostics, stage, status, reason);
        return true;
      });
      assert.equal(requests.length, stage === "search" ? 1 : 4);
      assertUnchanged(dir);
    });
  }
}

test("a detail access stop cannot be hidden by a mismatched returned job identity", async (t) => {
  const dir = directory(t);
  let calls = 0;
  await assert.rejects(runDaily({ keywords: ["one"], outputDir: path.join(dir, "site"), evidenceDir: path.join(dir, "internal"),
    fetchSearchPage: async () => ({ ok: true, status: 200, html: SEARCH }),
    fetchJobDetail: async () => { calls++; return { id: "999", url: "https://crowdworks.jp/public/jobs/999",
      detailFetch: { ok: false, status: 429, outcome: "fetch_failed" } }; }
  }), (error) => error.diagnostics.events.at(-1).reason === "rate_limited");
  assert.equal(calls, 1);
  assert.deepEqual(fs.readdirSync(dir), []);
});

for (const stage of ["search", "detail"]) {
  test(`${stage} exceptions with explicit denial status stop without logging their text`, async (t) => {
    for (const status of [401, 403, 429]) {
      const dir = directory(t);
      let requests = 0;
      const fail = async () => { requests++; throw Object.assign(new Error(PRIVATE_TEXT), { status }); };
      await assert.rejects(runDaily({ keywords: ["one", "two"], outputDir: path.join(dir, "site"), evidenceDir: path.join(dir, "internal"),
        fetchSearchPage: stage === "search" ? fail : async () => ({ ok: true, status: 200, html: SEARCH }),
        fetchJobDetail: fail }), (error) => {
        assert.equal(error.diagnostics.aborted, true);
        assert.equal(error.diagnostics.events.at(-1).httpStatus, status);
        assert.doesNotMatch(JSON.stringify(error.diagnostics), /SYNTHETIC_PRIVATE_MARKER|cookie|token|example/);
        return true;
      });
      assert.equal(requests, 1);
      assert.deepEqual(fs.readdirSync(dir), []);
    }
  });
}

test("response body read errors preserve the known status and use only network failure diagnostics", async (t) => {
  for (const stage of ["search", "detail"]) {
    const dir = directory(t);
    let diagnostic;
    const mock = t.mock.method(global, "fetch", async (url) => {
      const search = new URL(url).pathname === "/public/jobs/search";
      return { ok: true, status: 200, text: async () => {
        if (stage === "search" || !search) throw new Error(PRIVATE_TEXT);
        return SEARCH;
      } };
    });
    await runDaily({ keywords: ["one"], outputDir: path.join(dir, "site"), evidenceDir: path.join(dir, "internal"),
      onDiagnostics: (value) => { diagnostic = value; } });
    assert.equal(diagnostic.aborted, false);
    assert.equal(diagnostic.events.at(-1).reason, "network_failed");
    assert.equal(diagnostic.events.at(-1).httpStatus, 200);
    assert.doesNotMatch(JSON.stringify(diagnostic), /SYNTHETIC_PRIVATE_MARKER|cookie|token|example/);
    mock.mock.restore();
  }
});

test("normal zero, extraction failure, HTTP failure and network failure have distinct safe diagnostics", async (t) => {
  for (const [kind, status, html, expected] of [["zero", 200, EMPTY, "success"],
    ["parse", 200, "<html>unrecognized</html>", "extraction_failed"],
    ["http", 500, "<html>unavailable</html>", "http_failed"], ["network", null, "", "network_failed"]]) {
    const dir = directory(t);
    let diagnostic;
    const report = await runDaily({ keywords: [PRIVATE_TEXT], outputDir: path.join(dir, "site"), evidenceDir: path.join(dir, "internal"),
      fetchSearchPage: async () => { if (kind === "network") throw new Error(PRIVATE_TEXT);
        return { ok: status === 200, status, html }; }, onDiagnostics: (value) => { diagnostic = value; } });
    assert.equal(diagnostic.aborted, false);
    assert.equal(diagnostic.events[0].reason, expected);
    assert.equal(report.totalJobs, kind === "zero" ? 0 : null);
    assert.doesNotMatch(JSON.stringify(diagnostic), /SYNTHETIC_PRIVATE_MARKER|example|cookie|token/);
  }
});

test("diagnostic event rejects arbitrary stage, HTTP and reason values", () => {
  assert.deepEqual(diagnosticEvent(PRIVATE_TEXT, "429", PRIVATE_TEXT),
    { stage: "collector", httpStatus: null, reason: "collector_failed" });
});

for (const stage of ["search", "detail"]) {
  test(`real CLI ${stage} abort exits nonzero, logs allowlisted diagnostics and leaves old files intact`, (t) => {
    const dir = directory(t);
    seed(dir);
    const preload = path.join(dir, "synthetic-preload.cjs");
    const calls = path.join(dir, "requests.json");
    fs.writeFileSync(preload, `"use strict";
const fs = require("node:fs");
const requests = [];
global.fetch = async (url) => {
  const target = new URL(url); requests.push(target.pathname);
  fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify(requests));
  const search = target.pathname === "/public/jobs/search";
  const stop = ${JSON.stringify(stage)} === "search" || !search;
  return { ok: !stop, status: stop ? 429 : 200, url: target.toString(),
    text: async () => stop ? ${JSON.stringify(PRIVATE_TEXT)} : ${JSON.stringify(SEARCH)} };
};
`);
    const result = spawnSync(process.execPath, ["--require", preload, path.join(__dirname, "../src/daily.js"),
      "--output", path.join(dir, "site"), "--evidence-output", path.join(dir, "internal")], { encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const diagnostic = JSON.parse(result.stderr.trim());
    assert.equal(diagnostic.aborted, true);
    assert.equal(diagnostic.events.at(-1).reason, "rate_limited");
    assert.equal(diagnostic.events.at(-1).stage, stage);
    assert.doesNotMatch(result.stderr, /SYNTHETIC_PRIVATE_MARKER|cookie|token|example|Error:|stack|[A-Z]:\\/);
    const requests = JSON.parse(fs.readFileSync(calls, "utf8"));
    assert.equal(requests.length, stage === "search" ? 1 : 14);
    assertUnchanged(dir);
  });
}

test("CLI unexpected failures never print exception text or an absolute input path", (t) => {
  const dir = directory(t);
  const preload = path.join(dir, "deny-network.cjs");
  fs.writeFileSync(preload, 'global.fetch = async () => { throw new Error("synthetic_network_disabled"); };\n');
  const result = spawnSync(process.execPath, ["--require", preload, path.join(__dirname, "../src/daily.js"),
    "--public-histories", path.join(dir, PRIVATE_TEXT)], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), { kind: "collector_error", stage: "collector", httpStatus: null, reason: "collector_failed" });
  assert.equal(result.stdout, "");
});

test("production workflow gates snapshot and Pages steps behind the CLI success", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "../.github/workflows/daily.yml"), "utf8");
  const daily = workflow.indexOf("run: npm run daily");
  assert.ok(daily > 0);
  for (const step of ["Create Collector snapshots", "Commit Collector repository snapshots", "Configure Pages",
    "Prepare public files", "Upload Pages artifact", "Deploy Pages"]) assert.ok(workflow.indexOf(`- name: ${step}`) > daily);
  assert.doesNotMatch(workflow, /continue-on-error:|always\(\)|failure\(\)/);
});
