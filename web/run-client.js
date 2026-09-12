import {
  connectTrace,
  fetchFiles,
  fetchThreadRuns,
  fetchTrace,
  startTask,
  uploadFiles,
} from "./api.js?v=20260910-5";
import { isTerminalStatus } from "./state.js?v=20260910-5";

export class RunClient {
  constructor({ store, onNotice = () => {} }) {
    this.store = store;
    this.onNotice = onNotice;
    this.socket = null;
    this.socketGeneration = 0;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.operationGeneration = 0;
  }

  async start({ query, threadId, files = [] }) {
    const generation = ++this.operationGeneration;
    if (files.length) {
      this.store.setTaskStatus("uploading");
      await uploadFiles(threadId, files);
      if (generation !== this.operationGeneration) return null;
    }
    this.store.setTaskStatus("starting");
    const response = await startTask(query, threadId);
    if (generation !== this.operationGeneration) return null;
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

  async restore({ threadId, runId = null }) {
    if (!threadId) return null;
    const generation = ++this.operationGeneration;
    this.store.patch({ threadId, runId });
    const thread = await fetchThreadRuns(threadId);
    if (generation !== this.operationGeneration) return null;
    const summary = runId
      ? thread.runs?.find((item) => item.run_id === runId)
      : thread.runs?.[0];
    if (!summary) {
      if (!runId) {
        this.store.patch({
          runId: null,
          taskStatus: "idle",
          connection: "idle",
        });
        return null;
      }
      throw new Error("当前运行记录已不可用。");
    }

    this.store.patch({ runId: summary.run_id });
    this.store.prepareRestore();
    const trace = await fetchTrace(summary.run_id, 0);
    if (generation !== this.operationGeneration) return null;
    for (const event of trace.events) {
      this.store.addEvent(event);
    }
    if (!trace.events.length) {
      this.store.patch({
        taskStatus: summary.status || "idle",
        startedAt: summary.started_at || null,
        endedAt: summary.ended_at || null,
      });
    }
    await this.refreshFiles(this.store.snapshot.outputPath, generation);
    if (generation !== this.operationGeneration) return null;
    if (isTerminalStatus(this.store.snapshot.taskStatus)) {
      this.store.setConnection("idle");
    } else {
      this.connect();
    }
    return summary;
  }

  async refreshFiles(
    path = this.store.snapshot.outputPath,
    generation = this.operationGeneration,
  ) {
    if (!path) return [];
    try {
      const result = await fetchFiles(path);
      if (generation !== this.operationGeneration) return [];
      const files = result.files || [];
      this.store.setFiles(files);
      return files;
    } catch (error) {
      if (generation !== this.operationGeneration) return [];
      this.store.addClientError(error.message, "files");
      this.onNotice(`无法加载生成文件：${error.message}`);
      return [];
    }
  }

  clearTimers() {
    globalThis.clearTimeout(this.reconnectTimer);
    globalThis.clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  closeSocket(reason = "client navigation") {
    this.socketGeneration += 1;
    this.clearTimers();
    if (this.socket) {
      this.socket.close(1000, reason);
      this.socket = null;
    }
  }

  close(reason = "client navigation") {
    this.operationGeneration += 1;
    this.closeSocket(reason);
  }

  scheduleReconnect(generation) {
    if (
      generation !== this.socketGeneration
      || isTerminalStatus(this.store.snapshot.taskStatus)
    ) {
      return;
    }
    const delay = Math.min(1000 * (2 ** this.reconnectAttempts), 15000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = globalThis.setTimeout(() => this.connect(), delay);
  }

  connect() {
    const { threadId, runId, lastSequence } = this.store.snapshot;
    if (!threadId || !runId) return;

    this.closeSocket();
    const generation = this.socketGeneration;
    this.store.setConnection("connecting");

    const nextSocket = connectTrace({
      threadId,
      runId,
      afterSequence: lastSequence,
      onOpen: () => {
        if (generation !== this.socketGeneration) return;
        this.reconnectAttempts = 0;
        this.store.setConnection("connected");
        this.heartbeatTimer = globalThis.setInterval(() => {
          if (nextSocket.readyState === globalThis.WebSocket.OPEN) {
            nextSocket.send("ping");
          }
        }, 25000);
      },
      onMessage: (message) => {
        if (generation !== this.socketGeneration) return;
        this.store.addRawMessage(message);
        if (message.type !== "monitor_event" && !message.event) return;

        const added = this.store.addEvent(message);
        if (added && message.event === "session_created") {
          this.refreshFiles();
        }
        if (added && ["run_completed", "run_failed"].includes(message.event)) {
          this.refreshFiles();
          globalThis.clearInterval(this.heartbeatTimer);
        }
      },
      onError: () => {
        if (generation !== this.socketGeneration) return;
        this.store.setConnection("disconnected");
      },
      onClose: (event) => {
        if (generation !== this.socketGeneration) return;
        globalThis.clearInterval(this.heartbeatTimer);
        this.socket = null;
        this.store.setConnection("disconnected");
        if (event.code === 4404) {
          this.store.addClientError(
            "The saved run is no longer available in the trace store.",
            "websocket",
          );
          this.onNotice("当前运行记录已过期，请重新运行任务。", true);
          return;
        }
        this.scheduleReconnect(generation);
      },
    });
    this.socket = nextSocket;
  }
}
