// extension/logging.js
// Debug-gated logging helpers. Single source of truth for logInfo / logWarn
// so modules can be self-contained without importing the DOM-heavy reader-shell.js.

import { state } from "./state.js";

export function shouldDebugLog() {
  return Boolean(state.settings?.enableDebugLogs);
}

export function logInfo(...args) {
  if (shouldDebugLog()) {
    console.info(...args);
  }
}

export function logWarn(...args) {
  if (shouldDebugLog()) {
    console.warn(...args);
  }
}
