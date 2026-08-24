import test from "node:test";
import assert from "node:assert/strict";

import * as interactions from "../web/chat-interactions.js";

const {
  createFrameScheduler,
  initialScrollIntent,
  isExplicitScrollIntent,
  isNearBottom,
  reduceScrollIntent,
  shouldFollowNewContent,
  shouldSubmitOnEnter,
} = interactions;

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

test("programmatic smooth scrolling keeps following through intermediate scroll events", () => {
  assert.equal(typeof reduceScrollIntent, "function");
  let state = initialScrollIntent();

  state = reduceScrollIntent(state, { type: "programmatic-start" });
  state = reduceScrollIntent(state, { type: "scroll", nearBottom: false });

  assert.deepEqual(state, {
    followLatest: true,
    nearBottom: false,
    programmatic: true,
    userScrolling: false,
  });
  assert.equal(shouldFollowNewContent(state, true), true);

  state = reduceScrollIntent(state, { type: "scroll", nearBottom: true });
  assert.deepEqual(state, initialScrollIntent());
});

test("explicit user scrolling cancels programmatic follow until input settles", () => {
  assert.equal(typeof reduceScrollIntent, "function");
  let state = reduceScrollIntent(initialScrollIntent(), { type: "programmatic-start" });

  state = reduceScrollIntent(state, { type: "user-start", nearBottom: true });
  assert.equal(shouldFollowNewContent(state, true), false);

  state = reduceScrollIntent(state, { type: "scroll", nearBottom: false });
  assert.deepEqual(state, {
    followLatest: false,
    nearBottom: false,
    programmatic: false,
    userScrolling: true,
  });

  state = reduceScrollIntent(state, { type: "user-end", nearBottom: false });
  assert.equal(shouldFollowNewContent(state, true), false);
  assert.deepEqual(
    reduceScrollIntent(state, { type: "reset" }),
    initialScrollIntent(),
  );
});

test("wheel touch pointer and non-editing scroll keys are explicit user intent", () => {
  assert.equal(typeof isExplicitScrollIntent, "function");
  for (const event of [
    { type: "wheel" },
    { type: "touchstart" },
    { type: "pointerdown" },
    { type: "keydown", key: "ArrowUp", target: { tagName: "BODY" } },
    { type: "keydown", key: "PageDown", target: { tagName: "BODY" } },
    { type: "keydown", key: " ", target: { tagName: "BODY" } },
  ]) {
    assert.equal(isExplicitScrollIntent(event), true);
  }
  assert.equal(
    isExplicitScrollIntent({ type: "keydown", key: "ArrowUp", target: { tagName: "TEXTAREA" } }),
    false,
  );
  assert.equal(
    isExplicitScrollIntent({ type: "keydown", key: "Enter", target: { tagName: "BODY" } }),
    false,
  );
});

test("frame scheduler cancels superseded and explicitly abandoned callbacks", () => {
  assert.equal(typeof createFrameScheduler, "function");
  const callbacks = new Map();
  const cancelled = [];
  const observed = [];
  let nextFrame = 0;
  const scheduler = createFrameScheduler({
    requestFrame(callback) {
      nextFrame += 1;
      callbacks.set(nextFrame, callback);
      return nextFrame;
    },
    cancelFrame(frameId) {
      cancelled.push(frameId);
      callbacks.delete(frameId);
    },
  });

  scheduler.schedule(() => observed.push("stale"));
  scheduler.schedule(() => observed.push("latest"));
  assert.deepEqual(cancelled, [1]);
  callbacks.get(2)();
  assert.deepEqual(observed, ["latest"]);

  scheduler.schedule(() => observed.push("abandoned"));
  scheduler.cancel();
  assert.deepEqual(cancelled, [1, 3]);
  assert.deepEqual(observed, ["latest"]);
});
