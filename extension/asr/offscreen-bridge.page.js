// ASR offscreen 通道的页面侧客户端（createOffscreenChunkHost）：一次发起
// 「下载 + 解码 + 切片 + 转写」任务，音频字节与 API Key 全程不出 offscreen
// （offscreen 自己 fetch、自己取配置），页面只收逐片文本结果。
// 仅在页面环境加载（bundle 链路：pipeline → fallback → content script），
// 协议常量与契约注释唯一地址见 asr/protocol.js。

import { sendOffloadMessage } from "../shared/messaging.js";
import {
  ASR_DECODE_PORT_NAME,
  ASR_DECODE_ACTION,
  ASR_MSG_PROGRESS,
  ASR_MSG_CHUNK_RESULT,
  ASR_MSG_DONE,
  ASR_MSG_ERROR,
  ASR_TASK_PREPARE,
  ASR_TASK_CLEANUP
} from "./protocol.js";

// 页面侧客户端契约：
//   async ({ audioUrl, backupUrls, onProgress? }) =>
//     { results, totalChunks, skippedSegments, failedChunks }
//     results 为按片 index 排序的 [{ index, startSec, durationSec, result }]，
//     result 是适配器单片结果 { text, segments?, _asrDiag? }（Q8a 口径与
//     完整结果形状见 asr/protocol.js）。
// onProgress 中继 offscreen 引擎产出的进度文本。失败 reject 带用户可读文案；
// 成功失败都会发 cleanup 清 dnr 规则（带上 prepare 响应带回的 ruleId，只清
// 本任务这条，不碰并发任务的）。
export function createOffscreenChunkHost() {
  return async function offscreenChunkHost({ audioUrl, backupUrls, onProgress }) {
    // 先让 background 建 offscreen 文档 + 加防盗链规则（响应带回 ruleId），
    // 再直连文档传任务
    const prepared = await sendOffloadMessage({ taskType: ASR_TASK_PREPARE });
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
        sendOffloadMessage({ taskType: ASR_TASK_CLEANUP, ruleId: sessionRuleId }).catch(() => {
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

      const port = chrome.runtime.connect({ name: ASR_DECODE_PORT_NAME });
      port.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== "object" || done) return;
        if (msg.type === ASR_MSG_PROGRESS) {
          // offscreen 引擎产出的进度文本（语音识别中 N 片…）原样中继
          try {
            onProgress?.(String(msg.text || ""));
          } catch {
            // 进度回调异常不影响收包
          }
          return;
        }
        if (msg.type === ASR_MSG_CHUNK_RESULT) {
          results.push({
            index: Number(msg.index) || 0,
            startSec: Number(msg.startSec) || 0,
            durationSec: Number(msg.durationSec) || 0,
            result: msg.result
          });
          return;
        }
        if (msg.type === ASR_MSG_DONE) {
          totalChunks = Number(msg.totalChunks) || results.length;
          skippedSegments = Number(msg.skippedSegments) || 0;
          failedChunks = Number(msg.failedChunks) || 0;
          results.sort((a, b) => a.index - b.index);
          finish(resolve, { results, totalChunks, skippedSegments, failedChunks });
          return;
        }
        if (msg.type === ASR_MSG_ERROR) {
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
        action: ASR_DECODE_ACTION,
        task: {
          audioUrl: String(audioUrl || "").trim(),
          backupUrls: Array.isArray(backupUrls) ? backupUrls : []
        }
      });
    });
  };
}
