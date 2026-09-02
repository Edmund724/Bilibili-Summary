// Reader 状态微模块聚合（候选04 结构归并）。
//
// 本文件合并原 ids.js / view-state.js / scroll-state.js / page-state.js 四个
// 常驻微模块。它们同属 content 静态 chunk、消费方同一批，合并不改变分包
// 边界，只减少文件碎片与跨文件 import 噪音。
//
// 模块内按原籍分四节，保持原有导出符号名与行为不变；外部消费方统一从
// "./state.js" 导入。

// ===== ids.js：reader 私有 DOM id 表 =====
//
// 为什么聚合前独立成叶子：id 表被 UI 模板（ui/ui-renderer.js buildUiHtml）、
// 总结链（subtitle/ui.js）与 reader 域实现（video-bind/sync/lifecycle）三方
// 共享。若由 LAYOUT 域持有，常驻侧为取一份纯数据就得静态拖入整个
// LAYOUT 域。聚合后本文件仍是 content 静态 chunk 的轻量部分，不 import reader
// 域任何重实现。

export const ids = {
  root: "boc-root",
  // digest-only-ui：经典侧栏面板 ids（panel/status/meta/subtitleSelect/preview/
  // message/copyBtn/downloadBtn/refreshBtn/closeBtn/settingsBtn）已随 A 形态壳
  // 删除——Digest 面板是唯一界面，状态/消息写入 #boc-reading-status。
  readingView: "boc-reading-view",
  readingStatus: "boc-reading-status",
  readingCloseBtn: "boc-reading-close-btn",
  readingAutoScroll: "boc-reading-autoscroll",
  readingSubtitleVisible: "boc-reading-subtitle-visible",
  readingThemeSelect: "boc-reading-theme-select",
  readingSettingsBtn: "boc-reading-settings-btn",
  readingSettingsPanel: "boc-reading-settings-panel",
  readingChapterVisible: "boc-reading-chapter-visible",
  readingSubtitleSelect: "boc-reading-subtitle-select",
  readingSettingsHost: "boc-reading-settings-host",
  readingMeta: "boc-reading-meta",
  readingSubtitleList: "boc-reading-subtitle",
  readingSubtitleTailSpacer: "boc-reading-tail-spacer",
  // 统一 Digest 面板（PR2）：右侧面板壳 + 三标签（字幕/概览/AI 对话）分段控件。
  // 字幕列表（readingSubtitleList）整体挂进字幕 tab body；概览/AI 对话为诚实占位。
  readingDigestPanel: "boc-reading-digest-panel",
  readingTabSubtitle: "boc-reading-tab-subtitle",
  readingTabOverview: "boc-reading-tab-overview",
  readingTabChat: "boc-reading-tab-chat",
  readingTabBodySubtitle: "boc-reading-tabbody-subtitle",
  readingTabBodyOverview: "boc-reading-tabbody-overview",
  readingTabBodyChat: "boc-reading-tabbody-chat",
  // PR4 概览 tab 渲染宿主：reader/overview.ts 按状态机整块重建其内容
  //（idle/generating/ready/partial/error/empty，全诚实态）。
  readingOverviewBody: "boc-reading-overview-body",
  // PR3 字幕 tab 五件事：句内搜索、Copy/Export、Follow 悬浮按钮、转写中间态
  // 横幅、选区「解释」浮层与卡片、AI 对话 tab 的待解释意图卡。
  readingSearchInput: "boc-reading-search-input",
  readingSearchCount: "boc-reading-search-count",
  readingSearchPrevBtn: "boc-reading-search-prev",
  readingSearchNextBtn: "boc-reading-search-next",
  readingCopySubtitleBtn: "boc-reading-copy-subtitle",
  readingExportSubtitleBtn: "boc-reading-export-subtitle",
  readingFollowBtn: "boc-reading-follow-btn",
  readingTranscribeBanner: "boc-reading-transcribe-banner",
  readingTranscribeProgress: "boc-reading-transcribe-progress",
  readingExplainPop: "boc-reading-explain-pop",
  // 选区「解释」卡片宿主（面板内弹层；状态机与渲染在 reader/explain-card.ts）
  readingExplainCard: "boc-reading-explain-card",
  // PR3 占位期的待解释意图卡（PR5 起由对话 tab 组合根渲染/消费）
  readingChatIntent: "boc-reading-chat-intent",
  // PR5 AI 对话 tab（readingChat* 前缀，不用 sp 前缀）：对话区全部元素 id。
  // 结构与 sidepanel.html 的 sp* 树一一对应（context chip / 刷新 / 设置 / 新对话、
  // 转写提示行、消息区、模型/思考档/预设/历史、输入框、停止按钮），逻辑内核
  // 在 reader/chat-tab.ts（组合根）+ reader/chat-{lists,notices,popovers}.ts
  //（重建壳）+ ../chat/*（内核）。
  readingChatRoot: "boc-reading-chat",
  readingChatContextChip: "boc-reading-chat-context-chip",
  readingChatHistoryBtn: "boc-reading-chat-history-btn",
  readingChatRefreshBtn: "boc-reading-chat-refresh-btn",
  readingChatNewBtn: "boc-reading-chat-new-btn",
  readingChatOpenSettings: "boc-reading-chat-open-settings",
  readingChatAsrNotice: "boc-reading-chat-asr-notice",
  readingChatMessages: "boc-reading-chat-messages",
  readingChatSuggestions: "boc-reading-chat-suggestions",
  readingChatModelSelect: "boc-reading-chat-model-select",
  readingChatThinkingToggle: "boc-reading-chat-thinking-toggle",
  readingChatPresetBtn: "boc-reading-chat-preset-btn",
  readingChatPresetPopover: "boc-reading-chat-preset-popover",
  readingChatPresetList: "boc-reading-chat-preset-list",
  readingChatPresetInput: "boc-reading-chat-preset-input",
  readingChatPresetAddBtn: "boc-reading-chat-preset-add-btn",
  readingChatHistoryPopover: "boc-reading-chat-history-popover",
  readingChatHistoryList: "boc-reading-chat-history-list",
  readingChatHistoryClearBtn: "boc-reading-chat-history-clear-btn",
  readingChatInput: "boc-reading-chat-input",
  readingChatStopBtn: "boc-reading-chat-stop-btn"
};

// ===== view-state.js：阅读视图开关状态访问器 =====
//
// isReaderViewOpen 是纯 state 读取（state.reader.readingViewOpen），被
// ai/player-ai.js、subtitle/fetcher.js、core/message-handler.js 等域外模块
// 高频使用。聚合后仍只依赖 core/state.js 的常驻叶子，不触碰 reader 域
// 重符号。

import { state } from "../core/state.js";

export function isReaderViewOpen() {
  return state.reader.readingViewOpen;
}

// ===== scroll-state.js：阅读视图滚动状态共享叶子 =====
//
// 这是 SYNC（./sync.js）与 LAYOUT（./video-bind.js + ./digest-host.js）的共享
// 叶子：拥有手动滚动暂停与程序化滚动两个截止时间的唯一声明与读写函数。
// 放在独立叶子里，让 SYNC 与 LAYOUT 共享同一份状态而不需要访问器穿越
// reader-impl 的闭包 seam，也保持依赖图无环——本模块不 import reader 域内
// 任何其他模块（LAYOUT 仍然不得 import SYNC）。

let manualScrollPauseUntil = 0;    // readingManualScrollPauseUntil
let programmaticScrollUntil = 0;   // readingProgrammaticScrollUntil

export function isManualScrollPaused() {
  return Date.now() < manualScrollPauseUntil;
}

export function resetManualScrollPause() {
  manualScrollPauseUntil = 0;
}

export function isProgrammaticScrolling() {
  return Date.now() <= programmaticScrollUntil;
}

export function setManualScrollPaused(until: number) {
  manualScrollPauseUntil = until;
}

export function setProgrammaticScrollUntil(until: number) {
  programmaticScrollUntil = until;
}

// ===== 转写尾部留白（自 page-frame.js 并入） =====
//
// 消费方：batched-render 分批追加、lifecycle 的整段渲染，均属 reader 动态
// chunk，故随消费方落在本动态域聚合文件；此处不得 import 其他 reader 域模块
//（保持本文件只依赖 core/state 的既有边界）。
export function updateReadingSubtitleTailSpacer() {
  const spacer = document.getElementById(ids.readingSubtitleTailSpacer);
  if (!spacer) {
    return;
  }
  const subtitleList = document.getElementById(ids.readingSubtitleList);
  const hostHeight = subtitleList?.clientHeight || 0;
  const spacerHeight = Math.max(hostHeight, Math.round(window.innerHeight * 0.92), 320);
  // 候选10 批1 脏检查：现值与目标一致则跳写（250ms tick / 每帧追加都会调到）。
  // 读现值而非缓存快照：换新 spacer 节点（重建后 style.height 为空）或外部
  // 篡改时自动重写，无需额外的节点身份失效逻辑。
  if (spacer.style.height === `${spacerHeight}px`) {
    return;
  }
  spacer.style.height = `${spacerHeight}px`;
}

// ===== page-state.js：reader 页面状态守卫 =====
//
// 启动必需的三件套：clearReaderModePageState（清阅读模式页面标记）、
// enforceNormalPageStateIfNeeded（非阅读页状态收敛）、bindNormalPageStateGuard
// （MutationObserver 守卫）。它们全是「DOM 属性读写 + observer 注册」的轻操作，
// 依赖只有 core/state.js、bilibili/video-id-shared.js（isReaderMode）与
// ./presentation-fields.js（纯常量表）——均为常驻轻模块，不触碰 LAYOUT/SYNC/
// LIFECYCLE 的任何重符号，因此整体下沉为常驻，content.js init 无需为它们
// 动态装载 reader 域。

import { uiState } from "../core/state.js";
import { isReaderMode } from "../bilibili/video-id-shared.js";
import { READER_GUARD_CLEAR_ATTRS, READER_GUARD_FILTER } from "./presentation-fields.js";

export function clearReaderModePageState() {
  for (const attr of READER_GUARD_CLEAR_ATTRS.html) {
    document.documentElement.removeAttribute(attr);
  }
  for (const attr of READER_GUARD_CLEAR_ATTRS.body) {
    document.body.removeAttribute(attr);
  }
}

function shouldForceNormalPageState(url = location.href) {
  return !isReaderMode(url) && !state.reader.readingViewOpen;
}

export function enforceNormalPageStateIfNeeded(url = location.href) {
  if (!shouldForceNormalPageState(url)) {
    return;
  }
  clearReaderModePageState();
}

export function bindNormalPageStateGuard() {
  if (state.ui.normalPageStateGuardBound) {
    return;
  }
  uiState.setNormalPageStateGuardBound(true);

  const observer = new MutationObserver(() => {
    enforceNormalPageStateIfNeeded();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: READER_GUARD_FILTER.html
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: READER_GUARD_FILTER.body
  });
  enforceNormalPageStateIfNeeded();
}
