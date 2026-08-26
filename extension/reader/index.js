// Reader facade (issue 05).
//
// The reader domain's public, stable interface. External modules import reader
// capabilities ONLY from this file (plus the established seams:
// ./page-context.js for pure multi-page resolution, ./presenter.js for the
// bidirectional reader ↔ subtitle-fetcher channel).
//
// Implementation modules behind the facade (issue 06+):
//   ./reader-impl.js   LAYOUT    page-frame + player-host + shared closure/ids
//   ./sync.js          SYNC      playback↔transcript sync (depends on LAYOUT)
//   ./lifecycle.js     LIFECYCLE reader shell: lifecycle + settings
//                               (depends on LAYOUT + SYNC)
// The dependency graph is acyclic: SYNC → LAYOUT, LIFECYCLE → SYNC + LAYOUT.
// External code must not import these directly.
//
// Import-cycle note (issue 08): the reader implementation modules deliberately
// import nothing from core/runtime.js — they read reader DOM ids through local
// helpers and delegate settings persistence/loading to content.js through the
// presenter seam. This keeps the reader domain free of any static import path
// back through subtitle/fetcher.js.

// ===== lifecycle.js (reader shell): lifecycle + settings =====

// 进入阅读模式
export { enterReaderMode } from "./lifecycle.js";
// 退出阅读模式（关闭阅读视图并清理页面状态）
export { closeReadingView } from "./lifecycle.js";
// 渲染阅读视图主体（章节/字幕/信息面板）
export { renderReadingView } from "./lifecycle.js";
// 渲染阅读视图状态栏文案（跨域共享，位于 LAYOUT 基座）
export { renderReadingStatus } from "./reader-impl.js";
// 设置阅读视图就绪标记（data-boc-reader-ready / aria-busy）
export { setReadingViewReady } from "./lifecycle.js";
// 应用阅读排版与可见性设置到 DOM
export { applyReadingViewPresentation } from "./lifecycle.js";
// 从设置初始化阅读状态
export { hydrateReaderStateFromSettings } from "./lifecycle.js";
// 更新阅读偏好（状态 + DOM + 可选持久化）
export { updateReaderPreferences } from "./lifecycle.js";
// 渲染阅读设置面板（开关/步进器状态）
export { renderReaderPanels } from "./lifecycle.js";
// 渲染阅读信息面板（摘要/简介）
export { renderReadingInfoPanel } from "./lifecycle.js";
// 构建设置面板中的阅读步进器控件 HTML
export { buildReaderStepperControl } from "./lifecycle.js";
// 为步进器控件绑定点击交互
export { bindReaderStepperControl } from "./lifecycle.js";
// 等待视频元数据（时长可用）就绪
export { waitForVideoMetadata } from "./lifecycle.js";
// 注册 reader 侧渲染回调以响应 presenter 通知（subtitle-fetcher 数据就绪/重置/状态）
export { bindReaderPresenter } from "./lifecycle.js";
// 阅读模式调试辅助（__BOC_READER_DEBUG_SNAPSHOT__ 等）
export { installReaderDebugHelpers } from "./lifecycle.js";
// 阅读模式下的设置变更监听（chrome.storage.onChanged）
export { bindSettingsWatcher } from "./lifecycle.js";

// ===== reader-impl.js (LAYOUT): page-frame + player-host + shared closure =====

// 阅读视图的播放器绑定（LAYOUT）
export { bindReadingViewVideo } from "./reader-impl.js";
// 播放器宿主挂载观察（阅读模式期间）
export { startReaderPlayerObserver } from "./reader-impl.js";
export { stopReaderPlayerObserver } from "./reader-impl.js";
// 页面级状态守卫（非阅读页清理阅读模式标记）
export { enforceNormalPageStateIfNeeded } from "./reader-impl.js";
export { bindNormalPageStateGuard } from "./reader-impl.js";
export { clearReaderModePageState } from "./reader-impl.js";
// reader 私有 DOM id 表（供 UI 模板与少量外部 DOM 操作使用）
export { ids } from "./reader-impl.js";
// 阅读视图开关状态查询
export { isReaderViewOpen } from "./reader-impl.js";
// 阅读视图手动滚动暂停状态查询与重置
export { isManualScrollPaused, resetManualScrollPause } from "./reader-impl.js";
// 阅读视图程序化滚动状态查询
export { isProgrammaticScrolling } from "./reader-impl.js";
// 阅读模式下的播放器宿主 / 布局闭包状态访问器（供 reader 域内部模块使用）
export { setVideoEventsBound, isVideoEventsBound, setManualScrollPaused, setProgrammaticScrollUntil } from "./reader-impl.js";
// 日志（reader 域与外部共用，非 reader 专属能力）
export { logInfo, logWarn } from "../shared/logging.js";

// ===== sync.js (SYNC): playback↔transcript sync =====

// 播放↔字幕同步域（原 transcript-sync.js 段，issue 06+）：定时器、滚动暂停、
// 章节/字幕点击跳转与跟随状态均来自 ./sync.js（依赖 reader-impl.js 的 LAYOUT）。
export { startReadingViewSync } from "./sync.js";
export { stopReadingViewSync } from "./sync.js";
export { syncReadingViewPlayback } from "./sync.js";
export { setActiveReadingItems } from "./sync.js";
export { scrollReadingRailItemIntoView } from "./sync.js";
export { scrollReadingTranscriptItemIntoView } from "./sync.js";
export { jumpReadingTarget } from "./sync.js";
export { onReadingChapterClick } from "./sync.js";
export { onReadingTranscriptClick } from "./sync.js";
export { noteManualReaderInteraction } from "./sync.js";
export { updateReaderFollowState } from "./sync.js";
