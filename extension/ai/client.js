// 编排：拼请求 → fetch → 解析 SSE → 通过 port 把 token / reasoning 回吐给 side panel。

import { buildMessages, clipSubtitleForContext } from "./context.js";
import { buildBudgetPlan, estimateTokens, MATERIAL_BUDGET_CHARS } from "./budgeter.js";
import { parseSsePayload } from "./sse-parser.js";

// OpenAI 兼容协议常量。
// 覆盖 OpenAI / DeepSeek / Qwen / Zhipu / Kimi / MiniMax / Mimo / Opencode Go / OpenRouter / Stepfun / Ollama（OpenAI 兼容模式）等。
// （原 extension/ai/providers.js 唯一的导出，浅模块合并后内联于此。）
const OPENAI_COMPAT = {
  listModels: "/models",
  chatPath: "/chat/completions"
};

const MAX_STREAM_RETRIES = 2;

// 思考档位：off 不发任何参数；low / high 映射到 OpenAI 兼容的 reasoning_effort。
export const AI_THINKING_LEVELS = ["off", "low", "high"];

export function normalizeThinkingLevel(value) {
  return AI_THINKING_LEVELS.includes(value) ? value : "off";
}

/**
 * 构造 chat/completions 请求体（纯函数，便于单测）。
 */
export function buildChatRequestBody({ model, messages, thinkingLevel }) {
  const body = { model, messages, stream: true };
  const level = normalizeThinkingLevel(thinkingLevel);
  if (level !== "off") {
    body.reasoning_effort = level;
  }
  return body;
}

// 超预算回落时的提示文案：仅提示不报错，超预算/溢出标记供 03 接管。
export const OVER_BUDGET_NOTICE = "超长视频整理即将支持";

/**
 * 判定一段错误文案是否属于 context-length 溢出（纯函数，供单测与 03 兜底复用）。
 * 粗判：命中常见溢出子串，或「长度/上下文/令牌」语义 + 「超限」语义同时出现。
 * 非溢出错误（401/404/500/网络错误/限流等）返回 false，仍走既有重试/报错路径。
 */
export function isContextLengthOverflow(detailOrError) {
  const text = String(detailOrError ?? "").toLowerCase();
  if (!text) return false;

  const directPatterns = [
    "context_length",
    "context length",
    "maximum context length",
    "max context length",
    "context window",
    "too many tokens",
    "too long",
    "too large",
    "max_tokens",
    "max tokens",
    "token limit",
    "最大上下文",
    "上下文长度",
    "上下文超出",
    "超出上下文",
    "超出长度",
    "超过上下文",
    "令牌超限",
    "token超限",
    "超出上限"
  ];

  for (const pattern of directPatterns) {
    if (text.includes(pattern)) return true;
  }

  const subjectPattern = /(context|tokens?|length|上下文|长度|令牌|窗口)/;
  const overflowPattern = /(exceed|limit|maximum|too many|too long|overflow|超出|超过|超限|上限|最大)/;
  return subjectPattern.test(text) && overflowPattern.test(text);
}

/**
 * 决定给模型的字幕：素材预算内（≤100k token）整篇原样；超预算回落 50k 硬截断并打标记。
 * 纯函数，streamChat 只负责消费返回的 { markdown, mode, notice, overflowMarked }。
 * body 缺失/空时退化为对 subtitleMarkdown 的 estimateTokens 判定。
 */
export function resolveSubtitleForContext(context) {
  const ctx = context || {};
  const body = Array.isArray(ctx.subtitleBody) ? ctx.subtitleBody : [];
  const markdown = String(ctx.subtitleMarkdown || "");

  let mode;
  if (body.length > 0) {
    mode = buildBudgetPlan({ body, chapters: ctx.chapters }).mode;
  } else {
    mode = estimateTokens(markdown) > MATERIAL_BUDGET_CHARS ? "map-reduce" : "single";
  }

  if (mode === "single") {
    return { markdown, mode, notice: "", overflowMarked: false };
  }

  return {
    markdown: clipSubtitleForContext(markdown),
    mode,
    notice: OVER_BUDGET_NOTICE,
    overflowMarked: true
  };
}

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

      const events = parseSsePayload(data);
      for (let i = 0; i < events.length; i++) {
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

export async function streamChat({ provider, context, userPrompt, history, port, signal, onActivity, thinkingLevel }) {
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

  const subtitleResolution = resolveSubtitleForContext(context);
  if (subtitleResolution.notice) {
    port.postMessage({ type: "notice", data: subtitleResolution.notice });
  }
  if (subtitleResolution.overflowMarked) {
    // 超预算：仍先提示，再以 "overflow" 哨兵返回供 03 兜底转 Map-Reduce。
    return "overflow";
  }

  const messages = buildMessages({
    context: { ...context, subtitleMarkdown: subtitleResolution.markdown },
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
        body: JSON.stringify(buildChatRequestBody({
          model: provider.model,
          messages,
          thinkingLevel
        })),
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
      if (isContextLengthOverflow(detail)) {
        // context-length 溢出：以 "overflow" 哨兵返回供 03 兜底转 Map-Reduce，不走普通重试/报错路径。
        return "overflow";
      }
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
      return "done";
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

