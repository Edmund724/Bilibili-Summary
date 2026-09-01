// Reader 悬停 chrome（候选09 自 player-host.js 迁出）。
//
// 本文件拥有两组「宿主之上的浮层 chrome」定时器/绑定：
//   1. 控制条 chrome：自动隐藏（controlsHideTimer + hover 绑定）、可见性原语
//      （setReaderPlayerControlsVisible）、状态采集与自愈恢复
//      （ensureReaderPlayerControlsRecovered / queueEnsureReaderPlayerControls-
//      Recovered，含 controlsRecoveryTimer / controlsRecoveryInFlight /
//      controlsLastRecoverAt 节流）；
//   2. 头部 chrome：阅读视图头部动作按钮的悬停显示/延时隐藏
//     （headerHideTimer + hover 绑定）。
//
// 依赖方向说明（含一处既有耦合的如实记录）：本模块 import player-host 的
// getPlayerHost（原闭包直读 playerHost 改经访问器）与 layoutReaderPlayerHost
//（控制条恢复强制可见后须重算布局）；player-host 反向 import 本模块的
// 挂载/布局/清理路径调用点（bind/unbind/visible/queue/recovered）。双向均为
// 调用期引用，无模块求值期求值依赖，ESM 函数声明提升保证可用——与既有
// player-host ↔ page-frame 的调用期环同构。宿主停止路径的定时器清理（sync.js
// 的 SYNC→LAYOUT 静态边）仍经 player-host 的 clearLayoutTimersForSyncStop /
// closeReaderCleanup 转发到本模块的 clearReaderControlsHideTimer /
// cancelReaderControlsRecovery；unbindReaderPlayerControlsHover 由 player-host
// 按原导出转发（sync.js 的 import 路径不变）。
import { state } from "../core/state.js";
import { logInfo, logWarn } from "../shared/logging.js";
import { isVisibleReaderControl } from "../shared/dom-utils.js";
import { sleep } from "../shared/utils.js";
import { isWatchlaterPage } from "../bilibili/video-id-shared.js";
import { getPlayerHost, layoutReaderPlayerHost } from "./player-host.js";

declare global {
  interface Element {
    __bocReaderControlsHoverBound?: {
      showControls: () => void;
      hideControls: () => void;
    };
    __bocReaderHeaderHoverBound?: {
      showActions: () => void;
      hideActionsLater: () => void;
    };
  }
}

interface RecoveryOptions {
  reason?: string;
  retryDelayMs?: number;
}

interface QueueRecoveryOptions {
  reason?: string;
  delayMs?: number;
  minIntervalMs?: number;
}

let controlsHideTimer = 0;         // readingControlsHideTimer
let controlsRecoveryTimer = 0;     // readingControlsRecoveryTimer
let controlsRecoveryInFlight = false; // readingControlsRecoveryInFlight
let controlsLastRecoverAt = 0;     // readingControlsLastRecoverAt
let controlsHoverHost: Element | null = null;      // readingControlsHoverHost
let headerHoverHost: Element | null = null;        // readingHeaderHoverHost
let headerHideTimer = 0;           // readingHeaderHideTimer

export async function ensureReaderPlayerControlsRecovered(
  playerHostArg: Element | null = getPlayerHost(),
  { reason = "unknown", retryDelayMs = 90 }: RecoveryOptions = {}
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

function getReaderControlsRoot(playerHostArg: Element | null = getPlayerHost()): Element | null {
  return (
    playerHostArg?.closest?.("#playerWrap") ||
    playerHostArg?.closest?.("#bilibili-player") ||
    playerHostArg ||
    document.getElementById("playerWrap") ||
    document.getElementById("bilibili-player")
  );
}

function getReaderPlayerControlsState(playerHostArg: Element | null = getPlayerHost()) {
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

function hasReaderPlayerControlsIssue(playerHostArg: Element | null = getPlayerHost()) {
  if (!state.reader.readingNativePageMode || !playerHostArg || isWatchlaterPage()) {
    return false;
  }

  const snapshot = getReaderPlayerControlsState(playerHostArg);
  return snapshot.hostHasNoCursor || (snapshot.anyPresent && snapshot.anyHidden);
}

export function queueEnsureReaderPlayerControlsRecovered({
  reason = "unknown",
  delayMs = 120,
  minIntervalMs = 480
}: QueueRecoveryOptions = {}) {
  if (!state.reader.readingViewOpen || !state.reader.readingNativePageMode || isWatchlaterPage()) {
    return;
  }
  const playerHostNode = getPlayerHost();
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
    const activeHost = getPlayerHost();
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

export function setReaderPlayerControlsVisible(visible: boolean, playerHostArg: Element | null = getPlayerHost()) {
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
    if (!(node instanceof HTMLElement)) {
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

function scheduleReaderPlayerControlsHide(playerHostArg: Element | null = controlsHoverHost || getPlayerHost()) {
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

export function bindReaderPlayerControlsHover(playerHostArg: Element | null = getPlayerHost()) {
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

// clearLayoutTimersForSyncStop（player-host.js，SYNC 停止路径）原来内联清除的
// controlsHideTimer 分支：定时器属主随 chrome 迁入本模块后收拢为该导出。
export function clearReaderControlsHideTimer() {
  if (controlsHideTimer) {
    window.clearTimeout(controlsHideTimer);
    controlsHideTimer = 0;
  }
}

// closeReaderCleanup（player-host.js，停止/清理路径）原来内联清除的控制条恢复
// 定时器/在途标志：属主迁入本模块后收拢为该导出。
export function cancelReaderControlsRecovery() {
  if (controlsRecoveryTimer) {
    window.clearTimeout(controlsRecoveryTimer);
    controlsRecoveryTimer = 0;
  }
  controlsRecoveryInFlight = false;
}

function setReaderHeaderActionsVisible(visible: boolean) {
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

export function unbindReaderHeaderActionsHover() {
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
