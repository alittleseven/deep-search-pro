# Chat and Trace Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine the existing dark chat and Trace pages with restrained rounded controls, smoother visual hierarchy, and better chat scrolling and keyboard behavior without changing backend contracts or Agent behavior.

**Architecture:** Keep the current native HTML/CSS/ES module frontend and FastAPI static delivery. Isolate new chat input and scroll decisions in a small pure helper module so Node tests cover the behavior without a browser DOM; wire those helpers into `chat.js`, then apply shared visual tokens through the existing CSS files. Preserve the Trace topology and expose only its path-geometry helper for focused testing.

**Tech Stack:** HTML5, CSS3, browser ES modules, Node.js built-in test runner, FastAPI static files, pytest.

---

## File Map

- Create `web/chat-interactions.js`: pure decisions for Enter submission and near-bottom detection.
- Create `tests/frontend_chat_interactions.test.mjs`: Node tests for keyboard and scroll thresholds.
- Modify `web/index.html`: add the back-to-latest control and bump static asset versions.
- Modify `web/chat.js`: integrate input behavior, follow-latest state, busy feedback, and the new control.
- Modify `web/styles.css`: shared visual tokens and polished chat/sidebar/composer states.
- Modify `web/visualizer.js`: export and refine smooth edge path geometry without changing topology.
- Modify `tests/frontend_visualizer.test.mjs`: lock the curve geometry and retain the eleven-edge assertion.
- Modify `web/trace.html`: bump static asset versions only; preserve all existing diagnostic hooks.
- Modify `web/trace.css`: polish Trace controls, nodes, edges, records, and responsive behavior.
- Modify `tests/test_web_frontend.py`: verify new assets, DOM hooks, style tokens, and unchanged page capabilities.

### Task 1: Add Pure Chat Interaction Decisions

**Files:**
- Create: `web/chat-interactions.js`
- Create: `tests/frontend_chat_interactions.test.mjs`

- [ ] **Step 1: Write the failing interaction tests**

Create `tests/frontend_chat_interactions.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run:

```powershell
node --test tests/frontend_chat_interactions.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `web/chat-interactions.js`.

- [ ] **Step 3: Implement the pure helper module**

Create `web/chat-interactions.js`:

```js
export function shouldSubmitOnEnter(event) {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

export function isNearBottom(metrics, threshold = 96) {
  const remaining = metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
  return remaining <= threshold;
}
```

- [ ] **Step 4: Run the focused test**

Run:

```powershell
node --test tests/frontend_chat_interactions.test.mjs
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit the isolated behavior**

```powershell
git add web/chat-interactions.js tests/frontend_chat_interactions.test.mjs
git commit -m "test: define polished chat interactions"
```

### Task 2: Integrate Chat Keyboard, Scroll, and Busy Feedback

**Files:**
- Modify: `tests/test_web_frontend.py:18-94`
- Modify: `web/index.html:8-121`
- Modify: `web/chat.js:1-491`

- [ ] **Step 1: Extend the web contract test**

Add `/static/chat-interactions.js` to the asset tuple and `scroll-to-latest` to the chat element ID tuple in `tests/test_web_frontend.py`. Extend the symbol check with `shouldSubmitOnEnter`, `isNearBottom`, and `aria-busy`:

```python
assertions = (
    "shouldSubmitOnEnter",
    "isNearBottom",
    "aria-busy",
)
assert all(value in script for value in assertions)
```

- [ ] **Step 2: Run the focused contract test and verify failure**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_web_frontend.py::test_chat_page_exposes_complete_question_workflow -q
```

Expected: FAIL because `scroll-to-latest` and the helper symbols are absent.

- [ ] **Step 3: Add the back-to-latest control and bump chat asset versions**

Add this button between the message stream and composer in `web/index.html`:

```html
<button class="scroll-to-latest hidden" id="scroll-to-latest" type="button"
        aria-label="回到最新消息" title="回到最新消息">
  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
</button>
```

Change the stylesheet and module query strings from `v=20260821-5` to `v=20260824-1`.

- [ ] **Step 4: Wire the pure helpers into chat.js**

Add the cache-busted import:

```js
import {
  isNearBottom,
  shouldSubmitOnEnter,
} from "./chat-interactions.js?v=20260824-1";
```

Add state and scroll helpers near the existing module state:

```js
let followLatest = true;

function updateLatestControl() {
  const nearBottom = isNearBottom(elements.messages);
  followLatest = nearBottom;
  elements["scroll-to-latest"].classList.toggle("hidden", nearBottom);
}

function scrollToLatest({ smooth = false } = {}) {
  followLatest = true;
  elements["scroll-to-latest"].classList.add("hidden");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  elements.messages.scrollTo({
    top: elements.messages.scrollHeight,
    behavior: smooth && !reducedMotion ? "smooth" : "auto",
  });
}
```

In `renderHeader`, calculate busy once and expose it to CSS and assistive technology:

```js
const busy = isBusy(snapshot.taskStatus);
elements["send-button"].disabled = busy || !elements["task-input"].value.trim();
elements["send-button"].dataset.busy = String(busy);
elements["send-button"].setAttribute("aria-busy", String(busy));
elements["attach-button"].disabled = busy;
```

In `renderConversation`, preserve the reader's position and only follow updates when `followLatest` is true:

```js
const previousScrollTop = elements.messages.scrollTop;
const contentChanged = snapshot.events.length !== lastEventCount
  || pendingQuery
  || isTerminalStatus(snapshot.taskStatus);
const shouldScroll = contentChanged && followLatest;
elements.conversation.replaceChildren(fragment);
requestAnimationFrame(() => {
  if (shouldScroll) {
    scrollToLatest();
  } else {
    elements.messages.scrollTop = previousScrollTop;
    updateLatestControl();
  }
});
lastEventCount = snapshot.events.length;
```

Set `followLatest = true` immediately before rendering a submitted question, new session, or activated session. Replace the existing key handler and add scroll/button listeners:

```js
elements["task-input"].addEventListener("keydown", (event) => {
  if (!shouldSubmitOnEnter(event)) return;
  event.preventDefault();
  elements.composer.requestSubmit();
});

elements.messages.addEventListener("scroll", updateLatestControl, { passive: true });
elements["scroll-to-latest"].addEventListener("click", () => {
  scrollToLatest({ smooth: true });
});
```

Update local ES module query strings in `chat.js` to `v=20260824-1` so all imported modules use a consistent cache key.

- [ ] **Step 5: Run interaction and web contract tests**

Run:

```powershell
node --test tests/frontend_chat_interactions.test.mjs
.\.venv\Scripts\python.exe -m pytest tests/test_web_frontend.py::test_chat_page_exposes_complete_question_workflow tests/test_web_frontend.py::test_frontend_static_module_imports_are_cache_busted -q
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit the chat behavior integration**

```powershell
git add web/index.html web/chat.js tests/test_web_frontend.py
git commit -m "feat: improve chat input and scroll behavior"
```

### Task 3: Apply the Restrained Rounded Chat Visual System

**Files:**
- Modify: `tests/test_web_frontend.py:96-135`
- Modify: `web/styles.css:1-993`

- [ ] **Step 1: Add visual-system assertions**

Extend `test_frontend_has_accessible_controls_and_responsive_guards`:

```python
for token in (
    "--radius-panel: 8px",
    "--radius-control: 10px",
    "--radius-primary: 12px",
    "--motion-fast: 160ms",
    ".scroll-to-latest",
    '.send-button[data-busy="true"]',
):
    assert token in styles
```

- [ ] **Step 2: Run the visual contract test and verify failure**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_web_frontend.py::test_frontend_has_accessible_controls_and_responsive_guards -q
```

Expected: FAIL on the missing radius or motion tokens.

- [ ] **Step 3: Add shared tokens and motion rules**

Add these values to `:root` and use them in the existing selectors instead of introducing new decorative wrappers:

```css
:root {
  --black: #080a0b;
  --sidebar: #0c0f10;
  --canvas: #101315;
  --surface: #171b1d;
  --surface-2: #1c2224;
  --hover: #232a2c;
  --line: rgba(143, 158, 154, 0.16);
  --line-strong: rgba(166, 184, 179, 0.28);
  --text: #f3f6f5;
  --text-2: #c8d0ce;
  --muted: #8d9996;
  --teal: #50bdb2;
  --teal-dark: #28645e;
  --amber: #d6a85f;
  --red: #e07870;
  --radius-panel: 8px;
  --radius-control: 10px;
  --radius-primary: 12px;
  --motion-fast: 160ms;
  --motion-standard: 190ms;
}

button,
a,
input,
textarea {
  transition:
    color var(--motion-fast) ease,
    background-color var(--motion-fast) ease,
    border-color var(--motion-fast) ease,
    box-shadow var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}

button:active:not(:disabled),
.trace-button:active {
  transform: translateY(1px);
}
```

- [ ] **Step 4: Polish sidebar, messages, composer, and status surfaces**

Apply the shared radii to existing controls, keeping repeated content panels at 8px or less:

```css
.brand-mark,
.empty-mark,
.assistant-mark,
.session-item,
.queued-file,
.notice {
  border-radius: var(--radius-panel);
}

.new-session-button,
.session-search input,
.icon-button,
.trace-button {
  border-radius: var(--radius-control);
}

.user-bubble {
  border-radius: 12px 12px 4px 12px;
  border-color: rgba(168, 183, 179, 0.2);
  background: #1c2224;
}

.composer {
  border-radius: var(--radius-primary);
  border-color: rgba(166, 184, 179, 0.25);
  background: rgba(23, 27, 29, 0.98);
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.3);
}

.composer:focus-within {
  border-color: rgba(80, 189, 178, 0.58);
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.3), 0 0 0 3px rgba(80, 189, 178, 0.08);
}

.send-button {
  position: relative;
  border-radius: var(--radius-control);
}

.send-button[data-busy="true"] svg { opacity: 0; }

.send-button[data-busy="true"]::after {
  position: absolute;
  width: 14px;
  height: 14px;
  content: "";
  border: 2px solid rgba(7, 17, 15, 0.35);
  border-top-color: #07110f;
  border-radius: 50%;
  animation: send-spin 720ms linear infinite;
}

@keyframes send-spin { to { transform: rotate(360deg); } }
```

Add the back-to-latest control above the composer and keep its dimensions stable:

```css
.scroll-to-latest {
  position: absolute;
  z-index: 7;
  right: 50%;
  bottom: 148px;
  display: grid;
  width: 38px;
  height: 38px;
  cursor: pointer;
  place-items: center;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  color: var(--text-2);
  background: var(--surface-2);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.3);
  transform: translateX(50%);
}

.scroll-to-latest:hover {
  color: var(--text);
  border-color: rgba(80, 189, 178, 0.5);
  background: var(--hover);
}

.scroll-to-latest.hidden { display: none; }
```

Update mobile positioning inside the existing `max-width: 900px` and `max-width: 620px` blocks so the control remains centered above the narrower composer. Add `.send-button[data-busy="true"]::after` to the existing reduced-motion block with animation disabled.

- [ ] **Step 5: Run the focused web tests**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_web_frontend.py -q
```

Expected: all tests in `test_web_frontend.py` pass.

- [ ] **Step 6: Commit chat visual polish**

```powershell
git add web/styles.css tests/test_web_frontend.py
git commit -m "style: refine dark chat workspace"
```

### Task 4: Lock Smooth Trace Edge Geometry Without Changing Topology

**Files:**
- Modify: `tests/frontend_visualizer.test.mjs:1-27`
- Modify: `web/visualizer.js:24-38`

- [ ] **Step 1: Add a failing curve-geometry test**

Update the import and add this test:

```js
import { edgePath, EDGE_DEFINITIONS, nextZoom } from "../web/visualizer.js";

test("edgePath creates a stable rounded cubic connection", () => {
  assert.equal(
    edgePath({ x: 100, y: 80 }, { x: 300, y: 180 }),
    "M 100 80 C 196 80, 204 180, 300 180",
  );
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
node --test tests/frontend_visualizer.test.mjs
```

Expected: FAIL because `edgePath` is not exported or does not produce the specified handle positions.

- [ ] **Step 3: Export the refined bounded curve helper**

Replace the existing private helper in `web/visualizer.js`:

```js
export function edgePath(start, end) {
  const horizontalDistance = Math.abs(end.x - start.x);
  const handle = Math.max(56, Math.min(168, horizontalDistance * 0.48));
  const direction = end.x >= start.x ? 1 : -1;
  return `M ${start.x} ${start.y} C ${start.x + (handle * direction)} ${start.y}, ${end.x - (handle * direction)} ${end.y}, ${end.x} ${end.y}`;
}
```

Do not edit `EDGE_DEFINITIONS`, node status mapping, zoom levels, or selection behavior.

- [ ] **Step 4: Run the visualizer tests**

Run:

```powershell
node --test tests/frontend_visualizer.test.mjs
```

Expected: 3 tests pass, including the existing exact eleven-edge topology assertion.

- [ ] **Step 5: Commit the isolated graph geometry change**

```powershell
git add web/visualizer.js tests/frontend_visualizer.test.mjs
git commit -m "style: smooth trace graph connections"
```

### Task 5: Apply the Trace Visual Polish

**Files:**
- Modify: `tests/test_web_frontend.py:96-135`
- Modify: `web/trace.html:8-222`
- Modify: `web/trace.css:1-986`

- [ ] **Step 1: Add Trace visual contract checks**

Extend the responsive/accessibility test:

```python
for selector in (
    ".graph-edges path",
    "stroke-linecap: round",
    "vector-effect: non-scaling-stroke",
    ".graph-node[data-status=\"active\"]",
    ".role-item.selected",
):
    assert selector in styles
```

Keep the existing assertions for scrolling, responsive breakpoints, focus visibility, dialog semantics, tabs, graph nodes, and diagnostic IDs.

- [ ] **Step 2: Run the Trace contract test and verify failure**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_web_frontend.py::test_frontend_has_accessible_controls_and_responsive_guards -q
```

Expected: FAIL on `vector-effect: non-scaling-stroke`.

- [ ] **Step 3: Bump Trace page cache keys**

In `web/trace.html`, change `styles.css`, `trace.css`, and `app.js` query strings to `v=20260824-1`. Update local ES module query strings imported by `web/app.js` to the same cache key so the browser does not mix versions.

- [ ] **Step 4: Harmonize Trace controls and diagnostic surfaces**

Replace repeated hard-coded 6px control radii with shared tokens according to purpose:

```css
.trace-navigation a,
.trace-id-chip,
.query-field textarea,
.upload-zone,
.run-button,
.zoom-label,
.event-tools input,
.event-tools select {
  border-radius: var(--radius-control);
}

.run-actions,
.role-item,
.graph-node,
.inspector-item,
.event-item,
.file-item,
.report-content,
.raw-events {
  border-radius: var(--radius-panel);
}

.role-item:hover,
.role-item.selected {
  border-color: rgba(166, 184, 179, 0.34);
  background: var(--surface);
}

.role-item.selected {
  box-shadow: inset 3px 0 0 var(--teal), 0 10px 24px rgba(0, 0, 0, 0.12);
}

.graph-node:hover,
.graph-node.selected {
  border-color: rgba(80, 189, 178, 0.48);
  background: #1b2123;
}

.graph-node[data-status="active"] {
  border-color: rgba(80, 189, 178, 0.58);
  box-shadow: 0 0 0 3px rgba(80, 189, 178, 0.08);
}
```

Keep sections unframed and separated by the existing horizontal rules. Improve metrics, tabs, records, and drawer using border/color/spacing changes only; do not add nested cards or remove controls.

- [ ] **Step 5: Polish graph strokes and state contrast**

Update the existing graph edge rules:

```css
.graph-edges path {
  fill: none;
  stroke: rgba(137, 151, 148, 0.34);
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
  transition: stroke var(--motion-standard) ease, opacity var(--motion-standard) ease;
}

.graph-edges path.conditional { stroke-dasharray: 5 7; }
.graph-edges path.observed { stroke: rgba(80, 189, 178, 0.62); }
.graph-edges path.active {
  stroke: var(--teal);
  stroke-width: 2;
}
```

Retain the existing active-flow animation but disable it in `prefers-reduced-motion`.

- [ ] **Step 6: Run focused Trace and frontend tests**

Run:

```powershell
node --test tests/frontend_visualizer.test.mjs
.\.venv\Scripts\python.exe -m pytest tests/test_web_frontend.py tests/test_trace_api.py tests/test_trace_context.py -q
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit Trace visual polish**

```powershell
git add web/trace.html web/trace.css web/app.js tests/test_web_frontend.py
git commit -m "style: refine trace diagnostics workspace"
```

### Task 6: Regression Verification and Local Delivery

**Files:**
- Verify only; do not modify backend behavior.

- [ ] **Step 1: Run every Node frontend test**

Run:

```powershell
node --test tests/frontend_*.test.mjs
```

Expected: all frontend tests pass, including four chat interaction tests, three visualizer tests, and the existing Markdown, session, and run-client tests.

- [ ] **Step 2: Run focused Python frontend and Trace tests**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_web_frontend.py tests/test_trace_api.py tests/test_trace_context.py tests/test_trace_models.py tests/test_trace_monitor.py tests/test_trace_serializer.py tests/test_trace_store.py -q
```

Expected: all selected tests pass.

- [ ] **Step 3: Run the full Python suite**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

Expected: no new failures. If `tests/test_ragflow_sdk_compatibility.py` still fails because of the known SDK pagination response incompatibility, record it separately and confirm every frontend and Trace test remains green.

- [ ] **Step 4: Check formatting and unintended scope**

Run:

```powershell
git diff --check
git status --short
git diff --name-only HEAD~4..HEAD
```

Expected: no whitespace errors; implementation commits contain only `web/`, focused frontend tests, and this planned work. Existing unrelated changes in `agent/llm.py`, `prompt/prompts.yml`, `database/`, and `tests/test_ragflow_sdk_compatibility.py` remain untouched.

- [ ] **Step 5: Verify the running server endpoints**

Restart Uvicorn if needed, then run:

```powershell
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8002/).StatusCode
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8002/trace).StatusCode
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8002/favicon.ico).StatusCode
```

Expected: `200` for all three URLs.

- [ ] **Step 6: Inspect responsive states when browser access is available**

Reload both pages after the static cache-key update. Check desktop and mobile widths for: composer overlap, long Chinese query wrapping, sidebar navigation, back-to-latest visibility, focus rings, Trace vertical scrolling, graph fit/zoom, selected roles, event tabs, and the inspector drawer. Confirm no text overlap or clipped controls.

- [ ] **Step 7: Commit any verification-only corrections**

If verification required scoped CSS or frontend-test corrections, commit only those files:

```powershell
git add web tests/test_web_frontend.py tests/frontend_chat_interactions.test.mjs tests/frontend_visualizer.test.mjs
git commit -m "fix: finish responsive frontend polish"
```

If no correction was required, do not create an empty commit.
