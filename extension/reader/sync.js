// Reader playback↔transcript synchronization (extracted from reader-impl.js,
// formerly the transcript-sync.js segment, issue 06+).
//
// Deep module owning the sync timer and the manual/programmatic scroll-pause
// deadlines. Layout is the base layer (extension/reader/page-frame.js +
// player-host.js); this module depends on it and must never be imported by it
// (the dependency graph is acyclic: SYNC → LAYOUT).
//
//   LAYOUT   page-frame.js + player-host.js
//                               module-level closure: playerHost, videoEventsBound,
//                               scroll-pause variables, timer variables
//   SYNC     sync.js            syncTimer lives here; scroll deadlines live here;
//                               reads/writes the layout closure only through the
//                               exported layout functions (imported below)
//
// LAYOUT must not import this module — its layout/shell functions that need
// sync-domain behavior call it through the adapter registered below
// (registerSyncAdapter, in ./sync-adapter.js), keeping the dependency graph
// acyclic: SYNC → LAYOUT.
import { state } from "../core/state.js";
import { formatCompactTimestamp } from "../shared/string-utils.js";
import { getReaderElement } from "../shared/dom-utils.js";
import { findActiveSubtitleIndex, findActiveChapterIndex } from "../subtitle/core.js";
import { findReaderPlayerHost, getRuntimeVideoElement } from "../bilibili/video-probe.js";
import {
  isManualScrollPaused,
  resetManualScrollPause,
  setManualScrollPaused,
  setProgrammaticScrollUntil
} from "./scroll-state.js";

import { ids } from "./page-frame.js";
import {
  getPlayerHost,
  bindReadingViewVideo,
  queueEnsureReaderPlayerMounted,
  scheduleReaderLayout,
  flushReadingTranscriptToIndex,
  stopReaderPlayerObserver,
  unbindReaderPlayerControlsHover,
  closeReaderCleanup,
  renderReadingStatus,
  setVideoEventsBound,
  clearLayoutTimersForSyncStop
} from "./player-host.js";
import { registerSyncAdapter } from "./sync-adapter.js";

// Register this module's function table with the sync-adapter leaf
// (./sync-adapter.js) so the LAYOUT functions (page-frame/player-host) can call
// into the sync domain synchronously. Function declarations
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
// manualScrollPauseUntil / programmaticScrollUntil live in ./scroll-state.js,
// the shared leaf both this module and the LAYOUT layer read/write directly.
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
    // 候选10 批1：每拍 250ms 的 native 布局改走 rAF 合帧调度（与 scroll 事件
    // 同一调度），一帧至多一次「读→算→写」；layout 内部带脏检查，稳态零写。
    scheduleReaderLayout();
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

// 候选10 批1：上次激活高亮的缓存（字幕 + 章节各一份）。index 未变且上次写入的
// 节点仍连接在文档时，整段跳过 querySelector 与 classList 写。列表整段重建
// （renderReadingView）会使旧节点脱离文档、缓存自动失效回退到现查；分批渲染
// 未追到目标时节点为 null，同样回退现查（条目上屏后的下一拍自然补上高亮）。
const lastActiveItems = {
  subtitle: { index: -1, node: null },
  chapter: { index: -1, node: null }
};

// 解析本次应激活的节点：命中缓存时返回 unchanged=true（DOM 已是目标状态，
// 不需要任何 querySelector / classList 写）；未命中时按旧逻辑现查 next 与
// current——current 优先复用缓存里的旧激活节点（它就是上次被本函数加上
// is-active 的节点，语义等价且省一次 querySelector），旧节点已脱离文档时
// 退回 ".is-active" 现查，行为与原实现一致。
function resolveActiveItem(cached, index, list, className) {
  if (cached.node?.isConnected && cached.index === index) {
    return { next: cached.node, current: cached.node, unchanged: true };
  }
  const next = list.querySelector(`[data-index="${index}"]`);
  const current = cached.node?.isConnected
    ? cached.node
    : list.querySelector(`.${className}.is-active`);
  return { next, current, unchanged: false };
}

function setActiveReadingItems(subtitleIndex, chapterIndex, shouldScroll = false) {
  const transcriptList = getReaderElement(ids.readingTranscriptList);
  const chapterList = getReaderElement(ids.readingChapterList);
  const subtitleHit = resolveActiveItem(lastActiveItems.subtitle, subtitleIndex, transcriptList, "boc-reading-item");
  const chapterHit = resolveActiveItem(lastActiveItems.chapter, chapterIndex, chapterList, "boc-reading-chapter");

  if (!subtitleHit.unchanged) {
    if (subtitleHit.current && subtitleHit.current !== subtitleHit.next) {
      subtitleHit.current.classList.remove("is-active");
    }
    if (subtitleHit.next) {
      subtitleHit.next.classList.add("is-active");
    }
    lastActiveItems.subtitle.index = subtitleIndex;
    lastActiveItems.subtitle.node = subtitleHit.next;
  }
  if (!chapterHit.unchanged) {
    if (chapterHit.current && chapterHit.current !== chapterHit.next) {
      chapterHit.current.classList.remove("is-active");
    }
    if (chapterHit.next) {
      chapterHit.next.classList.add("is-active");
    }
    lastActiveItems.chapter.index = chapterIndex;
    lastActiveItems.chapter.node = chapterHit.next;
  }

  if (shouldScroll && state.reader.readingAutoScroll) {
    if (isManualScrollPaused()) {
      updateReaderFollowState();
      state.reader.setActiveSubtitleIndex(subtitleIndex);
      state.reader.setActiveChapterIndex(chapterIndex);
      return;
    }
    let scrollTranscriptNode = subtitleHit.next;
    // 候选10 批2：字幕列表分批渲染后，跳转/跟随的目标条目可能还没追加上屏。
    // 先同步补渲染到目标 index 再取节点滚动，保证「跳不过去」不发生；章节
    // 列表始终整段渲染，无此问题。
    if (!scrollTranscriptNode && subtitleIndex >= 0) {
      flushReadingTranscriptToIndex(subtitleIndex);
      scrollTranscriptNode = transcriptList.querySelector(`[data-index="${subtitleIndex}"]`);
      if (scrollTranscriptNode) {
        // 补渲染后才拿到节点：同步补上 is-active 并刷新缓存，与「节点本就在屏」
        // 的路径保持等价（否则高亮要拖到下一拍才出现）。
        if (subtitleHit.current && subtitleHit.current !== scrollTranscriptNode) {
          subtitleHit.current.classList.remove("is-active");
        }
        scrollTranscriptNode.classList.add("is-active");
        lastActiveItems.subtitle.index = subtitleIndex;
        lastActiveItems.subtitle.node = scrollTranscriptNode;
      }
    }
    if (scrollTranscriptNode) {
      scrollReadingTranscriptItemIntoView(scrollTranscriptNode);
    }
    if (chapterHit.next) {
      scrollReadingRailItemIntoView(chapterHit.next);
    }
  }

  state.reader.setActiveSubtitleIndex(subtitleIndex);
  state.reader.setActiveChapterIndex(chapterIndex);
}

function scrollReadingRailItemIntoView(node) {
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

function scrollReadingTranscriptItemIntoView(node) {
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
  // 候选10 批1：值未变时跳过 setAttribute。先读现值而非缓存上次写入值：
  // closeReadingView 会 removeAttribute，读现值能自动从外部移除中自愈。
  if (readingView.getAttribute("data-boc-reader-follow") === mode) {
    return;
  }
  readingView.setAttribute("data-boc-reader-follow", mode);
}
