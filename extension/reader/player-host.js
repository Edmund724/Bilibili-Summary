// Reader player host module.
// Owns the lifecycle of the embedded player host inside reader mode: mount/dismount,
// layout, mini-player dismissal, native control recovery, and header hover affordances.

import { state, readerState } from "../core/state.js";
import { sleep } from "../core/shared-defaults.js";
import { isReaderMode, isWatchlaterPage } from "../bilibili/url-utils.js";
import { byId } from "../core/runtime.js";
import { findReaderPlayerHost, getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { isVisibleReaderControl } from "../ai/player-ai.js";
import {
  dismissReaderMiniPlayer,
  getReaderMainWidthLimit
} from "./page-frame.js";
import {
  closeReaderCleanup,
  ensureReaderPlayerControlsRecovered,
  ids,
  logWarn,
  updateReadingTranscriptTailSpacer
} from "./shell.js";
import { syncReadingViewPlayback } from "./transcript-sync.js";

export function clearNativeReaderFloatingStyles(playerHost = state.reader.readingPlayerHost) {
  if (!state.reader.readingNativePageMode || !playerHost) {
    return;
  }

  const targets = [];
  let current = playerHost;
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

export function getReaderPlayerWrapNode(playerHost = state.reader.readingPlayerHost) {
  return (
    playerHost?.closest?.("#playerWrap") ||
    playerHost?.closest?.(".player-wrap") ||
    document.getElementById("playerWrap") ||
    document.querySelector(".player-wrap")
  );
}

export function hasNativeReaderPlayerLayoutIssue(playerHost = state.reader.readingPlayerHost) {
  if (!state.reader.readingNativePageMode || !playerHost) {
    return false;
  }

  const playerStyle = window.getComputedStyle(playerHost);
  if (playerStyle.position === "fixed" || playerStyle.position === "sticky") {
    return true;
  }

  const playerRect = playerHost.getBoundingClientRect();
  const wrapNode = getReaderPlayerWrapNode(playerHost);
  if (!wrapNode) {
    return false;
  }

  const wrapRect = wrapNode.getBoundingClientRect();
  return wrapRect.height <= 8 && playerRect.height > 120;
}

export async function ensureReaderPlayerMounted({ retries = 1, delayMs = 100, forceLayout = false } = {}) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const video = getRuntimeVideoElement();
    const playerHost = findReaderPlayerHost(video);
    if (video && playerHost) {
      const previousHost = state.reader.readingPlayerHost;
      const previousVideo = state.reader.readingVideoEl;
      video.controls = false;
      video.removeAttribute("controls");
      video.disablePictureInPicture = true;
      video.setAttribute("disablepictureinpicture", "");
      video.removeAttribute("autopictureinpicture");
      state.reader.readingPlayerHost = playerHost;
      const miniPlayerClosed = dismissReaderMiniPlayer(playerHost);
      if (miniPlayerClosed) {
        await sleep(120);
      }
      const activeHost = findReaderPlayerHost(video) || playerHost;
      state.reader.readingPlayerHost = activeHost;
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
        state.reader.readingVideoEventsBound = false;
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
  if (!state.reader.readingViewOpen || !isReaderMode() || state.reader.readingPlayerMountTimer) {
    return;
  }
  state.reader.readingPlayerMountTimer = window.setTimeout(() => {
    state.reader.readingPlayerMountTimer = 0;
    ensureReaderPlayerMounted({ retries: 12, delayMs: 120, forceLayout: true }).catch((error) => {
      logWarn("[BOC] ensure reader player mounted failed", error);
    });
  }, 60);
}

export function isReaderPresentationStable(playerHost = state.reader.readingPlayerHost) {
  if (!state.reader.readingViewOpen || !playerHost?.isConnected) {
    return false;
  }
  const rect = playerHost.getBoundingClientRect();
  if (!(rect.width > 240) || !(rect.height > 120)) {
    return false;
  }
  if (!state.reader.readingNativePageMode) {
    return true;
  }
  return !hasNativeReaderPlayerLayoutIssue(playerHost);
}

export function bindReaderLayout() {
  if (state.reader.readingLayoutBound) {
    return;
  }
  window.addEventListener("resize", layoutReaderPlayerHost);
  window.addEventListener("scroll", layoutReaderPlayerHost, { passive: true });
  document.addEventListener("fullscreenchange", layoutReaderPlayerHost);
  document.addEventListener("webkitfullscreenchange", layoutReaderPlayerHost);
  state.reader.readingLayoutBound = true;
}

export function unbindReaderLayout() {
  if (!state.reader.readingLayoutBound) {
    return;
  }
  window.removeEventListener("resize", layoutReaderPlayerHost);
  window.removeEventListener("scroll", layoutReaderPlayerHost);
  document.removeEventListener("fullscreenchange", layoutReaderPlayerHost);
  document.removeEventListener("webkitfullscreenchange", layoutReaderPlayerHost);
  state.reader.readingLayoutBound = false;
}

export function layoutReaderPlayerHost() {
  if (!state.reader.readingViewOpen || !isReaderMode()) {
    return;
  }

  const readingView = byId(ids.readingView);
  const playerHost = state.reader.readingPlayerHost;
  const slot = byId(ids.readingPlayerSlot);
  if (!playerHost) {
    return;
  }

  if (state.reader.readingNativePageMode) {
    const rect = playerHost.getBoundingClientRect();
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

    clearNativeReaderFloatingStyles(playerHost);
    cleanupReaderPlayerHostNode(playerHost);
    readingView.style.setProperty("--boc-reader-player-rendered-width", `${Math.round(renderedWidth)}px`);
    readingView.style.setProperty("--boc-reader-player-rendered-height", `${Math.round(renderedHeight)}px`);
    updateReadingTranscriptTailSpacer();
    queueEnsureReaderPlayerControlsRecovered({
      reason: "layout-native",
      delayMs: 120
    });
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

  readingView.style.setProperty("--boc-reader-player-rendered-width", `${Math.round(targetWidth)}px`);
  readingView.style.setProperty("--boc-reader-player-rendered-height", `${Math.round(targetHeight)}px`);
  playerHost.style.setProperty("position", "fixed", "important");
  playerHost.style.setProperty("left", `${Math.round(left)}px`, "important");
  playerHost.style.setProperty("top", `${Math.round(rect.top)}px`, "important");
  playerHost.style.setProperty("width", `${Math.round(targetWidth)}px`, "important");
  playerHost.style.setProperty("height", `${Math.round(targetHeight)}px`, "important");
  playerHost.style.setProperty("margin", "0", "important");
  playerHost.style.setProperty("z-index", "2147483647", "important");
  playerHost.style.setProperty("max-width", "none", "important");
  playerHost.style.setProperty("max-height", "none", "important");
  updateReadingTranscriptTailSpacer();
}

export function cleanupReaderPlayerHostNode(playerHost) {
  if (!playerHost) {
    return;
  }
  playerHost.classList.remove("boc-reader-player-host");
  playerHost.style.removeProperty("position");
  playerHost.style.removeProperty("inset");
  playerHost.style.removeProperty("left");
  playerHost.style.removeProperty("top");
  playerHost.style.removeProperty("right");
  playerHost.style.removeProperty("bottom");
  playerHost.style.removeProperty("transform");
  playerHost.style.removeProperty("width");
  playerHost.style.removeProperty("height");
  playerHost.style.removeProperty("margin");
  playerHost.style.removeProperty("z-index");
  playerHost.style.removeProperty("max-width");
  playerHost.style.removeProperty("max-height");
}

export function cleanupReaderPlayerHost() {
  restoreReaderPlayerContainer();
  unbindReaderPlayerControlsHover();
  unbindReaderHeaderActionsHover();
  closeReaderCleanup();
  const readingView = byId(ids.readingView);
  readingView?.style.removeProperty("--boc-reader-player-rendered-width");
  readingView?.style.removeProperty("--boc-reader-player-rendered-height");
  const playerHost = state.reader.readingPlayerHost;
  if (!playerHost) {
    return;
  }
  setReaderPlayerControlsVisible(false, playerHost);
  cleanupReaderPlayerHostNode(playerHost);
  state.reader.readingPlayerHost = null;
}

export function startReaderPlayerObserver() {
  if (!isReaderMode() || state.reader.readingPlayerObserver || !document.body) {
    return;
  }
  const observer = new MutationObserver(() => {
    if (!state.reader.readingViewOpen) {
      return;
    }
    const nextVideo = getRuntimeVideoElement();
    const nextHost = findReaderPlayerHost(nextVideo);
    if (nextVideo && nextHost && (nextVideo !== state.reader.readingVideoEl || nextHost !== state.reader.readingPlayerHost)) {
      queueEnsureReaderPlayerMounted();
    }
    if (document.querySelector(".bpx-player-mini-close, .bpx-player-mini-warp")) {
      scheduleReaderMiniPlayerDismiss();
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
  state.reader.readingPlayerObserver = observer;
}

export function stopReaderPlayerObserver() {
  if (state.reader.readingPlayerObserver) {
    state.reader.readingPlayerObserver.disconnect();
    state.reader.readingPlayerObserver = null;
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
    state.reader.readingVideoEventsBound = false;
    return null;
  }

  if (state.reader.readingVideoEl === video && state.reader.readingVideoEventsBound) {
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
        readerState.setNextScrollBehavior("auto");
        queueEnsureReaderPlayerControlsRecovered({
          reason: "seeked",
          delayMs: 140,
          minIntervalMs: 320
        });
      }
      const latestHost = findReaderPlayerHost(video);
      if (latestHost && latestHost !== state.reader.readingPlayerHost) {
        queueEnsureReaderPlayerMounted();
      }
      syncReadingViewPlayback();
    }
  };
  video.addEventListener("timeupdate", syncHandler);
  video.addEventListener("seeked", syncHandler);
  video.addEventListener("loadedmetadata", syncHandler);
  video.__bocReadingSyncHandler = syncHandler;
  state.reader.readingVideoEl = video;
  state.reader.readingPlayerHost = findReaderPlayerHost(video) || state.reader.readingPlayerHost;
  state.reader.readingVideoEventsBound = true;
  return video;
}

export function scheduleReaderMiniPlayerDismiss(maxAttempts = 12, delayMs = 180) {
  if (!state.reader.readingViewOpen) {
    return;
  }
  if (state.reader.readingMiniDismissTimer) {
    window.clearTimeout(state.reader.readingMiniDismissTimer);
    state.reader.readingMiniDismissTimer = 0;
  }

  let attempts = 0;
  const run = () => {
    if (!state.reader.readingViewOpen) {
      state.reader.readingMiniDismissTimer = 0;
      return;
    }

    const closed = dismissReaderMiniPlayer();
    const host = findReaderPlayerHost(getRuntimeVideoElement());
    if (host) {
      state.reader.readingPlayerHost = host;
      normalizeReaderPlayerContainer(host);
      layoutReaderPlayerHost();
    }

    attempts += 1;
    const miniExists = Boolean(document.querySelector(".bpx-player-mini-close, .bpx-player-mini-warp"));
    const hostFixed = Boolean(host && window.getComputedStyle(host).position === "fixed");
    if (attempts < maxAttempts && (miniExists || hostFixed || closed)) {
      state.reader.readingMiniDismissTimer = window.setTimeout(run, delayMs);
      return;
    }
    state.reader.readingMiniDismissTimer = 0;
  };

  state.reader.readingMiniDismissTimer = window.setTimeout(run, 40);
}

export function getReaderControlsRoot(playerHost = state.reader.readingPlayerHost) {
  return (
    playerHost?.closest?.("#playerWrap") ||
    playerHost?.closest?.("#bilibili-player") ||
    playerHost ||
    document.getElementById("playerWrap") ||
    document.getElementById("bilibili-player")
  );
}

export function getReaderPlayerControlsState(playerHost = state.reader.readingPlayerHost) {
  const controlRoot = getReaderControlsRoot(playerHost);
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
    hostHasNoCursor: Boolean(playerHost?.classList.contains("bpx-state-no-cursor")),
    anyPresent: nodes.some((item) => item.exists),
    anyHidden: nodes.some((item) => item.exists && !item.visible),
    nodes
  };
}

export function hasReaderPlayerControlsIssue(playerHost = state.reader.readingPlayerHost) {
  if (!state.reader.readingNativePageMode || !playerHost || isWatchlaterPage()) {
    return false;
  }

  const snapshot = getReaderPlayerControlsState(playerHost);
  return snapshot.hostHasNoCursor || (snapshot.anyPresent && snapshot.anyHidden);
}

export function queueEnsureReaderPlayerControlsRecovered({
  reason = "unknown",
  delayMs = 120,
  minIntervalMs = 480
} = {}) {
  if (!state.reader.readingViewOpen || !state.reader.readingNativePageMode || isWatchlaterPage()) {
    return;
  }
  const playerHost = state.reader.readingPlayerHost;
  if (!playerHost?.isConnected || state.reader.readingControlsRecoveryInFlight) {
    return;
  }

  const now = Date.now();
  if (state.reader.readingControlsRecoveryTimer) {
    return;
  }
  if (now - state.reader.readingControlsLastRecoverAt < minIntervalMs) {
    return;
  }

  state.reader.readingControlsRecoveryTimer = window.setTimeout(() => {
    state.reader.readingControlsRecoveryTimer = 0;
    if (!state.reader.readingViewOpen || !state.reader.readingNativePageMode || isWatchlaterPage()) {
      return;
    }
    const activeHost = state.reader.readingPlayerHost;
    if (!activeHost?.isConnected || !hasReaderPlayerControlsIssue(activeHost)) {
      return;
    }

    state.reader.readingControlsRecoveryInFlight = true;
    state.reader.readingControlsLastRecoverAt = Date.now();
    ensureReaderPlayerControlsRecovered(activeHost, {
      reason,
      retryDelayMs: 120
    })
      .catch((error) => {
        logWarn("[BOC] queued reader controls recovery failed", { reason, error });
      })
      .finally(() => {
        state.reader.readingControlsRecoveryInFlight = false;
      });
  }, delayMs);
}

export function setReaderPlayerControlsVisible(visible, playerHost = state.reader.readingPlayerHost) {
  if (!state.reader.readingNativePageMode || !playerHost) {
    return;
  }

  const controlRoot = getReaderControlsRoot(playerHost);
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
    if (playerHost.classList.contains("bpx-state-no-cursor")) {
      playerHost.classList.remove("bpx-state-no-cursor");
      playerHost.setAttribute("data-boc-reader-no-cursor-cleared", "1");
    }
    return;
  }

  if (playerHost.getAttribute("data-boc-reader-no-cursor-cleared") === "1") {
    playerHost.classList.add("bpx-state-no-cursor");
    playerHost.removeAttribute("data-boc-reader-no-cursor-cleared");
  }
}

export function scheduleReaderPlayerControlsHide(playerHost = state.reader.readingControlsHoverHost || state.reader.readingPlayerHost) {
  if (state.reader.readingControlsHideTimer) {
    window.clearTimeout(state.reader.readingControlsHideTimer);
  }
  state.reader.readingControlsHideTimer = window.setTimeout(() => {
    state.reader.readingControlsHideTimer = 0;
    if (!state.reader.readingViewOpen) {
      return;
    }
    setReaderPlayerControlsVisible(false, playerHost);
  }, 1200);
}

export function bindReaderPlayerControlsHover(playerHost = state.reader.readingPlayerHost) {
  if (!state.reader.readingNativePageMode || !isWatchlaterPage() || !playerHost) {
    return;
  }

  if (state.reader.readingControlsHoverHost && state.reader.readingControlsHoverHost !== playerHost) {
    unbindReaderPlayerControlsHover();
  }
  if (playerHost.__bocReaderControlsHoverBound) {
    state.reader.readingControlsHoverHost = playerHost;
    return;
  }

  const showControls = () => {
    if (!state.reader.readingViewOpen) {
      return;
    }
    setReaderPlayerControlsVisible(true, playerHost);
    scheduleReaderPlayerControlsHide(playerHost);
  };
  const hideControls = () => {
    if (state.reader.readingControlsHideTimer) {
      window.clearTimeout(state.reader.readingControlsHideTimer);
      state.reader.readingControlsHideTimer = 0;
    }
    setReaderPlayerControlsVisible(false, playerHost);
  };

  playerHost.addEventListener("mouseenter", showControls, true);
  playerHost.addEventListener("mousemove", showControls, true);
  playerHost.addEventListener("mouseleave", hideControls, true);
  playerHost.__bocReaderControlsHoverBound = { showControls, hideControls };
  state.reader.readingControlsHoverHost = playerHost;
}

export function unbindReaderPlayerControlsHover() {
  const playerHost = state.reader.readingControlsHoverHost;
  if (state.reader.readingControlsHideTimer) {
    window.clearTimeout(state.reader.readingControlsHideTimer);
    state.reader.readingControlsHideTimer = 0;
  }
  if (!playerHost?.__bocReaderControlsHoverBound) {
    state.reader.readingControlsHoverHost = null;
    return;
  }

  const { showControls, hideControls } = playerHost.__bocReaderControlsHoverBound;
  playerHost.removeEventListener("mouseenter", showControls, true);
  playerHost.removeEventListener("mousemove", showControls, true);
  playerHost.removeEventListener("mouseleave", hideControls, true);
  delete playerHost.__bocReaderControlsHoverBound;
  setReaderPlayerControlsVisible(false, playerHost);
  state.reader.readingControlsHoverHost = null;
}

export function setReaderHeaderActionsVisible(visible) {
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

export function scheduleReaderHeaderActionsHide(delayMs = 10000) {
  if (state.reader.readingHeaderHideTimer) {
    window.clearTimeout(state.reader.readingHeaderHideTimer);
    state.reader.readingHeaderHideTimer = 0;
  }
  state.reader.readingHeaderHideTimer = window.setTimeout(() => {
    state.reader.readingHeaderHideTimer = 0;
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
    state.reader.readingHeaderHoverHost = header || null;
    return;
  }

  const showActions = () => {
    if (!state.reader.readingViewOpen) {
      return;
    }
    if (state.reader.readingHeaderHideTimer) {
      window.clearTimeout(state.reader.readingHeaderHideTimer);
      state.reader.readingHeaderHideTimer = 0;
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
  state.reader.readingHeaderHoverHost = header;
  setReaderHeaderActionsVisible(true);
  scheduleReaderHeaderActionsHide();
}

export function unbindReaderHeaderActionsHover() {
  const header = state.reader.readingHeaderHoverHost;
  if (state.reader.readingHeaderHideTimer) {
    window.clearTimeout(state.reader.readingHeaderHideTimer);
    state.reader.readingHeaderHideTimer = 0;
  }
  if (!header?.__bocReaderHeaderHoverBound) {
    state.reader.readingHeaderHoverHost = null;
    return;
  }
  const { showActions, hideActionsLater } = header.__bocReaderHeaderHoverBound;
  header.removeEventListener("mouseenter", showActions, true);
  header.removeEventListener("mouseleave", hideActionsLater, true);
  delete header.__bocReaderHeaderHoverBound;
  state.reader.readingHeaderHoverHost = null;
  setReaderHeaderActionsVisible(true);
}

export function normalizeReaderPlayerContainer(playerHost = state.reader.readingPlayerHost) {
  if (!playerHost) {
    return;
  }

  restoreReaderPlayerContainer();
  const adjusted = [];
  let current = playerHost;
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
      if (current !== playerHost) {
        current.style.removeProperty("width");
        current.style.removeProperty("height");
      }
    }

    current = current.parentElement;
    depth += 1;
  }

  state.reader.readingPlayerAdjustedNodes = adjusted;
}

export function restoreReaderPlayerContainer() {
  const adjusted = Array.isArray(state.reader.readingPlayerAdjustedNodes) ? state.reader.readingPlayerAdjustedNodes : [];
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
  state.reader.readingPlayerAdjustedNodes = [];
}
