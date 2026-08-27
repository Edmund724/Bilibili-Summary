// ASR 音频「下载 + 解码 + 切片 + WAV 编码」的 offscreen 通道。MV3 service
// worker 没有 AudioContext，且 chrome.runtime 消息是 JSON 序列化——二进制
// （Uint8Array / Float32Array）跨 context 会变成数字键普通对象，字节全损。
// 因此下载、解码、切片、WAV 编码整体搬进 offscreen 文档，跨 context 只传
// 字符串（base64）与小 JSON，转写层（页面侧逐片 fetch 语音平台）不动。
//
// 数据流：runAsrPipeline → createOffscreenChunkHost()（page 侧）→
//   sendOffloadMessage({ taskType:"asr-decode-prepare" }) → background 建
//   offscreen 文档 + 加 dnr 防盗链规则 → 页面连 "asr-decode" port 直连
//   文档 → postMessage 任务 → 逐片收 { type:"chunk", wavBase64 } →
//   { type:"done" } → base64 还原为 Blob 返回 → 再发
//   { taskType:"asr-decode-cleanup" } 清 dnr 规则。
//
// 本模块同时在 background 与页面两个环境加载：顶层不触碰 worker-only API
// （chrome.declarativeNetRequest / chrome.offscreen 只在各自 handler 函数体内
// 访问）。

import { sendOffloadMessage } from "../core/runtime.js";

// 音频体积上限 200MB（offscreen 文档侧下载时 HEAD 探大小据此拒绝超长视频）
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
// offscreen 文档内的任务超时（解码与下载共用）
export const ASR_DECODE_TIMEOUT_MS = 10 * 60 * 1000;
// background 为任务创建的 offscreen 文档 URL
export const ASR_DECODE_OFFSCREEN_URL = "entry/offscreen.html";
// 会话规则 id：固定值即可，一次只跑一个解码任务，冲突概率低；
// updateSessionRules 采用"移除全部旧规则再添加"的方式天然去重。
const ASR_AUDIO_SESSION_RULE_ID = 32001;

// ===== 共享工具（页面/文档双侧共用） =====

// Uint8Array → base64 字符串（btoa 0x8000 分块，避免 String.fromCharCode
// 栈溢出）。浏览器用 btoa，Node 下退 Buffer。
export function bytesToBase64(bytes) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof btoa === "function") {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < source.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, source.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(source).toString("base64");
  }
  throw new Error("当前环境不支持 base64 编码（无 btoa / Buffer）");
}

// base64 字符串 → Uint8Array（bytesToBase64 的逆操作）
export function base64ToBytes(b64) {
  const binary = atob(String(b64 || ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// ===== 页面侧 chunk host =====

// 页面侧合成宿主：一次发起「下载 + 解码 + 切片 + WAV 编码」任务，音频字节
// 全程不跨 context（offscreen 文档自己 fetch），每片 WAV 以 base64 字符串
// 回传后还原为 Blob。契约：
//   async ({ audioUrl, backupUrls, plan }) =>
//     [{ index, startSec, durationSec, wavBlob }]
// 失败 reject 带用户可读文案；成功失败都会发 asr-decode-cleanup 清 dnr 规则。
export function createOffscreenChunkHost() {
  return async function offscreenChunkHost({ audioUrl, backupUrls, plan }) {
    // 先让 background 建 offscreen 文档 + 加防盗链规则，再直连文档传任务
    const prepared = await sendOffloadMessage({ taskType: "asr-decode-prepare" });
    if (!prepared?.ok) {
      throw new Error(prepared?.error || "音频解码服务启动失败");
    }

    return new Promise((resolve, reject) => {
      const chunks = [];
      let done = false;

      const cleanup = () => {
        sendOffloadMessage({ taskType: "asr-decode-cleanup" }).catch(() => {
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
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "chunk") {
          // done 之前未知 index 的 chunk 也收下，done 后统一按 index 排序
          chunks.push({
            index: Number(msg.index) || 0,
            startSec: Number(msg.startSec) || 0,
            durationSec: Number(msg.durationSec) || 0,
            wavBlob: new Blob([base64ToBytes(msg.wavBase64)], { type: "audio/wav" })
          });
          return;
        }
        if (msg.type === "done") {
          const ordered = chunks
            .slice()
            .sort((a, b) => a.index - b.index);
          finish(resolve, ordered);
          return;
        }
        if (msg.type === "error") {
          finish(reject, new Error(msg.error || "音频解码失败"));
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
          backupUrls: Array.isArray(backupUrls) ? backupUrls : [],
          chunkSeconds: Number(plan?.chunkSeconds) || 0
        }
      });
    });
  };
}

// ===== background 侧执行器 =====

// 任务准备：创建（或复用）offscreen 文档 + 加防盗链下载规则。页面侧连
// "asr-decode" 端口前调用，保证文档与规则就绪。
export async function handleAsrDecodePrepare(message, sender, sendResponse) {
  try {
    await ensureAsrOffscreenDocument();
    await addDownloadRules();
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({ ok: false, error: String(error?.message || error) });
  }
}

// 任务收尾：清掉本次解码会话加的防盗链规则（成功失败都要调，页面侧用
// try/finally 或 .finally 兜底）。会话规则随浏览器重启自动清空，无需持久化。
export async function handleAsrDecodeCleanup(message, sender, sendResponse) {
  try {
    await removeDownloadRules();
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
    const hasDoc = clients.some((client) => client.url?.includes(ASR_DECODE_OFFSCREEN_URL));
    if (!hasDoc) {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL(ASR_DECODE_OFFSCREEN_URL),
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Download, decode and slice video audio for ASR transcription."
      });
    }
  } catch {
    // 已有文档或创建失败：直接尝试连接，由连接结果兜底
  }
  return true;
}

// ===== 防盗链下载规则（dnr 为 MV3 专属 API，仅 background 可用） =====

// 为本次解码任务添加 Referer/Origin 会话规则（offscreen 文档 fetch 音轨时
// 绕防盗链；规则添加在任务准备阶段完成）
export async function addDownloadRules() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ASR_AUDIO_SESSION_RULE_ID],
    addRules: [
      {
        id: ASR_AUDIO_SESSION_RULE_ID,
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

// 清掉本次解码会话添加的规则（updateSessionRules 同时支持移除与添加）
export async function removeDownloadRules() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ASR_AUDIO_SESSION_RULE_ID]
  });
}
