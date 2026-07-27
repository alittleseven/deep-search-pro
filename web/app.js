import {
  connectTrace,
  downloadUrl,
  fetchFiles,
  fetchThreadRuns,
  fetchTrace,
  startTask,
  uploadFiles,
} from "./api.js";
import {
  ConsoleStore,
  isTerminalStatus,
  ROLE_DEFINITIONS,
  roleForEvent,
} from "./state.js";
import {
  ExecutionVisualizer,
  statusForNode,
} from "./visualizer.js";

const store = new ConsoleStore();
const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element]),
);

let queuedFiles = [];
let socket = null;
let socketGeneration = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let reconnectAttempts = 0;
let selected = { kind: "node", id: "main" };
let inspectorTab = "overview";
let bottomTab = "events";
let lastReportedOutput = Symbol("initial");
let noticeTimer = null;

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

function stringifyValue(value) {
  if (value === undefined) return "Unavailable";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

function selectEvent(event) {
  selected = {
    kind: "event",
    id: event.event_id || `${event.run_id}:${event.sequence}`,
    event,
  };
  render(store.snapshot);
}

function selectNode(nodeId) {
  selected = { kind: "node", id: nodeId };
  visualizer.select(nodeId);
  render(store.snapshot);
}

function renderEvents(snapshot) {
  const list = elements["events-list"];
  if (!snapshot.events.length) {
    list.replaceChildren(makeElement("div", "empty-state", "No trace events received."));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const event of snapshot.events) {
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
    row.addEventListener("click", () => selectEvent(event));
    fragment.append(row);
  }
  list.replaceChildren(fragment);
}

function isSafeLink(href) {
  try {
    const url = new URL(href, window.location.href);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function appendInlineMarkdown(parent, text) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_([^_\n]+)_|\[[^\]\n]+\]\([^) \n]+\))/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index || 0;
    if (index > cursor) {
      parent.append(document.createTextNode(text.slice(cursor, index)));
    }
    const token = match[0];
    if (token.startsWith("`")) {
      parent.append(makeElement("code", "", token.slice(1, -1)));
    } else if (token.startsWith("**") || token.startsWith("__")) {
      parent.append(makeElement("strong", "", token.slice(2, -2)));
    } else if (token.startsWith("*") || token.startsWith("_")) {
      parent.append(makeElement("em", "", token.slice(1, -1)));
    } else if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch && isSafeLink(linkMatch[2])) {
        const anchor = makeElement("a", "", linkMatch[1]);
        anchor.href = linkMatch[2];
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        parent.append(anchor);
      } else {
        parent.append(document.createTextNode(token));
      }
    }
    cursor = index + token.length;
  }
  if (cursor < text.length) {
    parent.append(document.createTextNode(text.slice(cursor)));
  }
}

function isBlockStart(line) {
  return /^(#{1,6})\s+/.test(line)
    || /^```/.test(line)
    || /^\s*>\s?/.test(line)
    || /^\s*[-*+]\s+/.test(line)
    || /^\s*\d+\.\s+/.test(line)
    || /^\s*(---+|\*\*\*+)\s*$/.test(line);
}

function renderMarkdown(value, container) {
  const source = stringifyValue(value).replaceAll("\r\n", "\n");
  const lines = source.split("\n");
  const fragment = document.createDocumentFragment();
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```(.*)$/);
    if (fence) {
      index += 1;
      const codeLines = [];
      while (index < lines.length && !/^```/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = makeElement("pre");
      const code = makeElement("code", "", codeLines.join("\n"));
      if (fence[1].trim()) code.dataset.language = fence[1].trim();
      pre.append(code);
      fragment.append(pre);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const element = makeElement(`h${heading[1].length}`);
      appendInlineMarkdown(element, heading[2]);
      fragment.append(element);
      index += 1;
      continue;
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      fragment.append(makeElement("hr"));
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const values = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        values.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      const quote = makeElement("blockquote");
      appendInlineMarkdown(quote, values.join("\n"));
      fragment.append(quote);
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      const list = makeElement(unordered ? "ul" : "ol");
      const matcher = unordered ? /^\s*[-*+]\s+(.+)$/ : /^\s*\d+\.\s+(.+)$/;
      while (index < lines.length) {
        const itemMatch = lines[index].match(matcher);
        if (!itemMatch) break;
        const item = makeElement("li");
        appendInlineMarkdown(item, itemMatch[1]);
        list.append(item);
        index += 1;
      }
      fragment.append(list);
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length
      && lines[index].trim()
      && !isBlockStart(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraph = makeElement("p");
    appendInlineMarkdown(paragraph, paragraphLines.join(" "));
    fragment.append(paragraph);
  }
  container.replaceChildren(fragment);
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

async function refreshFiles(path = store.snapshot.outputPath) {
  if (!path) return;
  try {
    const result = await fetchFiles(path);
    store.setFiles(result.files || []);
  } catch (error) {
    store.addClientError(error.message, "files");
    showNotice(`Could not load generated files: ${error.message}`);
  }
}

function clearSocketTimers() {
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  reconnectTimer = null;
  heartbeatTimer = null;
}

function closeSocket() {
  socketGeneration += 1;
  clearSocketTimers();
  if (socket) {
    socket.close(1000, "client navigation");
    socket = null;
  }
}

function scheduleReconnect(generation) {
  if (generation !== socketGeneration || isTerminalStatus(store.snapshot.taskStatus)) return;
  const delay = Math.min(1000 * (2 ** reconnectAttempts), 15000);
  reconnectAttempts += 1;
  reconnectTimer = window.setTimeout(() => connectSocket(), delay);
}

function connectSocket() {
  const { threadId, runId, lastSequence } = store.snapshot;
  if (!threadId || !runId) return;

  closeSocket();
  const generation = socketGeneration;
  store.setConnection("connecting");

  const nextSocket = connectTrace({
    threadId,
    runId,
    afterSequence: lastSequence,
    onOpen: () => {
      if (generation !== socketGeneration) return;
      reconnectAttempts = 0;
      store.setConnection("connected");
      heartbeatTimer = window.setInterval(() => {
        if (nextSocket.readyState === WebSocket.OPEN) {
          nextSocket.send("ping");
        }
      }, 25000);
    },
    onMessage: (message) => {
      if (generation !== socketGeneration) return;
      store.addRawMessage(message);
      if (message.type === "monitor_event" || message.event) {
        const added = store.addEvent(message);
        if (added && message.event === "session_created") {
          refreshFiles();
        }
        if (added && (message.event === "run_completed" || message.event === "run_failed")) {
          refreshFiles();
          clearInterval(heartbeatTimer);
        }
      }
    },
    onError: () => {
      if (generation !== socketGeneration) return;
      store.setConnection("disconnected");
    },
    onClose: (event) => {
      if (generation !== socketGeneration) return;
      clearInterval(heartbeatTimer);
      socket = null;
      store.setConnection("disconnected");
      if (event.code === 4404) {
        store.addClientError("The saved run is no longer available in the trace store.", "websocket");
        showNotice("The saved run is no longer available. Start a new run to reconnect.", true);
        return;
      }
      if (!isTerminalStatus(store.snapshot.taskStatus)) {
        scheduleReconnect(generation);
      }
    },
  });
  socket = nextSocket;
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
    if (queuedFiles.length) {
      store.setTaskStatus("uploading");
      await uploadFiles(threadId, queuedFiles);
    }
    store.setTaskStatus("starting");
    const response = await startTask(query, threadId);
    if (!response.run_id || !response.thread_id) {
      throw new Error("The task response did not include thread_id and run_id.");
    }
    store.beginRun({
      query,
      threadId: response.thread_id,
      runId: response.run_id,
    });
    queuedFiles = [];
    elements["file-input"].value = "";
    updateUploadMeta();
    connectSocket();
  } catch (error) {
    store.setTaskStatus("failed");
    store.addClientError(error.message, "task");
    showNotice(`Could not start the task: ${error.message}`, true);
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
    let runId = store.snapshot.runId;
    let summary = null;

    if (!runId && store.snapshot.threadId) {
      const thread = await fetchThreadRuns(store.snapshot.threadId);
      summary = thread.runs?.[0] || null;
      runId = summary?.run_id || null;
      if (runId) store.patch({ runId });
    }
    if (!runId) {
      store.setTaskStatus("idle");
      return;
    }

    if (!summary) {
      const thread = await fetchThreadRuns(store.snapshot.threadId);
      summary = thread.runs?.find((run) => run.run_id === runId) || null;
    }
    store.prepareRestore();
    const trace = await fetchTrace(runId, 0);
    for (const event of trace.events) {
      store.addEvent(event);
    }
    if (!trace.events.length && summary) {
      store.patch({
        taskStatus: summary.status || "idle",
        startedAt: summary.started_at || null,
        endedAt: summary.ended_at || null,
      });
    }
    await refreshFiles();
    if (!isTerminalStatus(store.snapshot.taskStatus)) {
      connectSocket();
    } else {
      store.setConnection("idle");
    }
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
  closeSocket();
  queuedFiles = [];
  elements["file-input"].value = "";
  elements["task-input"].value = "";
  lastReportedOutput = Symbol("reset");
  selected = { kind: "node", id: "main" };
  updateUploadMeta();
  store.newSession();
});

elements["copy-thread"].addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(store.snapshot.threadId);
    elements["copy-thread"].textContent = "Copied";
    window.setTimeout(() => {
      elements["copy-thread"].textContent = "Copy";
    }, 1400);
  } catch {
    showNotice("Clipboard access was unavailable.");
  }
});

for (const card of document.querySelectorAll("[data-role]")) {
  card.addEventListener("click", () => selectNode(card.dataset.role));
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
  });
}

elements["collapse-bottom"].addEventListener("click", () => {
  const panel = document.querySelector(".bottom-panel");
  const collapsed = panel.classList.toggle("collapsed");
  elements["collapse-bottom"].textContent = collapsed ? "Expand" : "Collapse";
  elements["collapse-bottom"].setAttribute("aria-expanded", String(!collapsed));
});

elements["dismiss-notice"].addEventListener("click", () => {
  clearTimeout(noticeTimer);
  elements.notice.classList.add("hidden");
});

window.addEventListener("beforeunload", closeSocket);
store.subscribe(render);
window.setInterval(updateElapsed, 1000);
restoreSession();
