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
    updatedAt: String(updatedAt),
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
  const query = params.toString();
  return query ? `/trace?${query}` : "/trace";
}

export class SessionRepository {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
  }

  list() {
    try {
      const value = JSON.parse(this.storage?.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(value) ? value.filter((item) => item?.threadId) : [];
    } catch {
      return [];
    }
  }

  save(record) {
    const sessions = upsertSession(this.list(), record);
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(sessions));
    } catch {
      return sessions;
    }
    return sessions;
  }
}
