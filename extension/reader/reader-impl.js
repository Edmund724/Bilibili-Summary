// Reader LAYOUT module (issue 06+).
//
// The base layer of the reader domain: page-frame (DOM focus/pruning/inline
// host) + player-host (player mount/controls/observer) + the shared module
// closure, ids table and accessor seam. The two modules that depend on it live
// in ./sync.js (SYNC) and ./lifecycle.js (LIFECYCLE); the dependency graph is
// acyclic (SYNC → LAYOUT, LIFECYCLE → SYNC + LAYOUT), so this module must not
// import either of them. All reader-domain bookkeeping that is private to the
// reader domain lives here as module-level closure variables instead of
// state.reader; the facade ./index.js re-exports the public functions.
//
// Settings/shared flags (readingViewOpen, readingTheme, ...) and fields that
// external modules read or write (readingVideoEl, readingDocumentClickBound)
// stay in state.reader.
import { state, uiState } from "../core/state.js";
import { logInfo, logWarn } from "../shared/logging.js";
import { getReaderElement, isVisibleReaderControl } from "../shared/dom-utils.js";
import { sleep } from "../core/shared-defaults.js";
import { isReaderMode, isWatchlaterPage } from "../bilibili/video-id-shared.js";
import { findReaderPlayerHost, getRuntimeVideoElement } from "../bilibili/video-probe.js";
import * as pageContext from "./page-context.js";

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
// programmaticScrollUntil stay declared here (base layer) and are written by
// sync.js through the exported set* accessors below; this module reads them
// exclusively through the exported is* accessors. Keeping the declarations
// here makes both modules share one closure scope with no cross-module state.
let playerHost = null;             // readingPlayerHost
let mainOriginalParent = null;     // readingMainOriginalParent
let mainOriginalNextSibling = null;// readingMainOriginalNextSibling
let playerAdjustedNodes = [];      // readingPlayerAdjustedNodes
let playerObserver = null;         // readingPlayerObserver
let playerMountTimer = 0;          // readingPlayerMountTimer
let playerRetryTimer = 0;          // readingPlayerRetryTimer
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
let manualScrollPauseUntil = 0;    // readingManualScrollPauseUntil
let programmaticScrollUntil = 0;   // readingProgrammaticScrollUntil

// Reader-domain DOM id table (shared by the LAYOUT and LIFECYCLE modules; the
// facade re-exports it for UI templates and a few external DOM operations).
export const ids = {
  root: "boc-root",
  panel: "boc-panel",
  status: "boc-status",
  meta: "boc-meta",
  subtitleSelect: "boc-subtitle-select",
  preview: "boc-preview",
  message: "boc-message",
  copyBtn: "boc-copy-btn",
  downloadBtn: "boc-download-btn",
  refreshBtn: "boc-refresh-btn",
  closeBtn: "boc-close-btn",
  settingsBtn: "boc-settings-btn",
  readingView: "boc-reading-view",
  readingPlayerSlot: "boc-reading-player-slot",
  readingStatus: "boc-reading-status",
  readingCloseBtn: "boc-reading-close-btn",
  readingRefreshBtn: "boc-reading-refresh-btn",
  readingAutoScroll: "boc-reading-autoscroll",
  readingTranscriptVisible: "boc-reading-transcript-visible",
  readingThemeSelect: "boc-reading-theme-select",
  readingSettingsBtn: "boc-reading-settings-btn",
  readingSettingsPanel: "boc-reading-settings-panel",
  readingFontScaleSelect: "boc-reading-font-scale-select",
  readingLetterSpacingSelect: "boc-reading-letter-spacing-select",
  readingLineHeightSelect: "boc-reading-line-height-select",
  readingContentWidthSelect: "boc-reading-content-width-select",
  readingChapterVisibilitySelect: "boc-reading-chapter-visibility-select",
  readingChapterVisible: "boc-reading-chapter-visible",
  readingSubtitleSelect: "boc-reading-subtitle-select",
  readingInfoSummary: "boc-reading-info-summary",
  readingInfoDescription: "boc-reading-info-description",
  readingDescriptionBtn: "boc-reading-description-btn",
  readingMeta: "boc-reading-meta",
  readingChapterList: "boc-reading-chapters",
  readingTranscriptList: "boc-reading-transcript",
  readingTranscriptTailSpacer: "boc-reading-tail-spacer"
};

// getReaderElement / isVisibleReaderControl live in ../shared/dom-utils.js:
// reading reader DOM ids is a reader-internal concern, and keeping that helper
// out of core/runtime.js keeps the reader modules free of a static import back
// through subtitle/fetcher.js (same rationale as the former local copy here).

// ===== reader facade accessors for closure state =====
//
// These accessors are the seam between the reader-impl (layout) closure and
// the sync/lifecycle modules that depend on it. The scroll-pause variables
// themselves moved to sync.js with the sync domain; the closure flags they
// read (videoEventsBound) stay here.

export function isReaderViewOpen() {
  return state.reader.readingViewOpen;
}

export function getPlayerHost() {
  return playerHost;
}

export function isManualScrollPaused() {
  return Date.now() < manualScrollPauseUntil;
}

export function resetManualScrollPause() {
  manualScrollPauseUntil = 0;
}

export function isProgrammaticScrolling() {
  return Date.now() <= programmaticScrollUntil;
}

// Writable accessors used by sync.js (its own closure variables):
export function setManualScrollPaused(until) {
  manualScrollPauseUntil = until;
}

export function setProgrammaticScrollUntil(until) {
  programmaticScrollUntil = until;
}

export function setVideoEventsBound(bound) {
  videoEventsBound = Boolean(bound);
}

export function isVideoEventsBound() {
  return videoEventsBound;
}

// Timer/flag accessors used by sync.js's stopReadingViewSync to clear the
// remaining layout timers it owns the lifecycle of.
export function clearLayoutTimersForSyncStop() {
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
  if (playerRetryTimer) {
    window.clearTimeout(playerRetryTimer);
    playerRetryTimer = 0;
  }
}

// Accessors for lifecycle.js (the shell segment moved there): it reads/writes
// the layout closure it shares via these, keeping the closure in the base
// layer (reader-impl.js) as the single source of truth.
export function getPlayerRetryTimer() {
  return playerRetryTimer;
}

export function setPlayerRetryTimer(timer) {
  playerRetryTimer = timer;
}

export function getControlsRecoveryTimer() {
  return controlsRecoveryTimer;
}

export function setControlsRecoveryTimer(timer) {
  controlsRecoveryTimer = timer;
}

export function setControlsRecoveryInFlight(inFlight) {
  controlsRecoveryInFlight = Boolean(inFlight);
}

// Seam to the sync domain: sync.js registers its function table here at module
// load (registerSyncAdapter), so the LAYOUT functions below (moveReadingMainInline's
// scroll handler, bindReadingViewVideo's sync handler) can call into the sync
// domain synchronously while reader-impl.js keeps a one-way dependency
// (reader-impl never imports sync.js, so no cycle can form).
let syncAdapter = null;

export function registerSyncAdapter(adapter) {
  syncAdapter = adapter || null;
}

function callSync(name, ...args) {
  return syncAdapter?.[name]?.(...args);
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
  spacer.style.height = `${spacerHeight}px`;
}

// Shared by the SYNC and LIFECYCLE domains (both render status text into the
// reading view); lives in the base layer so neither dependent module needs a
// back-edge to this one.
export function renderReadingStatus(text) {
  getReaderElement(ids.readingStatus).textContent = String(text || "");
}

export async function ensureReaderPlayerControlsRecovered(
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

// ===== page-frame.js (page frame helpers) =====
//
// Multi-page (分P) resolution lives in the pure page-context seam (issue 02);
// re-exported through the facade so existing importers keep working unchanged.

export {
  extractOid,
  hasExplicitPageParam,
  pickCidFromPages,
  pickDurationFromPages,
  pickPageFromPages,
  pickPageIndexFromOid,
  readCurrentPageFromPageState,
  readPageFromPlayerDom,
  resolvePageContext
} from "./page-context.js";

export function getReaderContentMaxPx() {
  if (state.reader.readingContentWidth === "compact") {
    return 680;
  }
  if (state.reader.readingContentWidth === "narrow") {
    return 760;
  }
  if (state.reader.readingContentWidth === "wide") {
    return 980;
  }
  if (state.reader.readingContentWidth === "full") {
    return 1100;
  }
  return 860;
}

export function getReaderPagePaddingPx() {
  return Math.min(32, Math.max(16, window.innerWidth * 0.028));
}

export function getReaderMainWidthLimit() {
  return Math.max(320, Math.min(getReaderContentMaxPx(), window.innerWidth - getReaderPagePaddingPx() * 2));
}

export function clearReaderModePageState() {
  document.documentElement.removeAttribute("data-boc-reader-mode");
  document.documentElement.removeAttribute("data-boc-reader-line-height");
  document.documentElement.removeAttribute("data-boc-reader-theme");
  document.documentElement.removeAttribute("data-boc-reader-font-scale");
  document.documentElement.removeAttribute("data-boc-reader-letter-spacing");
  document.documentElement.removeAttribute("data-boc-reader-content-width");
  document.documentElement.removeAttribute("data-boc-reader-chapter-visibility");
  document.documentElement.removeAttribute("data-boc-reader-has-chapters");
  document.documentElement.removeAttribute("data-boc-reader-transcript-visible");
  document.body.removeAttribute("data-boc-reader-mode");
  document.body.removeAttribute("data-boc-reader-line-height");
  document.body.removeAttribute("data-boc-reading-active");
}

export function shouldForceNormalPageState(url = location.href) {
  return !isReaderMode(url) && !state.reader.readingViewOpen;
}

export function enforceNormalPageStateIfNeeded(url = location.href) {
  if (!shouldForceNormalPageState(url)) {
    return;
  }
  clearReaderModePageState();
}

export function bindNormalPageStateGuard() {
  if (state.ui.normalPageStateGuardBound) {
    return;
  }
  uiState.setNormalPageStateGuardBound(true);

  const observer = new MutationObserver(() => {
    enforceNormalPageStateIfNeeded();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [
      "data-boc-reader-mode",
      "data-boc-reader-line-height",
      "data-boc-reader-theme",
      "data-boc-reader-font-scale",
      "data-boc-reader-letter-spacing",
      "data-boc-reader-content-width",
      "data-boc-reader-chapter-visibility",
      "data-boc-reader-has-chapters",
      "data-boc-reader-transcript-visible"
    ]
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["data-boc-reader-mode", "data-boc-reader-line-height", "data-boc-reading-active"]
  });
  pageContext.setNormalPageStateObserver(observer);
  enforceNormalPageStateIfNeeded();
}

export function cleanupReaderFloatingArtifacts(playerHostArg = playerHost) {
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
  }
  dismissReaderMiniPlayer(playerHostArg);
  const runtimeHost = findReaderPlayerHost(getRuntimeVideoElement());
  if (runtimeHost && runtimeHost !== playerHostArg) {
    dismissReaderMiniPlayer(runtimeHost);
  }
}

export function applyReaderPageFocus() {
  clearReaderPageFocus();

  const root = getReaderElement(ids.root);
  const video = getRuntimeVideoElement();
  const playerHostNode = findReaderPlayerHost(video);
  const titleNode = findReaderTitleContainer();
  const keepRoots = [root, playerHostNode, titleNode].filter(Boolean);

  keepRoots.forEach((node) => {
    markReaderKeepSubtree(node);
    markReaderKeepPath(node);
  });

  const keepNodes = Array.from(document.querySelectorAll("[data-boc-reader-keep='1']"));
  keepNodes.forEach((parent) => {
    Array.from(parent.children || []).forEach((child) => {
      if (child.id === ids.root) {
        return;
      }
      if (!child.hasAttribute("data-boc-reader-keep")) {
        child.setAttribute("data-boc-reader-hidden", "1");
      }
    });
  });

  pruneReaderNonKeepBranches(document.body);
  hideReaderNoiseNodes(keepRoots);
}

export function clearReaderPageFocus() {
  document.querySelectorAll("[data-boc-reader-keep]").forEach((node) => {
    node.removeAttribute("data-boc-reader-keep");
  });
  document.querySelectorAll("[data-boc-reader-hidden]").forEach((node) => {
    node.removeAttribute("data-boc-reader-hidden");
  });
}

export function applyInlineHostPresentation() {
  const inlineHost = document.getElementById("boc-reading-inline-host");
  if (!inlineHost) {
    return;
  }
  const leftContainer = document.querySelector(".left-container");
  const bgColor = leftContainer ? getComputedStyle(leftContainer).backgroundColor : "";
  if (state.reader.readingTranscriptVisible) {
    inlineHost.style.border = "";
    inlineHost.style.background = "";
    inlineHost.style.marginTop = "";
    inlineHost.style.boxShadow = "";
    inlineHost.style.borderRadius = "";
  } else {
    inlineHost.style.border = "none";
    inlineHost.style.background = bgColor;
    inlineHost.style.marginTop = "0";
    inlineHost.style.boxShadow = "none";
    inlineHost.style.borderRadius = "0";
  }
}

export function moveReadingMainInline() {
  if (!isReaderMode()) {
    return;
  }

  const readingMain = document.querySelector(".boc-reading-main");
  if (!readingMain) {
    return;
  }

  if (!mainOriginalParent) {
    mainOriginalParent = readingMain.parentElement;
    mainOriginalNextSibling = readingMain.nextSibling;
  }
  const playerWrap =
    document.getElementById("playerWrap") ||
    playerHost?.closest?.("#playerWrap") ||
    playerHost;
  const hostParent = playerWrap?.parentElement;
  if (!playerWrap || !hostParent) {
    return;
  }

  let inlineHost = document.getElementById("boc-reading-inline-host");
  if (!inlineHost) {
    inlineHost = document.createElement("div");
    inlineHost.id = "boc-reading-inline-host";
  }

  if (inlineHost.parentElement !== hostParent || inlineHost.previousElementSibling !== playerWrap) {
    playerWrap.insertAdjacentElement("afterend", inlineHost);
  }

  if (!inlineHost.dataset.bocScrollBound) {
    const handleInlineHostManualScroll = () => {
      if (isProgrammaticScrolling()) {
        return;
      }
      callSync("noteManualReaderInteraction");
    };
    inlineHost.addEventListener("scroll", handleInlineHostManualScroll);
    inlineHost.addEventListener("wheel", handleInlineHostManualScroll, { passive: true });
    inlineHost.dataset.bocScrollBound = "1";
  }

  if (readingMain.parentElement !== inlineHost) {
    inlineHost.appendChild(readingMain);
  }
  applyInlineHostPresentation();
  updateReadingTranscriptTailSpacer();
}

export function restoreReadingMainInline() {
  const readingMain = document.querySelector(".boc-reading-main");
  const inlineHost = document.getElementById("boc-reading-inline-host");
  if (readingMain && mainOriginalParent) {
    if (mainOriginalNextSibling?.parentNode === mainOriginalParent) {
      mainOriginalParent.insertBefore(readingMain, mainOriginalNextSibling);
    } else {
      mainOriginalParent.appendChild(readingMain);
    }
  }
  inlineHost?.remove();
  mainOriginalParent = null;
  mainOriginalNextSibling = null;
}

export function pruneReaderNonKeepBranches(node) {
  if (!node?.children?.length) {
    return;
  }

  Array.from(node.children).forEach((child) => {
    if (child.id === ids.root) {
      return;
    }
    const childHasKeep = child.hasAttribute("data-boc-reader-keep");
    const childContainsKeep = Boolean(child.querySelector?.("[data-boc-reader-keep='1']"));
    if (!childHasKeep && !childContainsKeep) {
      child.setAttribute("data-boc-reader-hidden", "1");
      return;
    }
    pruneReaderNonKeepBranches(child);
  });
}

export function hideReaderNoiseNodes(keepRoots = []) {
  const keepSet = new Set(keepRoots.filter(Boolean));
  const selectors = [
    ".strip-ad-inner",
    ".inside-wrp",
    ".inside-bg",
    ".hinter-msg",
    ".slide",
    ".cover.b-img",
    ".cover.b-img.sleepy",
    ".b-img.clickable",
    "[class*='activity']",
    "[class*='adcard']"
  ];

  document.querySelectorAll(selectors.join(",")).forEach((node) => {
    if (Array.from(keepSet).some((keepNode) => keepNode === node || node.contains(keepNode))) {
      return;
    }
    if (
      node.closest(
        "#bilibili-player, .bpx-player-container, .bpx-player-video-area, .bpx-player-primary-area, #boc-root, h1.video-title, .video-info-detail, .video-info-meta, .video-data"
      )
    ) {
      return;
    }
    node.setAttribute("data-boc-reader-hidden", "1");
    const card = node.closest("article, li, .card-box, .video-page-card-small, .video-page-special-card-small, .feed-card, .bili-video-card");
    if (card && !card.closest("#bilibili-player, .bpx-player-container, .bpx-player-video-area, .bpx-player-primary-area, #boc-root")) {
      card.setAttribute("data-boc-reader-hidden", "1");
    }
  });
}

export function markReaderKeepSubtree(node) {
  if (!node) {
    return;
  }
  node.setAttribute("data-boc-reader-keep", "1");
  node.querySelectorAll("*").forEach((child) => {
    child.setAttribute("data-boc-reader-keep", "1");
  });
}

export function markReaderKeepPath(node) {
  let current = node;
  while (current && current !== document.body) {
    current.setAttribute("data-boc-reader-keep", "1");
    current = current.parentElement;
  }
  document.body.setAttribute("data-boc-reader-keep", "1");
}

export function findReaderTitleContainer() {
  const title =
    document.querySelector("h1.video-title") ||
    document.querySelector("h1") ||
    document.querySelector("[data-title]");
  if (!title) {
    return null;
  }
  return title;
}

export function findReaderMetaContainer(titleNode = findReaderTitleContainer()) {
  const title = titleNode?.matches?.("h1, [data-title]") ? titleNode : titleNode?.querySelector?.("h1, [data-title]");
  if (!title) {
    return null;
  }

  const candidates = [
    title.nextElementSibling,
    title.parentElement?.nextElementSibling,
    title.parentElement,
    title.parentElement?.parentElement,
    ...(Array.from(title.parentElement?.parentElement?.children || []).slice(0, 6))
  ].filter(Boolean);

  for (const node of candidates) {
    if (node.matches?.(".video-data, .video-info-detail, .video-info-meta")) {
      return node;
    }
    if (node.querySelector?.(".view-text")) {
      return node;
    }
  }

  return null;
}

export function findReaderContentHost(playerHostArg = playerHost, titleNode = findReaderTitleContainer()) {
  if (!playerHostArg && !titleNode) {
    return null;
  }

  let current = titleNode || playerHostArg;
  while (current && current !== document.body) {
    const containsPlayer = playerHostArg ? current.contains(playerHostArg) : true;
    const containsTitle = titleNode ? current.contains(titleNode) : true;
    if (containsPlayer && containsTitle) {
      return current;
    }
    current = current.parentElement;
  }

  return playerHostArg?.parentElement || titleNode?.parentElement || null;
}

export function dismissReaderMiniPlayer(playerHostArg = playerHost) {
  const explicitClose = Array.from(document.querySelectorAll(".bpx-player-mini-close")).find(isVisibleReaderControl);
  if (explicitClose) {
    explicitClose.click();
    return true;
  }

  if (!playerHostArg) {
    return false;
  }

  const computed = window.getComputedStyle(playerHostArg);
  const fixedLike = computed.position === "fixed" || /mini|picture|float|fixed-player/i.test(playerHostArg.className || "");
  if (!fixedLike) {
    return false;
  }

  const roots = Array.from(
    new Set([
      playerHostArg,
      playerHostArg.parentElement,
      playerHostArg.closest("#playerWrap"),
      playerHostArg.closest("#bilibili-player")
    ].filter(Boolean))
  );

  const selectors = [
    ".bpx-player-mini-close",
    "[class*='mini'][class*='close']",
    "[class*='close']",
    "button[aria-label*='关闭']",
    "button[title*='关闭']",
    "[role='button'][aria-label*='关闭']",
    "[role='button'][title*='关闭']"
  ];

  for (const root of roots) {
    for (const selector of selectors) {
      const candidates = Array.from(root.querySelectorAll(selector)).filter(isVisibleReaderControl);
      const button = candidates.sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        return rectA.width * rectA.height - rectB.width * rectB.height;
      })[0];
      if (button) {
        button.click();
        return true;
      }
    }
  }

  const playerRect = playerHostArg.getBoundingClientRect();
  for (const root of roots) {
    const fallback = Array.from(root.querySelectorAll("button, [role='button'], [tabindex], div, span"))
      .filter((node) => {
        if (!isVisibleReaderControl(node)) {
          return false;
        }
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const nearTopRight =
          rect.width <= 48 &&
          rect.height <= 48 &&
          rect.left >= playerRect.right - 96 &&
          rect.top <= playerRect.top + 96;
        return nearTopRight && (style.cursor === "pointer" || node.hasAttribute("role") || node.hasAttribute("tabindex"));
      })
      .sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        return rectA.top + (playerRect.right - rectA.right) - (rectB.top + (playerRect.right - rectB.right));
      })[0];

    if (fallback) {
      fallback.click();
      return true;
    }
  }

  return false;
}

export function alignReaderViewportToPlayer() {
  if (!isReaderMode()) {
    return;
  }

  const titleNode = findReaderTitleContainer();
  const playerHostNode = playerHost || findReaderPlayerHost(getRuntimeVideoElement());
  const anchor = titleNode || playerHostNode;
  if (!anchor) {
    return;
  }

  const titleRect = titleNode?.getBoundingClientRect?.();
  const playerRect = playerHostNode?.getBoundingClientRect?.();
  const top = Math.min(
    titleRect?.top ?? Number.POSITIVE_INFINITY,
    playerRect?.top ?? Number.POSITIVE_INFINITY
  );
  if (!Number.isFinite(top)) {
    return;
  }

  const nextTop = Math.max(0, window.scrollY + top - 16);
  window.scrollTo({ top: nextTop, behavior: "auto" });
  window.setTimeout(() => {
    if (!state.reader.readingViewOpen || !isReaderMode()) {
      return;
    }
    window.scrollTo({ top: nextTop, behavior: "auto" });
    layoutReaderPlayerHost();
  }, 120);
}

// ===== player-host.js (player host lifecycle) =====

export function clearNativeReaderFloatingStyles(playerHostArg = playerHost) {
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

export function bindReaderLayout() {
  if (layoutBound) {
    return;
  }
  window.addEventListener("resize", layoutReaderPlayerHost);
  window.addEventListener("scroll", layoutReaderPlayerHost, { passive: true });
  document.addEventListener("fullscreenchange", layoutReaderPlayerHost);
  document.addEventListener("webkitfullscreenchange", layoutReaderPlayerHost);
  layoutBound = true;
}

export function unbindReaderLayout() {
  if (!layoutBound) {
    return;
  }
  window.removeEventListener("resize", layoutReaderPlayerHost);
  window.removeEventListener("scroll", layoutReaderPlayerHost);
  document.removeEventListener("fullscreenchange", layoutReaderPlayerHost);
  document.removeEventListener("webkitfullscreenchange", layoutReaderPlayerHost);
  layoutBound = false;
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

    clearNativeReaderFloatingStyles(playerHostNode);
    cleanupReaderPlayerHostNode(playerHostNode);
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
  playerHostNode.style.setProperty("position", "fixed", "important");
  playerHostNode.style.setProperty("left", `${Math.round(left)}px`, "important");
  playerHostNode.style.setProperty("top", `${Math.round(rect.top)}px`, "important");
  playerHostNode.style.setProperty("width", `${Math.round(targetWidth)}px`, "important");
  playerHostNode.style.setProperty("height", `${Math.round(targetHeight)}px`, "important");
  playerHostNode.style.setProperty("margin", "0", "important");
  playerHostNode.style.setProperty("z-index", "2147483647", "important");
  playerHostNode.style.setProperty("max-width", "none", "important");
  playerHostNode.style.setProperty("max-height", "none", "important");
  updateReadingTranscriptTailSpacer();
}

export function cleanupReaderPlayerHostNode(playerHostNode) {
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

export function getReaderControlsRoot(playerHostArg = playerHost) {
  return (
    playerHostArg?.closest?.("#playerWrap") ||
    playerHostArg?.closest?.("#bilibili-player") ||
    playerHostArg ||
    document.getElementById("playerWrap") ||
    document.getElementById("bilibili-player")
  );
}

export function getReaderPlayerControlsState(playerHostArg = playerHost) {
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

export function hasReaderPlayerControlsIssue(playerHostArg = playerHost) {
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

export function setReaderPlayerControlsVisible(visible, playerHostArg = playerHost) {
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

export function scheduleReaderPlayerControlsHide(playerHostArg = controlsHoverHost || playerHost) {
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

export function bindReaderPlayerControlsHover(playerHostArg = playerHost) {
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

export function normalizeReaderPlayerContainer(playerHostArg = playerHost) {
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

export function restoreReaderPlayerContainer() {
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

// ===== sync.js (playback sync) =====
//
// The sync domain (formerly the transcript-sync.js segment) lives in
// ./sync.js: startReadingViewSync, stopReadingViewSync, syncReadingViewPlayback,
// setActiveReadingItems, the scroll helpers, jumpReadingTarget, the click
// handlers, noteManualReaderInteraction and updateReaderFollowState. It
// depends on this module (LAYOUT) and must not be imported by it.
//
// reader-impl.js's sync reading of the scroll-pause deadlines is exposed as
// isManualScrollPaused() / isProgrammaticScrolling() above (see the "reader
// facade accessors" section); the variables themselves live in sync.js.
