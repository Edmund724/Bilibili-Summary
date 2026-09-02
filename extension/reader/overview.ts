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
//   4. 笔记一节（独立于概览生成，读既有产物，不造假数据）：
//        - 判定复用 ai/followup-context 的 hasFinalNote（用法对齐
//          followup-router：note = 会话存储里匹配当前视频的最新会话最后一条
//          assistant 消息；segmentSummaries = 按预算计划重建段键位读段缓存）；
//        - 成稿 → 预览卡（标题 + 首行摘要）+「查看完整笔记」面板内展开/收起，
//          Markdown 渲染复用 ui/markdown 的 renderMarkdown；
//        - 未成稿 → 引导按钮走对话 tab 直发链路（PR5 起：reader/chat-tab.ts 的
//          runQuickActionPrompt seam——定位 AI 对话 tab + 自动发送
//          playerAiQuickPrompt，不再绕侧边栏），流式进度与失败反馈沿用对话
//          tab 现有状态，本模块只反馈发起层面的失败。
//   5. 点击跳播：章节/金句复用 seekReadingTarget 通道（jumpReadingTarget，
//      阅读视图内点击语义 resumePlayback:true）；金句卡选中文本时不跳转。
//   6. 清理：closeReadingView 调 resetReaderOverviewState 归位状态；不取消进行中
//      的生成（管线后台跑完落缓存，重开阅读模式读缓存命中；落定回执因
//      generatedFor 已清而被丢弃，不会写进新会话）。
//
// 分章来源标注：管线产物不带来源信息，按 07 票决议从入参推断——生成发起时
// state.clip.chapters 为空即 AI 分章（章节标头带「AI 生成」小标注），自带章节
// 走短路径不标。

import { state } from "../core/state.js";
import { escapeHtml, formatCompactTimestamp } from "../shared/string-utils.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { DEFAULT_PLAYER_AI_QUICK_PROMPT } from "../core/defaults.js";
// PR5：概览笔记引导改走 reader 内对话 tab 的快捷动作消费 seam（二级惰性叶子）。
import { ensureReaderChatTab } from "../core/lazy-chat-tab.js";
import {
  runOverviewAnalysis,
  buildSubtitleSignature,
  type OverviewAnalysis
} from "../ai/analysis.js";
import { buildBudgetPlan } from "../ai/budgeter.js";
import { loadSegmentSummaries, lastAssistantContent } from "../ai/followup-router.js";
import { hasFinalNote } from "../ai/followup-context.js";
import {
  buildAiContextRef,
  buildContextKey,
  doesConversationMatchCurrentContext,
  normalizeConversations
} from "../ai/conversation.js";
import { renderMarkdown, stripThinkBlocks } from "../ui/markdown.js";
import { shouldShowHoursInNote } from "../notes/render.js";
import { ids } from "./state.js";
import { isReaderTranscribing } from "./transcribe-banner.js";
import { jumpReadingTarget } from "./sync.js";

// ============================================================
// 状态（模块内闭包，对齐 scroll-state/explain-intent 的 reader 域叶子模式）
// ============================================================

export type ReaderOverviewPhase = "idle" | "generating" | "ready" | "partial" | "error" | "empty";

// 笔记一节快照：checking（读取中）/ ready（hasFinalNote 成立，存全文）/
// none（未成稿或读取失败——两者对用户是同一个诚实空态）。
interface ReaderNoteSnapshot {
  phase: "checking" | "ready" | "none";
  title: string;
  excerpt: string;
  full: string;
}

interface ReaderOverviewState {
  phase: ReaderOverviewPhase;
  analysis: OverviewAnalysis | null;
  /** 章节标头「AI 生成」小标注：生成发起时稿件章节为空即 AI 分章 */
  aiChapters: boolean;
  progressText: string;
  errorText: string;
  /** 生成发起时的视频/字幕轨身份（bvid|cid|字幕签名），换轨/换片后退场旧产物 */
  generatedFor: string;
  /** 进行中的生成编排 promise：重复触发复用，落定置回 null */
  inflight: Promise<void> | null;
  note: ReaderNoteSnapshot;
  noteExpanded: boolean;
  /** 已发起笔记生成（player-ai-quick-action 受理成功）：显示进度去向提示 */
  noteRequested: boolean;
  noteError: string;
}

const overview: ReaderOverviewState = {
  phase: "idle",
  analysis: null,
  aiChapters: false,
  progressText: "",
  errorText: "",
  generatedFor: "",
  inflight: null,
  note: { phase: "checking", title: "", excerpt: "", full: "" },
  noteExpanded: false,
  noteRequested: false,
  noteError: ""
};

// 会话持久化键（sidepanel-conversation-store 写入侧的同键常量；存储侧无共享
// 常量模块，与写入侧字面量保持一致）。
const NOTE_CONVERSATIONS_STORAGE_KEY = "boc_ai_conversations_v1";
// 笔记首行摘要截断长度（原型 note-preview 的摘要式预览量级）。
const NOTE_PREVIEW_CHARS = 120;

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

// AI 上下文（runOverviewAnalysis 入参）：三键位 + 元信息 + 字幕体 + 章节。
// 字段名对齐 segmentCacheKeyFields（selectedSubtitleId/selectedSubtitleUrl/
// subtitleLang），保证缓存键位与 sidepanel/offscreen 侧同构。
function buildOverviewContext(): Record<string, unknown> {
  const clip = state.clip;
  return {
    bvid: clip.bvid,
    cid: clip.cid,
    aid: clip.aid,
    title: clip.title,
    author: clip.author,
    videoDescription: clip.description,
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

interface OverviewProvider {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

// 「选中平台 + 其 API Key」解析：与 offscreen 的 resolveProviderWithKey 同款
// 消息链（get-settings 选默认平台 → ai-providers-list 取列表 → get-ai-provider-
// key 取密钥），任一步失败以异常上翻进 error 态。
async function resolveOverviewProvider(): Promise<OverviewProvider> {
  const settingsResp = (await sendRuntimeMessage({ type: "get-settings" }).catch(() => null)) as
    | { ok?: boolean; settings?: { defaultModel?: unknown } }
    | null;
  const preferredId = String(settingsResp?.settings?.defaultModel || "").trim();

  const listResp = (await sendRuntimeMessage({ type: "ai-providers-list" }).catch(() => null)) as
    | { providers?: Array<{ id?: unknown; enabled?: unknown; baseUrl?: unknown; model?: unknown }> }
    | null;
  const enabled = (listResp?.providers || []).filter(
    (item) => item && item.enabled !== false && String(item?.id || "").trim()
  );
  const provider = enabled.find((item) => String(item.id) === preferredId) || enabled[0] || null;
  if (!provider) {
    throw new Error("还没有配置 AI 平台，请先在插件设置中添加并启用。");
  }

  const keyResp = (await sendRuntimeMessage({
    type: "get-ai-provider-key",
    providerId: String(provider.id)
  }).catch(() => null)) as { ok?: boolean; apiKey?: string; error?: string } | null;
  if (!keyResp?.ok) {
    throw new Error(String(keyResp?.error || "读取 API Key 失败"));
  }
  const apiKey = String(keyResp.apiKey || "").trim();
  return {
    baseUrl: String(provider.baseUrl || "").trim(),
    apiKey,
    model: String(provider.model || "").trim()
  };
}

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
    const provider = await resolveOverviewProvider();
    const analysis = await runOverviewAnalysis(
      { provider, context: buildOverviewContext(), forceRefresh },
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
    // 概览生成期间笔记可能已在侧边栏成稿：顺手刷新笔记一节快照。
    void refreshReaderNoteSnapshot();
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
 * 未生成就触发生成，并刷新笔记一节快照。幂等：已生成不重跑，生成中复用。
 */
export function ensureReaderOverviewTab(): void {
  renderReadingOverview();
  void triggerReaderOverviewGeneration();
  void refreshReaderNoteSnapshot();
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
      return buildGeneratingStrip() + buildResultSectionsHtml() + buildNoteSectionHtml();
    case "partial":
      return buildPartialStrip() + buildResultSectionsHtml() + buildNoteSectionHtml();
    case "error":
      return buildErrorStrip() + buildNoteSectionHtml();
    case "ready":
      return buildResultSectionsHtml() + buildNoteSectionHtml();
    case "idle":
    default:
      return `
        <div class="boc-reading-placeholder">
          <div class="boc-reading-placeholder-title">概览还未生成</div>
          <p class="boc-reading-placeholder-copy">切到概览标签页会自动开始生成全片总结、章节与金句。</p>
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
        <p class="boc-reading-placeholder-copy">音频转写完成后会自动生成全片总结、章节与金句，期间可先在「字幕」页看视频。</p>
      </div>
    `;
  }
  return `
    <div class="boc-reading-placeholder">
      <div class="boc-reading-placeholder-title">该视频没有可用字幕</div>
      <p class="boc-reading-placeholder-copy">概览（全片总结、章节与金句）需要字幕才能生成。</p>
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

// 结果区：总结段 → 章节列表 → 金句卡（视觉基准 prototype/final-概览.jpg）。
// 生成中已有旧产物（重试场景）时同样渲染，新结果落定后整体重建。
function buildResultSectionsHtml(): string {
  const analysis = overview.analysis;
  if (!analysis) {
    if (overview.phase === "generating") {
      return `
        <div class="boc-reading-placeholder">
          <div class="boc-reading-placeholder-title">正在生成概览</div>
          <p class="boc-reading-placeholder-copy">全片总结、章节与金句会出现在这里；期间可先在「字幕」页阅读。</p>
        </div>
      `;
    }
    return "";
  }

  const withHours = shouldShowHoursInNote(state, getClipBody());
  const sections: string[] = [];

  // —— 总结 ——
  const summary = String(analysis.summary || "").trim();
  sections.push(`
    <section class="boc-reading-ov-section">
      <div class="boc-reading-ov-h">总结</div>
      ${summary ? `<p class="boc-reading-ov-summary">${escapeHtml(summary)}</p>` : '<div class="boc-reading-ov-empty">模型没有给出全片总结。</div>'}
    </section>
  `);

  // —— 章节（「AI 生成」小标注仅 AI 分章显示；自带章节不标）——
  const chapters = (Array.isArray(analysis.chapters) ? analysis.chapters : []).filter(
    (item) => item && String(item.title || "").trim()
  );
  const chapterBadge = overview.aiChapters ? '<span class="boc-reading-ov-badge">AI 生成</span>' : "";
  sections.push(`
    <section class="boc-reading-ov-section">
      <div class="boc-reading-ov-h">章节${chapterBadge}</div>
      ${
        chapters.length === 0
          ? '<div class="boc-reading-ov-empty">没有可用的章节。</div>'
          : chapters
              .map((item) => {
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
              })
              .join("")
      }
    </section>
  `);

  // —— 金句卡（白底 + 左 3px accent 边 + 右下角时间戳）——
  const quotes = Array.isArray(analysis.quotes) ? analysis.quotes : [];
  sections.push(`
    <section class="boc-reading-ov-section">
      <div class="boc-reading-ov-h">金句<span class="boc-reading-ov-badge">AI 精选</span></div>
      ${
        quotes.length === 0
          ? '<div class="boc-reading-ov-empty">没有可用的金句。</div>'
          : quotes
              .map((item) => {
                const from = Number(item?.from) || 0;
                const content = String(item?.content || "").trim();
                if (!content) {
                  return "";
                }
                return `
                  <button type="button" class="boc-reading-ov-quote" data-seconds="${from}">
                    <span class="boc-reading-ov-quote-text">「${escapeHtml(content)}」</span>
                    <span class="boc-reading-ov-quote-foot"><span class="boc-reading-time">${escapeHtml(formatCompactTimestamp(from, withHours))}</span></span>
                  </button>
                `;
              })
              .join("")
      }
    </section>
  `);

  return sections.join("");
}

// —— 笔记一节（三态：读取中 / 成稿预览卡 / 未成稿引导卡）——
function buildNoteSectionHtml(): string {
  const head = '<section class="boc-reading-ov-section"><div class="boc-reading-ov-h">笔记</div>';
  if (overview.note.phase === "checking") {
    return `${head}<div class="boc-reading-ov-empty">笔记状态读取中…</div></section>`;
  }
  if (overview.note.phase === "ready") {
    const fullHtml = overview.noteExpanded
      ? `<div class="boc-reading-ov-note-full">${renderMarkdown(overview.note.full)}</div>`
      : "";
    return `
      ${head}
      <div class="boc-reading-ov-note-preview">
        <div class="boc-reading-ov-note-title">${escapeHtml(overview.note.title || "视频笔记")}</div>
        <p class="boc-reading-ov-note-excerpt">${escapeHtml(overview.note.excerpt)}</p>
        ${fullHtml}
        <button type="button" class="boc-reading-text-btn" data-overview-action="toggle-note">
          ${overview.noteExpanded ? "收起笔记" : "查看完整笔记 →"}
        </button>
      </div>
    </section>
    `;
  }
  // 未成稿：引导走 reader 内对话 tab 的笔记生成链路（playerAiQuickPrompt 直发，
  // PR5 起不再绕侧边栏）。流式进度与生成失败在对话 tab 沿用其现有状态反馈，
  // 这里只反馈发起层面的失败。
  const requestHint = overview.noteRequested
    ? '<p class="boc-reading-ov-note-hint">已在 AI 对话发起笔记生成，完成后回到概览即可查看。</p>'
    : "";
  const errorHint = overview.noteError
    ? `<p class="boc-reading-ov-note-hint is-error">${escapeHtml(overview.noteError)}</p>`
    : "";
  const generateBtn = overview.noteRequested
    ? ""
    : '<button type="button" class="boc-reading-ov-note-btn" data-overview-action="generate-note">生成完整笔记</button>';
  return `
    ${head}
    <div class="boc-reading-ov-note-preview is-empty">
      <p class="boc-reading-ov-note-hint">完整笔记还没有生成。</p>
      ${generateBtn}
      ${requestHint}
      ${errorHint}
    </div>
  </section>
  `;
}

// ============================================================
// 交互（章节/金句点击跳播 + 重试/笔记按钮；ui-renderer 事件委托入口）
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
    if (action === "toggle-note") {
      overview.noteExpanded = !overview.noteExpanded;
      renderIfOpen();
      return;
    }
    if (action === "generate-note") {
      void generateReaderNoteFromOverview();
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

// ============================================================
// 笔记一节（快照读取 + 引导生成）
// ============================================================

// 笔记快照请求令牌：并发刷新（切 tab / 生成落定）时只应用最后一次结果。
let noteSnapshotToken = 0;

async function refreshReaderNoteSnapshot(): Promise<void> {
  const token = ++noteSnapshotToken;
  overview.note = { phase: "checking", title: "", excerpt: "", full: "" };
  renderIfOpen();
  const snapshot = await loadReaderNoteSnapshot().catch(() => null);
  if (token !== noteSnapshotToken) {
    return; // 过期快照丢弃
  }
  overview.note = snapshot
    ? { phase: "ready", ...snapshot }
    : { phase: "none", title: "", excerpt: "", full: "" };
  renderIfOpen();
}

/**
 * 读取笔记产物（不造假数据，读不到就是未成稿）：
 *   - note：会话存储里匹配当前视频的最新会话的最后一条 assistant 消息
 *     （normalizeConversations 按 updatedAt 降序，matched[0] 即最新）；
 *   - segmentSummaries：按预算计划重建段键位读段缓存（followup-router 同款）；
 *   - hasFinalNote 判定成稿（笔记正文 + 分段小结齐备，CONTEXT.md 笔记词条）。
 * 无字幕 / 未匹配会话 / 判定不成立 → null（未成稿）。
 */
async function loadReaderNoteSnapshot(): Promise<{ title: string; excerpt: string; full: string } | null> {
  const clip = state.clip;
  if (getClipBody().length === 0) {
    return null;
  }
  const ref = buildAiContextRef({
    title: clip.title,
    url: location.href,
    author: clip.author,
    bvid: clip.bvid,
    cid: clip.cid,
    aid: clip.aid,
    pageIndex: clip.pageIndex
  });
  const contextKey = buildContextKey(ref);

  let noteText = "";
  let conversationTitle = "";
  try {
    const data = await chrome.storage.local.get([NOTE_CONVERSATIONS_STORAGE_KEY]);
    const conversations = normalizeConversations(data?.[NOTE_CONVERSATIONS_STORAGE_KEY]);
    const matched = conversations.filter((conversation) =>
      doesConversationMatchCurrentContext(conversation, ref, contextKey)
    );
    noteText = lastAssistantContent(matched[0]?.messages || []);
    conversationTitle = String(matched[0]?.title || "").trim();
  } catch {
    noteText = "";
  }
  if (!noteText.trim()) {
    return null;
  }

  // hasFinalNote 第二半：分段小结（Map-Reduce 路径的段缓存）。
  const plan = buildBudgetPlan({ body: getClipBody(), chapters: Array.isArray(clip.chapters) ? clip.chapters : [] });
  const summaries = await loadSegmentSummaries({ context: buildOverviewContext(), plan }).catch(() => [] as string[]);
  if (!hasFinalNote({ note: noteText, segmentSummaries: summaries })) {
    return null;
  }

  // 首行摘要式预览：剥掉 think 块取第一个非空行，超长截断。
  const plain = stripThinkBlocks(noteText);
  const firstLine = plain.split("\n").map((line) => line.trim()).find((line) => line) || "";
  const excerpt =
    firstLine.length > NOTE_PREVIEW_CHARS ? `${firstLine.slice(0, NOTE_PREVIEW_CHARS)}……` : firstLine;

  return {
    title: conversationTitle || String(clip.title || "").trim() || "视频笔记",
    excerpt,
    full: noteText
  };
}

// 引导按钮 → reader 内对话 tab 直发（PR5 改道：原 player-ai-quick-action 消息
// 打开 AI 侧边栏，现走对话组合根的快捷动作消费 seam——定位对话 tab +
// startNewConversation + 填 playerAiQuickPrompt + 自动发送，同一 seam、不再绕
// 侧边栏）。流式进度与失败反馈在对话 tab 沿用其现有状态；受理失败在此如实反馈。
async function generateReaderNoteFromOverview(): Promise<void> {
  try {
    const chat = await ensureReaderChatTab();
    const prompt = String(state.settings?.playerAiQuickPrompt || DEFAULT_PLAYER_AI_QUICK_PROMPT).trim();
    const accepted = await chat.runQuickActionPrompt(prompt);
    if (accepted) {
      overview.noteRequested = true;
      overview.noteError = "";
    } else {
      overview.noteError = "对话暂未就绪（未配置平台或上下文未就绪），请稍后重试。";
    }
  } catch (error) {
    overview.noteError = `发起笔记生成失败：${getErrorMessage(error)}`;
  }
  renderIfOpen();
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
  overview.note = { phase: "checking", title: "", excerpt: "", full: "" };
  overview.noteExpanded = false;
  overview.noteRequested = false;
  overview.noteError = "";
}
