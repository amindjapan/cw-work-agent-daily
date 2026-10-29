"use strict";

// Parse explicit UTF-8 JSON bytes without I/O or silent byte/key normalization.
// The returned bytes are a copy of the exact input used to parse the value.
function parseStrictJsonBytes(value, options = {}) {
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw null;
    const prototype = Object.getPrototypeOf(options);
    if (prototype !== Object.prototype && prototype !== null) throw null;
    const descriptors = Object.getOwnPropertyDescriptors(options);
    if (Reflect.ownKeys(descriptors).some((key) => key !== "maxBytes"
      || !Object.hasOwn(descriptors[key], "value"))) throw null;
    const maxBytes = descriptors.maxBytes?.value === undefined ? Infinity : descriptors.maxBytes.value;
    if (maxBytes !== Infinity && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) throw null;
    if (typeof value !== "string" && !Buffer.isBuffer(value)) throw null;
    if (Buffer.isBuffer(value) && typeof SharedArrayBuffer !== "undefined"
      && value.buffer instanceof SharedArrayBuffer) throw null;
    const size = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.length;
    if (!size || size > maxBytes) throw null;
    const bytes = Buffer.from(value, "utf8");
    if (!bytes.length || bytes.length > maxBytes) throw null;
    // ignoreBOM=true keeps it visible, so JSON.parse rejects it just as the
    // existing store's JSON.parse(readFileSync(..., "utf8")) does.
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (typeof value === "string" && source !== value) throw null;
    const parsed = JSON.parse(source);
    requireUniqueJsonKeys(source);
    return { value: parsed, bytes };
  } catch {
    const error = new Error("invalid_json_bytes");
    error.code = error.message;
    throw error;
  }
}

// JSON.parse has already checked the grammar. Walk its original tokens only to
// reject duplicate decoded keys, including escaped spellings of the same key.
function requireUniqueJsonKeys(source) {
  let offset = 0;
  const space = () => { while (offset < source.length && /\s/.test(source[offset])) offset++; };
  function string() {
    const start = offset++;
    while (offset < source.length) {
      const character = source[offset++];
      if (character === "\\") offset++;
      else if (character === "\"") return JSON.parse(source.slice(start, offset));
    }
    throw null;
  }
  function value() {
    space();
    if (source[offset] === "{") {
      offset++;
      space();
      if (source[offset] === "}") { offset++; return; }
      const keys = new Set();
      while (offset < source.length) {
        const key = string();
        if (keys.has(key)) throw null;
        keys.add(key);
        space();
        offset++; // colon
        value();
        space();
        if (source[offset++] === "}") return;
        space();
      }
    } else if (source[offset] === "[") {
      offset++;
      space();
      if (source[offset] === "]") { offset++; return; }
      while (offset < source.length) {
        value();
        space();
        if (source[offset++] === "]") return;
      }
    } else if (source[offset] === "\"") string();
    else while (offset < source.length && !/[\s,\]}]/.test(source[offset])) offset++;
  }
  value();
}

module.exports = { parseStrictJsonBytes };
