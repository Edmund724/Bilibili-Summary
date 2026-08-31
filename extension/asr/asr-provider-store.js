// extension/asr/asr-provider-store.js
// ASR（语音转写）平台 Provider/Key 的设置存储 + 连通性探针。
// 列表 CRUD 委托给 extension/core/provider-store.js 的 createProviderStore
// （与 AI 平台存储共用同一工厂）：provider 列表持久化在 chrome.storage.sync，
// API Key 单独存放在 chrome.storage.local，不随列表明文回传（列表只带
// hasSavedKey 布尔占位）。直接导出绑定好的 asrProviderStore 实例，消费方
// （background.js 消息路由、运行时配置处理器）调用实例方法。本模块只与
// chrome.storage / fetch 交互，不涉及消息路由。
//
// 与 AI 平台存储完全隔离：用不同的 storage key（asrProviders / asrProviderKeys），
// 不和对话平台混用同一个列表。

import { normalizeAsrProvider, normalizeBaseUrl } from "../core/presets.js";
import {
  HOST_PERMISSION_HINT,
  hasHostPermission
} from "../core/host-permissions.js";
import {
  createProviderStore,
  formatProbeConnectionError,
  formatProbeHttpError
} from "../core/provider-store.js";
import { getMergedSettings } from "../core/settings-store.js";
// 只 import WAV 编码微模块（探针只需要静音 WAV 字节），不引整个 chunker.js：
// 切片/解码校验那部分不需要进 SW 图（ADR-0003 拆静态边）。
import { encodeWavBytes } from "./wav-encode.js";

// ===== ASR 平台列表存储 =====

const ASR_PROVIDER_KEYS_STORAGE = "asrProviderKeys";
const ASR_PROVIDERS_STORAGE = "asrProviders";

export const asrProviderStore = createProviderStore({
  listStorageKey: ASR_PROVIDERS_STORAGE,
  keysStorageKey: ASR_PROVIDER_KEYS_STORAGE,
  normalizeProvider: normalizeAsrProvider
});

// ===== 静音 WAV 生成（探针用） =====

// 构造 1 秒 16kHz 单声道 16bit PCM 静音 WAV（全零采样）。
// WAV header 复用 asr/wav-encode.js 的 encodeWavBytes：静音即全零 Float32 采样
// （量化后仍为 0x0000，data 段全零）。用于 openai-transcriptions 探针。
// 1 秒 16k 单声道 16bit = 16000 采样 * 2 字节 = 32000 字节 PCM。
export function buildSilentWavBytes(durationSec = 1, sampleRate = 16000) {
  const sampleCount = Math.max(1, Math.floor(Number(durationSec) * sampleRate));
  return encodeWavBytes(new Float32Array(sampleCount), sampleRate);
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

  // S2 收紧 host_permissions：平台域名未授权时探针的跨域 fetch 只会以 CORS 失败
  // （「无法连接：Failed to fetch」看不出原因），先换成可操作提示。注入 transport
  // 的调用方（单测假传输）不经过真实网络，不受这道门禁。判定与 AI 探针共用
  // core/host-permissions.js 一份实现：取不到 chrome.permissions 时按已授权处理。
  if (!transport && !(await hasHostPermission(normalized.baseUrl))) {
    return { ok: false, error: HOST_PERMISSION_HINT };
  }

  // 解析 apiKey：优先 provider.apiKey，否则按 id 读已存 Key
  let apiKey = String(provider?.apiKey || "").trim();
  if (!apiKey && normalized.id) {
    apiKey = await asrProviderStore.getKey(normalized.id);
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
    return { ok: false, error: formatProbeConnectionError(error) };
  }

  if (response.ok) {
    return { ok: true };
  }

  return { ok: false, error: await formatProbeHttpError(response) };
}
