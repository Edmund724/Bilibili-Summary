// extension/core/url-watcher.ts
// URL 变化的纯机制层：history.pushState/replaceState 补丁 + href 轮询兜底，
// 检测到变化即同步派发 boc:urlchange 自定义事件。
// 不做任何业务编排：popstate/hashchange/boc:urlchange 的监听注册与 URL 变化
// 编排（重置 clip → 刷字幕 → reader 同步 → player-ai 按钮同步）在组合根
// entry/message-handler.ts（arch-slim-2/09 归位 entry/）的 bindUrlChangeHandler 中。
// 本文件只 import ./state.ts（防重标记），不得依赖 ui/reader/ai/subtitle/
// bilibili 任何域。
import { state, uiState } from "./state.js";

export const BOC_URL_CHANGE_EVENT = "boc:urlchange";
let urlWatcherHistoryPatched = false;
let urlWatcherPollStarted = false;
let lastObservedHref = "";

// href 轮询兜底节拍（原 1200ms 轮询的恢复，见下）。
const URL_POLL_INTERVAL_MS = 1000;

// URL 变化事件广播（纯机制，无域依赖）。两条检测路径：
// 1. history 补丁：同步、即时，但内容脚本跑在隔离世界，补丁只能截获本世界
//    的调用（扩展自己的 replaceReaderModeUrl）；B 站主世界的 SPA 导航
//   （稍后再看列表内换视频等）走的是主世界自己的 history，补丁不可见，
//    且 pushState 导航不触发 popstate。
// 2. href 轮询兜底：世界无关，覆盖主世界 SPA 导航；事件重复派发无害——
//    消费侧 handleUrlChange 有 clip 签名守卫去重。
// popstate/hashchange 的监听与 handleUrlChange 编排在 entry/message-handler.ts。
export function startUrlWatcher(): void {
  if (state.ui.urlWatcherStarted) {
    return;
  }
  uiState.setUrlWatcherStarted(true);

  if (!urlWatcherHistoryPatched) {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function pushState(this: History, ...args: unknown[]): unknown {
      const result = originalPushState.apply(this, args as Parameters<typeof history.pushState>);
      lastObservedHref = location.href;
      window.dispatchEvent(new Event(BOC_URL_CHANGE_EVENT));
      return result;
    };
    history.replaceState = function replaceState(this: History, ...args: unknown[]): unknown {
      const result = originalReplaceState.apply(this, args as Parameters<typeof history.replaceState>);
      lastObservedHref = location.href;
      window.dispatchEvent(new Event(BOC_URL_CHANGE_EVENT));
      return result;
    };
    urlWatcherHistoryPatched = true;
  }

  if (!urlWatcherPollStarted) {
    urlWatcherPollStarted = true;
    lastObservedHref = location.href;
    window.setInterval(() => {
      if (location.href === lastObservedHref) {
        return;
      }
      lastObservedHref = location.href;
      window.dispatchEvent(new Event(BOC_URL_CHANGE_EVENT));
    }, URL_POLL_INTERVAL_MS);
  }
}
