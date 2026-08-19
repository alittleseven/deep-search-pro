const EDGE_DEFINITIONS = [
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
];

function svgElement(name) {
  return document.createElementNS("http://www.w3.org/2000/svg", name);
}

function centerPoint(element, containerRect, side) {
  const rect = element.getBoundingClientRect();
  return {
    x: side === "left"
      ? rect.left - containerRect.left
      : rect.right - containerRect.left,
    y: rect.top - containerRect.top + rect.height / 2,
  };
}

function edgePath(start, end) {
  const span = Math.max(20, (end.x - start.x) * 0.44);
  return `M ${start.x} ${start.y} C ${start.x + span} ${start.y}, ${end.x - span} ${end.y}, ${end.x} ${end.y}`;
}

function nodeStatus(snapshot, nodeId) {
  if (nodeId === "input") {
    if (!snapshot.runId) return "idle";
    if (snapshot.taskStatus === "failed") return "failed";
    if (snapshot.taskStatus === "completed") return "completed";
    return "active";
  }
  if (nodeId === "output") {
    if (snapshot.taskStatus === "failed") return "failed";
    if (snapshot.taskStatus === "completed" && snapshot.finalOutput != null) return "completed";
    if (snapshot.taskStatus === "completed") return "unknown";
    return snapshot.runId ? "waiting" : "idle";
  }
  if (nodeId === "synthesis") {
    const modelEvents = snapshot.events.filter((event) => event.node_type === "model");
    const reportEvents = snapshot.events.filter((event) => event.event?.startsWith("report_"));
    const event = [...modelEvents, ...reportEvents].sort(
      (a, b) => (a.sequence || 0) - (b.sequence || 0),
    ).at(-1);
    if (!event) return "unknown";
    if (event.event?.endsWith("_failed")) return "failed";
    if (event.event?.endsWith("_completed")) return "completed";
    return "active";
  }
  return snapshot.roles[nodeId]?.status || "idle";
}

function nodeDetail(snapshot, nodeId, status) {
  if (nodeId === "input") {
    return snapshot.query || "Awaiting submission";
  }
  if (nodeId === "output") {
    if (status === "completed") return "Final result received";
    if (status === "failed") return "Run failed";
    if (status === "unknown") return "Completed without output";
    return "Awaiting completion";
  }
  if (nodeId === "synthesis") {
    return status === "unknown" ? "No explicit event" : "Explicit model/report event";
  }
  const role = snapshot.roles[nodeId];
  if (!role?.lastEvent) {
    return nodeId === "files" && snapshot.files.length
      ? `${snapshot.files.length} files observed`
      : "Not invoked";
  }
  if (role.status === "waiting") {
    return "Completion not emitted";
  }
  return role.lastEvent.message || role.lastEvent.event || "Event observed";
}

export class ExecutionVisualizer {
  constructor(container, onSelect) {
    this.container = container;
    this.svg = container.querySelector("#graph-edges");
    this.nodes = new Map(
      [...container.querySelectorAll("[data-node]")].map((node) => [
        node.dataset.node,
        node,
      ]),
    );
    this.statuses = {};

    for (const [id, node] of this.nodes) {
      node.addEventListener("click", () => onSelect(id));
    }
    this.resizeObserver = new ResizeObserver(() => this.drawEdges());
    this.resizeObserver.observe(container);
  }

  select(nodeId) {
    for (const [id, node] of this.nodes) {
      node.classList.toggle("selected", id === nodeId);
    }
  }

  update(snapshot) {
    for (const [id, node] of this.nodes) {
      const status = nodeStatus(snapshot, id);
      this.statuses[id] = status;
      node.dataset.status = status;
      node.querySelector(".badge").textContent = status;
      node.querySelector(".node-detail").textContent = nodeDetail(snapshot, id, status);
    }
    this.drawEdges();
  }

  drawEdges() {
    const containerRect = this.container.getBoundingClientRect();
    if (!containerRect.width || !containerRect.height) return;
    const fragment = document.createDocumentFragment();

    for (const [sourceId, targetId, conditional] of EDGE_DEFINITIONS) {
      const source = this.nodes.get(sourceId);
      const target = this.nodes.get(targetId);
      if (!source || !target) continue;
      const path = svgElement("path");
      path.setAttribute(
        "d",
        edgePath(
          centerPoint(source, containerRect, "right"),
          centerPoint(target, containerRect, "left"),
        ),
      );
      const sourceStatus = this.statuses[sourceId];
      const targetStatus = this.statuses[targetId];
      if (conditional) path.classList.add("conditional");
      if (!["idle", "unknown"].includes(targetStatus)) path.classList.add("observed");
      if (sourceStatus === "active" || targetStatus === "active") path.classList.add("active");
      fragment.append(path);
    }
    this.svg.replaceChildren(fragment);
  }
}

export function statusForNode(snapshot, nodeId) {
  return nodeStatus(snapshot, nodeId);
}
