// extension/bilibili/reader-url.ts
// clip 域行为：阅读模式 URL 更新（replaceReaderModeUrl）与 clip 签名时序
// 不变式——clip 签名必须先于 replaceState 更新（补丁后的 replaceState 会同步
// 派发 boc:urlchange 触发 handleUrlChange，签名未先更新会被误判为真实 URL
// 变化而清空全部 clip 状态）。
// 本函数仅 content 侧使用；原放在 core/runtime.js（URL 工具杂项），现归位到
// B 站域。可 import core/state 与 bilibili/video-id-shared。
import { clipState } from "../core/state.js";
import { computeCurrentClipSignature } from "./video-id-shared.js";
import { shouldDebugLog } from "../shared/logging.js";

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
