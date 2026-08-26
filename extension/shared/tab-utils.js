// tab-utils.js — tab / chrome.runtime transport helpers shared across extension
// pages, extracted out of extension/pages/sidepanel.js (ticket 08 of
// sidepanel-split, the thin-orchestrator pass).
//
// Domain: shared. These are sidepanel-local utilities that are pure transport
// (no sidepanel module-level state) and are needed both by the sidepanel
// orchestrator itself and by the injected deps it hands to ui/timestamp-nav.js
// (the seek flow reuses the same retry-wrapped sendMessageToActiveTab instead of
// reimplementing it).
//
// Exported functions:
//   - sleep(ms)                                pure; promise sleep via window.setTimeout
//   - waitForTabComplete(tabId, timeoutMs=15000)  polls chrome.tabs.get until "complete"
//   - sendMessageToActiveTab(tabId, message, retries=12)  retry-wrapped tabs.sendMessage
//
// NOTE: the module header deliberately avoids the words "import"/"from" (they
// would trip the validate-tree-imports.mjs export resolution on this file's own
// parsed import statements).
import { sleep } from "../core/shared-defaults.js";

export async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") {
      return true;
    }
    await sleep(250);
  }
  throw new Error("视频页面加载超时");
}

export async function sendMessageToActiveTab(tabId, message, retries = 12) {
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(resp);
        });
      });
    } catch (error) {
      lastError = error;
      await sleep(220);
    }
  }
  throw lastError || new Error("无法连接视频页面");
}
