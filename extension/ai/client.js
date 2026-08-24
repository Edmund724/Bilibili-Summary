// 编排：拼请求 → fetch → 解析 SSE → 通过 port 把 token / reasoning 回吐给 side panel。

import { OPENAI_COMPAT } from "./providers.js";
import { buildMessages, clipSubtitleForContext } from "./context.js";
import { parseSsePayload } from "./sse-parser.js";

const MAX_STREAM_RETRIES = 2;

/**
 * 发送单条 SSE 数据块。
 */
function postSseMessage(port, json) {
  const delta = json?.choices?.[0]?.delta || {};
  if (delta.reasoning_content) {
    port.postMessage({ type: "reasoning", data: String(delta.reasoning_content) });
  }
  if (delta.content) {
    port.postMessage({ type: "token", data: String(delta.content) });
  }
}

/**
 * 读取并解析单个 SSE 响应。
 */
async function drainSseStream({ response, port, signal, onActivity }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    if (signal?.aborted) {
      port.postMessage({ type: "stopped", reason: "已停止生成" });
      return "stopped";
    }

    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.length ? lines.pop() : "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      var events = parseSsePayload(data);
      for (var i = 0; i < events.length; i++) {
        onActivity?.();
        if (events[i].type === "reasoning") {
          port.postMessage({ type: "reasoning", data: events[i].data });
        } else {
          port.postMessage({ type: "token", data: events[i].data });
        }
      }
    }
  }
  return "done";
}

export async function streamChat({ provider, context, userPrompt, history, port, signal, onActivity }) {
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
    userPrompt,
    history,
    systemPrompt: context?.aiSystemPrompt
  });

  const headers = { "Content-Type": "application/json" };
  if (provider.apiKey) {
    headers["Authorization"] = `Bearer ${provider.apiKey}`;
  }

  for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
    if (attempt > 0) {
      port.postMessage({ type: "notice", data: `连接中断，正在重新连接（${attempt}/${MAX_STREAM_RETRIES}）...` });
      await new Promise(resolve => window.setTimeout(resolve, 800 * attempt));
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
        }),
        signal
      });
    } catch (e) {
      if (signal?.aborted) {
        port.postMessage({ type: "stopped", reason: "已停止生成" });
        return;
      }
      if (attempt >= MAX_STREAM_RETRIES) {
        port.postMessage({ type: "error", error: `网络错误：${e?.message || e}` });
        return;
      }
      continue;
    }

    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 200);
      } catch {}
      const errorMsg = `HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
      if (attempt >= MAX_STREAM_RETRIES) {
        port.postMessage({ type: "error", error: errorMsg });
        return;
      }
      port.postMessage({ type: "notice", data: `${errorMsg}，正在重试...` });
      continue;
    }

    try {
      const result = await drainSseStream({
        response,
        port,
        signal,
        onActivity
      });
      if (result === "stopped") return;
      port.postMessage({ type: "done" });
      return;
    } catch (e) {
      if (signal?.aborted) {
        port.postMessage({ type: "stopped", reason: "已停止生成" });
        return;
      }
      if (attempt >= MAX_STREAM_RETRIES) {
        port.postMessage({ type: "error", error: String(e?.message ?? e) });
        return;
      }
      // 否则继续重试
    }
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
