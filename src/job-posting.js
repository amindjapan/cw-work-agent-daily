"use strict";

const { normalizeText } = require("./model");
const { normalizePublicJobRef, normalizePublicProfileRef } = require("./public-evidence");
const { parseStrictJsonBytes } = require("./strict-json");

const TYPES = new Set(["JobPosting", "https://schema.org/JobPosting", "http://schema.org/JobPosting"]);
const CONTEXTS = new Set(["https://schema.org", "https://schema.org/", "http://schema.org", "http://schema.org/"]);

// Consume complete tags before looking for scripts, so '<script' in an
// attribute is never a tag. Raw-text/RCDATA and inert containers are excluded.
function structuredDataScripts(html) {
  const output = [];
  const inert = [];
  const raw = new Set(["script", "style", "title", "textarea", "xmp", "iframe", "noembed", "noframes"]);
  let cursor = 0;
  while ((cursor = html.indexOf("<", cursor)) !== -1) {
    if (html.startsWith("<!--", cursor)) {
      const end = html.indexOf("-->", cursor + 4);
      if (end === -1) return null;
      cursor = end + 3; continue;
    }
    if (/^<!|^<\?/.test(html.slice(cursor, cursor + 2))) {
      if (!/^<!doctype(?:\s|>)/i.test(html.slice(cursor))) return null;
      let end = cursor + 9;
      let quote = null;
      for (; end < html.length; end++) {
        if (quote) { if (html[end] === quote) quote = null; }
        else if (html[end] === "\"" || html[end] === "'") quote = html[end];
        else if (html[end] === ">") break;
        else if (html[end] === "<") return null;
      }
      if (end === html.length) return null;
      cursor = end + 1; continue;
    }
    const match = html.slice(cursor).match(/^<(\/?)([a-z][a-z0-9:-]*)(?=[\s/>])/i);
    if (!match) { cursor++; continue; }
    const closing = match[1] === "/";
    const name = match[2].toLowerCase();
    const attributeStart = cursor + match[0].length;
    let end = attributeStart;
    let quote = null;
    for (; end < html.length; end++) {
      const character = html[end];
      if (quote) { if (character === quote) quote = null; }
      else if (character === "\"" || character === "'") quote = character;
      else if (character === ">") break;
      else if (character === "<") return null;
    }
    if (end === html.length) return null;
    const attributes = html.slice(attributeStart, end);
    cursor = end + 1;
    if (["template", "noscript", "svg", "math"].includes(name)) {
      if (closing) { if (inert.pop() !== name) return null; }
      else { if (inert.length >= 16) return null; inert.push(name); }
      continue;
    }
    if (closing) continue;
    if (name === "plaintext") break;
    if (!raw.has(name)) continue;
    const closingTag = new RegExp(`</${name}\\s*>`, "gi");
    closingTag.lastIndex = cursor;
    const close = closingTag.exec(html);
    if (!close) return null;
    const body = html.slice(cursor, close.index);
    cursor = closingTag.lastIndex;
    if (name !== "script" || inert.length) continue;
    let offset = 0;
    let type = null;
    while (offset < attributes.length) {
      const attribute = attributes.slice(offset).match(/^\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/);
      if (!attribute) { if (/^\s*\/?\s*$/.test(attributes.slice(offset))) break; return null; }
      offset += attribute[0].length;
      if (attribute[1].toLowerCase() !== "type") continue;
      if (type !== null) return null;
      type = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
    }
    if (type?.toLowerCase() === "application/ld+json") {
      if (output.length >= 32) return null;
      output.push(body);
    }
  }
  return inert.length ? null : output;
}

function jobUrl(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^https:\/\/crowdworks\.jp\/public\/jobs\/([1-9][0-9]*)(?:\/)?(?:[?#].*)?$/i);
  return match ? normalizePublicJobRef({ platform: "crowdworks", id: match[1], url: value })?.url || null : null;
}

// Supported JSON-LD subset only. No remote contexts, @id dereferencing, script
// execution, arbitrary property traversal or network requests occur here.
function extractJobPosting(html, requestedUrl) {
  if (typeof html !== "string" || Buffer.byteLength(html, "utf8") > 1024 * 1024) return null;
  const expected = requestedUrl === undefined ? null : jobUrl(requestedUrl);
  if (requestedUrl !== undefined && !expected) return null;
  const scripts = structuredDataScripts(html);
  if (!scripts) return null;
  const postings = [];
  let visited = 0;
  const visit = (node, depth) => {
    if (++visited > 256 || depth > 16) throw new Error("unsupported_job_posting");
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    if (!node || typeof node !== "object") return;
    if (Object.hasOwn(node, "@context") && !CONTEXTS.has(node["@context"])) throw new Error("unsupported_job_posting");
    const types = node["@type"];
    const isJob = typeof types === "string" ? TYPES.has(types)
      : Array.isArray(types) && types.every((type) => typeof type === "string") && types.some((type) => TYPES.has(type));
    if (isJob) postings.push(node);
    if (Object.hasOwn(node, "@graph")) visit(node["@graph"], depth + 1);
  };
  try {
    for (const body of scripts) {
      let data;
      try { data = parseStrictJsonBytes(body, { maxBytes: 1024 * 1024 }).value; }
      catch { continue; } // Malformed unrelated structured-data blocks are not evidence.
      visit(data, 0);
    }
  } catch { return null; }

  // Explicit identity fields must agree. An identity-less legacy posting is
  // accepted only when it is the sole posting on the page. Multiple matching
  // postings are ambiguous even if their descriptions happen to be identical.
  const identified = postings.map((posting) => {
    const fields = ["url", "@id"].filter((key) => Object.hasOwn(posting, key));
    const urls = fields.map((key) => jobUrl(posting[key]));
    return { posting, identity: !fields.length ? "absent"
      : urls.every((url) => url && url === urls[0]) ? urls[0] : "invalid" };
  });
  if (identified.some((item) => item.identity === "invalid")) return null;
  if (!expected) return identified.length === 1 ? identified[0].posting : null;
  if (identified.length === 1 && identified[0].identity === "absent") return identified[0].posting;
  if (identified.some((item) => item.identity === "absent")) return null;
  const matching = identified.filter((item) => item.identity === expected);
  return matching.length === 1 ? matching[0].posting : null;
}

function postingDescription(posting, decodeEntities) {
  if (!posting || typeof posting.description !== "string") return "";
  try { return normalizeText(decodeEntities(posting.description)); }
  catch { return ""; }
}

function postingPublicClient(posting) {
  const organization = posting && posting.hiringOrganization;
  if (!organization || typeof organization !== "object" || Array.isArray(organization)) return null;
  if (Object.hasOwn(organization, "@context") && !CONTEXTS.has(organization["@context"])) return null;
  const url = organization.url;
  const match = typeof url === "string" && url.match(/^https:\/\/crowdworks\.jp\/public\/employers\/(\d+)(?:[?#].*)?$/);
  return match ? normalizePublicProfileRef({ platform: "crowdworks", profileId: match[1], url }) : null;
}

module.exports = { extractJobPosting, postingDescription, postingPublicClient };
