import { state, readerState } from "./state.js";
import { byId } from "./runtime.js";
import { getRuntimeVideoElement, findReaderPlayerHost } from "./video-probe.js";
import { findActiveSubtitleIndex, findActiveChapterIndex } from "./subtitle.js";
import { formatCompactTimestamp } from "./string-utils.js";
import {
  bindReadingViewVideo,
  queueEnsureReaderPlayerMounted,
  layoutReaderPlayerHost,
  stopReaderPlayerObserver,
  unbindReaderPlayerControlsHover
} from "./reader-player-host.js";
import { ids, renderReadingStatus } from "./reader-shell.js";

export function startReadingViewSync() {
  if (state.reader.readingSyncTimer) {
    window.clearInterval(state.reader.readingSyncTimer);
  }
  state.reader.readingSyncTimer = window.setInterval(() => {
    syncReadingViewPlayback();
  }, 250);
}

export function stopReadingViewSync() {
  if (state.reader.readingSyncTimer) {
    window.clearInterval(state.reader.readingSyncTimer);
    state.reader.readingSyncTimer = 0;
  }
  if (state.reader.readingMiniDismissTimer) {
    window.clearTimeout(state.reader.readingMiniDismissTimer);
    state.reader.readingMiniDismissTimer = 0;
  }
  if (state.reader.readingControlsHideTimer) {
    window.clearTimeout(state.reader.readingControlsHideTimer);
    state.reader.readingControlsHideTimer = 0;
  }
  if (state.reader.readingControlsRecoveryTimer) {
    window.clearTimeout(state.reader.readingControlsRecoveryTimer);
    state.reader.readingControlsRecoveryTimer = 0;
  }
  state.reader.readingControlsRecoveryInFlight = false;
  if (state.reader.readingPlayerMountTimer) {
    window.clearTimeout(state.reader.readingPlayerMountTimer);
    state.reader.readingPlayerMountTimer = 0;
  }
  if (state.reader.readingPlayerRetryTimer) {
    window.clearTimeout(state.reader.readingPlayerRetryTimer);
    state.reader.readingPlayerRetryTimer = 0;
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
  state.reader.readingVideoEventsBound = false;
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
      runtimeVideo !== state.reader.readingVideoEl || runtimeHost !== state.reader.readingPlayerHost;
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
    if (Date.now() < state.reader.readingManualScrollPauseUntil) {
      updateReaderFollowState();
      readerState.setActiveSubtitleIndex(subtitleIndex);
      readerState.setActiveChapterIndex(chapterIndex);
      return;
    }
    if (nextTranscript) {
      scrollReadingTranscriptItemIntoView(nextTranscript);
    }
    if (nextChapter) {
      scrollReadingRailItemIntoView(nextChapter);
    }
  }

  readerState.setActiveSubtitleIndex(subtitleIndex);
  readerState.setActiveChapterIndex(chapterIndex);
}

export function scrollReadingRailItemIntoView(node) {
  if (!node) {
    return;
  }
  state.reader.readingProgrammaticScrollUntil = Date.now() + 600;
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
  state.reader.readingProgrammaticScrollUntil = Date.now() + (behavior === "auto" ? 120 : 800);
  readerState.setNextScrollBehavior("smooth");
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
  state.reader.readingManualScrollPauseUntil = 0;
  readerState.setNextScrollBehavior("auto");
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
  state.reader.readingManualScrollPauseUntil = Date.now() + durationMs;
  updateReaderFollowState();
}

export function updateReaderFollowState() {
  const readingView = document.getElementById(ids.readingView);
  if (!readingView) {
    return;
  }
  const mode =
    !state.reader.readingAutoScroll ? "off" : Date.now() < state.reader.readingManualScrollPauseUntil ? "manual" : "auto";
  readingView.setAttribute("data-boc-reader-follow", mode);
}
