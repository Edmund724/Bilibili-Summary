import { setMessage } from "./message.js";
import {
  DEFAULT_PLAYER_AI_QUICK_PROMPT,
  formatLocalDate,
  normalizeDownloadFormat,
  normalizeReaderTheme,
  normalizeReaderFontScale,
  normalizeReaderLetterSpacing,
  normalizeReaderLineHeight,
  normalizeReaderContentWidth,
  normalizeReaderChapterVisibility,
  normalizeReaderTranscriptVisible,
  DEFAULT_SETTINGS
} from "./shared-defaults.js";
import { state, readerState, clipState, playerAiState, uiState } from "./state.js";

import {
  isReaderMode,
  stripReaderModeUrl,
  replaceReaderModeUrl,
  isWatchlaterPage,
  startUrlWatcher,
  computeCurrentClipSignature,
  toReadableText,
  getErrorMessage,
  sendRuntimeMessage,
  isExtensionContextInvalidated,
  requestOpenOptions,
  getSettings,
  byId,
  extractBvid,
  cleanVideoUrl,
  extractPageIndex,
  ensureRunActive,
  isStaleRunError,
  isRetryableNetworkError,
  findReaderPlayerHost,
  getRuntimeVideoElement
} from "./router.js";

import {
  readVideoTitle,
  readVideoAuthor,
  readUploadDate,
  getReadingTranscriptItems,
  getReadingTranscriptPlaceholderText,
  findActiveSubtitleIndex,
  findActiveChapterIndex,
  rebuildDerivedContent
} from "./subtitle.js";
import {
  startPlayerAiQuickActionObserver,
  bindPlayerAiQuickActionLayoutEvents,
  schedulePlayerAiQuickActionSync,
  schedulePlayerAiQuickActionRetry,
  syncPlayerAiQuickActionButton,
  removePlayerAiQuickActionButton,
  bindPlayerAiQuickActionCursorSync,
  hasPlayerSubtitleControl,
  findPlayerSubtitleControlNode,
  isPlayerSubtitleControlNode,
  findPlayerAiQuickActionHost,
  buildPlayerAiQuickActionIconSvg,
  syncPlayerAiQuickActionVisuals,
  handlePlayerAiQuickActionClick,
  isVisibleReaderControl,
  resetPlayerAiQuickActionRetryCount
} from "./player-ai.js";

import {
  buildUiHtml,
  bindUiEvents,
  resetClipState,
  refreshClip,
  loadSubtitle,
  getPopupPayload,
  setStatus,
  renderSubtitleSelect
} from "./panel.js";
import {
  bindSettingsWatcher,
  ids,
  logInfo,
  logWarn,
  installReaderDebugHelpers,
  hydrateReaderStateFromSettings,
  applyReadingViewPresentation,
  enterReaderMode,
  renderReadingStatus
} from "./reader.js";

const BOC_VERSION = "1.1.4";
const CACHE_KEY_PREFIX = "boc_subtitle_cache_";
globalThis.__BOC_CONTENT_SCRIPT_LOADED__ = BOC_VERSION;

import {
  buildBiliApiError,
  buildBilibiliEmbedIframe,
  buildChapterLines,
  buildFolderTemplateContext,
  buildFrontMatter,
  buildFrontmatterTemplateContext,
  buildHotCommentLines,
  buildMarkdown,
  buildNoteFilename,
  buildNotePlaceholderLines,
  buildNotePlaceholderTemplateContext,
  buildSrt,
  buildSubtitleCandidates,
  buildSubtitleInfoRequests,
  buildSubtitlePreview,
  buildSubtitleSectionLines,
  buildSubtitleSourceKey,
  buildTxt,
  escapeHtml,
  escapeYaml,
  formatCompactTimestamp,
  formatFixedPropertyYamlLine,
  formatSubtitleLine,
  formatTimestamp,
  getCurrentAid,
  getEnabledFrontmatterFields,
  getFixedFrontmatterPropertyLines,
  groupNotePlaceholderSections,
  isAiSubtitle,
  isRetryableError,
  isYamlDateValue,
  mapChaptersFromPlayerData,
  mapSubtitleTracks,
  normalizeChapterTime,
  normalizeChapters,
  normalizeFolder,
  normalizeHotComments,
  normalizeNotePlaceholderSections,
  normalizeSubtitleTracks,
  normalizeSubtitleUrl,
  normalizeSubtitleUrlForCache,
  parseFrontmatterArrayItems,
  pickPreferredSubtitle,
  pushOptionalLines,
  readRuntimeVideoDuration,
  resolveFolderTemplate,
  resolveFrontmatterTemplateValue,
  sanitizeFileName,
  sanitizeFolderTemplateValue,
  shouldShowHoursInNote,
  shouldShowHoursInSubtitle,
  subtitlePriority,
  validateSubtitleByDuration
} from "./formatters.js";

export {
  isSupportedUrl,
  ensureUiReady,
  clearReaderModePageState,
  shouldForceNormalPageState,
  enforceNormalPageStateIfNeeded,
  bindNormalPageStateGuard,
  bindRuntimeEvents
};

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

function ensureUiReady({ forceRecreate = false } = {}) {
  const existingRoot = document.getElementById(ids.root);
  if (existingRoot && forceRecreate) {
    existingRoot.remove();
    state.uiEventsBound = false;
  }

  let root = document.getElementById(ids.root);
  if (!root) {
    root = document.createElement("div");
    root.id = ids.root;
    root.innerHTML = buildUiHtml();
    document.body.appendChild(root);
    state.uiEventsBound = false;
  }

  if (!state.uiEventsBound) {
    bindUiEvents();
    state.uiEventsBound = true;
  }
}

function clearReaderModePageState() {
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

function shouldForceNormalPageState(url = location.href) {
  return !isReaderMode(url) && !state.readingViewOpen;
}

function enforceNormalPageStateIfNeeded(url = location.href) {
  if (!shouldForceNormalPageState(url)) {
    return;
  }
  clearReaderModePageState();
}

function bindNormalPageStateGuard() {
  if (state.normalPageStateGuardBound) {
    return;
  }
  state.normalPageStateGuardBound = true;

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
  state.normalPageStateObserver = observer;
  enforceNormalPageStateIfNeeded();
}

function bindRuntimeEvents() {
  if (state.runtimeEventsBound) {
    return;
  }
  state.runtimeEventsBound = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }

    if (message.type === "popup-get-state") {
      sendResponse({ ok: true, payload: getPopupPayload() });
      return false;
    }

    if (message.type === "popup-refresh") {
      refreshClip()
        .then(() => sendResponse({ ok: true, payload: getPopupPayload() }))
        .catch((error) =>
          sendResponse({ ok: false, error: getErrorMessage(error), payload: getPopupPayload() })
        );
      return true;
    }

    if (message.type === "popup-select-subtitle") {
      const url = String(message.url || "").trim();
      const lang = String(message.lang || "unknown");
      const subtitleId = String(message.subtitleId || "");
      if (!url) {
        sendResponse({ ok: false, error: "Missing subtitle URL", payload: getPopupPayload() });
        return false;
      }
      loadSubtitle(url, lang, state.fetchRunId, subtitleId)
        .then(() => {
          setStatus("字幕切换完成。");
          renderSubtitleSelect();
          sendResponse({ ok: true, payload: getPopupPayload() });
        })
        .catch((error) =>
          sendResponse({ ok: false, error: getErrorMessage(error), payload: getPopupPayload() })
        );
      return true;
    }

    if (message.type === "popup-trigger-reading-view") {
      state.playerAiQuickActionSuppressedUntil = Date.now() + 2500;
      removePlayerAiQuickActionButton();
      ensureUiReady();
      const readerUrl = String(message.readerUrl || "").trim();
      if (readerUrl) {
        replaceReaderModeUrl(readerUrl);
        document.documentElement.setAttribute("data-boc-reader-mode", "1");
        document.body.setAttribute("data-boc-reader-mode", "1");
      }
      if (!state.readingViewOpen) {
        enterReaderMode().catch((error) => {
          logWarn("[BOC] reading mode trigger failed", error);
        });
      }
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "sidepanel-get-context") {
      const settings = state.settings || DEFAULT_SETTINGS;
      const body = state.subtitleBody || [];
      let subtitleMarkdown = "";
      try {
        subtitleMarkdown = body.length
          ? buildMarkdown(state, body, { ...settings, includeHotCommentsInNote: false })
          : "";
      } catch (e) {
        subtitleMarkdown = "";
        logWarn("[BOC] sidepanel-get-context: buildMarkdown failed", e);
      }
      sendResponse({
        ok: true,
        payload: {
          url: location.href,
          title: state.title || "",
          author: state.author || "",
          uploadDate: state.uploadDate || "",
          bvid: state.bvid || "",
          cid: state.cid || "",
          aid: state.aid || "",
          pageIndex: Number(state.pageIndex) > 0 ? Number(state.pageIndex) : 1,
          pageCount: Number(state.pageCount) > 0 ? Number(state.pageCount) : 0,
          pageTitle: state.pageTitle || "",
          subtitleBody: body,
          subtitleMarkdown,
          subtitleLang: state.selectedSubtitleLang || "",
          selectedSubtitleId: state.selectedSubtitleId || "",
          selectedSubtitleUrl: state.selectedSubtitleUrl || "",
          subtitleOptions: state.subtitles || [],
          hotComments: []
        }
      });
      return false;
    }

    if (message.type === "sidepanel-get-hot-comments") {
      const count = 20; // 固定取前 20 条热门评论
      if (!count) {
        sendResponse({ ok: true, comments: [] });
        return false;
      }

      if (!getCurrentAid()) {
        state.hotComments = [];
        sendResponse({ ok: true, comments: [], note: "无法获取视频 aid" });
        return false;
      }

      fetchHotComments(count)
        .then((hotComments) => {
          state.hotComments = hotComments;
          sendResponse({ ok: true, comments: hotComments });
        })
        .catch((error) => {
          state.hotComments = [];
          sendResponse({ ok: true, comments: [], note: String(error?.message || error) });
        });
      return true;
    }

    if (message.type === "sidepanel-seek-video-time") {
      const seconds = Number(message.seconds);
      const video = getRuntimeVideoElement();
      if (!video) {
        sendResponse({ ok: false, error: "当前页面没有找到可联动的视频播放器。" });
        return false;
      }
      const nextTime = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
      const wasPaused = Boolean(video.paused);
      video.currentTime = nextTime;
      if (!wasPaused) {
        video.play().catch(() => {});
      }
      if (state.readingViewOpen) {
        state.readingManualScrollPauseUntil = 0;
        state.readingNextScrollBehavior = "auto";
        updateReaderFollowState();
        syncReadingViewPlayback(true);
      }
      sendResponse({ ok: true, currentTime: nextTime });
      return false;
    }

    return false;
  });
}



