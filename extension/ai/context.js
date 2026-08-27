// 把 content.js 传来的 context 拼成 chat messages，并提供建议 chip 模板。

export function buildMessages({ context, userPrompt, history, systemPrompt }) {
  const ctx = context || {};
  const sections = [
    `你是一个 B 站视频助手。当前用户正在看一个视频，标题：「${ctx.title || "未知"}」`,
    `作者：${ctx.author || "未知"} | 上传日期：${ctx.uploadDate || "未知"}`
  ];

  if (ctx.subtitleMarkdown) {
    sections.push(`以下是视频的字幕全文：\n\n${ctx.subtitleMarkdown}`);
  } else {
    sections.push("（暂无字幕）");
  }

  if (Array.isArray(ctx.hotComments) && ctx.hotComments.length) {
    const commentBlock = ctx.hotComments
      .map(function (c, i) { return `${i + 1}. ${c.uname || "匿名"}（赞 ${c.like || 0}）: ${c.message || ""}`; })
      .join("\n");
    sections.push(`以下是按热度排序的前 ${ctx.hotComments.length} 条热门评论：\n\n${commentBlock}`);
  }

  const customSystemPrompt = String(systemPrompt || "").trim();
  if (customSystemPrompt) {
    sections.push("以下是额外系统要求：\n" + customSystemPrompt);
  }

  let historyMessages = [];
  if (Array.isArray(history)) {
    historyMessages = history.filter(function (m) {
      return m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string";
    });
  }

  const messages = [
    { role: "system", content: sections.join("\n\n") },
    ...historyMessages,
    { role: "user", content: String(userPrompt || "") }
  ];
  return messages;
}

export function clipSubtitleForContext(markdown, maxChars = 50000) {
  const text = String(markdown || "");
  if (!text || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n...（字幕过长，已截断）";
}

export function buildSuggestedPrompts(context) {
  const prompts = [
    "用 3 句话总结这个视频",
    "提炼这个视频的 5 个重点",
    "按时间顺序整理这期视频的内容"
  ];
  if (context && Array.isArray(context.hotComments) && context.hotComments.length) {
    prompts.push("根据评论总结观众的看法");
  } else {
    prompts.push("把这期视频适合发朋友圈的观点摘出来");
  }
  return prompts;
}
