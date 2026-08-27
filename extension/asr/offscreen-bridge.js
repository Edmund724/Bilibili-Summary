// extension/asr/offscreen-bridge.js
// ASR 音频解码的 offscreen 通道。MV3 service worker 没有 AudioContext，
// 解码必须跑在 offscreen 文档里；本项目现有 offscreen 基建是
// 「background 创建文档 + 页面侧连 port 发消息」的模式（entry/offscreen.js
// 的 offscreen-chat 端口即如此），因此这里沿用同一套：page 侧发起一个
// 单任务通道（background 保证任务互斥、至多一个活跃文档），结果随
// port 回显。
//
// 数据流：runAsrPipeline → createOffscreenDecodeHost()（page 侧）→
//   sendOffloadMessage({ taskType:"asr-decode", task }) → background
//   handleAsrDecode → 创建 offscreen 文档 → 文档 decodeTo16kMono →
//   解码结果按 MAX_RESPONSE_BYTES 分块回传（结构化克隆转普通数组）。
//
// 潜在上限：解码结果按块回传（每块 16MB，低于跨进程消息配额），
// 单条消息无超限风险；输入音频经 background 下载时已按 200MB 上限拒绝
// 超长视频（downloader.js）。

import { sendOffloadMessage } from "../core/runtime.js";

// offscreen 文档侧按此字节上限对解码结果分块回传（低于配额，保持保守）
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
// offscreen 文档内的任务超时（分钟）
export const ASR_DECODE_TIMEOUT_MS = 10 * 60 * 1000;
// background 为任务创建的 offscreen 文档 URL
export const ASR_DECODE_OFFSCREEN_URL = "entry/offscreen.html";

// page 侧：发起单任务通道并收结果。task 返回结构化克隆可序列化的值
// （TypedArray 会被转成普通数组；收结果侧自行复原）。
function runOffscreenTask(task) {
  return sendOffloadMessage({ taskType: "asr-decode", task });
}

// 页面侧合成宿主（全量解码 + 重采样）：一次把整段音频送给 offscreen，
// 解码结果按 MAX_RESPONSE_BYTES 分块回传后拼回 Float32Array。startSec 传 0
// （整段从头解码，无需对齐）。回传已按 MAX_RESPONSE_BYTES 分块（每个
// 16MB 块远低于跨进程消息配额），单条消息无超限风险，超长视频同样适用。
export function createOffscreenDecodeHost() {
  return async function offscreenDecodeHost(arrayBuffer) {
    const task = {
      type: "decode",
      audioBytes: new Uint8Array(arrayBuffer),
      startSec: 0
    };
    return runOffscreenTask(task).then((payload) => {
      const merged = restoreFloat32Array(payload.chunks || []);
      return {
        sampleRate: Number(payload.sampleRate) || 16000,
        length: merged.length,
        getChannelData: () => merged,
        // 解码诊断（时长/峰值幅度），offscreen 文档侧产出；chunker 据此
        // 把"解码出静音"变成显式报错。其它宿主无此字段，属可选项。
        diagnostic: payload.diagnostic || null
      };
    });
  };
}

// ===== background 侧执行器 =====

// 执行 asr-decode 任务：创建（或复用）offscreen 文档 → 连 port 提交
// { action:"asr-decode", task } → 收 done/error 结果。background 侧只
// 透传文档的 port 消息（消息携带 content 时直接回传，需避免 sendResponse
// 跨任务误接：文档始终只回显单条结果）。
const ASR_OFFSCREEN_PORT = "asr-decode";
let asrOffscreenLock = null;

export async function handleAsrDecode(message, sender, sendResponse) {
  const task = message?.task;
  if (!task || typeof task !== "object") {
    sendResponse({ ok: false, error: "缺少 asr-decode 任务参数" });
    return;
  }
  try {
    const payload = await withAsrOffscreenLock(() => runInAsrOffscreen(task));
    sendResponse({ ok: true, payload });
  } catch (error) {
    sendResponse({ ok: false, error: String(error?.message || error) });
  }
}

// 任务互斥：同时只有一个 offscreen 解码任务在跑（避免并发创建文档）
async function withAsrOffscreenLock(taskFn) {
  while (asrOffscreenLock) {
    await asrOffscreenLock;
  }
  let release;
  asrOffscreenLock = new Promise((resolve) => {
    release = resolve;
  });
  try {
    return await taskFn();
  } finally {
    asrOffscreenLock = null;
    release();
  }
}

async function runInAsrOffscreen(task) {
  const document = await ensureAsrOffscreenDocument();
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: ASR_OFFSCREEN_PORT });
    let settled = false;
    const finish = (cb, value) => {
      if (settled) return;
      settled = true;
      try {
        port.disconnect();
      } catch {
        // ignore
      }
      cb(value);
    };
    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "done") {
        finish(resolve, msg.payload);
        return;
      }
      if (msg.type === "error") {
        finish(reject, new Error(String(msg.error || "offscreen 解码失败")));
      }
    });
    port.onDisconnect.addListener(() => {
      finish(reject, new Error("offscreen 文档已断开，音频解码失败"));
    });
    port.postMessage({ action: "asr-decode", task });
    // 兜底超时（文档侧也会超时，这里防文档被冻结的极端情况）
    setTimeout(() => {
      finish(reject, new Error("音频解码超时"));
    }, ASR_DECODE_TIMEOUT_MS + 15000).unref?.();
  });
}

// 有活跃文档就复用，没有则创建一个（offscreen 文档常驻 sidepanel 创建的
// "offscreen-chat" 实例，新端口与之并存互不干扰）。
async function ensureAsrOffscreenDocument() {
  try {
    const clients = await chrome.clients.matchAll({ includeUncontrolled: true });
    const hasDoc = clients.some((client) => client.url?.includes(ASR_DECODE_OFFSCREEN_URL));
    if (!hasDoc) {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL(ASR_DECODE_OFFSCREEN_URL),
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Decode and resample video audio for ASR transcription."
      });
    }
  } catch {
    // 已有文档或创建失败：直接尝试连接，由连接结果兜底
  }
  return true;
}

// ===== 工具（页面/文档双侧共用） =====

// 把 Float32Array 按 MAX_RESPONSE_BYTES 切成若干普通数组（结构化克隆
// 会把 TypedArray 转普通数组，这里显式切片避免一次传过大）
export function splitFloat32Array(data, maxBytes = MAX_RESPONSE_BYTES) {
  const bytesPerSample = 4;
  const maxSamples = Math.max(1, Math.floor(maxBytes / bytesPerSample));
  const chunks = [];
  for (let offset = 0; offset < data.length; offset += maxSamples) {
    chunks.push(Array.from(data.subarray(offset, offset + maxSamples)));
  }
  return chunks;
}

// 拼回整段解码结果（供宿主 getChannelData 使用）
export function restoreFloat32Array(chunks) {
  const total = chunks.reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const arr of chunks) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}
