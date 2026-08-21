# Chat and Trace Frontend Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Trace-first console with a polished dark chat homepage and a readable vertically scrolling Trace page while preserving every existing backend API and Trace behavior.

**Architecture:** Keep the frontend build-free with native HTML, CSS, and ES modules. Reuse `web/api.js` and the existing Trace store, add focused modules for browser session history, safe Markdown rendering, and shared run lifecycle handling, then let `chat.js` and `app.js` own only their page-specific rendering and interactions.

**Tech Stack:** FastAPI static routes, HTML5, CSS3, native ES modules, WebSocket, browser `localStorage`, pytest/TestClient, Node.js built-in test runner, Codex in-app browser.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `api/server.py` | Serve `/`, `/trace`, favicon, and existing static assets; no task logic changes. |
| `web/index.html` | Chat page semantic structure. |
| `web/trace.html` | Trace page semantic structure. |
| `web/styles.css` | Shared shell, dark tokens, sidebar, chat, Markdown, dialogs, responsive rules. |
| `web/trace.css` | Trace summary, graph viewport, drawer, event/report/file/raw panels. |
| `web/api.js` | Existing HTTP and WebSocket protocol wrapper; paths and payloads remain unchanged. |
| `web/session.js` | Pure session record operations plus guarded `localStorage` persistence and Trace URL construction. |
| `web/markdown.js` | Safe DOM-based Markdown rendering and value formatting shared by both pages. |
| `web/run-client.js` | Upload-before-task ordering, Trace restore, WebSocket reconnect, heartbeat, and file refresh. |
| `web/state.js` | Existing Trace event store and role/status inference, initialized from an explicit thread/run selection. |
| `web/chat.js` | Chat messages, composer, attachments, session navigation, answer/files rendering. |
| `web/app.js` | Trace page rendering, filtering, tabs, details drawer, and run controls. |
| `web/visualizer.js` | Existing eight-node/eleven-edge graph plus zoom and fit controls. |
| `tests/test_web_frontend.py` | FastAPI page/static contracts and source safety checks. |
| `tests/frontend_session.test.mjs` | Session history and route selection unit tests. |
| `tests/frontend_visualizer.test.mjs` | Graph topology and zoom unit tests. |

## Task 1: Add Separate Chat and Trace Page Contracts

**Files:**
- Modify: `tests/test_web_frontend.py`
- Modify: `api/server.py:28-40`
- Modify: `web/index.html`
- Create: `web/trace.html`

- [ ] **Step 1: Write the failing route and asset tests**

Replace the first frontend route test with explicit page contracts:

```python
def test_chat_and_trace_pages_and_static_assets_are_available() -> None:
    with TestClient(server.app) as client:
        chat = client.get("/")
        trace = client.get("/trace")
        assets = {
            path: client.get(path)
            for path in (
                "/static/styles.css",
                "/static/trace.css",
                "/static/chat.js",
                "/static/app.js",
                "/static/session.js",
                "/static/markdown.js",
                "/static/run-client.js",
            )
        }
        docs = client.get("/docs")

    assert chat.status_code == 200
    assert "Deep Search" in chat.text
    assert 'src="/static/chat.js?v=' in chat.text
    assert trace.status_code == 200
    assert "运行详情" in trace.text
    assert 'src="/static/app.js?v=' in trace.text
    assert all(response.status_code == 200 for response in assets.values())
    assert "text/css" in assets["/static/styles.css"].headers["content-type"]
    assert "text/css" in assets["/static/trace.css"].headers["content-type"]
    assert all(
        "javascript" in response.headers["content-type"]
        for path, response in assets.items()
        if path.endswith(".js")
    )
    assert docs.status_code == 200
    assert "Swagger UI" in docs.text
```

- [ ] **Step 2: Run the route test and verify it fails**

Run:

```powershell
pytest tests/test_web_frontend.py::test_chat_and_trace_pages_and_static_assets_are_available -v
```

Expected: FAIL because `/trace`, `trace.css`, `chat.js`, `session.js`, `markdown.js`, and `run-client.js` do not exist.

- [ ] **Step 3: Add the static Trace route and semantic page shells**

Add this route without changing task execution code:

```python
@app.get("/trace", include_in_schema=False)
async def trace_console() -> FileResponse:
    return FileResponse(web_dir / "trace.html")
```

Make `web/index.html` load the chat controller:

```html
<title>Deep Search</title>
<link rel="icon" type="image/svg+xml" href="/favicon.ico">
<link rel="stylesheet" href="/static/styles.css">
<script type="module" src="/static/chat.js?v=20260821-1"></script>
```

Create `web/trace.html` with the approved route identity and assets:

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>运行详情 - Deep Search</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.ico">
  <link rel="stylesheet" href="/static/styles.css">
  <link rel="stylesheet" href="/static/trace.css">
</head>
<body>
  <main id="trace-app" aria-label="运行详情"></main>
  <script type="module" src="/static/app.js?v=20260821-1"></script>
</body>
</html>
```

Create valid empty `chat.js`, `session.js`, `markdown.js`, and `run-client.js` ES modules plus a valid `trace.css` file so every new asset has the correct MIME type before later tasks fill them. Do not replace the existing `app.js` in this task:

```javascript
export {};
```

```css
:root {
  color-scheme: dark;
}
```

- [ ] **Step 4: Run the route tests and verify they pass**

Run:

```powershell
pytest tests/test_web_frontend.py::test_chat_and_trace_pages_and_static_assets_are_available tests/test_web_frontend.py::test_web_console_favicon_is_available -v
```

Expected: 2 passed.

- [ ] **Step 5: Commit the route split**

```powershell
git add api/server.py web/index.html web/trace.html web/trace.css web/chat.js web/session.js web/markdown.js web/run-client.js tests/test_web_frontend.py
git commit -m "feat: split chat and trace frontend routes"
```

## Task 2: Implement Browser Session History

**Files:**
- Create: `tests/frontend_session.test.mjs`
- Modify: `web/session.js`
- Modify: `web/state.js:1-83`

- [ ] **Step 1: Write failing session unit tests**

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import {
  createSessionRecord,
  parseTraceSelection,
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
    parseTraceSelection("?thread_id=t%201&run_id=r%2F2", {}),
    { threadId: "t 1", runId: "r/2" },
  );
  assert.equal(traceUrl("t 1", "r/2"), "/trace?thread_id=t+1&run_id=r%2F2");
});
```

- [ ] **Step 2: Run the Node tests and verify they fail**

Run:

```powershell
node --experimental-default-type=module --test tests/frontend_session.test.mjs
```

Expected: FAIL because the exports are missing.

- [ ] **Step 3: Implement pure session operations and guarded persistence**

`web/session.js` must export this public surface:

```javascript
const STORAGE_KEY = "deep-search-pro.sessions.v1";
const MAX_SESSIONS = 50;

export function createSessionRecord({
  threadId,
  runId = null,
  query = "",
  status = "idle",
  updatedAt = new Date().toISOString(),
}) {
  const normalizedQuery = String(query).trim();
  return {
    threadId: String(threadId),
    runId: runId ? String(runId) : null,
    title: normalizedQuery.slice(0, 36) || "新对话",
    query: normalizedQuery,
    status: String(status || "idle"),
    updatedAt,
  };
}

export function upsertSession(sessions, record) {
  return [record, ...sessions.filter((item) => item.threadId !== record.threadId)]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, MAX_SESSIONS);
}

export function parseTraceSelection(search, fallback = {}) {
  const params = new URLSearchParams(search);
  return {
    threadId: params.get("thread_id") || fallback.threadId || null,
    runId: params.get("run_id") || fallback.runId || null,
  };
}

export function traceUrl(threadId, runId) {
  const params = new URLSearchParams();
  if (threadId) params.set("thread_id", threadId);
  if (runId) params.set("run_id", runId);
  return `/trace?${params}`;
}

export class SessionRepository {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  list() {
    try {
      const value = JSON.parse(this.storage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(value) ? value.filter((item) => item?.threadId) : [];
    } catch {
      return [];
    }
  }

  save(record) {
    const sessions = upsertSession(this.list(), record);
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    } catch {
      return sessions;
    }
    return sessions;
  }
}
```

Change `initialSnapshot()` in `web/state.js` to accept an explicit selection while retaining the legacy saved run as fallback:

```javascript
function initialSnapshot(selection = {}) {
  const persisted = readPersisted();
  return {
    threadId: selection.threadId || persisted.threadId || crypto.randomUUID(),
    runId: selection.runId || persisted.runId || null,
    outputPath: persisted.outputPath || null,
    lastSequence: 0,
    taskStatus: selection.runId || persisted.runId ? "restoring" : "idle",
  };
}

export class ConsoleStore {
  constructor(selection = {}) {
    this.snapshot = initialSnapshot(selection);
    this.listeners = new Set();
    this.eventIds = new Set();
    this.persist();
  }
}
```

Keep every existing snapshot field after the shown fields.

- [ ] **Step 4: Run session and frontend tests**

Run:

```powershell
node --experimental-default-type=module --test tests/frontend_session.test.mjs
pytest tests/test_web_frontend.py -v
```

Expected: Node tests pass and frontend pytest tests pass.

- [ ] **Step 5: Commit session persistence**

```powershell
git add web/session.js web/state.js tests/frontend_session.test.mjs
git commit -m "feat: add browser session history"
```

## Task 3: Extract Safe Markdown and Shared Run Lifecycle

**Files:**
- Modify: `web/markdown.js`
- Modify: `web/run-client.js`
- Modify: `web/app.js`
- Modify: `tests/test_web_frontend.py`

- [ ] **Step 1: Add failing source safety and lifecycle assertions**

Extend the source safety test with these assertions:

```python
assert "export function renderMarkdown" in (WEB_ROOT / "markdown.js").read_text(encoding="utf-8")
assert "export class RunClient" in (WEB_ROOT / "run-client.js").read_text(encoding="utf-8")
assert "await uploadFiles" in (WEB_ROOT / "run-client.js").read_text(encoding="utf-8")
assert "await startTask" in (WEB_ROOT / "run-client.js").read_text(encoding="utf-8")
assert (WEB_ROOT / "run-client.js").read_text(encoding="utf-8").index("await uploadFiles") < (
    WEB_ROOT / "run-client.js"
).read_text(encoding="utf-8").index("await startTask")
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
pytest tests/test_web_frontend.py::test_frontend_uses_no_external_runtime_or_html_injection_sink -v
```

Expected: FAIL because the shared modules are empty.

- [ ] **Step 3: Move safe rendering into `markdown.js`**

Export the existing DOM-only renderer instead of duplicating it:

```javascript
export function stringifyValue(value) {
  if (value === undefined) return "Unavailable";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function isSafeLink(href, base = window.location.href) {
  try {
    const url = new URL(href, base);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

export function renderMarkdown(value, container) {
  const source = stringifyValue(value).replaceAll("\r\n", "\n");
  const fragment = document.createDocumentFragment();
  renderBlocks(source.split("\n"), fragment);
  container.replaceChildren(fragment);
}
```

Move `makeElement`, `appendInlineMarkdown`, `isBlockStart`, and the complete block loop from `web/app.js` into the same module. Keep link creation on `textContent`/DOM nodes and never use HTML parsing sinks.

- [ ] **Step 4: Implement `RunClient` and refactor Trace to use it**

Expose one lifecycle owner for both pages:

```javascript
import {
  connectTrace,
  fetchFiles,
  fetchThreadRuns,
  fetchTrace,
  startTask,
  uploadFiles,
} from "./api.js";
import { isTerminalStatus } from "./state.js";

export class RunClient {
  constructor({ store, onNotice = () => {} }) {
    this.store = store;
    this.onNotice = onNotice;
    this.socket = null;
    this.socketGeneration = 0;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  async start({ query, threadId, files = [] }) {
    if (files.length) {
      this.store.setTaskStatus("uploading");
      await uploadFiles(threadId, files);
    }
    this.store.setTaskStatus("starting");
    const response = await startTask(query, threadId);
    if (!response.run_id || !response.thread_id) {
      throw new Error("任务响应缺少 thread_id 或 run_id。");
    }
    this.store.beginRun({
      query,
      threadId: response.thread_id,
      runId: response.run_id,
    });
    this.connect();
    return response;
  }

  async restore({ threadId, runId }) {
    this.store.patch({ threadId, runId });
    const thread = await fetchThreadRuns(threadId);
    const summary = runId
      ? thread.runs?.find((item) => item.run_id === runId)
      : thread.runs?.[0];
    if (!summary) throw new Error("当前运行记录已不可用。");
    this.store.patch({ runId: summary.run_id });
    this.store.prepareRestore();
    const trace = await fetchTrace(summary.run_id, 0);
    for (const event of trace.events) this.store.addEvent(event);
    await this.refreshFiles();
    if (!isTerminalStatus(this.store.snapshot.taskStatus)) this.connect();
    return summary;
  }
}
```

Complete the class with the existing `connectSocket`, heartbeat, exponential reconnect, `after_sequence`, 4404 handling, `refreshFiles`, and `close` logic currently in `app.js`. Rename those methods to `connect()`, `scheduleReconnect()`, `refreshFiles()`, and `close()` and keep their behavior unchanged.

In `app.js`, replace local socket variables and lifecycle functions with:

```javascript
const runClient = new RunClient({
  store,
  onNotice: (message, sticky = false) => showNotice(message, sticky),
});
```

Import `renderMarkdown` and `stringifyValue` from `markdown.js`, then remove their duplicate local implementations.

- [ ] **Step 5: Run focused and full frontend tests**

Run:

```powershell
pytest tests/test_web_frontend.py -v
node --experimental-default-type=module --test tests/frontend_session.test.mjs
```

Expected: all commands pass.

- [ ] **Step 6: Commit shared frontend infrastructure**

```powershell
git add web/markdown.js web/run-client.js web/app.js tests/test_web_frontend.py
git commit -m "refactor: share frontend run lifecycle"
```

## Task 4: Build the Dark Chat Experience

**Files:**
- Modify: `tests/test_web_frontend.py`
- Modify: `web/index.html`
- Modify: `web/styles.css`
- Modify: `web/chat.js`

- [ ] **Step 1: Add failing chat structure and protocol tests**

```python
def test_chat_page_exposes_complete_question_workflow() -> None:
    html = (WEB_ROOT / "index.html").read_text(encoding="utf-8")
    script = (WEB_ROOT / "chat.js").read_text(encoding="utf-8")

    for element_id in (
        "session-list",
        "new-session",
        "session-search",
        "messages",
        "empty-state",
        "task-input",
        "file-input",
        "queued-files",
        "send-button",
        "trace-link",
        "connection-label",
        "notice",
    ):
        assert f'id="{element_id}"' in html

    for symbol in (
        "RunClient",
        "SessionRepository",
        "renderMarkdown",
        "downloadUrl",
        "traceUrl",
    ):
        assert symbol in script
```

- [ ] **Step 2: Run the chat contract test and verify it fails**

Run:

```powershell
pytest tests/test_web_frontend.py::test_chat_page_exposes_complete_question_workflow -v
```

Expected: FAIL because the chat structure and controller are not implemented.

- [ ] **Step 3: Implement the semantic chat page**

`web/index.html` must contain this hierarchy with real controls, not decorative placeholders:

```html
<div class="app-shell">
  <aside class="sidebar" id="sidebar" aria-label="会话导航">
    <button id="new-session" type="button">新建对话</button>
    <input id="session-search" type="search" placeholder="搜索当前浏览器会话">
    <div id="session-list" class="session-list"></div>
  </aside>
  <main class="chat-workspace">
    <header class="topbar">
      <div><h1 id="thread-title">新对话</h1><code id="thread-id"></code></div>
      <span id="connection-label" aria-live="polite">未开始</span>
      <button id="copy-thread" type="button" aria-label="复制线程 ID"></button>
      <a id="trace-link" class="button" aria-disabled="true">运行详情</a>
    </header>
    <section id="messages" class="message-stream" aria-live="polite">
      <div id="empty-state" class="chat-empty"></div>
    </section>
    <form id="composer" class="composer">
      <div id="queued-files"></div>
      <textarea id="task-input" placeholder="询问产品、库存、销量或手册内容"></textarea>
      <input id="file-input" type="file" multiple hidden>
      <button id="attach-button" type="button" aria-label="添加附件"></button>
      <button id="send-button" type="submit" aria-label="发送问题"></button>
    </form>
  </main>
</div>
<div id="notice" class="notice hidden" role="status" aria-live="polite">
  <span id="notice-text"></span>
  <button id="dismiss-notice" type="button">关闭</button>
</div>
```

Use inline Lucide path data for icons, `aria-label` for icon-only buttons, and no external assets.

- [ ] **Step 4: Implement chat rendering and interaction**

`web/chat.js` must initialize the shared components and subscribe to the Trace store:

```javascript
const repository = new SessionRepository();
const saved = repository.list()[0] || null;
const store = new ConsoleStore({
  threadId: saved?.threadId || crypto.randomUUID(),
  runId: saved?.runId || null,
});
const runClient = new RunClient({ store, onNotice: showNotice });

async function submitQuestion(event) {
  event.preventDefault();
  const query = elements["task-input"].value.trim();
  if (!query || isBusy(store.snapshot.taskStatus)) return;
  appendUserMessage(query);
  try {
    const response = await runClient.start({
      query,
      threadId: store.snapshot.threadId,
      files: queuedFiles,
    });
    repository.save(createSessionRecord({
      threadId: response.thread_id,
      runId: response.run_id,
      query,
      status: "running",
    }));
    queuedFiles = [];
    renderQueuedFiles();
  } catch (error) {
    store.setTaskStatus("failed");
    showNotice(`无法启动任务：${error.message}`, true);
  }
}
```

On every store update:

```javascript
function render(snapshot) {
  renderHeader(snapshot);
  renderSessions(repository.list());
  renderProgress(snapshot);
  renderAnswer(snapshot);
  renderGeneratedFiles(snapshot.files);
  elements["trace-link"].href = traceUrl(snapshot.threadId, snapshot.runId);
  elements["trace-link"].setAttribute("aria-disabled", String(!snapshot.runId));
}
```

Render the final assistant answer only from `snapshot.finalOutput`; do not simulate token streaming. Build user messages, progress rows, file links, and evidence rows with `document.createElement`, `textContent`, and `replaceChildren`.

- [ ] **Step 5: Implement the approved visual system in `styles.css`**

Define the exact shared tokens and structural constraints:

```css
:root {
  color-scheme: dark;
  --black: #090b0c;
  --sidebar: #0d0f10;
  --canvas: #111416;
  --surface: #171b1d;
  --surface-2: #1c2123;
  --hover: #22282b;
  --line: #2a3033;
  --line-strong: #3a4345;
  --text: #f1f4f3;
  --text-2: #c2cbc9;
  --muted: #899492;
  --teal: #43b8ad;
  --amber: #d4a65d;
  --red: #e07870;
  --content-width: 820px;
  font-family: "Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", sans-serif;
}

.app-shell {
  display: grid;
  grid-template-columns: 258px minmax(0, 1fr);
  height: 100dvh;
}

.message-stream {
  min-height: 0;
  overflow-y: auto;
  padding: 42px max(24px, calc((100% - var(--content-width)) / 2)) 190px;
}

.composer {
  position: absolute;
  right: max(24px, calc((100% - var(--content-width)) / 2));
  bottom: 20px;
  left: max(24px, calc((100% - var(--content-width)) / 2));
  min-height: 112px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface);
}
```

Implement the approved sidebar, right-aligned user bubble, unframed assistant response, table/Markdown styling, answer evidence rail, queued file chips, visible focus, reduced motion, and mobile sidebar drawer. Do not use gradient backgrounds or font sizes below `11px`.

- [ ] **Step 6: Run frontend tests**

```powershell
pytest tests/test_web_frontend.py -v
node --experimental-default-type=module --test tests/frontend_session.test.mjs
```

Expected: all tests pass.

- [ ] **Step 7: Commit the chat page**

```powershell
git add web/index.html web/styles.css web/chat.js tests/test_web_frontend.py
git commit -m "feat: add dark chat workspace"
```

## Task 5: Build the Vertically Scrolling Trace Page

**Files:**
- Modify: `tests/test_web_frontend.py`
- Modify: `web/trace.html`
- Modify: `web/trace.css`
- Modify: `web/app.js`

- [ ] **Step 1: Add failing Trace structure tests**

```python
def test_trace_page_preserves_diagnostics_in_vertical_layout() -> None:
    html = (WEB_ROOT / "trace.html").read_text(encoding="utf-8")
    css = (WEB_ROOT / "trace.css").read_text(encoding="utf-8")

    for element_id in (
        "run-title",
        "task-input",
        "run-button",
        "role-summary",
        "execution-graph",
        "graph-edges",
        "graph-empty",
        "inspector-drawer",
        "inspector-body",
        "records-collapse",
        "events-list",
        "final-report",
        "files-list",
        "raw-events",
    ):
        assert f'id="{element_id}"' in html

    assert "overflow-y: auto" in css
    assert 'data-bottom-tab="events"' in html
    assert 'data-bottom-tab="report"' in html
    assert 'data-bottom-tab="files"' in html
    assert 'data-bottom-tab="raw"' in html
```

- [ ] **Step 2: Run the Trace structure test and verify it fails**

```powershell
pytest tests/test_web_frontend.py::test_trace_page_preserves_diagnostics_in_vertical_layout -v
```

Expected: FAIL because the Trace shell is incomplete.

- [ ] **Step 3: Replace `trace.html` with the approved vertical hierarchy**

The page must use this order:

```html
<div class="app-shell trace-shell">
  <aside class="sidebar" aria-label="会话导航"></aside>
  <main class="trace-workspace">
    <header class="topbar trace-topbar"></header>
    <div class="trace-scroll">
      <div class="trace-content">
        <section class="run-summary" aria-labelledby="run-title"></section>
        <nav class="role-summary" id="role-summary" aria-label="执行角色状态"></nav>
        <section class="execution-section" aria-labelledby="execution-title">
          <header class="section-heading"></header>
          <div class="graph-frame">
            <div class="graph-viewport" id="graph-viewport">
              <div class="graph-stage" id="graph-stage">
                <div class="graph" id="execution-graph"></div>
              </div>
            </div>
            <aside class="inspector-drawer" id="inspector-drawer"></aside>
          </div>
        </section>
        <section class="run-records" id="run-records" aria-labelledby="records-title">
          <button id="records-collapse" type="button" aria-expanded="true">收起运行记录</button>
        </section>
      </div>
    </div>
  </main>
</div>
```

Populate the summary with all six existing metrics, thread/run IDs, upload control, current query, run button, connection status, new session, and copy thread controls. Render the existing five execution roles in `role-summary`; each compact role item must show status, observed availability, trigger count, and open the shared drawer when selected. Populate the graph with the existing eight `data-node` buttons and retain `graph-empty`. Populate the drawer with Overview/Input/Output/Event/Error tabs. Populate run records with Events/Final report/Generated files/Raw events tabs and retain the collapse/expand control.

- [ ] **Step 4: Implement readable Trace styling**

`web/trace.css` must establish one vertical scroll owner and readable minimums:

```css
.trace-workspace {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}

.trace-scroll {
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.trace-content {
  width: min(1180px, calc(100% - 48px));
  margin: 0 auto;
  padding: 32px 0 72px;
}

.graph-viewport {
  width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
}

.graph {
  position: relative;
  width: 1120px;
  height: 430px;
  font-size: 13px;
}

.run-records {
  padding-top: 36px;
  font-size: 13px;
}
```

Style the drawer as an overlay inside `.graph-frame`, not a permanent grid column. Give the event table `12-13px` text, `54px` rows, sticky headers when its own content exceeds the viewport, and horizontal scrolling on narrow screens.

- [ ] **Step 5: Adapt `app.js` rendering without changing Trace semantics**

Initialize from URL parameters and the browser session fallback:

```javascript
const repository = new SessionRepository();
const fallback = repository.list()[0] || {};
const selection = parseTraceSelection(window.location.search, fallback);
const store = new ConsoleStore(selection);
const runClient = new RunClient({ store, onNotice: showNotice });
```

Change `selectNode` and `selectEvent` to open the same drawer:

```javascript
function openInspector(selection) {
  selected = selection;
  elements["inspector-drawer"].classList.add("open");
  elements["inspector-backdrop"].classList.add("open");
  elements["inspector-drawer"].setAttribute("aria-hidden", "false");
  renderInspector(store.snapshot);
}

function closeInspector() {
  elements["inspector-drawer"].classList.remove("open");
  elements["inspector-backdrop"].classList.remove("open");
  elements["inspector-drawer"].setAttribute("aria-hidden", "true");
  selectedTrigger?.focus();
}
```

Retain `renderMetrics`, `renderAgents`, `renderEvents`, `renderReport`, `renderFiles`, `renderRaw`, event selection, inspector tabs, file download URLs, restore, reconnection, and task execution. Add event search and status filtering only at render time:

```javascript
const visibleEvents = snapshot.events.filter((event) => {
  const matchesStatus = eventStatusFilter === "all"
    || (event.status || "unknown") === eventStatusFilter;
  const haystack = `${event.name || ""} ${event.event || ""} ${event.message || ""}`
    .toLocaleLowerCase();
  return matchesStatus && haystack.includes(eventSearch.toLocaleLowerCase());
});
```

Map compact role items to the same node selection path and preserve the existing collapse behavior:

```javascript
for (const role of document.querySelectorAll("[data-role]")) {
  role.addEventListener("click", () => openInspector({
    kind: "node",
    id: role.dataset.role,
  }));
}

elements["records-collapse"].addEventListener("click", () => {
  const collapsed = elements["run-records"].classList.toggle("collapsed");
  elements["records-collapse"].textContent = collapsed
    ? "展开运行记录"
    : "收起运行记录";
  elements["records-collapse"].setAttribute("aria-expanded", String(!collapsed));
});
```

- [ ] **Step 6: Run Trace and full frontend tests**

```powershell
pytest tests/test_web_frontend.py::test_trace_page_preserves_diagnostics_in_vertical_layout -v
pytest tests/test_web_frontend.py -v
```

Expected: all tests pass.

- [ ] **Step 7: Commit the Trace layout**

```powershell
git add web/trace.html web/trace.css web/app.js tests/test_web_frontend.py
git commit -m "feat: redesign trace as vertical diagnostics"
```

## Task 6: Preserve Graph Topology and Add Zoom/Fit

**Files:**
- Create: `tests/frontend_visualizer.test.mjs`
- Modify: `web/visualizer.js`
- Modify: `web/app.js`
- Modify: `web/trace.css`

- [ ] **Step 1: Write failing graph topology and zoom tests**

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { EDGE_DEFINITIONS, nextZoom } from "../web/visualizer.js";

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
```

- [ ] **Step 2: Run the graph test and verify it fails**

```powershell
node --experimental-default-type=module --test tests/frontend_visualizer.test.mjs
```

Expected: FAIL because `EDGE_DEFINITIONS` and `nextZoom` are not exported.

- [ ] **Step 3: Export immutable topology and zoom helpers**

```javascript
export const EDGE_DEFINITIONS = Object.freeze([
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

const ZOOM_LEVELS = [0.75, 1, 1.25];

export function nextZoom(current, direction) {
  const index = ZOOM_LEVELS.indexOf(current);
  const safeIndex = index === -1 ? 1 : index;
  return ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, safeIndex + direction))];
}
```

Extend `ExecutionVisualizer` with `setZoom(scale)` and `fit()` methods. Scale `#execution-graph` and resize `#graph-stage` to the scaled base dimensions so scrollbars match the visual size. Call `drawEdges()` after sizing and preserve the same node status calculations.

- [ ] **Step 4: Wire controls and keyboard behavior**

In `app.js`:

```javascript
elements["graph-zoom-in"].addEventListener("click", () => visualizer.zoomBy(1));
elements["graph-zoom-out"].addEventListener("click", () => visualizer.zoomBy(-1));
elements["graph-fit"].addEventListener("click", () => visualizer.fit());
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && elements["inspector-drawer"].classList.contains("open")) {
    closeInspector();
  }
});
```

Use `ResizeObserver` to recalculate fit when the viewport changes, but do not reset a user-selected explicit zoom until they press the fit button.

- [ ] **Step 5: Run graph and frontend tests**

```powershell
node --experimental-default-type=module --test tests/frontend_visualizer.test.mjs tests/frontend_session.test.mjs
pytest tests/test_web_frontend.py -v
```

Expected: all tests pass.

- [ ] **Step 6: Commit graph interaction**

```powershell
git add web/visualizer.js web/app.js web/trace.css tests/frontend_visualizer.test.mjs
git commit -m "feat: add trace graph zoom and inspector drawer"
```

## Task 7: Accessibility, Responsive QA, and Guideline Review

**Files:**
- Modify: `web/index.html`
- Modify: `web/trace.html`
- Modify: `web/styles.css`
- Modify: `web/trace.css`
- Modify: `web/chat.js`
- Modify: `web/app.js`
- Modify: `tests/test_web_frontend.py`

- [ ] **Step 1: Add failing accessibility source checks**

```python
def test_frontend_has_accessible_controls_and_responsive_guards() -> None:
    pages = "\n".join(
        (WEB_ROOT / name).read_text(encoding="utf-8")
        for name in ("index.html", "trace.html")
    )
    styles = "\n".join(
        (WEB_ROOT / name).read_text(encoding="utf-8")
        for name in ("styles.css", "trace.css")
    )

    assert 'aria-live="polite"' in pages
    assert 'aria-label="关闭节点详情"' in pages
    assert ":focus-visible" in styles
    assert "prefers-reduced-motion" in styles
    assert "@media (max-width: 900px)" in styles
    assert "font-size: 8px" not in styles
    assert "font-size: 9px" not in styles
    assert "font-size: 10px" not in styles
```

- [ ] **Step 2: Run the accessibility test and verify it fails**

```powershell
pytest tests/test_web_frontend.py::test_frontend_has_accessible_controls_and_responsive_guards -v
```

Expected: FAIL until all semantic labels and minimum font sizes are applied.

- [ ] **Step 3: Complete keyboard, focus, and mobile behavior**

Implement these exact behaviors:

- Chat sidebar opens from the mobile menu and closes through a labeled close button or backdrop.
- Composer submits on `Ctrl+Enter`/`Meta+Enter`; plain Enter remains available for multiline text.
- Drawer traps no permanent focus, closes on `Escape`, and returns focus to the selected node/event.
- Disabled Trace links use both `aria-disabled="true"` and click prevention.
- All icon buttons have labels and titles.
- `prefers-reduced-motion: reduce` disables drawer and status animation.
- Mobile graph and event data scroll horizontally instead of shrinking below readable sizes.

Use CSS minimum font sizes of `11px` for auxiliary text, `12px` for controls/table text, `13px` for nodes, and `14px` for reading content.

- [ ] **Step 4: Apply the market-tested Web Interface Guidelines review**

Fetch the current rules from:

```text
https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
```

Review `web/*.html`, `web/*.css`, and `web/*.js`. Fix every applicable accessibility, focus, touch target, overflow, form labeling, reduced-motion, and responsive issue. Record any intentionally inapplicable rule in the implementation notes rather than suppressing it in code.

- [ ] **Step 5: Run frontend tests and inspect source**

```powershell
pytest tests/test_web_frontend.py -v
node --experimental-default-type=module --test tests/frontend_visualizer.test.mjs tests/frontend_session.test.mjs
rg -n "font-size: (8|9|10)px|outline: none|transition: all|https://" web
```

Expected: tests pass and `rg` reports no prohibited matches.

- [ ] **Step 6: Commit accessibility and responsive fixes**

```powershell
git add web tests/test_web_frontend.py
git commit -m "fix: polish responsive frontend accessibility"
```

## Task 8: End-to-End and Regression Verification

**Files:**
- Modify only if verification finds a scoped frontend defect.

- [ ] **Step 1: Run automated verification**

```powershell
pytest tests/test_web_frontend.py tests/test_trace_api.py tests/test_trace_store.py tests/test_trace_monitor.py -v
node --experimental-default-type=module --test tests/frontend_visualizer.test.mjs tests/frontend_session.test.mjs
pytest -q
```

Expected: focused frontend/Trace suites and Node suites pass. Full pytest may retain only the documented RAGFlow SDK `v0.24.0` versus server `v0.27.0` compatibility failure.

- [ ] **Step 2: Start the application on an available local port**

Check port `8002`; if occupied by this project, reuse it. Otherwise start:

```powershell
uvicorn api.server:app --host 127.0.0.1 --port 8002
```

Expected: application responds at `http://127.0.0.1:8002/` and `/trace`.

- [ ] **Step 3: Verify the real chat workflow in the browser**

At desktop `1440x900`:

1. Open `/` and confirm sidebar, empty state, composer, and no overlap.
2. Submit `查询华为擎云 W585X 的库存，并结合知识库总结适用场景。`
3. Confirm `POST /api/task` occurs, WebSocket connects with `run_id` and `after_sequence`, and status updates are visible.
4. Confirm the final answer renders as safe Markdown.
5. Confirm generated files appear with working `/api/download` links when present.
6. Confirm the session appears in the browser sidebar and survives refresh.
7. Open “运行详情” and verify the selected thread/run appears in the URL.

- [ ] **Step 4: Verify Trace diagnostics and scrolling**

1. Confirm `.trace-scroll.scrollHeight > .trace-scroll.clientHeight` for a populated run.
2. Scroll from the run summary to the bottom raw events panel.
3. Confirm all eight graph nodes and eleven SVG edges are present.
4. Exercise `75%`, `100%`, `125%`, and fit controls.
5. Open a node drawer, switch all five inspector tabs, close with `Escape`, and confirm focus returns.
6. Search/filter events and confirm only rendered rows change; stored event count remains unchanged.
7. Switch Events, Final report, Generated files, and Raw events tabs.

- [ ] **Step 5: Verify mobile layout and visual pixels**

At a mobile viewport near `390x844`:

1. Confirm the sidebar is a dismissible drawer.
2. Confirm no text or controls overlap.
3. Confirm the composer does not cover the latest message.
4. Confirm graph and event data can scroll horizontally.
5. Capture chat and Trace screenshots.
6. Check screenshots are nonblank and contain substantial non-background pixels.

- [ ] **Step 6: Inspect browser errors and final diff**

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors, no browser console errors, and unrelated user changes in `agent/llm.py`, `prompt/prompts.yml`, database files, and RAGFlow compatibility work remain untouched.

- [ ] **Step 7: Commit any verification-only fixes**

If Step 3-6 required scoped fixes:

```powershell
git add web api/server.py tests/test_web_frontend.py tests/frontend_session.test.mjs tests/frontend_visualizer.test.mjs
git commit -m "fix: address frontend verification findings"
```

If no fixes were required, do not create an empty commit.
