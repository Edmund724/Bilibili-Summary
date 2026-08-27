// offscreen.js — 隐藏后台页面，负责 SSE 流式请求，避免 Side Panel 被冻结。
// 同时承接 ASR 音频解码任务（asr-decode 端口）：service worker 无
// AudioContext，解码+重采样在这里用 OfflineAudioContext 完成。
import { streamChat } from "../ai/client.js";
import {
  MAX_AUDIO_BYTES,
  ASR_DECODE_TIMEOUT_MS,
  bytesToBase64
} from "../asr/offscreen-bridge.js";
import { buildWavChunks, makeDecodedBuffer } from "../asr/chunker.js";

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

// 收 { task: { audioUrl, backupUrls, chunkSeconds } }：在 offscreen 文档内
// 完成「下载（HEAD 探大小、主备 URL 轮换）→ 解码 → 校验 → 切片 → WAV 编码」，
// 每片 WAV 转 base64 字符串回传（chrome.runtime 消息是 JSON 序列化，二进制
// 跨 context 会变成数字键对象字节全损，base64 是唯一可靠通道）。音频字节
// 全程不跨 context。
async function handleAsrDecodeTask(task, port) {
  let aborted = false;
  port.onDisconnect.addListener(() => {
    // 断连视为取消：下载/切片循环处检查标志并静默退出（原 asr-audio 通道风格）
    aborted = true;
  });
  try {
    const audioUrl = String(task?.audioUrl || "").trim();
    if (!audioUrl) {
      throw new Error("asr-decode 任务参数不完整");
    }
    const chunkSeconds = Number(task?.chunkSeconds) || 0;

    const audioBytes = await fetchAudioBytes([audioUrl, ...(task?.backupUrls || [])], aborted);
    if (aborted) return;

    const { data, diagnostic } = await decodeTo16kMono(audioBytes, 0);
    if (aborted) return;

    // 静音/零时长校验 + 切片（chunkSeconds<=0 不切，整段一片，与 chunker 既有语义一致）。
    // data 是裸 Float32Array，须经 makeDecodedBuffer 适配为 chunker 契约的
    // AudioBuffer 鸭子类型（sampleRate 16k + diagnostic），否则会被误报「时长为零」。
    const chunks = buildWavChunks(makeDecodedBuffer(data, { diagnostic }), { chunkSeconds });
    for (const chunk of chunks) {
      if (aborted) return;
      port.postMessage({
        type: "chunk",
        index: chunk.index,
        startSec: chunk.startSec,
        durationSec: chunk.durationSec,
        wavBase64: bytesToBase64(new Uint8Array(await chunk.wavBlob.arrayBuffer()))
      });
    }
    if (aborted) return;
    port.postMessage({ type: "done", totalChunks: chunks.length });
  } catch (e) {
    if (aborted) {
      return;
    }
    try {
      port.postMessage({ type: "error", error: String(e?.message || e) });
    } catch {
      // port 已断开，忽略
    }
  }
}

// 依次尝试主地址与备用地址下载，返回字节数组。HEAD 先探大小：超上限直接
// 拒绝（不发起 GET），报「视频过长」；HEAD 非 ok 也照常走 GET（部分 CDN
// 不支持 HEAD）。任一次 GET 非 ok 或返回体为空视为失败，继续试下一个地址。
async function fetchAudioBytes(urls, aborted) {
  let headDone = false;
  for (const url of urls) {
    if (aborted) return null;
    if (!headDone) {
      await probeSize(url);
      headDone = true;
    }
    if (aborted) return null;
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      continue;
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.length === 0) {
      continue;
    }
    return buffer;
  }
  throw new Error("音频下载失败");
}

// HEAD 探大小：Content-Length 超上限直接拒绝（超长视频不下载不解码）
async function probeSize(url) {
  const response = await fetch(url, { method: "HEAD" });
  if (!response.ok) {
    // HEAD 非 ok：部分 CDN 不支持 HEAD，交给 GET 兜底
    return;
  }
  const length = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > 0 && length > MAX_AUDIO_BYTES) {
    throw new Error("视频过长");
  }
}

// 解码输入字节为 16kHz 单声道 Float32Array（解码 + 重采样 + 起点对齐）。
// AudioContext 解码用 detach 语义的 decodeAudioData，传入副本避免破坏
// 数据。startSec 仅用于对齐采样起点（本链路恒传 0，整段从头解码）。
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
    // 校验（静音/零时长显式报错）由 chunker 的 validateDecodedAudio 统一负责。
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
