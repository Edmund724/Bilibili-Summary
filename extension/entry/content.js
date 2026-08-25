import { state } from "../core/state.js";
import { BOC_VERSION } from "../shared/version.js";

import { isReaderMode, isWatchlaterPage } from "../bilibili/url-utils.js";
import { startUrlWatcher, getSettings } from "../core/runtime.js";
import { getErrorMessage } from "../shared/error-helpers.js";

import {
  bindPlayerAiQuickActionLayoutEvents,
  startPlayerAiQuickActionObserver,
  schedulePlayerAiQuickActionSync
} from "../ai/player-ai.js";

import { ensureUiReady } from "../ui/ui-renderer.js";
import {
  clearReaderModePageState,
  bindNormalPageStateGuard
} from "../reader/page-frame.js";
import {
  logInfo,
  installReaderDebugHelpers,
  bindSettingsWatcher,
  hydrateReaderStateFromSettings,
  applyReadingViewPresentation,
  enterReaderMode,
  renderReadingStatus
} from "../reader/shell.js";

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
  try {
    sessionStorage.setItem("__BOC_URL_DIAG__", JSON.stringify({
      href: location.href,
      origin: location.origin,
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
      version: BOC_VERSION,
      timestamp: Date.now()
    }));
  } catch {
    // ignore
  }

  if (!isSupportedUrl()) {
    return;
  }

  console.log("[BOC][t01-diag] init start", {
    href: location.href,
    userAgent: navigator.userAgent
  });
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
