// Reader LAYOUT 层 · digest-host 域（右栏 Digest 面板定位器）。
//
// 职责：计算右栏 rect 并写入 #boc-reading-view 的 CSS 变量
// --boc-digest-left/top/width/height。定位 CSS（reader-gate.css）消费这些变量，
// 本模块只负责「算 + 写」；浮层形态（降级 2）不写变量，改设
// data-boc-digest-float="1" 属性，让 CSS 回落到 reader.css 既有的
// 居中浮层基础样式。
//
// 贴栏形态的几何：面板吃掉「锚点左缘 → 视口右缘」整条右侧（B 站容器有最大
// 宽度，宽屏下锚点右缘与窗口右缘之间是大片死区），纵向钳进一屏（top 跟锚点
// 但不出视口，底缘贴视口底），内容超高由面板内部滚动消化。
// state.reader.readingContentWidth 档位（narrow 340 / standard 380 / wide 440）
// 作贴栏宽度下限：可填宽度不足档位宽时左缘向左延伸补足；float 档强制浮层。
// 步进器「面板宽度」档即本模块的消费方。
//
// player-host 整页接管退役后，本模块是 LAYOUT 层唯一的布局调度器
//（rAF 合帧 + 脏检查，思路源自旧 player-host 调度器）——digest-host
// 的写组是四个 CSS 变量与一个浮层属性，快照结构独立。
//
// 为什么不用 MutationObserver：弹幕每飘一条都是变更事件，白烧 CPU（见
// ui/digest-button.ts 头注）；SPA 换页换掉锚点节点的场景由 800ms 定时自查
// 覆盖，口径对齐 digest-button 的 REINJECT_INTERVAL_MS。

import { findReaderPlayerHost } from "../bilibili/video-probe.js";
import { state } from "../core/state.js";

// 右栏锚点候选（按优先级）。判定规则与覆盖页面见 closeDigestHost 上方注释；
// 全部只读 getBoundingClientRect，绝不往锚点里插节点。
const ANCHOR_SELECTORS = [
  ".right-container-inner",      // 新版 av/BV 播放页
  ".right-container",            // 新版播放页外层兜底
  ".playlist-container--right",  // 合集/列表态
  "#reco_list",                  // 旧版播放页
  "#viewbox_report",             // 旧版无推荐列表态
  ".up-info-container"           // 旧版无推荐列表态兜底
];

// 锚点有效硬下限：宽度过小视为隐藏副本/折叠态，跳过落到次优先候选。
const ANCHOR_MIN_WIDTH = 280;
// 贴栏宽度下限（readerContentWidth 语义 = 面板宽度档）：贴栏面板正常吃掉
// 锚点左缘到视口右缘的整条右侧，仅当可填宽度不足档位宽时左缘左移补足。
const PANEL_MIN_WIDTH = 300;
// narrow/standard/wide 三档的下限宽度；float 档不走贴栏，强制浮层形态。
export const PANEL_WIDTH_BY_MODE: Record<string, number> = {
  narrow: 340,
  standard: 380,
  wide: 440
};
const DEFAULT_PANEL_WIDTH = PANEL_WIDTH_BY_MODE.standard;

// 贴播放器右缘时的间距。贴栏纵向钳进一屏的最低高度保底（视口过矮时
// top 不再上移，宁可口子贴底）。
const PLAYER_GAP = 12;
const PINNED_MIN_HEIGHT = 240;
// 窄于该值不进贴栏形态（1000 是估计值，TODO: 手工验证时对照 B 站
// 右栏折叠断点校准后再定）。
const FLOAT_VIEWPORT_MIN_WIDTH = 1000;
// 定时自查间隔：SPA 换页把锚点节点换掉后靠它重锚（不用 MutationObserver，
// 理由见文件头注）。
const REANCHOR_INTERVAL_MS = 800;

// 当前档位的贴栏宽度下限：未知值（含 float）回落 standard。
function getPanelTargetWidth(): number {
  return PANEL_WIDTH_BY_MODE[state.reader.readingContentWidth] || DEFAULT_PANEL_WIDTH;
}

// float 档：无论锚点/视口是否合格，面板一律走浮层形态。
function isFloatMode(): boolean {
  return state.reader.readingContentWidth === "float";
}

const DIGEST_VAR_PREFIX = "--boc-digest-";
const DIGEST_VARS = ["left", "top", "width", "height"] as const;
const FLOAT_ATTR = "data-boc-digest-float";

// ===== 模块级生命周期状态（open/close 属主，幂等由 openDigestHost 守卫） =====

let reanchorTimer = 0;
let resizeObserver: ResizeObserver | null = null;
let observedAnchor: Element | null = null;
let layoutRafId = 0;
// 上次写组快照：与本次计算结果全同则整组跳写，避免每个滚动事件的无谓样式
// 失效（脏检查快照 lastSnapshot）。浮层分支记
// floating: true，与贴栏分支互斥，形态切换天然强制重写。
let lastSnapshot: { floating: boolean; values: string[] } | null = null;

// ===== 对外三个入口 =====

// 开始定位：立即算一次并写变量/浮层属性，然后挂上全部重算机制。重复调用
// 不叠加监听（幂等）。
export function openDigestHost(): void {
  if (reanchorTimer || resizeObserver) {
    return;
  }
  applyDigestRect();
  bindDigestHostListeners();
  reanchorTimer = window.setInterval(checkReanchor, REANCHOR_INTERVAL_MS);
}

// 拆除全部监听/定时器/observer，清除四个 CSS 变量与浮层属性。未 open 时
// 调用是安全的 no-op。
export function closeDigestHost(): void {
  if (reanchorTimer) {
    window.clearInterval(reanchorTimer);
    reanchorTimer = 0;
  }
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  observedAnchor = null;
  if (layoutRafId) {
    window.cancelAnimationFrame(layoutRafId);
    layoutRafId = 0;
  }
  window.removeEventListener("resize", scheduleDigestLayout);
  window.removeEventListener("scroll", scheduleDigestLayout);
  lastSnapshot = null;
  const readingView = document.getElementById("boc-reading-view");
  if (!readingView) {
    return;
  }
  for (const name of DIGEST_VARS) {
    readingView.style.removeProperty(DIGEST_VAR_PREFIX + name);
  }
  readingView.removeAttribute(FLOAT_ATTR);
}

// 手动重算一次（供未来消费方调用）：不走合帧，同步应用当前 rect。
export function refreshDigestHostRect(): void {
  applyDigestRect();
}

// ===== 重算机制 =====

function bindDigestHostListeners(): void {
  window.addEventListener("resize", scheduleDigestLayout);
  window.addEventListener("scroll", scheduleDigestLayout, { passive: true });
}

// 事件路径的合帧入口：置脏标志（rafId 非 0 即有未消费请求），一帧至多跑
// 一次「读→算→写」。
function scheduleDigestLayout(): void {
  if (layoutRafId) {
    return;
  }
  layoutRafId = window.requestAnimationFrame(runDigestLayout);
}

function runDigestLayout(): void {
  layoutRafId = 0;
  // 阅读视图节点已被移除（扩展根被清理/测试 teardown）时静默丢弃本帧：
  // 没有可写变量/属性的对象。
  if (!document.getElementById("boc-reading-view")) {
    return;
  }
  applyDigestRect();
}

// 800ms 自查：锚点节点被 B 站换掉（SPA 换页/重渲染）时重锚。判据是「当前
// 观察的锚点不再有效」（节点摘除或 rect 不再合格），此时若观察对象还挂在
// 旧节点上就先换观察对象再重算；观察对象仍有效则只需例行重算（滚动时
// fixed 定位要跟滚）。自查与事件路径共用 rAF 合帧。
function checkReanchor(): void {
  if (!reanchorTimer) {
    return;
  }
  const anchor = findDigestAnchor();
  if (anchor !== observedAnchor) {
    observeDigestAnchor(anchor);
  }
  scheduleDigestLayout();
}

// ===== 锚点与形态计算 =====

// 按优先级取第一个有效的右栏锚点：存在、rect.width >= 280 且 rect.right
// 未超出视口。隐藏副本（width 0）与滚出视口的候选都被跳过。
function findDigestAnchor(): Element | null {
  for (const selector of ANCHOR_SELECTORS) {
    const candidate = document.querySelector(selector);
    if (!candidate) {
      continue;
    }
    const rect = candidate.getBoundingClientRect();
    if (rect.width >= ANCHOR_MIN_WIDTH && rect.right <= window.innerWidth) {
      return candidate;
    }
  }
  return null;
}

// 重锚时换 ResizeObserver 的观察对象；锚点为 null 时只解除旧观察。
function observeDigestAnchor(anchor: Element | null): void {
  if (resizeObserver && observedAnchor) {
    resizeObserver.unobserve(observedAnchor);
  }
  observedAnchor = anchor;
  if (resizeObserver && anchor) {
    resizeObserver.observe(anchor);
  }
}

// 读→算→写一拍。所有路径（open/事件合帧/自查/手动）最终都到这里。
function applyDigestRect(): void {
  const readingView = document.getElementById("boc-reading-view");
  if (!readingView) {
    return;
  }

  // float 档强制浮层（不做贴栏判定）。
  if (isFloatMode()) {
    applyFloating();
    return;
  }

  const anchor = findDigestAnchor();
  if (anchor !== observedAnchor) {
    observeDigestAnchor(anchor);
  }

  // 锚点命中且视口够宽：贴栏形态，宽度取档位目标宽。
  const anchorRect = anchor?.getBoundingClientRect();
  if (anchorRect && window.innerWidth >= FLOAT_VIEWPORT_MIN_WIDTH) {
    const rect = clampAnchorRect(anchorRect);
    applyPinnedRect(readingView, rect);
    return;
  }

  // 降级 1：锚点全落空但视口够宽且有播放器——面板占「播放器右缘 + 12 →
  // 视口右缘」，纵向同样钳进一屏；挤不出下限宽则继续降级。
  if (window.innerWidth >= FLOAT_VIEWPORT_MIN_WIDTH) {
    const playerRect = getPlayerRect();
    if (playerRect) {
      const right = getViewportRightBound();
      const left = playerRect.right + PLAYER_GAP;
      const width = right - left;
      if (width >= PANEL_MIN_WIDTH) {
        const top = clampTopIntoViewport(playerRect.top);
        applyPinnedRect(readingView, {
          left,
          top,
          width,
          height: window.innerHeight - top
        });
        return;
      }
    }
  }

  // 降级 2：窄窗 / 连播放器都没有——浮层形态。不写四个变量，改设浮层
  // 属性，reader-gate.css 让面板回落到 reader.css 居中浮层基础样式。
  applyFloating();
}

// 视口右界：documentElement.clientWidth 不含经典滚动条（页面滚动条保持
// 可用，宽屏死区被面板吃掉但不动滚动条）；覆盖式滚动条平台它等于
// innerWidth。jsdom 下 clientWidth 恒 0，回落 innerWidth。
function getViewportRightBound(): number {
  return document.documentElement.clientWidth || window.innerWidth;
}

// 纵向钳进一屏：top 跟锚点/播放器但不小于 0，且不超过「视口底 -
// 最低高度保底」；底缘恒贴视口底。
function clampTopIntoViewport(rawTop: number): number {
  return Math.max(
    0,
    Math.min(Math.max(rawTop, 0), window.innerHeight - PINNED_MIN_HEIGHT)
  );
}

// 命中锚点后取面板 rect：占「锚点左缘 → 视口右界」整条右侧；可填宽度不足
// 档位下限宽时左缘向左延伸补足（窄窗/窄栏兜底）。
function clampAnchorRect(rect: DOMRect): { left: number; top: number; width: number; height: number } {
  const right = getViewportRightBound();
  const left = Math.min(rect.left, right - getPanelTargetWidth());
  const top = clampTopIntoViewport(rect.top);
  return { left, top, width: right - left, height: window.innerHeight - top };
}

// 降级 1 的播放器 rect：findReaderPlayerHost(video) 的宿主若不可用（video
// 缺失或宿主 rect 塌掉），返回 null 继续降级。
function getPlayerRect(): DOMRect | null {
  const video = document.querySelector("video");
  const host = findReaderPlayerHost(video);
  if (!host) {
    return null;
  }
  const rect = host.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return rect;
}

// ===== 写组（脏检查：与上次快照全同则整组跳写） =====

function applyPinnedRect(
  readingView: HTMLElement,
  rect: { left: number; top: number; width: number; height: number }
): void {
  const values = [
    `${Math.round(rect.left)}px`,
    `${Math.round(rect.top)}px`,
    `${Math.round(rect.width)}px`,
    `${Math.round(rect.height)}px`
  ];
  if (lastSnapshot && !lastSnapshot.floating && lastSnapshot.values.join() === values.join()) {
    return;
  }
  lastSnapshot = { floating: false, values };
  readingView.removeAttribute(FLOAT_ATTR);
  DIGEST_VARS.forEach((name, index) => {
    readingView.style.setProperty(DIGEST_VAR_PREFIX + name, values[index]);
  });
}

function applyFloating(): void {
  if (lastSnapshot?.floating) {
    return;
  }
  lastSnapshot = { floating: true, values: [] };
  const readingView = document.getElementById("boc-reading-view");
  if (!readingView) {
    return;
  }
  for (const name of DIGEST_VARS) {
    readingView.style.removeProperty(DIGEST_VAR_PREFIX + name);
  }
  readingView.setAttribute(FLOAT_ATTR, "1");
}
