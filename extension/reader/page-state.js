// Reader 页面状态守卫（候选02 分层惰性：自 page-frame.js 迁出的常驻微模块）。
//
// 启动必需的三件套：clearReaderModePageState（清阅读模式页面标记）、
// enforceNormalPageStateIfNeeded（非阅读页状态收敛）、bindNormalPageStateGuard
// （MutationObserver 守卫）。它们全是「DOM 属性读写 + observer 注册」的轻操作，
// 依赖只有 core/state.js 与 bilibili/video-id-shared.js（isReaderMode）——均为
// 常驻轻模块，不触碰 LAYOUT/SYNC/LIFECYCLE 的任何重符号，因此整体下沉为常驻，
// content.js init 无需为它们动态装载 reader 域。
// 函数体逐字搬自 page-frame.js 对应分节，行为零变化。
//
// 候选02：原实现会把 observer 经 page-context.setNormalPageStateObserver 注册
// 进 page-context.js 的模块闭包——但该 seam 自迁移后无任何读取方（page-context
// 内部的 getter 从未被调用），属死注册；去掉这条静态边后 page-context（~3.4KB，
// 仅 fetcher 的分P解析在用）得以随总结链切进动态 chunk。observer 的回调在本
// 模块内直接收敛页面状态，行为不受影响。
import { state, uiState } from "../core/state.js";
import { isReaderMode } from "../bilibili/video-id-shared.js";

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

function shouldForceNormalPageState(url = location.href) {
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
  enforceNormalPageStateIfNeeded();
}
