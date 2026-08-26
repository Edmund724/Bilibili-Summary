// Page-frame helpers for the reader (implementation detail — see ./index.js facade):
// layout sizing, page-state guards,
// focus/keep-tree management, player host alignment, multi-page (p数) page
// resolution, and small DOM utilities used by reader.js.
import { state, uiState } from "../core/state.js";
import { isReaderMode } from "../bilibili/url-utils.js";
import { byId } from "../core/runtime.js";
import { findReaderPlayerHost, getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { isVisibleReaderControl } from "../ai/player-ai.js";
// Cross-reader-module imports point at modules that will land in later split
// steps; the build script and runtime bundle already tolerate them, and the
// symbols resolve through the shared single-scope bundle at runtime.
import { ids, updateReadingTranscriptTailSpacer } from "./shell.js";
import { noteManualReaderInteraction } from "./transcript-sync.js";
import { layoutReaderPlayerHost } from "./player-host.js";
// Multi-page (分P) resolution moved to the pure page-context seam (issue 02);
// re-exported here so existing importers keep working unchanged.
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
  state.normalPageStateObserver = observer;
  enforceNormalPageStateIfNeeded();
}

export function cleanupReaderFloatingArtifacts(playerHost = state.reader.readingPlayerHost) {
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
  }
  dismissReaderMiniPlayer(playerHost);
  const runtimeHost = findReaderPlayerHost(getRuntimeVideoElement());
  if (runtimeHost && runtimeHost !== playerHost) {
    dismissReaderMiniPlayer(runtimeHost);
  }
}

export function applyReaderPageFocus() {
  clearReaderPageFocus();

  const root = byId(ids.root);
  const video = getRuntimeVideoElement();
  const playerHost = findReaderPlayerHost(video);
  const titleNode = findReaderTitleContainer();
  const keepRoots = [root, playerHost, titleNode].filter(Boolean);

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

  if (!state.reader.readingMainOriginalParent) {
    state.reader.readingMainOriginalParent = readingMain.parentElement;
    state.reader.readingMainOriginalNextSibling = readingMain.nextSibling;
  }
  const playerWrap =
    document.getElementById("playerWrap") ||
    state.reader.readingPlayerHost?.closest?.("#playerWrap") ||
    state.reader.readingPlayerHost;
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
      if (Date.now() <= state.reader.readingProgrammaticScrollUntil) {
        return;
      }
      noteManualReaderInteraction();
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
  if (readingMain && state.reader.readingMainOriginalParent) {
    if (state.reader.readingMainOriginalNextSibling?.parentNode === state.reader.readingMainOriginalParent) {
      state.reader.readingMainOriginalParent.insertBefore(readingMain, state.reader.readingMainOriginalNextSibling);
    } else {
      state.reader.readingMainOriginalParent.appendChild(readingMain);
    }
  }
  inlineHost?.remove();
  state.reader.readingMainOriginalParent = null;
  state.reader.readingMainOriginalNextSibling = null;
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

export function findReaderContentHost(playerHost = state.reader.readingPlayerHost, titleNode = findReaderTitleContainer()) {
  if (!playerHost && !titleNode) {
    return null;
  }

  let current = titleNode || playerHost;
  while (current && current !== document.body) {
    const containsPlayer = playerHost ? current.contains(playerHost) : true;
    const containsTitle = titleNode ? current.contains(titleNode) : true;
    if (containsPlayer && containsTitle) {
      return current;
    }
    current = current.parentElement;
  }

  return playerHost?.parentElement || titleNode?.parentElement || null;
}

export function dismissReaderMiniPlayer(playerHost = state.reader.readingPlayerHost) {
  const explicitClose = Array.from(document.querySelectorAll(".bpx-player-mini-close")).find(isVisibleReaderControl);
  if (explicitClose) {
    explicitClose.click();
    return true;
  }

  if (!playerHost) {
    return false;
  }

  const computed = window.getComputedStyle(playerHost);
  const fixedLike = computed.position === "fixed" || /mini|picture|float|fixed-player/i.test(playerHost.className || "");
  if (!fixedLike) {
    return false;
  }

  const roots = Array.from(
    new Set([
      playerHost,
      playerHost.parentElement,
      playerHost.closest("#playerWrap"),
      playerHost.closest("#bilibili-player")
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

  const playerRect = playerHost.getBoundingClientRect();
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
  const playerHost = state.reader.readingPlayerHost || findReaderPlayerHost(getRuntimeVideoElement());
  const anchor = titleNode || playerHost;
  if (!anchor) {
    return;
  }

  const titleRect = titleNode?.getBoundingClientRect?.();
  const playerRect = playerHost?.getBoundingClientRect?.();
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
