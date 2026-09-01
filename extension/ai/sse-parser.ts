// 纯函数 SSE payload 解析器。
// 输入：SSE data: 行去掉前缀后的文本（可能为空或 "[DONE]"）。
// 输出：{ type: "reasoning" | "content", data: string }[]。
// 不依赖任何 Chrome API、port、signal 或 fetch，可同时在 ES module 与 classic script 中使用。

import type { SseEvent } from "./types.js";

export function parseSsePayload(text: unknown): SseEvent[] {
  const trimmed = String(text || "").trim();
  if (!trimmed || trimmed === "[DONE]") {
    return [];
  }

  try {
    const json = JSON.parse(trimmed) as {
      choices?: Array<{ delta?: { reasoning_content?: unknown; content?: unknown } }>;
    };
    const delta = json?.choices?.[0]?.delta || {};
    const events: SseEvent[] = [];

    if (delta.reasoning_content) {
      events.push({ type: "reasoning", data: String(delta.reasoning_content) });
    }
    if (delta.content) {
      events.push({ type: "content", data: String(delta.content) });
    }
    return events;
  } catch {
    return [];
  }
}
