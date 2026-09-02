// Reader playback↔subtitle synchronization (extracted from reader-impl.js,
// formerly the subtitle-sync.js segment, issue 06+).
//
// Deep module owning the sync timer and the manual/programmatic scroll-pause
// deadlines, plus the reader 域唯一定位入口 seekReadingTarget（阅读视图内点击
// 与侧栏时间戳 seek 的共享规范序）。
//
// Layer graph (acyclic; ports.js is the zero-dependency leaf):
//
//   ports.js  显式回调端口（本域逆依赖的唯一通道，lifecycle 单点注册）
//   LAYOUT    page-frame.js + player-host.js        → ports
//                               module-level closure: playerHost, videoEventsBound,
//                               scroll-pause variables, timer variables
//   SYNC      sync.js（本文件）                     → LAYOUT + ports
//                               syncTimer lives here; scroll deadlines live here;
//                               reads/writes the layout closure only through the
//                               exported layout functions (imported below)
//   LIFECYCLE lifecycle.js                          → SYNC + LAYOUT
//
// LAYOUT must not import this module — its layout/shell functions that need
// sync-domain behavior call it through the explicit reader ports leaf
// (./ports.js, registered once by lifecycle.js), keeping the dependency graph
// acyclic: SYNC → LAYOUT. 不允许任何 `?.[` 式静默端口调用回潮。
import { state } from "../core/state.js";
import { formatCompactTimestamp } from "../shared/string-utils.js";
import { getReaderElement } from "../shared/dom-utils.js";
import { findActiveSubtitleIndex, findActiveChapterIndex } from "../subtitle/core.js";
import { findReaderPlayerHost, getRuntimeVideoElement } from "../bilibili/video-probe.js";
import {
  ids,
  isManualScrollPaused,
  resetManualScrollPause,
  setManualScrollPaused,
  setProgrammaticScrollUntil
} from "./state.js";
import {
  getPlayerHost,
  bindReadingViewVideo,
  unbindReadingViewVideoSync,
  queueEnsureReaderPlayerMounted,
  scheduleReaderLayout,
  stopReaderPlayerObserver,
  unbindReaderPlayerControlsHover,
  closeReaderCleanup,
  setVideoEventsBound,
  clearLayoutTimersForSyncStop
} from "./player-host.js";
// 候选02 分层惰性：状态栏文案属常驻微模块，直接 import（不再经 player-host 转发）。
import { renderReadingStatus } from "./presentation.js";
// 候选06 端口半边：SYNC → LIFECYCLE 的字幕同步补渲染经显式端口回调
//（实现由 lifecycle.js 启动时单点注册，缺失即抛错）。
import { readerPorts } from "./ports.js";
// PR3 转写中间态：250ms tick 顺带收敛转写横幅（相位/进度行脏检查在
// transcribe-banner 内部，稳态零 DOM 写）。transcribe-banner 是零依赖呈现叶子
//（state + shared status-bus），不破坏 SYNC → LAYOUT + ports 的层图。
import { updateReadingTranscribeBanner } from "./transcribe-banner.js";

// ===== sync-domain private bookkeeping (module-level closure state) =====
//
// syncTimer (readingSyncTimer) moved here with the sync domain.
// manualScrollPauseUntil / programmaticScrollUntil live in ./state.js,
// the shared leaf both this module and the LAYOUT layer read/write directly.
let syncTimer = 0; // readingSyncTimer

// ===== subtitle-sync.js (playback sync) =====

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
  unbindReadingViewVideoSync();
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
  // PR3：转写横幅随 tick 收敛（转写期间 onProgress 持续改写状态栏文本，进度行
  // 需要跟着刷新；显隐脏检查在 updateReadingTranscribeBanner 内部）。
  updateReadingTranscribeBanner();
}

// 候选10 批1：上次激活高亮的缓存（字幕 + 章节各一份）。index 未变且上次写入的
// 节点仍连接在文档时，整段跳过 querySelector 与 classList 写。列表整段重建
// （renderReadingView）会使旧节点脱离文档、缓存自动失效回退到现查；分批渲染
// 未追到目标时节点为 null，同样回退现查（条目上屏后的下一拍自然补上高亮）。
const lastActiveItems: { subtitle: ActiveItemCache; chapter: ActiveItemCache } = {
  subtitle: { index: -1, node: null },
  chapter: { index: -1, node: null }
};

// 解析本次应激活的节点：命中缓存时返回 unchanged=true（DOM 已是目标状态，
// 不需要任何 querySelector / classList 写）；未命中时按旧逻辑现查 next 与
// current——current 优先复用缓存里的旧激活节点（它就是上次被本函数加上
// is-active 的节点，语义等价且省一次 querySelector），旧节点已脱离文档时
// 退回 ".is-active" 现查，行为与原实现一致。
interface ActiveItemCache {
  index: number;
  node: HTMLElement | null;
}

function resolveActiveItem(cached: ActiveItemCache, index: number, list: HTMLElement, className: string) {
  if (cached.node?.isConnected && cached.index === index) {
    return { next: cached.node, current: cached.node, unchanged: true };
  }
  const next = list.querySelector<HTMLElement>(`[data-index="${index}"]`);
  const current = cached.node?.isConnected
    ? cached.node
    : list.querySelector<HTMLElement>(`.${className}.is-active`);
  return { next, current, unchanged: false };
}

function setActiveReadingItems(subtitleIndex: number, chapterIndex: number, shouldScroll = false) {
  const subtitleList = getReaderElement(ids.readingSubtitleList);
  // 阶段 2（B 形态）：rail 章节列表 DOM 已退役，章节高亮降级为可选容器（无
  // 节点即跳过写组）；activeChapterIndex 状态照常维护（概览 tab 的高亮消费）。
  const chapterList = document.getElementById(ids.readingChapterList);
  const subtitleHit = resolveActiveItem(lastActiveItems.subtitle, subtitleIndex, subtitleList, "boc-reading-item");
  const chapterHit = chapterList
    ? resolveActiveItem(lastActiveItems.chapter, chapterIndex, chapterList, "boc-reading-chapter")
    : { next: null, current: null, unchanged: true };

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
    let scrollSubtitleNode = subtitleHit.next;
    // 候选10 批2：字幕列表分批渲染后，跳转/跟随的目标条目可能还没追加上屏。
    // 先同步补渲染到目标 index 再取节点滚动，保证「跳不过去」不发生；章节
    // 列表始终整段渲染，无此问题。
    if (!scrollSubtitleNode && subtitleIndex >= 0) {
      // 候选06：补渲染实现属 LIFECYCLE（分批渲染状态机在 lifecycle.js），经
      // 显式端口回调（lifecycle 启动时注册，缺失即抛错，不再静默返回 true）。
      readerPorts.flushReadingSubtitleToIndex(subtitleIndex);
      scrollSubtitleNode = subtitleList.querySelector(`[data-index="${subtitleIndex}"]`);
      if (scrollSubtitleNode) {
        // 补渲染后才拿到节点：同步补上 is-active 并刷新缓存，与「节点本就在屏」
        // 的路径保持等价（否则高亮要拖到下一拍才出现）。
        if (subtitleHit.current && subtitleHit.current !== scrollSubtitleNode) {
          subtitleHit.current.classList.remove("is-active");
        }
        scrollSubtitleNode.classList.add("is-active");
        lastActiveItems.subtitle.index = subtitleIndex;
        lastActiveItems.subtitle.node = scrollSubtitleNode;
      }
    }
    if (scrollSubtitleNode) {
      scrollReadingSubtitleItemIntoView(scrollSubtitleNode);
    }
    if (chapterHit.next) {
      scrollReadingRailItemIntoView(chapterHit.next);
    }
  }

  state.reader.setActiveSubtitleIndex(subtitleIndex);
  state.reader.setActiveChapterIndex(chapterIndex);
}

function scrollReadingRailItemIntoView(node: HTMLElement) {
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

function scrollReadingSubtitleItemIntoView(node: HTMLElement) {
  if (!node) {
    return;
  }

  // PR2 统一 Digest 面板：字幕列表常驻右侧面板「字幕」tab（自身即滚动容器），
  // 原内联宿主分支（boc-reading-inline-host 的 scrollTo）随机制移除——跟随/
  // 跳转滚动一律收敛为「优先列表容器内滚动，容器不可滚才滚页面兜底」。
  // 列表容器或条目不可见（如其他标签页激活、条目尚未上屏）时退回
  // scrollIntoView：对隐藏节点无操作，不产生程序化滚动窗口。
  const subtitleList = getReaderElement(ids.readingSubtitleList);
  const listRect = subtitleList.getBoundingClientRect();
  const itemRect = node.getBoundingClientRect();
  if (!(listRect.height > 0) || !(itemRect.height > 0)) {
    scrollReadingRailItemIntoView(node);
    return;
  }

  const behavior = state.reader.readingNextScrollBehavior === "auto" ? "auto" : "smooth";
  setProgrammaticScrollUntil(Date.now() + (behavior === "auto" ? 120 : 800));
  state.reader.setNextScrollBehavior("smooth");
  if (subtitleList.scrollHeight <= subtitleList.clientHeight + 8) {
    const desiredTop = listRect.top + Math.max(72, Math.min(listRect.height * 0.24, 220));
    const nextTop = window.scrollY + itemRect.top - desiredTop;
    window.scrollTo({
      top: Math.max(0, Math.round(nextTop)),
      behavior
    });
    return;
  }

  const targetScrollTop =
    subtitleList.scrollTop + (itemRect.top - listRect.top) - Math.max(48, Math.min(listRect.height * 0.24, 180));
  subtitleList.scrollTo({
    top: Math.max(0, Math.round(targetScrollTop)),
    behavior
  });
}

// ===== seek 深入口（候选06 端口半边） =====
//
// reader 域的唯一定位入口：阅读视图内点击章节/字幕时间戳与侧栏时间戳 seek
// 一律收敛到这里（此前侧栏路径在 message-handler 手抄了一份乱序版本——先
// currentTime 后清暂停，currentTime 触发的 timeupdate 会在手动暂停标志未清时
// 跑同步，吞掉一次跟随滚动，属真 bug 风险）。
//
// 规范序锁死（不得重排）：
//   1) resetManualScrollPause                    清手动滚动暂停
//   2) setNextScrollBehavior("auto") + 跟随状态   设程序化跟随
//   3) video.currentTime = nextTime              赋值定位（触发的事件落在干净状态上）
//   4) resumePlayback 且暂停中才 play            播放策略参数化
//   5) syncReadingViewPlayback(true)             立即同步高亮/滚动
//
// 播放策略：阅读视图内点击传 resumePlayback:true（旧行为：暂停即播放）；侧栏
// seek 传 resumePlayback:false（暂停中不自动播放，与旧侧栏行为等价——旧侧栏
// 只在「seek 前正在播放」时补一次 play，本就在播的视频无需干预）。
export function seekReadingTarget(seconds: number | string, { resumePlayback = false } = {}) {
  const video = bindReadingViewVideo();
  if (!video) {
    renderReadingStatus("当前页面没有找到可联动的视频播放器。");
    return null;
  }

  // 统一两侧旧实现的截断语义：非有限值（NaN/Infinity）一律回 0，
  // 负值截为 0。返回截断后的时间供消息处理器回包使用。
  const raw = Number(seconds);
  const nextTime = Math.max(0, Number.isFinite(raw) ? raw : 0);
  resetManualScrollPause();
  state.reader.setNextScrollBehavior("auto");
  updateReaderFollowState();
  video.currentTime = nextTime;
  if (resumePlayback && video.paused) {
    video.play().catch(() => {});
  }
  syncReadingViewPlayback(true);
  return nextTime;
}

// 阅读视图内点击跳转：自动播放策略（resumePlayback:true）委托给 seek 深入口。
export function jumpReadingTarget(seconds: number | string) {
  seekReadingTarget(seconds, { resumePlayback: true });
}

export function onReadingChapterClick(event: MouseEvent) {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(".boc-reading-chapter");
  if (!target) {
    return;
  }
  jumpReadingTarget(target.dataset.seconds ?? 0);
}

export function onReadingSubtitleClick(event: MouseEvent) {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(".boc-reading-item");
  if (!target) {
    return;
  }
  // Don't jump if user is selecting text
  if (window.getSelection()?.toString().trim()) {
    return;
  }
  jumpReadingTarget(target.dataset.seconds ?? 0);
}

export function noteManualReaderInteraction(durationMs = 3000) {
  if (!state.reader.readingAutoScroll) {
    updateReaderFollowState();
    return;
  }
  setManualScrollPaused(Date.now() + durationMs);
  updateReaderFollowState();
}

// PR3 Follow playback 悬浮按钮的回调：把跟随从「关闭（off）/手动暂停（manual）」
// 拉回自动。按钮显隐由 data-boc-reader-follow 三态的 CSS 驱动（reader.css），
// 本函数只负责行为：
//   - off 态 = 用户在设置面板关了自动滚动 → 重新打开并同步 checkbox；
//   - manual 态 = 手动滚动暂停中 → 清暂停；
//   - 随后 forceScroll 同步一次高亮与滚动，跳回「当前正在播的句子」——不改
//     播放进度（按钮语义是「回去继续跟随」，不是 seek；与 youtube-digest
//     sidepanel.js 的 Follow playback 按钮行为一致）。
export function resumeReaderFollowPlayback() {
  if (!state.reader.readingAutoScroll) {
    state.reader.setAutoScroll(true);
    const checkbox = document.getElementById(ids.readingAutoScroll) as HTMLInputElement | null;
    if (checkbox) {
      checkbox.checked = true;
    }
  }
  resetManualScrollPause();
  updateReaderFollowState();
  syncReadingViewPlayback(true);
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
