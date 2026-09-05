// extension/ai/provider-models.ts
// AI 平台模型列表探测（arch-slim-2/09 自 core/ai-provider-store.ts 搬入 ai/：
// fetch 探针是 ai 域知识，与「纯存储」头注的 ai-provider-store 分家；搬法对齐
// 探针已住 ai/ 的先例 ai/provider-test.ts）。经 SW 消息（ai-providers-models）
// 从 options 页模型下拉调用：直连 `${baseUrl}/v1/models`（纯 GET fetch，不依赖
// completion 链）。
//
// background 的 ai-providers-models 路由（entry/background.ts）经本模块处理；
// aiProviderStore 仍住 core/（SW 消息路由的纯存储层），本模块只引用其 loadKeys。

import { aiProviderStore } from "../core/ai-provider-store.js";
import { HOST_PERMISSION_HINT, hasHostPermission } from "../core/host-permissions.js";
import { withTimeout } from "../shared/error-helpers.js";

export interface AiProvidersModelsMessage {
  baseUrl?: string;
  apiKey?: string;
  providerId?: string;
}

export interface AiProvidersModelsResult {
  ok: boolean;
  models?: string[];
  error?: string;
}

export async function handleAiProvidersModels({
  baseUrl,
  apiKey,
  providerId
}: AiProvidersModelsMessage): Promise<AiProvidersModelsResult> {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
  // S2 收紧 host_permissions：平台域名未授权时这条 GET 只会以 CORS 失败，回包是
  // 「Failed to fetch」这种看不出原因的文案，因此先做权限预检，未授权直接回可操作
  // 提示（与 AI/ASR 连通性探针共用 core/host-permissions.js 的判定）。
  if (!(await hasHostPermission(normalizedBaseUrl))) {
    return { ok: false, error: HOST_PERMISSION_HINT };
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  // 超时原语单源（arch-slim-2/03）：原手写 AbortController + setTimeout 改走
  // withTimeout 硬超时（timeoutError 拒绝，文案逐字不变）。差异仅在于到点后
  // 底层 fetch 不再被 abort——竞速已出局、响应无人消费，用户可见行为不变。
  try {
    if (!apiKey) {
      const keys = providerId ? await aiProviderStore.loadKeys() : {};
      apiKey = String(keys[String(providerId || "")] || "").trim();
    }
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const resp = await withTimeout(
      fetch(`${normalizedBaseUrl}/v1/models`, { headers, method: "GET" }),
      15000,
      new Error("请求超时，请检查 baseUrl 或稍后重试")
    );
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    const data = (await resp.json()) as { data?: Array<{ id?: string }> };
    const models: string[] = [];
    if (Array.isArray(data?.data)) {
      for (const item of data.data) {
        if (item?.id) models.push(String(item.id));
      }
    }
    return { ok: true, models };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false, error: "无法解析模型列表" };
    }
    return { ok: false, error: (error as Error | undefined)?.message || String(error) };
  }
}
