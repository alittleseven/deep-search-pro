import test from "node:test";
import assert from "node:assert/strict";

import { isSafeLink, stringifyValue } from "../web/markdown.js";

test("isSafeLink allows web and mail links but rejects executable protocols", () => {
  const base = "http://127.0.0.1:8002/";
  assert.equal(isSafeLink("/trace", base), true);
  assert.equal(isSafeLink("https://example.com", base), true);
  assert.equal(isSafeLink("mailto:ops@example.com", base), true);
  assert.equal(isSafeLink("javascript:alert(1)", base), false);
  assert.equal(isSafeLink("data:text/html,unsafe", base), false);
});

test("stringifyValue preserves strings and safely formats structured values", () => {
  assert.equal(stringifyValue("answer"), "answer");
  assert.equal(stringifyValue(null), "null");
  assert.equal(stringifyValue({ rows: 4 }), '{\n  "rows": 4\n}');
});
