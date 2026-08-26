// Reader facade (issue 05).
//
// The reader domain's public, stable interface. External modules import reader
// capabilities ONLY from this file (plus the established seams:
// ./page-context.js for pure multi-page resolution, ./presenter.js for the
// bidirectional reader ↔ subtitle-fetcher channel).
//
// ./reader-impl.js is the single deep implementation module that consolidates
// the former shell.js / page-frame.js / player-host.js / transcript-sync.js
// (issue 06). External code must not import it directly.
//
// Import-cycle note (issue 08): reader-impl.js deliberately imports nothing
// from core/runtime.js — it reads its own DOM ids through a local helper and
// delegates settings persistence/loading to content.js through the presenter
// seam. This keeps the reader domain free of any static import path back
// through subtitle/fetcher.js.

// 进入阅读模式
export { enterReaderMode } from "./reader-impl.js";
// 退出阅读模式（关闭阅读视图并清理页面状态）
export { closeReadingView } from "./reader-impl.js";
// 渲染阅读视图主体（章节/字幕/信息面板）
export { renderReadingView } from "./reader-impl.js";
// 渲染阅读视图状态栏文案
export { renderReadingStatus } from "./reader-impl.js";
// 设置阅读视图就绪标记（data-boc-reader-ready / aria-busy）
export { setReadingViewReady } from "./reader-impl.js";
// 应用阅读排版与可见性设置到 DOM
export { applyReadingViewPresentation } from "./reader-impl.js";
// 从设置初始化阅读状态
export { hydrateReaderStateFromSettings } from "./reader-impl.js";
// 更新阅读偏好（状态 + DOM + 可选持久化）
export { updateReaderPreferences } from "./reader-impl.js";
// 渲染阅读设置面板（开关/步进器状态）
export { renderReaderPanels } from "./reader-impl.js";
// 渲染阅读信息面板（摘要/简介）
export { renderReadingInfoPanel } from "./reader-impl.js";
// 构建设置面板中的阅读步进器控件 HTML
export { buildReaderStepperControl } from "./reader-impl.js";
// 为步进器控件绑定点击交互
export { bindReaderStepperControl } from "./reader-impl.js";
// 等待视频元数据（时长可用）就绪
export { waitForVideoMetadata } from "./reader-impl.js";
// 注册 reader 侧渲染回调以响应 presenter 通知（subtitle-fetcher 数据就绪/重置/状态）
export { bindReaderPresenter } from "./reader-impl.js";
// 阅读视图的播放同步：开始/停止/立即同步一次/交互挂起标记
export { startReadingViewSync } from "./reader-impl.js";
export { stopReadingViewSync } from "./reader-impl.js";
export { syncReadingViewPlayback } from "./reader-impl.js";
export { bindReadingViewVideo } from "./reader-impl.js";
export { noteManualReaderInteraction } from "./reader-impl.js";
export { updateReaderFollowState } from "./reader-impl.js";
// 阅读视图内的点击处理：章节 / 字幕项
export { onReadingChapterClick } from "./reader-impl.js";
export { onReadingTranscriptClick } from "./reader-impl.js";
export { jumpReadingTarget } from "./reader-impl.js";
// 播放器宿主挂载观察（阅读模式期间）
export { startReaderPlayerObserver } from "./reader-impl.js";
export { stopReaderPlayerObserver } from "./reader-impl.js";
// 页面级状态守卫（非阅读页清理阅读模式标记）
export { enforceNormalPageStateIfNeeded } from "./reader-impl.js";
export { bindNormalPageStateGuard } from "./reader-impl.js";
export { clearReaderModePageState } from "./reader-impl.js";
// 阅读模式调试辅助（__BOC_READER_DEBUG_SNAPSHOT__ 等）
export { installReaderDebugHelpers } from "./reader-impl.js";
// 阅读模式下的设置变更监听（chrome.storage.onChanged）
export { bindSettingsWatcher } from "./reader-impl.js";
// reader 私有 DOM id 表（供 UI 模板与少量外部 DOM 操作使用）
export { ids } from "./reader-impl.js";
// 阅读视图开关状态查询
export { isReaderViewOpen } from "./reader-impl.js";
// 阅读视图手动滚动暂停状态查询与重置
export { isManualScrollPaused, resetManualScrollPause } from "./reader-impl.js";
// 阅读视图程序化滚动状态查询
export { isProgrammaticScrolling } from "./reader-impl.js";
// 日志（reader 域与外部共用，非 reader 专属能力）
export { logInfo, logWarn } from "../shared/logging.js";
