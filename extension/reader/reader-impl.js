// Reader implementation (issue 06).
//
// Single deep module consolidating the former shallow modules shell.js,
// page-frame.js, player-host.js and transcript-sync.js (all of which imported
// each other in a cycle). All reader-domain bookkeeping that is private to the
// reader domain lives here as module-level closure variables instead of
// state.reader; the facade ./index.js re-exports the public functions.
//
// Settings/shared flags (readingViewOpen, readingTheme, ...) and fields that
// external modules read or write (readingVideoEl, readingManualScrollPauseUntil,
// readingProgrammaticScrollUntil, readingDocumentClickBound) stay in state.reader.
import { state, uiState } from "../core/state.js";
import { logInfo, logWarn, shouldDebugLog } from "../shared/logging.js";
import {
  normalizeReaderTheme,
  normalizeReaderFontScale,
  normalizeReaderLetterSpacing,
  normalizeReaderLineHeight,
  normalizeReaderContentWidth,
  normalizeReaderTranscriptVisible,
  sleep
} from "../core/shared-defaults.js";
import { isReaderMode, isWatchlaterPage, cleanVideoUrl } from "../bilibili/url-utils.js";
import { byId, sendRuntimeMessage, getSettings } from "../core/runtime.js";
import { findReaderPlayerHost, getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { getErrorMessage, isStaleRunError } from "../shared/error-helpers.js";
import {
  getReadingTranscriptItems,
  getReadingTranscriptPlaceholderText,
  findActiveSubtitleIndex,
  findActiveChapterIndex
} from "../subtitle/core.js";
import {
  normalizeChapters,
  isAiSubtitle
} from "../subtitle/selection.js";
import {
  escapeHtml,
  formatCompactTimestamp
} from "../shared/string-utils.js";
import {
  shouldShowHoursInNote
} from "../notes/render.js";
import {
  resetPlayerAiQuickActionRetryCount,
  schedulePlayerAiQuickActionSync
} from "../ai/player-ai.js";
import { isVisibleReaderControl } from "../ai/player-ai.js";
import { refreshClip } from "../subtitle/fetcher.js";
import { subscribeReaderPresenter } from "./presenter.js";
import * as pageContext from "./page-context.js";

// ===== reader-domain private bookkeeping (module-level closure state) =====
//
// These were state.reader fields before issue 06; no module outside
// extension/reader/ reads or writes them, so they are hoisted here.
// Issue 07 removed the corresponding dead fields from state.js.
// readingVideoEl is not hoisted here: it is a cross-module shared field
// (video-probe reads, fetcher nulls it, reader writes it when binding or
// unbinding the video), so state.reader stays its single source of truth.
let syncTimer = 0;                 // readingSyncTimer
let playerHost = null;             // readingPlayerHost
let mainOriginalParent = null;     // readingMainOriginalParent
let mainOriginalNextSibling = null;// readingMainOriginalNextSibling
let playerAdjustedNodes = [];      // readingPlayerAdjustedNodes
let playerObserver = null;         // readingPlayerObserver
let playerMountTimer = 0;          // readingPlayerMountTimer
let playerRetryTimer = 0;          // readingPlayerRetryTimer
let miniDismissTimer = 0;          // readingMiniDismissTimer
let controlsHideTimer = 0;         // readingControlsHideTimer
let controlsRecoveryTimer = 0;     // readingControlsRecoveryTimer
let controlsRecoveryInFlight = false; // readingControlsRecoveryInFlight
let controlsLastRecoverAt = 0;     // readingControlsLastRecoverAt
let controlsHoverHost = null;      // readingControlsHoverHost
let headerHoverHost = null;        // readingHeaderHoverHost
let headerHideTimer = 0;           // readingHeaderHideTimer
let videoEventsBound = false;      // readingVideoEventsBound
let layoutBound = false;           // readingLayoutBound
let documentClickBound = false;    // readingDocumentClickBound
let manualScrollPauseUntil = 0;    // readingManualScrollPauseUntil
let programmaticScrollUntil = 0;   // readingProgrammaticScrollUntil

// ===== shell.js (reader shell) =====

export function maybeRefreshReaderSubtitleInBackground() {
  if (state.clip.subtitleBody.length) {
    return;
  }
  waitForVideoMetadata().then(() => {
    refreshClip().catch((error) => {
      if (!isStaleRunError(error)) {
        renderReadingStatus(`字幕加载失败：${getErrorMessage(error)}`);
      }
    });
  });
}

// Subtitle fetcher publishes reader data changes through the presenter seam;
// the reader side registers a single handler that performs the rendering.
export function bindReaderPresenter() {
  return subscribeReaderPresenter((kind, text) => {
    switch (kind) {
      case "reset":
        stopReadingViewSync();
        stopReaderPlayerObserver();
        break;
      case "subtitle-ready":
        if (state.reader.readingViewOpen) {
          moveReadingMainInline();
          renderReadingView();
          renderReadingStatus(String(text || "") || "抓取完成，阅读视图已同步最新字幕。");
          startReadingViewSync();
          startReaderPlayerObserver();
          syncReadingViewPlayback(true);
        }
        break;
      case "rerender":
        if (state.reader.readingViewOpen) {
          renderReadingView();
        }
        break;
      case "status":
        renderReadingStatus(String(text || ""));
        break;
      default:
        break;
    }
  });
}

export { logInfo, logWarn, shouldDebugLog } from "../shared/logging.js";

export function installReaderDebugHelpers() {
  const snapshotReader = (label = "manual") => createReaderDebugSnapshot(label);
  globalThis.__BOC_READER_DEBUG_SNAPSHOT__ = snapshotReader;
  globalThis.__BOC_DEBUG__ = {
    ...(globalThis.__BOC_DEBUG__ || {}),
    snapshotReader
  };
  globalThis.__BOC_FORCE_SYNC_PLAYER_AI__ = () => {
    resetPlayerAiQuickActionRetryCount();
    schedulePlayerAiQuickActionSync(0);
  };
}

export const ids = {
  root: "boc-root",
  panel: "boc-panel",
  status: "boc-status",
  meta: "boc-meta",
  subtitleSelect: "boc-subtitle-select",
  preview: "boc-preview",
  message: "boc-message",
  copyBtn: "boc-copy-btn",
  downloadBtn: "boc-download-btn",
  refreshBtn: "boc-refresh-btn",
  closeBtn: "boc-close-btn",
  settingsBtn: "boc-settings-btn",
  readingView: "boc-reading-view",
  readingPlayerSlot: "boc-reading-player-slot",
  readingStatus: "boc-reading-status",
  readingCloseBtn: "boc-reading-close-btn",
  readingRefreshBtn: "boc-reading-refresh-btn",
  readingAutoScroll: "boc-reading-autoscroll",
  readingTranscriptVisible: "boc-reading-transcript-visible",
  readingThemeSelect: "boc-reading-theme-select",
  readingSettingsBtn: "boc-reading-settings-btn",
  readingSettingsPanel: "boc-reading-settings-panel",
  readingFontScaleSelect: "boc-reading-font-scale-select",
  readingLetterSpacingSelect: "boc-reading-letter-spacing-select",
  readingLineHeightSelect: "boc-reading-line-height-select",
  readingContentWidthSelect: "boc-reading-content-width-select",
  readingChapterVisibilitySelect: "boc-reading-chapter-visibility-select",
  readingChapterVisible: "boc-reading-chapter-visible",
  readingSubtitleSelect: "boc-reading-subtitle-select",
  readingInfoSummary: "boc-reading-info-summary",
  readingInfoDescription: "boc-reading-info-description",
  readingDescriptionBtn: "boc-reading-description-btn",
  readingMeta: "boc-reading-meta",
  readingChapterList: "boc-reading-chapters",
  readingTranscriptList: "boc-reading-transcript",
  readingTranscriptTailSpacer: "boc-reading-tail-spacer"
};

export function bindSettingsWatcher() {
  if (state.ui.settingsWatcherBound || !chrome.storage?.onChanged) {
    return;
  }
  uiState.setSettingsWatcherBound(true);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" && areaName !== "local") {
      return;
    }
    if (
      !changes.enablePlayerAiQuickAction &&
      !changes.playerAiQuickPrompt &&
      !changes.readerTheme &&
      !changes.readerFontScale &&
      !changes.readerLetterSpacing &&
      !changes.readerLineHeight &&
      !changes.readerContentWidth &&
      !changes.readerChapterVisibility &&
      !changes.readerTranscriptVisible
    ) {
      return;
    }

    getSettings()
      .then((settings) => {
        state.setSettings(settings);
        hydrateReaderStateFromSettings(settings);
        applyReadingViewPresentation();
        schedulePlayerAiQuickActionSync();
      })
      .catch((error) => {
        logWarn("[BOC] failed to refresh settings after storage change", error);
      });
  });
}
export function renderReadingSubtitleSelect() {
  const select = byId(ids.readingSubtitleSelect);
  const subtitles = state.clip.subtitles || [];

  if (subtitles.length === 0) {
    select.innerHTML = '<option value="">暂无字幕</option>';
    select.disabled = true;
    return;
  }

  select.innerHTML = subtitles
    .map((item) => {
      const selectedById =
        state.clip.selectedSubtitleId && String(item.id) === String(state.clip.selectedSubtitleId);
      const selectedByUrl = item.subtitleUrl === state.clip.selectedSubtitleUrl;
      const selected = selectedById || selectedByUrl ? "selected" : "";
      const label = item.lanDoc || item.lan || "unknown";
      const isAi = isAiSubtitle(item);
      const aiTag = isAi ? " [AI]" : "";
      const optionLabel = `${label}${aiTag}`;
      return `<option value="${escapeHtml(item.subtitleUrl)}" data-lang="${escapeHtml(
        label
      )}" data-id="${escapeHtml(String(item.id || ""))}" data-isai="${isAi}" ${selected}>${escapeHtml(
        optionLabel
      )}</option>`;
    })
    .join("");
  select.disabled = false;
}
export async function enterReaderMode() {
  const readingView = byId(ids.readingView);
  state.reader.setViewOpen(true);
  state.reader.setNativePageMode(true);
  document.body.setAttribute("data-boc-reading-active", "1");
  hydrateReaderStateFromSettings(state.settings);
  applyReadingViewPresentation();
  alignReaderViewportToPlayer();
  await sleep(0);
  openReaderViewShell(readingView);
  applyReaderPageFocus();
  renderReadingView();

  const earlyPlayerHost = findReaderPlayerHost(getRuntimeVideoElement());
  if (earlyPlayerHost) {
    earlyPlayerHost.setAttribute("data-boc-reader-fading", "1");
  }

  await sleep(0);

  // Try to mount player, with more retries for slower pages (like watch later)
  const mounted = await ensureReaderPlayerMounted({ retries: 50, delayMs: 150, forceLayout: true });
  const mountedPlayerHost = playerHost || earlyPlayerHost;
  if (mountedPlayerHost) {
    mountedPlayerHost.removeAttribute("data-boc-reader-fading");
  }
  if (!mounted) {
    // Don't throw - keep UI open and keep retrying in background
    renderReadingStatus("正在等待视频播放器就绪...");
    scheduleReaderPlayerRetry();
    return;
  }

  finishEnterReaderMode();
}

export function scheduleReaderPlayerRetry() {
  if (playerRetryTimer) {
    window.clearTimeout(playerRetryTimer);
    playerRetryTimer = 0;
  }
  // Keep trying to mount player in background
  const tryMount = async () => {
    playerRetryTimer = 0;
    if (!state.reader.readingViewOpen || !isReaderMode()) return;
    const mounted = await ensureReaderPlayerMounted({ retries: 10, delayMs: 200, forceLayout: true });
    const retryHost = playerHost;
    if (retryHost) {
      retryHost.removeAttribute("data-boc-reader-fading");
    }
    if (mounted) {
      finishEnterReaderMode();
    } else if (state.reader.readingViewOpen) {
      playerRetryTimer = window.setTimeout(tryMount, 500);
    }
  };
  playerRetryTimer = window.setTimeout(tryMount, 500);
}

export function finishEnterReaderMode() {
  if (!state.reader.readingViewOpen || !isReaderMode()) return;

  alignReaderViewportToPlayer();
  moveReadingMainInline();
  scheduleReaderMiniPlayerDismiss();
  maybeRefreshReaderSubtitleInBackground();
  syncReaderModeAfterMount();
  settleReaderModePresentation();
  bindReaderHeaderActionsHover();
}

export function openReaderViewShell(readingView = byId(ids.readingView)) {
  if (!readingView) {
    return;
  }
  readingView.classList.add("open", "reader-page");
  readingView.setAttribute("aria-hidden", "false");
  setReadingViewReady(false);
  renderReadingStatus("正在准备播放器和字幕...");
}

export function waitForVideoMetadata(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const video = getRuntimeVideoElement();
      const duration = Number(video?.duration);
      const ready = video && Number.isFinite(duration) && duration > 0;
      if (ready || Date.now() - start >= timeoutMs) {
        resolve();
        return;
      }
      window.setTimeout(check, 150);
    };
    check();
  });
}

export function syncReaderModeAfterMount() {
  startReadingViewSync();
  startReaderPlayerObserver();
  layoutReaderPlayerHost();
  syncReadingViewPlayback(true);
  updateReaderFollowState();
}

export function settleReaderModePresentation() {
  if (!isReaderPresentationStable()) {
    setReadingViewReady(false);
    renderReadingStatus("正在稳定播放器布局...");
    scheduleReaderPlayerRetry();
    return false;
  }
  setReadingViewReady(true);
  renderReadingStatus("阅读视图已就绪，播放视频时字幕会自动高亮。");
  return true;
}

export function closeReaderCleanup() {
  if (controlsRecoveryTimer) {
    window.clearTimeout(controlsRecoveryTimer);
    controlsRecoveryTimer = 0;
  }
  controlsRecoveryInFlight = false;
}

export function closeReadingView() {
  cleanupReaderFloatingArtifacts();
  state.reader.setViewOpen(false);
  state.reader.setNativePageMode(false);
  state.reader.setViewReady(false);
  state.reader.setSettingsExpanded(false);
  manualScrollPauseUntil = 0;
  programmaticScrollUntil = 0;
  state.reader.setNextScrollBehavior("smooth");
  if (playerRetryTimer) {
    window.clearTimeout(playerRetryTimer);
    playerRetryTimer = 0;
  }
  const readingView = byId(ids.readingView);
  readingView.classList.remove("open", "reader-page");
  readingView.setAttribute("aria-hidden", "true");
  readingView.setAttribute("data-boc-reader-ready", "0");
  readingView.removeAttribute("data-boc-reader-follow");
  document.body.removeAttribute("data-boc-reading-active");
  document.documentElement.removeAttribute("data-boc-reader-mode");
  document.body.removeAttribute("data-boc-reader-mode");
  document.documentElement.removeAttribute("data-boc-reader-theme");
  document.documentElement.removeAttribute("data-boc-reader-font-scale");
  document.documentElement.removeAttribute("data-boc-reader-letter-spacing");
  document.documentElement.removeAttribute("data-boc-reader-line-height");
  document.documentElement.removeAttribute("data-boc-reader-content-width");
  document.documentElement.removeAttribute("data-boc-reader-chapter-visibility");
  document.documentElement.removeAttribute("data-boc-reader-has-chapters");
  document.body.removeAttribute("data-boc-reader-theme");
  document.body.removeAttribute("data-boc-reader-font-scale");
  document.body.removeAttribute("data-boc-reader-letter-spacing");
  document.body.removeAttribute("data-boc-reader-line-height");
  document.body.removeAttribute("data-boc-reader-content-width");
  document.body.removeAttribute("data-boc-reader-chapter-visibility");
  document.body.removeAttribute("data-boc-reader-has-chapters");
  restoreReadingMainInline();
  stopReadingViewSync();
  unbindReaderLayout();
  cleanupReaderPlayerHost();
  clearReaderPageFocus();
  const sendingBar = document.querySelector(".bpx-player-sending-bar");
  if (sendingBar) {
    sendingBar.setAttribute("data-boc-reader-hide-sending-bar", "1");
    sendingBar.style.setProperty("display", "none", "important");
    window.setTimeout(() => {
      sendingBar.style.removeProperty("display");
      sendingBar.removeAttribute("data-boc-reader-hide-sending-bar");
    }, 200);
  }
  window.setTimeout(() => cleanupReaderFloatingArtifacts(), 40);
  window.setTimeout(() => cleanupReaderFloatingArtifacts(), 220);
}

export function renderReadingView() {
  const titleNode = document.querySelector(".boc-reading-title");
  const metaNode = byId(ids.readingMeta);
  const chapterList = byId(ids.readingChapterList);
  const transcriptList = byId(ids.readingTranscriptList);
  const chapters = normalizeChapters(state.clip.chapters || []);
  const body = Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
  const transcriptItems = getReadingTranscriptItems();
  const withHours = shouldShowHoursInNote(state, body);
  const hasChapters = chapters.length > 0;

  if (titleNode) {
    titleNode.textContent = state.clip.title || "B站字幕阅读";
  }
  if (metaNode) {
    metaNode.textContent = buildReadingMetaLine();
  }

  if (chapters.length === 0) {
    chapterList.innerHTML = '<div class="boc-reading-empty">当前视频没有章节。</div>';
  } else {
    chapterList.innerHTML = chapters
      .map(
        (item, index) => `
          <button
            type="button"
            class="boc-reading-chapter"
            data-index="${index}"
            data-seconds="${Number(item.from || 0) || 0}"
          >
            <span class="boc-reading-chapter-time">${escapeHtml(
              formatCompactTimestamp(item.from, withHours)
            )}</span>
            <span class="boc-reading-chapter-title">${escapeHtml(item.title)}</span>
          </button>
        `
      )
      .join("");
  }

  if (transcriptItems.length === 0) {
    transcriptList.innerHTML = `<div class="boc-reading-empty">${escapeHtml(
      getReadingTranscriptPlaceholderText()
    )}</div>`;
  } else {
    transcriptList.innerHTML = transcriptItems
      .map(
        (item) => `
          <button
            type="button"
            class="boc-reading-item"
            data-index="${item.index}"
            data-seconds="${item.from}"
          >
            <span class="boc-reading-time">${escapeHtml(
              formatCompactTimestamp(item.from, withHours)
            )}</span>
            <span class="boc-reading-text">${escapeHtml(item.content)}</span>
          </button>
        `
      )
      .join("");
    transcriptList.insertAdjacentHTML(
      "beforeend",
      `<div id="${ids.readingTranscriptTailSpacer}" class="boc-reading-tail-spacer" aria-hidden="true"></div>`
    );
  }

  updateReaderChapterPresence(hasChapters);
  renderReadingInfoPanel();
  renderReadingSubtitleSelect();
  renderReaderPanels();
  applyReadingViewPresentation();
  updateReadingTranscriptTailSpacer();
  state.reader.setActiveSubtitleIndex(-1);
  state.reader.setActiveChapterIndex(-1);
}

export function updateReadingTranscriptTailSpacer() {
  const spacer = document.getElementById(ids.readingTranscriptTailSpacer);
  if (!spacer) {
    return;
  }
  const inlineHost = document.getElementById("boc-reading-inline-host");
  const transcriptList = document.getElementById(ids.readingTranscriptList);
  const hostHeight = inlineHost?.clientHeight || transcriptList?.clientHeight || 0;
  const spacerHeight = Math.max(hostHeight, Math.round(window.innerHeight * 0.92), 320);
  spacer.style.height = `${spacerHeight}px`;
}

export function hydrateReaderStateFromSettings(settings = state.settings) {
  state.reader.setTheme(normalizeReaderTheme(settings?.readerTheme));
  state.reader.setFontScale(normalizeReaderFontScale(settings?.readerFontScale));
  state.reader.setLetterSpacing(normalizeReaderLetterSpacing(settings?.readerLetterSpacing ?? settings?.readerLineHeight));
  state.reader.setLineHeight(normalizeReaderLineHeight(settings?.readerLineHeight));
  state.reader.setContentWidth(normalizeReaderContentWidth(settings?.readerContentWidth));
  state.reader.setChapterVisible(settings?.readerChapterVisible !== undefined ? Boolean(settings.readerChapterVisible) : true);
  state.reader.setTranscriptVisible(normalizeReaderTranscriptVisible(settings?.readerTranscriptVisible));
}

export function applyReadingViewPresentation() {
  const readingView = byId(ids.readingView);
  readingView.dataset.theme = state.reader.readingTheme;
  readingView.dataset.fontScale = state.reader.readingFontScale;
  readingView.dataset.letterSpacing = state.reader.readingLetterSpacing;
  readingView.dataset.lineHeight = state.reader.readingLineHeight;
  readingView.dataset.contentWidth = state.reader.readingContentWidth;
  readingView.dataset.chapterVisibility = state.reader.readingChapterVisible ? "auto" : "hide";
  readingView.dataset.transcriptVisible = state.reader.readingTranscriptVisible ? "1" : "0";
  document.documentElement.dataset.bocReaderTheme = state.reader.readingTheme;
  document.documentElement.dataset.bocReaderFontScale = state.reader.readingFontScale;
  document.documentElement.dataset.bocReaderLetterSpacing = state.reader.readingLetterSpacing;
  document.documentElement.dataset.bocReaderLineHeight = state.reader.readingLineHeight;
  document.documentElement.dataset.bocReaderContentWidth = state.reader.readingContentWidth;
  document.documentElement.dataset.bocReaderChapterVisibility = state.reader.readingChapterVisible ? "auto" : "hide";
  document.documentElement.dataset.bocReaderTranscriptVisible = state.reader.readingTranscriptVisible ? "1" : "0";
  document.body.dataset.bocReaderTheme = state.reader.readingTheme;
  document.body.dataset.bocReaderFontScale = state.reader.readingFontScale;
  document.body.dataset.bocReaderLetterSpacing = state.reader.readingLetterSpacing;
  document.body.dataset.bocReaderLineHeight = state.reader.readingLineHeight;
  document.body.dataset.bocReaderContentWidth = state.reader.readingContentWidth;
  document.body.dataset.bocReaderChapterVisibility = state.reader.readingChapterVisible ? "auto" : "hide";
  document.body.dataset.bocReaderTranscriptVisible = state.reader.readingTranscriptVisible ? "1" : "0";
  const readingChapterVisibleEl = byId(ids.readingChapterVisible);
  if (readingChapterVisibleEl) {
    readingChapterVisibleEl.checked = state.reader.readingChapterVisible;
  }
  const main = document.querySelector(".boc-reading-main");
  if (main) {
    main.style.display = state.reader.readingTranscriptVisible ? "" : "none";
  }
  applyInlineHostPresentation();
}

export function updateReaderChapterPresence(hasChapters) {
  const value = hasChapters ? "1" : "0";
  const readingView = byId(ids.readingView);
  readingView.dataset.hasChapters = value;
  document.documentElement.dataset.bocReaderHasChapters = value;
  document.body.dataset.bocReaderHasChapters = value;
}

export function getToggleLabel(key, value) {
  const labels = {
    fontScale: { xs: "最小", s: "偏小", m: "标准", l: "偏大", xl: "最大" },
    letterSpacing: { tighter: "最紧", tight: "偏紧", normal: "标准", relaxed: "偏松", loose: "最松" },
    lineHeight: { compact: "最紧", tight: "偏紧", normal: "标准", relaxed: "偏松", loose: "最松" },
    contentWidth: { compact: "最窄", narrow: "偏窄", medium: "标准", wide: "偏宽", full: "最宽" }
  };
  return labels[key]?.[value] || "标准";
}

export function getReaderStepperConfig(settingKey) {
  const configs = {
    readerFontScale: {
      options: ["xs", "s", "m", "l", "xl"],
      labelKey: "fontScale",
      getCurrent: () => state.reader.readingFontScale,
      buildPayload: (value) => ({ readerFontScale: value })
    },
    readerLetterSpacing: {
      options: ["tighter", "tight", "normal", "relaxed", "loose"],
      labelKey: "letterSpacing",
      getCurrent: () => state.reader.readingLetterSpacing,
      buildPayload: (value) => ({ readerLetterSpacing: value })
    },
    readerLineHeight: {
      options: ["compact", "tight", "normal", "relaxed", "loose"],
      labelKey: "lineHeight",
      getCurrent: () => state.reader.readingLineHeight,
      buildPayload: (value) => ({ readerLineHeight: value })
    },
    readerContentWidth: {
      options: ["compact", "narrow", "medium", "wide", "full"],
      labelKey: "contentWidth",
      getCurrent: () => state.reader.readingContentWidth,
      buildPayload: (value) => ({ readerContentWidth: value })
    }
  };
  return configs[settingKey] || null;
}

export function buildReaderStepperControl({
  id,
  title,
  settingKey
}) {
  const config = getReaderStepperConfig(settingKey);
  if (!config) {
    return "";
  }
  return `
    <div id="${id}" class="boc-reading-stepper" data-reader-setting-id="${id}">
      <span class="boc-reading-stepper-title">${escapeHtml(title)}</span>
      <div class="boc-reading-stepper-buttons" role="group" aria-label="${escapeHtml(title)}">
        ${config.options
          .map(
            (option, index) => `
          <button
            type="button"
            class="boc-reading-stepper-btn"
            data-value="${escapeHtml(option)}"
            aria-label="${escapeHtml(title)} ${escapeHtml(getToggleLabel(config.labelKey, option))}"
            title="${escapeHtml(getToggleLabel(config.labelKey, option))}"
          >${index + 1}</button>
        `
          )
          .join("")}
      </div>
    </div>
  `;
}

export function bindReaderStepperControl(node, settingKey) {
  if (!node || node.dataset.bocBound === "1") {
    return;
  }

  node.addEventListener("click", (event) => {
    const button = event.target.closest("[data-value]");
    if (!button) {
      return;
    }
    setReaderPreference(settingKey, button.dataset.value || "");
  });
  node.dataset.bocBound = "1";
}

export function setReaderPreference(settingKey, nextValue) {
  const config = getReaderStepperConfig(settingKey);
  if (!config) {
    return;
  }

  const current = config.getCurrent();
  if (!config.options.includes(nextValue) || nextValue === current) {
    return;
  }
  updateReaderPreferences(config.buildPayload(nextValue), { persist: true });
}

export function renderReaderStepperState(node, settingKey) {
  const config = getReaderStepperConfig(settingKey);
  if (!node || !config) {
    return;
  }

  const current = config.getCurrent();
  node.querySelectorAll("[data-value]").forEach((button) => {
    const isActive = button.dataset.value === current;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

export function renderReaderPanels() {
  const settingsPanel = byId(ids.readingSettingsPanel);
  const settingsBtn = byId(ids.readingSettingsBtn);
  settingsPanel.hidden = !state.reader.readingSettingsExpanded;
  settingsBtn.classList.toggle("is-active", state.reader.readingSettingsExpanded);
  byId(ids.readingAutoScroll).checked = state.reader.readingAutoScroll;
  byId(ids.readingTranscriptVisible).checked = state.reader.readingTranscriptVisible;
  renderReaderStepperState(byId(ids.readingFontScaleSelect), "readerFontScale");
  renderReaderStepperState(byId(ids.readingLetterSpacingSelect), "readerLetterSpacing");
  renderReaderStepperState(byId(ids.readingLineHeightSelect), "readerLineHeight");
  renderReaderStepperState(byId(ids.readingContentWidthSelect), "readerContentWidth");
}

export function renderReadingInfoPanel() {
  const summaryNode = byId(ids.readingInfoSummary);
  const descriptionNode = byId(ids.readingInfoDescription);
  const descriptionBtn = byId(ids.readingDescriptionBtn);
  const summaryItems = buildReadingSummaryItems();
  const description = String(state.clip.description || "").trim();

  summaryNode.innerHTML =
    summaryItems.length === 0
      ? '<div class="boc-reading-empty">当前视频信息还未就绪。</div>'
      : summaryItems
          .map(
            (item) => `
              <div class="boc-reading-info-item">
                <span class="boc-reading-info-label">${escapeHtml(item.label)}</span>
                <span class="boc-reading-info-value">${escapeHtml(item.value)}</span>
              </div>
            `
          )
          .join("");

  if (!description) {
    descriptionNode.innerHTML = '<div class="boc-reading-empty">当前视频没有简介。</div>';
    descriptionNode.classList.remove("is-collapsed");
    descriptionBtn.hidden = true;
  } else {
    descriptionNode.textContent = description;
    const fullScrollHeight = descriptionNode.scrollHeight;
    descriptionNode.classList.add("is-collapsed");
    const clampedClientHeight = descriptionNode.clientHeight;
    descriptionNode.classList.toggle("is-collapsed", !state.reader.readingDescriptionExpanded);
    const hasOverflow = fullScrollHeight > clampedClientHeight + 2;
    if (!hasOverflow) {
      descriptionNode.classList.remove("is-collapsed");
      descriptionBtn.hidden = true;
      return;
    }
    descriptionBtn.hidden = false;
    descriptionBtn.textContent = state.reader.readingDescriptionExpanded ? "收起简介" : "查看更多";
  }
}

export function buildReadingSummaryItems() {
  const items = [];
  if (state.clip.title) {
    items.push({ label: "标题", value: state.clip.title });
  }
  if (state.clip.author) {
    items.push({ label: "作者", value: state.clip.author });
  }
  if (state.clip.uploadDate) {
    items.push({ label: "日期", value: state.clip.uploadDate });
  }
  if (Number(state.clip.pageCount) > 1) {
    const pageParts = [`P${Number(state.clip.pageIndex) > 0 ? Number(state.clip.pageIndex) : 1}`];
    if (state.clip.pageTitle) {
      pageParts.push(state.clip.pageTitle);
    }
    items.push({ label: "分P", value: pageParts.join(" ") });
  }
  return items;
}

export function updateReaderPreferences(next, { persist = true } = {}) {
  state.reader.setTheme(normalizeReaderTheme(next.readerTheme ?? state.reader.readingTheme));
  state.reader.setFontScale(normalizeReaderFontScale(next.readerFontScale ?? state.reader.readingFontScale));
  state.reader.setLetterSpacing(
    normalizeReaderLetterSpacing(next.readerLetterSpacing ?? state.reader.readingLetterSpacing)
  );
  state.reader.setLineHeight(normalizeReaderLineHeight(next.readerLineHeight ?? state.reader.readingLineHeight));
  state.reader.setContentWidth(normalizeReaderContentWidth(next.readerContentWidth ?? state.reader.readingContentWidth));
  state.reader.setChapterVisible(next.readerChapterVisible !== undefined ? Boolean(next.readerChapterVisible) : state.reader.readingChapterVisible);
  state.reader.setTranscriptVisible(
    normalizeReaderTranscriptVisible(next.readerTranscriptVisible ?? state.reader.readingTranscriptVisible)
  );
  state.setSettings({
    ...state.settings,
    readerTheme: state.reader.readingTheme,
    readerFontScale: state.reader.readingFontScale,
    readerLetterSpacing: state.reader.readingLetterSpacing,
    readerLineHeight: state.reader.readingLineHeight,
    readerContentWidth: state.reader.readingContentWidth,
    readerChapterVisible: state.reader.readingChapterVisible,
    readerTranscriptVisible: state.reader.readingTranscriptVisible
  });
  applyReadingViewPresentation();
  renderReaderPanels();
  if (persist) {
    persistReaderSettings();
  }
}

export function persistReaderSettings() {
  sendRuntimeMessage({ type: "save-settings", settings: state.settings }).catch((error) => {
    logWarn("[BOC] failed to persist reader settings", error);
  });
}

export function buildReadingMetaLine() {
  const parts = [];
  if (state.clip.author) {
    parts.push(state.clip.author);
  }
  if (state.clip.uploadDate) {
    parts.push(state.clip.uploadDate);
  }
  parts.push("bilibili.com");
  if (Number(state.clip.pageCount) > 1) {
    const pageParts = [`P${Number(state.clip.pageIndex) > 0 ? Number(state.clip.pageIndex) : 1}`];
    if (state.clip.pageTitle) {
      pageParts.push(state.clip.pageTitle);
    }
    parts.push(pageParts.join(" "));
  }
  if (state.clip.selectedSubtitleLang) {
    parts.push(`字幕：${state.clip.selectedSubtitleLang}`);
  }
  return parts.join(" · ");
}

export function renderReadingStatus(text) {
  byId(ids.readingStatus).textContent = String(text || "");
}

export function setReadingViewReady(ready) {
  state.reader.setViewReady(Boolean(ready));
  const readingView = document.getElementById(ids.readingView);
  if (!readingView) {
    return;
  }
  readingView.setAttribute("data-boc-reader-ready", state.reader.readingViewReady ? "1" : "0");
  readingView.setAttribute("aria-busy", state.reader.readingViewReady ? "false" : "true");
}

export function createReaderDebugSnapshot(label = "manual") {
  const pickNodeSnapshot = (selector) => {
    const node = document.querySelector(selector);
    if (!node) {
      return null;
    }
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return {
      selector,
      tag: node.tagName,
      id: node.id || "",
      className: typeof node.className === "string" ? node.className : "",
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      },
      style: {
        display: style.display,
        position: style.position,
        width: style.width,
        height: style.height,
        maxWidth: style.maxWidth,
        maxHeight: style.maxHeight,
        top: style.top,
        left: style.left,
        transform: style.transform,
        overflow: style.overflow,
        zIndex: style.zIndex
      },
      attrs: {
        readerKeep: node.getAttribute("data-boc-reader-keep"),
        readerHidden: node.getAttribute("data-boc-reader-hidden"),
        readerReset: node.getAttribute("data-boc-reader-player-reset")
      }
    };
  };

  const playerHostNode = playerHost || findReaderPlayerHost(getRuntimeVideoElement());
  const wrapNode = getReaderPlayerWrapNode(playerHostNode);
  const video = state.reader.readingVideoEl || getRuntimeVideoElement();
  const hostChain = [];
  let current = playerHostNode;
  let depth = 0;
  while (current && depth < 8) {
    const rect = current.getBoundingClientRect();
    const style = window.getComputedStyle(current);
    hostChain.push({
      tag: current.tagName,
      id: current.id || "",
      className: typeof current.className === "string" ? current.className : "",
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      },
      style: {
        position: style.position,
        width: style.width,
        height: style.height,
        top: style.top,
        left: style.left,
        transform: style.transform,
        overflow: style.overflow,
        zIndex: style.zIndex
      },
      readerReset: current.getAttribute("data-boc-reader-player-reset")
    });
    current = current.parentElement;
    depth += 1;
  }

  return {
    label: String(label || "manual"),
    url: cleanVideoUrl(),
    readerMode: document.documentElement.getAttribute("data-boc-reader-mode"),
    readingActive: document.body.getAttribute("data-boc-reading-active"),
    readingViewOpen: state.reader.readingViewOpen,
    readingNativePageMode: state.reader.readingNativePageMode,
    readingViewReady: state.reader.readingViewReady,
    readyStable: isReaderPresentationStable(playerHostNode),
    hasLayoutIssue: hasNativeReaderPlayerLayoutIssue(playerHostNode),
    hasRoot: Boolean(document.getElementById(ids.root)),
    hasReadingView: Boolean(document.getElementById(ids.readingView)),
    playerHost: playerHostNode
      ? {
          tag: playerHostNode.tagName,
          id: playerHostNode.id || "",
          className: typeof playerHostNode.className === "string" ? playerHostNode.className : ""
        }
      : null,
    wrapNode: wrapNode
      ? {
          tag: wrapNode.tagName,
          id: wrapNode.id || "",
          className: typeof wrapNode.className === "string" ? wrapNode.className : ""
        }
      : null,
    video: video
      ? {
          currentTime: Number(video.currentTime || 0) || 0,
          paused: Boolean(video.paused),
          videoWidth: Number(video.videoWidth || 0) || 0,
          videoHeight: Number(video.videoHeight || 0) || 0
        }
      : null,
    nodes: [
      "#app",
      "#playerWrap",
      ".player-wrap",
      "#bilibili-player",
      ".bpx-player-container",
      ".bpx-player-video-area",
      ".bpx-player-primary-area",
      "#boc-reading-inline-host",
      "#boc-reading-view"
    ]
      .map((selector) => pickNodeSnapshot(selector))
      .filter(Boolean),
    hostChain
  };
}

export async function ensureReaderPlayerControlsRecovered(
  playerHostArg = playerHost,
  { reason = "unknown", retryDelayMs = 90 } = {}
) {
  if (!state.reader.readingNativePageMode || !playerHostArg || isWatchlaterPage()) {
    return false;
  }

  const before = getReaderPlayerControlsState(playerHostArg);
  logInfo("[BOC] reader controls check", {
    reason,
    hostClassName: typeof playerHostArg.className === "string" ? playerHostArg.className : "",
    hostHasNoCursor: before.hostHasNoCursor,
    controlRootFound: before.controlRootFound,
    controls: before.nodes
  });

  if (!hasReaderPlayerControlsIssue(playerHostArg)) {
    return false;
  }

  logInfo("[BOC] recovering normal reader controls", {
    reason,
    hostClassName: typeof playerHostArg.className === "string" ? playerHostArg.className : ""
  });
  setReaderPlayerControlsVisible(true, playerHostArg);
  layoutReaderPlayerHost();

  let after = getReaderPlayerControlsState(playerHostArg);
  logInfo("[BOC] reader controls after recovery", {
    reason,
    hostClassName: typeof playerHostArg.className === "string" ? playerHostArg.className : "",
    hostHasNoCursor: after.hostHasNoCursor,
    controls: after.nodes,
    retried: false
  });
  if (!hasReaderPlayerControlsIssue(playerHostArg)) {
    return true;
  }

  await sleep(retryDelayMs);
  logInfo("[BOC] retrying normal reader controls recovery", {
    reason,
    hostClassName: typeof playerHostArg.className === "string" ? playerHostArg.className : ""
  });
  setReaderPlayerControlsVisible(true, playerHostArg);
  layoutReaderPlayerHost();
  after = getReaderPlayerControlsState(playerHostArg);
  logInfo("[BOC] reader controls after retry", {
    reason,
    hostClassName: typeof playerHostArg.className === "string" ? playerHostArg.className : "",
    hostHasNoCursor: after.hostHasNoCursor,
    controls: after.nodes,
    retried: true
  });
  return !hasReaderPlayerControlsIssue(playerHostArg);
}

// ===== page-frame.js (page frame helpers) =====
//
// Multi-page (分P) resolution lives in the pure page-context seam (issue 02);
// re-exported through the facade so existing importers keep working unchanged.

export {
  extractOid,
  hasExplicitPageParam,
  pickCidFromPages,
  pickDurationFromPages,
  pickPageFromPages,
  pickPageIndexFromOid,
  readCurrentPageFromPageState,
  readPageFromPlayerDom,
  resolvePageContext
} from "./page-context.js";

export function getReaderContentMaxPx() {
  if (state.reader.readingContentWidth === "compact") {
    return 680;
  }
  if (state.reader.readingContentWidth === "narrow") {
    return 760;
  }
  if (state.reader.readingContentWidth === "wide") {
    return 980;
  }
  if (state.reader.readingContentWidth === "full") {
    return 1100;
  }
  return 860;
}

export function getReaderPagePaddingPx() {
  return Math.min(32, Math.max(16, window.innerWidth * 0.028));
}

export function getReaderMainWidthLimit() {
  return Math.max(320, Math.min(getReaderContentMaxPx(), window.innerWidth - getReaderPagePaddingPx() * 2));
}

export function clearReaderModePageState() {
  document.documentElement.removeAttribute("data-boc-reader-mode");
  document.documentElement.removeAttribute("data-boc-reader-line-height");
  document.documentElement.removeAttribute("data-boc-reader-theme");
  document.documentElement.removeAttribute("data-boc-reader-font-scale");
  document.documentElement.removeAttribute("data-boc-reader-letter-spacing");
  document.documentElement.removeAttribute("data-boc-reader-content-width");
  document.documentElement.removeAttribute("data-boc-reader-chapter-visibility");
  document.documentElement.removeAttribute("data-boc-reader-has-chapters");
  document.documentElement.removeAttribute("data-boc-reader-transcript-visible");
  document.body.removeAttribute("data-boc-reader-mode");
  document.body.removeAttribute("data-boc-reader-line-height");
  document.body.removeAttribute("data-boc-reading-active");
}

export function shouldForceNormalPageState(url = location.href) {
  return !isReaderMode(url) && !state.reader.readingViewOpen;
}

export function enforceNormalPageStateIfNeeded(url = location.href) {
  if (!shouldForceNormalPageState(url)) {
    return;
  }
  clearReaderModePageState();
}

export function bindNormalPageStateGuard() {
  if (state.ui.normalPageStateGuardBound) {
    return;
  }
  uiState.setNormalPageStateGuardBound(true);

  const observer = new MutationObserver(() => {
    enforceNormalPageStateIfNeeded();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [
      "data-boc-reader-mode",
      "data-boc-reader-line-height",
      "data-boc-reader-theme",
      "data-boc-reader-font-scale",
      "data-boc-reader-letter-spacing",
      "data-boc-reader-content-width",
      "data-boc-reader-chapter-visibility",
      "data-boc-reader-has-chapters",
      "data-boc-reader-transcript-visible"
    ]
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["data-boc-reader-mode", "data-boc-reader-line-height", "data-boc-reading-active"]
  });
  pageContext.setNormalPageStateObserver(observer);
  enforceNormalPageStateIfNeeded();
}

export function cleanupReaderFloatingArtifacts(playerHostArg = playerHost) {
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
  }
  dismissReaderMiniPlayer(playerHostArg);
  const runtimeHost = findReaderPlayerHost(getRuntimeVideoElement());
  if (runtimeHost && runtimeHost !== playerHostArg) {
    dismissReaderMiniPlayer(runtimeHost);
  }
}

export function applyReaderPageFocus() {
  clearReaderPageFocus();

  const root = byId(ids.root);
  const video = getRuntimeVideoElement();
  const playerHostNode = findReaderPlayerHost(video);
  const titleNode = findReaderTitleContainer();
  const keepRoots = [root, playerHostNode, titleNode].filter(Boolean);

  keepRoots.forEach((node) => {
    markReaderKeepSubtree(node);
    markReaderKeepPath(node);
  });

  const keepNodes = Array.from(document.querySelectorAll("[data-boc-reader-keep='1']"));
  keepNodes.forEach((parent) => {
    Array.from(parent.children || []).forEach((child) => {
      if (child.id === ids.root) {
        return;
      }
      if (!child.hasAttribute("data-boc-reader-keep")) {
        child.setAttribute("data-boc-reader-hidden", "1");
      }
    });
  });

  pruneReaderNonKeepBranches(document.body);
  hideReaderNoiseNodes(keepRoots);
}

export function clearReaderPageFocus() {
  document.querySelectorAll("[data-boc-reader-keep]").forEach((node) => {
    node.removeAttribute("data-boc-reader-keep");
  });
  document.querySelectorAll("[data-boc-reader-hidden]").forEach((node) => {
    node.removeAttribute("data-boc-reader-hidden");
  });
}

export function applyInlineHostPresentation() {
  const inlineHost = document.getElementById("boc-reading-inline-host");
  if (!inlineHost) {
    return;
  }
  const leftContainer = document.querySelector(".left-container");
  const bgColor = leftContainer ? getComputedStyle(leftContainer).backgroundColor : "";
  if (state.reader.readingTranscriptVisible) {
    inlineHost.style.border = "";
    inlineHost.style.background = "";
    inlineHost.style.marginTop = "";
    inlineHost.style.boxShadow = "";
    inlineHost.style.borderRadius = "";
  } else {
    inlineHost.style.border = "none";
    inlineHost.style.background = bgColor;
    inlineHost.style.marginTop = "0";
    inlineHost.style.boxShadow = "none";
    inlineHost.style.borderRadius = "0";
  }
}

export function moveReadingMainInline() {
  if (!isReaderMode()) {
    return;
  }

  const readingMain = document.querySelector(".boc-reading-main");
  if (!readingMain) {
    return;
  }

  if (!mainOriginalParent) {
    mainOriginalParent = readingMain.parentElement;
    mainOriginalNextSibling = readingMain.nextSibling;
  }
  const playerWrap =
    document.getElementById("playerWrap") ||
    playerHost?.closest?.("#playerWrap") ||
    playerHost;
  const hostParent = playerWrap?.parentElement;
  if (!playerWrap || !hostParent) {
    return;
  }

  let inlineHost = document.getElementById("boc-reading-inline-host");
  if (!inlineHost) {
    inlineHost = document.createElement("div");
    inlineHost.id = "boc-reading-inline-host";
  }

  if (inlineHost.parentElement !== hostParent || inlineHost.previousElementSibling !== playerWrap) {
    playerWrap.insertAdjacentElement("afterend", inlineHost);
  }

  if (!inlineHost.dataset.bocScrollBound) {
    const handleInlineHostManualScroll = () => {
      if (Date.now() <= programmaticScrollUntil) {
        return;
      }
      noteManualReaderInteraction();
    };
    inlineHost.addEventListener("scroll", handleInlineHostManualScroll);
    inlineHost.addEventListener("wheel", handleInlineHostManualScroll, { passive: true });
    inlineHost.dataset.bocScrollBound = "1";
  }

  if (readingMain.parentElement !== inlineHost) {
    inlineHost.appendChild(readingMain);
  }
  applyInlineHostPresentation();
  updateReadingTranscriptTailSpacer();
}

export function restoreReadingMainInline() {
  const readingMain = document.querySelector(".boc-reading-main");
  const inlineHost = document.getElementById("boc-reading-inline-host");
  if (readingMain && mainOriginalParent) {
    if (mainOriginalNextSibling?.parentNode === mainOriginalParent) {
      mainOriginalParent.insertBefore(readingMain, mainOriginalNextSibling);
    } else {
      mainOriginalParent.appendChild(readingMain);
    }
  }
  inlineHost?.remove();
  mainOriginalParent = null;
  mainOriginalNextSibling = null;
}

export function pruneReaderNonKeepBranches(node) {
  if (!node?.children?.length) {
    return;
  }

  Array.from(node.children).forEach((child) => {
    if (child.id === ids.root) {
      return;
    }
    const childHasKeep = child.hasAttribute("data-boc-reader-keep");
    const childContainsKeep = Boolean(child.querySelector?.("[data-boc-reader-keep='1']"));
    if (!childHasKeep && !childContainsKeep) {
      child.setAttribute("data-boc-reader-hidden", "1");
      return;
    }
    pruneReaderNonKeepBranches(child);
  });
}

export function hideReaderNoiseNodes(keepRoots = []) {
  const keepSet = new Set(keepRoots.filter(Boolean));
  const selectors = [
    ".strip-ad-inner",
    ".inside-wrp",
    ".inside-bg",
    ".hinter-msg",
    ".slide",
    ".cover.b-img",
    ".cover.b-img.sleepy",
    ".b-img.clickable",
    "[class*='activity']",
    "[class*='adcard']"
  ];

  document.querySelectorAll(selectors.join(",")).forEach((node) => {
    if (Array.from(keepSet).some((keepNode) => keepNode === node || node.contains(keepNode))) {
      return;
    }
    if (
      node.closest(
        "#bilibili-player, .bpx-player-container, .bpx-player-video-area, .bpx-player-primary-area, #boc-root, h1.video-title, .video-info-detail, .video-info-meta, .video-data"
      )
    ) {
      return;
    }
    node.setAttribute("data-boc-reader-hidden", "1");
    const card = node.closest("article, li, .card-box, .video-page-card-small, .video-page-special-card-small, .feed-card, .bili-video-card");
    if (card && !card.closest("#bilibili-player, .bpx-player-container, .bpx-player-video-area, .bpx-player-primary-area, #boc-root")) {
      card.setAttribute("data-boc-reader-hidden", "1");
    }
  });
}

export function markReaderKeepSubtree(node) {
  if (!node) {
    return;
  }
  node.setAttribute("data-boc-reader-keep", "1");
  node.querySelectorAll("*").forEach((child) => {
    child.setAttribute("data-boc-reader-keep", "1");
  });
}

export function markReaderKeepPath(node) {
  let current = node;
  while (current && current !== document.body) {
    current.setAttribute("data-boc-reader-keep", "1");
    current = current.parentElement;
  }
  document.body.setAttribute("data-boc-reader-keep", "1");
}

export function findReaderTitleContainer() {
  const title =
    document.querySelector("h1.video-title") ||
    document.querySelector("h1") ||
    document.querySelector("[data-title]");
  if (!title) {
    return null;
  }
  return title;
}

export function findReaderMetaContainer(titleNode = findReaderTitleContainer()) {
  const title = titleNode?.matches?.("h1, [data-title]") ? titleNode : titleNode?.querySelector?.("h1, [data-title]");
  if (!title) {
    return null;
  }

  const candidates = [
    title.nextElementSibling,
    title.parentElement?.nextElementSibling,
    title.parentElement,
    title.parentElement?.parentElement,
    ...(Array.from(title.parentElement?.parentElement?.children || []).slice(0, 6))
  ].filter(Boolean);

  for (const node of candidates) {
    if (node.matches?.(".video-data, .video-info-detail, .video-info-meta")) {
      return node;
    }
    if (node.querySelector?.(".view-text")) {
      return node;
    }
  }

  return null;
}

export function findReaderContentHost(playerHostArg = playerHost, titleNode = findReaderTitleContainer()) {
  if (!playerHostArg && !titleNode) {
    return null;
  }

  let current = titleNode || playerHostArg;
  while (current && current !== document.body) {
    const containsPlayer = playerHostArg ? current.contains(playerHostArg) : true;
    const containsTitle = titleNode ? current.contains(titleNode) : true;
    if (containsPlayer && containsTitle) {
      return current;
    }
    current = current.parentElement;
  }

  return playerHostArg?.parentElement || titleNode?.parentElement || null;
}

export function dismissReaderMiniPlayer(playerHostArg = playerHost) {
  const explicitClose = Array.from(document.querySelectorAll(".bpx-player-mini-close")).find(isVisibleReaderControl);
  if (explicitClose) {
    explicitClose.click();
    return true;
  }

  if (!playerHostArg) {
    return false;
  }

  const computed = window.getComputedStyle(playerHostArg);
  const fixedLike = computed.position === "fixed" || /mini|picture|float|fixed-player/i.test(playerHostArg.className || "");
  if (!fixedLike) {
    return false;
  }

  const roots = Array.from(
    new Set([
      playerHostArg,
      playerHostArg.parentElement,
      playerHostArg.closest("#playerWrap"),
      playerHostArg.closest("#bilibili-player")
    ].filter(Boolean))
  );

  const selectors = [
    ".bpx-player-mini-close",
    "[class*='mini'][class*='close']",
    "[class*='close']",
    "button[aria-label*='关闭']",
    "button[title*='关闭']",
    "[role='button'][aria-label*='关闭']",
    "[role='button'][title*='关闭']"
  ];

  for (const root of roots) {
    for (const selector of selectors) {
      const candidates = Array.from(root.querySelectorAll(selector)).filter(isVisibleReaderControl);
      const button = candidates.sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        return rectA.width * rectA.height - rectB.width * rectB.height;
      })[0];
      if (button) {
        button.click();
        return true;
      }
    }
  }

  const playerRect = playerHostArg.getBoundingClientRect();
  for (const root of roots) {
    const fallback = Array.from(root.querySelectorAll("button, [role='button'], [tabindex], div, span"))
      .filter((node) => {
        if (!isVisibleReaderControl(node)) {
          return false;
        }
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const nearTopRight =
          rect.width <= 48 &&
          rect.height <= 48 &&
          rect.left >= playerRect.right - 96 &&
          rect.top <= playerRect.top + 96;
        return nearTopRight && (style.cursor === "pointer" || node.hasAttribute("role") || node.hasAttribute("tabindex"));
      })
      .sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        return rectA.top + (playerRect.right - rectA.right) - (rectB.top + (playerRect.right - rectB.right));
      })[0];

    if (fallback) {
      fallback.click();
      return true;
    }
  }

  return false;
}

export function alignReaderViewportToPlayer() {
  if (!isReaderMode()) {
    return;
  }

  const titleNode = findReaderTitleContainer();
  const playerHostNode = playerHost || findReaderPlayerHost(getRuntimeVideoElement());
  const anchor = titleNode || playerHostNode;
  if (!anchor) {
    return;
  }

  const titleRect = titleNode?.getBoundingClientRect?.();
  const playerRect = playerHostNode?.getBoundingClientRect?.();
  const top = Math.min(
    titleRect?.top ?? Number.POSITIVE_INFINITY,
    playerRect?.top ?? Number.POSITIVE_INFINITY
  );
  if (!Number.isFinite(top)) {
    return;
  }

  const nextTop = Math.max(0, window.scrollY + top - 16);
  window.scrollTo({ top: nextTop, behavior: "auto" });
  window.setTimeout(() => {
    if (!state.reader.readingViewOpen || !isReaderMode()) {
      return;
    }
    window.scrollTo({ top: nextTop, behavior: "auto" });
    layoutReaderPlayerHost();
  }, 120);
}

// ===== player-host.js (player host lifecycle) =====

export function clearNativeReaderFloatingStyles(playerHostArg = playerHost) {
  if (!state.reader.readingNativePageMode || !playerHostArg) {
    return;
  }

  const targets = [];
  let current = playerHostArg;
  let depth = 0;
  while (current && current !== document.body && depth < 8) {
    if (
      current.matches?.(
        ".bpx-player-container, .bpx-docker, .bpx-player-video-area, .bpx-player-primary-area, #bilibili-player, #playerWrap, .player-wrap"
      )
    ) {
      targets.push(current);
    }
    if (current.id === "playerWrap") {
      break;
    }
    current = current.parentElement;
    depth += 1;
  }

  targets.forEach((node) => {
    node.style.removeProperty("position");
    node.style.removeProperty("inset");
    node.style.removeProperty("left");
    node.style.removeProperty("top");
    node.style.removeProperty("right");
    node.style.removeProperty("bottom");
    node.style.removeProperty("transform");
    node.style.removeProperty("width");
    node.style.removeProperty("height");
    node.style.removeProperty("max-width");
    node.style.removeProperty("max-height");
    node.style.removeProperty("margin");
    node.style.removeProperty("z-index");
  });
}

export function getReaderPlayerWrapNode(playerHostArg = playerHost) {
  return (
    playerHostArg?.closest?.("#playerWrap") ||
    playerHostArg?.closest?.(".player-wrap") ||
    document.getElementById("playerWrap") ||
    document.querySelector(".player-wrap")
  );
}

export function hasNativeReaderPlayerLayoutIssue(playerHostArg = playerHost) {
  if (!state.reader.readingNativePageMode || !playerHostArg) {
    return false;
  }

  const playerStyle = window.getComputedStyle(playerHostArg);
  if (playerStyle.position === "fixed" || playerStyle.position === "sticky") {
    return true;
  }

  const playerRect = playerHostArg.getBoundingClientRect();
  const wrapNode = getReaderPlayerWrapNode(playerHostArg);
  if (!wrapNode) {
    return false;
  }

  const wrapRect = wrapNode.getBoundingClientRect();
  return wrapRect.height <= 8 && playerRect.height > 120;
}

export async function ensureReaderPlayerMounted({ retries = 1, delayMs = 100, forceLayout = false } = {}) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const video = getRuntimeVideoElement();
    const playerHostCandidate = findReaderPlayerHost(video);
    if (video && playerHostCandidate) {
      const previousHost = playerHost;
      const previousVideo = state.reader.readingVideoEl;
      video.controls = false;
      video.removeAttribute("controls");
      video.disablePictureInPicture = true;
      video.setAttribute("disablepictureinpicture", "");
      video.removeAttribute("autopictureinpicture");
      playerHost = playerHostCandidate;
      const miniPlayerClosed = dismissReaderMiniPlayer(playerHostCandidate);
      if (miniPlayerClosed) {
        await sleep(120);
      }
      const activeHost = findReaderPlayerHost(video) || playerHostCandidate;
      playerHost = activeHost;
      normalizeReaderPlayerContainer(activeHost);
      if (state.reader.readingNativePageMode) {
        clearNativeReaderFloatingStyles(activeHost);
        if (hasNativeReaderPlayerLayoutIssue(activeHost)) {
          normalizeReaderPlayerContainer(activeHost);
          clearNativeReaderFloatingStyles(activeHost);
        }
      }
      if (previousHost && previousHost !== activeHost) {
        setReaderPlayerControlsVisible(false, previousHost);
        cleanupReaderPlayerHostNode(previousHost);
      }
      if (previousVideo !== video) {
        videoEventsBound = false;
      }
      activeHost.classList.add("boc-reader-player-host");
      bindReadingViewVideo(video);
      bindReaderPlayerControlsHover(activeHost);
      bindReaderLayout();
      if (
        forceLayout ||
        previousHost !== activeHost ||
        attempt > 0 ||
        miniPlayerClosed ||
        (state.reader.readingNativePageMode && hasNativeReaderPlayerLayoutIssue(activeHost))
      ) {
        layoutReaderPlayerHost();
        if (state.reader.readingNativePageMode && hasNativeReaderPlayerLayoutIssue(activeHost)) {
          normalizeReaderPlayerContainer(activeHost);
          clearNativeReaderFloatingStyles(activeHost);
          layoutReaderPlayerHost();
        }
      }
      if (state.reader.readingNativePageMode && !isWatchlaterPage()) {
        await ensureReaderPlayerControlsRecovered(activeHost, {
          reason: attempt > 0 ? "mount-retry" : "mount"
        });
        queueEnsureReaderPlayerControlsRecovered({
          reason: attempt > 0 ? "post-mount-retry" : "post-mount",
          delayMs: 220,
          minIntervalMs: 240
        });
      }
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
      }
      return true;
    }
    await sleep(delayMs);
  }
  return false;
}

export function queueEnsureReaderPlayerMounted() {
  if (!state.reader.readingViewOpen || !isReaderMode() || playerMountTimer) {
    return;
  }
  playerMountTimer = window.setTimeout(() => {
    playerMountTimer = 0;
    ensureReaderPlayerMounted({ retries: 12, delayMs: 120, forceLayout: true }).catch((error) => {
      logWarn("[BOC] ensure reader player mounted failed", error);
    });
  }, 60);
}

export function isReaderPresentationStable(playerHostArg = playerHost) {
  if (!state.reader.readingViewOpen || !playerHostArg?.isConnected) {
    return false;
  }
  const rect = playerHostArg.getBoundingClientRect();
  if (!(rect.width > 240) || !(rect.height > 120)) {
    return false;
  }
  if (!state.reader.readingNativePageMode) {
    return true;
  }
  return !hasNativeReaderPlayerLayoutIssue(playerHostArg);
}

export function bindReaderLayout() {
  if (layoutBound) {
    return;
  }
  window.addEventListener("resize", layoutReaderPlayerHost);
  window.addEventListener("scroll", layoutReaderPlayerHost, { passive: true });
  document.addEventListener("fullscreenchange", layoutReaderPlayerHost);
  document.addEventListener("webkitfullscreenchange", layoutReaderPlayerHost);
  layoutBound = true;
}

export function unbindReaderLayout() {
  if (!layoutBound) {
    return;
  }
  window.removeEventListener("resize", layoutReaderPlayerHost);
  window.removeEventListener("scroll", layoutReaderPlayerHost);
  document.removeEventListener("fullscreenchange", layoutReaderPlayerHost);
  document.removeEventListener("webkitfullscreenchange", layoutReaderPlayerHost);
  layoutBound = false;
}

export function layoutReaderPlayerHost() {
  if (!state.reader.readingViewOpen || !isReaderMode()) {
    return;
  }

  const readingView = byId(ids.readingView);
  const playerHostNode = playerHost;
  const slot = byId(ids.readingPlayerSlot);
  if (!playerHostNode) {
    return;
  }

  if (state.reader.readingNativePageMode) {
    const rect = playerHostNode.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) {
      return;
    }

    const video = state.reader.readingVideoEl;
    let renderedWidth = rect.width;
    let renderedHeight = rect.height;
    if (Number(video?.videoWidth) > 0 && Number(video?.videoHeight) > 0) {
      const aspectRatio = Number(video.videoWidth) / Number(video.videoHeight);
      if (aspectRatio > 0) {
        const hostAspectRatio = rect.width / rect.height;
        if (hostAspectRatio > aspectRatio) {
          renderedHeight = rect.height;
          renderedWidth = rect.height * aspectRatio;
        } else {
          renderedWidth = rect.width;
          renderedHeight = rect.width / aspectRatio;
        }
      }
    }

    const widthLimit = getReaderMainWidthLimit();
    if (renderedWidth > widthLimit) {
      const scale = widthLimit / renderedWidth;
      renderedWidth = widthLimit;
      renderedHeight *= scale;
    }

    clearNativeReaderFloatingStyles(playerHostNode);
    cleanupReaderPlayerHostNode(playerHostNode);
    readingView.style.setProperty("--boc-reader-player-rendered-width", `${Math.round(renderedWidth)}px`);
    readingView.style.setProperty("--boc-reader-player-rendered-height", `${Math.round(renderedHeight)}px`);
    updateReadingTranscriptTailSpacer();
    queueEnsureReaderPlayerControlsRecovered({
      reason: "layout-native",
      delayMs: 120
    });
    return;
  }

  if (!slot) {
    return;
  }

  const rect = slot.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) {
    return;
  }

  const video = state.reader.readingVideoEl;
  const aspectRatio =
    Number(video?.videoWidth) > 0 && Number(video?.videoHeight) > 0
      ? Number(video.videoWidth) / Number(video.videoHeight)
      : 16 / 9;
  const targetHeight = rect.height;
  const targetWidth = Math.min(rect.width, targetHeight * aspectRatio);
  const left = rect.left + (rect.width - targetWidth) / 2;

  readingView.style.setProperty("--boc-reader-player-rendered-width", `${Math.round(targetWidth)}px`);
  readingView.style.setProperty("--boc-reader-player-rendered-height", `${Math.round(targetHeight)}px`);
  playerHostNode.style.setProperty("position", "fixed", "important");
  playerHostNode.style.setProperty("left", `${Math.round(left)}px`, "important");
  playerHostNode.style.setProperty("top", `${Math.round(rect.top)}px`, "important");
  playerHostNode.style.setProperty("width", `${Math.round(targetWidth)}px`, "important");
  playerHostNode.style.setProperty("height", `${Math.round(targetHeight)}px`, "important");
  playerHostNode.style.setProperty("margin", "0", "important");
  playerHostNode.style.setProperty("z-index", "2147483647", "important");
  playerHostNode.style.setProperty("max-width", "none", "important");
  playerHostNode.style.setProperty("max-height", "none", "important");
  updateReadingTranscriptTailSpacer();
}

export function cleanupReaderPlayerHostNode(playerHostNode) {
  if (!playerHostNode) {
    return;
  }
  playerHostNode.classList.remove("boc-reader-player-host");
  playerHostNode.style.removeProperty("position");
  playerHostNode.style.removeProperty("inset");
  playerHostNode.style.removeProperty("left");
  playerHostNode.style.removeProperty("top");
  playerHostNode.style.removeProperty("right");
  playerHostNode.style.removeProperty("bottom");
  playerHostNode.style.removeProperty("transform");
  playerHostNode.style.removeProperty("width");
  playerHostNode.style.removeProperty("height");
  playerHostNode.style.removeProperty("margin");
  playerHostNode.style.removeProperty("z-index");
  playerHostNode.style.removeProperty("max-width");
  playerHostNode.style.removeProperty("max-height");
}

export function cleanupReaderPlayerHost() {
  restoreReaderPlayerContainer();
  unbindReaderPlayerControlsHover();
  unbindReaderHeaderActionsHover();
  closeReaderCleanup();
  const readingView = byId(ids.readingView);
  readingView?.style.removeProperty("--boc-reader-player-rendered-width");
  readingView?.style.removeProperty("--boc-reader-player-rendered-height");
  const playerHostNode = playerHost;
  if (!playerHostNode) {
    return;
  }
  setReaderPlayerControlsVisible(false, playerHostNode);
  cleanupReaderPlayerHostNode(playerHostNode);
  playerHost = null;
}

export function startReaderPlayerObserver() {
  if (!isReaderMode() || playerObserver || !document.body) {
    return;
  }
  const observer = new MutationObserver(() => {
    if (!state.reader.readingViewOpen) {
      return;
    }
    const nextVideo = getRuntimeVideoElement();
    const nextHost = findReaderPlayerHost(nextVideo);
    if (nextVideo && nextHost && (nextVideo !== state.reader.readingVideoEl || nextHost !== playerHost)) {
      queueEnsureReaderPlayerMounted();
    }
    if (document.querySelector(".bpx-player-mini-close, .bpx-player-mini-warp")) {
      scheduleReaderMiniPlayerDismiss();
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
  playerObserver = observer;
}

export function stopReaderPlayerObserver() {
  if (playerObserver) {
    playerObserver.disconnect();
    playerObserver = null;
  }
}

export function bindReadingViewVideo(video = getRuntimeVideoElement()) {
  if (!video) {
    if (state.reader.readingVideoEl && state.reader.readingVideoEl.__bocReadingSyncHandler) {
      const prev = state.reader.readingVideoEl;
      prev.removeEventListener("timeupdate", prev.__bocReadingSyncHandler);
      prev.removeEventListener("seeked", prev.__bocReadingSyncHandler);
      prev.removeEventListener("loadedmetadata", prev.__bocReadingSyncHandler);
      delete prev.__bocReadingSyncHandler;
    }
    state.reader.readingVideoEl = null;
    videoEventsBound = false;
    return null;
  }

  if (state.reader.readingVideoEl === video && videoEventsBound) {
    return video;
  }

  if (state.reader.readingVideoEl && state.reader.readingVideoEl.__bocReadingSyncHandler) {
    const prev = state.reader.readingVideoEl;
    prev.removeEventListener("timeupdate", prev.__bocReadingSyncHandler);
    prev.removeEventListener("seeked", prev.__bocReadingSyncHandler);
    prev.removeEventListener("loadedmetadata", prev.__bocReadingSyncHandler);
  }

  const syncHandler = (event) => {
    if (state.reader.readingViewOpen) {
      if (event?.type === "loadedmetadata") {
        layoutReaderPlayerHost();
      }
      if (event?.type === "seeked") {
        state.reader.setNextScrollBehavior("auto");
        queueEnsureReaderPlayerControlsRecovered({
          reason: "seeked",
          delayMs: 140,
          minIntervalMs: 320
        });
      }
      const latestHost = findReaderPlayerHost(video);
      if (latestHost && latestHost !== playerHost) {
        queueEnsureReaderPlayerMounted();
      }
      syncReadingViewPlayback();
    }
  };
  video.addEventListener("timeupdate", syncHandler);
  video.addEventListener("seeked", syncHandler);
  video.addEventListener("loadedmetadata", syncHandler);
  video.__bocReadingSyncHandler = syncHandler;
  state.reader.readingVideoEl = video;
  playerHost = findReaderPlayerHost(video) || playerHost;
  videoEventsBound = true;
  return video;
}

export function scheduleReaderMiniPlayerDismiss(maxAttempts = 12, delayMs = 180) {
  if (!state.reader.readingViewOpen) {
    return;
  }
  if (miniDismissTimer) {
    window.clearTimeout(miniDismissTimer);
    miniDismissTimer = 0;
  }

  let attempts = 0;
  const run = () => {
    if (!state.reader.readingViewOpen) {
      miniDismissTimer = 0;
      return;
    }

    const closed = dismissReaderMiniPlayer();
    const host = findReaderPlayerHost(getRuntimeVideoElement());
    if (host) {
      playerHost = host;
      normalizeReaderPlayerContainer(host);
      layoutReaderPlayerHost();
    }

    attempts += 1;
    const miniExists = Boolean(document.querySelector(".bpx-player-mini-close, .bpx-player-mini-warp"));
    const hostFixed = Boolean(host && window.getComputedStyle(host).position === "fixed");
    if (attempts < maxAttempts && (miniExists || hostFixed || closed)) {
      miniDismissTimer = window.setTimeout(run, delayMs);
      return;
    }
    miniDismissTimer = 0;
  };

  miniDismissTimer = window.setTimeout(run, 40);
}

export function getReaderControlsRoot(playerHostArg = playerHost) {
  return (
    playerHostArg?.closest?.("#playerWrap") ||
    playerHostArg?.closest?.("#bilibili-player") ||
    playerHostArg ||
    document.getElementById("playerWrap") ||
    document.getElementById("bilibili-player")
  );
}

export function getReaderPlayerControlsState(playerHostArg = playerHost) {
  const controlRoot = getReaderControlsRoot(playerHostArg);
  const nodes = [".bpx-player-control-wrap", ".bpx-player-control-mask", ".bpx-player-control-entity"].map(
    (selector) => {
      const node = controlRoot?.querySelector(selector) || null;
      return {
        selector,
        exists: Boolean(node),
        visible: isVisibleReaderControl(node)
      };
    }
  );

  return {
    controlRootFound: Boolean(controlRoot),
    hostHasNoCursor: Boolean(playerHostArg?.classList.contains("bpx-state-no-cursor")),
    anyPresent: nodes.some((item) => item.exists),
    anyHidden: nodes.some((item) => item.exists && !item.visible),
    nodes
  };
}

export function hasReaderPlayerControlsIssue(playerHostArg = playerHost) {
  if (!state.reader.readingNativePageMode || !playerHostArg || isWatchlaterPage()) {
    return false;
  }

  const snapshot = getReaderPlayerControlsState(playerHostArg);
  return snapshot.hostHasNoCursor || (snapshot.anyPresent && snapshot.anyHidden);
}

export function queueEnsureReaderPlayerControlsRecovered({
  reason = "unknown",
  delayMs = 120,
  minIntervalMs = 480
} = {}) {
  if (!state.reader.readingViewOpen || !state.reader.readingNativePageMode || isWatchlaterPage()) {
    return;
  }
  const playerHostNode = playerHost;
  if (!playerHostNode?.isConnected || controlsRecoveryInFlight) {
    return;
  }

  const now = Date.now();
  if (controlsRecoveryTimer) {
    return;
  }
  if (now - controlsLastRecoverAt < minIntervalMs) {
    return;
  }

  controlsRecoveryTimer = window.setTimeout(() => {
    controlsRecoveryTimer = 0;
    if (!state.reader.readingViewOpen || !state.reader.readingNativePageMode || isWatchlaterPage()) {
      return;
    }
    const activeHost = playerHost;
    if (!activeHost?.isConnected || !hasReaderPlayerControlsIssue(activeHost)) {
      return;
    }

    controlsRecoveryInFlight = true;
    controlsLastRecoverAt = Date.now();
    ensureReaderPlayerControlsRecovered(activeHost, {
      reason,
      retryDelayMs: 120
    })
      .catch((error) => {
        logWarn("[BOC] queued reader controls recovery failed", { reason, error });
      })
      .finally(() => {
        controlsRecoveryInFlight = false;
      });
  }, delayMs);
}

export function setReaderPlayerControlsVisible(visible, playerHostArg = playerHost) {
  if (!state.reader.readingNativePageMode || !playerHostArg) {
    return;
  }

  const controlRoot = getReaderControlsRoot(playerHostArg);
  if (!controlRoot) {
    return;
  }

  const displayMap = new Map([
    [".bpx-player-control-wrap", "block"],
    [".bpx-player-control-mask", "block"],
    [".bpx-player-control-entity", "block"]
  ]);

  displayMap.forEach((displayValue, selector) => {
    const node = controlRoot.querySelector(selector);
    if (!node) {
      return;
    }

    if (visible) {
      node.style.setProperty("display", displayValue, "important");
      node.setAttribute("data-boc-reader-controls-forced", "1");
      return;
    }

    if (node.getAttribute("data-boc-reader-controls-forced") === "1") {
      node.style.removeProperty("display");
      node.removeAttribute("data-boc-reader-controls-forced");
    }
  });

  if (visible) {
    if (playerHostArg.classList.contains("bpx-state-no-cursor")) {
      playerHostArg.classList.remove("bpx-state-no-cursor");
      playerHostArg.setAttribute("data-boc-reader-no-cursor-cleared", "1");
    }
    return;
  }

  if (playerHostArg.getAttribute("data-boc-reader-no-cursor-cleared") === "1") {
    playerHostArg.classList.add("bpx-state-no-cursor");
    playerHostArg.removeAttribute("data-boc-reader-no-cursor-cleared");
  }
}

export function scheduleReaderPlayerControlsHide(playerHostArg = controlsHoverHost || playerHost) {
  if (controlsHideTimer) {
    window.clearTimeout(controlsHideTimer);
  }
  controlsHideTimer = window.setTimeout(() => {
    controlsHideTimer = 0;
    if (!state.reader.readingViewOpen) {
      return;
    }
    setReaderPlayerControlsVisible(false, playerHostArg);
  }, 1200);
}

export function bindReaderPlayerControlsHover(playerHostArg = playerHost) {
  if (!state.reader.readingNativePageMode || !isWatchlaterPage() || !playerHostArg) {
    return;
  }

  if (controlsHoverHost && controlsHoverHost !== playerHostArg) {
    unbindReaderPlayerControlsHover();
  }
  if (playerHostArg.__bocReaderControlsHoverBound) {
    controlsHoverHost = playerHostArg;
    return;
  }

  const showControls = () => {
    if (!state.reader.readingViewOpen) {
      return;
    }
    setReaderPlayerControlsVisible(true, playerHostArg);
    scheduleReaderPlayerControlsHide(playerHostArg);
  };
  const hideControls = () => {
    if (controlsHideTimer) {
      window.clearTimeout(controlsHideTimer);
      controlsHideTimer = 0;
    }
    setReaderPlayerControlsVisible(false, playerHostArg);
  };

  playerHostArg.addEventListener("mouseenter", showControls, true);
  playerHostArg.addEventListener("mousemove", showControls, true);
  playerHostArg.addEventListener("mouseleave", hideControls, true);
  playerHostArg.__bocReaderControlsHoverBound = { showControls, hideControls };
  controlsHoverHost = playerHostArg;
}

export function unbindReaderPlayerControlsHover() {
  const playerHostNode = controlsHoverHost;
  if (controlsHideTimer) {
    window.clearTimeout(controlsHideTimer);
    controlsHideTimer = 0;
  }
  if (!playerHostNode?.__bocReaderControlsHoverBound) {
    controlsHoverHost = null;
    return;
  }

  const { showControls, hideControls } = playerHostNode.__bocReaderControlsHoverBound;
  playerHostNode.removeEventListener("mouseenter", showControls, true);
  playerHostNode.removeEventListener("mousemove", showControls, true);
  playerHostNode.removeEventListener("mouseleave", hideControls, true);
  delete playerHostNode.__bocReaderControlsHoverBound;
  setReaderPlayerControlsVisible(false, playerHostNode);
  controlsHoverHost = null;
}

export function setReaderHeaderActionsVisible(visible) {
  const actions = document.querySelector(".boc-reading-actions");
  if (!actions) {
    return;
  }
  if (visible) {
    actions.removeAttribute("data-boc-icon-hidden");
    return;
  }
  actions.setAttribute("data-boc-icon-hidden", "1");
}

export function scheduleReaderHeaderActionsHide(delayMs = 10000) {
  if (headerHideTimer) {
    window.clearTimeout(headerHideTimer);
    headerHideTimer = 0;
  }
  headerHideTimer = window.setTimeout(() => {
    headerHideTimer = 0;
    if (!state.reader.readingViewOpen) {
      return;
    }
    setReaderHeaderActionsVisible(false);
  }, delayMs);
}

export function bindReaderHeaderActionsHover() {
  if (!state.reader.readingViewOpen) {
    return;
  }
  const header = document.querySelector(".boc-reading-header");
  if (!header || header.__bocReaderHeaderHoverBound) {
    headerHoverHost = header || null;
    return;
  }

  const showActions = () => {
    if (!state.reader.readingViewOpen) {
      return;
    }
    if (headerHideTimer) {
      window.clearTimeout(headerHideTimer);
      headerHideTimer = 0;
    }
    setReaderHeaderActionsVisible(true);
  };
  const hideActionsLater = () => {
    if (!state.reader.readingViewOpen) {
      return;
    }
    scheduleReaderHeaderActionsHide();
  };

  header.addEventListener("mouseenter", showActions, true);
  header.addEventListener("mouseleave", hideActionsLater, true);
  header.__bocReaderHeaderHoverBound = { showActions, hideActionsLater };
  headerHoverHost = header;
  setReaderHeaderActionsVisible(true);
  scheduleReaderHeaderActionsHide();
}

export function unbindReaderHeaderActionsHover() {
  const header = headerHoverHost;
  if (headerHideTimer) {
    window.clearTimeout(headerHideTimer);
    headerHideTimer = 0;
  }
  if (!header?.__bocReaderHeaderHoverBound) {
    headerHoverHost = null;
    return;
  }
  const { showActions, hideActionsLater } = header.__bocReaderHeaderHoverBound;
  header.removeEventListener("mouseenter", showActions, true);
  header.removeEventListener("mouseleave", hideActionsLater, true);
  delete header.__bocReaderHeaderHoverBound;
  headerHoverHost = null;
  setReaderHeaderActionsVisible(true);
}

export function normalizeReaderPlayerContainer(playerHostArg = playerHost) {
  if (!playerHostArg) {
    return;
  }

  restoreReaderPlayerContainer();
  const adjusted = [];
  let current = playerHostArg;
  let depth = 0;

  while (current && current !== document.body && depth < 12) {
    const computed = window.getComputedStyle(current);
    const className = typeof current.className === "string" ? current.className : "";
    const isPlayerLayoutNode = current.matches?.(
      ".bpx-player-container, .bpx-player-video-area, .bpx-player-primary-area, .bpx-player-inner, .scroll-sticky, .player-wrap, #playerWrap, #bilibili-player"
    );
    const isExplicitMiniNode = current.matches?.(
      ".bpx-player-mini-warp, .bpx-player-mini-close, [class*='mini-player'], [class*='picture-in-picture']"
    );
    const hasFloatingPosition = computed.position === "fixed" || computed.position === "sticky";
    const isMiniLike =
      hasFloatingPosition ||
      /mini|picture|float|fixed-player/i.test(className) ||
      current.matches?.(".bpx-player-mini-warp, .bpx-player-mini-close");
    const shouldReset = state.reader.readingNativePageMode
      ? Boolean(isExplicitMiniNode || (isPlayerLayoutNode && isMiniLike))
      : isPlayerLayoutNode || isMiniLike;

    if (shouldReset) {
      adjusted.push({
        node: current,
        position: current.style.position,
        left: current.style.left,
        top: current.style.top,
        right: current.style.right,
        bottom: current.style.bottom,
        width: current.style.width,
        height: current.style.height,
        transform: current.style.transform,
        margin: current.style.margin,
        zIndex: current.style.zIndex
      });
      current.setAttribute("data-boc-reader-player-reset", "1");
      current.style.setProperty("position", "static", "important");
      current.style.setProperty("left", "auto", "important");
      current.style.setProperty("top", "auto", "important");
      current.style.setProperty("right", "auto", "important");
      current.style.setProperty("bottom", "auto", "important");
      current.style.setProperty("transform", "none", "important");
      current.style.setProperty("margin", "0", "important");
      current.style.setProperty("z-index", "auto", "important");
      if (current !== playerHostArg) {
        current.style.removeProperty("width");
        current.style.removeProperty("height");
      }
    }

    current = current.parentElement;
    depth += 1;
  }

  playerAdjustedNodes = adjusted;
}

export function restoreReaderPlayerContainer() {
  const adjusted = Array.isArray(playerAdjustedNodes) ? playerAdjustedNodes : [];
  adjusted.forEach((item) => {
    const node = item?.node;
    if (!node?.isConnected) {
      return;
    }
    node.style.position = item.position || "";
    node.style.left = item.left || "";
    node.style.top = item.top || "";
    node.style.right = item.right || "";
    node.style.bottom = item.bottom || "";
    node.style.width = item.width || "";
    node.style.height = item.height || "";
    node.style.transform = item.transform || "";
    node.style.margin = item.margin || "";
    node.style.zIndex = item.zIndex || "";
    node.removeAttribute("data-boc-reader-player-reset");
  });
  playerAdjustedNodes = [];
}

// ===== transcript-sync.js (playback sync) =====

export function startReadingViewSync() {
  if (syncTimer) {
    window.clearInterval(syncTimer);
  }
  syncTimer = window.setInterval(() => {
    syncReadingViewPlayback();
  }, 250);
}

export function stopReadingViewSync() {
  if (syncTimer) {
    window.clearInterval(syncTimer);
    syncTimer = 0;
  }
  if (miniDismissTimer) {
    window.clearTimeout(miniDismissTimer);
    miniDismissTimer = 0;
  }
  if (controlsHideTimer) {
    window.clearTimeout(controlsHideTimer);
    controlsHideTimer = 0;
  }
  closeReaderCleanup();
  if (playerMountTimer) {
    window.clearTimeout(playerMountTimer);
    playerMountTimer = 0;
  }
  if (playerRetryTimer) {
    window.clearTimeout(playerRetryTimer);
    playerRetryTimer = 0;
  }
  stopReaderPlayerObserver();
  unbindReaderPlayerControlsHover();
  if (state.reader.readingVideoEl && state.reader.readingVideoEl.__bocReadingSyncHandler) {
    const video = state.reader.readingVideoEl;
    video.removeEventListener("timeupdate", video.__bocReadingSyncHandler);
    video.removeEventListener("seeked", video.__bocReadingSyncHandler);
    video.removeEventListener("loadedmetadata", video.__bocReadingSyncHandler);
    delete video.__bocReadingSyncHandler;
  }
  videoEventsBound = false;
}

export function syncReadingViewPlayback(forceScroll = false) {
  if (!state.reader.readingViewOpen) {
    return;
  }

  if (state.reader.readingNativePageMode) {
    layoutReaderPlayerHost();
  }

  const runtimeVideo = getRuntimeVideoElement();
  const runtimeHost = findReaderPlayerHost(runtimeVideo);
  if (runtimeVideo && runtimeHost) {
    const playerChanged =
      runtimeVideo !== state.reader.readingVideoEl || runtimeHost !== playerHost;
    if (playerChanged) {
      queueEnsureReaderPlayerMounted();
    }
  }

  const video = bindReadingViewVideo(runtimeVideo || state.reader.readingVideoEl);
  if (!video) {
    renderReadingStatus("当前页面没有找到可联动的视频播放器。");
    return;
  }

  const currentTime = Number(video.currentTime || 0) || 0;
  const subtitleIndex = findActiveSubtitleIndex(currentTime);
  const chapterIndex = findActiveChapterIndex(currentTime);
  const changed =
    subtitleIndex !== state.reader.readingActiveSubtitleIndex ||
    chapterIndex !== state.reader.readingActiveChapterIndex;

  setActiveReadingItems(subtitleIndex, chapterIndex, forceScroll || changed);
  updateReaderFollowState();
  renderReadingStatus(`当前进度 ${formatCompactTimestamp(currentTime, currentTime >= 3600)}`);
}

export function setActiveReadingItems(subtitleIndex, chapterIndex, shouldScroll = false) {
  const transcriptList = byId(ids.readingTranscriptList);
  const chapterList = byId(ids.readingChapterList);
  const nextTranscript = transcriptList.querySelector(`[data-index="${subtitleIndex}"]`);
  const nextChapter = chapterList.querySelector(`[data-index="${chapterIndex}"]`);
  const currentTranscript = transcriptList.querySelector(".boc-reading-item.is-active");
  const currentChapter = chapterList.querySelector(".boc-reading-chapter.is-active");

  if (currentTranscript && currentTranscript !== nextTranscript) {
    currentTranscript.classList.remove("is-active");
  }
  if (currentChapter && currentChapter !== nextChapter) {
    currentChapter.classList.remove("is-active");
  }
  if (nextTranscript) {
    nextTranscript.classList.add("is-active");
  }
  if (nextChapter) {
    nextChapter.classList.add("is-active");
  }

  if (shouldScroll && state.reader.readingAutoScroll) {
    if (Date.now() < manualScrollPauseUntil) {
      updateReaderFollowState();
      state.reader.setActiveSubtitleIndex(subtitleIndex);
      state.reader.setActiveChapterIndex(chapterIndex);
      return;
    }
    if (nextTranscript) {
      scrollReadingTranscriptItemIntoView(nextTranscript);
    }
    if (nextChapter) {
      scrollReadingRailItemIntoView(nextChapter);
    }
  }

  state.reader.setActiveSubtitleIndex(subtitleIndex);
  state.reader.setActiveChapterIndex(chapterIndex);
}

export function scrollReadingRailItemIntoView(node) {
  if (!node) {
    return;
  }
  programmaticScrollUntil = Date.now() + 600;
  node.scrollIntoView({
    behavior: "smooth",
    block: "nearest",
    inline: "nearest"
  });
}

export function scrollReadingTranscriptItemIntoView(node) {
  if (!node) {
    return;
  }

  const transcriptList = byId(ids.readingTranscriptList);
  const inlineHost = document.getElementById("boc-reading-inline-host");
  const listRect = transcriptList.getBoundingClientRect();
  const itemRect = node.getBoundingClientRect();
  if (!(listRect.height > 0) || !(itemRect.height > 0)) {
    scrollReadingRailItemIntoView(node);
    return;
  }

  const behavior = state.reader.readingNextScrollBehavior === "auto" ? "auto" : "smooth";
  programmaticScrollUntil = Date.now() + (behavior === "auto" ? 120 : 800);
  state.reader.setNextScrollBehavior("smooth");
  if (state.reader.readingNativePageMode && inlineHost && inlineHost.scrollHeight > inlineHost.clientHeight + 8) {
    const hostRect = inlineHost.getBoundingClientRect();
    const computed = window.getComputedStyle(node);
    const lineHeight = Number.parseFloat(computed.lineHeight) || itemRect.height || 32;
    const desiredOffset = lineHeight * 2.5;
    const targetScrollTop =
      inlineHost.scrollTop + (itemRect.top - hostRect.top) - desiredOffset;
    inlineHost.scrollTo({
      top: Math.max(0, Math.round(targetScrollTop)),
      behavior
    });
    return;
  }
  if (state.reader.readingNativePageMode || transcriptList.scrollHeight <= transcriptList.clientHeight + 8) {
    const desiredTop = listRect.top + Math.max(72, Math.min(listRect.height * 0.24, 220));
    const nextTop = window.scrollY + itemRect.top - desiredTop;
    window.scrollTo({
      top: Math.max(0, Math.round(nextTop)),
      behavior
    });
    return;
  }

  const targetScrollTop =
    transcriptList.scrollTop + (itemRect.top - listRect.top) - Math.max(48, Math.min(listRect.height * 0.24, 180));
  transcriptList.scrollTo({
    top: Math.max(0, Math.round(targetScrollTop)),
    behavior
  });
}

export function jumpReadingTarget(seconds) {
  const video = bindReadingViewVideo();
  if (!video) {
    renderReadingStatus("当前页面没有找到可联动的视频播放器。");
    return;
  }

  const nextTime = Math.max(0, Number(seconds || 0) || 0);
  manualScrollPauseUntil = 0;
  state.reader.setNextScrollBehavior("auto");
  updateReaderFollowState();
  video.currentTime = nextTime;
  if (video.paused) {
    video.play().catch(() => {});
  }
  syncReadingViewPlayback(true);
}

export function onReadingChapterClick(event) {
  const target = event.target.closest(".boc-reading-chapter");
  if (!target) {
    return;
  }
  jumpReadingTarget(target.dataset.seconds);
}

export function onReadingTranscriptClick(event) {
  const target = event.target.closest(".boc-reading-item");
  if (!target) {
    return;
  }
  // Don't jump if user is selecting text
  if (window.getSelection()?.toString().trim()) {
    return;
  }
  jumpReadingTarget(target.dataset.seconds);
}

export function noteManualReaderInteraction(durationMs = 3000) {
  if (!state.reader.readingAutoScroll) {
    updateReaderFollowState();
    return;
  }
  manualScrollPauseUntil = Date.now() + durationMs;
  updateReaderFollowState();
}

export function updateReaderFollowState() {
  const readingView = document.getElementById(ids.readingView);
  if (!readingView) {
    return;
  }
  const mode =
    !state.reader.readingAutoScroll ? "off" : Date.now() < manualScrollPauseUntil ? "manual" : "auto";
  readingView.setAttribute("data-boc-reader-follow", mode);
}
