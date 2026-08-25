import { state } from "./state.js";

import {
  isReaderMode,
  isWatchlaterPage,
  startUrlWatcher,
  getErrorMessage,
  getSettings
} from "./router.js";

import {
  bindPlayerAiQuickActionLayoutEvents,
  startPlayerAiQuickActionObserver,
  schedulePlayerAiQuickActionSync
} from "./player-ai.js";

import { ensureUiReady } from "./panel.js";
import {
  clearReaderModePageState,
  bindNormalPageStateGuard
} from "./reader-page-frame.js";
import {
  logInfo,
  installReaderDebugHelpers,
  bindSettingsWatcher,
  hydrateReaderStateFromSettings,
  applyReadingViewPresentation,
  enterReaderMode,
  renderReadingStatus
} from "./reader-shell.js";

import { bindRuntimeEvents } from "./messages.js";

const BOC_VERSION = "1.1.4";
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
    state.settings = settings;
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
