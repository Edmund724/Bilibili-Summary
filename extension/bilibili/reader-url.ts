// extension/bilibili/reader-url.ts
// clip 域行为：阅读模式 URL 的两件事——boc_reader=1 的唯一拼法
// （buildReaderModeUrl）与 replaceState 更新（replaceReaderModeUrl）+ clip 签名
// 时序。
// 不变式——clip 签名必须先于 replaceState 更新（补丁后的 replaceState 会同步
// 派发 boc:urlchange 触发 handleUrlChange，签名未先更新会被误判为真实 URL
// 变化而清空全部 clip 状态）。
// 两个函数均仅 content 侧使用；replaceReaderModeUrl 原放在 core/runtime.js
// （URL 工具杂项）现归位到 B 站域；buildReaderModeUrl 原为三处手抄
// （reader/shell.ts resolveReaderEntryUrl、ui/digest-button.ts buildReaderUrl、
// reader/chat-tab.ts openCurrentContextInReader），arch-slim-2/03 收口为单源。
// 可 import core/state 与 bilibili/video-id-shared。
import { clipState } from "../core/state.js";
import { cleanVideoUrl, computeCurrentClipSignature } from "./video-id-shared.js";
import { shouldDebugLog } from "../shared/logging.js";

// boc_reader=1 阅读模式 URL 的唯一拼法：cleanVideoUrl 清成规范视频 URL 再加
// boc_reader=1 查询参数；非 B 站/非视频 URL 原样返回（cleanVideoUrl 语义），
// URL 解析失败回落 cleanVideoUrl 的结果，绝不抛出。
export function buildReaderModeUrl(rawUrl: string): string {
  const base = cleanVideoUrl(rawUrl);
  try {
    const parsed = new URL(base);
    parsed.searchParams.set("boc_reader", "1");
    return parsed.toString();
  } catch {
    return base;
  }
}

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
