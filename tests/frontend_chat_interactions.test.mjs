import test from "node:test";
import assert from "node:assert/strict";

import * as interactions from "../web/chat-interactions.js";

const {
  createFrameScheduler,
  createRenderBatch,
  initialScrollIntent,
  isExplicitScrollIntent,
  isAtBottom,
  isNearBottom,
  queueRenderBatch,
  reduceScrollIntent,
  resetRenderBatch,
  shouldFollowNewContent,
  shouldRestoreRenderAnchor,
  shouldSubmitOnEnter,
  takeRenderBatch,
} = interactions;

test("plain Enter submits while Shift+Enter keeps a newline", () => {
  assert.equal(shouldSubmitOnEnter({ key: "Enter" }), true);
  assert.equal(shouldSubmitOnEnter({ key: "Enter", shiftKey: true }), false);
  assert.equal(shouldSubmitOnEnter({ key: "a" }), false);
});

test("IME composition never submits the message", () => {
  assert.equal(shouldSubmitOnEnter({ key: "Enter", isComposing: true }), false);
});

test("WebKit IME key events never submit the message", () => {
  assert.equal(shouldSubmitOnEnter({ key: "Enter", keyCode: 229 }), false);
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

  state = reduceScrollIntent(state, { type: "scroll", nearBottom: true, atBottom: true });
  assert.deepEqual(state, initialScrollIntent());
});

test("near-bottom threshold does not complete programmatic scrolling before exact bottom", () => {
  assert.equal(typeof isAtBottom, "function");
  assert.equal(isNearBottom({ scrollTop: 484, clientHeight: 400, scrollHeight: 980 }), true);
  assert.equal(isAtBottom({ scrollTop: 484, clientHeight: 400, scrollHeight: 980 }), false);
  assert.equal(isAtBottom({ scrollTop: 580, clientHeight: 400, scrollHeight: 980 }), true);

  let state = reduceScrollIntent(initialScrollIntent(), { type: "programmatic-start" });
  state = reduceScrollIntent(state, {
    type: "scroll",
    nearBottom: true,
    atBottom: false,
  });
  assert.equal(state.programmatic, true);
  assert.equal(shouldFollowNewContent(state, true), true);

  assert.deepEqual(
    reduceScrollIntent(state, { type: "scroll", nearBottom: true, atBottom: true }),
    initialScrollIntent(),
  );
});

test("unchanged renders do not restore anchors during programmatic scrolling", () => {
  assert.equal(typeof shouldRestoreRenderAnchor, "function");
  const state = reduceScrollIntent(initialScrollIntent(), { type: "programmatic-start" });

  assert.equal(shouldFollowNewContent(state, false), false);
  assert.equal(shouldRestoreRenderAnchor(state, 420), false);
});

test("settled programmatic-origin batches do not restore unchanged anchors", () => {
  let batch = queueRenderBatch(createRenderBatch(), {
    scrollTop: 420,
    contentChanged: false,
    programmatic: true,
  });
  batch = queueRenderBatch(batch, {
    scrollTop: 860,
    contentChanged: false,
    programmatic: true,
  });
  let state = reduceScrollIntent(initialScrollIntent(), { type: "programmatic-start" });
  state = reduceScrollIntent(state, { type: "scroll", nearBottom: true, atBottom: true });

  assert.equal(batch.programmatic, true);
  assert.equal(shouldRestoreRenderAnchor(
    state,
    batch.anchor,
    batch.contentChanged,
    batch.programmatic,
  ), false);
});

test("changed programmatic-origin batches still follow latest after settling", () => {
  const batch = queueRenderBatch(createRenderBatch(), {
    scrollTop: 420,
    contentChanged: true,
    programmatic: true,
  });
  let state = reduceScrollIntent(initialScrollIntent(), { type: "programmatic-start" });
  state = reduceScrollIntent(state, { type: "scroll", nearBottom: true, atBottom: true });

  assert.equal(shouldFollowNewContent(state, batch.contentChanged), true);
});

test("superseding back-to-latest clears a pending non-programmatic batch", () => {
  let batch = queueRenderBatch(createRenderBatch(), {
    scrollTop: 420,
    contentChanged: false,
    programmatic: false,
  });
  assert.equal(batch.anchor, 420);

  batch = resetRenderBatch(batch);
  let state = reduceScrollIntent(initialScrollIntent(), { type: "programmatic-start" });
  state = reduceScrollIntent(state, { type: "scroll", nearBottom: true, atBottom: true });
  const settledBatch = takeRenderBatch(batch);

  assert.deepEqual(settledBatch, {
    anchor: null,
    contentChanged: false,
    programmatic: false,
    remaining: createRenderBatch(),
  });
  assert.equal(shouldRestoreRenderAnchor(
    state,
    settledBatch.anchor,
    settledBatch.contentChanged,
    settledBatch.programmatic,
  ), false);
});

test("settled non-programmatic renders restore an available anchor", () => {
  assert.equal(shouldRestoreRenderAnchor(initialScrollIntent(), 420), true);
  assert.equal(shouldRestoreRenderAnchor(initialScrollIntent(), null), false);
});

test("active user scrolling never restores a render anchor", () => {
  const state = reduceScrollIntent(initialScrollIntent(), {
    type: "user-start",
    nearBottom: false,
  });

  assert.equal(shouldRestoreRenderAnchor(state, 420), false);
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

test("render batches keep the first anchor and accumulated content change", () => {
  assert.equal(typeof createRenderBatch, "function");
  let batch = createRenderBatch();
  batch = queueRenderBatch(batch, { scrollTop: 420, contentChanged: true });
  batch = queueRenderBatch(batch, { scrollTop: 860, contentChanged: false });

  assert.deepEqual(takeRenderBatch(batch), {
    anchor: 420,
    contentChanged: true,
    programmatic: false,
    remaining: createRenderBatch(),
  });
});

test("generated scroll between rapid renders does not discard pending content", () => {
  let batch = queueRenderBatch(createRenderBatch(), {
    scrollTop: 420,
    contentChanged: true,
  });
  let scrollIntent = reduceScrollIntent(initialScrollIntent(), {
    type: "user-start",
    nearBottom: false,
  });
  scrollIntent = reduceScrollIntent(scrollIntent, {
    type: "user-end",
    nearBottom: false,
  });
  scrollIntent = reduceScrollIntent(scrollIntent, {
    type: "scroll",
    nearBottom: true,
    atBottom: true,
  });
  batch = queueRenderBatch(batch, { scrollTop: 860, contentChanged: false });

  assert.equal(scrollIntent.followLatest, false);
  assert.deepEqual(takeRenderBatch(batch), {
    anchor: 420,
    contentChanged: true,
    programmatic: false,
    remaining: createRenderBatch(),
  });
});

test("explicit cancellation discards pending render anchor and content", () => {
  let batch = queueRenderBatch(createRenderBatch(), {
    scrollTop: 420,
    contentChanged: true,
  });
  assert.deepEqual(resetRenderBatch(batch), createRenderBatch());
});

test("reset clears active user intent after blur or session reset", () => {
  let state = reduceScrollIntent(initialScrollIntent(), { type: "programmatic-start" });
  state = reduceScrollIntent(state, { type: "user-start", nearBottom: false });
  assert.equal(state.userScrolling, true);
  assert.deepEqual(reduceScrollIntent(state, { type: "reset" }), initialScrollIntent());
});
