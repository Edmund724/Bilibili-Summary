import { DEFAULT_SETTINGS } from "./defaults.js";

/**
 * State namespace objects.
 *
 * Access patterns:
 * - Structured: state.reader.X, state.clip.X, state.playerAi.X, state.ui.X
 *
 * The structured namespaces expose the sub-state objects directly.
 * Flat sub-state property access (e.g. state.readingViewOpen) is no longer
 * supported; use the structured namespace (state.reader.readingViewOpen) instead.
 */

// Reader namespace. Issue 06 hoisted reader-internal bookkeeping into
// reader-impl.js module closure; issue 07 removed the now-dead fields. The
// remaining fields are settings/shared flags plus a few cross-module
// bookkeeping fields: readingVideoEl (video-probe reads, fetcher writes null,
// reader-impl writes the element when binding/unbinding),
// readingDocumentClickBound (ui-renderer sets).
const readerState = {
  readingViewOpen: false,
  readingNativePageMode: false,
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
  readingVideoEl: null,
  readingDocumentClickBound: false,
  readingViewReady: false,
  setViewOpen(value) { this.readingViewOpen = value; },
  setNativePageMode(value) { this.readingNativePageMode = value; },
  setAutoScroll(value) { this.readingAutoScroll = value; },
  setTheme(value) { this.readingTheme = value; },
  setFontScale(value) { this.readingFontScale = value; },
  setLetterSpacing(value) { this.readingLetterSpacing = value; },
  setLineHeight(value) { this.readingLineHeight = value; },
  setContentWidth(value) { this.readingContentWidth = value; },
  setChapterVisible(value) { this.readingChapterVisible = value; },
  setTranscriptVisible(value) { this.readingTranscriptVisible = value; },
  setSettingsExpanded(value) { this.readingSettingsExpanded = value; },
  setDescriptionExpanded(value) { this.readingDescriptionExpanded = value; },
  setActiveSubtitleIndex(value) { this.readingActiveSubtitleIndex = value; },
  setActiveChapterIndex(value) { this.readingActiveChapterIndex = value; },
  setNextScrollBehavior(value) { this.readingNextScrollBehavior = value; },
  setViewReady(value) { this.readingViewReady = value; }
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
  // 无字幕原因（subtitleFetchState === "empty" 时的归类，供 sidepanel 拦截总结
  // 时按原因提示）：
  //   null            未知/不适用
  //   "no-asr-config" 未配置语音识别平台（含激活平台不在列表）
  //   "asr-disabled"  无字幕自动转写开关未开启
  //   "asr-failed"    语音识别失败
  //   "asr-empty"     语音识别成功但未识别到语音内容
  // 写入点在 asr/fallback.js 各终态分支（skip/empty 原因；失败原因随无字幕
  // 出口逆事务 commitNoSubtitle 写入）；清除点为 resetClipState 与字幕接受
  // 事务（subtitle/commit.js acceptSubtitle，subtitleFetchState → "ready"
  // 的唯一写入点）。
  noSubtitleReason: null,
  chapters: [],
  hotComments: [],
  markdown: "",
  srt: "",
  txt: "",
  currentClipSignature: "",
  setCurrentUrl(value) { this.currentUrl = value; },
  setFetchRunId(value) { this.fetchRunId = value; },
  setBvid(value) { this.bvid = value; },
  setAid(value) { this.aid = value; },
  setCid(value) { this.cid = value; },
  setCidSource(value) { this.cidSource = value; },
  setPageIndex(value) { this.pageIndex = value; },
  setPageCount(value) { this.pageCount = value; },
  setPageTitle(value) { this.pageTitle = value; },
  setVideoDuration(value) { this.videoDuration = value; },
  setDescription(value) { this.description = value; },
  setTitle(value) { this.title = value; },
  setAuthor(value) { this.author = value; },
  setUploadDate(value) { this.uploadDate = value; },
  setSubtitles(value) { this.subtitles = value; },
  setSelectedSubtitleId(value) { this.selectedSubtitleId = value; },
  setSelectedSubtitleUrl(value) { this.selectedSubtitleUrl = value; },
  setSelectedSubtitleLang(value) { this.selectedSubtitleLang = value; },
  setSubtitleBody(value) { this.subtitleBody = value; },
  setSubtitleFetchState(value) { this.subtitleFetchState = value; },
  setNoSubtitleReason(value) { this.noSubtitleReason = value; },
  setChapters(value) { this.chapters = value; },
  setHotComments(value) { this.hotComments = value; },
  setMarkdown(value) { this.markdown = value; },
  setSrt(value) { this.srt = value; },
  setTxt(value) { this.txt = value; },
  setCurrentClipSignature(value) { this.currentClipSignature = value; }
};

const playerAiState = {
  playerAiQuickActionObserver: null,
  playerAiQuickActionLayoutBound: false,
  playerAiQuickActionSyncTimer: 0,
  playerAiQuickActionRevealTimer: 0,
  playerAiQuickActionHideTimer: 0,
  playerAiQuickActionCursorHideTimer: 0,
  playerAiQuickActionSubmitting: false,
  playerAiQuickActionSuppressedUntil: 0,
  setObserver(value) { this.playerAiQuickActionObserver = value; },
  setLayoutBound(value) { this.playerAiQuickActionLayoutBound = value; },
  setSyncTimer(value) { this.playerAiQuickActionSyncTimer = value; },
  setRevealTimer(value) { this.playerAiQuickActionRevealTimer = value; },
  setHideTimer(value) { this.playerAiQuickActionHideTimer = value; },
  setCursorHideTimer(value) { this.playerAiQuickActionCursorHideTimer = value; },
  setSubmitting(value) { this.playerAiQuickActionSubmitting = value; },
  setSuppressedUntil(value) { this.playerAiQuickActionSuppressedUntil = value; }
};

const uiState = {
  uiEventsBound: false,
  runtimeEventsBound: false,
  settingsWatcherBound: false,
  normalPageStateGuardBound: false,
  urlWatcherStarted: false,
  statusText: "准备就绪，点击“刷新抓取”开始。",
  messageText: "",
  setEventsBound(value) { this.uiEventsBound = value; },
  setRuntimeEventsBound(value) { this.runtimeEventsBound = value; },
  setSettingsWatcherBound(value) { this.settingsWatcherBound = value; },
  setNormalPageStateGuardBound(value) { this.normalPageStateGuardBound = value; },
  setUrlWatcherStarted(value) { this.urlWatcherStarted = value; },
  setStatusText(value) { this.statusText = value; },
  setMessageText(value) { this.messageText = value; }
};

const stateTarget = {
  settings: { ...DEFAULT_SETTINGS },
  readerState,
  clipState,
  playerAiState,
  uiState,
  reader: readerState,
  clip: clipState,
  playerAi: playerAiState,
  ui: uiState,
  setSettings(next) { this.settings = next; }
};

const state = stateTarget;

export { state, clipState, playerAiState, uiState };
