// Reader 私有 DOM id 表（候选02 分层惰性：自 page-frame.js 迁出的常驻微模块）。
//
// 为什么独立成叶子：id 表被 UI 模板（ui/ui-renderer.js buildUiHtml）、总结链
// （subtitle/ui.js）与 reader 域实现（page-frame/player-host/sync/lifecycle）
// 三方共享。若继续由 page-frame.js 持有，常驻侧为取一份纯数据就得静态拖入
// 整个 LAYOUT 域。本模块只含常量，不 import 任何 reader 域实现，静态图轻。
//
// 消费约定：常驻/链层直接 import 本文件；reader 域内实现经 page-frame.js 的
// re-export 取用（保持域内旧 import 路径不变）；facade（reader/index.js）对外
// 转发的仍是同一份对象。

// Reader-domain DOM id table (shared by the LAYOUT and LIFECYCLE modules; the
// facade re-exports it for UI templates and a few external DOM operations).
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
  readingTranscriptVisible: "boc-reading-transcript-visible",
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
  readingTranscriptList: "boc-reading-transcript",
  readingTranscriptTailSpacer: "boc-reading-tail-spacer"
};
