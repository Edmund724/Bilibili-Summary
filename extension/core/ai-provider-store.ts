// extension/core/ai-provider-store.ts
// AI 平台 Provider/Key 的存储（列表 CRUD + 归一化）。
// 从 extension/entry/background.js 提取的深模块：只与 chrome.storage 交互，
// 不涉及消息路由。所有函数返回 Promise，由 background.js 的消息处理函数调用。
// 全局设置（reader/AI/ASR/下载域）的归一化与读写已拆到 settings-store.js，
// 本模块只负责 AI 平台列表 CRUD。连通性测试/探针已移至 ai/provider-test.js
// （候选 04 拆链：探针依赖 ai/completion.js，留在本文件会把整条 completion 链
// 拖进 SW 静态图；options 页直调 provider-test，本模块回归纯存储）。

import { createProviderStore } from "./provider-store.js";
import { HOST_PERMISSION_HINT, hasHostPermission } from "./host-permissions.js";

export interface AiProvider {
  id: string;
  presetId: string;
  name: string;
  baseUrl: string;
  model: string;
  requiresKey: boolean;
  enabled: boolean;
  hasSavedKey?: boolean;
  apiKey?: string;
}

// ===== AI 模型平台存储 =====
// 列表 CRUD（load/save/delete/Key 读写）委托给通用工厂 createProviderStore，
// 本模块只提供 storage key 与 AI 专属的 normalizeProvider。不变式
// “apiKey 永不进同步列表”由工厂统一保证。直接导出绑定好的 store 实例，
// 消费方（background 消息路由）调用实例方法。

const AI_PROVIDER_KEYS_STORAGE = "aiProviderKeys";

function normalizeAiProvider(item: unknown): AiProvider | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Partial<AiProvider>;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  return {
    id,
    presetId: String(raw.presetId || "custom"),
    name: String(raw.name || "自定义").trim() || "自定义",
    baseUrl: String(raw.baseUrl || "").trim().replace(/\/+$/, ""),
    model: String(raw.model || "").trim(),
    requiresKey: raw.requiresKey !== false,
    enabled: raw.enabled !== false
  };
}

export const aiProviderStore = createProviderStore<AiProvider>({
  listStorageKey: "aiProviders",
  keysStorageKey: AI_PROVIDER_KEYS_STORAGE,
  normalizeProvider: normalizeAiProvider
});

// ===== 模型列表探测 =====
// 经 SW 消息（ai-providers-models）从 options 页模型下拉调用：直连
// `${baseUrl}/v1/models`（纯 GET fetch，不依赖 completion 链），故留在本模块。

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
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  try {
    if (!apiKey) {
      const keys = providerId ? await aiProviderStore.loadKeys() : {};
      apiKey = String(keys[String(providerId || "")] || "").trim();
    }
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    controller = new AbortController();
    timer = setTimeout(() => controller!.abort(), 15000);
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
    const data = (await resp.json()) as { data?: Array<{ id?: string }> };
    const models: string[] = [];
    if (Array.isArray(data?.data)) {
      for (const item of data.data) {
        if (item?.id) models.push(String(item.id));
      }
    }
    return { ok: true, models };
  } catch (error) {
    cleanup();
    if ((error as Error | undefined)?.name === "AbortError") {
      return { ok: false, error: "请求超时，请检查 baseUrl 或稍后重试" };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, error: "无法解析模型列表" };
    }
    return { ok: false, error: (error as Error | undefined)?.message || String(error) };
  }
}
