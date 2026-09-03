// extension/asr/provider-models.ts
// ASR 平台模型列表拉取（options 页模型名下拉的数据源）。
// 与 asr/provider-test.js 同属「候选 04 拆链」后的 options 页直调模块：
// 扩展页面 context 下 host_permissions 生效，跨域 fetch 无需 SW 消息往返
// （对照：AI 侧模型列表仍走 ai-providers-models 消息，由 SW 里的
// core/ai-provider-store.js 直连）。本模块不进 SW 静态图。

import { normalizeBaseUrl } from "../core/presets.js";
import { HOST_PERMISSION_HINT, hasHostPermission } from "../core/host-permissions.js";
import { asrProviderStore } from "./asr-provider-store.js";

export interface ListAsrModelsInput {
  baseUrl?: string;
  apiKey?: string;
  providerId?: string;
}

export interface ListAsrModelsResult {
  ok: boolean;
  models?: string[];
  error?: string;
}

// GET `${baseUrl}/models?sub_type=speech-to-text`：sub_type 是 SiliconFlow 的
// 语音模型过滤参数，其他 OpenAI 兼容端点会忽略未知查询参数、回全量列表。
// Key 解析优先用户重输的 apiKey，否则按 providerId 读已存 Key（本地 Whisper
// 常无 Key，都没有就裸 GET）。
export async function listAsrModels({ baseUrl, apiKey, providerId }: ListAsrModelsInput): Promise<ListAsrModelsResult> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return { ok: false, error: "请先填写 baseUrl" };
  }
  // S2 收紧 host_permissions：平台域名未授权时这条 GET 只会以 CORS 失败，回包是
  // 「Failed to fetch」这种看不出原因的文案，因此先做权限预检，未授权直接回可操作
  // 提示（与 AI/ASR 连通性探针共用 core/host-permissions.js 的判定）。
  if (!(await hasHostPermission(normalizedBaseUrl))) {
    return { ok: false, error: HOST_PERMISSION_HINT };
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  let resolvedApiKey = String(apiKey || "").trim();
  if (!resolvedApiKey && providerId) {
    resolvedApiKey = await asrProviderStore.getKey(String(providerId));
  }
  if (resolvedApiKey) {
    headers.Authorization = `Bearer ${resolvedApiKey}`;
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => controller.abort(), 15000);
  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  try {
    const resp = await fetch(`${normalizedBaseUrl}/models?sub_type=speech-to-text`, {
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
