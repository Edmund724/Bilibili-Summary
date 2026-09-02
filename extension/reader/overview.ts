// PR4 概览 tab：状态机 + 生成编排 + 渲染 + 交互（reader 域内，PR3
// subtitle-search / transcribe-banner 同款单模块先例）。
//
// 数据管线：ai/analysis.ts 的 runOverviewAnalysis（PR4a 已定稿，本模块只接线）——
// 缓存读取、分段产物复用、生成中 promise 复用都在管线内；本模块负责：
//   1. 状态机：idle / generating（含进度文案）/ ready / partial（带 failedRanges）/
//      error（带错误信息）/ empty（无字幕诚实空态），产物引用存模块内闭包。
//   2. 触发时机（基线决议「打开即自动生成并缓存」）：
//        - enterReaderMode 打开视图（lifecycle 调用，字幕已在则直接生成）；
//        - subtitle-ready presenter 通知（lifecycle 调用，转写/抓取完成后兜住）；
//        - 用户切到概览 tab（ui-renderer → ensureReaderOverviewTab，idle 才触发）。
//      重复触发去重两层：本模块 inflight promise 复用 + 管线 finalKey promise
//      复用（runOverviewAnalysis 内建）；已生成（ready/partial）不自动重跑，
//      重试一律显式 forceRefresh（段缓存让已成功段免重付费）。
//   3. 签名守卫：generatedFor 记录生成时的 (bvid, cid, 字幕签名)（与缓存键同一
//      构成），换轨/切分P/重抓后旧产物立即退场，渲染层自愈不串片展示。
//   4. 点击跳播：章节/金句复用 seekReadingTarget 通道（jumpReadingTarget，
//      阅读视图内点击语义 resumePlayback:true）；金句卡选中文本时不跳转。
//   5. 清理：closeReadingView 调 resetReaderOverviewState 归位状态；不取消进行中
//      的生成（管线后台跑完落缓存，重开阅读模式读缓存命中；落定回执因
//      generatedFor 已清而被丢弃，不会写进新会话）。
//
// 分章来源标注：管线产物不带来源信息，按 07 票决议从入参推断——生成发起时
// state.clip.chapters 为空即 AI 分章（章节标头带「AI 生成」小标注），自带章节
// 走短路径不标。

import { state } from "../core/state.js";
import { escapeHtml, formatCompactTimestamp } from "../shared/string-utils.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { setMessage } from "../shared/ui-status.js";
// 「选中平台 + 其 API Key」解析（与选区解释共用）。
import { resolveActiveProvider } from "../ai/active-provider.js";
import {
  runOverviewAnalysis,
  buildSubtitleSignature,
  groupQuotesIntoChapters,
  type AnalysisChapter,
  type AnalysisQuote,
  type OverviewAnalysis
} from "../ai/analysis.js";
import { shouldShowHoursInNote } from "../notes/render.js";
import { ids } from "./state.js";
import { isReaderTranscribing } from "./transcribe-banner.js";
import { jumpReadingTarget } from "./sync.js";

// ============================================================
// 状态（模块内闭包，对齐 scroll-state/explain-intent 的 reader 域叶子模式）
// ============================================================

export type ReaderOverviewPhase = "idle" | "generating" | "ready" | "partial" | "error" | "empty";

interface ReaderOverviewState {
  phase: ReaderOverviewPhase;
  analysis: OverviewAnalysis | null;
  /** 章节标头「AI 生成」小标注：生成发起时视频自带章节为空即 AI 分章 */
  aiChapters: boolean;
  progressText: string;
  errorText: string;
  /** 生成发起时的视频/字幕轨身份（bvid|cid|字幕签名），换轨/换片后退场旧产物 */
  generatedFor: string;
  /** 进行中的生成编排 promise：重复触发复用，落定置回 null */
  inflight: Promise<void> | null;
}

const overview: ReaderOverviewState = {
  phase: "idle",
  analysis: null,
  aiChapters: false,
  progressText: "",
  errorText: "",
  generatedFor: "",
  inflight: null
};

function getClipBody(): { from: number; to: number; content: string }[] {
  return Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
}

// 当前视频/字幕轨身份：与整份概览缓存键同一构成（bvid + cid + 字幕签名；
// 签名含自带章节模式位——章节出现/消失切换短路径，产物与「AI 生成」标注一并换血）。
function currentOverviewKey(): string {
  const clip = state.clip;
  const signature = buildSubtitleSignature({
    lang: clip.selectedSubtitleLang,
    subtitleId: clip.selectedSubtitleId,
    subtitleUrl: clip.selectedSubtitleUrl,
    body: getClipBody(),
    chapters: Array.isArray(clip.chapters) ? clip.chapters : []
  });
  return `${clip.bvid}|${clip.cid}|${signature}`;
}

// AI 上下文（runOverviewAnalysis 入参）：三键位 + 元信息 + 字幕体 + 章节 + 热评。
// 字段名对齐 segmentCacheKeyFields（selectedSubtitleId/selectedSubtitleUrl/
// subtitleLang），保证缓存键位与 sidepanel/offscreen 侧同构。
// 热评透传给管线：与简介一起供「现成章节目录」解析（简介/评论里的时间戳目录
// 优先决定章节边界，AI 只补每章大意）；无目录/解析失败不影响现状行为。
function buildOverviewContext(): Record<string, unknown> {
  const clip = state.clip;
  return {
    bvid: clip.bvid,
    cid: clip.cid,
    aid: clip.aid,
    title: clip.title,
    author: clip.author,
    videoDescription: clip.description,
    hotComments: Array.isArray(clip.hotComments) ? clip.hotComments : [],
    videoDuration: clip.videoDuration,
    subtitleLang: clip.selectedSubtitleLang,
    selectedSubtitleId: clip.selectedSubtitleId,
    selectedSubtitleUrl: clip.selectedSubtitleUrl,
    subtitleBody: getClipBody(),
    chapters: Array.isArray(clip.chapters) ? clip.chapters : []
  };
}

// ============================================================
// 生成编排（provider 解析 + 管线调用 + 状态机迁移）
// ============================================================

// 「选中平台 + 其 API Key」解析在 ai/active-provider.js（与选区解释共用同一份
// 消息链实现）；失败以异常上翻进 error 态。

function renderIfOpen(): void {
  if (state.reader.readingViewOpen) {
    renderReadingOverview();
  }
}

// 无字幕出口：不触发生成（07 票决议数据层也直接拒绝），展示诚实空态。
// 转写进行中给出预期文案（转写完成后字幕就绪通知会再触发）。
function markEmptyPhase(): void {
  overview.phase = "empty";
  overview.analysis = null;
  overview.generatedFor = "";
  overview.progressText = "";
  overview.errorText = "";
}

// 旧产物退场（换轨/切分P/会话收尾共用）：产物引用一并丢弃。
function dropOverviewProduct(): void {
  overview.phase = "idle";
  overview.analysis = null;
  overview.generatedFor = "";
  overview.progressText = "";
  overview.errorText = "";
}

/**
 * 触发概览生成（fire-and-forget；返回编排 promise 供测试/去重方 await）。
 * 去重语义：
 *   - generating 中重复触发 → 复用本次编排 promise（管线内还会按 finalKey 二次去重）；
 *   - ready/partial 且身份未变 → 不重跑（部分结果重试必须显式 forceRefresh）；
 *   - error → 不自动重跑（错误条上的重试按钮走 forceRefresh）；
 *   - forceRefresh=true → 跳过以上短路重新生成（整份缓存不读，段缓存照常复用）。
 * 无字幕 → 标记 empty 态不触发。
 */
export function triggerReaderOverviewGeneration(
  { forceRefresh = false }: { forceRefresh?: boolean } = {}
): Promise<void> {
  if (overview.inflight) {
    return overview.inflight;
  }
  if (getClipBody().length === 0) {
    markEmptyPhase();
    renderIfOpen();
    return Promise.resolve();
  }
  const clipKey = currentOverviewKey();
  if (
    !forceRefresh &&
    overview.generatedFor === clipKey &&
    (overview.phase === "ready" || overview.phase === "partial" || overview.phase === "error")
  ) {
    return Promise.resolve();
  }
  if (overview.generatedFor !== clipKey) {
    dropOverviewProduct();
  }
  overview.generatedFor = clipKey;
  overview.aiChapters = !Array.isArray(state.clip.chapters) || state.clip.chapters.length === 0;
  overview.phase = "generating";
  overview.progressText = "正在生成概览…";
  overview.errorText = "";
  renderIfOpen();

  const run = startOverviewRun(clipKey, forceRefresh);
  overview.inflight = run;
  const cleanup = () => {
    if (overview.inflight === run) {
      overview.inflight = null;
    }
  };
  run.then(cleanup, cleanup);
  return run;
}

async function startOverviewRun(clipKey: string, forceRefresh: boolean): Promise<void> {
  try {
    const provider = await resolveActiveProvider();
    const analysis = await runOverviewAnalysis(
      // digest-only-ui：思考档位显式钉死 off（对齐 ai/explain.ts 的钉法）——
      // 章节/金句生成不开放思考档位，省略档位虽会在协议层归一化落到 off，
      // 显式传参让请求体带 THINKING_DISABLE_FIELDS 的行为成为契约而非默认值
      // 巧合（协议层改动时不会被静默带走）。
      { provider, context: buildOverviewContext(), forceRefresh, thinkingLevel: "off" },
      {
        // 分段进度文案（buildProgressNotice：「正在整理第 x/y 段（n%）」）注入：
        // 生成中状态条实时跟随（管线 onProgress 为可选注入，分段路径才回调）。
        onProgress: (notice) => {
          overview.progressText = String(notice || "");
          renderIfOpen();
        },
        // 成本护栏（分段路径预估 ≥5 次调用时）：页内 confirm，与
        // sidepanel-chat-runtime 的护栏确认同款手法；拒绝以 err.cancelled 上翻。
        askCostGuard: (message) => Promise.resolve(window.confirm(message))
      }
    );
    if (overview.generatedFor !== clipKey) {
      return; // 会话已收尾/已换片：产物丢弃（closeReadingView 清理语义）
    }
    overview.analysis = analysis;
    overview.phase = Array.isArray(analysis.failedRanges) && analysis.failedRanges.length > 0 ? "partial" : "ready";
    overview.progressText = "";
    overview.errorText = "";
    renderIfOpen();
  } catch (error) {
    if (overview.generatedFor !== clipKey) {
      return; // 同上：过期回执丢弃
    }
    const err = error as { cancelled?: unknown; aborted?: unknown } | null;
    if (err?.cancelled || err?.aborted) {
      // 用户拒绝成本护栏 / 请求被中止：回到未生成态，不算失败
      dropOverviewProduct();
      renderIfOpen();
      return;
    }
    overview.phase = "error";
    overview.errorText = getErrorMessage(error, "概览生成失败");
    overview.progressText = "";
    renderIfOpen();
  }
}

// ============================================================
// 触发入口（lifecycle / ui-renderer 调用面）
// ============================================================

/**
 * 切到概览 tab 的入口（ui-renderer 标签切换回调）：先收敛渲染（含换片自愈），
 * 未生成就触发生成。幂等：已生成不重跑，生成中复用。
 */
export function ensureReaderOverviewTab(): void {
  renderReadingOverview();
  void triggerReaderOverviewGeneration();
}

// ============================================================
// 渲染（替换 PR2 占位卡：#boc-reading-tabbody-overview 内整块重建）
// ============================================================

// 渲染前把状态收敛到与当前视频/字幕轨一致：
//   - 字幕体为空 → empty（诚实空态，转写中给出预期文案）；
//   - 字幕从无到有 → empty 退场回 idle（等下次触发）；
//   - generatedFor 与当前身份不一致 → 旧产物退场（换轨/切分P/重抓不串片）。
function syncOverviewPhaseToClip(): void {
  if (getClipBody().length === 0) {
    if (overview.phase !== "empty") {
      markEmptyPhase();
    }
    return;
  }
  if (overview.phase === "empty") {
    overview.phase = "idle";
    return;
  }
  if (overview.generatedFor && overview.generatedFor !== currentOverviewKey()) {
    dropOverviewProduct();
  }
}

export function renderReadingOverview(): void {
  const body = document.getElementById(ids.readingOverviewBody);
  if (!body) {
    return;
  }
  syncOverviewPhaseToClip();
  body.innerHTML = buildOverviewBodyHtml();
}

function buildOverviewBodyHtml(): string {
  switch (overview.phase) {
    case "empty":
      return buildEmptyStateHtml();
    case "generating":
      return buildGeneratingStrip() + buildResultSectionsHtml();
    case "partial":
      return buildPartialStrip() + buildResultSectionsHtml();
    case "error":
      return buildErrorStrip();
    case "ready":
      return buildResultSectionsHtml();
    case "idle":
    default:
      return `
        <div class="boc-reading-placeholder">
          <div class="boc-reading-placeholder-title">概览还未生成</div>
          <p class="boc-reading-placeholder-copy">切到概览标签页会自动开始生成章节与金句。</p>
        </div>
      `;
  }
}

// 无字幕诚实空态（07 票决议：无字幕不触发、不放假数据）。转写进行中（字幕
// tab 横幅同源判定）给出预期文案，与横幅「转写完成后字幕与概览将自动出现」一致。
function buildEmptyStateHtml(): string {
  if (isReaderTranscribing()) {
    return `
      <div class="boc-reading-placeholder">
        <div class="boc-reading-placeholder-title">概览等字幕就绪后自动生成</div>
        <p class="boc-reading-placeholder-copy">音频转写完成后会自动生成章节与金句，期间可先在「字幕」页看视频。</p>
      </div>
    `;
  }
  return `
    <div class="boc-reading-placeholder">
      <div class="boc-reading-placeholder-title">该视频没有可用字幕</div>
      <p class="boc-reading-placeholder-copy">概览（章节与金句）需要字幕才能生成。</p>
    </div>
  `;
}

// 生成中状态条：进度文案来自管线 onProgress（分段路径实时推进），细进度条
// 复用转写横幅的 boc-asr-pulse 不确定动画（页面侧拿不到确定进度）。
function buildGeneratingStrip(): string {
  return `
    <div class="boc-reading-ov-strip is-generating">
      <span class="boc-reading-ov-strip-text">正在生成概览…</span>
      <span class="boc-reading-ov-progress">${escapeHtml(overview.progressText || "")}</span>
    </div>
    <div class="boc-reading-ov-track" aria-hidden="true"><div class="boc-reading-ov-fill"></div></div>
  `;
}

// 部分失败标记条：失败区间数 + 重试按钮（forceRefresh 重跑——整份缓存跳过、
// 段缓存让已成功段免重付费，见 analysis.ts 失败语义）。
function buildPartialStrip(): string {
  const failedCount = overview.analysis?.failedRanges?.length || 0;
  return `
    <div class="boc-reading-ov-strip is-partial">
      <span class="boc-reading-ov-strip-text">有 ${failedCount} 个分段生成失败，对应区间的章节与金句缺失。</span>
      <button type="button" class="boc-reading-mini-btn" data-overview-action="retry-failed">重试失败区间</button>
    </div>
  `;
}

function buildErrorStrip(): string {
  return `
    <div class="boc-reading-ov-strip is-error">
      <span class="boc-reading-ov-strip-text">概览生成失败：${escapeHtml(overview.errorText || "未知错误")}</span>
      <button type="button" class="boc-reading-mini-btn" data-overview-action="retry">重试</button>
    </div>
  `;
}

// 结果区：章节列表 → 金句卡。生成中已有旧产物（重试场景）时同样渲染，
// 新结果落定后整体重建。
function buildResultSectionsHtml(): string {
  const analysis = overview.analysis;
  if (!analysis) {
    if (overview.phase === "generating") {
      return `
        <div class="boc-reading-placeholder">
          <div class="boc-reading-placeholder-title">正在生成概览</div>
          <p class="boc-reading-placeholder-copy">章节与金句会出现在这里；期间可先在「字幕」页阅读。</p>
        </div>
      `;
    }
    return "";
  }

  const withHours = shouldShowHoursInNote(state, getClipBody());
  // 章节缺标题 / 金句缺文本的残条目不渲染（与既有空态判定同口径）。
  const chapters = (Array.isArray(analysis.chapters) ? analysis.chapters : []).filter(
    (item) => item && String(item.title || "").trim()
  );
  const quotes = (Array.isArray(analysis.quotes) ? analysis.quotes : []).filter(
    (item) => item && String(item?.content || "").trim()
  );
  const chapterBadge = overview.aiChapters ? '<span class="boc-reading-ov-badge">AI 生成</span>' : "";
  const quotesEmptyNote = quotes.length === 0 ? '<div class="boc-reading-ov-empty">没有可用的金句。</div>' : "";

  // —— 无章节视频：维持平铺——章节空态 + 独立金句 section（卡片按 from 平铺）——
  if (chapters.length === 0) {
    return `
      <section class="boc-reading-ov-section">
        <div class="boc-reading-ov-h">章节</div>
        <div class="boc-reading-ov-empty">没有可用的章节。</div>
      </section>
      <section class="boc-reading-ov-section">
        <div class="boc-reading-ov-h">金句<span class="boc-reading-ov-badge">AI 精选</span></div>
        ${quotesEmptyNote}${quotes.map((item) => quoteCardHtml(item, withHours, false)).join("")}
      </section>
    `;
  }

  // —— 有章节：金句归章（groupQuotesIntoChapters）——每章卡后紧跟该章金句卡，
  // 早于第一章的 orphan 金句单列「其他金句」，不硬塞进最近的章节。两条路径
  // （AI 分章 / 自带章节短路径）产物同构，UI 不区分来源（概览票 07 决议）。
  const { grouped, orphans } = groupQuotesIntoChapters(chapters, quotes);
  const chapterBlocks = grouped
    .map(({ chapter, quotes: chapterQuotes }) => {
      return `${chapterCardHtml(chapter, withHours)}${chapterQuotes.map((item) => quoteCardHtml(item, withHours, true)).join("")}`;
    })
    .join("");
  const orphanBlock = orphans.length
    ? `<div class="boc-reading-ov-subhead">其他金句<span class="boc-reading-ov-badge">AI 精选</span></div>${orphans
        .map((item) => quoteCardHtml(item, withHours, false))
        .join("")}`
    : "";
  return `
    <section class="boc-reading-ov-section">
      <div class="boc-reading-ov-h">章节${chapterBadge}</div>
      ${chapterBlocks}${orphanBlock}${quotesEmptyNote}
    </section>
  `;
}

// 章节卡（时间戳 pill + 标题 + 小结，点击跳播）。
function chapterCardHtml(item: AnalysisChapter, withHours: boolean): string {
  const from = Number(item.from) || 0;
  const desc = String(item.summary || "").trim();
  return `
    <button type="button" class="boc-reading-ov-chapter" data-seconds="${from}">
      <span class="boc-reading-time">${escapeHtml(formatCompactTimestamp(from, withHours))}</span>
      <span class="boc-reading-ov-chapter-copy">
        <span class="boc-reading-ov-chapter-title">${escapeHtml(String(item.title))}</span>
        ${desc ? `<span class="boc-reading-ov-chapter-desc">${escapeHtml(desc)}</span>` : ""}
      </span>
    </button>
  `;
}

// 金句卡（白底 + 左 3px accent 边 + 右下角时间戳 + Copy 按钮）。
// nested = 归章形态（挂在所属章节卡之后，缩进表达从属）；平铺形态（无章节 /
// orphan 组）不加。时间戳与原话原样呈现，不重排不改写。
function quoteCardHtml(item: AnalysisQuote, withHours: boolean, nested: boolean): string {
  const from = Number(item?.from) || 0;
  const content = String(item?.content || "").trim();
  if (!content) {
    return "";
  }
  return `
    <button type="button" class="boc-reading-ov-quote${nested ? " is-nested" : ""}" data-seconds="${from}">
      <span class="boc-reading-ov-quote-text">「${escapeHtml(content)}」</span>
      <span class="boc-reading-ov-quote-foot">
        <span class="boc-reading-time">${escapeHtml(formatCompactTimestamp(from, withHours))}</span>
        <span class="boc-reading-ov-quote-copy" role="button" data-overview-action="copy-quote" data-quote="${escapeHtml(content)}" data-seconds="${from}">Copy</span>
      </span>
    </button>
  `;
}

// ============================================================
// 交互（章节/金句点击跳播 + 复制金句 + 重试；ui-renderer 事件委托入口）
// ============================================================

export function onReadingOverviewClick(event: MouseEvent): void {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-overview-action]");
  if (target) {
    const action = target.dataset.overviewAction || "";
    if (action === "retry-failed" || action === "retry") {
      // 失败区间/整体重试：forceRefresh 跳过整份缓存，段缓存让已成功段免重付费
      void triggerReaderOverviewGeneration({ forceRefresh: true });
      return;
    }
    if (action === "copy-quote") {
      void copyQuoteToClipboard(target);
      return;
    }
    return;
  }

  // 章节/金句点击 → 跳播（点句跳转同一通道：jumpReadingTarget，阅读视图内
  // 点击语义 = resumePlayback:true）。金句卡有正文，用户选中文本复制时不跳转，
  // 与字幕句点击同款守卫。
  const seekTarget = (event.target as HTMLElement | null)?.closest<HTMLElement>(
    ".boc-reading-ov-chapter, .boc-reading-ov-quote"
  );
  if (!seekTarget) {
    return;
  }
  if (window.getSelection()?.toString().trim()) {
    return;
  }
  jumpReadingTarget(seekTarget.dataset.seconds ?? 0);
}

// 复制单条金句（含时间戳）到剪贴板：取数与反馈照抄 copySubtitleTranscript
// （subtitle/ui.js）——navigator.clipboard.writeText + setMessage；文本取
// 卡片 data-quote（无 HTML 实体顾虑）。金句点击默认是跳播，本按钮在
// onReadingOverviewClick 顶部分流拦下。
async function copyQuoteToClipboard(quoteEl: HTMLElement): Promise<void> {
  const seconds = Number(quoteEl.dataset.seconds) || 0;
  const content = quoteEl.dataset.quote || "";
  const withHours = shouldShowHoursInNote(state, getClipBody());
  const text = `${formatCompactTimestamp(seconds, withHours)} 「${content}」`;
  if (!content) {
    setMessage("没有可复制的金句。");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    setMessage("金句已复制到剪贴板。");
  } catch (error) {
    setMessage(`复制失败：${getErrorMessage(error)}`);
  }
}

// ============================================================
// 清理（closeReadingView 清理清单调用）
// ============================================================

/**
 * 会话收尾：状态与产物引用归位。不取消进行中的生成——管线后台跑完落缓存，
 * 重开阅读模式读缓存命中；落定回执因 generatedFor 已清而被丢弃（见
 * startOverviewRun 的回执守卫），不会写进新会话。
 */
export function resetReaderOverviewState(): void {
  overview.phase = "idle";
  overview.analysis = null;
  overview.aiChapters = false;
  overview.progressText = "";
  overview.errorText = "";
  overview.generatedFor = "";
  overview.inflight = null;
}
