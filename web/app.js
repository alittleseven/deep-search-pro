import { downloadUrl } from "./api.js?v=20260824-1";
import { renderMarkdown, stringifyValue } from "./markdown.js?v=20260824-1";
import { RunClient } from "./run-client.js?v=20260824-1";
import {
  chatUrl,
  createSessionRecord,
  parseTraceSelection,
  restoredQuery,
  SessionRepository,
} from "./session.js?v=20260824-1";
import {
  ConsoleStore,
  ROLE_DEFINITIONS,
  roleForEvent,
} from "./state.js?v=20260824-1";
import {
  ExecutionVisualizer,
  statusForNode,
} from "./visualizer.js?v=20260824-1";

const repository = new SessionRepository();
const fallback = repository.list()[0] || {};
const viewParams = new URLSearchParams(window.location.search);
const selection = parseTraceSelection(window.location.search, fallback);
const store = new ConsoleStore(selection);
const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element]),
);

let queuedFiles = [];
let selected = { kind: "node", id: "main" };
let selectedTrigger = null;
let inspectorTab = "overview";
let bottomTab = ["events", "report", "files", "raw"].includes(viewParams.get("tab"))
  ? viewParams.get("tab")
  : "events";
let eventSearch = viewParams.get("event_search") || "";
let eventStatusFilter = ["all", "running", "completed", "failed"].includes(
  viewParams.get("event_status"),
)
  ? viewParams.get("event_status")
  : "all";
let inputRunId = null;
let lastReportedOutput = Symbol("initial");
let noticeTimer = null;
const runClient = new RunClient({ store, onNotice: showNotice });

const visualizer = new ExecutionVisualizer(
  elements["execution-graph"],
  (nodeId) => selectNode(nodeId),
);

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatIdentifier(value) {
  if (!value) return "—";
  return value.length > 18
    ? `${value.slice(0, 9)}…${value.slice(-5)}`
    : value;
}

function formatStatus(status) {
  if (!status) return "Unknown";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatEventName(event) {
  return String(event || "unknown").replaceAll("_", " ");
}

function formatTime(value, includeDate = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    ...(includeDate ? { year: "numeric", month: "short", day: "2-digit" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  return `${remainder}s`;
}

function showNotice(message, sticky = false) {
  clearTimeout(noticeTimer);
  elements["notice-text"].textContent = String(message);
  elements.notice.classList.remove("hidden");
  if (!sticky) {
    noticeTimer = window.setTimeout(() => {
      elements.notice.classList.add("hidden");
    }, 7000);
  }
}

function syncViewUrl() {
  const url = new URL(window.location.href);
  if (store.snapshot.threadId) url.searchParams.set("thread_id", store.snapshot.threadId);
  else url.searchParams.delete("thread_id");
  if (store.snapshot.runId) url.searchParams.set("run_id", store.snapshot.runId);
  else url.searchParams.delete("run_id");
  if (bottomTab === "events") url.searchParams.delete("tab");
  else url.searchParams.set("tab", bottomTab);
  if (eventSearch) url.searchParams.set("event_search", eventSearch);
  else url.searchParams.delete("event_search");
  if (eventStatusFilter === "all") url.searchParams.delete("event_status");
  else url.searchParams.set("event_status", eventStatusFilter);
  history.replaceState(null, "", url);
}

function taskLabel(status) {
  return {
    idle: "Idle",
    uploading: "Uploading",
    starting: "Starting",
    restoring: "Restoring",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  }[status] || formatStatus(status);
}

function connectionLabel(status) {
  return {
    idle: store.snapshot.runId ? "Trace loaded" : "No active run",
    connecting: "Connecting",
    connected: "Live connection",
    disconnected: "Disconnected",
  }[status] || formatStatus(status);
}

function updateElapsed(snapshot = store.snapshot) {
  if (!snapshot.startedAt) {
    elements["metric-elapsed"].textContent = "—";
    return;
  }
  const start = new Date(snapshot.startedAt).getTime();
  const end = snapshot.endedAt
    ? new Date(snapshot.endedAt).getTime()
    : Date.now();
  elements["metric-elapsed"].textContent = formatDuration(end - start);
}

function latestActiveRole(snapshot) {
  return Object.values(snapshot.roles)
    .filter((role) => role.status === "active")
    .sort((a, b) => {
      const aSequence = a.lastEvent?.sequence || 0;
      const bSequence = b.lastEvent?.sequence || 0;
      return bSequence - aSequence;
    })[0];
}

function renderHeader(snapshot) {
  elements["thread-id"].textContent = formatIdentifier(snapshot.threadId);
  elements["thread-id"].title = snapshot.threadId;
  elements["run-id"].textContent = formatIdentifier(snapshot.runId);
  elements["run-id"].title = snapshot.runId || "";
  elements["chat-link"].href = chatUrl(snapshot.threadId, snapshot.runId);

  const query = restoredQuery(inputRunId, snapshot);
  if (query !== null) {
    elements["task-input"].value = query;
    inputRunId = snapshot.runId;
  }

  elements["connection-pill"].dataset.status = snapshot.connection;
  elements["connection-label"].textContent = connectionLabel(snapshot.connection);
  elements["task-state"].dataset.status = snapshot.taskStatus;
  elements["task-state"].textContent = taskLabel(snapshot.taskStatus);

  const busy = ["uploading", "starting", "restoring", "running"].includes(
    snapshot.taskStatus,
  );
  elements["run-button"].disabled = busy || !elements["task-input"].value.trim();
  elements["run-button"].textContent = busy ? taskLabel(snapshot.taskStatus) : "Run search";
}

function renderMetrics(snapshot) {
  elements["metric-events"].textContent = String(snapshot.events.length);
  elements["metric-tools"].textContent = String(
    snapshot.events.filter((event) => event.event === "tool_started").length,
  );
  elements["metric-files"].textContent = String(snapshot.files.length);
  elements["metric-connection"].textContent = connectionLabel(snapshot.connection);
  const activeRole = latestActiveRole(snapshot);
  elements["metric-agent"].textContent = activeRole
    ? ROLE_DEFINITIONS[activeRole.id].label
    : "—";
  updateElapsed(snapshot);
}

function renderAgents(snapshot) {
  let activeCount = 0;
  for (const card of document.querySelectorAll("[data-role]")) {
    const role = snapshot.roles[card.dataset.role];
    if (!role) continue;
    if (role.status === "active") activeCount += 1;
    card.dataset.status = role.status;
    card.classList.toggle(
      "selected",
      selected.kind === "node" && selected.id === card.dataset.role,
    );
    const badge = card.querySelector("[data-agent-status]");
    badge.textContent = formatStatus(role.status);
    badge.dataset.status = role.status;
    card.querySelector("[data-agent-event]").textContent = role.lastEvent
      ? role.lastEvent.message || formatEventName(role.lastEvent.event)
      : "No events observed";
    card.querySelector("[data-agent-availability]").textContent = role.observed
      ? "Observed in trace"
      : "Availability unreported";
    card.querySelector("[data-agent-count]").textContent =
      `${role.count} ${role.count === 1 ? "trigger" : "triggers"}`;
  }
  elements["active-role-count"].textContent = `${activeCount} active`;
}

function eventSource(event) {
  if (event.name) return event.name;
  const role = roleForEvent(event);
  if (role) return ROLE_DEFINITIONS[role].label;
  return event.node_type || "Run";
}

function openInspector(nextSelection, trigger = document.activeElement) {
  selected = nextSelection;
  selectedTrigger = trigger instanceof HTMLElement ? trigger : null;
  elements["inspector-drawer"].classList.add("open");
  elements["inspector-backdrop"].classList.add("open");
  elements["inspector-drawer"].removeAttribute("inert");
  elements["inspector-drawer"].setAttribute("aria-hidden", "false");
  render(store.snapshot);
  elements["close-inspector"].focus();
}

function closeInspector() {
  elements["inspector-drawer"].classList.remove("open");
  elements["inspector-backdrop"].classList.remove("open");
  elements["inspector-drawer"].setAttribute("inert", "");
  elements["inspector-drawer"].setAttribute("aria-hidden", "true");
  selectedTrigger?.focus();
}

function selectEvent(event, trigger) {
  openInspector({
    kind: "event",
    id: event.event_id || `${event.run_id}:${event.sequence}`,
    event,
  }, trigger);
}

function selectNode(nodeId, trigger) {
  visualizer.select(nodeId);
  openInspector({ kind: "node", id: nodeId }, trigger);
}

function renderEvents(snapshot) {
  const list = elements["events-list"];
  const normalizedSearch = eventSearch.toLocaleLowerCase();
  const visibleEvents = snapshot.events.filter((event) => {
    const matchesStatus = eventStatusFilter === "all"
      || (event.status || "unknown") === eventStatusFilter;
    const haystack = `${event.name || ""} ${event.event || ""} ${event.message || ""}`
      .toLocaleLowerCase();
    return matchesStatus && haystack.includes(normalizedSearch);
  });
  if (!visibleEvents.length) {
    const message = snapshot.events.length
      ? "没有符合筛选条件的事件。"
      : "暂无追踪事件。";
    list.replaceChildren(makeElement("div", "empty-state", message));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const event of visibleEvents) {
    const row = makeElement("button", "event-row event-grid");
    row.type = "button";
    row.dataset.status = event.status || "unknown";
    if (
      selected.kind === "event"
      && selected.id === (event.event_id || `${event.run_id}:${event.sequence}`)
    ) {
      row.classList.add("selected");
    }
    row.append(
      makeElement("span", "", formatTime(event.timestamp)),
      makeElement("span", "", eventSource(event)),
      makeElement("span", "", formatEventName(event.event)),
      makeElement("span", "event-status", event.status || "—"),
      makeElement("span", "", event.message || "—"),
    );
    row.title = `Sequence ${event.sequence || "—"} · ${event.event}`;
    row.addEventListener("click", () => selectEvent(event, row));
    fragment.append(row);
  }
  list.replaceChildren(fragment);
}

function renderReport(snapshot) {
  if (snapshot.finalOutput === lastReportedOutput) return;
  lastReportedOutput = snapshot.finalOutput;
  if (snapshot.finalOutput === null || snapshot.finalOutput === undefined) {
    const empty = makeElement("div", "empty-state");
    empty.append(
      "The final Markdown report appears after a real ",
      makeElement("code", "", "run_completed"),
      " event.",
    );
    elements["final-report"].replaceChildren(empty);
    return;
  }
  if (typeof snapshot.finalOutput === "string" && !snapshot.finalOutput.trim()) {
    elements["final-report"].replaceChildren(makeElement(
      "div",
      "empty-state",
      "The run completed without report content.",
    ));
    return;
  }
  renderMarkdown(snapshot.finalOutput, elements["final-report"]);
}

function fileKind(name) {
  const extension = String(name).split(".").pop();
  return extension && extension !== name ? extension.toUpperCase() : "FILE";
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function renderFiles(snapshot) {
  const list = elements["files-list"];
  if (!snapshot.files.length) {
    list.replaceChildren(makeElement(
      "div",
      "empty-state",
      snapshot.outputPath
        ? "No generated files found in the session directory."
        : "Generated files appear after the backend creates a session directory.",
    ));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const file of snapshot.files) {
    const row = makeElement("div", "file-row");
    const name = makeElement("strong", "", file.name || "Unnamed file");
    name.title = file.path || file.name || "";
    const link = makeElement("a", "", "Download");
    link.href = downloadUrl(file.path);
    link.setAttribute("download", file.name || "");
    const modified = Number(file.mtime) * 1000;
    row.append(
      name,
      makeElement("span", "file-kind", fileKind(file.name || "")),
      makeElement("span", "", formatBytes(file.size)),
      makeElement(
        "span",
        "file-time",
        Number.isFinite(modified) ? formatTime(modified, true) : "—",
      ),
      link,
    );
    fragment.append(row);
  }
  list.replaceChildren(fragment);
}

function renderRaw(snapshot) {
  if (!snapshot.events.length && !snapshot.rawMessages.length && !snapshot.clientErrors.length) {
    elements["raw-events"].textContent = "No WebSocket messages received.";
    return;
  }
  elements["raw-events"].textContent = JSON.stringify({
    trace_events: snapshot.events,
    websocket_messages: snapshot.rawMessages,
    client_errors: snapshot.clientErrors,
  }, null, 2);
}

function eventForNode(snapshot, nodeId) {
  if (nodeId === "input") {
    return snapshot.events.find((event) => event.event === "run_started") || null;
  }
  if (nodeId === "output") {
    return snapshot.events.findLast(
      (event) => event.event === "run_completed" || event.event === "run_failed",
    ) || null;
  }
  if (nodeId === "synthesis") {
    return snapshot.events.findLast(
      (event) => event.node_type === "model" || event.event?.startsWith("report_"),
    ) || null;
  }
  return snapshot.roles[nodeId]?.lastEvent || null;
}

function selectedEvent(snapshot) {
  if (selected.kind === "event") {
    return snapshot.events.find(
      (event) => (event.event_id || `${event.run_id}:${event.sequence}`) === selected.id,
    ) || selected.event || null;
  }
  return eventForNode(snapshot, selected.id);
}

function selectedTitle(snapshot) {
  if (selected.kind === "event") {
    const event = selectedEvent(snapshot);
    return event ? formatEventName(event.event) : "Event";
  }
  return {
    input: "User Request",
    synthesis: "Main Agent Synthesis",
    output: "Final Output",
    ...Object.fromEntries(
      Object.entries(ROLE_DEFINITIONS).map(([id, definition]) => [id, definition.label]),
    ),
  }[selected.id] || "Inspector";
}

function detailList(rows) {
  const list = makeElement("dl", "detail-list");
  for (const [label, value] of rows) {
    const row = makeElement("div", "detail-row");
    row.append(
      makeElement("dt", "", label),
      makeElement("dd", "", value === null || value === undefined ? "—" : String(value)),
    );
    list.append(row);
  }
  return list;
}

function jsonPanel(value, error = false) {
  if (value === null || value === undefined) {
    return makeElement("div", "inspector-empty", "No data is available for this section.");
  }
  return makeElement("pre", `json-block${error ? " error-block" : ""}`, stringifyValue(value));
}

function renderInspector(snapshot) {
  const event = selectedEvent(snapshot);
  const title = selectedTitle(snapshot);
  const nodeStatus = selected.kind === "node"
    ? statusForNode(snapshot, selected.id)
    : event?.status || "unknown";
  elements["inspector-title"].textContent = title;
  elements["inspector-status"].textContent = formatStatus(nodeStatus);
  elements["inspector-status"].dataset.status = nodeStatus;

  let content;
  if (inspectorTab === "overview") {
    if (event) {
      content = detailList([
        ["Name", event.name || title],
        ["Event type", event.event],
        ["Status", event.status || "—"],
        ["Time", formatTime(event.timestamp, true)],
        ["Sequence", event.sequence ?? "—"],
        ["Entity ID", event.entity_id || "—"],
        ["Parent ID", event.parent_id || "—"],
        ["Tool", event.node_type === "tool" ? event.name || "—" : "—"],
        ["Duration", event.duration_ms == null ? "Unavailable" : formatDuration(event.duration_ms)],
      ]);
    } else if (selected.kind === "node") {
      const purpose = ROLE_DEFINITIONS[selected.id]?.purpose
        || {
          input: "The research task accepted by the HTTP API.",
          synthesis: "An architectural phase without a dedicated event in the current producer.",
          output: "The output provided by a terminal run event.",
        }[selected.id];
      content = detailList([
        ["Name", title],
        ["Status", formatStatus(nodeStatus)],
        ["Purpose", purpose || "—"],
        ["Trace evidence", "No matching event observed"],
      ]);
    } else {
      content = makeElement("div", "inspector-empty", "Select an event or graph node to inspect it.");
    }
  } else if (inspectorTab === "input") {
    content = jsonPanel(event?.input);
  } else if (inspectorTab === "output") {
    content = jsonPanel(event?.output);
  } else if (inspectorTab === "event") {
    content = jsonPanel(event);
  } else {
    content = jsonPanel(event?.error, true);
  }
  elements["inspector-body"].replaceChildren(content);
}

function renderBottomTabs() {
  for (const button of document.querySelectorAll("[data-bottom-tab]")) {
    button.classList.toggle("active", button.dataset.bottomTab === bottomTab);
  }
  for (const panel of document.querySelectorAll("[data-bottom-panel]")) {
    panel.classList.toggle("active", panel.dataset.bottomPanel === bottomTab);
  }
}

function render(snapshot) {
  renderHeader(snapshot);
  renderMetrics(snapshot);
  renderAgents(snapshot);
  renderEvents(snapshot);
  renderReport(snapshot);
  renderFiles(snapshot);
  renderRaw(snapshot);
  renderInspector(snapshot);
  renderBottomTabs();
  visualizer.update(snapshot);
  visualizer.select(selected.kind === "node" ? selected.id : "");
  elements["graph-empty"].classList.toggle("hidden", Boolean(snapshot.runId));
  elements["tab-event-count"].textContent = String(snapshot.events.length);
  elements["tab-file-count"].textContent = String(snapshot.files.length);
}

async function runSearch() {
  const query = elements["task-input"].value.trim();
  if (!query) {
    showNotice("Enter a research task before starting.");
    elements["task-input"].focus();
    return;
  }
  if (["uploading", "starting", "restoring", "running"].includes(store.snapshot.taskStatus)) {
    return;
  }

  const threadId = store.snapshot.threadId || crypto.randomUUID();
  try {
    const response = await runClient.start({
      query,
      threadId,
      files: queuedFiles,
    });
    if (!response) return;
    repository.save(createSessionRecord({
      threadId: response.thread_id,
      runId: response.run_id,
      query,
      status: "running",
    }));
    syncViewUrl();
    queuedFiles = [];
    elements["file-input"].value = "";
    updateUploadMeta();
  } catch (error) {
    store.setTaskStatus("failed");
    store.addClientError(error.message, "task");
    showNotice(`无法启动任务：${error.message}。请检查服务配置后重试。`, true);
  }
}

function updateUploadMeta() {
  elements["upload-meta"].textContent = queuedFiles.length
    ? `${queuedFiles.length} selected · ${queuedFiles.map((file) => file.name).join(", ")}`
    : "Drop files or browse";
}

function setQueuedFiles(files) {
  queuedFiles = [...files];
  updateUploadMeta();
}

async function restoreSession() {
  try {
    const summary = await runClient.restore({
      threadId: store.snapshot.threadId,
      runId: store.snapshot.runId,
    });
    if (!summary) {
      store.setTaskStatus("idle");
    }
    syncViewUrl();
  } catch (error) {
    store.addClientError(error.message, "restore");
    store.patch({
      runId: null,
      lastSequence: 0,
      taskStatus: "idle",
      connection: "idle",
    });
    showNotice("The previous in-memory trace is no longer available. The thread ID was preserved.");
  }
}

elements["run-button"].addEventListener("click", runSearch);
elements["task-input"].addEventListener("input", () => renderHeader(store.snapshot));
elements["task-input"].addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    runSearch();
  }
});

elements["file-input"].addEventListener("change", (event) => {
  setQueuedFiles(event.target.files || []);
});
elements["upload-zone"].addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    elements["file-input"].click();
  }
});
for (const eventName of ["dragenter", "dragover"]) {
  elements["upload-zone"].addEventListener(eventName, (event) => {
    event.preventDefault();
    elements["upload-zone"].classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements["upload-zone"].addEventListener(eventName, (event) => {
    event.preventDefault();
    elements["upload-zone"].classList.remove("dragging");
  });
}
elements["upload-zone"].addEventListener("drop", (event) => {
  if (event.dataTransfer?.files?.length) {
    setQueuedFiles(event.dataTransfer.files);
  }
});

elements["new-session"].addEventListener("click", () => {
  if (
    store.snapshot.taskStatus === "running"
    && !window.confirm("The backend run will continue. Detach this console and create a new session?")
  ) {
    return;
  }
  runClient.close();
  queuedFiles = [];
  elements["file-input"].value = "";
  elements["task-input"].value = "";
  lastReportedOutput = Symbol("reset");
  selected = { kind: "node", id: "main" };
  updateUploadMeta();
  store.newSession();
  history.replaceState(null, "", "/trace");
});

elements["copy-thread"].addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(store.snapshot.threadId);
    showNotice("线程 ID 已复制");
  } catch {
    showNotice("无法复制线程 ID。");
  }
});

for (const card of document.querySelectorAll("[data-role]")) {
  card.addEventListener("click", () => selectNode(card.dataset.role, card));
}

for (const button of document.querySelectorAll("[data-inspector-tab]")) {
  button.addEventListener("click", () => {
    inspectorTab = button.dataset.inspectorTab;
    for (const tab of document.querySelectorAll("[data-inspector-tab]")) {
      tab.classList.toggle("active", tab === button);
    }
    renderInspector(store.snapshot);
  });
}

for (const button of document.querySelectorAll("[data-bottom-tab]")) {
  button.addEventListener("click", () => {
    bottomTab = button.dataset.bottomTab;
    renderBottomTabs();
    syncViewUrl();
  });
}

elements["records-collapse"].addEventListener("click", () => {
  const collapsed = elements["run-records"].classList.toggle("collapsed");
  elements["records-collapse"].textContent = collapsed
    ? "展开运行记录"
    : "收起运行记录";
  elements["records-collapse"].setAttribute("aria-expanded", String(!collapsed));
});

elements["event-search"].addEventListener("input", (event) => {
  eventSearch = event.target.value;
  renderEvents(store.snapshot);
  syncViewUrl();
});

elements["event-status-filter"].addEventListener("change", (event) => {
  eventStatusFilter = event.target.value;
  renderEvents(store.snapshot);
  syncViewUrl();
});

elements["close-inspector"].addEventListener("click", closeInspector);
elements["inspector-backdrop"].addEventListener("click", closeInspector);
elements["graph-zoom-in"].addEventListener("click", () => visualizer.zoomBy(1));
elements["graph-zoom-out"].addEventListener("click", () => visualizer.zoomBy(-1));
elements["graph-fit"].addEventListener("click", () => visualizer.fit());

window.addEventListener("keydown", (event) => {
  const drawerOpen = elements["inspector-drawer"].classList.contains("open");
  if (event.key === "Escape" && drawerOpen) {
    closeInspector();
    return;
  }
  if (event.key === "Tab" && drawerOpen) {
    const focusable = [...elements["inspector-drawer"].querySelectorAll(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
    )];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

elements["dismiss-notice"].addEventListener("click", () => {
  clearTimeout(noticeTimer);
  elements.notice.classList.add("hidden");
});

window.addEventListener("beforeunload", () => runClient.close());
elements["event-search"].value = eventSearch;
elements["event-status-filter"].value = eventStatusFilter;
store.subscribe(render);
window.setInterval(updateElapsed, 1000);
restoreSession();
