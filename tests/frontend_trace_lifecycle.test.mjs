import test from "node:test";
import assert from "node:assert/strict";

import { ConsoleStore } from "../web/state.js";

function installMemoryStorage(context) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const entries = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key) {
        return entries.get(key) ?? null;
      },
      setItem(key, value) {
        entries.set(key, String(value));
      },
    },
  });
  context.after(() => {
    if (previous) {
      Object.defineProperty(globalThis, "localStorage", previous);
    } else {
      delete globalThis.localStorage;
    }
  });
}

function toolEvent(overrides = {}) {
  return {
    event_id: "event-tool-start",
    thread_id: "thread-1",
    run_id: "run-1",
    sequence: 1,
    event: "tool_started",
    node_type: "tool",
    status: "running",
    entity_id: "tool-call-1",
    tool_call_id: "tool-call-1",
    name: "数据库查询工具",
    timestamp: "2026-09-10T03:00:00.000Z",
    input: { query: "SELECT 1" },
    output: null,
    error: null,
    ...overrides,
  };
}

test("terminal tool event replaces the running row and keeps raw trace events", (context) => {
  installMemoryStorage(context);
  const store = new ConsoleStore({ threadId: "thread-1", runId: "run-1" });

  store.addEvent(toolEvent());
  store.addEvent(toolEvent({
    event_id: "event-tool-completed",
    sequence: 2,
    event: "tool_completed",
    status: "completed",
    ended_at: "2026-09-10T03:00:01.000Z",
    duration_ms: 1000,
    input: null,
    output: "products: 4",
  }));

  assert.equal(store.snapshot.events.length, 1);
  assert.equal(store.snapshot.events[0].event, "tool_completed");
  assert.equal(store.snapshot.events[0].status, "completed");
  assert.deepEqual(store.snapshot.events[0].input, { query: "SELECT 1" });
  assert.equal(store.snapshot.events[0].output, "products: 4");
  assert.equal(store.snapshot.rawTraceEvents.length, 2);
  assert.equal(store.snapshot.roles.database.status, "completed");
});

test("terminal agent failure replaces the running row with its error", (context) => {
  installMemoryStorage(context);
  const store = new ConsoleStore({ threadId: "thread-1", runId: "run-1" });

  store.addEvent({
    event_id: "event-agent-start",
    thread_id: "thread-1",
    run_id: "run-1",
    sequence: 1,
    event: "agent_started",
    node_type: "agent",
    status: "running",
    entity_id: "agent-call-1",
    name: "网络搜索助手",
    timestamp: "2026-09-10T03:00:00.000Z",
    input: { description: "查找产品资料" },
  });
  store.addEvent({
    event_id: "event-agent-failed",
    thread_id: "thread-1",
    run_id: "run-1",
    sequence: 2,
    event: "agent_failed",
    node_type: "agent",
    status: "failed",
    entity_id: "agent-call-1",
    name: "网络搜索助手",
    timestamp: "2026-09-10T03:00:01.000Z",
    ended_at: "2026-09-10T03:00:01.000Z",
    duration_ms: 1000,
    error: { type: "RuntimeError", message: "network unavailable" },
  });

  assert.equal(store.snapshot.events.length, 1);
  assert.equal(store.snapshot.events[0].event, "agent_failed");
  assert.equal(store.snapshot.events[0].status, "failed");
  assert.deepEqual(store.snapshot.events[0].input, {
    description: "查找产品资料",
  });
  assert.equal(store.snapshot.events[0].error.message, "network unavailable");
  assert.equal(store.snapshot.rawTraceEvents.length, 2);
  assert.equal(store.snapshot.roles.network.status, "failed");
});

test("terminal run event replaces the active row but retains the original request", (context) => {
  installMemoryStorage(context);
  const store = new ConsoleStore({ threadId: "thread-1", runId: "run-1" });

  store.addEvent({
    event_id: "event-run-start",
    thread_id: "thread-1",
    run_id: "run-1",
    sequence: 1,
    event: "run_started",
    node_type: "run",
    status: "running",
    entity_id: "run-1",
    timestamp: "2026-09-10T03:00:00.000Z",
    input: { query: "查询产品库存" },
  });
  store.addEvent({
    event_id: "event-run-completed",
    thread_id: "thread-1",
    run_id: "run-1",
    sequence: 2,
    event: "run_completed",
    node_type: "run",
    status: "completed",
    entity_id: "run-1",
    timestamp: "2026-09-10T03:00:01.000Z",
    output: "库存查询完成",
  });

  assert.deepEqual(
    store.snapshot.events.map((event) => event.event),
    ["run_completed"],
  );
  assert.equal(store.snapshot.finalOutput, "库存查询完成");
  assert.deepEqual(
    store.snapshot.rawTraceEvents.map((event) => event.event),
    ["run_started", "run_completed"],
  );
  assert.deepEqual(store.snapshot.rawTraceEvents[0].input, {
    query: "查询产品库存",
  });
});
