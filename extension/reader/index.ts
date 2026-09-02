// Reader 动态域入口（lazy-reader 的 import() 落点）。
//
// 本文件是 core/lazy-reader.ts 动态 import("../reader/index.js") 的物理入口，
// esbuild 需要它作为 reader 动态 chunk 的入口模块。它不是 facade：外部模块对
// 静态/常驻符号（ids/view-state/scroll-state/page-state）应直接 import
// "./state.js"，本文件不再转发。
//
// 本文件只聚合 reader 动态域（LAYOUT/SYNC/LIFECYCLE）的导出，供 ensureReaderDomain()
// 装载后使用。依赖图保持无环：
//   ports.js        显式回调端口叶子
//   LAYOUT          page-frame.js + video-bind.js + digest-host.js → ports
//   SYNC            sync.js                                        → LAYOUT + ports
//   LIFECYCLE       lifecycle.js                                   → SYNC + LAYOUT + ports
// （ports.js 为零依赖叶子，承载逆依赖回调；lifecycle.js 启动时单点注册。
//   阶段 3 起 player-host/hover-chrome 随整页接管退役。）
//
// Import-cycle note (issue 08): the reader implementation modules deliberately
// import nothing from core/runtime.js — they read reader DOM ids through local
// helpers and delegate settings persistence/loading to content.js through the
// presenter seam. This keeps the reader domain free of any static import path
// back through subtitle/fetcher.js.

// ===== lifecycle.js（reader shell）：生命周期 + 渲染 + presenter 处理体 =====

// 进入阅读模式
export { enterReaderMode } from "./lifecycle.js";
// 退出阅读模式（关闭阅读视图并清理页面状态）
export { closeReadingView } from "./lifecycle.js";
// 渲染阅读视图主体（章节/字幕/信息面板）
export { renderReadingView } from "./lifecycle.js";
// 等待视频元数据（时长可用）就绪
export { waitForVideoMetadata } from "./lifecycle.js";
// 阅读视图打开后的交互呈现
export {
  updateReaderPreferences,
  renderReaderPanels,
  renderReadingInfoPanel,
  applyReaderStepperPreference
} from "./lifecycle.js";
// presenter seam 通知的 reader 侧处理体
export { handleReaderPresenterNotification } from "./lifecycle.js";
// 阅读模式调试快照真身
export { createReaderDebugSnapshot } from "./debug-snapshot.js";

// ===== LAYOUT 层：page-frame.js + video-bind.js + digest-host.js =====

// 阅读视图的播放器绑定（LAYOUT · video-bind 域，阶段 3 自 player-host 迁出）
export { bindReadingViewVideo } from "./video-bind.js";

// ===== sync.js (SYNC): playback↔subtitle sync =====

// 播放↔字幕同步域：定时器、滚动暂停、章节/字幕点击跳转与跟随状态均来自 ./sync.js
//（依赖 LAYOUT 层 page-frame.js + video-bind.js）。
export { startReadingViewSync } from "./sync.js";
export { stopReadingViewSync } from "./sync.js";
export { syncReadingViewPlayback } from "./sync.js";
export { jumpReadingTarget } from "./sync.js";
// seek 深入口（候选06）：阅读视图内点击与侧栏时间戳 seek 的唯一规范序入口
export { seekReadingTarget } from "./sync.js";
export { onReadingChapterClick } from "./sync.js";
export { onReadingSubtitleClick } from "./sync.js";
export { noteManualReaderInteraction } from "./sync.js";
export { updateReaderFollowState } from "./sync.js";
// PR3：Follow playback 悬浮按钮的恢复跟随回调
export { resumeReaderFollowPlayback } from "./sync.js";

// ===== PR3 字幕 tab：句内搜索 / 转写中间态横幅 =====

// 句内搜索：refresh（renderReadingView 尾部重放 + 输入变化）、move（上/下一条）、
// clear（closeReadingView 会话收尾）
export { refreshReadingSubtitleSearch, moveReadingSubtitleSearch, clearReadingSubtitleSearch } from "./subtitle-search.js";
// 转写中间态横幅：渲染尾部/tick 收敛（update）与转写中判定
export { updateReadingTranscribeBanner, isReaderTranscribing } from "./transcribe-banner.js";

// ===== PR4 概览 tab：状态机触达入口（ui-renderer 调用面） =====

// 概览 tab 切换入口（未生成自动触发 + 笔记快照刷新）、章节/金句点击与重试/
// 笔记按钮的事件委托、显式触发生成（重试走 forceRefresh 参数）、渲染收敛。
// 渲染尾部/打开触发/关闭清理由 lifecycle 直接 import overview.js，不经此处。
export {
  ensureReaderOverviewTab,
  onReadingOverviewClick,
  triggerReaderOverviewGeneration,
  renderReadingOverview
} from "./overview.js";
