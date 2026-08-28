// extension/asr/asr-provider-store.js
// ASR（语音转写）平台 Provider/Key 的设置存储 + 连通性探针。
// 列表 CRUD 委托给 extension/core/provider-store.js 的 createProviderStore
// （与 AI 平台存储共用同一工厂）：provider 列表持久化在 chrome.storage.sync，
// API Key 单独存放在 chrome.storage.local，不随列表明文回传（列表只带
// hasSavedKey 布尔占位）。本模块只与 chrome.storage / fetch 交互，不涉及
// 消息路由——background.js 的处理函数调用这里。
//
// 与 AI 平台存储完全隔离：用不同的 storage key（asrProviders / asrProviderKeys），
// 不和对话平台混用同一个列表。

import { normalizeAsrProvider, normalizeBaseUrl } from "../core/shared-defaults.js";
import { createProviderStore } from "../core/provider-store.js";
import { getMergedSettings } from "../core/ai-provider-store.js";

// ===== ASR 平台列表存储 =====

const ASR_PROVIDER_KEYS_STORAGE = "asrProviderKeys";
const ASR_PROVIDERS_STORAGE = "asrProviders";

const providerStore = createProviderStore({
  listStorageKey: ASR_PROVIDERS_STORAGE,
  keysStorageKey: ASR_PROVIDER_KEYS_STORAGE,
  normalizeProvider: normalizeAsrProvider
});

// 读取已存 API Key（providerId -> apiKey 的映射）。Key 单独存 local，
// 不随 sync 的 provider 列表明文回传。
export async function loadAsrProviderKeys() {
  return providerStore.loadKeys();
}

// 读取单个 provider 的已存 Key（按 id 查）。供探针在不要求用户重输 Key 时使用。
export async function getAsrProviderKey(providerId) {
  return providerStore.getKey(providerId);
}

// 读取 provider 列表，Key 不明文回传，只带 hasSavedKey 占位。
export async function loadAsrProviders() {
  return providerStore.loadProviders();
}

// 保存 provider 列表。列表中若带 apiKey 字段则一并写入 Key 存储，
// 但回传列表只带 hasSavedKey 占位（Key 不明文出现在 sync 列表里）。
export async function saveAsrProviders(items) {
  return providerStore.saveProviders(items);
}

// 删除 provider，其已存 Key 一并清理（不残留孤儿 Key）。
export async function deleteAsrProvider(providerId) {
  return providerStore.deleteProvider(providerId);
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
// 可选第二参 options.transport：注入传输函数（测试用 fake transport），
// 缺省在调用时取全局 fetch（而非模块加载时绑定）。
// 返回 { ok: boolean, error?: string }。
export async function testAsrConnection(provider, { transport } = {}) {
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
    // 语言档位来自全局设置 asrLanguage（popup 顶部切换）：测试连接时同步
    // 验证该语言的请求链路（SiliconFlow 辰星只有 ?language=english 才启用
    // 英文识别，静音探针的 200 即证明该参数被接受）。
    let language = "";
    try {
      const settings = await getMergedSettings();
      language = settings?.asrLanguage || "";
    } catch {
      // 设置读取失败不阻塞探针：按 auto 处理（不附语言参数）
    }
    return probeOpenAiTranscriptions({
      baseUrl: normalized.baseUrl,
      apiKey,
      model: normalized.model,
      language,
      transport
    });
  }
  // normalizeAsrProvider 已校验 type，理论上到不了这里
  return { ok: false, error: "未知的 ASR 平台类型：" + normalized.type };
}

// openai-transcriptions 探针：构造 1 秒 16kHz 静音 WAV POST 到
// `${baseUrl}/audio/transcriptions`，HTTP 200 即通过。
// 适用于 SiliconFlow / 本地 Whisper / 自定义。
// 语言档位（provider.language）以查询参数附带：选 zh/en 时同时验证该语言的
// 请求链路（SiliconFlow 辰星只有 ?language=english 才启用英文识别，静音探针
// 的 200 即证明该参数被接受）。
async function probeOpenAiTranscriptions({ baseUrl, apiKey, model, language, transport }) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return { ok: false, error: "请填写 baseUrl" };
  }
  if (!model) {
    return { ok: false, error: "请填写模型名" };
  }

  const wavBytes = buildSilentWavBytes(1, 16000);
  const headers = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // 语言档位转查询参数（与适配器 buildTranscriptionUrl 同规则）：
  // zh → ?language=zh，en → ?language=english，auto 省略
  const lang = String(language || "").trim().toLowerCase();
  const query = lang === "zh" || lang === "en"
    ? `?language=${lang === "zh" ? "zh" : "english"}`
    : "";

  const form = new FormData();
  form.append("file", new Blob([wavBytes], { type: "audio/wav" }), "probe.wav");
  form.append("model", model);
  form.append("response_format", "verbose_json");
  // 不把 language 放 multipart 字段（SiliconFlow 只认查询参数）
  // 千万不要手动设 Content-Type，浏览器自动带 boundary

  // 传输层可注入（测试用 fake transport）；默认在调用时取全局 fetch。
  const doFetch = transport || ((...args) => fetch(...args));

  let response;
  try {
    response = await doFetch(`${normalizedBaseUrl}/audio/transcriptions${query}`, {
      method: "POST",
      headers,
      body: form
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
