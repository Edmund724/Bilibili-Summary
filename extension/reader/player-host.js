// Reader LAYOUT 层 · player-host 域（自 reader-impl.js 机械拆分）。
//
// 本文件拥有播放器宿主生命周期：挂载（ensureReaderPlayerMounted）/布局
// （layoutReaderPlayerHost，含候选10 批1 的 rAF 合帧与脏检查快照）/小窗关闭
// 调度/观察器，以及闭包访问器（getPlayerHost/setVideoEventsBound/
// clearLayoutTimersForSyncStop）与宿主停止清理（closeReaderCleanup）。分节
// 函数体逐字节搬自原 reader-impl.js 的 player-host 分节（原 :680-1486），
// 行为零变化。页面框架（DOM 焦点/剪枝/内联宿主/转写尾部留白）在
// ./page-frame.js；状态栏文案在 ./presentation.js。
//
// 候选06 端口半边：原寄居本文件的「只为破环」符号已各归其位——
// flushReadingTranscriptToIndex/setReadingTranscriptFlush 槽迁入 ./ports.js
// 显式端口（实现由 lifecycle.js 单点注册）；renderReadingStatus 转发删除
// （消费方直接 import ./presentation.js）；updateReadingTranscriptTailSpacer
// 迁往 ./page-frame.js（内联宿主的滚动留白属页面框架）。closeReaderCleanup 与
// clearLayoutTimersForSyncStop 留在本文件（sync.js 经合法 SYNC→LAYOUT 静态边
// 调用，并非反环 seam），其中控制条 chrome 的定时器清理转发到 ./hover-chrome.js。
// SYNC 域回调经 ./ports.js 显式端口（缺失即抛错）；./sync.js 与 ./lifecycle.js
// 依赖本层，本文件不得反向 import 它们。
// playerRetryTimer 闭包变量整体迁入 ./lifecycle.js（属主启动/清除都在那），
// clearLayoutTimersForSyncStop 因此不再清它（closeReadingView 原本就在
// stopReadingViewSync 之前自清；presenter reset 路径由 lifecycle 补齐清除）。
//
// 候选09：控制条自动隐藏/可见性/自愈恢复与头部悬停 chrome（两组 timer/observer）
// 整体迁往 ./hover-chrome.js；本文件在挂载/布局/清理路径经 import 调用其导出，
// 并按原导出转发 unbindReaderPlayerControlsHover（sync.js 的 import 路径不变）。
// 该拆分固有的双向耦合（chrome 恢复强制可见后须调 layoutReaderPlayerHost 重算
// 布局，而布局/挂载流程须驱动 chrome）全部是调用期引用，无模块求值期依赖，
// 与既有 player-host ↔ page-frame 的调用期环同构，详见 hover-chrome.js 头注。
import { state } from "../core/state.js";
import { logWarn } from "../shared/logging.js";
import { getReaderElement } from "../shared/dom-utils.js";
import { sleep } from "../shared/utils.js";
import { isReaderMode, isWatchlaterPage } from "../bilibili/video-id-shared.js";
import { findReaderPlayerHost, getRuntimeVideoElement } from "../bilibili/video-probe.js";
// 跨域模块接口：reader 私有 DOM id 表、页面宽度上限、小窗关闭与转写尾部留白
//（page-frame.js 导出）。
import {
  ids,
  getReaderMainWidthLimit,
  dismissReaderMiniPlayer,
  updateReadingTranscriptTailSpacer
} from "./page-frame.js";
// 候选06：SYNC 域回调经 reader 域唯一显式端口（ports.js 叶子，缺失即抛错）。
import { readerPorts } from "./ports.js";
// 候选09：控制条自动隐藏/恢复与头部悬停 chrome（属主迁往 ./hover-chrome.js）；
// 调用点在本文件的挂载/布局/清理路径。
import {
  setReaderPlayerControlsVisible,
  ensureReaderPlayerControlsRecovered,
  queueEnsureReaderPlayerControlsRecovered,
  bindReaderPlayerControlsHover,
  unbindReaderPlayerControlsHover,
  unbindReaderHeaderActionsHover,
  clearReaderControlsHideTimer,
  cancelReaderControlsRecovery
} from "./hover-chrome.js";

// 候选09：sync.js 的 SYNC→LAYOUT 静态边仍从本文件取该导出——按原导出转发
//（本文件 cleanupReaderPlayerHost 也经上方 import 直接调用它）。
export { unbindReaderPlayerControlsHover };

// ===== reader-domain private bookkeeping (module-level closure state) =====
//
// These were state.reader fields before issue 06; no module outside
// extension/reader/ reads or writes them, so they are hoisted here.
// Issue 07 removed the corresponding dead fields from state.js.
// readingVideoEl is not hoisted here: it is a cross-module shared field
// (video-probe reads, fetcher nulls it, reader writes it when binding or
// unbinding the video), so state.reader stays its single source of truth.
//
// syncTimer moved to sync.js with the sync domain. manualScrollPauseUntil /
// programmaticScrollUntil moved to ./scroll-state.js, the shared leaf owned by
// SYNC and LAYOUT alike; this module reads them only through that module's
// exported is* functions.
//
// playerRetryTimer（readingPlayerRetryTimer）迁入 ./lifecycle.js：属主启动
//（scheduleReaderPlayerRetry）与清除（closeReadingView）都在那个模块。
let playerHost = null;             // readingPlayerHost
let playerAdjustedNodes = [];      // readingPlayerAdjustedNodes
let playerObserver = null;         // readingPlayerObserver
let playerMountTimer = 0;          // readingPlayerMountTimer
let miniDismissTimer = 0;          // readingMiniDismissTimer
let videoEventsBound = false;      // readingVideoEventsBound
let layoutBound = false;           // readingLayoutBound

// ===== 候选10 批1：rAF 合帧布局调度与脏检查快照 =====
//
// scroll/resize 与 250ms sync tick 原先各自同步跑一次 layoutReaderPlayerHost
// （读 rect → 写 style → 读 clientHeight → 写 spacer），一帧内多次读写交错会
// 反复强制布局。事件路径现在只经 scheduleReaderLayout 置脏（rafId 即脏标志），
// 一帧至多跑一次「读→算→写」；同一帧内重复 scroll/tick 触发自动合并。
// layoutRafId 非 0 即表示「有未消费的布局请求」，cancel 路径见下。
let layoutRafId = 0;

// layoutReaderPlayerHost 上次写组快照：模式（native/slot）、宿主与视图节点、
// CSS 变量与 slot 分支的 8 个 setProperty 值。与本次计算结果全同则整组跳写，
// 避免每拍 tick / 每个滚动事件的无谓样式失效；模式切换（native↔slot）或
// 宿主/视图节点换新时强制写全量，防止旧快照掩盖新节点上的缺省样式。
let lastLayoutSnapshot = null;

// （候选10 批1 spacer 的脏检查采用「读内联现值比较」，无需模块级缓存字段：
// 内联样式读取是纯字符串操作，无布局开销；列表整段重建换新 spacer 节点
// （style.height 为空）或外部篡改时天然不命中、强制重写。）

function runScheduledReaderLayout() {
  layoutRafId = 0;
  // 阅读视图节点已被移除（扩展根被清理 / 测试 teardown 等）时直接丢弃本帧：
  // layoutReaderPlayerHost 经 byId 取节点，缺失会抛错；视图不在就没有可布局
  // 的对象，静默丢弃比让异常冒进 scroll 回调更安全。
  if (!document.getElementById(ids.readingView)) {
    return;
  }
  layoutReaderPlayerHost();
}

// 事件/tick 路径的布局入口：合并一帧内重复请求。直接调用
// layoutReaderPlayerHost 的路径（挂载/loadedmetadata/恢复重试等一次性场景）
// 保持同步语义不变。
export function scheduleReaderLayout() {
  if (layoutRafId) {
    return;
  }
  layoutRafId = window.requestAnimationFrame(runScheduledReaderLayout);
}

// 取消挂起的合帧布局：stop/close 路径（clearLayoutTimersForSyncStop /
// unbindReaderLayout）调用，避免关掉阅读视图后还跑一帧。
function cancelScheduledReaderLayout() {
  if (layoutRafId) {
    window.cancelAnimationFrame(layoutRafId);
    layoutRafId = 0;
  }
}

// ===== reader facade accessors for closure state =====
//
// These accessors are the seam between the layout (player-host.js) closure and
// the sync/lifecycle modules that depend on it. The scroll-pause variables
// moved to ./scroll-state.js, the shared leaf both domains read and write
// directly; sync.js resets the videoEventsBound flag through setVideoEventsBound.
export function getPlayerHost() {
  return playerHost;
}

export function setVideoEventsBound(bound) {
  videoEventsBound = Boolean(bound);
}

// Timer/flag accessors used by sync.js's stopReadingViewSync to clear the
// remaining layout timers it owns the lifecycle of. playerRetryTimer 分支已随
// 变量迁入 ./lifecycle.js（属主清除），不再在此清理；controlsHideTimer 分支随
// chrome 迁入 ./hover-chrome.js（属主清除），经其导出转发。
export function clearLayoutTimersForSyncStop() {
  // 挂起的合帧布局同属 stop 路径要清理的“布局定时器”：取消后关闭阅读视图
  // 不会再补跑一帧 layout（即便补跑也会被 layoutReaderPlayerHost 的
  // readingViewOpen 守卫拦下，这里显式取消是按候选10要求的兜底）。
  cancelScheduledReaderLayout();
  if (miniDismissTimer) {
    window.clearTimeout(miniDismissTimer);
    miniDismissTimer = 0;
  }
  clearReaderControlsHideTimer();
  if (playerMountTimer) {
    window.clearTimeout(playerMountTimer);
    playerMountTimer = 0;
  }
}


// 停止路径清理（LAYOUT 自有服务，非反环 seam）：closeReaderCleanup 清控制条
// 恢复定时器/在途标志（候选09 起属主在 ./hover-chrome.js，经其导出转发），
// stopReadingViewSync（sync.js，合法 SYNC→LAYOUT 静态边）与
// cleanupReaderPlayerHost（本域）在停止/清理时调用。
// 候选06 起 player-host 不再寄居任何「仅为破环」的符号——逆依赖回调一律走
// ./ports.js 显式端口，本文件只保留播放器宿主自身的状态与清理。
export function closeReaderCleanup() {
  cancelReaderControlsRecovery();
}

// renderReadingStatus 已迁往 ./presentation.js（消费方直接 import，本文件不再
// 转发）；updateReadingTranscriptTailSpacer 已迁往 ./page-frame.js（内联宿主
// 的滚动留白属页面框架域，本文件经 import 取用）。


// ===== player-host.js (player host lifecycle) =====

function clearNativeReaderFloatingStyles(playerHostArg = playerHost) {
  if (!state.reader.readingNativePageMode || !playerHostArg) {
    return;
  }

  const targets = [];
  let current = playerHostArg;
  let depth = 0;
  while (current && current !== document.body && depth < 8) {
    if (
      current.matches?.(
        ".bpx-player-container, .bpx-docker, .bpx-player-video-area, .bpx-player-primary-area, #bilibili-player, #playerWrap, .player-wrap"
      )
    ) {
      targets.push(current);
    }
    if (current.id === "playerWrap") {
      break;
    }
    current = current.parentElement;
    depth += 1;
  }

  targets.forEach((node) => {
    node.style.removeProperty("position");
    node.style.removeProperty("inset");
    node.style.removeProperty("left");
    node.style.removeProperty("top");
    node.style.removeProperty("right");
    node.style.removeProperty("bottom");
    node.style.removeProperty("transform");
    node.style.removeProperty("width");
    node.style.removeProperty("height");
    node.style.removeProperty("max-width");
    node.style.removeProperty("max-height");
    node.style.removeProperty("margin");
    node.style.removeProperty("z-index");
  });
}

export function getReaderPlayerWrapNode(playerHostArg = playerHost) {
  return (
    playerHostArg?.closest?.("#playerWrap") ||
    playerHostArg?.closest?.(".player-wrap") ||
    document.getElementById("playerWrap") ||
    document.querySelector(".player-wrap")
  );
}

export function hasNativeReaderPlayerLayoutIssue(playerHostArg = playerHost) {
  if (!state.reader.readingNativePageMode || !playerHostArg) {
    return false;
  }

  const playerStyle = window.getComputedStyle(playerHostArg);
  if (playerStyle.position === "fixed" || playerStyle.position === "sticky") {
    return true;
  }

  const playerRect = playerHostArg.getBoundingClientRect();
  const wrapNode = getReaderPlayerWrapNode(playerHostArg);
  if (!wrapNode) {
    return false;
  }

  const wrapRect = wrapNode.getBoundingClientRect();
  return wrapRect.height <= 8 && playerRect.height > 120;
}

export async function ensureReaderPlayerMounted({ retries = 1, delayMs = 100, forceLayout = false } = {}) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const video = getRuntimeVideoElement();
    const playerHostCandidate = findReaderPlayerHost(video);
    if (video && playerHostCandidate) {
      const previousHost = playerHost;
      const previousVideo = state.reader.readingVideoEl;
      video.controls = false;
      video.removeAttribute("controls");
      video.disablePictureInPicture = true;
      video.setAttribute("disablepictureinpicture", "");
      video.removeAttribute("autopictureinpicture");
      playerHost = playerHostCandidate;
      const miniPlayerClosed = dismissReaderMiniPlayer(playerHostCandidate);
      if (miniPlayerClosed) {
        await sleep(120);
      }
      const activeHost = findReaderPlayerHost(video) || playerHostCandidate;
      playerHost = activeHost;
      normalizeReaderPlayerContainer(activeHost);
      if (state.reader.readingNativePageMode) {
        clearNativeReaderFloatingStyles(activeHost);
        if (hasNativeReaderPlayerLayoutIssue(activeHost)) {
          normalizeReaderPlayerContainer(activeHost);
          clearNativeReaderFloatingStyles(activeHost);
        }
      }
      if (previousHost && previousHost !== activeHost) {
        setReaderPlayerControlsVisible(false, previousHost);
        cleanupReaderPlayerHostNode(previousHost);
      }
      if (previousVideo !== video) {
        videoEventsBound = false;
      }
      activeHost.classList.add("boc-reader-player-host");
      bindReadingViewVideo(video);
      bindReaderPlayerControlsHover(activeHost);
      bindReaderLayout();
      if (
        forceLayout ||
        previousHost !== activeHost ||
        attempt > 0 ||
        miniPlayerClosed ||
        (state.reader.readingNativePageMode && hasNativeReaderPlayerLayoutIssue(activeHost))
      ) {
        layoutReaderPlayerHost();
        if (state.reader.readingNativePageMode && hasNativeReaderPlayerLayoutIssue(activeHost)) {
          normalizeReaderPlayerContainer(activeHost);
          clearNativeReaderFloatingStyles(activeHost);
          layoutReaderPlayerHost();
        }
      }
      if (state.reader.readingNativePageMode && !isWatchlaterPage()) {
        await ensureReaderPlayerControlsRecovered(activeHost, {
          reason: attempt > 0 ? "mount-retry" : "mount"
        });
        queueEnsureReaderPlayerControlsRecovered({
          reason: attempt > 0 ? "post-mount-retry" : "post-mount",
          delayMs: 220,
          minIntervalMs: 240
        });
      }
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
      }
      return true;
    }
    await sleep(delayMs);
  }
  return false;
}

export function queueEnsureReaderPlayerMounted() {
  if (!state.reader.readingViewOpen || !isReaderMode() || playerMountTimer) {
    return;
  }
  playerMountTimer = window.setTimeout(() => {
    playerMountTimer = 0;
    ensureReaderPlayerMounted({ retries: 12, delayMs: 120, forceLayout: true }).catch((error) => {
      logWarn("[BOC] ensure reader player mounted failed", error);
    });
  }, 60);
}

export function isReaderPresentationStable(playerHostArg = playerHost) {
  if (!state.reader.readingViewOpen || !playerHostArg?.isConnected) {
    return false;
  }
  const rect = playerHostArg.getBoundingClientRect();
  if (!(rect.width > 240) || !(rect.height > 120)) {
    return false;
  }
  if (!state.reader.readingNativePageMode) {
    return true;
  }
  return !hasNativeReaderPlayerLayoutIssue(playerHostArg);
}

function bindReaderLayout() {
  if (layoutBound) {
    return;
  }
  // 候选10 批1：滚动/缩放/全屏事件只置脏标志 + rAF 合帧，一帧至多一次
  // 「读→算→写」；同步 layout 入口保留给挂载等一次性路径。
  window.addEventListener("resize", scheduleReaderLayout);
  window.addEventListener("scroll", scheduleReaderLayout, { passive: true });
  document.addEventListener("fullscreenchange", scheduleReaderLayout);
  document.addEventListener("webkitfullscreenchange", scheduleReaderLayout);
  layoutBound = true;
}

export function unbindReaderLayout() {
  if (!layoutBound) {
    return;
  }
  window.removeEventListener("resize", scheduleReaderLayout);
  window.removeEventListener("scroll", scheduleReaderLayout);
  document.removeEventListener("fullscreenchange", scheduleReaderLayout);
  document.removeEventListener("webkitfullscreenchange", scheduleReaderLayout);
  layoutBound = false;
  // 解绑即意味着阅读视图收尾：取消挂起的合帧布局，关闭后不再补跑一帧。
  cancelScheduledReaderLayout();
}

export function layoutReaderPlayerHost() {
  if (!state.reader.readingViewOpen || !isReaderMode()) {
    return;
  }

  const readingView = getReaderElement(ids.readingView);
  const playerHostNode = playerHost;
  const slot = getReaderElement(ids.readingPlayerSlot);
  if (!playerHostNode) {
    return;
  }

  if (state.reader.readingNativePageMode) {
    const rect = playerHostNode.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) {
      return;
    }

    const video = state.reader.readingVideoEl;
    let renderedWidth = rect.width;
    let renderedHeight = rect.height;
    if (Number(video?.videoWidth) > 0 && Number(video?.videoHeight) > 0) {
      const aspectRatio = Number(video.videoWidth) / Number(video.videoHeight);
      if (aspectRatio > 0) {
        const hostAspectRatio = rect.width / rect.height;
        if (hostAspectRatio > aspectRatio) {
          renderedHeight = rect.height;
          renderedWidth = rect.height * aspectRatio;
        } else {
          renderedWidth = rect.width;
          renderedHeight = rect.width / aspectRatio;
        }
      }
    }

    const widthLimit = getReaderMainWidthLimit();
    if (renderedWidth > widthLimit) {
      const scale = widthLimit / renderedWidth;
      renderedWidth = widthLimit;
      renderedHeight *= scale;
    }

    const cssWidth = `${Math.round(renderedWidth)}px`;
    const cssHeight = `${Math.round(renderedHeight)}px`;
    // 候选10 批1 脏检查：与上次快照全同（同模式/同节点/同 CSS 变量值）则整组
    // 跳写（含浮动样式清理与控制条恢复排队）；模式或节点变化强制写全量。
    const unchanged =
      lastLayoutSnapshot &&
      lastLayoutSnapshot.mode === "native" &&
      lastLayoutSnapshot.viewEl === readingView &&
      lastLayoutSnapshot.hostEl === playerHostNode &&
      lastLayoutSnapshot.cssWidth === cssWidth &&
      lastLayoutSnapshot.cssHeight === cssHeight;
    lastLayoutSnapshot = {
      mode: "native",
      viewEl: readingView,
      hostEl: playerHostNode,
      cssWidth,
      cssHeight,
      slot: null
    };
    if (!unchanged) {
      clearNativeReaderFloatingStyles(playerHostNode);
      cleanupReaderPlayerHostNode(playerHostNode);
      readingView.style.setProperty("--boc-reader-player-rendered-width", cssWidth);
      readingView.style.setProperty("--boc-reader-player-rendered-height", cssHeight);
      queueEnsureReaderPlayerControlsRecovered({
        reason: "layout-native",
        delayMs: 120
      });
    }
    updateReadingTranscriptTailSpacer();
    return;
  }

  if (!slot) {
    return;
  }

  const rect = slot.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) {
    return;
  }

  const video = state.reader.readingVideoEl;
  const aspectRatio =
    Number(video?.videoWidth) > 0 && Number(video?.videoHeight) > 0
      ? Number(video.videoWidth) / Number(video.videoHeight)
      : 16 / 9;
  const targetHeight = rect.height;
  const targetWidth = Math.min(rect.width, targetHeight * aspectRatio);
  const left = rect.left + (rect.width - targetWidth) / 2;

  const cssWidth = `${Math.round(targetWidth)}px`;
  const cssHeight = `${Math.round(targetHeight)}px`;
  // slot 分支的 8 个 setProperty 值快照（margin/zIndex/max-* 为常量，一并记录，
  // 与 native 快照对齐；任何一项变化都强制整组重写）。
  const slotStyles = {
    position: "fixed",
    left: `${Math.round(left)}px`,
    top: `${Math.round(rect.top)}px`,
    width: cssWidth,
    height: cssHeight,
    margin: "0",
    zIndex: "2147483647",
    maxWidth: "none",
    maxHeight: "none"
  };
  const unchanged =
    lastLayoutSnapshot &&
    lastLayoutSnapshot.mode === "slot" &&
    lastLayoutSnapshot.viewEl === readingView &&
    lastLayoutSnapshot.hostEl === playerHostNode &&
    lastLayoutSnapshot.cssWidth === cssWidth &&
    lastLayoutSnapshot.cssHeight === cssHeight &&
    JSON.stringify(lastLayoutSnapshot.slot) === JSON.stringify(slotStyles);
  lastLayoutSnapshot = {
    mode: "slot",
    viewEl: readingView,
    hostEl: playerHostNode,
    cssWidth,
    cssHeight,
    slot: slotStyles
  };
  if (!unchanged) {
    readingView.style.setProperty("--boc-reader-player-rendered-width", cssWidth);
    readingView.style.setProperty("--boc-reader-player-rendered-height", cssHeight);
    playerHostNode.style.setProperty("position", slotStyles.position, "important");
    playerHostNode.style.setProperty("left", slotStyles.left, "important");
    playerHostNode.style.setProperty("top", slotStyles.top, "important");
    playerHostNode.style.setProperty("width", slotStyles.width, "important");
    playerHostNode.style.setProperty("height", slotStyles.height, "important");
    playerHostNode.style.setProperty("margin", slotStyles.margin, "important");
    playerHostNode.style.setProperty("z-index", slotStyles.zIndex, "important");
    playerHostNode.style.setProperty("max-width", slotStyles.maxWidth, "important");
    playerHostNode.style.setProperty("max-height", slotStyles.maxHeight, "important");
  }
  updateReadingTranscriptTailSpacer();
}

function cleanupReaderPlayerHostNode(playerHostNode) {
  if (!playerHostNode) {
    return;
  }
  playerHostNode.classList.remove("boc-reader-player-host");
  playerHostNode.style.removeProperty("position");
  playerHostNode.style.removeProperty("inset");
  playerHostNode.style.removeProperty("left");
  playerHostNode.style.removeProperty("top");
  playerHostNode.style.removeProperty("right");
  playerHostNode.style.removeProperty("bottom");
  playerHostNode.style.removeProperty("transform");
  playerHostNode.style.removeProperty("width");
  playerHostNode.style.removeProperty("height");
  playerHostNode.style.removeProperty("margin");
  playerHostNode.style.removeProperty("z-index");
  playerHostNode.style.removeProperty("max-width");
  playerHostNode.style.removeProperty("max-height");
}

export function cleanupReaderPlayerHost() {
  restoreReaderPlayerContainer();
  unbindReaderPlayerControlsHover();
  unbindReaderHeaderActionsHover();
  closeReaderCleanup();
  const readingView = getReaderElement(ids.readingView);
  readingView?.style.removeProperty("--boc-reader-player-rendered-width");
  readingView?.style.removeProperty("--boc-reader-player-rendered-height");
  // 候选10 批1：CSS 变量已在上面移除，布局写组快照必须失效——否则下次打开
  // 阅读视图且尺寸未变时，脏检查会误判“无需重写”，变量缺失导致布局塌掉。
  lastLayoutSnapshot = null;
  const playerHostNode = playerHost;
  if (!playerHostNode) {
    return;
  }
  setReaderPlayerControlsVisible(false, playerHostNode);
  cleanupReaderPlayerHostNode(playerHostNode);
  playerHost = null;
}

export function startReaderPlayerObserver() {
  if (!isReaderMode() || playerObserver || !document.body) {
    return;
  }
  const observer = new MutationObserver(() => {
    if (!state.reader.readingViewOpen) {
      return;
    }
    const nextVideo = getRuntimeVideoElement();
    const nextHost = findReaderPlayerHost(nextVideo);
    if (nextVideo && nextHost && (nextVideo !== state.reader.readingVideoEl || nextHost !== playerHost)) {
      queueEnsureReaderPlayerMounted();
    }
    if (document.querySelector(".bpx-player-mini-close, .bpx-player-mini-warp")) {
      scheduleReaderMiniPlayerDismiss();
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: false
  });
  playerObserver = observer;
}

export function stopReaderPlayerObserver() {
  if (playerObserver) {
    playerObserver.disconnect();
    playerObserver = null;
  }
}

export function bindReadingViewVideo(video = getRuntimeVideoElement()) {
  if (!video) {
    if (state.reader.readingVideoEl && state.reader.readingVideoEl.__bocReadingSyncHandler) {
      const prev = state.reader.readingVideoEl;
      prev.removeEventListener("timeupdate", prev.__bocReadingSyncHandler);
      prev.removeEventListener("seeked", prev.__bocReadingSyncHandler);
      prev.removeEventListener("loadedmetadata", prev.__bocReadingSyncHandler);
      delete prev.__bocReadingSyncHandler;
    }
    state.reader.readingVideoEl = null;
    videoEventsBound = false;
    return null;
  }

  if (state.reader.readingVideoEl === video && videoEventsBound) {
    return video;
  }

  if (state.reader.readingVideoEl && state.reader.readingVideoEl.__bocReadingSyncHandler) {
    const prev = state.reader.readingVideoEl;
    prev.removeEventListener("timeupdate", prev.__bocReadingSyncHandler);
    prev.removeEventListener("seeked", prev.__bocReadingSyncHandler);
    prev.removeEventListener("loadedmetadata", prev.__bocReadingSyncHandler);
  }

  const syncHandler = (event) => {
    if (state.reader.readingViewOpen) {
      if (event?.type === "loadedmetadata") {
        layoutReaderPlayerHost();
      }
      if (event?.type === "seeked") {
        state.reader.setNextScrollBehavior("auto");
        queueEnsureReaderPlayerControlsRecovered({
          reason: "seeked",
          delayMs: 140,
          minIntervalMs: 320
        });
      }
      const latestHost = findReaderPlayerHost(video);
      if (latestHost && latestHost !== playerHost) {
        queueEnsureReaderPlayerMounted();
      }
      // Resolved at call time through the explicit reader ports leaf
      // (./ports.js), so this never creates a static player-host → sync.js edge.
      readerPorts.syncReadingViewPlayback();
    }
  };
  video.addEventListener("timeupdate", syncHandler);
  video.addEventListener("seeked", syncHandler);
  video.addEventListener("loadedmetadata", syncHandler);
  video.__bocReadingSyncHandler = syncHandler;
  state.reader.readingVideoEl = video;
  playerHost = findReaderPlayerHost(video) || playerHost;
  videoEventsBound = true;
  return video;
}

export function scheduleReaderMiniPlayerDismiss(maxAttempts = 12, delayMs = 180) {
  if (!state.reader.readingViewOpen) {
    return;
  }
  if (miniDismissTimer) {
    window.clearTimeout(miniDismissTimer);
    miniDismissTimer = 0;
  }

  let attempts = 0;
  const run = () => {
    if (!state.reader.readingViewOpen) {
      miniDismissTimer = 0;
      return;
    }

    const closed = dismissReaderMiniPlayer();
    const host = findReaderPlayerHost(getRuntimeVideoElement());
    if (host) {
      playerHost = host;
      normalizeReaderPlayerContainer(host);
      layoutReaderPlayerHost();
    }

    attempts += 1;
    const miniExists = Boolean(document.querySelector(".bpx-player-mini-close, .bpx-player-mini-warp"));
    const hostFixed = Boolean(host && window.getComputedStyle(host).position === "fixed");
    if (attempts < maxAttempts && (miniExists || hostFixed || closed)) {
      miniDismissTimer = window.setTimeout(run, delayMs);
      return;
    }
    miniDismissTimer = 0;
  };

  miniDismissTimer = window.setTimeout(run, 40);
}

function normalizeReaderPlayerContainer(playerHostArg = playerHost) {
  if (!playerHostArg) {
    return;
  }

  restoreReaderPlayerContainer();
  const adjusted = [];
  let current = playerHostArg;
  let depth = 0;

  while (current && current !== document.body && depth < 12) {
    const computed = window.getComputedStyle(current);
    const className = typeof current.className === "string" ? current.className : "";
    const isPlayerLayoutNode = current.matches?.(
      ".bpx-player-container, .bpx-player-video-area, .bpx-player-primary-area, .bpx-player-inner, .scroll-sticky, .player-wrap, #playerWrap, #bilibili-player"
    );
    const isExplicitMiniNode = current.matches?.(
      ".bpx-player-mini-warp, .bpx-player-mini-close, [class*='mini-player'], [class*='picture-in-picture']"
    );
    const hasFloatingPosition = computed.position === "fixed" || computed.position === "sticky";
    const isMiniLike =
      hasFloatingPosition ||
      /mini|picture|float|fixed-player/i.test(className) ||
      current.matches?.(".bpx-player-mini-warp, .bpx-player-mini-close");
    const shouldReset = state.reader.readingNativePageMode
      ? Boolean(isExplicitMiniNode || (isPlayerLayoutNode && isMiniLike))
      : isPlayerLayoutNode || isMiniLike;

    if (shouldReset) {
      adjusted.push({
        node: current,
        position: current.style.position,
        left: current.style.left,
        top: current.style.top,
        right: current.style.right,
        bottom: current.style.bottom,
        width: current.style.width,
        height: current.style.height,
        transform: current.style.transform,
        margin: current.style.margin,
        zIndex: current.style.zIndex
      });
      current.setAttribute("data-boc-reader-player-reset", "1");
      current.style.setProperty("position", "static", "important");
      current.style.setProperty("left", "auto", "important");
      current.style.setProperty("top", "auto", "important");
      current.style.setProperty("right", "auto", "important");
      current.style.setProperty("bottom", "auto", "important");
      current.style.setProperty("transform", "none", "important");
      current.style.setProperty("margin", "0", "important");
      current.style.setProperty("z-index", "auto", "important");
      if (current !== playerHostArg) {
        current.style.removeProperty("width");
        current.style.removeProperty("height");
      }
    }

    current = current.parentElement;
    depth += 1;
  }

  playerAdjustedNodes = adjusted;
}

function restoreReaderPlayerContainer() {
  const adjusted = Array.isArray(playerAdjustedNodes) ? playerAdjustedNodes : [];
  adjusted.forEach((item) => {
    const node = item?.node;
    if (!node?.isConnected) {
      return;
    }
    node.style.position = item.position || "";
    node.style.left = item.left || "";
    node.style.top = item.top || "";
    node.style.right = item.right || "";
    node.style.bottom = item.bottom || "";
    node.style.width = item.width || "";
    node.style.height = item.height || "";
    node.style.transform = item.transform || "";
    node.style.margin = item.margin || "";
    node.style.zIndex = item.zIndex || "";
    node.removeAttribute("data-boc-reader-player-reset");
  });
  playerAdjustedNodes = [];
}
