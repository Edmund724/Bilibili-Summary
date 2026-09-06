// 「概览数据管线」三片之编排（arch-slim-3 #11 自 ai/analysis.ts 切出）：双路径分派、
// 两级缓存接线、成本护栏与 inflightOverviews promise 复用（全仓唯一的 analysis 模块态）。
// 静态依赖两个纯片 analysis-validate / analysis-prompts；对外经 analysis.ts 壳再导出。

import { buildSubtitleSourceKey, buildSubtitleSignature, normalizeSubtitleItems } from "../subtitle/cache.js";
import { logError } from "../shared/logging.js";
import { makeAbortedError } from "../shared/error-helpers.js";
import { createCacheFamily } from "../core/cache-lru.js";
import { buildBudgetPlan as _buildBudgetPlan } from "./budgeter.js";
import { buildCostGuardNotice as _buildCostGuardNotice } from "./cost-guard.js";
import { chatCompletion as _chatCompletion } from "./completion.js";
import { parseLooseJson } from "./json-repair.js";
import { buildProgressNotice } from "./map-reduce.js";
import { runMapBounded, DEFAULT_MAP_CONCURRENCY } from "./pool.js";
import { budgetScaleSuffix, segmentCacheKeyFields } from "./segment-cache.js";
import {
  MAX_ANALYSIS_CHAPTERS,
  mergeAnalyses,
  validateAnalysis,
  type AnalysisChapter,
  type OverviewAnalysis,
} from "./analysis-validate.js";
import {
  ANALYSIS_SYSTEM_PROMPT,
  QUOTES_SYSTEM_PROMPT,
  buildAnalysisPrompt,
  buildQuotesPrompt,
  estimateOutputTokens,
  hotCommentsText,
  parseChapterOutline,
  tailItems,
  type BuiltAnalysisPrompt,
  type OutlineChapter,
} from "./analysis-prompts.js";
import type { BudgetPlan, BudgetPlanSegment, ChatMessage } from "./types.js";

// FNV-1a 32 位哈希与字幕签名族已迁 subtitle/cache.ts（arch-slim-3 #1，键族同居）；
// 本模块经上方 import 消费同一实现。

// 整份概览结果缓存键前缀（键形：前缀 + bvid + cid + 字幕轨 source key + 字幕签名）。
const ANALYSIS_FINAL_PREFIX = "boc_lvs_analysis_final_";
// 概览分段产物缓存键前缀（键形与 boc_lvs_summary_ 同族：…+ 段序号 [+ 预算代]）。
// 注意它是 ANALYSIS_FINAL_PREFIX 的父前缀——两族都已注册进 core/cache-lru.ts 的
// CACHE_FAMILIES（前缀撞车语义见该处注释），本模块不再自行扩展淘汰名单。
const ANALYSIS_SEGMENT_PREFIX = "boc_lvs_analysis_";
// 前情回顾字数：每段开头附带的上一段结尾字数（对齐参考仓库 ANALYSIS_OVERLAP_CHARS）。
const ANALYSIS_CONTEXT_CHARS = 400;

// 空正文重试的输出预算上限：思考型模型（如 step-3.7-flash）会无视关思考字段族
// 强制思考，思考把 max_tokens 耗尽（finish_reason=length）后 content 空串返回，
// parseLooseJson 只会抛出难懂的「Unexpected end of JSON input」。首次调用空正文
// 时按原估算加倍（封顶此处）重试一次，给思考之后的正文留出落出空间。
const EMPTY_TEXT_RETRY_MAX_TOKENS_CEILING = 16384;

// ============================================================
// 缓存（chrome.storage.local + 统一 LRU 淘汰；读取失败静默返回 null）
// ============================================================

// 两族缓存实例（arch-slim-2/08 缓存族参数化）：键拼装 / 静默读 / LRU 淘汰写 /
// 失败日志口径全部出自 core/cache-lru.ts 的 createCacheFamily，本模块只剩族参数。
// 两族已注册进 CACHE_FAMILIES（core/cache-lru.ts），不再在本模块自行扩展淘汰名单。
function isOverviewShape(value: unknown): value is OverviewAnalysis {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray((value as { chapters?: unknown }).chapters) &&
      Array.isArray((value as { quotes?: unknown }).quotes)
  );
}

const analysisFinalFamily = createCacheFamily<OverviewAnalysis>({
  prefix: ANALYSIS_FINAL_PREFIX,
  payloadField: "analysis",
  toSourceKey: buildSubtitleSourceKey,
  validate: isOverviewShape,
  logFailure: (info) => logError("[BOC] failed to save analysis cache after eviction", info)
});

const analysisSegmentFamily = createCacheFamily<OverviewAnalysis>({
  prefix: ANALYSIS_SEGMENT_PREFIX,
  payloadField: "analysis",
  toSourceKey: buildSubtitleSourceKey,
  validate: isOverviewShape,
  logFailure: (info) => logError("[BOC] failed to save analysis cache after eviction", info)
});

function contextKeyFields(context: Record<string, unknown> | undefined | null): {
  bvid: unknown;
  cid: unknown;
  subtitleId: string;
  subtitleUrl: string;
  lang: string;
} {
  const fields = segmentCacheKeyFields(context);
  return {
    bvid: fields.bvid,
    cid: fields.cid,
    subtitleId: String(fields.subtitleId ?? ""),
    subtitleUrl: String(fields.subtitleUrl ?? ""),
    lang: String(fields.lang ?? "")
  };
}

/**
 * 整份概览结果缓存键：bvid + cid + 字幕轨 source key + 字幕签名。
 * 签名随字幕内容（条数/首末时间戳/文本量）与轨道变化，重抓字幕/换轨/切分P 自然 miss。
 */
export function buildAnalysisFinalCacheKey(context: Record<string, unknown> | undefined | null, signature: unknown): string {
  return analysisFinalFamily.key(contextKeyFields(context), String(signature ?? ""));
}

/**
 * 概览分段产物缓存键：与 boc_lvs_summary_ 同族键形（…+ 段序号 [+ 预算代]），
 * 仅族前缀不同——产物不共享、键位机制共享（07 票决议）；预算代后缀逻辑继承
 * segment-cache 的 budgetScaleSuffix（_b50 等），段边界漂移不串内容。
 */
export function buildAnalysisSegmentCacheKey(
  context: Record<string, unknown> | undefined | null,
  segmentIndex: number | string | unknown,
  budgetScale: number | string | unknown = 1
): string {
  return analysisSegmentFamily.key(contextKeyFields(context), `${segmentIndex}${budgetScaleSuffix(budgetScale)}`);
}

// ============================================================
// 编排入口：双路径分派 + promise 复用 + 成本护栏
// ============================================================

// 以下三个依赖注入类型仅本模块的编排签名使用（runOverviewAnalysis 的入参 /
// deps 形状），arch-slim-2/08 转私有：生产消费方（reader/overview.ts）传对象
// 字面量无需引用类型；ladder.ts 的同名类型声明形状不同（宽松 BudgetPlan，
// 供测试 fake 只填 mode 等少数字段），刻意不合并（见工单 Comments 裁定）。
type ChatCompletionFn = (input: {
  provider: { baseUrl?: string; apiKey?: string; model?: string };
  messages: ChatMessage[];
  thinkingLevel?: string;
  signal?: AbortSignal | null;
  retries?: number;
  maxTokens?: number | null;
}) => Promise<unknown>;

type BuildBudgetPlanFn = (args: { body?: unknown[]; chapters?: unknown[] }) => BudgetPlan;

type BuildCostGuardNoticeFn = (args: { estimatedCalls?: unknown; estimatedTokens?: unknown }) => {
  shouldPrompt: boolean;
  message: string;
};

interface RunOverviewAnalysisArgs {
  provider: { baseUrl?: string; apiKey?: string; model?: string };
  /** AI 上下文（AiContext 形状）：bvid/cid/字幕轨三键位 + title/author/videoDescription + subtitleBody/chapters。 */
  context: Record<string, unknown>;
  signal?: AbortSignal | null;
  thinkingLevel?: string;
  /** 跳过整份缓存读取重新生成（分段缓存仍复用——重试只重跑未落盘段）。 */
  forceRefresh?: boolean;
}

interface RunOverviewAnalysisDeps {
  chatCompletion?: ChatCompletionFn;
  buildBudgetPlan?: BuildBudgetPlanFn;
  buildCostGuardNotice?: BuildCostGuardNoticeFn;
  /** 成本护栏确认钩子（≥5 次调用时）；未注入则不阻塞、直接生成（接线由集成步骤负责）。 */
  askCostGuard?: (message: string) => Promise<unknown>;
  /** 分段进度回调（可选，数据层无 port）。 */
  onProgress?: (notice: string) => void;
}

// 生成中 promise 复用（对齐 ensureSummarizeChain 的 promise 缓存手法）：
// 同一 finalKey 的重复触发共享同一 promise；落定（成功或失败）即移除，
// 之后触发改走缓存读取或重新生成。
const inflightOverviews = new Map<string, Promise<OverviewAnalysis>>();

// 分段 worker 的单段结果：失败不炸整单（07 票决议），以 ok 标记带出段区间。
interface SegmentOutcome {
  ok: boolean;
  part?: OverviewAnalysis;
  from?: number;
  to?: number;
  error?: unknown;
}

// 稿件章节 → 产物章节（短路径：章节取稿件标题，模型不再分章）。
// to 缺失/不合法时回落到下一章 from（末章 maxSeconds），与 AI 分章产物同构。
function normalizeManuscriptChapters(chapters: unknown, maxSeconds: number): AnalysisChapter[] {
  const list = (Array.isArray(chapters) ? chapters : [])
    .map((raw) => {
      const item = raw as { from?: unknown; to?: unknown; title?: unknown };
      return {
        from: Math.floor(Number(item?.from)),
        to: Math.floor(Number(item?.to)),
        title: typeof item?.title === "string" ? item.title.trim().slice(0, 300) : ""
      };
    })
    .filter((item) => Number.isFinite(item.from) && item.from >= 0 && item.title)
    .sort((a, b) => a.from - b.from);

  const out: AnalysisChapter[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (seen.has(item.from)) continue;
    seen.add(item.from);
    const nextFrom = i + 1 < list.length ? list[i + 1].from : null;
    const to =
      Number.isFinite(item.to) && item.to > item.from
        ? item.to
        : nextFrom !== null && nextFrom > item.from
          ? nextFrom
          : maxSeconds;
    out.push({ from: item.from, to, title: item.title, summary: "" });
  }
  return out.slice(0, MAX_ANALYSIS_CHAPTERS);
}

// 取消错误：err.cancelled = true 标记（house style 类型化标记；消费方查标记分流）。
function makeOverviewCancelledError(): Error & { cancelled: true } {
  const error = new Error("已取消") as Error & { cancelled: true };
  error.cancelled = true;
  return error;
}

// 空产物错误：模型没给出任何有效章节与金句（对齐参考仓库 EMPTY_ANALYSIS 语义）。
function makeEmptyAnalysisError(): Error {
  return new Error("模型没有产出有效的章节或金句，请重试。");
}

// 单次模型调用 → 宽容解析 → 校验。maxTokens 按正文长度估算（ratio 0.5，
// 前情回顾只进输入不进输出）；非流式显式 retries 由调用方给（单次 2 / 分段走池层重试）。
// 空正文（含纯空白）按「思考占满输出预算」加倍预算重试一次，仍空则抛可读错误
// （EMPTY_TEXT_RETRY_MAX_TOKENS_CEILING 处有根因说明）。
async function requestValidatedPart({
  provider,
  systemPrompt,
  built,
  minSeconds,
  thinkingLevel,
  signal,
  retries,
  chatCompletionImpl
}: {
  provider: { baseUrl?: string; apiKey?: string; model?: string };
  systemPrompt: string;
  built: BuiltAnalysisPrompt;
  minSeconds: number;
  thinkingLevel?: string;
  signal?: AbortSignal | null;
  retries?: number;
  chatCompletionImpl: ChatCompletionFn;
}): Promise<OverviewAnalysis> {
  if (signal?.aborted) {
    throw makeAbortedError();
  }
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: built.prompt }
  ];
  const baseMaxTokens = estimateOutputTokens(built.transcriptChars, { ratio: 0.5, floor: 2048 });
  const requestBase = { provider, messages, thinkingLevel, signal, retries };
  let text = await chatCompletionImpl({ ...requestBase, maxTokens: baseMaxTokens });
  if (!String(text ?? "").trim()) {
    text = await chatCompletionImpl({
      ...requestBase,
      maxTokens: Math.min(baseMaxTokens * 2, EMPTY_TEXT_RETRY_MAX_TOKENS_CEILING)
    });
  }
  if (!String(text ?? "").trim()) {
    throw new Error("模型没有返回正文（输出预算可能被思考过程占满），请重试。");
  }
  return validateAnalysis(parseLooseJson(String(text ?? "")), built.timing.maxTimestampSeconds, minSeconds);
}

/**
 * 概览生成编排入口（纯数据层，依赖注入对齐 ladder / orchestrateMapReduce 惯例）：
 * 1. 双路径分派：字幕 ≤100k 字符（buildBudgetPlan mode=single）单次非流式调用
 *    （显式 retries: 2）；>100k 走 buildBudgetPlan 切段 + runMapBounded 有界并发
 *    每段生成 + 段产物合并。
 * 2. 自带章节短路径：context.chapters 非空时只跑金句挑选调用（短提示词），
 *    章节取稿件标题，产物与 AI 分章完全同构。
 * 3. 失败语义：分段路径段失败 → 跳过出部分结果 + failedRanges 记录（全部段
 *    失败 → 抛第一个真实错误）；单次路径失败 → 抛错由调用方处理。
 * 4. 缓存：整份结果按 (bvid, cid, 字幕轨, 字幕签名) 落 chrome.storage.local；
 *    分段产物按段缓存复用——重试（forceRefresh）天然只重跑未落盘段。
 * 5. 生成编排：同视频生成中重复触发 → 复用进行中的 promise（ensureSummarizeChain
 *    手法：promise 缓存按 finalKey 去重、落定即清），与笔记管线互不阻塞。
 * 返回归一化产物；abort / 取消 / 失败以异常上浮（err.aborted / err.cancelled 标记）。
 * 本函数刻意非 async：直接返回内部 promise，重复触发拿到的是同一个 promise 引用。
 */
export function runOverviewAnalysis(
  { provider, context, signal, thinkingLevel, forceRefresh = false }: RunOverviewAnalysisArgs,
  deps: RunOverviewAnalysisDeps = {}
): Promise<OverviewAnalysis> {
  const ctx = context || {};
  const body = Array.isArray(ctx.subtitleBody) ? (ctx.subtitleBody as unknown[]) : [];
  // 短路径判定：自带章节非空 → 只挑金句（章节取稿件标题）。
  const manuscriptChapters = Array.isArray(ctx.chapters) ? ctx.chapters : [];
  const shortPath = manuscriptChapters.length > 0;
  // 现成章节目录：简介 + 热门评论里的时间戳目录（「00:00 开场」行）。
  // 短路径（稿件自带章节）不需要目录——章节边界已有权威来源。
  const chapterOutline = shortPath ? [] : parseChapterOutline([ctx.videoDescription, hotCommentsText(ctx.hotComments)].join("\n"));

  const signature = buildSubtitleSignature({
    lang: ctx.subtitleLang,
    subtitleId: ctx.selectedSubtitleId,
    subtitleUrl: ctx.selectedSubtitleUrl,
    body,
    chapters: manuscriptChapters,
    chapterOutline
  });
  const finalKey = buildAnalysisFinalCacheKey(ctx, signature);

  // 生成编排：进行中 promise 复用（forceRefresh 的显式重生成不去重）。
  const inflight = forceRefresh ? undefined : inflightOverviews.get(finalKey);
  if (inflight) {
    return inflight;
  }
  const promise = executeOverviewRun({
    provider,
    ctx,
    body,
    shortPath,
    manuscriptChapters,
    chapterOutline,
    finalKey,
    signal,
    thinkingLevel,
    forceRefresh,
    chatCompletionImpl: deps.chatCompletion ?? (_chatCompletion as unknown as ChatCompletionFn),
    buildBudgetPlanImpl: deps.buildBudgetPlan ?? (_buildBudgetPlan as unknown as BuildBudgetPlanFn),
    buildCostGuardNoticeImpl:
      deps.buildCostGuardNotice ?? (_buildCostGuardNotice as unknown as BuildCostGuardNoticeFn),
    askCostGuard: deps.askCostGuard,
    onProgress: deps.onProgress
  });
  if (!forceRefresh) {
    inflightOverviews.set(finalKey, promise);
    const cleanup = () => {
      if (inflightOverviews.get(finalKey) === promise) {
        inflightOverviews.delete(finalKey);
      }
    };
    promise.then(cleanup, cleanup);
  }
  return promise;
}

interface ExecuteOverviewRunArgs {
  provider: { baseUrl?: string; apiKey?: string; model?: string };
  ctx: Record<string, unknown>;
  body: unknown[];
  shortPath: boolean;
  manuscriptChapters: unknown[];
  chapterOutline: OutlineChapter[];
  finalKey: string;
  signal?: AbortSignal | null;
  thinkingLevel?: string;
  forceRefresh: boolean;
  chatCompletionImpl: ChatCompletionFn;
  buildBudgetPlanImpl: BuildBudgetPlanFn;
  buildCostGuardNoticeImpl: BuildCostGuardNoticeFn;
  askCostGuard?: (message: string) => Promise<unknown>;
  onProgress?: (notice: string) => void;
}

async function executeOverviewRun({
  provider,
  ctx,
  body,
  shortPath,
  manuscriptChapters,
  chapterOutline,
  finalKey,
  signal,
  thinkingLevel,
  forceRefresh,
  chatCompletionImpl,
  buildBudgetPlanImpl,
  buildCostGuardNoticeImpl,
  askCostGuard,
  onProgress
}: ExecuteOverviewRunArgs): Promise<OverviewAnalysis> {
  if (normalizeSubtitleItems(body).length === 0) {
    throw new Error("没有可用的字幕");
  }
  const systemPrompt = shortPath ? QUOTES_SYSTEM_PROMPT : ANALYSIS_SYSTEM_PROMPT;
  const buildPrompt = shortPath ? buildQuotesPrompt : buildAnalysisPrompt;
  // 整份缓存命中直接复用（短路径的章节取自稿件，返回前以稿件现值覆盖，防章节晚于字幕更新）。
  if (!forceRefresh) {
    const cached = await analysisFinalFamily.load(finalKey);
    if (cached) {
      return shortPath
        ? { ...cached, chapters: normalizeManuscriptChapters(manuscriptChapters, cached.chapters.at(-1)?.to ?? 0) }
        : cached;
    }
  }

  const promptVars = {
    title: ctx.title,
    ownerName: ctx.author,
    videoDescription: ctx.videoDescription,
    chapterOutline
  };
  const plan = buildBudgetPlanImpl({ body, chapters: manuscriptChapters });
  const segments = Array.isArray(plan.segments) ? plan.segments : [];
  const segmented = plan.mode === "map-reduce" && segments.length > 0;

  // 成本护栏：分段路径预估 ≥5 次调用时经注入的确认钩子询问（对齐 ladder 手法；
  // 钩子未注入则不阻塞——护栏 UI 接线由集成步骤负责）。
  if (segmented) {
    const guard = buildCostGuardNoticeImpl({
      estimatedCalls: segments.length,
      estimatedTokens: plan.totalChars
    });
    if (guard.shouldPrompt && typeof askCostGuard === "function") {
      if (signal?.aborted) {
        throw makeAbortedError();
      }
      const confirmed = Boolean(await askCostGuard(guard.message));
      if (!confirmed) {
        throw makeOverviewCancelledError();
      }
    }
  }

  if (!segmented) {
    // —— 单次路径：预算内一次调用，失败整体抛错由调用方处理（07 票决议）——
    const items = normalizeSubtitleItems(body);
    const startSeconds = Math.max(0, Math.floor(Number(items[0]?.from) || 0));
    const built = buildPrompt({
      ...promptVars,
      items: body,
      contextItems: [],
      videoDuration: ctx.videoDuration,
      startSeconds,
      segmentIndex: 1,
      totalSegments: 1
    });
    const part = await requestValidatedPart({
      provider,
      systemPrompt,
      built,
      minSeconds: startSeconds,
      thinkingLevel,
      signal,
      retries: 2,
      chatCompletionImpl
    });
    const analysis = shortPath
      ? {
          ...part,
          chapters: normalizeManuscriptChapters(manuscriptChapters, built.timing.maxTimestampSeconds)
        }
      : part;
    if (!analysis.chapters.length && !analysis.quotes.length) {
      throw makeEmptyAnalysisError();
    }
    await analysisFinalFamily.save(finalKey, analysis);
    return analysis;
  }

  // —— 分段路径：有界并发逐段生成（段缓存复用），段失败跳过出部分结果 ——
  const total = segments.length;
  let done = 0;

  const analyzeSegment = async (segment: BudgetPlanSegment, index: number): Promise<OverviewAnalysis> => {
    const segKey = buildAnalysisSegmentCacheKey(ctx, segment.index, 1);
    const cached = await analysisSegmentFamily.load(segKey);
    if (cached) {
      return cached;
    }
    if (signal?.aborted) {
      throw makeAbortedError();
    }
    // 前情回顾：上一段结尾字幕（只作上下文，产出限定在本段区间，靠 minSeconds 兜底）。
    const contextItems = index > 0 ? tailItems(segments[index - 1]?.items, ANALYSIS_CONTEXT_CHARS) : [];
    const built = buildPrompt({
      ...promptVars,
      items: segment.items,
      contextItems,
      // 时长变量按本段区间算（对齐参考仓库 analyzeChunk 传 chunk.endSeconds）。
      videoDuration: segment.to,
      startSeconds: segment.from,
      segmentIndex: index + 1,
      totalSegments: total
    });
    const part = await requestValidatedPart({
      provider,
      systemPrompt,
      built,
      minSeconds: segment.from,
      thinkingLevel,
      signal,
      chatCompletionImpl
    });
    // 先落盘再返回：失败重试只重跑未落盘段（segment-cache 复用语义）。
    await analysisSegmentFamily.save(segKey, part);
    return part;
  };

  const worker = async (segment: BudgetPlanSegment, index: number): Promise<SegmentOutcome> => {
    try {
      const part = await analyzeSegment(segment, index);
      return { ok: true, part };
    } catch (e) {
      // 中止仍整体上抛（池层收束）；其余失败按 07 票决议跳过该段、记录区间。
      if ((e as { aborted?: boolean })?.aborted || signal?.aborted) {
        throw e;
      }
      return { ok: false, from: segment.from, to: segment.to, error: e };
    }
  };

  let outcomes: SegmentOutcome[];
  try {
    outcomes = await runMapBounded({
      items: segments,
      worker,
      concurrency: DEFAULT_MAP_CONCURRENCY,
      signal,
      onItemDone: () => {
        done += 1;
        onProgress?.(buildProgressNotice(done, total));
      }
    });
  } catch (e) {
    if ((e as { aborted?: boolean })?.aborted || signal?.aborted) {
      throw e;
    }
    throw e instanceof Error ? e : new Error(String(e));
  }

  const parts = outcomes.filter((outcome) => outcome?.ok && outcome.part).map((outcome) => outcome.part as OverviewAnalysis);
  const failedRanges = outcomes
    .filter((outcome) => !outcome?.ok)
    .map((outcome) => ({ from: Math.floor(Number(outcome?.from) || 0), to: Math.floor(Number(outcome?.to) || 0) }));

  // 全军覆没时把第一个真实错误透出去，它比「生成失败」有用得多。
  if (parts.length === 0) {
    const firstError = outcomes.find((outcome) => !outcome?.ok)?.error;
    if (firstError instanceof Error) {
      throw firstError;
    }
    throw new Error(firstError ? String(firstError) : "概览生成失败。");
  }

  const merged = mergeAnalyses(parts);
  const analysis: OverviewAnalysis = shortPath
    ? {
        ...merged,
        chapters: normalizeManuscriptChapters(manuscriptChapters, merged.chapters.at(-1)?.to ?? 0)
      }
    : merged;
  if (!analysis.chapters.length && !analysis.quotes.length) {
    throw makeEmptyAnalysisError();
  }
  if (failedRanges.length) {
    analysis.failedRanges = failedRanges;
  }
  // 部分结果照常落缓存（含 failedRanges）：重试走 forceRefresh，段缓存让已成功段免重付费。
  await analysisFinalFamily.save(finalKey, analysis);
  return analysis;
}
