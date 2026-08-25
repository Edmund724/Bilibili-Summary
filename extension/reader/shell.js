import { state, readerState, uiState } from "../core/state.js";
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
  getReadingTranscriptPlaceholderText
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
import { refreshClip } from "../subtitle/fetcher.js";
import {
  getReaderPlayerWrapNode,
  hasNativeReaderPlayerLayoutIssue,
  ensureReaderPlayerMounted,
  isReaderPresentationStable,
  unbindReaderLayout,
  layoutReaderPlayerHost,
  cleanupReaderPlayerHost,
  startReaderPlayerObserver,
  scheduleReaderMiniPlayerDismiss,
  getReaderPlayerControlsState,
  hasReaderPlayerControlsIssue,
  setReaderPlayerControlsVisible,
  bindReaderHeaderActionsHover
} from "./player-host.js";
import {
  cleanupReaderFloatingArtifacts,
  applyReaderPageFocus,
  clearReaderPageFocus,
  moveReadingMainInline,
  restoreReadingMainInline,
  alignReaderViewportToPlayer
} from "./page-frame.js";
import {
  startReadingViewSync,
  stopReadingViewSync,
  syncReadingViewPlayback,
  updateReaderFollowState
} from "./transcript-sync.js";

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

export { logInfo, logWarn, shouldDebugLog };

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
  readerState.setViewOpen(true);
  readerState.setNativePageMode(true);
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
  const mountedPlayerHost = state.reader.readingPlayerHost || earlyPlayerHost;
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
  if (state.reader.readingPlayerRetryTimer) {
    window.clearTimeout(state.reader.readingPlayerRetryTimer);
    state.reader.readingPlayerRetryTimer = 0;
  }
  // Keep trying to mount player in background
  const tryMount = async () => {
    state.reader.readingPlayerRetryTimer = 0;
    if (!state.reader.readingViewOpen || !isReaderMode()) return;
    const mounted = await ensureReaderPlayerMounted({ retries: 10, delayMs: 200, forceLayout: true });
    const retryHost = state.reader.readingPlayerHost;
    if (retryHost) {
      retryHost.removeAttribute("data-boc-reader-fading");
    }
    if (mounted) {
      finishEnterReaderMode();
    } else if (state.reader.readingViewOpen) {
      state.reader.readingPlayerRetryTimer = window.setTimeout(tryMount, 500);
    }
  };
  state.reader.readingPlayerRetryTimer = window.setTimeout(tryMount, 500);
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

export function closeReadingView() {
  cleanupReaderFloatingArtifacts();
  readerState.setViewOpen(false);
  readerState.setNativePageMode(false);
  readerState.setViewReady(false);
  readerState.setSettingsExpanded(false);
  state.reader.readingManualScrollPauseUntil = 0;
  state.reader.readingProgrammaticScrollUntil = 0;
  readerState.setNextScrollBehavior("smooth");
  if (state.reader.readingPlayerRetryTimer) {
    window.clearTimeout(state.reader.readingPlayerRetryTimer);
    state.reader.readingPlayerRetryTimer = 0;
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
  readerState.setActiveSubtitleIndex(-1);
  readerState.setActiveChapterIndex(-1);
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
  readerState.setTheme(normalizeReaderTheme(settings?.readerTheme));
  readerState.setFontScale(normalizeReaderFontScale(settings?.readerFontScale));
  readerState.setLetterSpacing(normalizeReaderLetterSpacing(settings?.readerLetterSpacing ?? settings?.readerLineHeight));
  readerState.setLineHeight(normalizeReaderLineHeight(settings?.readerLineHeight));
  readerState.setContentWidth(normalizeReaderContentWidth(settings?.readerContentWidth));
  readerState.setChapterVisible(settings?.readerChapterVisible !== undefined ? Boolean(settings.readerChapterVisible) : true);
  readerState.setTranscriptVisible(normalizeReaderTranscriptVisible(settings?.readerTranscriptVisible));
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
  const inlineHost = document.getElementById("boc-reading-inline-host");
  if (inlineHost) {
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
  readerState.setTheme(normalizeReaderTheme(next.readerTheme ?? state.reader.readingTheme));
  readerState.setFontScale(normalizeReaderFontScale(next.readerFontScale ?? state.reader.readingFontScale));
  readerState.setLetterSpacing(
    normalizeReaderLetterSpacing(next.readerLetterSpacing ?? state.reader.readingLetterSpacing)
  );
  readerState.setLineHeight(normalizeReaderLineHeight(next.readerLineHeight ?? state.reader.readingLineHeight));
  readerState.setContentWidth(normalizeReaderContentWidth(next.readerContentWidth ?? state.reader.readingContentWidth));
  readerState.setChapterVisible(next.readerChapterVisible !== undefined ? Boolean(next.readerChapterVisible) : state.reader.readingChapterVisible);
  readerState.setTranscriptVisible(
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
  readerState.setViewReady(Boolean(ready));
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

  const playerHost = state.reader.readingPlayerHost || findReaderPlayerHost(getRuntimeVideoElement());
  const wrapNode = getReaderPlayerWrapNode(playerHost);
  const video = state.reader.readingVideoEl || getRuntimeVideoElement();
  const hostChain = [];
  let current = playerHost;
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
    readyStable: isReaderPresentationStable(playerHost),
    hasLayoutIssue: hasNativeReaderPlayerLayoutIssue(playerHost),
    hasRoot: Boolean(document.getElementById(ids.root)),
    hasReadingView: Boolean(document.getElementById(ids.readingView)),
    playerHost: playerHost
      ? {
          tag: playerHost.tagName,
          id: playerHost.id || "",
          className: typeof playerHost.className === "string" ? playerHost.className : ""
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
  playerHost = state.reader.readingPlayerHost,
  { reason = "unknown", retryDelayMs = 90 } = {}
) {
  if (!state.reader.readingNativePageMode || !playerHost || isWatchlaterPage()) {
    return false;
  }

  const before = getReaderPlayerControlsState(playerHost);
  logInfo("[BOC] reader controls check", {
    reason,
    hostClassName: typeof playerHost.className === "string" ? playerHost.className : "",
    hostHasNoCursor: before.hostHasNoCursor,
    controlRootFound: before.controlRootFound,
    controls: before.nodes
  });

  if (!hasReaderPlayerControlsIssue(playerHost)) {
    return false;
  }

  logInfo("[BOC] recovering normal reader controls", {
    reason,
    hostClassName: typeof playerHost.className === "string" ? playerHost.className : ""
  });
  setReaderPlayerControlsVisible(true, playerHost);
  layoutReaderPlayerHost();

  let after = getReaderPlayerControlsState(playerHost);
  logInfo("[BOC] reader controls after recovery", {
    reason,
    hostClassName: typeof playerHost.className === "string" ? playerHost.className : "",
    hostHasNoCursor: after.hostHasNoCursor,
    controls: after.nodes,
    retried: false
  });
  if (!hasReaderPlayerControlsIssue(playerHost)) {
    return true;
  }

  await sleep(retryDelayMs);
  logInfo("[BOC] retrying normal reader controls recovery", {
    reason,
    hostClassName: typeof playerHost.className === "string" ? playerHost.className : ""
  });
  setReaderPlayerControlsVisible(true, playerHost);
  layoutReaderPlayerHost();
  after = getReaderPlayerControlsState(playerHost);
  logInfo("[BOC] reader controls after retry", {
    reason,
    hostClassName: typeof playerHost.className === "string" ? playerHost.className : "",
    hostHasNoCursor: after.hostHasNoCursor,
    controls: after.nodes,
    retried: true
  });
  return !hasReaderPlayerControlsIssue(playerHost);
}
