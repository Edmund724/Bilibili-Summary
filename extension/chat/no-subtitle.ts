// extension/chat/no-subtitle.ts — 一键总结「无字幕拦截」的判定与文案（可测纯模块；
// PR5 自 extension/pages/sidepanel-no-subtitle.ts 迁入 chat 域，逻辑零语义改动）。
//
// 为什么存在：content 侧无字幕收尾后快照为 subtitleFetchState === "empty" 且字
// 幕体为空，此时把空 subtitleBody 发给模型只会得到凭标题+热评编造的总结。
// ensureCurrentContextForSend 在最终快照后据此拦截发送，并按 noSubtitleReason
// （content 侧 asr/fallback.js 写入、经 sidepanel-get-context payload 透传）给
// 出对应提示。文案与原因的对应关系锁定在本模块（tests/chat/no-subtitle.test.js）。
//
// reason 取值（clipState.noSubtitleReason，见 core/state.js）：
//   null            未知/未归类 → 通用文案
//   "no-asr-config" 未配置语音识别平台 → 引导自行申请硅基流动 API Key 并填入设置页
//   "asr-disabled"  无字幕自动转写开关未开启 → 引导到设置页开启
//   "asr-failed"    语音识别失败 → 建议重新抓取或稍后再试
//   "asr-empty"     未识别到语音内容 → 该视频没有人声

import type { SidepanelContextSnapshot } from "./chat-state.js";

// ensureCurrentContextForSend 的类型化拦截信号：非 true 的返回值一律让
// chat-runtime 的 sendMessage 提前返回（不追加用户消息、不落 chatHistory、
// 不发起 port）。与既有 boolean false（上下文读取失败）区分开。
export const NO_SUBTITLE_SEND_BLOCKED = "no-subtitle-send-blocked";

// noSubtitleReason 的可能取值（content 侧写入 "no-asr-config"/"asr-disabled"/
// "asr-failed"/"asr-empty"，经 payload 透传；缺失/未知 → 通用文案）。快照经
// AiContext 的开放索引签名读出为 unknown，调用点显式收窄。
export type NoSubtitleReason = string | null | undefined;

// 「当前快照是否为无字幕空上下文」判定（ensureCurrentContextForSend 用，纯函数）。
// 与 isContextPending 的边界互补：pending 管"还在抓取/转写"（loading），
// 这里管"已经无字幕收尾"（empty）。字幕体非空即放行，不受状态字段影响。
export function isNoSubtitleEmptyContext(snapshot: SidepanelContextSnapshot | null | undefined): boolean {
  if (!snapshot) {
    return false;
  }
  const body = Array.isArray(snapshot.subtitleBody) ? snapshot.subtitleBody : [];
  if (body.length > 0) {
    return false;
  }
  return snapshot.subtitleFetchState === "empty";
}

// 按无字幕原因给出提示文案；openSettings 为 true 时提示末尾附「前往设置」
// 链接（sidepanel 负责渲染与 openOptionsPage 接线）。
export function buildNoSubtitleNotice(reason: NoSubtitleReason): { message: string; openSettings: boolean } {
  switch (reason) {
    case "no-asr-config":
      return {
        message: "当前视频没有字幕，无法总结。可到硅基流动官网免费申请 API Key，填入扩展设置页后即可自动转写生成字幕。",
        openSettings: true
      };
    case "asr-disabled":
      return {
        message: "当前视频没有字幕，且语音转写开关已关闭。可在设置页开启「无字幕时自动生成字幕」后再试。",
        openSettings: true
      };
    case "asr-failed":
      return {
        message: "当前视频没有字幕，语音识别未成功，暂时无法总结。可重新抓取或稍后再试。",
        openSettings: false
      };
    case "asr-empty":
      return {
        message: "这个视频没有识别到语音内容，无法总结。",
        openSettings: false
      };
    default:
      // reason 缺失/未知：通用文案
      return {
        message: "当前视频没有字幕，无法总结。",
        openSettings: false
      };
  }
}
