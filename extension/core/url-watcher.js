// extension/core/url-watcher.js
// URL 变化的纯机制层：给 history.pushState/replaceState 打补丁，在原始调用后
// 同步派发 boc:urlchange 自定义事件（取代原先的 1200ms 轮询）。
// 不做任何业务编排：popstate/hashchange/boc:urlchange 的监听注册与 URL 变化
// 编排（重置 clip → 刷字幕 → reader 同步 → player-ai 按钮同步）在组合根
// core/message-handler.js 的 bindUrlChangeHandler 中。
// 本文件只 import ./state.js（防重标记），不得依赖 ui/reader/ai/subtitle/
// bilibili 任何域。
import { state, uiState } from "./state.js";

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
