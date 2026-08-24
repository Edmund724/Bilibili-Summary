import { state } from "./state.js";
import {
  isStaleRunError,
  getErrorMessage
} from "./router.js";
import {
  refreshClip
} from "./subtitle-fetcher.js";
import {
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
  waitForVideoMetadata
} from "./reader.js";

export {
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
  onReadingTranscriptClick
};

export {
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
  layoutReaderPlayerHost
};

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
