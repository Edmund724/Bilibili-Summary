// Reader facade (issue 05).
//
// The reader domain's public, stable interface. External modules import reader
// capabilities ONLY from this file (plus the established seams:
// ./page-context.js for pure multi-page resolution, ./presenter.js for the
// bidirectional reader ↔ subtitle-fetcher channel and ./scroll-state.js for
// the shared scroll-pause leaf).
//
// 候选02 分层惰性：本 facade 自候选02 起只在 ensureReaderDomain()（core/
// lazy-reader.js）的动态 import 边上装载——常驻侧的启动接线与轻呈现已拆往
// ./init-essentials.js、./presentation.js、./page-state.js、./ids.js、
// ./view-state.js（常驻微模块），消费方直接 import 那些文件，不再经本 facade。
// 本文件继续聚合 reader 域的重活（LAYOUT/SYNC/LIFECYCLE），并把已迁出的
// 符号按新家转发，保持对外接口与迁移前一致。
//
// Implementation modules behind the facade (issue 06+):
//   ./ports.js         LEAF      explicit callback port (LAYOUT→SYNC /
//                                SYNC→LIFECYCLE back-edges; registered by lifecycle)
//   ./page-frame.js    LAYOUT    page frame: DOM focus/pruning/inline host
//   ./player-host.js   LAYOUT    player mount/controls/observer + shared fns
//   ./sync.js          SYNC      playback↔transcript sync (depends on LAYOUT)
//   ./lifecycle.js     LIFECYCLE reader shell: lifecycle + render
//                               (depends on LAYOUT + SYNC)
// The dependency graph is acyclic: SYNC → LAYOUT, LIFECYCLE → SYNC + LAYOUT
// （ports.js 为零依赖叶子，承载逆依赖回调；lifecycle.js 启动时单点注册）。
// External code must not import these directly.
//
// Import-cycle note (issue 08): the reader implementation modules deliberately
// import nothing from core/runtime.js — they read reader DOM ids through local
// helpers and delegate settings persistence/loading to content.js through the
// presenter seam. This keeps the reader domain free of any static import path
// back through subtitle/fetcher.js.

// ===== lifecycle.js (reader shell): 生命周期 + 渲染 + presenter 处理体 =====

// 进入阅读模式
export { enterReaderMode } from "./lifecycle.js";
// 退出阅读模式（关闭阅读视图并清理页面状态）
export { closeReadingView } from "./lifecycle.js";
// 渲染阅读视图主体（章节/字幕/信息面板）
export { renderReadingView } from "./lifecycle.js";
// 等待视频元数据（时长可用）就绪
export { waitForVideoMetadata } from "./lifecycle.js";
// 阅读视图打开后的交互呈现（候选02：自 presentation.js 移回本域——常驻侧的
// ui-renderer 回调经 ensureReaderDomain 转发到这些导出）
export {
  updateReaderPreferences,
  renderReaderPanels,
  renderReadingInfoPanel,
  applyReaderStepperPreference
} from "./lifecycle.js";
// presenter seam 通知的 reader 侧处理体（候选02：注册接线迁往
// ./init-essentials.js 的 bindReaderPresenter，经 ensureReaderDomain 装载本域
// 后转发到这里）
export { handleReaderPresenterNotification } from "./lifecycle.js";
// 阅读模式调试快照真身（候选02：全局函数注册在 ./init-essentials.js，
// 经 ensureReaderDomain 装载本域后转发到这里）
export { createReaderDebugSnapshot } from "./lifecycle.js";

// ===== 常驻微模块转发（候选02 拆出；facade 对外接口不变） =====

// 启动接线（presenter 注册 / 调试辅助注册 / 设置监听）。常驻侧直接 import
// ./init-essentials.js；此处转发仅为维持 facade 接口完整（测试与动态装载方）。
export {
  bindReaderPresenter,
  installReaderDebugHelpers,
  bindSettingsWatcher
} from "./init-essentials.js";
// 排版/设置呈现的启动部分（状态栏文案、hydrate/apply、步进器模板与监听绑定；
// 交互呈现已移回 lifecycle.js，见上方导出）。
export {
  renderReadingStatus,
  hydrateReaderStateFromSettings,
  applyReadingViewPresentation,
  buildReaderStepperControl,
  bindReaderStepperControl
} from "./presentation.js";
// 页面状态守卫三件套（常驻侧直接 import ./page-state.js）。
export {
  enforceNormalPageStateIfNeeded,
  bindNormalPageStateGuard,
  clearReaderModePageState
} from "./page-state.js";
// reader 私有 DOM id 表（常驻微模块 ./ids.js；供 UI 模板与总结链共享）。
export { ids } from "./ids.js";
// 阅读视图开关状态查询（常驻微模块 ./view-state.js；player-ai/message-handler/
// fetcher 等域外高频读取方直接 import 该文件）。
export { isReaderViewOpen } from "./view-state.js";

// ===== LAYOUT 层：page-frame.js + player-host.js =====

// 阅读视图的播放器绑定（LAYOUT · player-host 域）
export { bindReadingViewVideo } from "./player-host.js";
// 停止播放器宿主挂载观察（启动由 LIFECYCLE/SYNC 在域内驱动，不经 facade）
export { stopReaderPlayerObserver } from "./player-host.js";
// 阅读视图手动滚动 / 程序化滚动的暂停状态函数移至 ./scroll-state.js 共享叶子，
// 不再经本 facade 转发；消费方（core/message-handler.js、ui/ui-renderer.js）
// 直接 import scroll-state.js。日志同理：直接 import ../shared/logging.js。
// 分P 解析同样不经 facade：消费方直接 import ./page-context.js（established seam）。

// ===== sync.js (SYNC): playback↔transcript sync =====

// 播放↔字幕同步域（原 transcript-sync.js 段，issue 06+）：定时器、滚动暂停、
// 章节/字幕点击跳转与跟随状态均来自 ./sync.js（依赖 LAYOUT 层 page-frame.js +
// player-host.js）。
// 高亮/滚动等仅域内使用的函数不再经 facade 转发。
export { startReadingViewSync } from "./sync.js";
export { stopReadingViewSync } from "./sync.js";
export { syncReadingViewPlayback } from "./sync.js";
export { jumpReadingTarget } from "./sync.js";
// seek 深入口（候选06）：阅读视图内点击与侧栏时间戳 seek 的唯一规范序入口
//（清暂停 → 设跟随 → currentTime → 同步；resumePlayback 参数化播放策略）。
export { seekReadingTarget } from "./sync.js";
export { onReadingChapterClick } from "./sync.js";
export { onReadingTranscriptClick } from "./sync.js";
export { noteManualReaderInteraction } from "./sync.js";
export { updateReaderFollowState } from "./sync.js";
