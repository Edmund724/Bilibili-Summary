// extension/core/ai-provider-store.js
// AI 平台 Provider/Key 的存储 + 连接测试/模型探测。
// 从 extension/entry/background.js 提取的深模块：只与 chrome.storage / fetch 交互，
// 不涉及消息路由。所有函数返回 Promise，由 background.js 的消息处理函数调用。
// 全局设置（reader/AI/ASR/下载域）的归一化与读写已拆到 settings-store.js，
// 本模块只负责 AI 平台列表 CRUD 与探针。

import { createProviderStore, formatProbeConnectionError } from "./provider-store.js";
import { chatCompletion } from "../ai/completion.js";

// ===== AI 模型平台存储 =====
// 列表 CRUD（load/save/delete/Key 读写）委托给通用工厂 createProviderStore，
// 本模块只提供 storage key 与 AI 专属的 normalizeProvider。不变式
// “apiKey 永不进同步列表”由工厂统一保证。直接导出绑定好的 store 实例，
// 消费方（background 消息路由）调用实例方法。

const AI_PROVIDER_KEYS_STORAGE = "aiProviderKeys";

function normalizeAiProvider(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || "").trim();
  if (!id) return null;
  return {
    id,
    presetId: String(item.presetId || "custom"),
    name: String(item.name || "自定义").trim() || "自定义",
    baseUrl: String(item.baseUrl || "").trim().replace(/\/+$/, ""),
    model: String(item.model || "").trim(),
    requiresKey: item.requiresKey !== false,
    enabled: item.enabled !== false
  };
}

export const aiProviderStore = createProviderStore({
  listStorageKey: "aiProviders",
  keysStorageKey: AI_PROVIDER_KEYS_STORAGE,
  normalizeProvider: normalizeAiProvider
});

// ===== 连接测试 / 模型探测 =====
// 探针经 ai/completion.js 的 probe 模式发请求（max_tokens:1 + messages ping，
// 成功判定 = response.ok 且不读响应体），本模块只负责输入预检与错误形状包装：
// 接缝抛错（类型化标记）转 { ok: false, error }，文案复用共享 helper 逐字对齐旧实现。

// 把接缝抛出的类型化错误转成探针错误文案：
// - HTTP 失败（err.status / err.overflow）：接缝 message 与 formatProbeHttpError 同型，直接透传；
// - 连接失败（原始抛出物挂 err.cause）：复用「无法连接：…」文案（AI/ASR 逐字一致）；
// - 其余（接缝 baseUrl/model 守卫等）：message 已是清晰文案，直接透传。
function formatProbeSeamError(error) {
  if (error?.status != null || error?.overflow) {
    return error.message;
  }
  if (error?.cause) {
    return formatProbeConnectionError(error.cause);
  }
  return error.message;
}

export async function testAiConnection({ baseUrl, apiKey, model }) {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  const normalizedModel = String(model || "").trim();
  if (!normalizedBaseUrl) {
    return { ok: false, error: "请填写 baseUrl" };
  }
  if (!normalizedModel) {
    return { ok: false, error: "请填写模型名" };
  }

  return probeAiChatCompletion({
    baseUrl: normalizedBaseUrl,
    apiKey,
    model: normalizedModel,
    headers: { Accept: "application/json" }
  });
}

export async function probeAiChatCompletion({ baseUrl, apiKey, model, headers }) {
  const requestHeaders = { ...(headers || { Accept: "application/json" }) };
  if (apiKey && !requestHeaders.Authorization) {
    requestHeaders.Authorization = `Bearer ${apiKey}`;
  }

  try {
    await chatCompletion({
      provider: { baseUrl, apiKey, model },
      messages: [{ role: "user", content: "ping" }],
      probe: true,
      headers: requestHeaders,
      retries: 0
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatProbeSeamError(error) };
  }
}

export async function handleAiProvidersModels({ baseUrl, apiKey, providerId }) {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
  const headers = { Accept: "application/json" };
  let controller = null;
  let timer = null;

  const cleanup = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  try {
    if (!apiKey) {
      const keys = providerId ? await aiProviderStore.loadKeys() : {};
      apiKey = String(keys[providerId] || "").trim();
    }
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(`${normalizedBaseUrl}/v1/models`, {
      headers,
      method: "GET",
      signal: controller.signal
    });
    cleanup();
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    const data = await resp.json();
    const models = [];
    if (Array.isArray(data?.data)) {
      for (const item of data.data) {
        if (item?.id) models.push(String(item.id));
      }
    }
    return { ok: true, models };
  } catch (error) {
    cleanup();
    if (error?.name === "AbortError") {
      return { ok: false, error: "请求超时，请检查 baseUrl 或稍后重试" };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, error: "无法解析模型列表" };
    }
    return { ok: false, error: error?.message || String(error) };
  }
}
