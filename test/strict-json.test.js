"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseStrictJsonBytes } = require("../src/strict-json");

function rejects(value, options) {
  assert.throws(() => parseStrictJsonBytes(value, options), (error) => {
    assert.equal(error.message, "invalid_json_bytes");
    assert.equal(error.code, error.message);
    return true;
  });
}

test("strict JSON accepts Unicode, escapes, nesting and exact explicit bytes", () => {
  const text = ' \n {"人工":"たこ 🐙", "escaped\\\"key": [1,true,null,{"x":"\\u0061"}]} \t';
  const parsed = parseStrictJsonBytes(text);
  assert.deepEqual(parsed.value, JSON.parse(text));
  assert.deepEqual(parsed.bytes, Buffer.from(text, "utf8"));
  assert.deepEqual(parseStrictJsonBytes(Buffer.from(text, "utf8")).value, parsed.value);
});

test("strict JSON accepts primitives and empty containers without prescribing caller schema", () => {
  for (const text of ["null", "true", "false", "123", "-1.25e2", '"text"', "[]", "{}", '[{},[],"}"]']) {
    assert.deepEqual(parseStrictJsonBytes(text).value, JSON.parse(text));
  }
});

test("strict JSON rejects duplicate decoded keys only within the same object", () => {
  for (const text of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"outer":[{"x":1,"x":2}]}']) rejects(text);
  assert.deepEqual(parseStrictJsonBytes('[{"x":1},{"x":2}]').value, [{ x: 1 }, { x: 2 }]);
});

test("strict JSON byte limits count UTF-8 bytes and include the exact boundary", () => {
  const text = '"たこ"';
  const size = Buffer.byteLength(text, "utf8");
  assert.equal(parseStrictJsonBytes(text, { maxBytes: size }).bytes.length, size);
  rejects(text, { maxBytes: size - 1 });
  rejects("{}", { maxBytes: 0 });
  for (const maxBytes of [-1, 1.5, NaN, "20", null]) rejects("{}", { maxBytes });
});

test("strict JSON rejects BOM, malformed UTF-8, lossy strings and malformed syntax", () => {
  for (const input of ["", "\ufeff{}", Buffer.from([0xff]), '"\ud800"', "{", '[1,]', '{"x":undefined}']) rejects(input);
});

test("strict JSON copies ordinary buffers and refuses shared mutable bytes", () => {
  const input = Buffer.from('{"x":1}');
  const parsed = parseStrictJsonBytes(input);
  input.fill(0);
  assert.equal(parsed.bytes.toString("utf8"), '{"x":1}');
  const shared = Buffer.from(new SharedArrayBuffer(2));
  shared.write("{}");
  rejects(shared);
});

test("strict JSON rejects oversized inputs before allocating a second byte copy", (t) => {
  const input = Buffer.from("{}");
  const copying = t.mock.method(Buffer, "from", () => { throw new Error("unexpected_copy"); });
  rejects(input, { maxBytes: 1 });
  rejects("{}", { maxBytes: 1 });
  assert.equal(copying.mock.callCount(), 0);
});

test("strict JSON option accessors cannot execute or expose caller errors", () => {
  let reads = 0;
  const options = { get maxBytes() { reads++; throw "synthetic-private-value"; } };
  rejects("{}", options);
  assert.equal(reads, 0);
  rejects("{}", { unknown: true });
  rejects("{}", null);
});

test("strict JSON cannot silently ignore an inherited size limit", () => {
  rejects("{}", Object.create({ maxBytes: 1 }));
  assert.deepEqual(parseStrictJsonBytes("{}", Object.assign(Object.create(null), { maxBytes: 2 })).value, {});
});
