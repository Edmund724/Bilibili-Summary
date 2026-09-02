// Reader 调试快照（自 lifecycle.js 迁出）。
// __BOC_READER_DEBUG_SNAPSHOT__ 全局函数的真身：采集阅读视图/播放器宿主链的
// getBoundingClientRect + getComputedStyle + data 属性，产出一份可序列化布局
// 快照，用于排查播放器宿主/面板布局走样。注册在 ./init-essentials.js（常驻
// 轻量），只在手动调用全局函数时经 ensureReaderDomain 装载 reader 域后转发；
// 对外经 reader/index.js 动态域入口转发本导出。
//
// 阶段 3（B 形态收尾）：原 player-host 的宿主访问器（getPlayerHost）与呈现
// 稳定性/浮动布局判定（isReaderPresentationStable/hasNativeReaderPlayerLayoutIssue）
// 随整页接管退役——readyStable/hasLayoutIssue 字段删除，宿主一律经探针
// findReaderPlayerHost 现查；player-reset 局部标记也随宿主复位逻辑一并删除。
//
// 依赖方向（无环）：core/state、bilibili 探针/URL 工具、reader/state.js 的 ids 表；
// 本模块不被 reader 域内任何实现模块 import。
import { state } from "../core/state.js";
import { cleanVideoUrl } from "../bilibili/video-id-shared.js";
import { findReaderPlayerHost, getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { ids } from "./state.js";

export function createReaderDebugSnapshot(label = "manual") {
  const pickNodeSnapshot = (selector: string) => {
    const node = document.querySelector(selector);
    if (!node) {
      return null;
    }
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return {
      selector,
      tag: node.tagName,
      id: node.id || "",
      className: typeof node.className === "string" ? node.className : "",
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      },
      style: {
        display: style.display,
        position: style.position,
        width: style.width,
        height: style.height,
        maxWidth: style.maxWidth,
        maxHeight: style.maxHeight,
        top: style.top,
        left: style.left,
        transform: style.transform,
        overflow: style.overflow,
        zIndex: style.zIndex
      },
      attrs: {
        readerKeep: node.getAttribute("data-boc-reader-keep"),
        readerHidden: node.getAttribute("data-boc-reader-hidden")
      }
    };
  };

  const playerHostNode = findReaderPlayerHost(getRuntimeVideoElement());
  const video = state.reader.readingVideoEl || getRuntimeVideoElement();
  const hostChain = [];
  let current = playerHostNode;
  let depth = 0;
  while (current && depth < 8) {
    const rect = current.getBoundingClientRect();
    const style = window.getComputedStyle(current);
    hostChain.push({
      tag: current.tagName,
      id: current.id || "",
      className: typeof current.className === "string" ? current.className : "",
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      },
      style: {
        position: style.position,
        width: style.width,
        height: style.height,
        top: style.top,
        left: style.left,
        transform: style.transform,
        overflow: style.overflow,
        zIndex: style.zIndex
      }
    });
    current = current.parentElement;
    depth += 1;
  }

  return {
    label: String(label || "manual"),
    url: cleanVideoUrl(),
    readerMode: document.documentElement.getAttribute("data-boc-reader-mode"),
    readingActive: document.body.getAttribute("data-boc-reading-active"),
    readingViewOpen: state.reader.readingViewOpen,
    readingNativePageMode: state.reader.readingNativePageMode,
    readingViewReady: state.reader.readingViewReady,
    hasRoot: Boolean(document.getElementById(ids.root)),
    hasReadingView: Boolean(document.getElementById(ids.readingView)),
    playerHost: playerHostNode
      ? {
          tag: playerHostNode.tagName,
          id: playerHostNode.id || "",
          className: typeof playerHostNode.className === "string" ? playerHostNode.className : ""
        }
      : null,
    video: video
      ? {
          currentTime: Number(video.currentTime || 0) || 0,
          paused: Boolean(video.paused),
          videoWidth: Number(video.videoWidth || 0) || 0,
          videoHeight: Number(video.videoHeight || 0) || 0
        }
      : null,
    nodes: [
      "#app",
      "#playerWrap",
      ".player-wrap",
      "#bilibili-player",
      ".bpx-player-container",
      ".bpx-player-video-area",
      ".bpx-player-primary-area",
      "#boc-reading-digest-panel",
      "#boc-reading-view"
    ]
      .map((selector) => pickNodeSnapshot(selector))
      .filter(Boolean),
    hostChain
  };
}
