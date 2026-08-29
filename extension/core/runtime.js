// core/runtime.js 是纯共享层：settings 读写、state 导出、boc:urlchange 事件
// 广播、replaceReaderModeUrl 等 URL 工具。URL 变化的编排（重置 clip → 刷字幕
// → reader 同步 → player-ai 按钮同步）在组合根 core/message-handler.js 的
// bindUrlChangeHandler 中。本文件不得 import ui/reader/ai/subtitle 任何域，
// 否则会与 subtitle/fetcher.js → getSettings 形成 core↔subtitle 循环。
import { state, clipState, uiState } from "./state.js";
import { DEFAULT_SETTINGS } from "./defaults.js";
import { computeCurrentClipSignature } from "../bilibili/video-id-shared.js";
import { shouldDebugLog } from "../shared/logging.js";

export function replaceReaderModeUrl(nextUrl) {
  const targetUrl = String(nextUrl || "").trim();
  if (!targetUrl || targetUrl === location.href) {
    return;
  }

  try {
    // Update clip signature BEFORE calling replaceState, because the patched
    // history.replaceState dispatches boc:urlchange synchronously, which
    // triggers handleUrlChange — if the signature hasn't been updated yet,
    // it looks like a real URL change and resets all clip state (chapters,
    // subtitles, etc.).
    clipState.setCurrentUrl(targetUrl);
    clipState.setCurrentClipSignature(computeCurrentClipSignature(targetUrl));
    history.replaceState(history.state, "", targetUrl);
    clipState.setCurrentUrl(location.href);
    clipState.setCurrentClipSignature(computeCurrentClipSignature(location.href));
  } catch (error) {
    if (shouldDebugLog()) {
      console.warn("[BOC] failed to replace reader mode url", error);
    }
  }
}

export const BOC_URL_CHANGE_EVENT = "boc:urlchange";
let urlWatcherHistoryPatched = false;

// URL 变化事件广播（纯机制，无域依赖）：给 history.pushState/replaceState 打
// 补丁，在原始调用后同步派发 boc:urlchange 自定义事件，取代原先的 1200ms 轮询。
// popstate/hashchange 的监听与 handleUrlChange 编排在 core/message-handler.js。
export function startUrlWatcher() {
  if (state.ui.urlWatcherStarted) {
    return;
  }
  uiState.setUrlWatcherStarted(true);

  if (!urlWatcherHistoryPatched) {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function pushState(...args) {
      const result = originalPushState.apply(this, args);
      window.dispatchEvent(new Event(BOC_URL_CHANGE_EVENT));
      return result;
    };
    history.replaceState = function replaceState(...args) {
      const result = originalReplaceState.apply(this, args);
      window.dispatchEvent(new Event(BOC_URL_CHANGE_EVENT));
      return result;
    };
    urlWatcherHistoryPatched = true;
  }
}

export function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(resp);
      });
    } catch (error) {
      reject(error);
    }
  });
}

// 通用 offscreen 任务通道：发 "offload-task" 消息给 background，按 taskType
// 分发给注册的任务执行器（现承载 asr-decode-prepare / asr-decode-cleanup，
// 见 asr/offscreen-bridge.bg.js：前者建 offscreen 文档 + 为该任务分配独立 id 的
// dnr 防盗链规则，后者按消息携带的 ruleId 只清自己的规则——多任务并发规则
// 并存、互不影响）。消息结构随任务类型定，执行器异常原样透传。
export function sendOffloadMessage(message) {
  return sendRuntimeMessage({ type: "offload-task", ...message });
}

export function isExtensionContextInvalidated(error) {
  const msg = String(error?.message || "");
  return msg.includes("Extension context invalidated");
}

// 归一化责任在 background(get-settings 处理器统一走 normalizeSettings),本函数只透传。
export async function getSettings(timeoutMs = 5000) {
  try {
    const timeoutPromise = new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error("getSettings timeout")), timeoutMs);
    });
    const response = await Promise.race([
      sendRuntimeMessage({ type: "get-settings" }),
      timeoutPromise
    ]);
    if (!response?.ok) {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...(response.settings || {}) };
  } catch (error) {
    console.warn("[BOC] getSettings fallback to defaults", error?.message);
    return { ...DEFAULT_SETTINGS };
  }
}
