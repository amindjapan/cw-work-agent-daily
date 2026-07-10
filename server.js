"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { extractJobs, fetchSearchPage } = require("./src/scraper");
const { classifyJob, makeApplyDraft, makeDeliveryDraft } = require("./src/model");
const { ensureDir, readJson, upsertJobs, writeJson } = require("./src/store");

const PORT = Number(process.env.PORT || 4188);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const OUTPUT_DIR = path.join(ROOT, "outputs");
const JOBS_PATH = path.join(DATA_DIR, "jobs.json");

ensureDir(DATA_DIR);
ensureDir(OUTPUT_DIR);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      return sendFile(res, path.join(ROOT, "public", "index.html"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, {
        ok: true,
        mode: "human-approved-test",
        jobs: getJobs().length,
        outputDir: OUTPUT_DIR
      });
    }
    if (req.method === "GET" && url.pathname === "/api/jobs") {
      return json(res, { jobs: getJobs() });
    }
    if (req.method === "POST" && url.pathname === "/api/search") {
      const body = await readJsonBody(req);
      const keywords = String(body.keywords || "").trim();
      const pages = Math.max(1, Math.min(5, Number(body.pages || 1)));
      const categoryId = String(body.categoryId || "").trim();
      const imported = [];
      const attempts = [];

      for (let page = 1; page <= pages; page += 1) {
        const result = await fetchSearchPage({ keywords, page, categoryId });
        attempts.push({
          url: result.url,
          status: result.status,
          ok: result.ok,
          needsManualImport: result.needsManualImport
        });
        if (result.needsManualImport) {
          return json(res, {
            ok: false,
            needsManualImport: true,
            message: "クラウドワークス側で通常取得がブロックされました。ブラウザで対象ページを開き、ページ本文またはHTMLを貼り付けてください。",
            attempts
          }, 409);
        }
        imported.push(...extractJobs(result.html, result.url));
      }

      const jobs = saveJobs(imported);
      return json(res, { ok: true, imported: imported.length, attempts, jobs });
    }
    if (req.method === "POST" && url.pathname === "/api/import") {
      const body = await readJsonBody(req);
      const sourceText = String(body.sourceText || "");
      const sourceUrl = String(body.sourceUrl || "manual-import");
      const imported = extractJobs(sourceText, sourceUrl);
      const jobs = saveJobs(imported);
      return json(res, { ok: true, imported: imported.length, jobs });
    }
    if (req.method === "POST" && url.pathname === "/api/reanalyze") {
      const jobs = getJobs().map((job) => ({ ...job, analysis: classifyJob(job) }));
      writeJson(JOBS_PATH, jobs);
      return json(res, { ok: true, jobs });
    }
    if (req.method === "POST" && url.pathname === "/api/draft/apply") {
      const body = await readJsonBody(req);
      const job = findJob(body.jobId);
      if (!job) return json(res, { error: "案件が見つかりません" }, 404);
      const draft = makeApplyDraft(job, body.profile || {});
      const file = saveOutput(job, "apply", draft);
      return json(res, { ok: true, draft, file });
    }
    if (req.method === "POST" && url.pathname === "/api/draft/delivery") {
      const body = await readJsonBody(req);
      const job = findJob(body.jobId);
      if (!job) return json(res, { error: "案件が見つかりません" }, 404);
      const draft = makeDeliveryDraft(job);
      const file = saveOutput(job, "delivery", draft);
      return json(res, { ok: true, draft, file });
    }
    if (req.method === "POST" && url.pathname === "/api/jobs/status") {
      const body = await readJsonBody(req);
      const jobs = getJobs().map((job) =>
        job.id === body.jobId ? { ...job, status: String(body.status || "") } : job
      );
      writeJson(JOBS_PATH, jobs);
      return json(res, { ok: true, jobs });
    }

    return json(res, { error: "Not found" }, 404);
  } catch (error) {
    return json(res, { error: error.message || String(error) }, 500);
  }
});

function getJobs() {
  return readJson(JOBS_PATH, []);
}

function saveJobs(imported) {
  const jobs = upsertJobs(getJobs(), imported);
  writeJson(JOBS_PATH, jobs);
  return jobs;
}

function findJob(id) {
  return getJobs().find((job) => job.id === String(id));
}

function saveOutput(job, kind, content) {
  const safeTitle = String(job.title || job.id)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 50);
  const file = path.join(OUTPUT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}_${kind}_${job.id}_${safeTitle}.md`);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function sendFile(res, file, contentType) {
  fs.readFile(file, (error, data) => {
    if (error) return json(res, { error: "File not found" }, 404);
    res.writeHead(200, { "content-type": contentType });
    res.end(data);
  });
}

function json(res, value, status = 200) {
  const data = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data)
  });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 5_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

server.listen(PORT, () => {
  console.log(`CloudWorks Work Agent Test: http://localhost:${PORT}`);
});
