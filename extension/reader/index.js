// Reader facade (issue 05).
//
// The reader domain's public, stable interface. External modules import reader
// capabilities ONLY from this file (plus the two established seams:
// ./page-context.js for pure multi-page resolution, ./presenter.js for the
// fetcher → reader notification channel).
//
// The modules below (./shell.js, ./page-frame.js, ./player-host.js,
// ./transcript-sync.js) are implementation details of the reader domain:
// they remain standalone files and keep their own exports, but external code
// must not import them directly. Internal wiring among them stays as-is and
// may be consolidated in a later step.

// 进入阅读模式
export { enterReaderMode } from "./shell.js";
// 退出阅读模式（关闭阅读视图并清理页面状态）
export { closeReadingView } from "./shell.js";
// 渲染阅读视图主体（章节/字幕/信息面板）
export { renderReadingView } from "./shell.js";
// 渲染阅读视图状态栏文案
export { renderReadingStatus } from "./shell.js";
// 设置阅读视图就绪标记（data-boc-reader-ready / aria-busy）
export { setReadingViewReady } from "./shell.js";
// 应用阅读排版与可见性设置到 DOM
export { applyReadingViewPresentation } from "./shell.js";
// 从设置初始化阅读状态
export { hydrateReaderStateFromSettings } from "./shell.js";
// 更新阅读偏好（状态 + DOM + 可选持久化）
export { updateReaderPreferences } from "./shell.js";
// 渲染阅读设置面板（开关/步进器状态）
export { renderReaderPanels } from "./shell.js";
// 渲染阅读信息面板（摘要/简介）
export { renderReadingInfoPanel } from "./shell.js";
// 构建设置面板中的阅读步进器控件 HTML
export { buildReaderStepperControl } from "./shell.js";
// 为步进器控件绑定点击交互
export { bindReaderStepperControl } from "./shell.js";
// 等待视频元数据（时长可用）就绪
export { waitForVideoMetadata } from "./shell.js";
// 注册 reader 侧渲染回调以响应 presenter 通知（subtitle-fetcher 数据就绪/重置/状态）
export { bindReaderPresenter } from "./shell.js";
// 阅读视图的播放同步：开始/停止/立即同步一次/交互挂起标记
export { startReadingViewSync } from "./transcript-sync.js";
export { stopReadingViewSync } from "./transcript-sync.js";
export { syncReadingViewPlayback } from "./transcript-sync.js";
export { noteManualReaderInteraction } from "./transcript-sync.js";
export { updateReaderFollowState } from "./transcript-sync.js";
// 阅读视图内的点击处理：章节 / 字幕项
export { onReadingChapterClick } from "./transcript-sync.js";
export { onReadingTranscriptClick } from "./transcript-sync.js";
// 播放器宿主挂载观察（阅读模式期间）
export { startReaderPlayerObserver } from "./player-host.js";
export { stopReaderPlayerObserver } from "./player-host.js";
// 页面级状态守卫（非阅读页清理阅读模式标记）
export { enforceNormalPageStateIfNeeded } from "./page-frame.js";
export { bindNormalPageStateGuard } from "./page-frame.js";
export { clearReaderModePageState } from "./page-frame.js";
// 阅读模式调试辅助（__BOC_READER_DEBUG_SNAPSHOT__ 等）
export { installReaderDebugHelpers } from "./shell.js";
// 阅读模式下的设置变更监听（chrome.storage.onChanged）
export { bindSettingsWatcher } from "./shell.js";
// reader 私有 DOM id 表（供 UI 模板与少量外部 DOM 操作使用）
export { ids } from "./shell.js";
// 日志（reader 域与外部共用，非 reader 专属能力）
export { logInfo, logWarn } from "../shared/logging.js";
