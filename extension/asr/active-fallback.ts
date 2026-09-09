// extension/asr/active-fallback.ts
// ASR 回退的页面侧装配叶（arch-review-2026-09/09 自 subtitle/fetcher.js 迁入，
// Q15=A）：provider 列表读取（loadAsrProviderList）+ createAsrFallback 的 deps
// 装配 + promise 缓存单例 loader + broadcastSubtitleStatus（Q16=A，随 deps 平移
// 至此、仍经 deps 注入 createAsrFallback）。fetcher 经动态 import 本模块获取
// 回退单例，ASR 重域（pipeline + fallback 及其专属依赖）不进常驻 chunk。
//
// 依赖分层（与 asr/fallback.js 模块头注的直 import 白名单衔接）：
//   - fallback.js 纯策略（skip 闸门/缓存命中/并发共享/收尾）不碰，白名单不动；
//   - runAsrPipeline 的传递闭包含 offscreen-bridge.page → shared/messaging →
//     fetcher，不能由 fallback.js 直 import——动态 import pipeline 的职责留在
//     本叶子，不移进 fallback.js；
//   - 其余装配依赖直取各单源：getSettings（core/runtime）、setStatus/setMessage
//    （shared/ui-status）、acceptSubtitle / commitNoSubtitle（subtitle/commit，
//     字幕接受事务唯一入口）、loadProviders（本文件 loadAsrProviderList）。
// 本模块只被 subtitle/fetcher.js 动态 import；不 import extension/entry/ 与
// extension/pages/ 的任何内容。

import { getSettings } from "../core/runtime.js";
import { setMessage, setStatus } from "../shared/ui-status.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { createLazyLoader } from "../shared/lazy-import.js";
// PR3：boc-subtitle-status 广播的进程内镜像（零依赖叶子）——reader 同进程的
// 转写中间态呈现经它读取/订阅（content script 收不到自己的 runtime 广播）。
import { publishSubtitleStatusPhase } from "../shared/subtitle-status-bus.js";
import { acceptSubtitle, commitNoSubtitle } from "../subtitle/commit.js";
import type { AsrFallback, AsrProviderMeta } from "./fallback.js";

// 把耗时阶段的变更广播给 popup / AI 侧边栏，让它们在各自等待抓取响应、
// 无法实时读取页内状态栏的情况下也能区分“抓取本地字幕”和“音频转写”。
// 仅广播阶段标记，文案由各端自行渲染；失败（扩展上下文关闭等）静默忽略。
//
// PR3：chrome.runtime.sendMessage 广播**不会回送给发送方所在的 content script
// 自己**（popup/sidepanel 等扩展上下文才收得到）——reader 与编排同进程，靠
// 监听 onMessage 拿不到相位。故这里同步把相位发布进 shared/subtitle-status-bus
// （进程内镜像叶子），reader 域的转写中间态横幅经它读取/订阅；跨上下文场景
// 仍走原 chrome 广播，行为不变。
function broadcastSubtitleStatus(phase: string): void {
  publishSubtitleStatusPhase(phase);
  try {
    const promise = chrome.runtime.sendMessage({ type: "boc-subtitle-status", phase });
    if (promise && typeof promise.catch === "function") {
      promise.catch(() => {});
    }
  } catch {
    // 静默忽略：广播失败不影响抓取主流程。
  }
}

// ASR provider 列表（provider 元数据，无 Key）经 background 的 asr-providers-list
// 读取：asrProviders 已从 settings 快照摘除（save-settings 白名单不再落盘该键，
// 写回收口在 asr-providers-save），页面侧不碰 chrome.storage provider 存储。
// 消息失败按空列表降级：回退入口据此走 no-asr-config skip，与旧行为一致。
async function loadAsrProviderList(): Promise<AsrProviderMeta[]> {
  try {
    // 响应形状由消息类型经 ResponseOf 推断（arch-slim-2/02）
    const resp = await sendRuntimeMessage({ type: "asr-providers-list" });
    return Array.isArray(resp?.providers) ? resp.providers : [];
  } catch {
    return [];
  }
}

// ASR 回退策略簇（skip 闸门 / 缓存命中 / 并发共享去重 / 转写 / 收尾）在
// asr/fallback.js（工厂 createAsrFallback，进行中的转写共享单元闭包在工厂层）。
// 此处注入运行时与 UI 依赖完成薄接线；字幕接受事务的两个入口
//（acceptSubtitle / commitNoSubtitle）与 broadcastSubtitleStatus 一并作为注入
// 依赖传入，保持 fallback → subtitle 事务层无静态边（与原
// applyNoSubtitleState/refreshDerivedContent 注入同款）。
//
// 懒加载边界：工厂实例（asrFallback 单例）为首次调用时动态 import 再创建，
// promise 缓存（shared/lazy-import.js 的 createLazyLoader，与
// lazy-player-ai/lazy-reader/summarize-chain 加载器同款）保证单例（与原模块
// 级单例语义一致）；加载失败清空缓存允许重试。
const asrFallbackLoader = createLazyLoader(async () => {
  const [{ runAsrPipeline }, { createAsrFallback }] = await Promise.all([
    import("./pipeline.js"),
    import("./fallback.js")
  ]);
  return createAsrFallback({
    getSettings,
    loadProviders: loadAsrProviderList,
    setStatus,
    setMessage,
    acceptSubtitle,
    commitNoSubtitle,
    runAsrPipeline,
    broadcastSubtitleStatus
  });
});

// subtitle/fetcher.js（refreshClip 的无字幕出口与失败兜底）经此惰性获取回退
// 单例。
export function loadActiveAsrFallback(): Promise<AsrFallback> {
  return asrFallbackLoader.load();
}
