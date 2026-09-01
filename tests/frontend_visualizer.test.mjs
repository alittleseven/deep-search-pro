import test from "node:test";
import assert from "node:assert/strict";

import { edgePath, EDGE_DEFINITIONS, nextZoom } from "../web/visualizer.js";

test("graph preserves the existing eleven observed topology edges", () => {
  assert.deepEqual(EDGE_DEFINITIONS, [
    ["input", "main", false],
    ["main", "network", true],
    ["main", "database", true],
    ["main", "knowledge", true],
    ["network", "synthesis", true],
    ["database", "synthesis", true],
    ["knowledge", "synthesis", true],
    ["main", "synthesis", false],
    ["synthesis", "files", true],
    ["synthesis", "output", false],
    ["files", "output", false],
  ]);
});

test("zoom moves only through supported levels", () => {
  assert.equal(nextZoom(1, 1), 1.25);
  assert.equal(nextZoom(1.25, 1), 1.25);
  assert.equal(nextZoom(1, -1), 0.75);
  assert.equal(nextZoom(0.75, -1), 0.75);
});

test("edgePath creates a stable rounded cubic connection", () => {
  assert.equal(
    edgePath({ x: 100, y: 80 }, { x: 300, y: 180 }),
    "M 100 80 C 196 80, 204 180, 300 180",
  );
});
