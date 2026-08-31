// core/runtime.ts 现在只剩内容侧的设置读取（getSettings）。
// 其余能力已按职责拆出：
//   - 消息传输（sendRuntimeMessage / sendOffloadMessage）→ shared/messaging.ts
//     （所有 context 共用，shared 叶子，不 import core/*）；
//   - URL 事件机制（startUrlWatcher / BOC_URL_CHANGE_EVENT）→ core/url-watcher.ts
//     （history 补丁 + boc:urlchange 派发的纯机制；编排仍在组合根
//     core/message-handler.ts 的 bindUrlChangeHandler）；
//   - 阅读模式 URL 更新（replaceReaderModeUrl，含 clip 签名先于 replaceState
//     的时序不变式）→ bilibili/reader-url.ts（B 站域）。
// URL 变化的编排（重置 clip → 刷字幕 → reader 同步 → player-ai 按钮同步）在
// 组合根 core/message-handler.ts 的 bindUrlChangeHandler 中。本文件不得 import
// ui/reader/ai/subtitle 任何域，否则会与 subtitle/fetcher.ts → getSettings
// 形成 core↔subtitle 循环。
import { DEFAULT_SETTINGS, type Settings } from "./defaults.js";
import { sendRuntimeMessage } from "../shared/messaging.js";

// 归一化责任在 background(get-settings 处理器统一走 normalizeSettings),本函数只透传。
export async function getSettings(timeoutMs = 5000): Promise<Settings> {
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error("getSettings timeout")), timeoutMs);
    });
    const response = await Promise.race([
      sendRuntimeMessage({ type: "get-settings" }),
      timeoutPromise
    ]);
    if (!response || typeof response !== "object" || !(response as { ok?: unknown }).ok) {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...((response as { settings?: Partial<Settings> }).settings || {}) };
  } catch (error) {
    console.warn("[BOC] getSettings fallback to defaults", (error as Error | undefined)?.message);
    return { ...DEFAULT_SETTINGS };
  }
}
