import {
  BOC_VERSION,
  tryLoadSubtitleCandidates,
  resetClipState,
  refreshClip,
  loadSubtitle
} from "./subtitle-fetcher.js";

import {
  CACHE_KEY_PREFIX,
  fetchSubtitleBundle,
  fetchVideoMeta,
  retryAsync,
  getSubtitleCacheKey
} from "./subtitle-fetch.js";
import {
  onSubtitleChange,
  getPopupPayload,
  applyNoSubtitleState,
  readVideoDescription,
  copyMarkdown,
  downloadSubtitle
} from "./subtitle-ui.js";
import { refreshDerivedContent } from "./note-build.js";

import {
  buildUiHtml,
  bindUiEvents,
  ensureUiReady,
  setBusyState,
  setStatus,
  renderMeta,
  renderSubtitleSelect,
  setMessage
} from "./ui-renderer.js";

import {
  ids,
  buildReaderStepperControl,
  bindReaderStepperControl,
  updateReaderPreferences,
  renderReaderPanels,
  renderReadingInfoPanel,
  hydrateReaderStateFromSettings,
  applyReadingViewPresentation,
  renderReadingStatus,
  syncReaderModeAfterMount,
  settleReaderModePresentation,
  closeReadingView,
  renderReadingView,
  logWarn,
  openReaderViewShell,
  maybeRefreshReaderSubtitleInBackground
} from "./reader-shell.js";
import {
  updateReaderFollowState,
  syncReadingViewPlayback,
  stopReadingViewSync,
  noteManualReaderInteraction,
  onReadingChapterClick,
  onReadingTranscriptClick,
  startReadingViewSync
} from "./reader-transcript-sync.js";
import {
  bindReaderHeaderActionsHover,
  startReaderPlayerObserver,
  stopReaderPlayerObserver,
  scheduleReaderMiniPlayerDismiss,
  ensureReaderPlayerMounted,
  layoutReaderPlayerHost
} from "./reader-player-host.js";
import {
  moveReadingMainInline,
  alignReaderViewportToPlayer,
  applyReaderPageFocus
} from "./reader-page-frame.js";

export {
  BOC_VERSION,
  CACHE_KEY_PREFIX,
  retryAsync,
  fetchVideoMeta,
  tryLoadSubtitleCandidates,
  getSubtitleCacheKey,
  resetClipState,
  refreshClip,
  loadSubtitle,
  fetchSubtitleBundle,
  onSubtitleChange,
  getPopupPayload,
  applyNoSubtitleState,
  readVideoDescription,
  refreshDerivedContent,
  copyMarkdown,
  downloadSubtitle,
  buildUiHtml,
  bindUiEvents,
  ensureUiReady,
  setBusyState,
  setStatus,
  renderMeta,
  renderSubtitleSelect,
  setMessage,
  ids,
  buildReaderStepperControl,
  bindReaderStepperControl,
  updateReaderPreferences,
  renderReaderPanels,
  renderReadingInfoPanel,
  updateReaderFollowState,
  syncReadingViewPlayback,
  closeReadingView,
  renderReadingView,
  stopReadingViewSync,
  noteManualReaderInteraction,
  logWarn,
  onReadingChapterClick,
  onReadingTranscriptClick,
  hydrateReaderStateFromSettings,
  applyReadingViewPresentation,
  renderReadingStatus,
  syncReaderModeAfterMount,
  settleReaderModePresentation,
  bindReaderHeaderActionsHover,
  startReadingViewSync,
  startReaderPlayerObserver,
  stopReaderPlayerObserver,
  moveReadingMainInline,
  alignReaderViewportToPlayer,
  scheduleReaderMiniPlayerDismiss,
  openReaderViewShell,
  applyReaderPageFocus,
  ensureReaderPlayerMounted,
  layoutReaderPlayerHost,
  maybeRefreshReaderSubtitleInBackground
};
