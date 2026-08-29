// ASR「下载 + 解码 + 切片 + 转写」的 offscreen 通道。MV3 service worker 没有
// AudioContext，且 chrome.runtime 消息是 JSON 序列化——二进制（Uint8Array /
// Float32Array）跨 context 会变成数字键普通对象，字节全损。因此下载、解码、
// 切片、转写整体搬进 offscreen 文档（转写引擎 asr/engine.js 与适配器与解码同
// context 加载），跨 context 只传文本结果与小 JSON；音频字节与 API Key 都不出
// offscreen（Key 由 offscreen 直调 background 的 get-asr-runtime-config 获取）。
//
// 数据流：runAsrPipeline → createOffscreenChunkHost()（page 侧）→
//   sendOffloadMessage({ taskType:"asr-decode-prepare" }) → background 建
//   offscreen 文档 + 按任务分配独立 id 的 dnr 防盗链规则（响应带回 ruleId）
//   → 页面连 "asr-decode" port 直连文档 → postMessage 任务
//   { audioUrl, backupUrls } → 逐条收 { type:"progress" } /
//   { type:"chunk-result" } → { type:"done" } → 汇总按片 index 对齐的文本
//   结果返回 → 再发 { taskType:"asr-decode-cleanup", ruleId } 只清自己这条
//   dnr 规则（多任务并发时各删各的，互不影响）。
//   转写与视频切换解耦：页面侧不做 stale 复核（旧实现曾按注入的过期回调在
//   每条 port 消息到达时断连取消，已删）。任务取消只剩真断连——页面关闭/
//   扩展重载 → port.onDisconnect → offscreen 侧 aborted → 解码停止、引擎
//   停止调度（现成机制）。
//
// 本模块同时在 background 与页面两个环境加载：顶层不触碰 worker-only API
// （chrome.declarativeNetRequest / chrome.offscreen 只在各自 handler 函数体内
// 访问）。

import { sendOffloadMessage } from "../core/runtime.js";
import { OFFSCREEN_URL, OFFSCREEN_CREATE_REASON } from "../shared/offscreen-constants.js";

// 音频体积上限 200MB（offscreen 文档侧下载时 HEAD 探大小据此拒绝超长视频）
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
// offscreen 文档内的任务超时（解码与下载共用）
export const ASR_DECODE_TIMEOUT_MS = 10 * 60 * 1000;
// 防盗链会话规则 id 池下界：id 按任务独立分配（一个任务一条规则，多任务
// 并发时规则并存、cleanup 只删自己的），自此单调递增；任务结束归还空闲池
// 复用，防止长会话 id 无限增长。上界之外的活跃任务按错误路径上报。
export const ASR_AUDIO_SESSION_RULE_ID_BASE = 32001;
const ASR_AUDIO_SESSION_RULE_ID_MAX = 32100;

// ===== 页面侧 chunk host =====

// 页面侧客户端：一次发起「下载 + 解码 + 切片 + 转写」任务，音频字节与
// API Key 全程不出 offscreen（offscreen 自己 fetch、自己取配置），页面只收
// 逐片文本结果。契约：
//   async ({ audioUrl, backupUrls, onProgress? }) =>
//     { results, totalChunks, skippedSegments, failedChunks }
//     results 为按片 index 排序的 [{ index, startSec, durationSec, result }]，
//     result 是适配器单片结果 { text, segments?, _asrDiag? }；
//     totalChunks 为产出片数，skippedSegments 为解码失败跳过的段数，
//     failedChunks 为转写失败跳过的片数（Q8a 口径：个别失败不整体失败）。
// onProgress 中继 offscreen 引擎产出的进度文本。失败 reject 带用户可读文案；
// 成功失败都会发 asr-decode-cleanup 清 dnr 规则（带上 prepare 响应带回的
// ruleId，只清本任务这条，不碰并发任务的）。
export function createOffscreenChunkHost() {
  return async function offscreenChunkHost({ audioUrl, backupUrls, onProgress }) {
    // 先让 background 建 offscreen 文档 + 加防盗链规则（响应带回 ruleId），
    // 再直连文档传任务
    const prepared = await sendOffloadMessage({ taskType: "asr-decode-prepare" });
    if (!prepared?.ok) {
      throw new Error(prepared?.error || "音频解码服务启动失败");
    }
    const sessionRuleId = Number(prepared.ruleId) || 0;

    return new Promise((resolve, reject) => {
      const results = [];
      let done = false;
      let totalChunks = 0;
      let skippedSegments = 0;
      let failedChunks = 0;

      const cleanup = () => {
        sendOffloadMessage({ taskType: "asr-decode-cleanup", ruleId: sessionRuleId }).catch(() => {
          // 规则清理失败不影响主流程（会话规则随浏览器重启自动清空）
        });
      };
      const finish = (callback, value) => {
        if (done) return;
        done = true;
        try {
          port.disconnect();
        } catch {
          // ignore
        }
        cleanup();
        callback(value);
      };

      const port = chrome.runtime.connect({ name: "asr-decode" });
      port.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== "object" || done) return;
        if (msg.type === "progress") {
          // offscreen 引擎产出的进度文本（语音识别中 N 片…）原样中继
          try {
            onProgress?.(String(msg.text || ""));
          } catch {
            // 进度回调异常不影响收包
          }
          return;
        }
        if (msg.type === "chunk-result") {
          results.push({
            index: Number(msg.index) || 0,
            startSec: Number(msg.startSec) || 0,
            durationSec: Number(msg.durationSec) || 0,
            result: msg.result
          });
          return;
        }
        if (msg.type === "done") {
          totalChunks = Number(msg.totalChunks) || results.length;
          skippedSegments = Number(msg.skippedSegments) || 0;
          failedChunks = Number(msg.failedChunks) || 0;
          results.sort((a, b) => a.index - b.index);
          finish(resolve, { results, totalChunks, skippedSegments, failedChunks });
          return;
        }
        if (msg.type === "error") {
          const error = new Error(msg.error || "音频转写失败");
          if (msg.code) {
            error.code = msg.code;
          }
          // 结构化原因（asr-skip 的 "asr-disabled" / "no-asr-config"）随错误
          // 对象透传，最终落 clipState.noSubtitleReason（asr/fallback.js）
          if (msg.reason) {
            error.reason = msg.reason;
          }
          finish(reject, error);
        }
      });
      port.onDisconnect.addListener(() => {
        if (!done) {
          finish(reject, new Error("音频解码中断：后台连接已断开"));
        }
      });

      port.postMessage({
        action: "asr-decode",
        task: {
          audioUrl: String(audioUrl || "").trim(),
          backupUrls: Array.isArray(backupUrls) ? backupUrls : []
        }
      });
    });
  };
}

// ===== background 侧执行器 =====

// 防盗链规则 id 分配器（模块级，仅 background 执行器触碰）：prepare 分配、
// cleanup 归还。单调计数器 + 空闲池复用，防止长会话 id 无限增长；活跃集
// 记账保证重复/未知 id 的 cleanup 幂等忽略、不污染池状态。
let nextSessionRuleId = ASR_AUDIO_SESSION_RULE_ID_BASE;
const activeSessionRuleIds = new Set();
const freeSessionRuleIds = [];

function allocateSessionRuleId() {
  let ruleId = freeSessionRuleIds.pop();
  if (ruleId === undefined) {
    if (nextSessionRuleId > ASR_AUDIO_SESSION_RULE_ID_MAX) {
      throw new Error("防盗链规则 id 已耗尽（活跃转写任务过多），请稍后重试");
    }
    ruleId = nextSessionRuleId++;
  }
  activeSessionRuleIds.add(ruleId);
  return ruleId;
}

function releaseSessionRuleId(ruleId) {
  const id = Number(ruleId) || 0;
  // 活跃集守卫：未分配/已归还的 id（重复 cleanup、陈旧 id）不动池状态
  if (!activeSessionRuleIds.delete(id)) {
    return;
  }
  freeSessionRuleIds.push(id);
}

// 任务准备：创建（或复用）offscreen 文档 + 分配一个独立 id 并按它加防盗链
// 下载规则。页面侧连 "asr-decode" 端口前调用，保证文档与规则就绪；ruleId
// 随响应带回，页面侧 cleanup 时原样带回，只删自己这条。
export async function handleAsrDecodePrepare(message, sender, sendResponse) {
  let ruleId = 0;
  try {
    ruleId = allocateSessionRuleId();
    await ensureAsrOffscreenDocument();
    await addDownloadRules(ruleId);
    sendResponse({ ok: true, ruleId });
  } catch (error) {
    // updateSessionRules 失败照既有错误路径上报不吞；该 id 未成功占用
    // （updateSessionRules 原子生效），归还空闲池避免失败一次泄漏一个 id。
    if (ruleId) {
      releaseSessionRuleId(ruleId);
    }
    sendResponse({ ok: false, error: String(error?.message || error) });
  }
}

// 任务收尾：删掉本次解码任务自己的防盗链规则（成功失败都要调，页面侧用
// try/finally 或 .finally 兜底）。只删消息携带的 ruleId，不影响并发任务
// 的规则；删除不存在的 id 由 Chrome 忽略，重复/未知 id 的 cleanup 幂等不抛。
// 会话规则随浏览器重启自动清空，无需持久化。
export async function handleAsrDecodeCleanup(message, sender, sendResponse) {
  try {
    const ruleId = Number(message?.ruleId) || 0;
    if (ruleId > 0) {
      await removeDownloadRules(ruleId);
      releaseSessionRuleId(ruleId);
    }
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({ ok: false, error: String(error?.message || error) });
  }
}

// 有活跃文档就复用，没有则创建一个（offscreen 文档常驻 sidepanel 创建的
// "offscreen-chat" 实例，新端口与之并存互不干扰）。
async function ensureAsrOffscreenDocument() {
  try {
    // 注意：SW 标准全局是 self.clients（ServiceWorkerGlobalScope.clients），
    // 没有 chrome.clients 这个命名空间。曾误用 chrome.clients 导致 TypeError
    // 被外层 catch 吞掉、无文档时从不创建 offscreen 文档，页面侧 asr-decode
    // 端口因找不到接收端 ~2ms 断连（「音频解码中断：后台连接已断开」）。
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    const hasDoc = clients.some((client) => client.url?.includes(OFFSCREEN_URL));
    if (!hasDoc) {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL(OFFSCREEN_URL),
        // 不用 AUDIO_PLAYBACK：Chrome 对无真实播放的 AUDIO_PLAYBACK 文档
        // 30 秒强制关闭（长视频解码 >30s 会「音频解码中断」）；本文档实际
        // 是解码 + 转写（WAV Blob 仅在本 context 内经 FormData 上传），
        // BLOBS 不受该限制。取值统一收拢在 shared/offscreen-constants.js
        //（与 sidepanel 聊天自愈的创建方共用同一 reason）。
        reasons: [OFFSCREEN_CREATE_REASON],
        justification: "Download, decode, slice and transcribe video audio for ASR subtitles."
      });
    }
  } catch {
    // 已有文档或创建失败：直接尝试连接，由连接结果兜底
  }
  return true;
}

// ===== 防盗链下载规则（dnr 为 MV3 专属 API，仅 background 可用） =====

// 为单个解码任务添加 Referer/Origin 会话规则（offscreen 文档 fetch 音轨时
// 绕防盗链；规则内容与旧固定 id 版本一致，仅 id 按任务独立）。保留先删后加
// 的幂等：SW 重启后分配器计数清零、id 复用时先清掉同名残留旧规则。
export async function addDownloadRules(ruleId) {
  const id = Number(ruleId) || 0;
  if (id <= 0) {
    throw new Error("缺少防盗链规则 id");
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [
      {
        id,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Referer", operation: "set", value: "https://www.bilibili.com" },
            { header: "Origin", operation: "set", value: "https://www.bilibili.com" }
          ]
        },
        condition: {
          urlFilter: "||bilivideo.com",
          resourceTypes: ["xmlhttprequest"]
        }
      }
    ]
  });
}

// 清掉指定任务 id 的规则（updateSessionRules 同时支持移除与添加）
export async function removeDownloadRules(ruleId) {
  const id = Number(ruleId) || 0;
  if (id <= 0) {
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id]
  });
}
