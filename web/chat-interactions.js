export function shouldSubmitOnEnter(event) {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

export function isNearBottom(metrics, threshold = 96) {
  const remaining = metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
  return remaining <= threshold;
}
