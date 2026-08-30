// reader 域启动接线（候选02 分层惰性：自 lifecycle.js 迁出的常驻微模块）。
//
// content.js init() 需要在启动同步执行的三个 reader 接线函数。它们本身只是
// 「注册回调/全局钩子」的轻操作，但原先是 lifecycle.js 的导出——常驻侧为了
// 这三口接线就得静态拖入整个 reader 域。本模块把注册路径留在常驻，把真正的
// reader 域重活（debug 快照、presenter 通知处理）改成回调触发时经
// ensureReaderDomain() 动态装载。
//
// 依赖全部为常驻叶子（core/state、shared/logging、./presenter、
// ./presentation、./view-state、core/lazy-reader、./presentation-fields 纯常量），
// 不 import lifecycle/player-host/page-frame/sync。
import { state, uiState } from "../core/state.js";
import { logWarn } from "../shared/logging.js";
import {
  loadReaderSettingsThroughSeam,
  requestPlayerAiSync,
  subscribeReaderPresenter
} from "./presenter.js";
import {
  applyReadingViewPresentation,
  hydrateReaderStateFromSettings
} from "./presentation.js";
import { isReaderViewOpen } from "./view-state.js";
import { ensureReaderDomain, isReaderDomainLoaded } from "../core/lazy-reader.js";
// 候选06：监听键清单从呈现属性表派生（单一事实源 presentation-fields.js）。
// 相对旧手抄清单的修正与保留：
//   - 补进实际读写键 readerChapterVisible（旧清单盯的是改名前的旧键
//     readerChapterVisibility，属 8c2e4ff 改名后的手抄走样）；
//   - 旧键 readerChapterVisibility 仍在监听（settings-store 依旧归一化/落盘
//     它以兼容旧存储数据），经表的 legacyStorageKey 覆盖；
//   - enablePlayerAiQuickAction / playerAiQuickPrompt 两枚非呈现设置键以
//     kind:"settings" 收进表（无属性落位，只为本监听键清单服务）。
import { READER_SETTINGS_WATCH_KEYS } from "./presentation-fields.js";

// 阅读模式调试辅助（__BOC_READER_DEBUG_SNAPSHOT__ 等）。注册保持常驻轻量；
// 快照真身（createReaderDebugSnapshot，读播放器链布局/样式）在 reader 域内，
// 只在手动调用全局函数时才动态装载。未装载即调用会先拉起 reader 域——这是
// 显式的调试动作，装载成本可接受；装载失败按 null 快照落地并记日志。
export function installReaderDebugHelpers() {
  const snapshotReader = (label = "manual") =>
    ensureReaderDomain()
      .then((reader) => reader.createReaderDebugSnapshot(label))
      .catch((error) => {
        logWarn("[BOC] reader debug snapshot failed (reader domain load failed)", error);
        return null;
      });
  globalThis.__BOC_READER_DEBUG_SNAPSHOT__ = snapshotReader;
  globalThis.__BOC_DEBUG__ = {
    ...(globalThis.__BOC_DEBUG__ || {}),
    snapshotReader
  };
  globalThis.__BOC_FORCE_SYNC_PLAYER_AI__ = () => {
    requestPlayerAiSync(0, { resetRetry: true });
  };
}

// 阅读模式下的设置变更监听（chrome.storage.onChanged）。监听注册与回调里的
// state/settings 应用（hydrate/apply 已下沉 presentation 常驻微模块）全部
// 常驻轻量，无需触碰 reader 域重符号；函数体逐字搬自 lifecycle.js，行为零变化。
export function bindSettingsWatcher() {
  if (state.ui.settingsWatcherBound || !chrome.storage?.onChanged) {
    return;
  }
  uiState.setSettingsWatcherBound(true);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" && areaName !== "local") {
      return;
    }
    // 候选06：键清单表驱动（READER_SETTINGS_WATCH_KEYS = 全部 storageKey ∪
    // legacyStorageKey），不再手抄。
    if (!READER_SETTINGS_WATCH_KEYS.some((key) => changes[key])) {
      return;
    }

    loadReaderSettingsThroughSeam()
      .then((settings) => {
        state.setSettings(settings);
        hydrateReaderStateFromSettings(settings);
        applyReadingViewPresentation();
        requestPlayerAiSync();
      })
      .catch((error) => {
        logWarn("[BOC] failed to refresh settings after storage change", error);
      });
  });
}

// presenter seam 的 reader 侧注册：fetcher（总结链层）发布数据变更通知时，
// reader 域按需装载后处理。注册本身常驻；转发路径带两级门控——
//   1. reader 域未装载且阅读视图未打开 ⇒ 跳过：视图未打开 ⇒ 旧处理器在本域内
//      的动作（reset: 停同步/观察器/重试定时器——均未启动；subtitle-ready/
//      rerender: 发布方本就按 isReaderViewOpen 门控；status: 写隐藏状态栏文本，
//      无行为消费方）等价于 no-op，避免为一次空通知拉起 ~50KB reader 域。
//      不变式：视图打开 ⇒ enterReaderMode 已执行 ⇒ 域已装载，因此「未装载且
//      视图未打开」恰好覆盖全部可跳过通知；视图开着（含测试直接装载 facade
//      的路径）则放行走 ensure 装载。
//   2. subtitle-ready/rerender 且视图未打开 ⇒ 与旧处理器的 readingViewOpen
//      早退分支等价，跳过。
// 已装载（或视图打开）时经 ensureReaderDomain 转发，处理体在
// lifecycle.handleReaderPresenterNotification（原 bindReaderPresenter 回调体
// 原样搬移）。
export function bindReaderPresenter() {
  return subscribeReaderPresenter((kind, text) => {
    if (!isReaderDomainLoaded() && !isReaderViewOpen()) {
      return;
    }
    if ((kind === "subtitle-ready" || kind === "rerender") && !isReaderViewOpen()) {
      return;
    }
    ensureReaderDomain()
      .then((reader) => reader.handleReaderPresenterNotification(kind, text))
      .catch((error) => {
        logWarn("[BOC] reader presenter dispatch failed", { kind, error });
      });
  });
}
