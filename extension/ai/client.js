// 编排：拼请求 → fetch → 解析 SSE → 通过 port 把 token 回吐给 side panel。

import { OPENAI_COMPAT } from "./providers.js";
import { parseOpenAISSE } from "./stream.js";
import { buildMessages, clipSubtitleForContext } from "./context.js";

export async function streamChat({ provider, context, userPrompt, port }) {
  if (!port) return;

  const baseUrl = String(provider?.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    port.postMessage({ type: "error", error: "baseUrl 未配置" });
    return;
  }
  if (!provider.model) {
    port.postMessage({ type: "error", error: "模型未配置" });
    return;
  }

  const messages = buildMessages({
    context: { ...context, subtitleMarkdown: clipSubtitleForContext(context?.subtitleMarkdown) },
    userPrompt
  });

  const headers = { "Content-Type": "application/json" };
  if (provider.apiKey) {
    headers["Authorization"] = `Bearer ${provider.apiKey}`;
  }

  let response;
  try {
    response = await fetch(`${baseUrl}${OPENAI_COMPAT.chatPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: provider.model,
        messages,
        stream: true
      })
    });
  } catch (e) {
    port.postMessage({ type: "error", error: `网络错误：${e?.message || e}` });
    return;
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {}
    port.postMessage({ type: "error", error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` });
    return;
  }

  try {
    for await (const token of parseOpenAISSE(response)) {
      port.postMessage({ type: "token", data: token });
    }
    port.postMessage({ type: "done" });
  } catch (e) {
    port.postMessage({ type: "error", error: String(e?.message ?? e) });
  }
}

// 测试连接：拉一次 /models，验证 baseUrl + key。
export async function testConnection({ baseUrl, apiKey }) {
  const url = `${String(baseUrl || "").trim().replace(/\/+$/, "")}${OPENAI_COMPAT.listModels}`;
  const headers = { Accept: "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  let response;
  try {
    response = await fetch(url, { method: "GET", headers, cache: "no-store" });
  } catch (e) {
    return { ok: false, error: `无法连接：${e?.message || e}` };
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {}
    return { ok: false, error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
  }
  let models = [];
  try {
    const data = await response.json();
    if (Array.isArray(data?.data)) {
      models = data.data.map((m) => m?.id).filter(Boolean);
    }
  } catch {
    // /models 返回非 JSON 也算通：只验证了连通性
  }
  return { ok: true, models };
}