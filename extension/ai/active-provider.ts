// extension/ai/active-provider.ts
// 「当前选中的 AI 平台 + 其 API Key」的 content 侧解析（概览生成 / 选区解释共用）。
//
// 消息链与 offscreen 的 resolveProviderWithKey 同款（get-settings 取默认平台 id →
// ai-providers-list 取启用平台列表 → get-ai-provider-key 取密钥），差别只在
// content 侧没有 port 可回吐：失败一律以异常上翻，由调用方的状态机落 error 态。
//
// 为什么单独成文件：概览（reader/overview.js）与选区解释（reader/explain-card.js）
// 都要「拿一个能直接发请求的 provider」，此前只有概览一份，解释再写一遍就是第三份
// 复制（offscreen 那份因回吐协议不同不合并）。

import { sendRuntimeMessage } from "../shared/messaging.js";
import type { AiProvider } from "./types.js";

export const NO_ACTIVE_PROVIDER_MESSAGE = "还没有配置 AI 平台，请先在插件设置中添加并启用。";

/**
 * 解析当前应使用的 AI 平台（含 apiKey/baseUrl/model）。
 * 优先设置里的 defaultModel，取不到则退到第一个启用平台；无平台或读 Key 失败抛错。
 */
export async function resolveActiveProvider(): Promise<AiProvider> {
  const settingsResp = (await sendRuntimeMessage({ type: "get-settings" }).catch(() => null)) as
    | { ok?: boolean; settings?: { defaultModel?: unknown } }
    | null;
  const preferredId = String(settingsResp?.settings?.defaultModel || "").trim();

  const listResp = (await sendRuntimeMessage({ type: "ai-providers-list" }).catch(() => null)) as
    | { providers?: Array<{ id?: unknown; enabled?: unknown; baseUrl?: unknown; model?: unknown }> }
    | null;
  const enabled = (listResp?.providers || []).filter(
    (item) => item && item.enabled !== false && String(item?.id || "").trim()
  );
  const provider = enabled.find((item) => String(item.id) === preferredId) || enabled[0] || null;
  if (!provider) {
    throw new Error(NO_ACTIVE_PROVIDER_MESSAGE);
  }

  const keyResp = (await sendRuntimeMessage({
    type: "get-ai-provider-key",
    providerId: String(provider.id)
  }).catch(() => null)) as { ok?: boolean; apiKey?: string; error?: string } | null;
  if (!keyResp?.ok) {
    throw new Error(String(keyResp?.error || "读取 API Key 失败"));
  }

  return {
    baseUrl: String(provider.baseUrl || "").trim(),
    apiKey: String(keyResp.apiKey || "").trim(),
    model: String(provider.model || "").trim()
  };
}
