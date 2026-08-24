import { state, readerState, clipState, playerAiState, uiState } from "./state.js";
import { sleep } from "./shared-defaults.js";
import {
  byId,
  findReaderPlayerHost,
  getRuntimeVideoElement,
  isReaderMode,
  isWatchlaterPage,
  cleanVideoUrl,
  getErrorMessage,
  sendRuntimeMessage,
  ensureRunActive,
  isStaleRunError,
  isExtensionContextInvalidated,
  toReadableText
} from "./router.js";
import {
  getReadingTranscriptItems,
  getReadingTranscriptPlaceholderText,
  findActiveSubtitleIndex,
  findActiveChapterIndex,
  normalizeChapters,
  rebuildDerivedContent
} from "./subtitle.js";
import {
  escapeHtml,
  formatCompactTimestamp,
  normalizeChapterTime,
  buildBiliApiError,
  buildMarkdown,
  buildSrt,
  buildTxt,
  getCurrentAid,
  normalizeFolder,
  buildNoteFilename,
  buildFrontMatter,
  pushOptionalLines,
  buildNotePlaceholderLines,
  buildFolderTemplateContext,
  buildFrontmatterTemplateContext,
  buildNotePlaceholderTemplateContext,
  buildSubtitleCandidates,
  buildSubtitleInfoRequests,
  mapChaptersFromPlayerData,
  mapSubtitleTracks,
  normalizeSubtitleUrl,
  normalizeSubtitleUrlForCache,
  parseFrontmatterArrayItems,
  pickPreferredSubtitle,
  readRuntimeVideoDuration,
  resolveFolderTemplate,
  resolveFrontmatterTemplateValue,
  sanitizeFileName,
  sanitizeFolderTemplateValue,
  shouldShowHoursInNote,
  shouldShowHoursInSubtitle,
  subtitlePriority,
  validateSubtitleByDuration,
  fetchJson,
  fetchJsonInBackground,
  fetchSubtitleBody,
  clearSubtitleCacheByKey,
  saveSubtitleToCache,
  fetchHotComments
} from "./formatters.js";
import {
  isVisibleReaderControl,
  resetPlayerAiQuickActionRetryCount,
  schedulePlayerAiQuickActionSync
} from "./player-ai.js";
import {
  refreshClip
} from "./panel.js";


export function getReaderContentMaxPx() {
  if (state.readingContentWidth === "compact") {
    return 680;
  }
  if (state.readingContentWidth === "narrow") {
    return 760;
  }
  if (state.readingContentWidth === "wide") {
    return 980;
  }
  if (state.readingContentWidth === "full") {
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

export function clearNativeReaderFloatingStyles(playerHost = state.readingPlayerHost) {
  if (!state.readingNativePageMode || !playerHost) {
    return;
  }

  const targets = [];
  let current = playerHost;
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

export function getReaderPlayerWrapNode(playerHost = state.readingPlayerHost) {
  return (
    playerHost?.closest?.("#playerWrap") ||
    playerHost?.closest?.(".player-wrap") ||
    document.getElementById("playerWrap") ||
    document.querySelector(".player-wrap")
  );
}

export function hasNativeReaderPlayerLayoutIssue(playerHost = state.readingPlayerHost) {
  if (!state.readingNativePageMode || !playerHost) {
    return false;
  }

  const playerStyle = window.getComputedStyle(playerHost);
  if (playerStyle.position === "fixed" || playerStyle.position === "sticky") {
    return true;
  }

  const playerRect = playerHost.getBoundingClientRect();
  const wrapNode = getReaderPlayerWrapNode(playerHost);
  if (!wrapNode) {
    return false;
  }

  const wrapRect = wrapNode.getBoundingClientRect();
  return wrapRect.height <= 8 && playerRect.height > 120;
}


export function shouldDebugLog() {
  return Boolean(state.settings?.enableDebugLogs);
}

export function logInfo(...args) {
  if (shouldDebugLog()) {
    console.info(...args);
  }
}

export function logWarn(...args) {
  if (shouldDebugLog()) {
    console.warn(...args);
  }
}

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
  if (state.settingsWatcherBound || !chrome.storage?.onChanged) {
    return;
  }
  state.settingsWatcherBound = true;

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
        state.settings = settings;
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
  const subtitles = state.subtitles || [];

  if (subtitles.length === 0) {
    select.innerHTML = '<option value="">暂无字幕</option>';
    select.disabled = true;
    return;
  }

  select.innerHTML = subtitles
    .map((item) => {
      const selectedById =
        state.selectedSubtitleId && String(item.id) === String(state.selectedSubtitleId);
      const selectedByUrl = item.subtitleUrl === state.selectedSubtitleUrl;
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
export function cleanupReaderFloatingArtifacts(playerHost = state.readingPlayerHost) {
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
  }
  dismissReaderMiniPlayer(playerHost);
  const runtimeHost = findReaderPlayerHost(getRuntimeVideoElement());
  if (runtimeHost && runtimeHost !== playerHost) {
    dismissReaderMiniPlayer(runtimeHost);
  }
}

export async function enterReaderMode() {
  const readingView = byId(ids.readingView);
  state.readingViewOpen = true;
  state.readingNativePageMode = true;
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
  const mountedPlayerHost = state.readingPlayerHost || earlyPlayerHost;
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
  if (state.readingPlayerRetryTimer) {
    window.clearTimeout(state.readingPlayerRetryTimer);
    state.readingPlayerRetryTimer = 0;
  }
  // Keep trying to mount player in background
  const tryMount = async () => {
    state.readingPlayerRetryTimer = 0;
    if (!state.readingViewOpen || !isReaderMode()) return;
    const mounted = await ensureReaderPlayerMounted({ retries: 10, delayMs: 200, forceLayout: true });
    const retryHost = state.readingPlayerHost;
    if (retryHost) {
      retryHost.removeAttribute("data-boc-reader-fading");
    }
    if (mounted) {
      finishEnterReaderMode();
    } else if (state.readingViewOpen) {
      state.readingPlayerRetryTimer = window.setTimeout(tryMount, 500);
    }
  };
  state.readingPlayerRetryTimer = window.setTimeout(tryMount, 500);
}

export function finishEnterReaderMode() {
  if (!state.readingViewOpen || !isReaderMode()) return;

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

export function maybeRefreshReaderSubtitleInBackground() {
  if (state.subtitleBody.length) {
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

export async function ensureReaderPlayerMounted({ retries = 1, delayMs = 100, forceLayout = false } = {}) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const video = getRuntimeVideoElement();
    const playerHost = findReaderPlayerHost(video);
    if (video && playerHost) {
      const previousHost = state.readingPlayerHost;
      const previousVideo = state.readingVideoEl;
      video.controls = false;
      video.removeAttribute("controls");
      video.disablePictureInPicture = true;
      video.setAttribute("disablepictureinpicture", "");
      video.removeAttribute("autopictureinpicture");
      state.readingPlayerHost = playerHost;
      const miniPlayerClosed = dismissReaderMiniPlayer(playerHost);
      if (miniPlayerClosed) {
        await sleep(120);
      }
      const activeHost = findReaderPlayerHost(video) || playerHost;
      state.readingPlayerHost = activeHost;
      normalizeReaderPlayerContainer(activeHost);
      if (state.readingNativePageMode) {
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
        state.readingVideoEventsBound = false;
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
        (state.readingNativePageMode && hasNativeReaderPlayerLayoutIssue(activeHost))
      ) {
        layoutReaderPlayerHost();
        if (state.readingNativePageMode && hasNativeReaderPlayerLayoutIssue(activeHost)) {
          normalizeReaderPlayerContainer(activeHost);
          clearNativeReaderFloatingStyles(activeHost);
          layoutReaderPlayerHost();
        }
      }
      if (state.readingNativePageMode && !isWatchlaterPage()) {
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
  if (!state.readingViewOpen || !isReaderMode() || state.readingPlayerMountTimer) {
    return;
  }
  state.readingPlayerMountTimer = window.setTimeout(() => {
    state.readingPlayerMountTimer = 0;
    ensureReaderPlayerMounted({ retries: 12, delayMs: 120, forceLayout: true }).catch((error) => {
      logWarn("[BOC] ensure reader player mounted failed", error);
    });
  }, 60);
}

export function closeReadingView() {
  cleanupReaderFloatingArtifacts();
  state.readingViewOpen = false;
  state.readingNativePageMode = false;
  state.readingViewReady = false;
  state.readingSettingsExpanded = false;
  state.readingManualScrollPauseUntil = 0;
  state.readingProgrammaticScrollUntil = 0;
  state.readingNextScrollBehavior = "smooth";
  if (state.readingPlayerRetryTimer) {
    window.clearTimeout(state.readingPlayerRetryTimer);
    state.readingPlayerRetryTimer = 0;
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
  const chapters = normalizeChapters(state.chapters || []);
  const body = Array.isArray(state.subtitleBody) ? state.subtitleBody : [];
  const transcriptItems = getReadingTranscriptItems();
  const withHours = shouldShowHoursInNote(state, body);
  const hasChapters = chapters.length > 0;

  if (titleNode) {
    titleNode.textContent = state.title || "B站字幕阅读";
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
  state.readingActiveSubtitleIndex = -1;
  state.readingActiveChapterIndex = -1;
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
  state.readingTheme = normalizeReaderTheme(settings?.readerTheme);
  state.readingFontScale = normalizeReaderFontScale(settings?.readerFontScale);
  state.readingLetterSpacing = normalizeReaderLetterSpacing(settings?.readerLetterSpacing ?? settings?.readerLineHeight);
  state.readingLineHeight = normalizeReaderLineHeight(settings?.readerLineHeight);
  state.readingContentWidth = normalizeReaderContentWidth(settings?.readerContentWidth);
  state.readingChapterVisible = settings?.readerChapterVisible !== undefined ? Boolean(settings.readerChapterVisible) : true;
  state.readingTranscriptVisible = normalizeReaderTranscriptVisible(settings?.readerTranscriptVisible);
}

export function applyReadingViewPresentation() {
  const readingView = byId(ids.readingView);
  readingView.dataset.theme = state.readingTheme;
  readingView.dataset.fontScale = state.readingFontScale;
  readingView.dataset.letterSpacing = state.readingLetterSpacing;
  readingView.dataset.lineHeight = state.readingLineHeight;
  readingView.dataset.contentWidth = state.readingContentWidth;
  readingView.dataset.chapterVisibility = state.readingChapterVisible ? "auto" : "hide";
  readingView.dataset.transcriptVisible = state.readingTranscriptVisible ? "1" : "0";
  document.documentElement.dataset.bocReaderTheme = state.readingTheme;
  document.documentElement.dataset.bocReaderFontScale = state.readingFontScale;
  document.documentElement.dataset.bocReaderLetterSpacing = state.readingLetterSpacing;
  document.documentElement.dataset.bocReaderLineHeight = state.readingLineHeight;
  document.documentElement.dataset.bocReaderContentWidth = state.readingContentWidth;
  document.documentElement.dataset.bocReaderChapterVisibility = state.readingChapterVisible ? "auto" : "hide";
  document.documentElement.dataset.bocReaderTranscriptVisible = state.readingTranscriptVisible ? "1" : "0";
  document.body.dataset.bocReaderTheme = state.readingTheme;
  document.body.dataset.bocReaderFontScale = state.readingFontScale;
  document.body.dataset.bocReaderLetterSpacing = state.readingLetterSpacing;
  document.body.dataset.bocReaderLineHeight = state.readingLineHeight;
  document.body.dataset.bocReaderContentWidth = state.readingContentWidth;
  document.body.dataset.bocReaderChapterVisibility = state.readingChapterVisible ? "auto" : "hide";
  document.body.dataset.bocReaderTranscriptVisible = state.readingTranscriptVisible ? "1" : "0";
  const readingChapterVisibleEl = byId(ids.readingChapterVisible);
  if (readingChapterVisibleEl) {
    readingChapterVisibleEl.checked = state.readingChapterVisible;
  }
  const main = document.querySelector(".boc-reading-main");
  if (main) {
    main.style.display = state.readingTranscriptVisible ? "" : "none";
  }
  const inlineHost = document.getElementById("boc-reading-inline-host");
  if (inlineHost) {
    const leftContainer = document.querySelector(".left-container");
    const bgColor = leftContainer ? getComputedStyle(leftContainer).backgroundColor : "";
    if (state.readingTranscriptVisible) {
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
      getCurrent: () => state.readingFontScale,
      buildPayload: (value) => ({ readerFontScale: value })
    },
    readerLetterSpacing: {
      options: ["tighter", "tight", "normal", "relaxed", "loose"],
      labelKey: "letterSpacing",
      getCurrent: () => state.readingLetterSpacing,
      buildPayload: (value) => ({ readerLetterSpacing: value })
    },
    readerLineHeight: {
      options: ["compact", "tight", "normal", "relaxed", "loose"],
      labelKey: "lineHeight",
      getCurrent: () => state.readingLineHeight,
      buildPayload: (value) => ({ readerLineHeight: value })
    },
    readerContentWidth: {
      options: ["compact", "narrow", "medium", "wide", "full"],
      labelKey: "contentWidth",
      getCurrent: () => state.readingContentWidth,
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
  settingsPanel.hidden = !state.readingSettingsExpanded;
  settingsBtn.classList.toggle("is-active", state.readingSettingsExpanded);
  byId(ids.readingAutoScroll).checked = state.readingAutoScroll;
  byId(ids.readingTranscriptVisible).checked = state.readingTranscriptVisible;
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
  const description = String(state.description || "").trim();

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
    descriptionNode.classList.toggle("is-collapsed", !state.readingDescriptionExpanded);
    const hasOverflow = fullScrollHeight > clampedClientHeight + 2;
    if (!hasOverflow) {
      descriptionNode.classList.remove("is-collapsed");
      descriptionBtn.hidden = true;
      return;
    }
    descriptionBtn.hidden = false;
    descriptionBtn.textContent = state.readingDescriptionExpanded ? "收起简介" : "查看更多";
  }
}

export function buildReadingSummaryItems() {
  const items = [];
  if (state.title) {
    items.push({ label: "标题", value: state.title });
  }
  if (state.author) {
    items.push({ label: "作者", value: state.author });
  }
  if (state.uploadDate) {
    items.push({ label: "日期", value: state.uploadDate });
  }
  if (Number(state.pageCount) > 1) {
    const pageParts = [`P${Number(state.pageIndex) > 0 ? Number(state.pageIndex) : 1}`];
    if (state.pageTitle) {
      pageParts.push(state.pageTitle);
    }
    items.push({ label: "分P", value: pageParts.join(" ") });
  }
  return items;
}

export function updateReaderPreferences(next, { persist = true } = {}) {
  state.readingTheme = normalizeReaderTheme(next.readerTheme ?? state.readingTheme);
  state.readingFontScale = normalizeReaderFontScale(next.readerFontScale ?? state.readingFontScale);
  state.readingLetterSpacing = normalizeReaderLetterSpacing(
    next.readerLetterSpacing ?? state.readingLetterSpacing
  );
  state.readingLineHeight = normalizeReaderLineHeight(next.readerLineHeight ?? state.readingLineHeight);
  state.readingContentWidth = normalizeReaderContentWidth(next.readerContentWidth ?? state.readingContentWidth);
  state.readingChapterVisible = next.readerChapterVisible !== undefined ? Boolean(next.readerChapterVisible) : state.readingChapterVisible;
  state.readingTranscriptVisible = normalizeReaderTranscriptVisible(
    next.readerTranscriptVisible ?? state.readingTranscriptVisible
  );
  state.settings = {
    ...state.settings,
    readerTheme: state.readingTheme,
    readerFontScale: state.readingFontScale,
    readerLetterSpacing: state.readingLetterSpacing,
    readerLineHeight: state.readingLineHeight,
    readerContentWidth: state.readingContentWidth,
    readerChapterVisible: state.readingChapterVisible,
    readerTranscriptVisible: state.readingTranscriptVisible
  };
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
  if (state.author) {
    parts.push(state.author);
  }
  if (state.uploadDate) {
    parts.push(state.uploadDate);
  }
  parts.push("bilibili.com");
  if (Number(state.pageCount) > 1) {
    const pageParts = [`P${Number(state.pageIndex) > 0 ? Number(state.pageIndex) : 1}`];
    if (state.pageTitle) {
      pageParts.push(state.pageTitle);
    }
    parts.push(pageParts.join(" "));
  }
  if (state.selectedSubtitleLang) {
    parts.push(`字幕：${state.selectedSubtitleLang}`);
  }
  return parts.join(" · ");
}

export function renderReadingStatus(text) {
  byId(ids.readingStatus).textContent = String(text || "");
}

export function setReadingViewReady(ready) {
  state.readingViewReady = Boolean(ready);
  const readingView = document.getElementById(ids.readingView);
  if (!readingView) {
    return;
  }
  readingView.setAttribute("data-boc-reader-ready", state.readingViewReady ? "1" : "0");
  readingView.setAttribute("aria-busy", state.readingViewReady ? "false" : "true");
}

export function isReaderPresentationStable(playerHost = state.readingPlayerHost) {
  if (!state.readingViewOpen || !playerHost?.isConnected) {
    return false;
  }
  const rect = playerHost.getBoundingClientRect();
  if (!(rect.width > 240) || !(rect.height > 120)) {
    return false;
  }
  if (!state.readingNativePageMode) {
    return true;
  }
  return !hasNativeReaderPlayerLayoutIssue(playerHost);
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

  const playerHost = state.readingPlayerHost || findReaderPlayerHost(getRuntimeVideoElement());
  const wrapNode = getReaderPlayerWrapNode(playerHost);
  const video = state.readingVideoEl || getRuntimeVideoElement();
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
    readingViewOpen: state.readingViewOpen,
    readingNativePageMode: state.readingNativePageMode,
    readingViewReady: state.readingViewReady,
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

export function bindReaderLayout() {
  if (state.readingLayoutBound) {
    return;
  }
  window.addEventListener("resize", layoutReaderPlayerHost);
  window.addEventListener("scroll", layoutReaderPlayerHost, { passive: true });
  document.addEventListener("fullscreenchange", layoutReaderPlayerHost);
  document.addEventListener("webkitfullscreenchange", layoutReaderPlayerHost);
  state.readingLayoutBound = true;
}

export function unbindReaderLayout() {
  if (!state.readingLayoutBound) {
    return;
  }
  window.removeEventListener("resize", layoutReaderPlayerHost);
  window.removeEventListener("scroll", layoutReaderPlayerHost);
  document.removeEventListener("fullscreenchange", layoutReaderPlayerHost);
  document.removeEventListener("webkitfullscreenchange", layoutReaderPlayerHost);
  state.readingLayoutBound = false;
}

export function layoutReaderPlayerHost() {
  if (!state.readingViewOpen || !isReaderMode()) {
    return;
  }

  const readingView = byId(ids.readingView);
  const playerHost = state.readingPlayerHost;
  const slot = byId(ids.readingPlayerSlot);
  if (!playerHost) {
    return;
  }

  if (state.readingNativePageMode) {
    const rect = playerHost.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) {
      return;
    }

    const video = state.readingVideoEl;
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

    clearNativeReaderFloatingStyles(playerHost);
    cleanupReaderPlayerHostNode(playerHost);
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

  const video = state.readingVideoEl;
  const aspectRatio =
    Number(video?.videoWidth) > 0 && Number(video?.videoHeight) > 0
      ? Number(video.videoWidth) / Number(video.videoHeight)
      : 16 / 9;
  const targetHeight = rect.height;
  const targetWidth = Math.min(rect.width, targetHeight * aspectRatio);
  const left = rect.left + (rect.width - targetWidth) / 2;

  readingView.style.setProperty("--boc-reader-player-rendered-width", `${Math.round(targetWidth)}px`);
  readingView.style.setProperty("--boc-reader-player-rendered-height", `${Math.round(targetHeight)}px`);
  playerHost.style.setProperty("position", "fixed", "important");
  playerHost.style.setProperty("left", `${Math.round(left)}px`, "important");
  playerHost.style.setProperty("top", `${Math.round(rect.top)}px`, "important");
  playerHost.style.setProperty("width", `${Math.round(targetWidth)}px`, "important");
  playerHost.style.setProperty("height", `${Math.round(targetHeight)}px`, "important");
  playerHost.style.setProperty("margin", "0", "important");
  playerHost.style.setProperty("z-index", "2147483647", "important");
  playerHost.style.setProperty("max-width", "none", "important");
  playerHost.style.setProperty("max-height", "none", "important");
  updateReadingTranscriptTailSpacer();
}

export function cleanupReaderPlayerHostNode(playerHost) {
  if (!playerHost) {
    return;
  }
  playerHost.classList.remove("boc-reader-player-host");
  playerHost.style.removeProperty("position");
  playerHost.style.removeProperty("inset");
  playerHost.style.removeProperty("left");
  playerHost.style.removeProperty("top");
  playerHost.style.removeProperty("right");
  playerHost.style.removeProperty("bottom");
  playerHost.style.removeProperty("transform");
  playerHost.style.removeProperty("width");
  playerHost.style.removeProperty("height");
  playerHost.style.removeProperty("margin");
  playerHost.style.removeProperty("z-index");
  playerHost.style.removeProperty("max-width");
  playerHost.style.removeProperty("max-height");
}

export function cleanupReaderPlayerHost() {
  restoreReaderPlayerContainer();
  unbindReaderPlayerControlsHover();
  unbindReaderHeaderActionsHover();
  if (state.readingControlsRecoveryTimer) {
    window.clearTimeout(state.readingControlsRecoveryTimer);
    state.readingControlsRecoveryTimer = 0;
  }
  state.readingControlsRecoveryInFlight = false;
  const readingView = byId(ids.readingView);
  readingView?.style.removeProperty("--boc-reader-player-rendered-width");
  readingView?.style.removeProperty("--boc-reader-player-rendered-height");
  const playerHost = state.readingPlayerHost;
  if (!playerHost) {
    return;
  }
  setReaderPlayerControlsVisible(false, playerHost);
  cleanupReaderPlayerHostNode(playerHost);
  state.readingPlayerHost = null;
}

export function startReadingViewSync() {
  if (state.readingSyncTimer) {
    window.clearInterval(state.readingSyncTimer);
  }
  state.readingSyncTimer = window.setInterval(() => {
    syncReadingViewPlayback();
  }, 250);
}

export function stopReadingViewSync() {
  if (state.readingSyncTimer) {
    window.clearInterval(state.readingSyncTimer);
    state.readingSyncTimer = 0;
  }
  if (state.readingMiniDismissTimer) {
    window.clearTimeout(state.readingMiniDismissTimer);
    state.readingMiniDismissTimer = 0;
  }
  if (state.readingControlsHideTimer) {
    window.clearTimeout(state.readingControlsHideTimer);
    state.readingControlsHideTimer = 0;
  }
  if (state.readingControlsRecoveryTimer) {
    window.clearTimeout(state.readingControlsRecoveryTimer);
    state.readingControlsRecoveryTimer = 0;
  }
  state.readingControlsRecoveryInFlight = false;
  if (state.readingPlayerMountTimer) {
    window.clearTimeout(state.readingPlayerMountTimer);
    state.readingPlayerMountTimer = 0;
  }
  if (state.readingPlayerRetryTimer) {
    window.clearTimeout(state.readingPlayerRetryTimer);
    state.readingPlayerRetryTimer = 0;
  }
  stopReaderPlayerObserver();
  unbindReaderPlayerControlsHover();
  if (state.readingVideoEl && state.readingVideoEl.__bocReadingSyncHandler) {
    const video = state.readingVideoEl;
    video.removeEventListener("timeupdate", video.__bocReadingSyncHandler);
    video.removeEventListener("seeked", video.__bocReadingSyncHandler);
    video.removeEventListener("loadedmetadata", video.__bocReadingSyncHandler);
    delete video.__bocReadingSyncHandler;
  }
  state.readingVideoEventsBound = false;
}

export function startReaderPlayerObserver() {
  if (!isReaderMode() || state.readingPlayerObserver || !document.body) {
    return;
  }
  const observer = new MutationObserver(() => {
    if (!state.readingViewOpen) {
      return;
    }
    const nextVideo = getRuntimeVideoElement();
    const nextHost = findReaderPlayerHost(nextVideo);
    if (nextVideo && nextHost && (nextVideo !== state.readingVideoEl || nextHost !== state.readingPlayerHost)) {
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
  state.readingPlayerObserver = observer;
}

export function stopReaderPlayerObserver() {
  if (state.readingPlayerObserver) {
    state.readingPlayerObserver.disconnect();
    state.readingPlayerObserver = null;
  }
}

export function bindReadingViewVideo(video = getRuntimeVideoElement()) {
  if (!video) {
    if (state.readingVideoEl && state.readingVideoEl.__bocReadingSyncHandler) {
      const prev = state.readingVideoEl;
      prev.removeEventListener("timeupdate", prev.__bocReadingSyncHandler);
      prev.removeEventListener("seeked", prev.__bocReadingSyncHandler);
      prev.removeEventListener("loadedmetadata", prev.__bocReadingSyncHandler);
      delete prev.__bocReadingSyncHandler;
    }
    state.readingVideoEl = null;
    state.readingVideoEventsBound = false;
    return null;
  }

  if (state.readingVideoEl === video && state.readingVideoEventsBound) {
    return video;
  }

  if (state.readingVideoEl && state.readingVideoEl.__bocReadingSyncHandler) {
    const prev = state.readingVideoEl;
    prev.removeEventListener("timeupdate", prev.__bocReadingSyncHandler);
    prev.removeEventListener("seeked", prev.__bocReadingSyncHandler);
    prev.removeEventListener("loadedmetadata", prev.__bocReadingSyncHandler);
  }

  const syncHandler = (event) => {
    if (state.readingViewOpen) {
      if (event?.type === "loadedmetadata") {
        layoutReaderPlayerHost();
      }
      if (event?.type === "seeked") {
        state.readingNextScrollBehavior = "auto";
        queueEnsureReaderPlayerControlsRecovered({
          reason: "seeked",
          delayMs: 140,
          minIntervalMs: 320
        });
      }
      const latestHost = findReaderPlayerHost(video);
      if (latestHost && latestHost !== state.readingPlayerHost) {
        queueEnsureReaderPlayerMounted();
      }
      syncReadingViewPlayback();
    }
  };
  video.addEventListener("timeupdate", syncHandler);
  video.addEventListener("seeked", syncHandler);
  video.addEventListener("loadedmetadata", syncHandler);
  video.__bocReadingSyncHandler = syncHandler;
  state.readingVideoEl = video;
  state.readingPlayerHost = findReaderPlayerHost(video) || state.readingPlayerHost;
  state.readingVideoEventsBound = true;
  return video;
}

export function applyReaderPageFocus() {
  clearReaderPageFocus();

  const root = byId(ids.root);
  const video = getRuntimeVideoElement();
  const playerHost = findReaderPlayerHost(video);
  const titleNode = findReaderTitleContainer();
  const keepRoots = [root, playerHost, titleNode].filter(Boolean);

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

export function moveReadingMainInline() {
  if (!isReaderMode()) {
    return;
  }

  const readingMain = document.querySelector(".boc-reading-main");
  if (!readingMain) {
    return;
  }

  if (!state.readingMainOriginalParent) {
    state.readingMainOriginalParent = readingMain.parentElement;
    state.readingMainOriginalNextSibling = readingMain.nextSibling;
  }
  const playerWrap =
    document.getElementById("playerWrap") ||
    state.readingPlayerHost?.closest?.("#playerWrap") ||
    state.readingPlayerHost;
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
      if (Date.now() <= state.readingProgrammaticScrollUntil) {
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
  const leftContainer = document.querySelector(".left-container");
  const bgColor = leftContainer ? getComputedStyle(leftContainer).backgroundColor : "";
  if (state.readingTranscriptVisible) {
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
  updateReadingTranscriptTailSpacer();
}

export function restoreReadingMainInline() {
  const readingMain = document.querySelector(".boc-reading-main");
  const inlineHost = document.getElementById("boc-reading-inline-host");
  if (readingMain && state.readingMainOriginalParent) {
    if (state.readingMainOriginalNextSibling?.parentNode === state.readingMainOriginalParent) {
      state.readingMainOriginalParent.insertBefore(readingMain, state.readingMainOriginalNextSibling);
    } else {
      state.readingMainOriginalParent.appendChild(readingMain);
    }
  }
  inlineHost?.remove();
  state.readingMainOriginalParent = null;
  state.readingMainOriginalNextSibling = null;
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

export function findReaderContentHost(playerHost = state.readingPlayerHost, titleNode = findReaderTitleContainer()) {
  if (!playerHost && !titleNode) {
    return null;
  }

  let current = titleNode || playerHost;
  while (current && current !== document.body) {
    const containsPlayer = playerHost ? current.contains(playerHost) : true;
    const containsTitle = titleNode ? current.contains(titleNode) : true;
    if (containsPlayer && containsTitle) {
      return current;
    }
    current = current.parentElement;
  }

  return playerHost?.parentElement || titleNode?.parentElement || null;
}

export function moveRootToReaderContentHost() {
  return;
}

export function restoreRootMount() {
  return;
}

export function dismissReaderMiniPlayer(playerHost = state.readingPlayerHost) {
  const explicitClose = Array.from(document.querySelectorAll(".bpx-player-mini-close")).find(isVisibleReaderControl);
  if (explicitClose) {
    explicitClose.click();
    return true;
  }

  if (!playerHost) {
    return false;
  }

  const computed = window.getComputedStyle(playerHost);
  const fixedLike = computed.position === "fixed" || /mini|picture|float|fixed-player/i.test(playerHost.className || "");
  if (!fixedLike) {
    return false;
  }

  const roots = Array.from(
    new Set([
      playerHost,
      playerHost.parentElement,
      playerHost.closest("#playerWrap"),
      playerHost.closest("#bilibili-player")
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

  const playerRect = playerHost.getBoundingClientRect();
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

export function scheduleReaderMiniPlayerDismiss(maxAttempts = 12, delayMs = 180) {
  if (!state.readingViewOpen) {
    return;
  }
  if (state.readingMiniDismissTimer) {
    window.clearTimeout(state.readingMiniDismissTimer);
    state.readingMiniDismissTimer = 0;
  }

  let attempts = 0;
  const run = () => {
    if (!state.readingViewOpen) {
      state.readingMiniDismissTimer = 0;
      return;
    }

    const closed = dismissReaderMiniPlayer();
    const host = findReaderPlayerHost(getRuntimeVideoElement());
    if (host) {
      state.readingPlayerHost = host;
      normalizeReaderPlayerContainer(host);
      layoutReaderPlayerHost();
    }

    attempts += 1;
    const miniExists = Boolean(document.querySelector(".bpx-player-mini-close, .bpx-player-mini-warp"));
    const hostFixed = Boolean(host && window.getComputedStyle(host).position === "fixed");
    if (attempts < maxAttempts && (miniExists || hostFixed || closed)) {
      state.readingMiniDismissTimer = window.setTimeout(run, delayMs);
      return;
    }
    state.readingMiniDismissTimer = 0;
  };

  state.readingMiniDismissTimer = window.setTimeout(run, 40);
}

export function getReaderControlsRoot(playerHost = state.readingPlayerHost) {
  return (
    playerHost?.closest?.("#playerWrap") ||
    playerHost?.closest?.("#bilibili-player") ||
    playerHost ||
    document.getElementById("playerWrap") ||
    document.getElementById("bilibili-player")
  );
}

export function getReaderPlayerControlsState(playerHost = state.readingPlayerHost) {
  const controlRoot = getReaderControlsRoot(playerHost);
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
    hostHasNoCursor: Boolean(playerHost?.classList.contains("bpx-state-no-cursor")),
    anyPresent: nodes.some((item) => item.exists),
    anyHidden: nodes.some((item) => item.exists && !item.visible),
    nodes
  };
}

export function hasReaderPlayerControlsIssue(playerHost = state.readingPlayerHost) {
  if (!state.readingNativePageMode || !playerHost || isWatchlaterPage()) {
    return false;
  }

  const snapshot = getReaderPlayerControlsState(playerHost);
  return snapshot.hostHasNoCursor || (snapshot.anyPresent && snapshot.anyHidden);
}

export function queueEnsureReaderPlayerControlsRecovered({
  reason = "unknown",
  delayMs = 120,
  minIntervalMs = 480
} = {}) {
  if (!state.readingViewOpen || !state.readingNativePageMode || isWatchlaterPage()) {
    return;
  }
  const playerHost = state.readingPlayerHost;
  if (!playerHost?.isConnected || state.readingControlsRecoveryInFlight) {
    return;
  }

  const now = Date.now();
  if (state.readingControlsRecoveryTimer) {
    return;
  }
  if (now - state.readingControlsLastRecoverAt < minIntervalMs) {
    return;
  }

  state.readingControlsRecoveryTimer = window.setTimeout(() => {
    state.readingControlsRecoveryTimer = 0;
    if (!state.readingViewOpen || !state.readingNativePageMode || isWatchlaterPage()) {
      return;
    }
    const activeHost = state.readingPlayerHost;
    if (!activeHost?.isConnected || !hasReaderPlayerControlsIssue(activeHost)) {
      return;
    }

    state.readingControlsRecoveryInFlight = true;
    state.readingControlsLastRecoverAt = Date.now();
    ensureReaderPlayerControlsRecovered(activeHost, {
      reason,
      retryDelayMs: 120
    })
      .catch((error) => {
        logWarn("[BOC] queued reader controls recovery failed", { reason, error });
      })
      .finally(() => {
        state.readingControlsRecoveryInFlight = false;
      });
  }, delayMs);
}

export function setReaderPlayerControlsVisible(visible, playerHost = state.readingPlayerHost) {
  if (!state.readingNativePageMode || !playerHost) {
    return;
  }

  const controlRoot = getReaderControlsRoot(playerHost);
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
    if (playerHost.classList.contains("bpx-state-no-cursor")) {
      playerHost.classList.remove("bpx-state-no-cursor");
      playerHost.setAttribute("data-boc-reader-no-cursor-cleared", "1");
    }
    return;
  }

  if (playerHost.getAttribute("data-boc-reader-no-cursor-cleared") === "1") {
    playerHost.classList.add("bpx-state-no-cursor");
    playerHost.removeAttribute("data-boc-reader-no-cursor-cleared");
  }
}

export async function ensureReaderPlayerControlsRecovered(
  playerHost = state.readingPlayerHost,
  { reason = "unknown", retryDelayMs = 90 } = {}
) {
  if (!state.readingNativePageMode || !playerHost || isWatchlaterPage()) {
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

export function scheduleReaderPlayerControlsHide(playerHost = state.readingControlsHoverHost || state.readingPlayerHost) {
  if (state.readingControlsHideTimer) {
    window.clearTimeout(state.readingControlsHideTimer);
  }
  state.readingControlsHideTimer = window.setTimeout(() => {
    state.readingControlsHideTimer = 0;
    if (!state.readingViewOpen) {
      return;
    }
    setReaderPlayerControlsVisible(false, playerHost);
  }, 1200);
}

export function bindReaderPlayerControlsHover(playerHost = state.readingPlayerHost) {
  if (!state.readingNativePageMode || !isWatchlaterPage() || !playerHost) {
    return;
  }

  if (state.readingControlsHoverHost && state.readingControlsHoverHost !== playerHost) {
    unbindReaderPlayerControlsHover();
  }
  if (playerHost.__bocReaderControlsHoverBound) {
    state.readingControlsHoverHost = playerHost;
    return;
  }

  const showControls = () => {
    if (!state.readingViewOpen) {
      return;
    }
    setReaderPlayerControlsVisible(true, playerHost);
    scheduleReaderPlayerControlsHide(playerHost);
  };
  const hideControls = () => {
    if (state.readingControlsHideTimer) {
      window.clearTimeout(state.readingControlsHideTimer);
      state.readingControlsHideTimer = 0;
    }
    setReaderPlayerControlsVisible(false, playerHost);
  };

  playerHost.addEventListener("mouseenter", showControls, true);
  playerHost.addEventListener("mousemove", showControls, true);
  playerHost.addEventListener("mouseleave", hideControls, true);
  playerHost.__bocReaderControlsHoverBound = { showControls, hideControls };
  state.readingControlsHoverHost = playerHost;
}

export function unbindReaderPlayerControlsHover() {
  const playerHost = state.readingControlsHoverHost;
  if (state.readingControlsHideTimer) {
    window.clearTimeout(state.readingControlsHideTimer);
    state.readingControlsHideTimer = 0;
  }
  if (!playerHost?.__bocReaderControlsHoverBound) {
    state.readingControlsHoverHost = null;
    return;
  }

  const { showControls, hideControls } = playerHost.__bocReaderControlsHoverBound;
  playerHost.removeEventListener("mouseenter", showControls, true);
  playerHost.removeEventListener("mousemove", showControls, true);
  playerHost.removeEventListener("mouseleave", hideControls, true);
  delete playerHost.__bocReaderControlsHoverBound;
  setReaderPlayerControlsVisible(false, playerHost);
  state.readingControlsHoverHost = null;
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
  if (state.readingHeaderHideTimer) {
    window.clearTimeout(state.readingHeaderHideTimer);
    state.readingHeaderHideTimer = 0;
  }
  state.readingHeaderHideTimer = window.setTimeout(() => {
    state.readingHeaderHideTimer = 0;
    if (!state.readingViewOpen) {
      return;
    }
    setReaderHeaderActionsVisible(false);
  }, delayMs);
}

export function bindReaderHeaderActionsHover() {
  if (!state.readingViewOpen) {
    return;
  }
  const header = document.querySelector(".boc-reading-header");
  if (!header || header.__bocReaderHeaderHoverBound) {
    state.readingHeaderHoverHost = header || null;
    return;
  }

  const showActions = () => {
    if (!state.readingViewOpen) {
      return;
    }
    if (state.readingHeaderHideTimer) {
      window.clearTimeout(state.readingHeaderHideTimer);
      state.readingHeaderHideTimer = 0;
    }
    setReaderHeaderActionsVisible(true);
  };
  const hideActionsLater = () => {
    if (!state.readingViewOpen) {
      return;
    }
    scheduleReaderHeaderActionsHide();
  };

  header.addEventListener("mouseenter", showActions, true);
  header.addEventListener("mouseleave", hideActionsLater, true);
  header.__bocReaderHeaderHoverBound = { showActions, hideActionsLater };
  state.readingHeaderHoverHost = header;
  setReaderHeaderActionsVisible(true);
  scheduleReaderHeaderActionsHide();
}

export function unbindReaderHeaderActionsHover() {
  const header = state.readingHeaderHoverHost;
  if (state.readingHeaderHideTimer) {
    window.clearTimeout(state.readingHeaderHideTimer);
    state.readingHeaderHideTimer = 0;
  }
  if (!header?.__bocReaderHeaderHoverBound) {
    state.readingHeaderHoverHost = null;
    return;
  }
  const { showActions, hideActionsLater } = header.__bocReaderHeaderHoverBound;
  header.removeEventListener("mouseenter", showActions, true);
  header.removeEventListener("mouseleave", hideActionsLater, true);
  delete header.__bocReaderHeaderHoverBound;
  state.readingHeaderHoverHost = null;
  setReaderHeaderActionsVisible(true);
}

export function normalizeReaderPlayerContainer(playerHost = state.readingPlayerHost) {
  if (!playerHost) {
    return;
  }

  restoreReaderPlayerContainer();
  const adjusted = [];
  let current = playerHost;
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
    const shouldReset = state.readingNativePageMode
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
      if (current !== playerHost) {
        current.style.removeProperty("width");
        current.style.removeProperty("height");
      }
    }

    current = current.parentElement;
    depth += 1;
  }

  state.readingPlayerAdjustedNodes = adjusted;
}

export function restoreReaderPlayerContainer() {
  const adjusted = Array.isArray(state.readingPlayerAdjustedNodes) ? state.readingPlayerAdjustedNodes : [];
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
  state.readingPlayerAdjustedNodes = [];
}

export function alignReaderViewportToPlayer() {
  if (!isReaderMode()) {
    return;
  }

  const titleNode = findReaderTitleContainer();
  const playerHost = state.readingPlayerHost || findReaderPlayerHost(getRuntimeVideoElement());
  const anchor = titleNode || playerHost;
  if (!anchor) {
    return;
  }

  const titleRect = titleNode?.getBoundingClientRect?.();
  const playerRect = playerHost?.getBoundingClientRect?.();
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
    if (!state.readingViewOpen || !isReaderMode()) {
      return;
    }
    window.scrollTo({ top: nextTop, behavior: "auto" });
    layoutReaderPlayerHost();
  }, 120);
}

export function syncReadingViewPlayback(forceScroll = false) {
  if (!state.readingViewOpen) {
    return;
  }

  if (state.readingNativePageMode) {
    layoutReaderPlayerHost();
  }

  const runtimeVideo = getRuntimeVideoElement();
  const runtimeHost = findReaderPlayerHost(runtimeVideo);
  if (runtimeVideo && runtimeHost) {
    const playerChanged =
      runtimeVideo !== state.readingVideoEl || runtimeHost !== state.readingPlayerHost;
    if (playerChanged) {
      queueEnsureReaderPlayerMounted();
    }
  }

  const video = bindReadingViewVideo(runtimeVideo || state.readingVideoEl);
  if (!video) {
    renderReadingStatus("当前页面没有找到可联动的视频播放器。");
    return;
  }

  const currentTime = Number(video.currentTime || 0) || 0;
  const subtitleIndex = findActiveSubtitleIndex(currentTime);
  const chapterIndex = findActiveChapterIndex(currentTime);
  const changed =
    subtitleIndex !== state.readingActiveSubtitleIndex ||
    chapterIndex !== state.readingActiveChapterIndex;

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

  if (shouldScroll && state.readingAutoScroll) {
    if (Date.now() < state.readingManualScrollPauseUntil) {
      updateReaderFollowState();
      state.readingActiveSubtitleIndex = subtitleIndex;
      state.readingActiveChapterIndex = chapterIndex;
      return;
    }
    if (nextTranscript) {
      scrollReadingTranscriptItemIntoView(nextTranscript);
    }
    if (nextChapter) {
      scrollReadingRailItemIntoView(nextChapter);
    }
  }

  state.readingActiveSubtitleIndex = subtitleIndex;
  state.readingActiveChapterIndex = chapterIndex;
}

export function scrollReadingRailItemIntoView(node) {
  if (!node) {
    return;
  }
  state.readingProgrammaticScrollUntil = Date.now() + 600;
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

  const behavior = state.readingNextScrollBehavior === "auto" ? "auto" : "smooth";
  state.readingProgrammaticScrollUntil = Date.now() + (behavior === "auto" ? 120 : 800);
  state.readingNextScrollBehavior = "smooth";
  if (state.readingNativePageMode && inlineHost && inlineHost.scrollHeight > inlineHost.clientHeight + 8) {
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
  if (state.readingNativePageMode || transcriptList.scrollHeight <= transcriptList.clientHeight + 8) {
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
  state.readingManualScrollPauseUntil = 0;
  state.readingNextScrollBehavior = "auto";
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
  if (!state.readingAutoScroll) {
    updateReaderFollowState();
    return;
  }
  state.readingManualScrollPauseUntil = Date.now() + durationMs;
  updateReaderFollowState();
}

export function updateReaderFollowState() {
  const readingView = document.getElementById(ids.readingView);
  if (!readingView) {
    return;
  }
  const mode =
    !state.readingAutoScroll ? "off" : Date.now() < state.readingManualScrollPauseUntil ? "manual" : "auto";
  readingView.setAttribute("data-boc-reader-follow", mode);
}

export function hasExplicitPageParam(url) {
  try {
    return new URL(url).searchParams.has("p");
  } catch {
    return false;
  }
}

export function extractOid(url) {
  try {
    return String(new URL(url).searchParams.get("oid") || "").trim();
  } catch {
    return "";
  }
}

export function pickPageFromPages(pages, pageIndex) {
  const safePageIndex = Number(pageIndex) > 0 ? Number(pageIndex) : 1;
  const safePages = Array.isArray(pages) ? pages : [];
  const pageByIndex = safePages[safePageIndex - 1];
  if (pageByIndex?.cid) {
    return pageByIndex;
  }

  const pageByNo = safePages.find((item) => Number(item.page) === safePageIndex);
  if (pageByNo?.cid) {
    return pageByNo;
  }

  return null;
}

export function pickCidFromPages(pages, pageIndex, fallbackCid = "") {
  const matchedPage = pickPageFromPages(pages, pageIndex);
  if (matchedPage?.cid) {
    return String(matchedPage.cid);
  }

  const safePages = Array.isArray(pages) ? pages : [];
  if (safePages[0]?.cid) {
    return String(safePages[0].cid);
  }

  if (fallbackCid) {
    return String(fallbackCid);
  }

  throw new Error("没有找到当前分P的 CID。");
}

export function pickPageIndexFromOid(pages, oid, options = {}) {
  const safeOid = String(oid || "").trim();
  if (!safeOid) {
    return 0;
  }

  const safePages = Array.isArray(pages) ? pages : [];
  const pageByCid = safePages.find((item) => String(item?.cid || "") === safeOid);
  if (pageByCid?.page) {
    return Number(pageByCid.page) || 0;
  }

  // watchlater 等页面的 oid 通常是 aid 而非 cid；
  // 若 oid 与视频 aid 一致，尝试从页面状态读取当前播放分P。
  const safeAid = String(options?.aid || "").trim();
  if (safeAid && safeOid === safeAid) {
    return readCurrentPageFromPageState(safePages, options?.defaultCid);
  }

  return 0;
}

export function readCurrentPageFromPageState(pages, fallbackCid = "") {
  const safePages = Array.isArray(pages) ? pages : [];

  // 1. 优先使用 URL 中的 ?p= 参数
  try {
    const pageFromUrl = Number(new URL(location.href).searchParams.get("p") || "0");
    if (Number.isFinite(pageFromUrl) && pageFromUrl > 0) {
      return pageFromUrl;
    }
  } catch {
    // ignore
  }

  // 2. 其次尝试页面全局状态（watchlater 等页面通常携带播放器状态）
  try {
    const rootState = window?.__INITIAL_STATE__ || {};
    const playerState = rootState.player || window?.__PLAYER_STATE__ || window?.__BILI_PLAYER__;
    if (playerState) {
      const candidates = [
        playerState.page,
        playerState.pageIndex,
        playerState.currentPage,
        playerState.data?.page,
        playerState.data?.pageIndex
      ];
      for (const value of candidates) {
        const pageFromState = Number(value || "0");
        if (Number.isFinite(pageFromState) && pageFromState > 0) {
          return pageFromState;
        }
      }
    }

    const videoData = rootState.videoData || rootState.playletInfo;
    if (videoData) {
      const pageFromVideoData = Number(
        videoData.page || videoData.pageIndex || videoData.currentPage || videoData.data?.page || "0"
      );
      if (Number.isFinite(pageFromVideoData) && pageFromVideoData > 0) {
        return pageFromVideoData;
      }
      const cidFromVideoData = String(videoData.cid || videoData.data?.cid || "");
      if (cidFromVideoData) {
        const matched = safePages.find((item) => String(item?.cid || "") === cidFromVideoData);
        if (matched?.page) {
          return Number(matched.page) || 0;
        }
      }
    }
  } catch {
    // ignore
  }

  // 3. 从播放器 DOM / video currentSrc / iframe src 读取当前分P
  const pageFromDom = readPageFromPlayerDom(safePages);
  if (Number.isFinite(pageFromDom) && pageFromDom > 0) {
    return pageFromDom;
  }

  // 4. 最后按 defaultCid / 首页索引兜底
  if (fallbackCid) {
    const pageByCid = safePages.find((item) => String(item?.cid || "") === String(fallbackCid));
    if (pageByCid?.page) {
      return Number(pageByCid.page) || 1;
    }
  }

  return safePages.length > 0 ? 1 : 0;
}

export function readPageFromPlayerDom(pages) {
  const safePages = Array.isArray(pages) ? pages : [];

  // 3a. 从 video currentSrc / src 提取 cid / page
  try {
    const video = getRuntimeVideoElement();
    if (video) {
      const src = String(video.currentSrc || video.src || "").trim();
      if (src) {
        const cidMatch = src.match(/[?&]cid=(\d+)/i);
        if (cidMatch) {
          const matched = safePages.find((item) => String(item?.cid || "") === cidMatch[1]);
          if (matched?.page) {
            return Number(matched.page) || 0;
          }
        }
        const pageMatch = src.match(/[?&]page=(\d+)/i);
        if (pageMatch) {
          const page = Number(pageMatch[1]);
          if (Number.isFinite(page) && page > 0) {
            return page;
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // 3b. 从播放器 iframe src 提取 page / cid
  try {
    const iframe =
      document.querySelector(
        "#bilibili-player iframe, .bpx-player-container iframe, iframe[src*='player.bilibili.com']"
      ) ||
      document.querySelector("iframe[src*='bilibili.com/player']");
    if (iframe?.src) {
      const pageMatch = iframe.src.match(/[?&]page=(\d+)/i);
      if (pageMatch) {
        const page = Number(pageMatch[1]);
        if (Number.isFinite(page) && page > 0) {
          return page;
        }
      }
      const cidMatch = iframe.src.match(/[?&]cid=(\d+)/i);
      if (cidMatch) {
        const matched = safePages.find((item) => String(item?.cid || "") === cidMatch[1]);
        if (matched?.page) {
          return Number(matched.page) || 0;
        }
      }
    }
  } catch {
    // ignore
  }

  // 3c. 从播放器控制栏/DOM 文本中推断当前分P
  try {
    const playerRoot =
      document.querySelector(".bpx-player-control-wrap") ||
      document.querySelector("#bilibili-player .bpx-player-control-wrap") ||
      document.querySelector(".player-wrap");
    if (playerRoot) {
      const text = playerRoot.textContent || "";
      // 匹配类似 "P2"、"第2集"、"第02话" 等文本
      const pageMatch = text.match(/(?:^|\s|第)\s*(\d+)\s*(?:集|话|P|part)/i);
      if (pageMatch) {
        const page = Number(pageMatch[1]);
        if (Number.isFinite(page) && page > 0) {
          return page;
        }
      }
    }
  } catch {
    // ignore
  }

  return 0;
}

export function pickDurationFromPages(pages, pageIndex, fallbackDuration = 0) {
  const matchedPage = pickPageFromPages(pages, pageIndex);
  if (Number(matchedPage?.duration) > 0) {
    return Number(matchedPage.duration);
  }

  const safePages = Array.isArray(pages) ? pages : [];
  if (Number(safePages[0]?.duration) > 0) {
    return Number(safePages[0].duration);
  }

  return Number(fallbackDuration || 0) || 0;
}

