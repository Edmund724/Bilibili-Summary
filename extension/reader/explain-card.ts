// extension/reader/explain-card.ts — 字幕 tab 内的「解释」卡片（选区解释的落点）。
//
// 交互链：在字幕句里选中词/句 → 选区下方浮出「解释」按钮（DOM 与选区监听在
// ui/ui-renderer.js，它是壳层唯一构建方）→ 点按钮调本模块 openReaderExplainCard
// → 面板内弹卡片（遮罩 + 对话框），就地展示模型给出的解释。
//
// 为什么不发到对话 tab：解释是「读完这句马上要懂」的即时动作，跳到对话 tab 会
// 打断阅读、且把一次短问答塞进长会话历史里。对话链路仍然保留——卡片底部的
// 「去对话追问」按钮走 reader/explain-intent 的单槽意图契约，把选中片段 + 所在
// 整句交给对话 tab 自动发送（用户在解释之后想继续追问时的正路）。
//
// 依赖方向：本模块属 reader 动态域（reader/index.js 聚合导出，ui-renderer 经
// ensureReaderDomain 装载后调用），可静态依赖 ai 域与 ui 壳层 setter——与
// reader/chat-tab.js 静态 import ui-renderer 的 setReaderDigestTab 同款先例。
//
// 竞态：一次只开一张卡；重复打开（换选区再点）先 abort 上一请求，runId 守卫
// 丢弃过期回执。关闭阅读视图（lifecycle.closeReadingView）也走 close。

import { state } from "../core/state.js";
import { escapeHtml } from "../shared/string-utils.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { renderMarkdown } from "../ui/markdown.js";
import { resolveActiveProvider } from "../ai/active-provider.js";
import { explainSelection } from "../ai/explain.js";
import { logWarn } from "../shared/logging.js";
import { ids } from "./state.js";
import { setPendingExplainIntent } from "./explain-intent.js";
import { setReaderDigestTab, activateReaderChatTab } from "../ui/ui-renderer.js";

type ExplainCardPhase = "loading" | "ready" | "error";

interface ExplainCardState {
  open: boolean;
  phase: ExplainCardPhase;
  /** 用户选中的原文 */
  selection: string;
  /** 选中所在的整条字幕句 */
  line: string;
  /** 所在句起始秒 */
  from: number;
  /** 所在句在字幕体中的下标（上下文窗口锚点） */
  index: number;
  /** 成功回执文本 */
  text: string;
  /** 失败文案 */
  error: string;
  /** 在飞请求的中止器 */
  controller: AbortController | null;
  /** 代际号：回执落定前比对，过期回执丢弃 */
  runId: number;
}

const card: ExplainCardState = {
  open: false,
  phase: "loading",
  selection: "",
  line: "",
  from: 0,
  index: -1,
  text: "",
  error: "",
  controller: null,
  runId: 0
};

export interface ReaderExplainCardPayload {
  selection: string;
  line: string;
  from: number;
  index: number;
}

function getCardRoot(): HTMLElement | null {
  return document.getElementById(ids.readingExplainCard);
}

function getClipBody(): { from: number; content: string }[] {
  return Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
}

// 整卡重建（结构与概览/对话 tab 同款：状态机驱动 innerHTML，容器不换）。
function renderCard(): void {
  const root = getCardRoot();
  if (!root) {
    return;
  }
  if (!card.open) {
    root.hidden = true;
    root.innerHTML = "";
    return;
  }
  root.hidden = false;

  const bodyHtml =
    card.phase === "loading"
      ? `
        <div class="boc-reading-explain-card-state">
          <span class="boc-reading-explain-card-dot" aria-hidden="true"></span>
          正在解释…
        </div>
      `
      : card.phase === "error"
        ? `
          <div class="boc-reading-explain-card-state is-error">${escapeHtml(card.error || "解释失败")}</div>
          <button type="button" class="boc-reading-mini-btn" data-explain-card-action="retry">重试</button>
        `
        : `<div class="boc-reading-explain-card-answer">${renderMarkdown(card.text)}</div>`;

  root.innerHTML = `
    <div class="boc-reading-explain-card-mask" data-explain-card-action="close"></div>
    <section class="boc-reading-explain-card-dialog" role="dialog" aria-modal="true" aria-label="解释" tabindex="-1">
      <header class="boc-reading-explain-card-head">
        <span class="boc-reading-explain-card-title">解释</span>
        <button type="button" class="boc-reading-explain-card-close" data-explain-card-action="close" title="关闭" aria-label="关闭">×</button>
      </header>
      <div class="boc-reading-explain-card-quote">${escapeHtml(card.selection)}</div>
      <div class="boc-reading-explain-card-content">${bodyHtml}</div>
      <footer class="boc-reading-explain-card-foot">
        <button type="button" class="boc-reading-mini-btn" data-explain-card-action="ask-chat">去对话追问</button>
      </footer>
    </section>
  `;

  // 焦点进对话框：键盘用户点完「解释」后 Esc/Tab 立即可用（选区已清，不再需要
  // 页面焦点；jsdom 无布局但 focus() 可调，守卫存在性即可）。
  root.querySelector<HTMLElement>(".boc-reading-explain-card-dialog")?.focus?.({ preventScroll: true });
}

// Esc 关闭：只在卡片开着期间挂文档级 keydown（与遮罩/× 同一关闭语义）。
function onCardKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.stopPropagation();
    closeReaderExplainCard();
  }
}

function bindCardEsc(): void {
  document.addEventListener("keydown", onCardKeyDown, true);
}

function unbindCardEsc(): void {
  document.removeEventListener("keydown", onCardKeyDown, true);
}

// 发起解释请求（provider 解析失败/请求失败都落 error 态，不静默）。
function startExplainRequest(): void {
  const runId = card.runId;
  card.phase = "loading";
  card.text = "";
  card.error = "";
  renderCard();

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  card.controller = controller;

  void (async () => {
    try {
      const provider = await resolveActiveProvider();
      const text = await explainSelection({
        provider,
        videoTitle: state.clip.title,
        selection: card.selection,
        line: card.line,
        from: card.from,
        index: card.index,
        body: getClipBody(),
        signal: controller?.signal
      });
      if (runId !== card.runId) {
        return; // 已被新的打开/关闭取代：丢弃过期回执
      }
      card.phase = "ready";
      card.text = text;
      renderCard();
    } catch (error) {
      if (runId !== card.runId || (error as { aborted?: boolean })?.aborted) {
        return; // 中止/过期：卡片已关闭或已换选区，不打扰
      }
      logWarn("[BOC] explain selection failed", error);
      card.phase = "error";
      card.error = getErrorMessage(error);
      renderCard();
    }
  })();
}

/**
 * 打开解释卡片并发起解释请求。
 * 重复打开（换了选区再点「解释」）：先中止上一请求，代际号 +1 让旧回执作废。
 */
export function openReaderExplainCard(payload: ReaderExplainCardPayload): void {
  const selection = String(payload?.selection || "").trim();
  const line = String(payload?.line || "").trim();
  if (!selection) {
    return;
  }
  card.controller?.abort();
  card.runId += 1;
  card.open = true;
  card.selection = selection;
  card.line = line || selection;
  card.from = Number(payload?.from) || 0;
  card.index = Number.isFinite(Number(payload?.index)) ? Number(payload.index) : -1;
  bindCardEsc();
  startExplainRequest();
}

/** 关闭卡片：中止在飞请求并整卡归位（幂等）。 */
export function closeReaderExplainCard(): void {
  if (!card.open) {
    return;
  }
  unbindCardEsc();
  card.controller?.abort();
  card.controller = null;
  card.runId += 1;
  card.open = false;
  card.text = "";
  card.error = "";
  renderCard();
}

/**
 * 卡片内点击委托（ui-renderer 挂在卡片容器上转发）：
 * close（遮罩 / ×）→ 关卡片；retry → 重发；ask-chat → 写待解释意图并切到对话 tab。
 */
export function onReaderExplainCardClick(event: MouseEvent): void {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-explain-card-action]");
  if (!target) {
    return;
  }
  event.stopPropagation();
  const action = target.dataset.explainCardAction;
  if (action === "close") {
    closeReaderExplainCard();
    return;
  }
  if (action === "retry") {
    if (card.open) {
      card.runId += 1;
      startExplainRequest();
    }
    return;
  }
  if (action === "ask-chat") {
    // 意图契约（reader/explain-intent.ts）：selection 带上用户实际选中的片段，
    // 对话 tab 据此出「解释这个词」的提示词；卡片自身负责关（切 tab 后卡片在
    // 字幕 tab 里，不关会残留）。
    setPendingExplainIntent({
      from: card.from,
      content: card.line,
      selection: card.selection,
      createdAt: Date.now()
    });
    closeReaderExplainCard();
    setReaderDigestTab("chat");
    activateReaderChatTab();
  }
}

/** 卡片是否开着（closeReadingView 收尾判定 / 测试）。 */
export function isReaderExplainCardOpen(): boolean {
  return card.open;
}
