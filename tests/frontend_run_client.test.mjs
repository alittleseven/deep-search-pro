import test from "node:test";
import assert from "node:assert/strict";

import { RunClient } from "../web/run-client.js";

test("restore keeps a new thread idle when it has no runs", async (context) => {
  const patches = [];
  const store = {
    snapshot: {
      taskStatus: "idle",
    },
    patch(values) {
      patches.push(values);
      Object.assign(this.snapshot, values);
    },
  };
  context.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({ runs: [] }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  ));

  const client = new RunClient({ store });
  const result = await client.restore({ threadId: "new-thread", runId: null });

  assert.equal(result, null);
  assert.deepEqual(patches.at(-1), {
    runId: null,
    taskStatus: "idle",
    connection: "idle",
  });
});

test("closing the client prevents an old restore from changing the current session", async (context) => {
  let resolveRuns;
  const runsResponse = new Promise((resolve) => {
    resolveRuns = resolve;
  });
  const store = {
    snapshot: { taskStatus: "idle" },
    patch(values) {
      Object.assign(this.snapshot, values);
    },
  };
  context.mock.method(globalThis, "fetch", () => runsResponse);
  const client = new RunClient({ store });

  const restoring = client.restore({ threadId: "old-thread", runId: "old-run" });
  client.close();
  store.patch({ threadId: "new-thread", runId: null, taskStatus: "idle" });
  resolveRuns(new Response(JSON.stringify({
    runs: [{ run_id: "old-run", status: "completed" }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));

  assert.equal(await restoring, null);
  assert.equal(store.snapshot.threadId, "new-thread");
  assert.equal(store.snapshot.runId, null);
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});

test("closing during upload prevents the stale task from starting", async (context) => {
  let resolveUpload;
  const uploadResponse = new Promise((resolve) => {
    resolveUpload = resolve;
  });
  const store = {
    snapshot: { taskStatus: "idle" },
    setTaskStatus(taskStatus) {
      this.snapshot.taskStatus = taskStatus;
    },
  };
  context.mock.method(globalThis, "fetch", () => uploadResponse);
  const client = new RunClient({ store });

  const starting = client.start({
    query: "old question",
    threadId: "old-thread",
    files: [new Blob(["reference"])],
  });
  client.close();
  resolveUpload(new Response(JSON.stringify({ status: "uploaded" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));

  assert.equal(await starting, null);
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});
