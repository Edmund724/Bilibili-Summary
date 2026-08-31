// Reader 页面状态守卫（候选02 分层惰性：自 page-frame.js 迁出的常驻微模块）。
//
// 启动必需的三件套：clearReaderModePageState（清阅读模式页面标记）、
// enforceNormalPageStateIfNeeded（非阅读页状态收敛）、bindNormalPageStateGuard
// （MutationObserver 守卫）。它们全是「DOM 属性读写 + observer 注册」的轻操作，
// 依赖只有 core/state.js、bilibili/video-id-shared.js（isReaderMode）与
// ./presentation-fields.js（纯常量表，候选06 单一事实源）——均为常驻轻模块，
// 不触碰 LAYOUT/SYNC/LIFECYCLE 的任何重符号，因此整体下沉为常驻，
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
// 候选06：清理清单与 observer 的 attributeFilter 均从呈现属性表派生
//（单一事实源 presentation-fields.js），本文件不再手抄字段清单。
import { READER_GUARD_CLEAR_ATTRS, READER_GUARD_FILTER } from "./presentation-fields.js";

export function clearReaderModePageState() {
  // 修正走样：旧手抄的 body 清单只有 mode/line-height/reading-active 三项，
  // 与 html 全集不对称且无 CSS 依据（阅读表里 body 与 html 的选择器面
  // 完全一致），残留属脏状态；按正确超集对齐全集（见 presentation-fields.js
  // 头注的清单漂移考古）。
  for (const attr of READER_GUARD_CLEAR_ATTRS.html) {
    document.documentElement.removeAttribute(attr);
  }
  for (const attr of READER_GUARD_CLEAR_ATTRS.body) {
    document.body.removeAttribute(attr);
  }
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
  // 候选06：filter 从表派生（watchedByGuard 标志）。body 侧旧手抄只有 3 项
  //（走样，同 clearReaderModePageState），现与 html 对齐为全集 + reading-active。
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: READER_GUARD_FILTER.html
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: READER_GUARD_FILTER.body
  });
  enforceNormalPageStateIfNeeded();
}
