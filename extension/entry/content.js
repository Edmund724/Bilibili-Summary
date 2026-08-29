import { state } from "../core/state.js";
import { BOC_VERSION } from "../core/defaults.js";

import { isReaderMode, isWatchlaterPage } from "../bilibili/video-id-shared.js";
import { getSettings } from "../core/runtime.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { logInfo, logWarn } from "../shared/logging.js";

// 播放器 AI 模块经加载器按需引入（候选4 分包）：默认关闭的设置对应的能力
// 不再常驻，start/stop/sync 全部走 loadPlayerAi() 的动态 import。
import { loadPlayerAi, isPlayerAiLoaded } from "../core/lazy-player-ai.js";

import { ensureUiReady } from "../ui/ui-renderer.js";
import {
  installReaderDebugHelpers,
  bindSettingsWatcher,
  bindReaderPresenter,
  hydrateReaderStateFromSettings,
  applyReadingViewPresentation,
  enterReaderMode,
  renderReadingStatus,
  clearReaderModePageState,
  bindNormalPageStateGuard
} from "../reader/index.js";

import {
  subscribeReaderSettingsPersist,
  subscribeReaderSettingsLoad,
  subscribePlayerAiSync
} from "../reader/presenter.js";

import { bindRuntimeEvents, bindUrlChangeHandler } from "../core/message-handler.js";

globalThis.__BOC_CONTENT_SCRIPT_LOADED__ = BOC_VERSION;

// 播放器 AI 开关监听只注册一次：init 在模块加载时同步执行，声明必须位于
// 其之前（避免 TDZ），标志兜底防重复注入。
let playerAiSettingsWatcherBound = false;

init();

function isSupportedUrl() {
  if (isReaderMode()) return true;
  if (isWatchlaterPage()) return true;
  if (/\/video\//.test(location.pathname)) return true;
  return false;
}

function init() {
  logInfo(`[BOC] content script loaded, version=${BOC_VERSION}`);
  if (!isSupportedUrl()) {
    return;
  }

  ensureUiReady({ forceRecreate: true });
  installReaderDebugHelpers();

  const shouldEnterReaderMode = isReaderMode();
  if (shouldEnterReaderMode) {
    document.documentElement.setAttribute("data-boc-reader-mode", "1");
    document.body.setAttribute("data-boc-reader-mode", "1");
  } else {
    clearReaderModePageState();
  }

  bindRuntimeEvents();
  bindSettingsWatcher();
  bindReaderPresenter();
  // Reader settings persistence (sendRuntimeMessage, shared/messaging.js) and
  // loading (getSettings, core/runtime.js) are outside the reader domain;
  // reader-impl.js must not import them (import cycle), so content.js wires
  // the presenter seam callbacks here.
  subscribeReaderSettingsPersist(() => {
    sendRuntimeMessage({ type: "save-settings", settings: state.settings }).catch((error) => {
      logWarn("[BOC] failed to persist reader settings", error);
    });
  });
  subscribeReaderSettingsLoad(() => getSettings());
  // Reader triggers player-ai quick-action sync through this seam instead of
  // importing ai/player-ai.js (which would pull core/runtime.js into the
  // reader dependency graph). The delayMs argument maps to
  // schedulePlayerAiQuickActionSync(delayMs); an undefined value keeps the
  // default 120ms delay. options.resetRetry mirrors the original
  // __BOC_FORCE_SYNC_PLAYER_AI__ behavior (only the debug helper resets the
  // retry counter before syncing).
  subscribePlayerAiSync((delayMs, options) => {
    // 未加载 = 快捷开关关闭态：按钮不存在，无需同步（start 自带初始 sync，
    // 开启后 reader 的同步请求自然恢复语义）。
    if (!isPlayerAiLoaded()) {
      return;
    }
    loadPlayerAi()
      .then((playerAi) => {
        if (options && options.resetRetry) {
          playerAi.resetPlayerAiQuickActionRetryCount();
        }
        playerAi.schedulePlayerAiQuickActionSync(delayMs);
      })
      .catch((error) => {
        logWarn("[BOC] player-ai sync via lazy loader failed", error);
      });
  });
  bindNormalPageStateGuard();
  // 播放器 AI 按钮的 layout 监听与 observer 改由 startPlayerAiQuickAction
  // 显式启动（见 getSettings().then 与 bindPlayerAiSettingsWatcher），
  // 默认关闭时不再无条件绑定。
  // URL 变化编排已搬到组合根（bindUrlChangeHandler）：监听 popstate/hashchange/
  // boc:urlchange 并按序编排；runtime.startUrlWatcher 由其内部调用，只负责
  // history 补丁与 boc:urlchange 广播。
  bindUrlChangeHandler();
  bindPlayerAiSettingsWatcher();
  getSettings().then((settings) => {
    state.setSettings(settings);
    hydrateReaderStateFromSettings(settings);
    applyReadingViewPresentation();
    // 按设置显式启停：默认关闭（core/defaults.js enablePlayerAiQuickAction:
    // false）时不绑 layout 监听、不挂 observer，避免关闭态每帧空转 no-op。
    // 懒加载语义：开启才触发模块加载；关闭时模块未加载即无任何残留可清理，
    // 加载过（isPlayerAiLoaded）才需要走 stop 收尾。
    if (settings.enablePlayerAiQuickAction) {
      startPlayerAiQuickActionLazy();
    } else {
      stopPlayerAiQuickActionLazy();
    }
    if (shouldEnterReaderMode) {
      enterReaderMode().catch((error) => {
        renderReadingStatus(`阅读视图启动失败：${getErrorMessage(error)}`);
      });
    }
  });
}

// 播放器 AI 开关存放在 chrome.storage.sync：监听该键变更动态启停，设置切换
// 无需刷新页面即可生效。
function bindPlayerAiSettingsWatcher() {
  if (playerAiSettingsWatcherBound) {
    return;
  }
  playerAiSettingsWatcherBound = true;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      areaName !== "sync" ||
      !Object.prototype.hasOwnProperty.call(changes, "enablePlayerAiQuickAction")
    ) {
      return;
    }
    const enabled = Boolean(changes.enablePlayerAiQuickAction.newValue);
    // syncPlayerAiQuickActionButton 读 state.settings，先同步该键再启停，
    // 不依赖 reader watcher（bindSettingsWatcher）的异步全量回读时序
    if (state.settings) {
      state.settings.enablePlayerAiQuickAction = enabled;
    }
    if (enabled) {
      startPlayerAiQuickActionLazy();
    } else {
      stopPlayerAiQuickActionLazy();
    }
  });
}

// ===== 懒加载边界 a（候选4 分包）：player-ai 的 start/stop 适配 =====
// 加载器语义：模块未加载时 stop/remove 都是 no-op（按钮只可能由该模块创建，
// 未加载 ⇒ 无残留），因此「关闭设置」分支只在已加载时才需要真正执行 stop。

function startPlayerAiQuickActionLazy() {
  loadPlayerAi()
    .then((playerAi) => {
      playerAi.startPlayerAiQuickAction();
    })
    .catch((error) => {
      logWarn("[BOC] player-ai module load failed (quick action not started)", error);
    });
}

function stopPlayerAiQuickActionLazy() {
  if (!isPlayerAiLoaded()) {
    return;
  }
  loadPlayerAi()
    .then((playerAi) => {
      playerAi.stopPlayerAiQuickAction();
    })
    .catch((error) => {
      logWarn("[BOC] player-ai stop after lazy load failed", error);
    });
}
