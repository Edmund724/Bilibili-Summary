// offscreen.js — 隐藏后台页面，负责 SSE 流式请求，避免 Side Panel 被冻结。
// 同时承接 ASR 音频解码任务（asr-decode 端口）：service worker 无
// AudioContext，解码+重采样在这里用 OfflineAudioContext 完成。
import { streamChat } from "../ai/client.js";
import {
  ASR_DECODE_TIMEOUT_MS,
  splitFloat32Array
} from "../asr/offscreen-bridge.js";

let activeAbortController = null;
let idleTimeoutId = null;
var STREAM_IDLE_TIMEOUT_MS = 90000;

function armIdleTimeout(abortController, port) {
  clearIdleTimeout();
  idleTimeoutId = setTimeout(function () {
    if (abortController && !abortController.signal.aborted) {
      abortController.abort();
      port.postMessage({
        type: "error",
        error: "请求超时（90 秒未返回任何数据），已自动中断"
      });
    }
  }, STREAM_IDLE_TIMEOUT_MS);
}

function clearIdleTimeout() {
  if (idleTimeoutId) {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = null;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "asr-decode") {
    port.onMessage.addListener((msg) => {
      if (!msg || msg.action !== "asr-decode") return;
      handleAsrDecodeTask(msg.task || {}, port);
    });
    return;
  }
  if (!port || port.name !== "offscreen-chat") {
    return;
  }

  port.onMessage.addListener(async (msg) => {
    if (!msg) return;
    if (msg.action === "stop") {
      abortActiveRequest();
      return;
    }
    if (msg.action !== "chat") return;

    try {
      abortActiveRequest();
      activeAbortController = new AbortController();

      const providersResp = await chrome.runtime.sendMessage({ type: "ai-providers-list" });
      const list = (providersResp?.providers || []).filter(p => p.enabled);
      const provider = list.find(p => p.id === msg.providerId) || null;
      if (!provider) {
        port.postMessage({ type: "error", error: "未找到选中的平台" });
        clearActiveRequestState();
        return;
      }

      const keysResp = await chrome.runtime.sendMessage({ type: "get-ai-provider-key", providerId: msg.providerId });
      if (!keysResp?.ok) {
        port.postMessage({ type: "error", error: keysResp?.error || "读取 API Key 失败" });
        clearActiveRequestState();
        return;
      }
      const apiKey = String(keysResp.apiKey || "").trim();
      if (provider.requiresKey !== false && !apiKey) {
        port.postMessage({ type: "error", error: "该平台 API Key 未配置" });
        clearActiveRequestState();
        return;
      }

      armIdleTimeout(activeAbortController, port);

      await streamChat({
        provider: { ...provider, apiKey },
        context: msg.context || {},
        userPrompt: msg.prompt || "",
        history: Array.isArray(msg.history) ? msg.history : [],
        thinkingLevel: msg.thinkingLevel,
        port,
        signal: activeAbortController.signal,
        onActivity: function () { armIdleTimeout(activeAbortController, port); }
      });
    } catch (e) {
      port.postMessage({ type: "error", error: String(e?.message || e) });
    } finally {
      clearIdleTimeout();
      clearActiveRequestState();
    }
  });

  port.onDisconnect.addListener(() => {
    abortActiveRequest();
    clearIdleTimeout();
    clearActiveRequestState();
  });
});

function abortActiveRequest() {
  if (activeAbortController && !activeAbortController.signal.aborted) {
    activeAbortController.abort();
  }
  activeAbortController = null;
}

function clearActiveRequestState() {
  activeAbortController = null;
}

// ===== ASR 音频解码任务 =====

// 收 { task: { type:"decode", audioBytes, startSec } }，解码 + 重采样 16k
// 单声道后按块回传 Float32Array（块间序号升序，页面侧按序拼接）。
// startSec 仅用于对齐采样起点：输入必须是 16k 采样率的字节流（页面侧
// 按此切段），先解码到 16k 单声道，再丢弃 startSec 前的采样。
async function handleAsrDecodeTask(task, port) {
  try {
    if (task?.type !== "decode" || !task.audioBytes) {
      throw new Error("asr-decode 任务参数不完整");
    }
    const { data, diagnostic } = await decodeTo16kMono(task.audioBytes, task.startSec);
    port.postMessage({
      type: "done",
      payload: { sampleRate: 16000, chunks: splitFloat32Array(data), diagnostic }
    });
  } catch (e) {
    port.postMessage({ type: "error", error: String(e?.message || e) });
  }
}

// 解码输入字节为 16kHz 单声道 Float32Array（解码 + 重采样 + 起点对齐）。
// AudioContext 解码用 detach 语义的 decodeAudioData，传入副本避免破坏
// 结构化克隆后的数据。
async function decodeTo16kMono(audioBytes, startSec = 0) {
  const AudioCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioCtor) {
    throw new Error("当前环境没有 AudioContext，无法解码");
  }
  const audioCtx = new AudioCtor();
  try {
    const decoded = await withTimeout(audioCtx.decodeAudioData(bytesToArrayBuffer(audioBytes)), ASR_DECODE_TIMEOUT_MS);
    const targetRate = 16000;
    const outLength = Math.max(1, Math.round(decoded.duration * targetRate));
    const offline = new OfflineAudioContext(1, outLength, targetRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await withTimeout(offline.startRendering(), ASR_DECODE_TIMEOUT_MS);
    const mono = rendered.getChannelData(0);
    if (!(mono.length > 0)) {
      throw new Error("音频解码失败：解码结果为空采样");
    }
    // 诊断信息：解码时长与峰值幅度。峰值≈0 说明解码出来是静音——用于区分
    // "视频真没人声"与"音轨获取/容器解码出了问题"（B 站 fMP4 有兼容性风险）。
    let peak = 0;
    for (let i = 0; i < mono.length; i += 1) {
      const abs = Math.abs(mono[i]);
      if (abs > peak) peak = abs;
    }
    const diagnostic = { durationSec: Math.round(rendered.duration * 100) / 100, peak };
    console.info("[BOC][asr-decode] 解码完成", diagnostic);
    const startSample = Math.round(Number(startSec || 0) * targetRate);
    if (startSample <= 0 || startSample >= mono.length) {
      return { data: mono, diagnostic };
    }
    return { data: mono.subarray(startSample), diagnostic };
  } finally {
    audioCtx.close();
  }
}

function bytesToArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) {
    return bytes.slice(0);
  }
  if (ArrayBuffer.isView(bytes)) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  if (Array.isArray(bytes)) {
    return new Uint8Array(bytes).buffer;
  }
  throw new Error("无法识别的音频数据格式");
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("音频解码超时")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
