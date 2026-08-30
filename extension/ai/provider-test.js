// extension/ai/provider-test.js
// AI 平台连通性测试探针（候选 04 拆链）。
// 从 core/ai-provider-store.js 移出：探针依赖 ai/completion.js（→ sse-parser.js），
// 留在 ai-provider-store 里会把整条 completion 链拖进 Service Worker 静态图，
// 而 SW 并不需要它（ADR-0003：平台禁止动态 import()，只能拆静态边）。
// 连通性测试真正需要的上下文是「扩展页面」：options 页直接 import 本模块调用，
// host_permissions 对扩展页面同样生效，跨域 fetch 无需经过 SW 消息往返。
//
// 职责边界：本模块只负责探针的输入预检、Key 代查与错误形状包装；Provider
// 列表 CRUD/归一化仍归 core/ai-provider-store.js（SW 出于消息路由仍要加载它，
// 但不再经它拖入 completion 链）。本模块只在 options 页 context 加载，不进 SW 图。

import { chatCompletion } from "./completion.js";
import { formatProbeConnectionError } from "../core/provider-store.js";
import { aiProviderStore } from "../core/ai-provider-store.js";

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

// options 页「测试」按钮的入口：平铺字段 + providerId，替代原 ai-providers-test
// 消息在 SW 侧的输入装配（provider-handlers.js pickFlatTestProvider 的契约）——
// Key 解析优先用户重输的 apiKey，否则按 providerId 从已存 Key 代查，都没有为空串。
// 返回 { ok, error? }，UX 语义与原消息往返完全一致。
export async function testAiProviderConnection({ providerId, baseUrl, apiKey, model }) {
  let resolvedApiKey = String(apiKey || "").trim();
  if (!resolvedApiKey && providerId) {
    try {
      const keys = await aiProviderStore.loadKeys();
      resolvedApiKey = String(keys[providerId] || "").trim();
    } catch (error) {
      // Key 存储读取失败沿用原处理器的容错：按空 Key 继续探针（报错来自探针本身）
      console.warn("读取已存 API Key 失败，按未填写 Key 继续", error);
    }
  }
  return testAiConnection({ baseUrl, apiKey: resolvedApiKey, model });
}
