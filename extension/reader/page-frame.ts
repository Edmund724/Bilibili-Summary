// Reader LAYOUT 层 · page-frame 域（自 reader-impl.js 机械拆分）。
//
// 本文件拥有页面框架：DOM 焦点（applyReaderPageFocus）/剪枝/内联宿主
// （moveReadingMainInline）与阅读模式页面状态守卫（bindNormalPageStateGuard），
// 以及 reader 私有 DOM id 表（ids，两域与 facade 共用）。分节函数体逐字节
// 搬自原 reader-impl.js 的 page-frame 分节（原 :257-679），行为零变化。
// 播放器宿主（挂载/布局/控制条/观察器）在 ./player-host.js；两域互调一律走
// 显式模块导出：本文件导出 getReaderMainWidthLimit/dismissReaderMiniPlayer，
// player-host.js 导出 getPlayerHost/layoutReaderPlayerHost。
// page-frame ⇄ player-host 为 LAYOUT 层内部的相互依赖（全部为函数互调，运行时
// 经 ESM live binding 解析）。转写列表尾部留白（updateReadingTranscriptTailSpacer）
// 候选06 自 player-host 迁入本文件：它读取的 boc-reading-inline-host 正是本域
// moveReadingMainInline 创建的内联宿主，属页面框架的滚动留白。
//
// SYNC 域调用经 ./ports.js 显式端口叶子（readerPorts）；./sync.js 与
// ./lifecycle.js 依赖本层，本文件不得反向 import 它们。
//
// 候选02 分层惰性：页面状态守卫三件套（clearReaderModePageState /
// enforceNormalPageStateIfNeeded / bindNormalPageStateGuard）、id 表、
// 候选04：isReaderViewOpen/ids/scroll-state/page-state 已收进 ./state.js。
// 本文件继续经 re-export 保持域内旧 import 路径不变，但真实来源统一为 state.js。
import { state } from "../core/state.js";
import { getReaderElement, isVisibleReaderControl } from "../shared/dom-utils.js";
import { isReaderMode } from "../bilibili/video-id-shared.js";
import { findReaderPlayerHost, getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { isProgrammaticScrolling } from "./state.js";
// 跨域模块接口：播放器宿主状态与布局函数（player-host.js 导出）。
import { getPlayerHost, layoutReaderPlayerHost } from "./player-host.js";
// 候选06：SYNC 域回调经 reader 域唯一显式端口（ports.js 叶子，缺失即抛错）。
import { readerPorts } from "./ports.js";
import { applyInlineHostPresentation } from "./presentation.js";
// 候选02 分层惰性：id 表已迁往 ./state.js（常驻微模块），本文件内部仍大量按 id
// 读写 reader DOM，经该 import 取用（此前为本地 const 定义，迁移后补上）。
import { ids } from "./state.js";

// ===== 状态微模块 re-export（域内旧路径兼容） =====

export { ids, isReaderViewOpen } from "./state.js";
export {
  clearReaderModePageState,
  enforceNormalPageStateIfNeeded,
  bindNormalPageStateGuard
} from "./state.js";
export { applyInlineHostPresentation } from "./presentation.js";

// ===== page-frame 域闭包状态（自 reader-impl.js 头部迁入） =====
//
// mainOriginalParent / mainOriginalNextSibling 仅本域读写
//（moveReadingMainInline 记录、restoreReadingMainInline 恢复并清空）。
let mainOriginalParent: Node | null = null;     // readingMainOriginalParent
let mainOriginalNextSibling: Node | null = null;// readingMainOriginalNextSibling

// Reader 私有 DOM id 表 / isReaderViewOpen / 页面状态守卫已迁往 ./state.js
//（候选04 结构归并），applyInlineHostPresentation 留在 ./presentation.js——
// 见文件头的 re-export。
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
  const keepRoots = [root, playerHostNode, titleNode].filter((n): n is Element => Boolean(n));

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
      readerPorts.noteManualReaderInteraction();
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

// 转写列表尾部留白（候选06 自 player-host.js 迁入）：高度取内联宿主
//（boc-reading-inline-host，由本域 moveReadingMainInline 创建）或转写列表的
// 可视高度与视口的较大者——留白是内联滚动框架的一部分，故归页面框架域。
// 消费方：player-host.layoutReaderPlayerHost（native/slot 两分支收尾）、本域
// moveReadingMainInline、lifecycle 的分批追加/整段渲染，均经合法静态边取用。
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

function pruneReaderNonKeepBranches(node: Element) {
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

function hideReaderNoiseNodes(keepRoots: Element[] = []) {
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

function markReaderKeepSubtree(node: Element) {
  if (!node) {
    return;
  }
  node.setAttribute("data-boc-reader-keep", "1");
  node.querySelectorAll("*").forEach((child) => {
    child.setAttribute("data-boc-reader-keep", "1");
  });
}

function markReaderKeepPath(node: Element) {
  let current: Element | null = node;
  while (current && current !== document.body) {
    current.setAttribute("data-boc-reader-keep", "1");
    current = current.parentElement;
  }
  document.body.setAttribute("data-boc-reader-keep", "1");
}

function findReaderTitleContainer(): Element | null {
  const title =
    document.querySelector("h1.video-title") ||
    document.querySelector("h1") ||
    document.querySelector("[data-title]");
  if (!title) {
    return null;
  }
  return title;
}

export function dismissReaderMiniPlayer(playerHostArg: Element | null = getPlayerHost()) {
  const explicitClose = Array.from(document.querySelectorAll(".bpx-player-mini-close")).find(isVisibleReaderControl);
  if (explicitClose) {
    (explicitClose as HTMLElement).click();
    return true;
  }

  if (!playerHostArg) {
    return false;
  }

  const computed = window.getComputedStyle(playerHostArg);
  const fixedLike = computed.position === "fixed" || /mini|picture|float|fixed-player/i.test((playerHostArg as HTMLElement).className || "");
  if (!fixedLike) {
    return false;
  }

  const roots = Array.from(
    new Set(
      [
        playerHostArg,
        playerHostArg.parentElement,
        playerHostArg.closest("#playerWrap"),
        playerHostArg.closest("#bilibili-player")
      ].filter((n): n is Element => Boolean(n))
    )
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
        (button as HTMLElement).click();
        return true;
      }
    }
  }

  const playerRect = playerHostArg.getBoundingClientRect();
  for (const root of roots) {
    const fallback = Array.from(root.querySelectorAll("button, [role='button'], [tabindex], div, span"))
      .filter((node): node is Element => {
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
      (fallback as HTMLElement).click();
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
