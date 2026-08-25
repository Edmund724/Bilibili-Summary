// Page-frame helpers for the reader: layout sizing, page-state guards,
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

export function moveRootToReaderContentHost() {
  return;
}

export function restoreRootMount() {
  return;
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

export function hasExplicitPageParam(url) {
  try {
    return new URL(url).searchParams.has("p");
  } catch {
    return false;
  }
}

export function extractOid(url) {
  try {
    return String(new URL(url).searchParams.get("oid") || "").trim();
  } catch {
    return "";
  }
}

export function pickPageFromPages(pages, pageIndex) {
  const safePageIndex = Number(pageIndex) > 0 ? Number(pageIndex) : 1;
  const safePages = Array.isArray(pages) ? pages : [];
  const pageByIndex = safePages[safePageIndex - 1];
  if (pageByIndex?.cid) {
    return pageByIndex;
  }

  const pageByNo = safePages.find((item) => Number(item.page) === safePageIndex);
  if (pageByNo?.cid) {
    return pageByNo;
  }

  return null;
}

export function pickCidFromPages(pages, pageIndex, fallbackCid = "") {
  const matchedPage = pickPageFromPages(pages, pageIndex);
  if (matchedPage?.cid) {
    return String(matchedPage.cid);
  }

  const safePages = Array.isArray(pages) ? pages : [];
  if (safePages[0]?.cid) {
    return String(safePages[0].cid);
  }

  if (fallbackCid) {
    return String(fallbackCid);
  }

  throw new Error("没有找到当前分P的 CID。");
}

export function pickPageIndexFromOid(pages, oid, options = {}) {
  const safeOid = String(oid || "").trim();
  if (!safeOid) {
    return 0;
  }

  const safePages = Array.isArray(pages) ? pages : [];
  const pageByCid = safePages.find((item) => String(item?.cid || "") === safeOid);
  if (pageByCid?.page) {
    return Number(pageByCid.page) || 0;
  }

  // watchlater 等页面的 oid 通常是 aid 而非 cid；
  // 若 oid 与视频 aid 一致，尝试从页面状态读取当前播放分P。
  const safeAid = String(options?.aid || "").trim();
  if (safeAid && safeOid === safeAid) {
    return readCurrentPageFromPageState(safePages, options?.defaultCid);
  }

  return 0;
}

export function readCurrentPageFromPageState(pages, fallbackCid = "") {
  const safePages = Array.isArray(pages) ? pages : [];

  // 1. 优先使用 URL 中的 ?p= 参数
  try {
    const pageFromUrl = Number(new URL(location.href).searchParams.get("p") || "0");
    if (Number.isFinite(pageFromUrl) && pageFromUrl > 0) {
      return pageFromUrl;
    }
  } catch {
    // ignore
  }

  // 2. 其次尝试页面全局状态（watchlater 等页面通常携带播放器状态）
  try {
    const rootState = window?.__INITIAL_STATE__ || {};
    const playerState = rootState.player || window?.__PLAYER_STATE__ || window?.__BILI_PLAYER__;
    if (playerState) {
      const candidates = [
        playerState.page,
        playerState.pageIndex,
        playerState.currentPage,
        playerState.data?.page,
        playerState.data?.pageIndex
      ];
      for (const value of candidates) {
        const pageFromState = Number(value || "0");
        if (Number.isFinite(pageFromState) && pageFromState > 0) {
          return pageFromState;
        }
      }
    }

    const videoData = rootState.videoData || rootState.playletInfo;
    if (videoData) {
      const pageFromVideoData = Number(
        videoData.page || videoData.pageIndex || videoData.currentPage || videoData.data?.page || "0"
      );
      if (Number.isFinite(pageFromVideoData) && pageFromVideoData > 0) {
        return pageFromVideoData;
      }
      const cidFromVideoData = String(videoData.cid || videoData.data?.cid || "");
      if (cidFromVideoData) {
        const matched = safePages.find((item) => String(item?.cid || "") === cidFromVideoData);
        if (matched?.page) {
          return Number(matched.page) || 0;
        }
      }
    }
  } catch {
    // ignore
  }

  // 3. 从播放器 DOM / video currentSrc / iframe src 读取当前分P
  const pageFromDom = readPageFromPlayerDom(safePages);
  if (Number.isFinite(pageFromDom) && pageFromDom > 0) {
    return pageFromDom;
  }

  // 4. 最后按 defaultCid / 首页索引兜底
  if (fallbackCid) {
    const pageByCid = safePages.find((item) => String(item?.cid || "") === String(fallbackCid));
    if (pageByCid?.page) {
      return Number(pageByCid.page) || 1;
    }
  }

  return safePages.length > 0 ? 1 : 0;
}

export function readPageFromPlayerDom(pages) {
  const safePages = Array.isArray(pages) ? pages : [];

  // 3a. 从 video currentSrc / src 提取 cid / page
  try {
    const video = getRuntimeVideoElement();
    if (video) {
      const src = String(video.currentSrc || video.src || "").trim();
      if (src) {
        const cidMatch = src.match(/[?&]cid=(\d+)/i);
        if (cidMatch) {
          const matched = safePages.find((item) => String(item?.cid || "") === cidMatch[1]);
          if (matched?.page) {
            return Number(matched.page) || 0;
          }
        }
        const pageMatch = src.match(/[?&]page=(\d+)/i);
        if (pageMatch) {
          const page = Number(pageMatch[1]);
          if (Number.isFinite(page) && page > 0) {
            return page;
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // 3b. 从播放器 iframe src 提取 page / cid
  try {
    const iframe =
      document.querySelector(
        "#bilibili-player iframe, .bpx-player-container iframe, iframe[src*='player.bilibili.com']"
      ) ||
      document.querySelector("iframe[src*='bilibili.com/player']");
    if (iframe?.src) {
      const pageMatch = iframe.src.match(/[?&]page=(\d+)/i);
      if (pageMatch) {
        const page = Number(pageMatch[1]);
        if (Number.isFinite(page) && page > 0) {
          return page;
        }
      }
      const cidMatch = iframe.src.match(/[?&]cid=(\d+)/i);
      if (cidMatch) {
        const matched = safePages.find((item) => String(item?.cid || "") === cidMatch[1]);
        if (matched?.page) {
          return Number(matched.page) || 0;
        }
      }
    }
  } catch {
    // ignore
  }

  // 3c. 从播放器控制栏/DOM 文本中推断当前分P
  try {
    const playerRoot =
      document.querySelector(".bpx-player-control-wrap") ||
      document.querySelector("#bilibili-player .bpx-player-control-wrap") ||
      document.querySelector(".player-wrap");
    if (playerRoot) {
      const text = playerRoot.textContent || "";
      // 匹配类似 "P2"、"第2集"、"第02话" 等文本
      const pageMatch = text.match(/(?:^|\s|第)\s*(\d+)\s*(?:集|话|P|part)/i);
      if (pageMatch) {
        const page = Number(pageMatch[1]);
        if (Number.isFinite(page) && page > 0) {
          return page;
        }
      }
    }
  } catch {
    // ignore
  }

  return 0;
}

export function pickDurationFromPages(pages, pageIndex, fallbackDuration = 0) {
  const matchedPage = pickPageFromPages(pages, pageIndex);
  if (Number(matchedPage?.duration) > 0) {
    return Number(matchedPage.duration);
  }

  const safePages = Array.isArray(pages) ? pages : [];
  if (Number(safePages[0]?.duration) > 0) {
    return Number(safePages[0].duration);
  }

  return Number(fallbackDuration || 0) || 0;
}
