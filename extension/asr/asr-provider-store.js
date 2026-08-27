// extension/asr/asr-provider-store.js
// ASR（语音转写）平台 Provider/Key 的设置存储 + 连通性探针。
// 镜像 extension/core/ai-provider-store.js 的模式：provider 列表持久化在
// chrome.storage.sync，API Key 单独存放在 chrome.storage.local，不随列表
// 明文回传（列表只带 hasSavedKey 布尔占位）。本模块只与 chrome.storage /
// fetch 交互，不涉及消息路由——background.js 的处理函数调用这里。
//
// 与 AI 平台存储完全隔离：用不同的 storage key（asrProviders / asrProviderKeys），
// 不和对话平台混用同一个列表。

import { normalizeAsrProvider, normalizeBaseUrl } from "../core/shared-defaults.js";

// ===== ASR 平台列表存储 =====

const ASR_PROVIDER_KEYS_STORAGE = "asrProviderKeys";
const ASR_PROVIDERS_STORAGE = "asrProviders";

// 读取已存 API Key（providerId -> apiKey 的映射）。Key 单独存 local，
// 不随 sync 的 provider 列表明文回传。
export async function loadAsrProviderKeys() {
  const localData = await chrome.storage.local.get([ASR_PROVIDER_KEYS_STORAGE]);
  const keys = localData?.[ASR_PROVIDER_KEYS_STORAGE];
  return keys && typeof keys === "object" ? keys : {};
}

// 读取单个 provider 的已存 Key（按 id 查）。供探针在不要求用户重输 Key 时使用。
export async function getAsrProviderKey(providerId) {
  if (!providerId) return "";
  const keys = await loadAsrProviderKeys();
  return String(keys[providerId] || "").trim();
}

// 写入/清空单个 provider 的 Key（空串则删除）。
export async function saveAsrProviderKey(providerId, apiKey) {
  const keys = await loadAsrProviderKeys();
  const trimmed = String(apiKey || "").trim();
  if (trimmed) {
    keys[providerId] = trimmed;
  } else {
    delete keys[providerId];
  }
  await chrome.storage.local.set({ [ASR_PROVIDER_KEYS_STORAGE]: keys });
  return keys;
}

// 读取 provider 列表，Key 不明文回传，只带 hasSavedKey 占位。
export async function loadAsrProviders() {
  const [syncData, keys] = await Promise.all([
    chrome.storage.sync.get([ASR_PROVIDERS_STORAGE]),
    loadAsrProviderKeys()
  ]);
  const list = Array.isArray(syncData[ASR_PROVIDERS_STORAGE]) ? syncData[ASR_PROVIDERS_STORAGE] : [];
  return list
    .map(normalizeAsrProvider)
    .filter(Boolean)
    .map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
}

// 保存 provider 列表。列表中若带 apiKey 字段则一并写入 Key 存储，
// 但回传列表只带 hasSavedKey 占位（Key 不明文出现在 sync 列表里）。
export async function saveAsrProviders(items) {
  const rawList = Array.isArray(items) ? items : [];
  const keys = await loadAsrProviderKeys();
  const nextList = [];
  for (const raw of rawList) {
    const normalized = normalizeAsrProvider(raw);
    if (!normalized) continue;
    nextList.push(normalized);
    const incomingKey = String(raw?.apiKey || "").trim();
    if (incomingKey) {
      keys[normalized.id] = incomingKey;
    }
  }
  await Promise.all([
    chrome.storage.sync.set({ [ASR_PROVIDERS_STORAGE]: nextList }),
    chrome.storage.local.set({ [ASR_PROVIDER_KEYS_STORAGE]: keys })
  ]);
  // 返回带 hasSavedKey 的列表，方便前端渲染占位
  return nextList.map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
}

// 删除 provider，其已存 Key 一并清理（不残留孤儿 Key）。
export async function deleteAsrProvider(providerId) {
  const list = await loadAsrProviders();
  const next = list.filter((p) => p.id !== providerId).map((p) => {
    // 列表项带 hasSavedKey 占位，归一化函数不接受该字段，剥掉再存
    const { hasSavedKey: _omit, ...rest } = p;
    return rest;
  });
  await chrome.storage.sync.set({ [ASR_PROVIDERS_STORAGE]: next });
  const keys = await loadAsrProviderKeys();
  if (keys && providerId in keys) {
    delete keys[providerId];
    await chrome.storage.local.set({ [ASR_PROVIDER_KEYS_STORAGE]: keys });
  }
  return next.map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
}

// ===== 静音 WAV 生成（探针用） =====

// 构造 1 秒 16kHz 单声道 16bit PCM 静音 WAV（全零采样）。
// 手写 WAV header + PCM，不引依赖。用于 openai-transcriptions 探针。
// 1 秒 16k 单声道 16bit = 16000 采样 * 2 字节 = 32000 字节 PCM。
export function buildSilentWavBytes(durationSec = 1, sampleRate = 16000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const sampleCount = Math.max(1, Math.floor(Number(durationSec) * sampleRate));
  const dataSize = sampleCount * blockAlign;

  // RIFF chunk: 12 字节
  // fmt subchunk: 16 字节
  // data subchunk header: 8 字节
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true); // chunk size
  writeAscii(view, 8, "WAVE");

  // fmt subchunk
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // subchunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data subchunk（静音，PCM 全零即 0x0000，ArrayBuffer 默认全零无需再写）
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  return new Uint8Array(buffer);
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ===== 连通性探针 =====

// 按 provider.type 分发到对应探针。provider 可直接带 apiKey（前端测试按钮
// 用户重输的场景），也可不带（由 providerId 从已存 Key 读取）。
// 返回 { ok: boolean, error?: string }。
export async function testAsrConnection(provider) {
  const normalized = normalizeAsrProvider(provider);
  if (!normalized) {
    return { ok: false, error: "平台配置不完整或 type 非法" };
  }

  // 解析 apiKey：优先 provider.apiKey，否则按 id 读已存 Key
  let apiKey = String(provider?.apiKey || "").trim();
  if (!apiKey && normalized.id) {
    apiKey = await getAsrProviderKey(normalized.id);
  }

  if (normalized.type === "openai-transcriptions") {
    return probeOpenAiTranscriptions({
      baseUrl: normalized.baseUrl,
      apiKey,
      model: normalized.model
    });
  }
  if (normalized.type === "dashscope-filetrans") {
    return probeDashscopeFiletrans({ baseUrl: normalized.baseUrl, apiKey });
  }
  // normalizeAsrProvider 已校验 type，理论上到不了这里
  return { ok: false, error: "未知的 ASR 平台类型：" + normalized.type };
}

// openai-transcriptions 探针：构造 1 秒 16kHz 静音 WAV POST 到
// `${baseUrl}/audio/transcriptions`，HTTP 200 即通过。
// 适用于 SiliconFlow / 本地 Whisper / 自定义。
async function probeOpenAiTranscriptions({ baseUrl, apiKey, model }) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return { ok: false, error: "请填写 baseUrl" };
  }
  if (!model) {
    return { ok: false, error: "请填写模型名" };
  }

  const wavBytes = buildSilentWavBytes(1, 16000);
  // jsdom / Node 测试环境无原生 FormData/Blob 时降级用 multipart 手拼
  const hasFormData = typeof FormData !== "undefined" && typeof Blob !== "undefined";
  let body;
  const headers = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  if (hasFormData) {
    const form = new FormData();
    form.append("file", new Blob([wavBytes], { type: "audio/wav" }), "probe.wav");
    form.append("model", model);
    form.append("response_format", "verbose_json");
    form.append("language", "zh");
    body = form;
    // 千万不要手动设 Content-Type，浏览器自动带 boundary
  } else {
    const boundary = "----bocAsrProbe" + Math.random().toString(36).slice(2);
    headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
    body = buildMultipartBody(boundary, [
      { name: "file", filename: "probe.wav", contentType: "audio/wav", data: wavBytes },
      { name: "model", value: model },
      { name: "response_format", value: "verbose_json" },
      { name: "language", value: "zh" }
    ]);
  }

  let response;
  try {
    response = await fetch(`${normalizedBaseUrl}/audio/transcriptions`, {
      method: "POST",
      headers,
      body
    });
  } catch (error) {
    return { ok: false, error: `无法连接：${error?.message || error}` };
  }

  if (response.ok) {
    return { ok: true };
  }

  let detail = "";
  try {
    detail = (await response.text()).slice(0, 200);
  } catch {}
  return { ok: false, error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
}

// dashscope-filetrans 探针：调百炼临时存储上传授权接口验证 Key 有效即可，
// 不真跑转写任务。接口：GET ${baseUrl}/api/v1/uploads?action=getPolicy&model=paraformer-v2
// （参考百炼"文件上传"文档）。授权 200 即认为 Key 有效。
async function probeDashscopeFiletrans({ baseUrl, apiKey }) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return { ok: false, error: "请填写 baseUrl" };
  }
  if (!apiKey) {
    return { ok: false, error: "请填写 API Key" };
  }

  let response;
  try {
    response = await fetch(
      `${normalizedBaseUrl}/api/v1/uploads?action=getPolicy&model=paraformer-v2`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json"
        }
      }
    );
  } catch (error) {
    return { ok: false, error: `无法连接：${error?.message || error}` };
  }

  if (response.ok) {
    return { ok: true };
  }

  // 401/403 明确是 Key 无效；其它 4xx 附带响应体片段
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 200);
  } catch {}
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: `API Key 无效或无权限（HTTP ${response.status}）${detail ? `: ${detail}` : ""}` };
  }
  return { ok: false, error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
}

// ===== 工具：multipart 手拼（无 FormData 环境降级用） =====

function buildMultipartBody(boundary, fields) {
  const parts = [];
  const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  const crlf = "\r\n";

  for (const field of fields) {
    parts.push(`--${boundary}${crlf}`);
    if (field.filename) {
      parts.push(
        `Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"${crlf}`
      );
      parts.push(`Content-Type: ${field.contentType}${crlf}${crlf}`);
      // 二进制数据后续单独 append
      parts.push({ binary: field.data });
      parts.push(crlf);
    } else {
      parts.push(`Content-Disposition: form-data; name="${field.name}"${crlf}${crlf}`);
      parts.push(`${field.value}${crlf}`);
    }
  }
  parts.push(`--${boundary}--${crlf}`);

  // 统一编码为 Uint8Array
  const chunks = parts.map((part) => {
    if (part && typeof part === "object" && part.binary) {
      return part.binary;
    }
    const str = String(part);
    return encoder ? encoder.encode(str) : Buffer.from(str, "utf-8");
  });
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// ===== 工具：bytes -> base64 =====

// 分段编码避免 String.fromCharCode 栈溢出（32768 字节/段）。
function bytesToBase64(bytes) {
  // 环境差异：浏览器有 btoa，Node 有 Buffer。优先 btoa。
  if (typeof btoa === "function") {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  throw new Error("当前环境不支持 base64 编码（无 btoa / Buffer）");
}
