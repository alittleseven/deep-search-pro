import test from "node:test";
import assert from "node:assert/strict";

import {
  isNearBottom,
  shouldSubmitOnEnter,
} from "../web/chat-interactions.js";

test("plain Enter submits while Shift+Enter keeps a newline", () => {
  assert.equal(shouldSubmitOnEnter({ key: "Enter" }), true);
  assert.equal(shouldSubmitOnEnter({ key: "Enter", shiftKey: true }), false);
  assert.equal(shouldSubmitOnEnter({ key: "a" }), false);
});

test("IME composition never submits the message", () => {
  assert.equal(shouldSubmitOnEnter({ key: "Enter", isComposing: true }), false);
});

test("near-bottom detection allows a small reading threshold", () => {
  assert.equal(isNearBottom({ scrollTop: 600, clientHeight: 320, scrollHeight: 1000 }), true);
  assert.equal(isNearBottom({ scrollTop: 400, clientHeight: 320, scrollHeight: 1000 }), false);
});

test("short message streams count as already at the latest content", () => {
  assert.equal(isNearBottom({ scrollTop: 0, clientHeight: 500, scrollHeight: 420 }), true);
});
