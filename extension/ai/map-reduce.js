// 「Map-Reduce 编排」模块：超预算视频（>100k token）端到端出成稿。
// 阶梯：预算内单次（02 streamChat）；超出走本模块——按 01 的分段计划切段，
// 逐段（串行）生成分段小结，再一次性交给成稿调用输出正文（clamp ≤16k）。
// 模型调用统一经 ai/completion.js 接缝（非流式、默认无重试，保持现状）；
// context-length 溢出（err.overflow=true）触发编排级兜底：自动按 0.5 倍收紧
// 入口侧预算（单段输入 / 归并组输入）整轮重跑一次——预算假设（模型上下文窗口
// ≥ 预算常量）被打破时的自愈，仅一轮：仍溢出则带明确文案抛出。重跑独立于
// 池层重试（pool 对 overflow 不重试，避免同素材浪费重发）。
// 跑在 offscreen 文档，经 port 向侧边栏回吐进度 notice 与最终正文 token；
// 全程可中止（复用 AbortController）；04 缓存命中可跳过 map 调用。
// prompt 措辞对齐蓝本 .scratch/video-to-note/backend/llm_summarizer.py：
// 分段小结忠实压缩保留时间点与事实，成稿面向收藏/复习、不补外部知识。

import { formatCompactTimestamp } from "../shared/string-utils.js";
import { makeAbortedError } from "../shared/error-helpers.js";
import { buildBudgetPlan, FINAL_OUTPUT_CHARS, SEGMENT_SUMMARY_CHARS, SEGMENT_INPUT_CHARS, REDUCE_GROUP_INPUT_CHARS } from "./budgeter.js";
import { chatCompletion } from "./completion.js";
import { runMapBounded, DEFAULT_MAP_CONCURRENCY } from "./pool.js";
import { shouldReduce, reduceSummaries } from "./reduce.js";
import {
  buildRawSegmentCacheKey,
  buildSegmentSummaryCacheKey,
  loadSegmentSummary,
  saveSegmentSummary,
  saveRawSegments
} from "./segment-cache.js";

// 单条字幕项渲染上限（防御性截断，避免个别超长项撑爆小结请求）。
const MAX_ITEM_CHARS = 4000;

// 溢出放宽预算重跑：收紧比例与用户可见文案（重跑发起 / 重跑仍溢出）。
const OVERFLOW_RETRY_BUDGET_SCALE = 0.5;
const OVERFLOW_RETRY_NOTICE = "模型上下文不足，已自动调低单段素材量并重试";
const OVERFLOW_STILL_MESSAGE = "该视频素材在调低分段量后仍超出模型上下文，请更换上下文窗口更大的模型后重试";

/**
 * 进度文案纯函数：percent = round(index / total * 100)。
 */
export function buildProgressNotice(index, total) {
  const safeTotal = Math.max(1, Number(total) || 1);
  const safeIndex = Math.min(Math.max(1, Number(index) || 1), safeTotal);
  const percent = Math.round((safeIndex / safeTotal) * 100);
  return `正在整理第 ${safeIndex}/${safeTotal} 段（${percent}%）`;
}

/**
 * 把一条字幕项渲染成 `[起点-终点] 内容`（时间点格式对齐蓝本 segments_to_prompt）。
 */
export function formatSegmentItem(item) {
  const content = String(item && item.content != null ? item.content : "").trim();
  const from = Number(item && item.from) || 0;
  const to = Number(item && item.to) || from;
  const withHours = from >= 3600 || to >= 3600;
  return `[${formatCompactTimestamp(from, withHours)}-${formatCompactTimestamp(to, withHours)}] ${content}`;
}

/**
 * 分段小结 prompt（本域术语是「分段小结」/ segment；上游蓝本函数名叫 _chunk_prompt）：
 * 对齐蓝本 _chunk_prompt 措辞——视频标题 + 第 index/N 个连续片段 +
 * 忠实压缩（保留重要事实、例子、论证关系与原有时间点），不做评价、不补外部知识。
 */
function buildSegmentPrompt({ title, index, total, items }) {
  const segmentLines = (Array.isArray(items) ? items : []).map((item) => {
    const text = formatSegmentItem(item);
    return text.length > MAX_ITEM_CHARS ? text.slice(0, MAX_ITEM_CHARS) + "…" : text;
  });
  return `视频标题：${title}
这是第 ${index}/${total} 个连续片段。

请忠实压缩这个片段，供后续撰写完整笔记使用。保留重要事实、例子、论证关系和原有时间点；
结合上下文理解表达意图，不做评价，不补充外部知识。

字幕：
${segmentLines.join("\n")}`;
}

/**
 * 成稿 prompt：对齐蓝本 _note_prompt——产出面向收藏/复习的 Markdown 视频笔记，
 * 忠实复原脉络/观点/依据/时间点，不补外部知识，标题 `# 视频笔记：《{title}》`。
 * 材料中每条小结以 `### 片段 i` 标注。
 */
function buildNotePrompt({ title, material }) {
  return `写一份翔实、自然的 Markdown 视频笔记。完整复原内容脉络、具体例子、核心观点及其依据，
并在有帮助时加入关键时间点。不要加入外部知识或评价。

视频标题：${title}

以准确理解语境和作者立场为先。时间点只能取自材料。可在上下文支持时直接修正明显的口误、
笔误或转写错误。结构按内容自然组织，不必凑固定模板。标题使用：# 视频笔记：《${title}》

材料：
${material}`;
}

/**
 * 把所有分段小结汇总为一份成稿材料：每条前面 `### 片段 i` 标注。
 */
function buildMaterial(summaries) {
  const list = Array.isArray(summaries) ? summaries : [];
  return list
    .map((summary, i) => `### 片段 ${i + 1}\n${String(summary || "")}`)
    .join("\n\n");
}

/**
 * 单段小结：先查缓存命中直接复用（04 填空后生效），未命中则构造 prompt 调模型并落盘。
 * budgetScale：本轮预算档（默认 1）——小结缓存 key 按档隔离（防段边界漂移后命中
 * 错位小结）；原始段只按常态档（scale=1）落盘（供 followup 跨会话检索，检索侧
 * 永远按常态档切段，非常态档写入反而污染检索数据）。
 * 返回小结字符串；中止（signal.aborted）时抛出标记 aborted 的错误，由上层统一收束。
 * 落盘经段缓存的 LRU 淘汰写入；淘汰后重试仍失败时经 notifyCacheWriteError 上浮
 * （编排层保证整个运行期只提示一次），不再中断编排。
 */
async function summarizeSegment({
  provider,
  context,
  segment,
  total,
  signal,
  thinkingLevel,
  chatCompletionImpl,
  notifyCacheWriteError,
  budgetScale = 1
}) {
  const rawKey = buildRawSegmentCacheKey(context, segment.index, budgetScale);
  const summaryKey = buildSegmentSummaryCacheKey(context, segment.index, budgetScale);

  // 缓存命中直接复用，跳过 map 调用与无谓的原始段落盘（04 填空后生效）。
  const cached = await loadSegmentSummary(summaryKey);
  if (cached != null) {
    return cached;
  }

  // 原始字幕段落盘（04 实现落盘；06 按需检索时可跨会话复用；仅常态档）。
  // 淘汰后重试仍失败 → 上浮一次（编排层去重），不中断本段小结。
  if (budgetScale === 1) {
    const savedRaw = await saveRawSegments(rawKey, segment.items || []);
    if (savedRaw && savedRaw.ok === false && typeof notifyCacheWriteError === "function") {
      notifyCacheWriteError();
    }
  }

  if (signal?.aborted) {
    throw makeAbortedError();
  }

  const prompt = buildSegmentPrompt({
    title: context?.title || "未知",
    index: segment.index,
    total,
    items: segment.items || []
  });
  const summary = await chatCompletionImpl({
    provider,
    messages: [
      { role: "system", content: "你是视频笔记编辑。忠实理解语境与作者意图，允许结合上下文保守修正明显的口误、笔误和语音转写错误。" },
      { role: "user", content: prompt }
    ],
    thinkingLevel,
    signal
  });

  const trimmed = String(summary || "").trim();
  // 小结 ≤10k 保留（约 20%）；超出时尾部截断兜底（本票不做归并，靠此 clamp 保预算）
  const clamped = trimmed.length > SEGMENT_SUMMARY_CHARS ? trimmed.slice(0, SEGMENT_SUMMARY_CHARS) : trimmed;
  const savedSummary = await saveSegmentSummary(summaryKey, clamped);
  if (savedSummary && savedSummary.ok === false && typeof notifyCacheWriteError === "function") {
    notifyCacheWriteError();
  }
  return clamped;
}

/**
 * 编排主函数（签名固定，04/07/08 只换内部实现）：
 * 切片 → 逐段小结（串行 runMapBounded）→ 成稿（shouldReduce 为真先归并）→ 回吐正文。
 * 溢出兜底：任一阶段模型调用抛带 .overflow 标记的错误时，按 0.5 倍收紧入口侧预算
 * （单段输入 / 归并组输入）整轮重跑一次——重跑用新预算重切段，小结缓存 key 按档
 * 隔离（非常态档不会命中常态档的小结，段边界漂移不串内容）。重跑仍溢出则带明确
 * 文案抛出；中止（aborted）在任何阶段都收束为 stopped 回吐，不触发重跑。
 * 返回 { draft, segmentSummaries, aborted }；aborted 时已回吐内容不串数据、不再 post done。
 */
export async function orchestrateMapReduce({
  provider,
  context,
  plan,
  port,
  signal,
  thinkingLevel,
  onProgress,
  chatCompletion: chatCompletionImpl = chatCompletion
}) {
  const ctx = context || {};
  const post = (message) => {
    if (port && typeof port.postMessage === "function") {
      port.postMessage(message);
    }
  };

  // 中止收束：回吐 stopped（对齐 streamChat 的停止 UX），不 post done，不抛错误；
  // 已完成的小结（部分结果）随 aborted 结果带出。
  const abortReturn = (segmentSummaries = []) => {
    post({ type: "stopped", reason: "已停止生成" });
    return { draft: "", segmentSummaries, aborted: true };
  };

  // 缓存写入最终失败（LRU 淘汰后重试仍失败）的 user-visible 上浮：复用 Map-Reduce
  // 协议既有的 notice 通道，整个运行期只提示一次（后续失败仅 logError，不打扰）。
  let cacheWriteNoticeShown = false;
  const notifyCacheWriteError = () => {
    if (cacheWriteNoticeShown) {
      return;
    }
    cacheWriteNoticeShown = true;
    post({ type: "notice", data: "本地字幕缓存写入失败（已自动清理旧视频缓存仍失败），本次结果可能无法跨会话复用。" });
  };

  /**
   * 单轮编排：按 budgetScale 切段 → 逐段小结 → 归并 → 成稿 → 回吐。
   * injectedPlan：首轮用调用方注入的 plan（ladder 按常态预算预生成，成本护栏
   * 文案与其一致）；重跑必须重算（预算已收紧，段边界与调用数都变了）。
   * abort 返回 { aborted: true }；溢出与其他错误 throw，由外层分流。
   */
  const runOnce = async ({ budgetScale, injectedPlan }) => {
    const resolvedPlan =
      injectedPlan ||
      buildBudgetPlan(
        {
          body: Array.isArray(ctx.subtitleBody) ? ctx.subtitleBody : [],
          chapters: Array.isArray(ctx.chapters) ? ctx.chapters : []
        },
        {
          segmentInputChars: Math.round(SEGMENT_INPUT_CHARS * budgetScale),
          reduceGroupInputChars: Math.round(REDUCE_GROUP_INPUT_CHARS * budgetScale)
        }
      );
    const segments = Array.isArray(resolvedPlan.segments) ? resolvedPlan.segments : [];
    const total = segments.length;

    // 按原始下标累积的小结（并发完成序可乱，写回位置不乱）；中止时随 aborted
    // 结果带出已完成的部分。
    const segmentSummaries = [];

    const emitProgress = (index) => {
      const notice = buildProgressNotice(index, total);
      if (typeof onProgress === "function") {
        onProgress(notice);
      } else {
        post({ type: "notice", data: notice });
      }
    };

    const worker = async (segment) => {
      const summary = await summarizeSegment({
        provider,
        context: ctx,
        segment,
        total,
        signal,
        thinkingLevel,
        chatCompletionImpl,
        notifyCacheWriteError,
        budgetScale
      });
      return { segment, summary };
    };

    let done;
    try {
      done = await runMapBounded({
        items: segments,
        worker,
        concurrency: DEFAULT_MAP_CONCURRENCY,
        signal,
        onItemDone: (result, index) => {
          segmentSummaries[index] = result?.summary || "";
          emitProgress(result?.segment?.index ?? index + 1);
        }
      });
    } catch (e) {
      if (e?.aborted || signal?.aborted) {
        return abortReturn(segmentSummaries);
      }
      throw e;
    }

    if (signal?.aborted) {
      return abortReturn(segmentSummaries);
    }

    // 成稿材料：所有小结汇总；shouldReduce 为真先走归并（07 填空后生效）。
    let materialSummaries = done.map((r) => r?.summary || "").filter((s) => s != null);
    if (shouldReduce(resolvedPlan) && materialSummaries.length > 1) {
      let merged;
      try {
        merged = await reduceSummaries({
          summaries: materialSummaries,
          title: ctx.title || "未知",
          groupInputChars: resolvedPlan.reduceGroupInputChars,
          runPrompts: async ({ prompt, messages }) => {
            const text = await chatCompletionImpl({
              provider,
              messages: messages || [
                { role: "system", content: "你是视频笔记编辑。" },
                { role: "user", content: prompt }
              ],
              thinkingLevel,
              signal
            });
            return String(text || "");
          },
          signal,
          onProgress: emitProgress
        });
      } catch (e) {
        // 归并阶段的中止同样收束为 stopped（此前该阶段 abort 会漏成 port error）。
        if (e?.aborted || signal?.aborted) {
          return abortReturn(segmentSummaries);
        }
        throw e;
      }
      materialSummaries = Array.isArray(merged?.merged) ? merged.merged : materialSummaries;
    }
    if (signal?.aborted) {
      return abortReturn(segmentSummaries);
    }

    const material = buildMaterial(materialSummaries);
    const notePrompt = buildNotePrompt({ title: ctx.title || "未知", material });

    let draft = "";
    try {
      draft = String(
        await chatCompletionImpl({
          provider,
          messages: [
            { role: "system", content: "你是视频笔记编辑。忠实理解语境与作者意图，允许结合上下文保守修正明显的口误、笔误和语音转写错误。" },
            { role: "user", content: notePrompt }
          ],
          thinkingLevel,
          signal
        }) || ""
      ).trim();
    } catch (e) {
      if (e?.aborted || signal?.aborted) {
        return abortReturn(segmentSummaries);
      }
      throw e;
    }

    if (signal?.aborted) {
      return abortReturn(segmentSummaries);
    }

    // 成稿 clamp 到 FINAL_OUTPUT_CHARS（16000）以内
    if (draft.length > FINAL_OUTPUT_CHARS) {
      draft = draft.slice(0, FINAL_OUTPUT_CHARS);
    }

    post({ type: "token", data: draft });
    post({ type: "done" });
    return { draft, segmentSummaries, aborted: false };
  };

  try {
    return await runOnce({ budgetScale: 1, injectedPlan: plan });
  } catch (e) {
    if (e?.aborted || signal?.aborted) {
      return abortReturn();
    }
    if (!e?.overflow) {
      throw e;
    }
    // 溢出兜底：放宽预算（收紧单段/归并组输入至 0.5 倍）整轮重跑一次。
    post({ type: "notice", data: OVERFLOW_RETRY_NOTICE });
    try {
      return await runOnce({ budgetScale: OVERFLOW_RETRY_BUDGET_SCALE });
    } catch (e2) {
      if (e2?.aborted || signal?.aborted) {
        return abortReturn();
      }
      if (e2?.overflow) {
        throw new Error(OVERFLOW_STILL_MESSAGE);
      }
      throw e2;
    }
  }
}
