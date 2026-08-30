// Reader LAYOUT 层 · player-host 域（自 reader-impl.js 机械拆分）。
//
// 本文件拥有播放器宿主生命周期：挂载（ensureReaderPlayerMounted）/布局
// （layoutReaderPlayerHost）/控制条恢复与悬停/小窗关闭调度/观察器，以及原
// reader-impl.js 头部的共享函数（closeReaderCleanup、
// updateReadingTranscriptTailSpacer、renderReadingStatus）与闭包访问器
// （getPlayerHost/setVideoEventsBound/clearLayoutTimersForSyncStop）。
// 分节函数体逐字节搬自原 reader-impl.js 的 player-host 分节（原 :680-1486），
// 行为零变化。页面框架（DOM 焦点/剪枝/内联宿主）在 ./page-frame.js。
//
// SYNC 域调用经 ./sync-adapter.js 反环叶子（callSync）；./sync.js 与
// ./lifecycle.js 依赖本层，本文件不得反向 import 它们。
// playerRetryTimer 闭包变量整体迁入 ./lifecycle.js（属主启动/清除都在那），
// clearLayoutTimersForSyncStop 因此不再清它（closeReadingView 原本就在
// stopReadingViewSync 之前自清；presenter reset 路径由 lifecycle 补齐清除）。
import { state } from "../core/state.js";
import { logInfo, logWarn } from "../shared/logging.js";
import { getReaderElement, isVisibleReaderControl } from "../shared/dom-utils.js";
import { sleep } from "../shared/utils.js";
import { isReaderMode, isWatchlaterPage } from "../bilibili/video-id-shared.js";
import { findReaderPlayerHost, getRuntimeVideoElement } from "../bilibili/video-probe.js";
// 跨域模块接口：reader 私有 DOM id 表、页面宽度上限与小窗关闭（page-frame.js 导出）。
import { ids, getReaderMainWidthLimit, dismissReaderMiniPlayer } from "./page-frame.js";
import { callSync } from "./sync-adapter.js";
// 候选02 分层惰性：renderReadingStatus 是纯 DOM 文案写入的轻函数，已迁往
// 常驻微模块 ./presentation.js（message-handler/content.js 等常驻侧直接 import
// 该模块，不再为一句状态栏文案拖入本域）。此处 re-export 维持域内旧路径。
export { renderReadingStatus } from "./presentation.js";

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
let controlsHideTimer = 0;         // readingControlsHideTimer
let controlsRecoveryTimer = 0;     // readingControlsRecoveryTimer
let controlsRecoveryInFlight = false; // readingControlsRecoveryInFlight
let controlsLastRecoverAt = 0;     // readingControlsLastRecoverAt
let controlsHoverHost = null;      // readingControlsHoverHost
let headerHoverHost = null;        // readingHeaderHoverHost
let headerHideTimer = 0;           // readingHeaderHideTimer
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

// ===== 候选10 批2：字幕分批渲染的「同步补渲染」seam =====
//
// SYNC 域（sync.js）的跳转/跟随定位要求「目标条目未上屏时先同步补渲染到目标
// index 再滚动」，但分批渲染任务归 LIFECYCLE（lifecycle.js）所有，而
// SYNC → LIFECYCLE 是依赖图禁止的边（LIFECYCLE → SYNC + LAYOUT 才合法）。
// 与 sync-adapter.js（SYNC 注册、LAYOUT 调用）互为镜像：LIFECYCLE 在模块加载
// 时把补渲染实现注册进本基座，SYNC 经 flushReadingTranscriptToIndex 调用，
// 依赖图保持无环。
let transcriptFlushHandler = null;

export function setReadingTranscriptFlush(handler) {
  transcriptFlushHandler = typeof handler === "function" ? handler : null;
}

// 供 SYNC 域调用：目标 index 未上屏时同步补渲染。无注册实现（如测试只挂骨架、
// 或列表本就无需分批）时直接返回 true，调用方的后续 querySelector 行为与
// 未引入分批渲染前一致。
export function flushReadingTranscriptToIndex(targetIndex) {
  if (!transcriptFlushHandler) {
    return true;
  }
  return Boolean(transcriptFlushHandler(targetIndex));
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
// 变量迁入 ./lifecycle.js（属主清除），不再在此清理。
export function clearLayoutTimersForSyncStop() {
  // 挂起的合帧布局同属 stop 路径要清理的“布局定时器”：取消后关闭阅读视图
  // 不会再补跑一帧 layout（即便补跑也会被 layoutReaderPlayerHost 的
  // readingViewOpen 守卫拦下，这里显式取消是按候选10要求的兜底）。
  cancelScheduledReaderLayout();
  if (miniDismissTimer) {
    window.clearTimeout(miniDismissTimer);
    miniDismissTimer = 0;
  }
  if (controlsHideTimer) {
    window.clearTimeout(controlsHideTimer);
    controlsHideTimer = 0;
  }
  if (playerMountTimer) {
    window.clearTimeout(playerMountTimer);
    playerMountTimer = 0;
  }
}


// Shared by the LAYOUT and LIFECYCLE domains: layoutReaderPlayerHost /
// moveReadingMainInline call updateReadingTranscriptTailSpacer, and
// stopReadingViewSync (sync.js) / cleanupReaderPlayerHost call
// closeReaderCleanup. They live in the base layer so neither dependent module
// needs a back-edge to this one.
export function closeReaderCleanup() {
  if (controlsRecoveryTimer) {
    window.clearTimeout(controlsRecoveryTimer);
    controlsRecoveryTimer = 0;
  }
  controlsRecoveryInFlight = false;
}

export function updateReadingTranscriptTailSpacer() {
  const spacer = document.getElementById(ids.readingTranscriptTailSpacer);
  if (!spacer) {
    return;
  }
  const inlineHost = document.getElementById("boc-reading-inline-host");
  const transcriptList = document.getElementById(ids.readingTranscriptList);
  const hostHeight = inlineHost?.clientHeight || transcriptList?.clientHeight || 0;
  const spacerHeight = Math.max(hostHeight, Math.round(window.innerHeight * 0.92), 320);
  // 候选10 批1 脏检查：现值与目标一致则跳写（250ms tick / 每帧追加都会调到）。
  // 读现值而非缓存快照：换新 spacer 节点（重建后 style.height 为空）或外部
  // 篡改时自动重写，无需额外的节点身份失效逻辑。
  if (spacer.style.height === `${spacerHeight}px`) {
    return;
  }
  spacer.style.height = `${spacerHeight}px`;
}

// renderReadingStatus 已迁往 ./presentation.js（文件头 re-export）：SYNC 与
// LIFECYCLE 域经旧路径继续可用，常驻侧则直接 import 微模块。

async function ensureReaderPlayerControlsRecovered(
  playerHostArg = playerHost,
  { reason = "unknown", retryDelayMs = 90 } = {}
) {
  if (!state.reader.readingNativePageMode || !playerHostArg || isWatchlaterPage()) {
    return false;
  }

  const before = getReaderPlayerControlsState(playerHostArg);
  logInfo("[BOC] reader controls check", {
    reason,
    hostClassName: typeof playerHostArg.className === "string" ? playerHostArg.className : "",
    hostHasNoCursor: before.hostHasNoCursor,
    controlRootFound: before.controlRootFound,
    controls: before.nodes
  });

  if (!hasReaderPlayerControlsIssue(playerHostArg)) {
    return false;
  }

  logInfo("[BOC] recovering normal reader controls", {
    reason,
    hostClassName: typeof playerHostArg.className === "string" ? playerHostArg.className : ""
  });
  setReaderPlayerControlsVisible(true, playerHostArg);
  layoutReaderPlayerHost();

  let after = getReaderPlayerControlsState(playerHostArg);
  logInfo("[BOC] reader controls after recovery", {
    reason,
    hostClassName: typeof playerHostArg.className === "string" ? playerHostArg.className : "",
    hostHasNoCursor: after.hostHasNoCursor,
    controls: after.nodes,
    retried: false
  });
  if (!hasReaderPlayerControlsIssue(playerHostArg)) {
    return true;
  }

  await sleep(retryDelayMs);
  logInfo("[BOC] retrying normal reader controls recovery", {
    reason,
    hostClassName: typeof playerHostArg.className === "string" ? playerHostArg.className : ""
  });
  setReaderPlayerControlsVisible(true, playerHostArg);
  layoutReaderPlayerHost();
  after = getReaderPlayerControlsState(playerHostArg);
  logInfo("[BOC] reader controls after retry", {
    reason,
    hostClassName: typeof playerHostArg.className === "string" ? playerHostArg.className : "",
    hostHasNoCursor: after.hostHasNoCursor,
    controls: after.nodes,
    retried: true
  });
  return !hasReaderPlayerControlsIssue(playerHostArg);
}


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
      // Resolved at call time through the sync adapter, so this never
      // creates a static reader-impl → sync.js cycle.
      callSync("syncReadingViewPlayback");
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

function getReaderControlsRoot(playerHostArg = playerHost) {
  return (
    playerHostArg?.closest?.("#playerWrap") ||
    playerHostArg?.closest?.("#bilibili-player") ||
    playerHostArg ||
    document.getElementById("playerWrap") ||
    document.getElementById("bilibili-player")
  );
}

function getReaderPlayerControlsState(playerHostArg = playerHost) {
  const controlRoot = getReaderControlsRoot(playerHostArg);
  const nodes = [".bpx-player-control-wrap", ".bpx-player-control-mask", ".bpx-player-control-entity"].map(
    (selector) => {
      const node = controlRoot?.querySelector(selector) || null;
      return {
        selector,
        exists: Boolean(node),
        visible: isVisibleReaderControl(node)
      };
    }
  );

  return {
    controlRootFound: Boolean(controlRoot),
    hostHasNoCursor: Boolean(playerHostArg?.classList.contains("bpx-state-no-cursor")),
    anyPresent: nodes.some((item) => item.exists),
    anyHidden: nodes.some((item) => item.exists && !item.visible),
    nodes
  };
}

function hasReaderPlayerControlsIssue(playerHostArg = playerHost) {
  if (!state.reader.readingNativePageMode || !playerHostArg || isWatchlaterPage()) {
    return false;
  }

  const snapshot = getReaderPlayerControlsState(playerHostArg);
  return snapshot.hostHasNoCursor || (snapshot.anyPresent && snapshot.anyHidden);
}

function queueEnsureReaderPlayerControlsRecovered({
  reason = "unknown",
  delayMs = 120,
  minIntervalMs = 480
} = {}) {
  if (!state.reader.readingViewOpen || !state.reader.readingNativePageMode || isWatchlaterPage()) {
    return;
  }
  const playerHostNode = playerHost;
  if (!playerHostNode?.isConnected || controlsRecoveryInFlight) {
    return;
  }

  const now = Date.now();
  if (controlsRecoveryTimer) {
    return;
  }
  if (now - controlsLastRecoverAt < minIntervalMs) {
    return;
  }

  controlsRecoveryTimer = window.setTimeout(() => {
    controlsRecoveryTimer = 0;
    if (!state.reader.readingViewOpen || !state.reader.readingNativePageMode || isWatchlaterPage()) {
      return;
    }
    const activeHost = playerHost;
    if (!activeHost?.isConnected || !hasReaderPlayerControlsIssue(activeHost)) {
      return;
    }

    controlsRecoveryInFlight = true;
    controlsLastRecoverAt = Date.now();
    ensureReaderPlayerControlsRecovered(activeHost, {
      reason,
      retryDelayMs: 120
    })
      .catch((error) => {
        logWarn("[BOC] queued reader controls recovery failed", { reason, error });
      })
      .finally(() => {
        controlsRecoveryInFlight = false;
      });
  }, delayMs);
}

function setReaderPlayerControlsVisible(visible, playerHostArg = playerHost) {
  if (!state.reader.readingNativePageMode || !playerHostArg) {
    return;
  }

  const controlRoot = getReaderControlsRoot(playerHostArg);
  if (!controlRoot) {
    return;
  }

  const displayMap = new Map([
    [".bpx-player-control-wrap", "block"],
    [".bpx-player-control-mask", "block"],
    [".bpx-player-control-entity", "block"]
  ]);

  displayMap.forEach((displayValue, selector) => {
    const node = controlRoot.querySelector(selector);
    if (!node) {
      return;
    }

    if (visible) {
      node.style.setProperty("display", displayValue, "important");
      node.setAttribute("data-boc-reader-controls-forced", "1");
      return;
    }

    if (node.getAttribute("data-boc-reader-controls-forced") === "1") {
      node.style.removeProperty("display");
      node.removeAttribute("data-boc-reader-controls-forced");
    }
  });

  if (visible) {
    if (playerHostArg.classList.contains("bpx-state-no-cursor")) {
      playerHostArg.classList.remove("bpx-state-no-cursor");
      playerHostArg.setAttribute("data-boc-reader-no-cursor-cleared", "1");
    }
    return;
  }

  if (playerHostArg.getAttribute("data-boc-reader-no-cursor-cleared") === "1") {
    playerHostArg.classList.add("bpx-state-no-cursor");
    playerHostArg.removeAttribute("data-boc-reader-no-cursor-cleared");
  }
}

function scheduleReaderPlayerControlsHide(playerHostArg = controlsHoverHost || playerHost) {
  if (controlsHideTimer) {
    window.clearTimeout(controlsHideTimer);
  }
  controlsHideTimer = window.setTimeout(() => {
    controlsHideTimer = 0;
    if (!state.reader.readingViewOpen) {
      return;
    }
    setReaderPlayerControlsVisible(false, playerHostArg);
  }, 1200);
}

function bindReaderPlayerControlsHover(playerHostArg = playerHost) {
  if (!state.reader.readingNativePageMode || !isWatchlaterPage() || !playerHostArg) {
    return;
  }

  if (controlsHoverHost && controlsHoverHost !== playerHostArg) {
    unbindReaderPlayerControlsHover();
  }
  if (playerHostArg.__bocReaderControlsHoverBound) {
    controlsHoverHost = playerHostArg;
    return;
  }

  const showControls = () => {
    if (!state.reader.readingViewOpen) {
      return;
    }
    setReaderPlayerControlsVisible(true, playerHostArg);
    scheduleReaderPlayerControlsHide(playerHostArg);
  };
  const hideControls = () => {
    if (controlsHideTimer) {
      window.clearTimeout(controlsHideTimer);
      controlsHideTimer = 0;
    }
    setReaderPlayerControlsVisible(false, playerHostArg);
  };

  playerHostArg.addEventListener("mouseenter", showControls, { capture: true, passive: true });
  playerHostArg.addEventListener("mousemove", showControls, { capture: true, passive: true });
  playerHostArg.addEventListener("mouseleave", hideControls, { capture: true, passive: true });
  playerHostArg.__bocReaderControlsHoverBound = { showControls, hideControls };
  controlsHoverHost = playerHostArg;
}

export function unbindReaderPlayerControlsHover() {
  const playerHostNode = controlsHoverHost;
  if (controlsHideTimer) {
    window.clearTimeout(controlsHideTimer);
    controlsHideTimer = 0;
  }
  if (!playerHostNode?.__bocReaderControlsHoverBound) {
    controlsHoverHost = null;
    return;
  }

  const { showControls, hideControls } = playerHostNode.__bocReaderControlsHoverBound;
  playerHostNode.removeEventListener("mouseenter", showControls, true);
  playerHostNode.removeEventListener("mousemove", showControls, true);
  playerHostNode.removeEventListener("mouseleave", hideControls, true);
  delete playerHostNode.__bocReaderControlsHoverBound;
  setReaderPlayerControlsVisible(false, playerHostNode);
  controlsHoverHost = null;
}

function setReaderHeaderActionsVisible(visible) {
  const actions = document.querySelector(".boc-reading-actions");
  if (!actions) {
    return;
  }
  if (visible) {
    actions.removeAttribute("data-boc-icon-hidden");
    return;
  }
  actions.setAttribute("data-boc-icon-hidden", "1");
}

function scheduleReaderHeaderActionsHide(delayMs = 10000) {
  if (headerHideTimer) {
    window.clearTimeout(headerHideTimer);
    headerHideTimer = 0;
  }
  headerHideTimer = window.setTimeout(() => {
    headerHideTimer = 0;
    if (!state.reader.readingViewOpen) {
      return;
    }
    setReaderHeaderActionsVisible(false);
  }, delayMs);
}

export function bindReaderHeaderActionsHover() {
  if (!state.reader.readingViewOpen) {
    return;
  }
  const header = document.querySelector(".boc-reading-header");
  if (!header || header.__bocReaderHeaderHoverBound) {
    headerHoverHost = header || null;
    return;
  }

  const showActions = () => {
    if (!state.reader.readingViewOpen) {
      return;
    }
    if (headerHideTimer) {
      window.clearTimeout(headerHideTimer);
      headerHideTimer = 0;
    }
    setReaderHeaderActionsVisible(true);
  };
  const hideActionsLater = () => {
    if (!state.reader.readingViewOpen) {
      return;
    }
    scheduleReaderHeaderActionsHide();
  };

  header.addEventListener("mouseenter", showActions, true);
  header.addEventListener("mouseleave", hideActionsLater, true);
  header.__bocReaderHeaderHoverBound = { showActions, hideActionsLater };
  headerHoverHost = header;
  setReaderHeaderActionsVisible(true);
  scheduleReaderHeaderActionsHide();
}

function unbindReaderHeaderActionsHover() {
  const header = headerHoverHost;
  if (headerHideTimer) {
    window.clearTimeout(headerHideTimer);
    headerHideTimer = 0;
  }
  if (!header?.__bocReaderHeaderHoverBound) {
    headerHoverHost = null;
    return;
  }
  const { showActions, hideActionsLater } = header.__bocReaderHeaderHoverBound;
  header.removeEventListener("mouseenter", showActions, true);
  header.removeEventListener("mouseleave", hideActionsLater, true);
  delete header.__bocReaderHeaderHoverBound;
  headerHoverHost = null;
  setReaderHeaderActionsVisible(true);
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
