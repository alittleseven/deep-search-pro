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
