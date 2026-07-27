const STORAGE_KEY = "deep-search-pro.console.v1";

export const ROLE_DEFINITIONS = {
  main: {
    label: "Main Agent",
    purpose: "Orchestrates research and produces the final response.",
  },
  network: {
    label: "Network Search",
    purpose: "Finds current public information through Tavily.",
  },
  database: {
    label: "Database Query",
    purpose: "Inspects MySQL tables and executes database queries.",
  },
  knowledge: {
    label: "Knowledge Base",
    purpose: "Queries configured RAGFlow knowledge assistants.",
  },
  files: {
    label: "Report / Files",
    purpose: "Generates Markdown, PDF, and other task artifacts.",
  },
};

const TERMINAL_EVENTS = new Set(["run_completed", "run_failed"]);
const ACTIVE_EVENTS = new Set([
  "agent_started",
  "tool_started",
  "model_started",
  "retrieval_started",
  "report_started",
]);
const COMPLETED_EVENTS = new Set([
  "agent_completed",
  "tool_completed",
  "model_completed",
  "retrieval_completed",
  "report_completed",
]);
const FAILED_EVENTS = new Set([
  "agent_failed",
  "tool_failed",
  "model_failed",
  "retrieval_failed",
  "report_failed",
]);

function createRoles() {
  return Object.fromEntries(Object.keys(ROLE_DEFINITIONS).map((id) => [
    id,
    {
      id,
      status: "idle",
      lastEvent: null,
      count: 0,
      observed: false,
    },
  ]));
}

function readPersisted() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function persistable(snapshot) {
  return {
    threadId: snapshot.threadId,
    runId: snapshot.runId,
    outputPath: snapshot.outputPath,
    lastSequence: snapshot.lastSequence,
  };
}

function eventKey(event) {
  return event.event_id
    || `${event.run_id || "run"}:${event.sequence || 0}:${event.event || event.type}`;
}

function containsAny(value, terms) {
  const text = String(value || "").toLocaleLowerCase();
  return terms.some((term) => text.includes(term));
}

export function roleForEvent(event) {
  const name = event.name || event.data?.assistant_name || event.data?.tool_name || "";
  const nodeType = event.node_type;

  if (event.event === "run_started" || TERMINAL_EVENTS.has(event.event)) {
    return "main";
  }
  if (event.event?.startsWith("report_")) {
    return "files";
  }
  if (nodeType === "agent") {
    if (containsAny(name, ["网络", "network", "tavily"])) return "network";
    if (containsAny(name, ["数据库", "database", "mysql", "sql"])) return "database";
    if (containsAny(name, ["ragflow", "知识", "knowledge"])) return "knowledge";
  }
  if (nodeType === "tool") {
    if (containsAny(name, ["markdown", "pdf", "文档生成", "转pdf"])) return "files";
    if (containsAny(name, ["网络", "internet", "tavily"])) return "network";
    if (containsAny(name, ["数据库", "mysql", "sql", "table"])) return "database";
    if (containsAny(name, ["ragflow", "知识", "retriev"])) return "knowledge";
  }
  return null;
}

function eventStatus(event) {
  if (FAILED_EVENTS.has(event.event) || event.event === "run_failed") {
    return "failed";
  }
  if (COMPLETED_EVENTS.has(event.event) || event.event === "run_completed") {
    return "completed";
  }
  if (ACTIVE_EVENTS.has(event.event) || event.event === "run_started") {
    return "active";
  }
  return event.status === "running" ? "active" : event.status || "unknown";
}

function outputPathFrom(event) {
  if (event.event !== "session_created") return null;
  return event.output?.path || event.data?.path || null;
}

function initialSnapshot() {
  const persisted = readPersisted();
  return {
    threadId: persisted.threadId || crypto.randomUUID(),
    runId: persisted.runId || null,
    outputPath: persisted.outputPath || null,
    lastSequence: Number.isInteger(persisted.lastSequence)
      ? persisted.lastSequence
      : 0,
    taskStatus: persisted.runId ? "restoring" : "idle",
    connection: "idle",
    query: "",
    events: [],
    rawMessages: [],
    clientErrors: [],
    roles: createRoles(),
    startedAt: null,
    endedAt: null,
    finalOutput: null,
    files: [],
  };
}

export class ConsoleStore {
  constructor() {
    this.snapshot = initialSnapshot();
    this.listeners = new Set();
    this.eventIds = new Set();
    this.persist();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  emit() {
    this.persist();
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

  persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable(this.snapshot)));
  }

  patch(values) {
    Object.assign(this.snapshot, values);
    this.emit();
  }

  setConnection(connection) {
    this.patch({ connection });
  }

  setTaskStatus(taskStatus) {
    this.patch({ taskStatus });
  }

  beginRun({ query, threadId, runId }) {
    this.eventIds.clear();
    this.snapshot = {
      ...this.snapshot,
      threadId,
      runId,
      lastSequence: 0,
      outputPath: null,
      taskStatus: "starting",
      query,
      events: [],
      rawMessages: [],
      clientErrors: [],
      roles: createRoles(),
      startedAt: null,
      endedAt: null,
      finalOutput: null,
      files: [],
    };
    this.emit();
  }

  newSession() {
    this.eventIds.clear();
    this.snapshot = {
      ...initialSnapshot(),
      threadId: crypto.randomUUID(),
      runId: null,
      outputPath: null,
      lastSequence: 0,
      taskStatus: "idle",
    };
    this.emit();
  }

  prepareRestore() {
    this.eventIds.clear();
    this.snapshot.events = [];
    this.snapshot.rawMessages = [];
    this.snapshot.roles = createRoles();
    this.snapshot.startedAt = null;
    this.snapshot.endedAt = null;
    this.snapshot.finalOutput = null;
    this.snapshot.lastSequence = 0;
    this.emit();
  }

  addRawMessage(message) {
    this.snapshot.rawMessages.push({
      receivedAt: new Date().toISOString(),
      payload: message,
    });
    if (this.snapshot.rawMessages.length > 500) {
      this.snapshot.rawMessages.shift();
    }
    this.emit();
  }

  addClientError(message, source = "client") {
    this.snapshot.clientErrors.push({
      source,
      message: String(message),
      timestamp: new Date().toISOString(),
    });
    if (this.snapshot.clientErrors.length > 50) {
      this.snapshot.clientErrors.shift();
    }
    this.emit();
  }

  addEvent(event) {
    if (!event || typeof event !== "object" || !event.event) {
      return false;
    }
    const key = eventKey(event);
    if (this.eventIds.has(key)) {
      return false;
    }
    this.eventIds.add(key);
    this.snapshot.events.push(event);
    this.snapshot.events.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
    this.snapshot.lastSequence = Math.max(
      this.snapshot.lastSequence,
      Number(event.sequence) || 0,
    );

    if (event.event === "run_started") {
      this.snapshot.taskStatus = "running";
      this.snapshot.startedAt = event.started_at || event.timestamp || new Date().toISOString();
      this.snapshot.query = event.input?.query || this.snapshot.query;
    }

    const path = outputPathFrom(event);
    if (path) {
      this.snapshot.outputPath = path;
    }

    const roleId = roleForEvent(event);
    if (roleId) {
      const role = this.snapshot.roles[roleId];
      const firstStart = (
        (roleId === "main" && event.event === "run_started")
        || (event.node_type === "agent" && event.event === "agent_started")
        || (roleId === "files" && event.event === "tool_started")
      );
      role.observed = true;
      role.lastEvent = event;
      role.status = eventStatus(event);
      if (firstStart) {
        role.count += 1;
      }
    }

    if (event.event === "run_completed") {
      this.snapshot.taskStatus = "completed";
      this.snapshot.endedAt = event.ended_at || event.timestamp || new Date().toISOString();
      this.snapshot.finalOutput = event.output ?? event.data?.result ?? null;
      for (const [id, role] of Object.entries(this.snapshot.roles)) {
        if (id !== "main" && role.status === "active") {
          role.status = "waiting";
        }
      }
    }

    if (event.event === "run_failed") {
      this.snapshot.taskStatus = event.status === "cancelled" ? "cancelled" : "failed";
      this.snapshot.endedAt = event.ended_at || event.timestamp || new Date().toISOString();
      for (const [id, role] of Object.entries(this.snapshot.roles)) {
        if (id !== "main" && role.status === "active") {
          role.status = "waiting";
        }
      }
    }

    this.emit();
    return true;
  }

  setFiles(files) {
    this.patch({ files: Array.isArray(files) ? files : [] });
  }
}

export function isTerminalStatus(status) {
  return ["completed", "failed", "cancelled"].includes(status);
}
