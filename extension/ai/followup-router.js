// 「追问路由」模块：把 05（追问上下文压缩）与 06（原始字幕段按需检索）接入
// offscreen 的 Map-Reduce 分派链——超预算视频总结完成后继续追问时，不再重跑
// Map-Reduce，改走「压缩摘要（从段缓存加载的分段小结 + 上一轮成稿笔记）+
// 命中时间戳/章节/关键词注入的原始段」+ 单次调用，token 随追问近乎常数。
// 首轮 / 尚未成稿（无笔记或无分段小结）→ 返回 null，交给上层跑完整 Map-Reduce。
// 纯逻辑 + 注入的 loader，无 DOM/chrome 直接依赖（默认 loader 走 segment-cache）。
import { hasFinalNote, buildFollowupSubtitleMarkdown } from "./followup-context.js";
import { retrieveRawSegments } from "./raw-retrieval.js";
import { formatSegmentItem } from "./map-reduce.js";
import {
  getSegmentSummaryKey,
  loadSegmentSummary as loadSegmentSummaryFromCache
} from "./segment-cache.js";

// 组装某段小结/原始段的缓存键（与 map-reduce.js 使用同一套键位）。
function buildCacheKey({ context, keyBuilder, segment }) {
  return keyBuilder({
    bvid: context?.bvid,
    cid: context?.cid,
    subtitleId: context?.selectedSubtitleId,
    subtitleUrl: context?.selectedSubtitleUrl,
    lang: context?.subtitleLang,
    segmentIndex: segment?.index
  });
}

/**
 * 从段缓存按段顺序加载全部分段小结（跳过 null/空，保持段序）。
 * loader 可注入以便单测；缺省用 segment-cache 的真实加载器。
 */
export async function loadSegmentSummaries({ context = {}, plan = null, loadSummary = loadSegmentSummaryFromCache } = {}) {
  const segments = Array.isArray(plan?.segments) ? plan.segments : [];
  const out = [];
  for (const segment of segments) {
    const key = buildCacheKey({ context, keyBuilder: getSegmentSummaryKey, segment });
    const summary = await loadSummary(key);
    if (typeof summary === "string" && summary.trim().length > 0) {
      out.push(summary);
    }
  }
  return out;
}

// 单条命中的原始段渲染成注入文本块：逐条字幕项按 [起点-终点] 内容 拼行。
export function renderRawSegment(segment) {
  const items = Array.isArray(segment?.items) ? segment.items : [];
  return items
    .map((item) => formatSegmentItem(item))
    .filter((line) => line.length > 0)
    .join("\n");
}

// 构造一个「按需检索」函数：基于 plan.segments（已在内存的原始字幕段，与 04 缓存的段同构），
// 每次调用 06 的 retrieveRawSegments 命中后，把命中段渲染成文本块数组返回（同步，供 05 注入）。
export function buildRetrieveRaw({ context = {}, plan = null } = {}) {
  const rawSegments = (Array.isArray(plan?.segments) ? plan.segments : []).map((seg) => ({
    index: seg.index,
    from: seg.from,
    to: seg.to,
    items: Array.isArray(seg.items) ? seg.items : []
  }));

  return function retrieveRaw(prompt) {
    const hits = retrieveRawSegments({
      prompt,
      chapters: Array.isArray(context?.chapters) ? context.chapters : [],
      rawSegments
    });
    return hits.map((seg) => renderRawSegment(seg)).filter((text) => text.length > 0);
  };
}

// 取最近一条 assistant 消息正文（作为「成稿笔记」候选）；无则返回空串。
export function lastAssistantContent(history = []) {
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i];
    if (message && message.role === "assistant" && typeof message.content === "string" && message.content.trim()) {
      return message.content;
    }
  }
  return "";
}

/**
 * 解析追问上下文：超预算视频 + 已有历史 + 已能拼出「成稿笔记 + 分段小结」时，
 * 返回供 streamChat 复用的压缩上下文（subtitleMarkdown 换成压缩摘要，subtitleBody 置空）；
 * 其余情况（≤100k / 首轮 / 尚未成稿）返回 null，表示走完整 Map-Reduce。
 */
export async function resolveFollowupContext({
  context = {},
  plan = null,
  history = [],
  userPrompt = "",
  loadSummaries = loadSegmentSummaries
} = {}) {
  if (plan?.mode !== "map-reduce") {
    return null;
  }
  if (!Array.isArray(history) || history.length === 0) {
    return null;
  }

  const note = lastAssistantContent(history);
  if (!note) {
    return null;
  }

  const segmentSummaries = await loadSummaries({ context, plan });
  if (!hasFinalNote({ note, segmentSummaries })) {
    return null;
  }

  const subtitleMarkdown = buildFollowupSubtitleMarkdown({
    contextData: context,
    note,
    segmentSummaries,
    userPrompt,
    retrieveRaw: buildRetrieveRaw({ context, plan })
  });

  return { ...context, subtitleMarkdown, subtitleBody: [] };
}
