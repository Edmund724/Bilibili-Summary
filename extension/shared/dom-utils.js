// Reader-domain DOM helpers shared across modules.
//
// getReaderElement is the local replacement for core/runtime.js's byId:
// reading reader DOM ids is a reader-internal concern, and keeping it here
// (document.getElementById + throw) keeps the reader modules free of a static
// import of core/runtime.js, which would otherwise form an import cycle back
// through subtitle/fetcher.js.
export function getReaderElement(id) {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing node: ${id}`);
  }
  return node;
}

// Pure DOM visibility check (originally duplicated in reader-impl.js and
// ai/player-ai.js with identical semantics; both now import this copy).
export function isVisibleReaderControl(node) {
  if (!node || typeof node.getBoundingClientRect !== "function") {
    return false;
  }
  const rect = node.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const style = window.getComputedStyle(node);
  return style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
}
