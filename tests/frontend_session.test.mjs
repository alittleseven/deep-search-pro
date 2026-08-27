import test from "node:test";
import assert from "node:assert/strict";

import {
  chatUrl,
  createSessionRecord,
  parseChatSelection,
  parseTraceSelection,
  restoredQuery,
  SessionRepository,
  traceUrl,
  upsertSession,
} from "../web/session.js";

test("upsertSession keeps newest browser session first", () => {
  const old = createSessionRecord({
    threadId: "thread-old",
    runId: "run-old",
    query: "旧问题",
    status: "completed",
    updatedAt: "2026-08-20T10:00:00.000Z",
  });
  const current = createSessionRecord({
    threadId: "thread-current",
    runId: "run-current",
    query: "W585X 库存",
    status: "running",
    updatedAt: "2026-08-21T10:00:00.000Z",
  });

  assert.deepEqual(
    upsertSession([old], current).map((item) => item.threadId),
    ["thread-current", "thread-old"],
  );
});

test("upsertSession updates a thread without duplicating it", () => {
  const first = createSessionRecord({ threadId: "thread-1", query: "第一问" });
  const updated = createSessionRecord({
    threadId: "thread-1",
    runId: "run-2",
    query: "第二问",
    status: "completed",
  });

  const result = upsertSession([first], updated);

  assert.equal(result.length, 1);
  assert.equal(result[0].runId, "run-2");
  assert.equal(result[0].title, "第二问");
});

test("Trace selection prefers URL values and encodes links", () => {
  assert.deepEqual(
    parseTraceSelection("?thread_id=t%201&run_id=r%2F2", {
      threadId: "fallback-thread",
      runId: "fallback-run",
    }),
    { threadId: "t 1", runId: "r/2" },
  );
  assert.equal(traceUrl("t 1", "r/2"), "/trace?thread_id=t+1&run_id=r%2F2");
  assert.equal(chatUrl("t 1", "r/2"), "/?thread_id=t+1&run_id=r%2F2");
});

test("chat selection does not pair a URL thread with a stale saved run", () => {
  assert.deepEqual(
    parseChatSelection("?thread_id=visible-thread", {
      threadId: "saved-thread",
      runId: "stale-run",
    }, () => "new-thread"),
    { threadId: "visible-thread", runId: null },
  );
});

test("restoredQuery returns a query once when a run becomes available", () => {
  assert.equal(restoredQuery(null, { runId: "run-1", query: "库存情况" }), "库存情况");
  assert.equal(restoredQuery("run-1", { runId: "run-1", query: "库存情况" }), null);
  assert.equal(restoredQuery(null, { runId: "run-1", query: "" }), null);
});

test("SessionRepository safely handles invalid stored JSON", () => {
  const storage = {
    getItem: () => "not-json",
    setItem: () => {
      throw new Error("storage unavailable");
    },
  };
  const repository = new SessionRepository(storage);

  assert.deepEqual(repository.list(), []);
  assert.equal(repository.save(createSessionRecord({ threadId: "thread-1" })).length, 1);
});
