// 把 content.js 传来的 context 拼成 chat messages，并提供建议 chip 模板。

import { SEGMENT_INPUT_CHARS } from "./budgeter.js";
import { buildSubtitlePrompt } from "./subtitle-prompt.js";
import type { AiContext, ChatMessage, HotComment } from "./types.js";

interface BuildMessagesInput {
  context?: AiContext | null;
  userPrompt?: unknown;
  history?: unknown[];
  systemPrompt?: unknown;
}

export function buildMessages({ context, userPrompt, history, systemPrompt }: BuildMessagesInput = {}): ChatMessage[] {
  const ctx = context || {};
  const sections: string[] = [
    `你是一个 B 站视频助手。当前用户正在看一个视频，标题：「${ctx.title || "未知"}」`,
    `作者：${ctx.author || "未知"} | 上传日期：${ctx.uploadDate || "未知"}`
  ];

  // 字幕只以 subtitleBody（原始条目）入协议，发送物由此现场渲染，与预算判定同源。
  // includeTimestampInBody 由 payload 透传（context-resolver / content 侧设置），
  // 缺失时 buildSubtitlePrompt 默认 true（与历史默认一致）。
  const subtitleText = String(ctx.compressedSummaryMarkdown || "")
    || buildSubtitlePrompt({
      body: ctx.subtitleBody,
      chapters: ctx.chapters,
      videoDuration: ctx.videoDuration,
      includeTimestampInBody: ctx.includeTimestampInBody
    });
  if (subtitleText) {
    sections.push(`以下是视频的字幕全文：\n\n${subtitleText}`);
  } else {
    sections.push("（暂无字幕）");
  }

  if (Array.isArray(ctx.hotComments) && ctx.hotComments.length) {
    const commentBlock = ctx.hotComments
      .map(function (c: HotComment, i: number) { return `${i + 1}. ${c.uname || "匿名"}（赞 ${c.like || 0}）: ${c.message || ""}`; })
      .join("\n");
    sections.push(`以下是按热度排序的前 ${ctx.hotComments.length} 条热门评论：\n\n${commentBlock}`);
  }

  const customSystemPrompt = String(systemPrompt || "").trim();
  if (customSystemPrompt) {
    sections.push("以下是额外系统要求：\n" + customSystemPrompt);
  }

  let historyMessages: ChatMessage[] = [];
  if (Array.isArray(history)) {
    historyMessages = history.filter(function (m: unknown) {
      return m && ((m as { role?: unknown }).role === "user" || (m as { role?: unknown }).role === "assistant") && typeof (m as { content?: unknown }).content === "string";
    }) as ChatMessage[];
  }

  const messages: ChatMessage[] = [
    { role: "system", content: sections.join("\n\n") },
    ...historyMessages,
    { role: "user", content: String(userPrompt || "") }
  ];
  return messages;
}

// 截断上限即单段输入预算（budgeter 的 SEGMENT_INPUT_CHARS）：与 Map-Reduce 的
// 「单段原始字幕字符上限」是同一个概念，不再各写一份 50000。
export function clipSubtitleForContext(markdown: unknown, maxChars: number = SEGMENT_INPUT_CHARS): string {
  const text = String(markdown || "");
  if (!text || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n...（字幕过长，已截断）";
}
