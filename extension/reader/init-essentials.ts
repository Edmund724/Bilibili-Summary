// reader 域启动接线（候选02 分层惰性：自 lifecycle.js 迁出的常驻微模块）。
//
// content.js init() 需要在启动同步执行的两个 reader 接线函数。它们本身只是
// 「注册回调/全局钩子」的轻操作，但原先是 lifecycle.js 的导出——常驻侧为了
// 这几口接线就得静态拖入整个 reader 域。本模块把注册路径留在常驻，把真正的
// reader 域重活（debug 快照）改成回调触发时经 ensureReaderDomain() 动态装载。
//
// presenter 通知的订阅不在本模块（原 bindReaderPresenter 已随双实例缺陷修复
// 搬进 reader/lifecycle.ts）：content 两轮构建把常驻底座在懒加载区重复一份，
// reader-bus 有两个实例，常驻侧订阅收不到懒加载区发布的通知。
//
// 依赖全部为常驻叶子（core/state、shared/logging、./reader-bus、
// ./presentation、./view-state、./lazy-reader、./presentation-fields 纯常量），
// 不 import lifecycle/sync 等 reader 域重实现。
import { state, uiState } from "../core/state.js";
import { logWarn } from "../shared/logging.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import {
  loadReaderSettingsThroughSeam,
  requestPlayerAiSync
} from "./reader-bus.js";
// 候选03 常驻瘦身：hydrate / apply 已惰性化，只在阅读视图打开时才需要应用。
import {
  applyReadingViewPresentation,
  hydrateReaderStateFromSettings
} from "./lazy-reader-presentation.js";
import { isReaderViewOpen } from "./state.js";
import { ensureReaderDomain } from "./lazy-reader.js";
import type * as DebugSnapshotModule from "./debug-snapshot.js";
// 候选06：监听键清单从呈现属性表派生（单一事实源 presentation-fields.js）。
// 相对旧手抄清单的修正与保留：
//   - 补进实际读写键 readerChapterVisible（旧清单盯的是改名前的旧键
//     readerChapterVisibility，属 8c2e4ff 改名后的手抄走样）；
//   - enablePlayerAiQuickAction / playerAiQuickPrompt 两枚非呈现设置键以
//     kind:"settings" 收进表（无属性落位，只为本监听键清单服务）。
//（三开关退役 2026-09：readerChapterVisible/Visibility/TranscriptVisible 键已
// 随滚动/字幕/章节开关删除，监听键只剩 readerTheme 与上述两枚 settings 键。）
import { READER_SETTINGS_WATCH_KEYS } from "./presentation-fields.js";
import type { Settings } from "../core/defaults.js";

// 阅读模式调试辅助（__BOC_READER_DEBUG_SNAPSHOT__ 等）。注册保持常驻轻量；
// 快照真身（createReaderDebugSnapshot，读播放器链布局/样式）在 reader 域内，
// 只在手动调用全局函数时才动态装载。未装载即调用会先拉起 reader 域——这是
// 显式的调试动作，装载成本可接受；装载失败按 null 快照落地并记日志。
export function installReaderDebugHelpers() {
  const snapshotReader = async (label = "manual") => {
    try {
      const reader = await ensureReaderDomain();
      return ((reader as unknown) as typeof DebugSnapshotModule).createReaderDebugSnapshot(label);
    } catch (error) {
      logWarn("[BOC] reader debug snapshot failed (reader domain load failed)", error);
      return null;
    }
  };
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

  // 候选06：键清单表驱动（READER_SETTINGS_WATCH_KEYS = 全部 storageKey ∪
  // legacyStorageKey），不再手抄；区/键过滤经 shared/watch-storage-keys seam
  //（R3 收口，sync+local 两区同一键清单）。
  watchStorageKeys(async (changes) => {
    try {
      const next = (await loadReaderSettingsThroughSeam()) as Settings;
      state.setSettings(next);
      // 候选03：阅读视图未打开时跳过呈现层应用；进入阅读模式时 enterReaderMode
      // 内部会 hydrate/apply，保证最终状态正确。视图开着则经惰性装载后应用
      //（fire-and-forget：不阻塞下方 requestPlayerAiSync，与迁移前启动链后
      // 同步触发 sync 的时序一致）。
      if (isReaderViewOpen()) {
        void (async () => {
          try {
            await hydrateReaderStateFromSettings(next);
            await applyReadingViewPresentation();
          } catch (error) {
            logWarn("[BOC] failed to apply reader presentation after storage change", error);
          }
        })();
      }
      requestPlayerAiSync();
    } catch (error) {
      logWarn("[BOC] failed to refresh settings after storage change", error);
    }
  }, { sync: READER_SETTINGS_WATCH_KEYS, local: READER_SETTINGS_WATCH_KEYS });
}
