// Dependency-free DOM helpers shared across modules.
//
// byId is the single DOM-id lookup helper (document.getElementById + throw).
// It deliberately lives in this leaf rather than core/runtime.js: reader
// modules must never import core/runtime.js, which would otherwise form an
// import cycle back through subtitle/fetcher.js.
export function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing node: ${id}`);
  }
  return node;
}

// Reader-domained alias of byId; same lookup, kept so reader call sites read
// naturally. New code should prefer byId.
export const getReaderElement = byId;

// Pure DOM visibility check (originally duplicated in reader-impl.js and
// ai/player-ai.js with identical semantics; both now import this copy).
export function isVisibleReaderControl(node: unknown): boolean {
  if (!node || typeof (node as Element).getBoundingClientRect !== "function") {
    return false;
  }
  const rect = (node as Element).getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const style = window.getComputedStyle(node as Element);
  return style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
}
