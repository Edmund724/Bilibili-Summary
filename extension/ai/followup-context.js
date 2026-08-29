// 「追问上下文压缩」模块（05 票）：总结完成后继续追问时，不再每轮重发整篇原始字幕，
// 常驻上下文改为「压缩摘要（分段小结 + 成稿笔记）+ 近 N 轮 verbatim + 本轮问题」，
// 保证 token 随追问近乎常数。术语与上限对齐 CONTEXT.md 与 ADR-0001（追问压缩路径）；
// 原始字幕段按需检索注入由 06 负责，此处通过注入函数 retrieveRaw 解耦（缺省不注入）。
// 纯函数、无 side effect，不碰 chrome/DOM。

import { buildSubtitlePrompt } from "./subtitle-prompt.js";

// 近 N 轮 verbatim（N = 最近对话轮数）：由外部 buildMessages(history, userPrompt) 取近 N 轮
// 拼进消息历史，本模块只负责「字幕体」这一栏的取舍与压缩。
export const RECENT_TURNS_DEFAULT = 6;

// 检索注入（相关原始字幕段）总量上限：压缩摘要默认 ≤60k，注入 ≤30k，
// 合计 ≤90k < 素材预算 100k，保证追问仍走预算内单次、绝不溢出。
export const RAW_INJECTION_MAX_CHARS = 30000;

// 分段小结常驻的独立 token 上限：每条小结本身已由 03 按 ≤10k clamp，
// 此处对「汇总后的分段小结部分」再做独立截断（尾部）。40k ≈ 覆盖 ≥4 段小结的忠实汇总，
// 加上成稿 ≤16k 后整体仍在默认 maxChars=60k 之内——常驻上下文有界，不随原始字幕长度增长。
export const SEGMENT_SUMMARIES_MAX_CHARS = 40000;

// 整体压缩摘要默认上限（分段小结 + 成稿，字符≈token，对齐 ADR-0001 的 chars × 1.0）。
const COMPRESSED_SUMMARY_MAX_CHARS = 60000;
// 尾部截断标记：长度计入 maxChars，保证返回串严格 ≤ maxChars。
const TRUNCATION_MARKER = "\n…（压缩摘要过长，已截断尾部）";

// 保守地把 maxChars 规整为非负整数；非有限值（undefined/NaN 等）回落 0。
function normalizeMaxChars(maxChars) {
  const n = Number(maxChars);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// 尾部截断：超长时保留头部、在尾部补截断标记，返回串长度严格 ≤ maxChars。
function truncateTail(text, maxChars) {
  const value = String(text ?? "");
  const max = normalizeMaxChars(maxChars);
  if (value.length <= max) return value;
  if (max <= TRUNCATION_MARKER.length) return value.slice(0, max);
  return value.slice(0, max - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

// 是否已「成稿」：笔记正文 + 分段小结两者齐备才算；首轮 / 尚未成稿 → false。
export function hasFinalNote({ note, segmentSummaries } = {}) {
  const noteText = String(note || "").trim();
  const hasSummaries = Array.isArray(segmentSummaries) && segmentSummaries.length > 0;
  return noteText.length > 0 && hasSummaries;
}

// 近 N 轮 verbatim：只保留最近 turns 轮对话（每轮 = 一 user 一 assistant，共 2 条），
// 把历史封顶，保证追问 token 不随轮数无限增长（对齐 ADR「token 随追问近乎常数」）。
export function trimRecentTurns(history, turns = RECENT_TURNS_DEFAULT) {
  const list = Array.isArray(history) ? history : [];
  const safeTurns = Math.max(1, Math.floor(Number(turns) || RECENT_TURNS_DEFAULT));
  return list.slice(-(safeTurns * 2));
}

// 组装「压缩摘要」字符串：分段小结（每条 `### 片段 i` 小标题 + 正文，先受独立上限约束）
// + 成稿笔记；整体再受 maxChars 约束（截断尾部）。保留各小结与笔记原文（verbatim）。
export function buildCompressedSummary({
  segmentSummaries = [],
  note = "",
  maxChars = COMPRESSED_SUMMARY_MAX_CHARS
} = {}) {
  const summaries = Array.isArray(segmentSummaries) ? segmentSummaries : [];
  const noteText = note == null ? "" : String(note);

  let summariesSection = "";
  if (summaries.length > 0) {
    const lines = summaries.map((summary, i) => `### 片段 ${i + 1}\n${summary == null ? "" : String(summary)}`);
    summariesSection = "## 分段小结\n\n" + truncateTail(lines.join("\n\n"), SEGMENT_SUMMARIES_MAX_CHARS);
  }

  const sections = [];
  if (summariesSection.length > 0) sections.push(summariesSection);
  if (noteText.length > 0) sections.push("## 成稿笔记\n\n" + noteText);

  return truncateTail(sections.join("\n\n"), maxChars);
}

// 追问时的字幕体：已成稿 → 压缩摘要 [+ 检索注入的原始段尾缀]；
// 尚未成稿（首轮 / 无笔记）→ 由 buildSubtitlePrompt 从原始字幕体（subtitleBody +
// chapters + videoDuration）现场渲染全文（协议已不含预渲染的 subtitleMarkdown）。
// retrieveRaw 为 06 注入的 (userPrompt) => string[]，缺省 () => []，完全解耦。
export function buildFollowupSubtitleMarkdown({
  contextData = {},
  note = null,
  segmentSummaries = null,
  userPrompt = "",
  retrieveRaw = null
} = {}) {
  const ctx = contextData || {};
  const noteText = note == null ? "" : String(note);
  const summaries = Array.isArray(segmentSummaries) ? segmentSummaries : [];

  if (!hasFinalNote({ note: noteText, segmentSummaries: summaries })) {
    return buildSubtitlePrompt({
      body: ctx.subtitleBody,
      chapters: ctx.chapters,
      videoDuration: ctx.videoDuration,
      includeTimestampInBody: ctx.includeTimestampInBody
    });
  }

  const compressed = buildCompressedSummary({ segmentSummaries: summaries, note: noteText });

  const retrieveFn = typeof retrieveRaw === "function" ? retrieveRaw : () => [];
  const hits = (retrieveFn(userPrompt) || []).filter((text) => typeof text === "string" && text.length > 0);
  if (hits.length === 0) {
    return compressed;
  }
  let injection = hits.join("\n\n");
  // 注入原始段设上限，保证「压缩摘要 + 注入」合计仍在预算内（避免追问静默溢出/无输出）。
  if (injection.length > RAW_INJECTION_MAX_CHARS) {
    injection = injection.slice(0, RAW_INJECTION_MAX_CHARS);
  }
  return compressed + "\n\n## 相关原始字幕段\n\n" + injection;
}
