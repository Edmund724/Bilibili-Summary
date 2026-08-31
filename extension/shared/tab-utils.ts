// tab-utils.ts — tab / chrome.runtime transport helpers shared across extension
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
//   - waitForTabComplete(tabId, options)       polls chrome.tabs.get until "complete"
//   - sendMessageToTab(tabId, message)         one-shot tabs.sendMessage as a promise
//   - sendMessageToActiveTab(tabId, message, retries=12)  retry-wrapped tabs.sendMessage
import { sleep } from "./utils.js";

interface WaitForTabCompleteOptions {
  timeoutMs?: number;
  polls?: number;
  pollMs?: number;
}

// 轮询等待 tab 加载完成（chrome.tabs.get 直到 status === "complete"）。两种终止
// 条件按调用方显式二选一：
//   - options.polls > 0：最多轮询 polls 次（间隔 options.pollMs），耗尽返回
//     false，失败处理交给调用方（background 注入流程用）；
//   - 否则限时 options.timeoutMs（默认 15000），超时抛错（sidepanel / seek
//     流程用，catch 后统一提示）。
export async function waitForTabComplete(
  tabId: number,
  { timeoutMs = 15000, polls = 0, pollMs = 250 }: WaitForTabCompleteOptions = {}
): Promise<boolean> {
  const startedAt = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") {
      return true;
    }
    if (polls > 0) {
      if (attempt + 1 >= polls) {
        return false;
      }
    } else if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("视频页面加载超时");
    }
    await sleep(pollMs);
  }
}

// 单发 tabs.sendMessage（callback 包成 promise；无重试，重试变体见
// sendMessageToActiveTab）。
export function sendMessageToTab<T = unknown>(tabId: number, message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp: unknown) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp as T);
    });
  });
}

export async function sendMessageToActiveTab<T = unknown>(
  tabId: number,
  message: unknown,
  retries = 12
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await sendMessageToTab<T>(tabId, message);
    } catch (error) {
      lastError = error;
      await sleep(220);
    }
  }
  throw lastError || new Error("无法连接视频页面");
}
