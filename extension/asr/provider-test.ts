// extension/asr/provider-test.ts
// ASR 平台连通性测试探针（候选 04 拆链）。
// 从 asr/asr-provider-store.js 移出：探针依赖 asr/wav-encode.js 与
// core/host-permissions.js，留在 asr-provider-store 里会把 wav-encode 链拖进
// Service Worker 静态图，而 SW 并不需要它（ADR-0003：平台禁止动态 import()，
// 只能拆静态边）。连通性测试真正需要的上下文是「扩展页面」：options 页直接
// import 本模块调用，host_permissions 对扩展页面同样生效，跨域 fetch 无需经过
// SW 消息往返。
//
// 职责边界：本模块只负责探针的输入预检、Key 代查与错误形状包装；Provider
// 列表 CRUD/归一化仍归 asr/asr-provider-store.js（SW 出于消息路由仍要加载它，
// 但不再经它拖入 wav-encode 链）。本模块只在 options 页 context 加载，不进 SW 图。

import { normalizeAsrProvider, normalizeBaseUrl, type AsrProvider } from "../core/presets.js";
import { HOST_PERMISSION_HINT, hasHostPermission } from "../core/host-permissions.js";
import { formatProbeConnectionError, formatProbeHttpError } from "../core/provider-store.js";
import { getMergedSettings } from "../core/settings-store.js";
import { encodeWavBytes } from "./wav-encode.js";
import { asrProviderStore } from "./asr-provider-store.js";

export interface AsrProbeOptions {
  transport?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface AsrProbeResult {
  ok: boolean;
  error?: string;
}

// ===== 静音 WAV 生成（探针用） =====

// 构造 durationSec 秒 sampleRate Hz 单声道 16bit PCM 静音 WAV（全零采样）。
// WAV header 复用 asr/wav-encode.js 的 encodeWavBytes：静音即全零 Float32 采样
// （量化后仍为 0x0000，data 段全零）。用于 openai-transcriptions 探针。
export function buildSilentWavBytes(durationSec = 1, sampleRate = 16000): Uint8Array {
  const sampleCount = Math.max(1, Math.floor(Number(durationSec) * sampleRate));
  return encodeWavBytes(new Float32Array(sampleCount), sampleRate);
}

// ===== 连通性探针 =====

// 按 provider.type 分发到对应探针。provider 可直接带 apiKey（前端测试按钮
// 用户重输的场景），也可不带（由 providerId 从已存 Key 读取）。
// 可选第二参 options.transport：注入传输函数（测试用 fake transport），
// 缺省在调用时取全局 fetch（而非模块加载时绑定）。
// 返回 { ok: boolean, error?: string }。
export async function testAsrConnection(
  provider: unknown,
  { transport }: AsrProbeOptions = {}
): Promise<AsrProbeResult> {
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
  let apiKey = String((provider as { apiKey?: string }).apiKey || "").trim();
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
      language = (settings?.asrLanguage as string) || "";
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

interface OpenAiTranscriptionsProbeParams {
  baseUrl: string;
  apiKey: string;
  model: string;
  language: string;
  transport?: AsrProbeOptions["transport"];
}

// openai-transcriptions 探针：构造 1 秒 16kHz 静音 WAV POST 到
// `${baseUrl}/audio/transcriptions`，HTTP 200 即通过。
// 适用于 SiliconFlow / 本地 Whisper / 自定义。
// 语言档位（provider.language）以查询参数附带：选 zh/en 时同时验证该语言的
// 请求链路（SiliconFlow 辰星只有 ?language=english 才启用英文识别，静音探针
// 的 200 即证明该参数被接受）。
async function probeOpenAiTranscriptions({
  baseUrl,
  apiKey,
  model,
  language,
  transport
}: OpenAiTranscriptionsProbeParams): Promise<AsrProbeResult> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return { ok: false, error: "请填写 baseUrl" };
  }
  if (!model) {
    return { ok: false, error: "请填写模型名" };
  }

  const wavBytes = buildSilentWavBytes(1, 16000);
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  // 语言档位转查询参数（与适配器 buildTranscriptionUrl 同规则）：
  // zh → ?language=zh，en → ?language=english，auto 省略
  const lang = String(language || "").trim().toLowerCase();
  const query = lang === "zh" || lang === "en"
    ? `?language=${lang === "zh" ? "zh" : "english"}`
    : "";

  const form = new FormData();
  form.append("file", new Blob([wavBytes as BlobPart], { type: "audio/wav" }), "probe.wav");
  form.append("model", model);
  form.append("response_format", "verbose_json");
  // 不把 language 放 multipart 字段（SiliconFlow 只认查询参数）
  // 千万不要手动设 Content-Type，浏览器自动带 boundary

  // 传输层可注入（测试用 fake transport）；默认在调用时取全局 fetch。
  const doFetch = transport || ((...args: [string, RequestInit]) => fetch(...args));

  let response: Response;
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
