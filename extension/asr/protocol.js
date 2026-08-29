// ASR「下载 + 解码 + 切片 + 转写」的跨 context 协议常量（唯一地址）。
// MV3 service worker 没有 AudioContext，且 chrome.runtime 消息是 JSON 序列化
// ——二进制（Uint8Array / Float32Array）跨 context 会变成数字键普通对象，
// 字节全损。因此下载、解码、切片、转写整体搬进 offscreen 文档（转写引擎
// asr/engine.js 与适配器与解码同 context 加载），跨 context 只传文本结果与
// 小 JSON；音频字节与 API Key 都不出 offscreen（Key 由 offscreen 直调
// background 的 get-asr-runtime-config 获取）。
//
// 数据流：runAsrPipeline → createOffscreenChunkHost()（page 侧，
// asr/offscreen-bridge.page.js）→ sendOffloadMessage({ taskType: ASR_TASK_PREPARE })
// → background 建 offscreen 文档 + 按任务分配独立 id 的 dnr 防盗链规则
// （响应带回 ruleId，见 asr/offscreen-bridge.bg.js）→ 页面连
// ASR_DECODE_PORT_NAME port 直连文档 → postMessage 任务
// { audioUrl, backupUrls } → 逐条收 ASR_MSG_PROGRESS / ASR_MSG_CHUNK_RESULT
// → ASR_MSG_DONE → 汇总按片
// index 对齐的文本结果返回 → 再发 { taskType: ASR_TASK_CLEANUP, ruleId } 只清自己
// 这条 dnr 规则（多任务并发时各删各的，互不影响）。
// 转写与视频切换解耦：页面侧不做 stale 复核（旧实现曾按注入的过期回调在
// 每条 port 消息到达时断连取消，已删）。任务取消只剩真断连——页面关闭/
// 扩展重载 → port.onDisconnect → offscreen 侧 aborted → 解码停止、引擎
// 停止调度（现成机制）。
//
// 页面侧客户端（createOffscreenChunkHost）在 asr/offscreen-bridge.page.js；
// background 侧执行器（DNR 规则簿记 + prepare/cleanup handler）在
// asr/offscreen-bridge.bg.js；offscreen 文档内 handler 侧接线在
// entry/offscreen.js / entry/offscreen-asr.js。两侧均 import 本模块取常量，
// 禁止手写协议字面量（注释除外）。

// ===== port 与任务消息 =====

// 页面 ↔ offscreen 文档直连的 port 名
export const ASR_DECODE_PORT_NAME = "asr-decode";
// 页面经 port 首条消息派发任务的 action 字段取值（与 port 名同串、语义不同）
export const ASR_DECODE_ACTION = "asr-decode";

// offload 任务类型：background 的 offload-task 通道按 taskType 分发
// （prepare 建文档 + 加规则，cleanup 删规则）
export const ASR_TASK_PREPARE = "asr-decode-prepare";
export const ASR_TASK_CLEANUP = "asr-decode-cleanup";

// ===== port 消息 type（offscreen handler → 页面） =====

// 引擎产出的进度文本（语音识别中 N 片…），页面原样中继 onProgress
export const ASR_MSG_PROGRESS = "progress";
// 单片转写结果 { index, startSec, durationSec, result }，result 为适配器
// 单片结果 { text, segments?, _asrDiag? }，原样透传（纯 JSON 文本）
export const ASR_MSG_CHUNK_RESULT = "chunk-result";
// 终态汇总 { totalChunks, skippedSegments, failedChunks }
export const ASR_MSG_DONE = "done";
// 终态错误 { error, code?, reason? }：code（如 "asr-skip"）与结构化 reason
// （asr-skip 的 "asr-disabled" / "no-asr-config"）随错误对象透传，最终落
// clipState.noSubtitleReason（asr/fallback.js）
export const ASR_MSG_ERROR = "error";

// ===== 页面侧任务结果形状（createOffscreenChunkHost 的 resolve 值） =====
//   { results, totalChunks, skippedSegments, failedChunks }
//   results 为按片 index 排序的 [{ index, startSec, durationSec, result }]；
//   totalChunks 为产出片数，skippedSegments 为解码失败跳过的段数，
//   failedChunks 为转写失败跳过的片数（Q8a 口径：个别失败不整体失败，
//   全部段解码失败零片产出才算整体失败）。

// ===== 共享数值常量 =====

// 音频体积上限 200MB（offscreen 文档侧下载时 HEAD 探大小据此拒绝超长视频）
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
// offscreen 文档内的任务超时（解码与下载共用）
export const ASR_DECODE_TIMEOUT_MS = 10 * 60 * 1000;
