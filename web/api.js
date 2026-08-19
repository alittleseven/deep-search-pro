const JSON_HEADERS = {
  "Content-Type": "application/json",
};

async function parseResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const detail = payload && typeof payload === "object"
      ? payload.detail || payload.error
      : payload;
    throw new Error(detail || `Request failed with HTTP ${response.status}`);
  }

  if (payload && typeof payload === "object" && payload.error) {
    throw new Error(payload.error);
  }
  return payload;
}

export async function uploadFiles(threadId, files) {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }
  formData.append("thread_id", threadId);

  return parseResponse(await fetch("/api/upload", {
    method: "POST",
    body: formData,
  }));
}

export async function startTask(query, threadId) {
  return parseResponse(await fetch("/api/task", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      query,
      thread_id: threadId,
    }),
  }));
}

export async function fetchThreadRuns(threadId) {
  return parseResponse(await fetch(
    `/api/threads/${encodeURIComponent(threadId)}/runs`,
  ));
}

export async function fetchTrace(runId, afterSequence = 0) {
  const events = [];
  let cursor = afterSequence;
  let hasMore = true;

  while (hasMore) {
    const query = new URLSearchParams({
      after_sequence: String(cursor),
      limit: "1000",
    });
    const page = await parseResponse(await fetch(
      `/api/runs/${encodeURIComponent(runId)}/trace?${query}`,
    ));
    events.push(...page.events);
    cursor = page.last_sequence;
    hasMore = page.has_more;
  }

  return {
    events,
    lastSequence: cursor,
  };
}

export async function fetchFiles(path) {
  const query = new URLSearchParams({ path });
  return parseResponse(await fetch(`/api/files?${query}`));
}

export function downloadUrl(path) {
  const query = new URLSearchParams({ path });
  return `/api/download?${query}`;
}

export function connectTrace({
  threadId,
  runId,
  afterSequence,
  onOpen,
  onMessage,
  onError,
  onClose,
}) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({
    run_id: runId,
    after_sequence: String(afterSequence),
  });
  const socket = new WebSocket(
    `${protocol}//${window.location.host}/ws/${encodeURIComponent(threadId)}?${query}`,
  );

  socket.addEventListener("open", onOpen);
  socket.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      payload = {
        type: "unparseable_message",
        raw: String(event.data),
      };
    }
    onMessage(payload);
  });
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  return socket;
}
