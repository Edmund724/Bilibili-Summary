// extension/ai/subtitle-prompt.js
// 「字幕 → 模型可读文本」的唯一渲染收口：消息协议只携带 subtitleBody（原始字幕
// 条目数组）+ chapters + videoDuration + includeTimestampInBody，markdown 一律在
// 发 prompt 前由本模块从 body 现场渲染，保证「预算按 body 判定、发送物由同一份
// body 渲染」同源一致（素材预算量与实际消耗不再脱节）。
//
// 两个入口：
// - buildAiConversationMarkdown(meta, body, settings)：笔记场景（原 context-resolver
//   的实现原样搬入，签名与行为不变）；
// - buildSubtitlePrompt({...})：发模型场景，输出与 buildAiConversationMarkdown 等价
//   的 markdown；body 为空时返回空串，由调用方决定占位文案（如「（暂无字幕）」）。

import { formatCompactTimestamp } from "../shared/string-utils.js";
import { buildSubtitleSectionLines, shouldShowHoursInNote } from "../notes/render.js";

// 笔记场景：按设置（章节占位/时间戳开关）把字幕体渲染成带章节分桶的 markdown。
export function buildAiConversationMarkdown(meta, body, settings) {
  const includeTimestampInBody = settings?.includeTimestampInBody !== false;
  const withHours = shouldShowHoursInNote(meta, body);
  const lines = [];
  const chapters = Array.isArray(meta?.chapters) ? meta.chapters : [];
  if (chapters.length) {
    lines.push("## 章节", "");
    chapters.forEach((item) => {
      const stamp = includeTimestampInBody ? `\`${formatCompactTimestamp(item.from, withHours)}\` ` : "";
      lines.push(`- ${stamp}${item.title}`);
    });
    lines.push("");
  }
  const subtitleLines = buildSubtitleSectionLines(body, chapters, { includeTimestampInBody }, withHours);
  // render 版兜底：无字幕时返回 ["（暂无字幕）"]，章节分桶全空时回退为整段字幕列表。
  if (subtitleLines.length > 0) {
    lines.push("## 字幕", "", ...subtitleLines);
  }
  return lines.join("\n");
}

/**
 * 发模型场景：从字幕体（而非渲染产物）渲染模型可读文本。
 * 输入与素材预算判定（buildBudgetPlan 的 body + chapters）同源；withHours 由
 * shouldShowHoursInNote 按 body/chapters/videoDuration 判定，与笔记渲染一致。
 * body 为空/缺失时返回空串（调用方按「暂无字幕」兜底），不虚构内容。
 */
export function buildSubtitlePrompt({ body, chapters, videoDuration, includeTimestampInBody } = {}) {
  const items = Array.isArray(body) ? body : [];
  if (items.length === 0) {
    return "";
  }
  return buildAiConversationMarkdown(
    { chapters, videoDuration },
    items,
    // 消息协议透传的布尔设置；缺失/非法时默认 true（与历史默认一致：字幕带时间戳）。
    { includeTimestampInBody: includeTimestampInBody !== false }
  );
}
