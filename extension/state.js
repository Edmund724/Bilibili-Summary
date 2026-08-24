import { DEFAULT_SETTINGS } from "./shared-defaults.js";

const readerState = {
  readingViewOpen: false,
  readingNativePageMode: false,
  readingRootOriginalParent: null,
  readingAutoScroll: true,
  readingTheme: "light",
  readingFontScale: "m",
  readingLetterSpacing: "normal",
  readingLineHeight: "tight",
  readingContentWidth: "medium",
  readingChapterVisible: true,
  readingTranscriptVisible: true,
  readingSettingsExpanded: false,
  readingDescriptionExpanded: false,
  readingActiveSubtitleIndex: -1,
  readingActiveChapterIndex: -1,
  readingNextScrollBehavior: "smooth",
  readingSyncTimer: 0,
  readingVideoEl: null,
  readingPlayerHost: null,
  readingMainOriginalParent: null,
  readingMainOriginalNextSibling: null,
  readingPlayerAdjustedNodes: [],
  readingPlayerObserver: null,
  readingPlayerMountTimer: 0,
  readingPlayerRetryTimer: 0,
  readingMiniDismissTimer: 0,
  readingControlsHideTimer: 0,
  readingControlsRecoveryTimer: 0,
  readingControlsRecoveryInFlight: false,
  readingControlsLastRecoverAt: 0,
  readingControlsHoverHost: null,
  readingHeaderHoverHost: null,
  readingHeaderHideTimer: 0,
  readingVideoEventsBound: false,
  readingLayoutBound: false,
  readingDocumentClickBound: false,
  readingManualScrollPauseUntil: 0,
  readingProgrammaticScrollUntil: 0,
  readingViewReady: false
};

const clipState = {
  currentUrl: typeof location !== "undefined" ? location.href : "",
  fetchRunId: 0,
  bvid: "",
  aid: "",
  cid: "",
  cidSource: "",
  pageIndex: 1,
  pageCount: 0,
  pageTitle: "",
  videoDuration: 0,
  description: "",
  title: "",
  author: "",
  uploadDate: "",
  subtitles: [],
  selectedSubtitleId: "",
  selectedSubtitleUrl: "",
  selectedSubtitleLang: "",
  subtitleBody: [],
  subtitleFetchState: "idle",
  chapters: [],
  hotComments: [],
  markdown: "",
  srt: "",
  txt: "",
  currentClipSignature: ""
};

const playerAiState = {
  playerAiQuickActionObserver: null,
  playerAiQuickActionLayoutBound: false,
  playerAiQuickActionSyncTimer: 0,
  playerAiQuickActionRevealTimer: 0,
  playerAiQuickActionHideTimer: 0,
  playerAiQuickActionCursorHideTimer: 0,
  playerAiQuickActionSubmitting: false,
  playerAiQuickActionSuppressedUntil: 0
};

const uiState = {
  uiEventsBound: false,
  runtimeEventsBound: false,
  settingsWatcherBound: false,
  normalPageStateGuardBound: false,
  urlWatcherStarted: false,
  statusText: "准备就绪，点击“刷新抓取”开始。",
  messageText: ""
};

const stateTarget = {
  settings: { ...DEFAULT_SETTINGS },
  normalPageStateObserver: null,
  readerState,
  clipState,
  playerAiState,
  uiState
};

const state = new Proxy(stateTarget, {
  get(target, prop) {
    if (prop in readerState) return readerState[prop];
    if (prop in clipState) return clipState[prop];
    if (prop in playerAiState) return playerAiState[prop];
    if (prop in uiState) return uiState[prop];
    return target[prop];
  },
  set(target, prop, value) {
    if (prop in readerState) {
      readerState[prop] = value;
      return true;
    }
    if (prop in clipState) {
      clipState[prop] = value;
      return true;
    }
    if (prop in playerAiState) {
      playerAiState[prop] = value;
      return true;
    }
    if (prop in uiState) {
      uiState[prop] = value;
      return true;
    }
    target[prop] = value;
    return true;
  },
  has(target, prop) {
    if (prop in readerState) return true;
    if (prop in clipState) return true;
    if (prop in playerAiState) return true;
    if (prop in uiState) return true;
    return prop in target;
  },
  ownKeys(target) {
    const keys = new Set([
      ...Object.keys(readerState),
      ...Object.keys(clipState),
      ...Object.keys(playerAiState),
      ...Object.keys(uiState),
      ...Object.keys(target)
    ]);
    return Array.from(keys);
  }
});

export { state, readerState, clipState, playerAiState, uiState };
