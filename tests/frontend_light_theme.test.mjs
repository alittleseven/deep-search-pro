import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sharedCss = readFileSync(new URL("../web/styles.css", import.meta.url), "utf8");
const traceCss = readFileSync(new URL("../web/trace.css", import.meta.url), "utf8");
const askHtml = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const traceHtml = readFileSync(new URL("../web/trace.html", import.meta.url), "utf8");

test("shared workspace exposes a light paper theme with dark text", () => {
  const root = sharedCss.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1];

  assert.ok(root, "expected shared theme tokens in :root");
  assert.match(root, /color-scheme:\s*light;/);
  assert.match(root, /--black:\s*#f[0-9a-f]{5};/i);
  assert.match(root, /--canvas:\s*#f[0-9a-f]{5};/i);
  assert.match(root, /--surface:\s*#ffffff;/i);
  assert.match(root, /--text:\s*#1[0-9a-f]{5};/i);
  assert.match(root, /--primary:\s*#1[0-9a-f]{5};/i);
});

test("trace workspace uses light graph and inspector surfaces", () => {
  assert.match(traceCss, /\.graph-frame\s*\{[\s\S]*?background:\s*var\(--surface\)/);
  assert.match(traceCss, /\.inspector-drawer\s*\{[\s\S]*?background:\s*var\(--surface\)/);
  assert.match(traceCss, /\.graph-viewport\s*\{[\s\S]*?background:\s*var\(--surface-soft\)/);
});

test("interactive surfaces respect reduced motion", () => {
  const styles = `${sharedCss}\n${traceCss}`;

  assert.match(styles, /transition:[^;]*var\(--t-base\)[^;]*var\(--ease\)/);
  assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

test("both documents advertise a light browser chrome", () => {
  for (const document of [askHtml, traceHtml]) {
    assert.match(document, /<meta name="color-scheme" content="light">/);
    assert.match(document, /<meta name="theme-color" content="#f[0-9a-f]{5}">/i);
  }
});
