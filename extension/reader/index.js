export {
  noteManualReaderInteraction,
  onReadingChapterClick,
  onReadingTranscriptClick,
  startReadingViewSync,
  stopReadingViewSync,
  syncReadingViewPlayback,
  updateReaderFollowState
} from "./transcript-sync.js";
export {
  applyReadingViewPresentation,
  bindReaderStepperControl,
  bindSettingsWatcher,
  buildReaderStepperControl,
  closeReadingView,
  enterReaderMode,
  hydrateReaderStateFromSettings,
  ids,
  installReaderDebugHelpers,
  logInfo,
  logWarn,
  renderReaderPanels,
  renderReadingInfoPanel,
  renderReadingStatus,
  renderReadingView,
  shouldDebugLog,
  updateReaderPreferences,
  waitForVideoMetadata
} from "./shell.js";
export {
  bindNormalPageStateGuard,
  clearReaderModePageState,
  enforceNormalPageStateIfNeeded,
  extractOid,
  hasExplicitPageParam,
  moveReadingMainInline,
  pickCidFromPages,
  pickDurationFromPages,
  pickPageFromPages,
  pickPageIndexFromOid
} from "./page-frame.js";
export { startReaderPlayerObserver, stopReaderPlayerObserver } from "./player-host.js";
