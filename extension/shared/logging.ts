// extension/logging.ts
// Debug-gated logging helpers. Single source of truth for logInfo / logWarn
// so modules can be self-contained without importing the DOM-heavy reader-shell.js.

import { state } from "../core/state.js";

export function shouldDebugLog(): boolean {
  return Boolean(state.settings?.enableDebugLogs);
}

export function logInfo(...args: unknown[]): void {
  if (shouldDebugLog()) {
    console.info(...args);
  }
}

export function logWarn(...args: unknown[]): void {
  if (shouldDebugLog()) {
    console.warn(...args);
  }
}

export function logError(...args: unknown[]): void {
  if (shouldDebugLog()) {
    console.error(...args);
  }
}
