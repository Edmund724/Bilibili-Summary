import { state } from "../core/state.js";
import { BOC_VERSION } from "../core/shared-defaults.js";

import { isReaderMode, isWatchlaterPage } from "../bilibili/video-id-shared.js";
import { startUrlWatcher, getSettings, sendRuntimeMessage } from "../core/runtime.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { logWarn } from "../shared/logging.js";

import {
  bindPlayerAiQuickActionLayoutEvents,
  startPlayerAiQuickActionObserver,
  schedulePlayerAiQuickActionSync,
  resetPlayerAiQuickActionRetryCount
} from "../ai/player-ai.js";

import { ensureUiReady } from "../ui/ui-renderer.js";
import {
  logInfo,
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

import { bindRuntimeEvents } from "../core/message-handler.js";

globalThis.__BOC_CONTENT_SCRIPT_LOADED__ = BOC_VERSION;

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
  // Reader settings persistence/loading live in core/runtime.js; reader-impl.js
  // must not import runtime (import cycle), so content.js wires the presenter
  // seam callbacks here.
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
    if (options && options.resetRetry) {
      resetPlayerAiQuickActionRetryCount();
    }
    schedulePlayerAiQuickActionSync(delayMs);
  });
  bindNormalPageStateGuard();
  bindPlayerAiQuickActionLayoutEvents();
  startUrlWatcher();
  getSettings().then((settings) => {
    state.setSettings(settings);
    hydrateReaderStateFromSettings(settings);
    applyReadingViewPresentation();
    startPlayerAiQuickActionObserver();
    schedulePlayerAiQuickActionSync();
    if (shouldEnterReaderMode) {
      enterReaderMode().catch((error) => {
        renderReadingStatus(`阅读视图启动失败：${getErrorMessage(error)}`);
      });
    }
  });
}
