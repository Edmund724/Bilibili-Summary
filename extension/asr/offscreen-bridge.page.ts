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
import type { AsrProgressMessage, AsrChunkResultMessage, AsrDoneMessage, AsrErrorMessage } from "./protocol.js";

// ===== 页面侧任务契约类型 =====

// 适配器单片结果（port 透传的 JSON；叶子字段保持 unknown，页面侧只做
// 防御性读取——字段语义见 asr/protocol.js 的 chunk-result 注释）
export interface AsrChunkResult {
  text?: unknown;
  segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }>;
  _asrDiag?: unknown;
  durationSec?: unknown;
}

// 单片记录（offscreen 桥 done 后按片 index 排序）
export interface AsrChunkRecord {
  index: number;
  startSec: number;
  durationSec: number;
  result: AsrChunkResult | null;
}

// 任务入参：audioUrl 可缺省（音轨条目无 baseUrl 时由 offscreen 侧报错兜底）
export interface OffscreenChunkHostArgs {
  audioUrl: string | undefined;
  backupUrls?: string[];
  onProgress?: (message: string) => void;
}

// 任务结果：results 为按片 index 排序的单片记录；totalChunks 为产出片数，
// skippedSegments 为解码失败跳过的段数，failedChunks 为转写失败跳过的片数
// （Q8a 口径：个别失败不整体失败，全部段解码失败零片产出才算整体失败，
// 见 asr/protocol.js）。
export interface OffscreenChunkHostResult {
  results: AsrChunkRecord[];
  totalChunks: number;
  skippedSegments: number;
  failedChunks: number;
}

// 页面侧客户端契约：
//   async ({ audioUrl, backupUrls, onProgress? }) =>
//     { results, totalChunks, skippedSegments, failedChunks }
//     results 为按片 index 排序的 [{ index, startSec, durationSec, result }]，
//     result 是适配器单片结果 { text, segments?, _asrDiag? }（Q8a 口径与
//     完整结果形状见 asr/protocol.js）。
// onProgress 中继 offscreen 引擎产出的进度文本。失败 reject 带用户可读文案；
// 成功失败都会发 cleanup 清 dnr 规则（带上 prepare 响应带回的 ruleId，只清
// 本任务这条，不碰并发任务的）。
export type OffscreenChunkHost = (args: OffscreenChunkHostArgs) => Promise<OffscreenChunkHostResult>;

// prepare 响应（background 回包：offscreen 文档就绪 + 本任务的防盗链规则 id）
interface OffscreenPrepareResponse {
  ok?: boolean;
  ruleId?: number;
  error?: string;
}

// port 消息读取形状直接复用 protocol 的消息类型（线格式一致）。progress 的
// 文本字段是 text（entry/offscreen-asr.ts 的 postMessage 实发字段）。
type AsrPortMessageLike =
  | AsrProgressMessage
  | AsrChunkResultMessage
  | AsrDoneMessage
  | AsrErrorMessage;

export function createOffscreenChunkHost(): OffscreenChunkHost {
  return async function offscreenChunkHost({ audioUrl, backupUrls, onProgress }: OffscreenChunkHostArgs): Promise<OffscreenChunkHostResult> {
    // 先让 background 建 offscreen 文档 + 加防盗链规则（响应带回 ruleId），
    // 再直连文档传任务
    const prepared = (await sendOffloadMessage({ taskType: ASR_TASK_PREPARE })) as OffscreenPrepareResponse | null;
    if (!prepared?.ok) {
      throw new Error(prepared?.error || "音频解码服务启动失败");
    }
    const sessionRuleId = Number(prepared.ruleId) || 0;

    return new Promise((resolve, reject) => {
      const results: AsrChunkRecord[] = [];
      let done = false;
      let totalChunks = 0;
      let skippedSegments = 0;
      let failedChunks = 0;

      const cleanup = (): void => {
        sendOffloadMessage({ taskType: ASR_TASK_CLEANUP, ruleId: sessionRuleId }).catch(() => {
          // 规则清理失败不影响主流程（会话规则随浏览器重启自动清空）
        });
      };
      const finish = <V>(callback: (value: V) => void, value: V): void => {
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
      port.onMessage.addListener((rawMsg: unknown) => {
        const msg = rawMsg as AsrPortMessageLike | null;
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
            result: msg.result as AsrChunkResult | null
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
          const error: Error & { code?: string; reason?: string } = new Error(msg.error || "音频转写失败");
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
