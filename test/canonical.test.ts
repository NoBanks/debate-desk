import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCanonicalSafe, canonicalBytes, documentHash, receiptHash, sha256Hex, type Json } from "../src/canonical.js";

// Expected value computed independently with Python:
//   hashlib.sha256(json.dumps(r, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
const SAMPLE: Json = { b: [2, { z: 1, a: "x" }], a: "hi", n: null, t: true };

test("receiptHash matches the Python reference rule", () => {
  assert.equal(receiptHash(SAMPLE), "ab32f171d96548e89874b9791d8230ecbbec33e718750e7badfd6ab76c1c61e2");
});

test("canonical bytes sort keys recursively and use no whitespace", () => {
  assert.equal(canonicalBytes(SAMPLE).toString("utf8"), '{"a":"hi","b":[2,{"a":"x","z":1}],"n":null,"t":true}');
});

test("key order in the input never changes the hash", () => {
  const reordered: Json = { t: true, n: null, a: "hi", b: [2, { a: "x", z: 1 }] };
  assert.equal(receiptHash(reordered), receiptHash(SAMPLE));
});

test("receipts refuse floats, unsafe integers and non-ASCII text", () => {
  assert.throws(() => assertCanonicalSafe({ price: 1.5 }), /integers only/);
  assert.throws(() => assertCanonicalSafe({ big: 2 ** 53 }), /integers only/);
  assert.throws(() => assertCanonicalSafe({ s: "café" }), /non-ASCII/);
  assert.throws(() => assertCanonicalSafe({ s: "a\nb" }), /non-ASCII|control/);
  assert.doesNotThrow(() => assertCanonicalSafe({ ok: [1, -2, "text", null, true, { k: "9007199254740993" }] }));
});

test("documentHash keeps newlines and non-ASCII that receipts forbid", () => {
  const doc: Json = { text: "line1\nline2 café" };
  assert.throws(() => receiptHash(doc));
  assert.equal(documentHash(doc), sha256Hex(Buffer.from(JSON.stringify(doc), "utf8")));
});

test("sha256Hex of empty input is the well-known constant", () => {
  assert.equal(sha256Hex(new Uint8Array()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});
