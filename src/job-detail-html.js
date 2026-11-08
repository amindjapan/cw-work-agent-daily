"use strict";

const { normalizePublicJobRef } = require("./public-evidence");
const VOID = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
const RAW = new Set("script style textarea title xmp iframe noembed noframes".split(" "));
const INERT = new Set(["template", "noscript", "svg", "math"]);
function decode(value) {
  const names = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value.replace(/&(?:#x([\da-f]+)|#(\d+)|(amp|quot|apos|lt|gt|nbsp));/gi, (_, hex, dec, name) => {
    if (name) return names[name.toLowerCase()];
    const n = Number.parseInt(hex || dec, hex ? 16 : 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : " ";
  });
}
function identity(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/^https:\/\/crowdworks\.jp\/public\/jobs\/([1-9]\d{0,31})(?:\/)?(?:[?#].*)?$/i);
  return m ? normalizePublicJobRef({ platform: "crowdworks", id: m[1], url })?.url || null : null;
}
// A deliberately limited, fail-closed HTML tokenizer, not a browser DOM parser.
// Explicitly closed ancestry is required; no script execution or remote lookup.
function inspectHtmlJobDetail(html, requestedUrl) {
  const expected = identity(requestedUrl);
  if (!expected || typeof html !== "string" || Buffer.byteLength(html) > 1024 * 1024) return null;
  const stack = []; const canonicals = []; const roots = []; const tables = []; const cells = [];
  let cursor = 0; let tokens = 0;
  const active = () => !stack.some(n => n.inert);
  const append = text => { if (active()) for (const n of stack) if (n.cell) n.text.push(text); };
  while (cursor < html.length) {
    if (++tokens > 50000) return null;
    const open = html.indexOf("<", cursor);
    if (open < 0) { append(decode(html.slice(cursor))); cursor = html.length; break; }
    append(decode(html.slice(cursor, open)));
    cursor = open;
    if (html.startsWith("<!--", cursor)) {
      const end = html.indexOf("-->", cursor + 4); if (end < 0) return null;
      cursor = end + 3; continue;
    }
    const start = html.slice(cursor).match(/^<(\/?)([a-z][a-z0-9:-]*)(?=[\s/>])/i);
    if (!start) {
      const doctype = html.slice(cursor).match(/^<!doctype\s+html\s*>/i);
      if (doctype) { cursor += doctype[0].length; continue; }
      // Literal less-than in text is supported, but unsupported declarations are not.
      if (/^<[!?]/.test(html.slice(cursor))) return null;
      append("<"); cursor++; continue;
    }
    const name = start[2].toLowerCase(); const closing = !!start[1];
    // Browser plaintext consumes the rest of the document even when hidden.
    // Select/frameset parsing discards or reparents tags; this subset cannot model it.
    if (name === "plaintext" || name === "select" || name === "frameset") return null;
    // Table tokens can implicitly close/reparent a cell in browser parsing.
    // Nested tables and malformed table fragments are unsupported, even hidden.
    if (!closing && stack.some(n => n.cell)
      && ["table", "tr", "td", "th", "thead", "tbody", "tfoot", "caption", "colgroup", "col"].includes(name)) return null;
    let end = cursor + start[0].length; let quote = null;
    for (; end < html.length; end++) {
      const c = html[end];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
      else if (c === "<") return null;
    }
    if (end === html.length) return null;
    const attributes = html.slice(cursor + start[0].length, end);
    if (closing) {
      if (!/^\s*$/.test(attributes)) return null;
      if (VOID.has(name) && name !== "br") { cursor = end + 1; continue; }
      const node = stack.pop(); if (!node || node.name !== name) return null;
      if (node.cell) { node.end = cursor; node.description = node.text.join(" ").replace(/\s+/g, " ").trim(); }
      cursor = end + 1; append(" "); continue;
    }
    const attrs = Object.create(null); let offset = 0;
    while (offset < attributes.length) {
      const a = attributes.slice(offset).match(/^\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/);
      if (!a) { if (/^\s*\/?\s*$/.test(attributes.slice(offset))) break; return null; }
      offset += a[0].length; const key = a[1].toLowerCase();
      if (Object.hasOwn(attrs, key)) return null;
      attrs[key] = decode(a[2] ?? a[3] ?? a[4] ?? "");
    }
    // Unknown data-script MIME types may be structured evidence. Never bypass
    // their parser's identity/ambiguity checks via HTML fallback or exemption.
    if (name === "script" && Object.hasOwn(attrs, "type")
      && !["", "text/javascript", "application/javascript", "module"].includes(attrs.type.toLowerCase())) return null;
    if (/\/\s*$/.test(attributes) && !VOID.has(name)) return null;
    // CSS comments can split property values. External stylesheets and class
    // selectors are not evaluated: this is text extraction, not computed visibility.
    const inlineStyle = (attrs.style || "").replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "");
    const hidden = Object.hasOwn(attrs, "hidden") || Object.hasOwn(attrs, "inert")
      || (attrs["aria-hidden"] || "").toLowerCase() === "true"
      || /(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden)/i.test(inlineStyle);
    const isActive = active() && !hidden && !INERT.has(name) && !RAW.has(name);
    const classes = (attrs.class || "").split(/\s+/);
    const node = { name, inert: hidden || INERT.has(name), root: false, table: false, cell: false };
    if (isActive) {
      if (name === "link" && (attrs.rel || "").toLowerCase().split(/\s+/).includes("canonical")) canonicals.push(identity(attrs.href));
      if (attrs.id === "job_offer_detail") {
        // A table closes a p in browser parsing; table-scope ancestors can also
        // foster-parent the apparent root. Only an ordinary div root is supported.
        if (name !== "div" || stack.some(n => ["p", "table", "thead", "tbody", "tfoot", "tr", "td", "th"].includes(n.name))) return null;
        node.root = true; roots.push(node);
      }
      if (name === "table" && classes.includes("job_offer_detail_table")) {
        node.table = true; node.rootParent = stack.find(n => n.root); tables.push(node);
      }
      if (name === "td" && classes.includes("confirm_outside_link")) {
        // Do not infer browser table repair or foster-parented ancestry.
        const parent = stack[stack.length - 1];
        const beforeRow = stack[stack.length - 2];
        const beforeGroup = stack[stack.length - 3];
        if (parent?.name !== "tr" || !(beforeRow?.name === "table"
          || (["tbody", "thead", "tfoot"].includes(beforeRow?.name) && beforeGroup?.name === "table"))) return null;
        node.cell = true; node.tableParent = [...stack].reverse().find(n => n.name === "table");
        node.start = end + 1; node.text = []; cells.push(node);
      }
      if (name === "base") return null;
    }
    append(" "); cursor = end + 1;
    if (RAW.has(name)) {
      const close = new RegExp(`</${name}\\s*>`, "gi"); close.lastIndex = cursor;
      const match = close.exec(html); if (!match) return null;
      // Script escaped/double-escaped states require a full HTML parser. A
      // nearest-close scan is unsafe for those inputs, so decline the subset.
      if (name === "script" && /<!--|<script/i.test(html.slice(cursor, match.index))) return null;
      cursor = close.lastIndex; continue;
    }
    if (!VOID.has(name)) { stack.push(node); if (stack.length > 128) return null; }
  }
  if (stack.length || canonicals.length !== 1 || canonicals[0] !== expected || roots.length !== 1
    || tables.length !== 1 || tables[0].rootParent !== roots[0] || cells.length !== 1
    || cells[0].tableParent !== tables[0] || !cells[0].description) return null;
  const { start, end, description } = cells[0];
  return { start, end, description, html: html.slice(start, end) };
}
function extractHtmlJobDescription(html, requestedUrl) {
  return inspectHtmlJobDetail(html, requestedUrl)?.description || "";
}
module.exports = { extractHtmlJobDescription, inspectHtmlJobDetail };
