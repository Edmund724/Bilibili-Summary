// Reader LAYOUT 层 · page-frame 域（自 reader-impl.js 机械拆分）。
//
// 本文件拥有页面框架：DOM 焦点（applyReaderPageFocus）/剪枝/内联宿主
// （moveReadingMainInline）与阅读模式页面状态守卫（bindNormalPageStateGuard），
// 以及 reader 私有 DOM id 表（ids，两域与 facade 共用）。分节函数体逐字节
// 搬自原 reader-impl.js 的 page-frame 分节（原 :257-679），行为零变化。
// 播放器宿主（挂载/布局/控制条/观察器）在 ./player-host.js；两域互调一律走
// 显式模块导出：本文件导出 getReaderMainWidthLimit/dismissReaderMiniPlayer，
// player-host.js 导出 getPlayerHost/layoutReaderPlayerHost/
// updateReadingTranscriptTailSpacer。page-frame ⇄ player-host 为 LAYOUT 层
// 内部的相互依赖（全部为函数互调，运行时经 ESM live binding 解析）。
//
// SYNC 域调用经 ./sync-adapter.js 反环叶子（callSync）；./sync.js 与
// ./lifecycle.js 依赖本层，本文件不得反向 import 它们。
//
// 候选02 分层惰性：页面状态守卫三件套（clearReaderModePageState /
// enforceNormalPageStateIfNeeded / bindNormalPageStateGuard）、id 表、
// isReaderViewOpen、applyInlineHostPresentation 已迁往常驻微模块
//（./page-state.js、./ids.js、./view-state.js、./presentation.js）。本文件
// 经 re-export 保持域内旧 import 路径与 facade 转发不变。
import { state } from "../core/state.js";
import { getReaderElement, isVisibleReaderControl } from "../shared/dom-utils.js";
import { isReaderMode } from "../bilibili/video-id-shared.js";
import { findReaderPlayerHost, getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { isProgrammaticScrolling } from "./scroll-state.js";
// 跨域模块接口：播放器宿主状态与布局函数（player-host.js 导出）。
import { getPlayerHost, layoutReaderPlayerHost, updateReadingTranscriptTailSpacer } from "./player-host.js";
import { callSync } from "./sync-adapter.js";
import { applyInlineHostPresentation } from "./presentation.js";
// 候选02 分层惰性：id 表已迁往 ./ids.js（常驻微模块），本文件内部仍大量按 id
// 读写 reader DOM，经该 import 取用（此前为本地 const 定义，迁移后补上）。
import { ids } from "./ids.js";

// ===== 常驻微模块 re-export（域内旧路径兼容 + facade 转发） =====

export { ids } from "./ids.js";
export { isReaderViewOpen } from "./view-state.js";
export {
  clearReaderModePageState,
  enforceNormalPageStateIfNeeded,
  bindNormalPageStateGuard
} from "./page-state.js";
export { applyInlineHostPresentation } from "./presentation.js";

// ===== page-frame 域闭包状态（自 reader-impl.js 头部迁入） =====
//
// mainOriginalParent / mainOriginalNextSibling 仅本域读写
//（moveReadingMainInline 记录、restoreReadingMainInline 恢复并清空）。
let mainOriginalParent = null;     // readingMainOriginalParent
let mainOriginalNextSibling = null;// readingMainOriginalNextSibling

// Reader 私有 DOM id 表已迁往 ./ids.js（常驻微模块，供 UI 模板与总结链共享），
// isReaderViewOpen 迁往 ./view-state.js，页面状态守卫迁往 ./page-state.js，
// applyInlineHostPresentation 迁往 ./presentation.js——见文件头的 re-export。
// getReaderElement / isVisibleReaderControl live in ../shared/dom-utils.js:
// reading reader DOM ids is a reader-internal concern, and keeping that helper
// out of core/runtime.js keeps the reader modules free of a static import back
// through subtitle/fetcher.js (same rationale as the former local copy here).

// ===== page-frame.js (page frame helpers) =====
//
// Multi-page (分P) resolution lives in the pure page-context seam (issue 02);
// consumers import ./page-context.js directly (established seam, see facade).

function getReaderContentMaxPx() {
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

function getReaderPagePaddingPx() {
  return Math.min(32, Math.max(16, window.innerWidth * 0.028));
}

export function getReaderMainWidthLimit() {
  return Math.max(320, Math.min(getReaderContentMaxPx(), window.innerWidth - getReaderPagePaddingPx() * 2));
}

export function cleanupReaderFloatingArtifacts(playerHostArg = getPlayerHost()) {
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
    getPlayerHost()?.closest?.("#playerWrap") ||
    getPlayerHost();
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

function pruneReaderNonKeepBranches(node) {
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

function hideReaderNoiseNodes(keepRoots = []) {
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

function markReaderKeepSubtree(node) {
  if (!node) {
    return;
  }
  node.setAttribute("data-boc-reader-keep", "1");
  node.querySelectorAll("*").forEach((child) => {
    child.setAttribute("data-boc-reader-keep", "1");
  });
}

function markReaderKeepPath(node) {
  let current = node;
  while (current && current !== document.body) {
    current.setAttribute("data-boc-reader-keep", "1");
    current = current.parentElement;
  }
  document.body.setAttribute("data-boc-reader-keep", "1");
}

function findReaderTitleContainer() {
  const title =
    document.querySelector("h1.video-title") ||
    document.querySelector("h1") ||
    document.querySelector("[data-title]");
  if (!title) {
    return null;
  }
  return title;
}

export function dismissReaderMiniPlayer(playerHostArg = getPlayerHost()) {
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
  const playerHostNode = getPlayerHost() || findReaderPlayerHost(getRuntimeVideoElement());
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
