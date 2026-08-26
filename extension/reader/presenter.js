// Reader presenter seam.
//
// Decouples subtitle fetching orchestration (subtitle/fetcher.js) from the
// reader rendering layer: fetcher publishes data-change notifications here
// instead of calling reader render functions directly, while the reader side
// (shell.js) registers callbacks to render on those notifications.
//
// All payloads are read from the shared state at notification time, so the
// callbacks need no arguments.

import { logWarn } from "../shared/logging.js";

const readers = [];

export function subscribeReaderPresenter(handler) {
  if (typeof handler !== "function") {
    return () => {};
  }
  if (readers.indexOf(handler) === -1) {
    readers.push(handler);
  }
  return function unsubscribeReaderPresenter() {
    const index = readers.indexOf(handler);
    if (index !== -1) {
      readers.splice(index, 1);
    }
  };
}

export function notifyReaderPresenter(kind) {
  for (const handler of readers.slice()) {
    try {
      handler(kind);
    } catch (error) {
      logWarn("[BOC] reader presenter handler failed", { kind, error });
    }
  }
}
