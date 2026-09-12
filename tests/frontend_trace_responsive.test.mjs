import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const traceCss = readFileSync(new URL("../web/trace.css", import.meta.url), "utf8");

test("mobile trace controls reset desktop width constraints", () => {
  const mobileRules = traceCss.match(
    /@media \(max-width: 900px\) \{([\s\S]*?)\n\}\n\n@media \(max-width: 560px\)/,
  )?.[1];

  assert.ok(mobileRules, "expected a mobile trace stylesheet section");
  assert.match(mobileRules, /\.run-actions\s*\{[^}]*flex-direction:\s*column;/);
  assert.match(mobileRules, /\.run-actions\s*>\s*div\s*\{[^}]*min-width:\s*0;/);
  assert.match(mobileRules, /\.run-button\s*\{[^}]*min-width:\s*0;/);
});
