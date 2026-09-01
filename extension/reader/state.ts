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
// 总结链（subtitle/ui.js）与 reader 域实现（page-frame/player-host/sync/
// lifecycle）三方共享。若继续由 page-frame.js 持有，常驻侧为取一份纯数据
// 就得静态拖入整个 LAYOUT 域。聚合后本文件仍是 content 静态 chunk 的轻量
// 部分，不 import reader 域任何重实现。

export const ids = {
  root: "boc-root",
  panel: "boc-panel",
  status: "boc-status",
  meta: "boc-meta",
  subtitleSelect: "boc-subtitle-select",
  preview: "boc-preview",
  message: "boc-message",
  copyBtn: "boc-copy-btn",
  downloadBtn: "boc-download-btn",
  refreshBtn: "boc-refresh-btn",
  closeBtn: "boc-close-btn",
  settingsBtn: "boc-settings-btn",
  readingView: "boc-reading-view",
  readingPlayerSlot: "boc-reading-player-slot",
  readingStatus: "boc-reading-status",
  readingCloseBtn: "boc-reading-close-btn",
  readingRefreshBtn: "boc-reading-refresh-btn",
  readingAutoScroll: "boc-reading-autoscroll",
  readingSubtitleVisible: "boc-reading-subtitle-visible",
  readingThemeSelect: "boc-reading-theme-select",
  readingSettingsBtn: "boc-reading-settings-btn",
  readingSettingsPanel: "boc-reading-settings-panel",
  readingFontScaleSelect: "boc-reading-font-scale-select",
  readingLetterSpacingSelect: "boc-reading-letter-spacing-select",
  readingLineHeightSelect: "boc-reading-line-height-select",
  readingContentWidthSelect: "boc-reading-content-width-select",
  readingChapterVisibilitySelect: "boc-reading-chapter-visibility-select",
  readingChapterVisible: "boc-reading-chapter-visible",
  readingSubtitleSelect: "boc-reading-subtitle-select",
  readingInfoSummary: "boc-reading-info-summary",
  readingInfoDescription: "boc-reading-info-description",
  readingDescriptionBtn: "boc-reading-description-btn",
  readingMeta: "boc-reading-meta",
  readingChapterList: "boc-reading-chapters",
  readingSubtitleList: "boc-reading-subtitle",
  readingSubtitleTailSpacer: "boc-reading-tail-spacer"
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
// 这是 SYNC（./sync.js）与 LAYOUT（./page-frame.js + ./player-host.js）的共享
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
