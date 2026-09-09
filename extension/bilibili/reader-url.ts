// extension/bilibili/reader-url.ts
// clip 域行为：阅读模式 URL 的 replaceState 更新（replaceReaderModeUrl）+
// clip 签名时序。
// 不变式——clip 签名必须先于 replaceState 更新（补丁后的 replaceState 会同步
// 派发 boc:urlchange 触发 handleUrlChange，签名未先更新会被误判为真实 URL
// 变化而清空全部 clip 状态）。
// 本函数仅 content 侧使用；replaceReaderModeUrl 原放在 core/runtime.js
// （URL 工具杂项）现归位到 B 站域。buildReaderModeUrl 原为三处手抄
// （reader/shell.ts resolveReaderEntryUrl、ui/digest-button.ts buildReaderUrl、
// reader/chat-tab.ts openCurrentContextInReader），arch-slim-2/03 收口为单源，
// 2026-09 工单 02-toolbar-icon-opens-digest 起 SW 侧工具栏入口也要消费同一
// 拼法——本文件拖 core/state 不能进 SW 图，纯 URL 计算的 buildReaderModeUrl
// 已收编至 bilibili/video-id-shared.ts，此处 re-export 保持页内消费方不动。
// 可 import core/state 与 bilibili/video-id-shared。
import { clipState } from "../core/state.js";
import { computeCurrentClipSignature } from "./video-id-shared.js";
import { shouldDebugLog } from "../shared/logging.js";

export { buildReaderModeUrl } from "./video-id-shared.js";

export function replaceReaderModeUrl(nextUrl: unknown): void {
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
