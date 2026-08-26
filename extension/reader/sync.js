// Reader playback↔transcript synchronization (extracted from reader-impl.js,
// formerly the transcript-sync.js segment, issue 06+).
//
// Deep module owning the sync timer and the manual/programmatic scroll-pause
// deadlines. Layout is the base layer (extension/reader/reader-impl.js); this
// module depends on it and must never be imported by it (the dependency graph
// is acyclic: SYNC → LAYOUT).
//
//   LAYOUT   reader-impl.js     module-level closure: playerHost, videoEventsBound,
//                               scroll-pause variables, timer variables
//   SYNC     sync.js            syncTimer lives here; scroll deadlines live here;
//                               reads/writes the layout closure only through the
//                               exported layout functions (imported below)
//
// reader-impl.js must not import this module — its layout/shell functions that
// need sync-domain behavior call it through the adapter registered below
// (registerSyncAdapter), keeping the dependency graph acyclic: SYNC → LAYOUT.
import { state } from "../core/state.js";
import { formatCompactTimestamp } from "../shared/string-utils.js";
import { findActiveSubtitleIndex, findActiveChapterIndex } from "../subtitle/core.js";
import { findReaderPlayerHost, getRuntimeVideoElement } from "../bilibili/video-probe.js";

import {
  ids,
  getReaderElement,
  getPlayerHost,
  bindReadingViewVideo,
  queueEnsureReaderPlayerMounted,
  layoutReaderPlayerHost,
  stopReaderPlayerObserver,
  unbindReaderPlayerControlsHover,
  closeReaderCleanup,
  renderReadingStatus,
  isManualScrollPaused,
  resetManualScrollPause,
  setManualScrollPaused,
  setProgrammaticScrollUntil,
  setVideoEventsBound,
  clearLayoutTimersForSyncStop,
  registerSyncAdapter
} from "./reader-impl.js";

// Register this module's function table with the layout module so shell/layout
// functions can call into the sync domain synchronously. Function declarations
// are hoisted, so the table is complete at module-evaluation time. Removed in
// the lifecycle extraction commit, when the shell segment moves to
// lifecycle.js and imports ./sync.js directly.
registerSyncAdapter({
  startReadingViewSync,
  stopReadingViewSync,
  syncReadingViewPlayback,
  updateReaderFollowState,
  noteManualReaderInteraction,
  resetManualScrollPause,
  setProgrammaticScrollUntil
});

// ===== sync-domain private bookkeeping (module-level closure state) =====
//
// syncTimer (readingSyncTimer) moved here with the sync domain.
// manualScrollPauseUntil / programmaticScrollUntil were hoisted to
// reader-impl.js (issue 06); they moved here with the sync domain because all
// their readers/writers are sync functions. The layout side only reads them
// through the exported is* accessors and resets them via resetManualScrollPause.
let syncTimer = 0; // readingSyncTimer

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
  clearLayoutTimersForSyncStop();
  closeReaderCleanup();
  stopReaderPlayerObserver();
  unbindReaderPlayerControlsHover();
  if (state.reader.readingVideoEl && state.reader.readingVideoEl.__bocReadingSyncHandler) {
    const video = state.reader.readingVideoEl;
    video.removeEventListener("timeupdate", video.__bocReadingSyncHandler);
    video.removeEventListener("seeked", video.__bocReadingSyncHandler);
    video.removeEventListener("loadedmetadata", video.__bocReadingSyncHandler);
    delete video.__bocReadingSyncHandler;
  }
  setVideoEventsBound(false);
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
      runtimeVideo !== state.reader.readingVideoEl || runtimeHost !== getPlayerHost();
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
  const transcriptList = getReaderElement(ids.readingTranscriptList);
  const chapterList = getReaderElement(ids.readingChapterList);
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
    if (isManualScrollPaused()) {
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
  setProgrammaticScrollUntil(Date.now() + 600);
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

  const transcriptList = getReaderElement(ids.readingTranscriptList);
  const inlineHost = document.getElementById("boc-reading-inline-host");
  const listRect = transcriptList.getBoundingClientRect();
  const itemRect = node.getBoundingClientRect();
  if (!(listRect.height > 0) || !(itemRect.height > 0)) {
    scrollReadingRailItemIntoView(node);
    return;
  }

  const behavior = state.reader.readingNextScrollBehavior === "auto" ? "auto" : "smooth";
  setProgrammaticScrollUntil(Date.now() + (behavior === "auto" ? 120 : 800));
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
  resetManualScrollPause();
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
  setManualScrollPaused(Date.now() + durationMs);
  updateReaderFollowState();
}

export function updateReaderFollowState() {
  const readingView = document.getElementById(ids.readingView);
  if (!readingView) {
    return;
  }
  const mode =
    !state.reader.readingAutoScroll ? "off" : isManualScrollPaused() ? "manual" : "auto";
  readingView.setAttribute("data-boc-reader-follow", mode);
}
