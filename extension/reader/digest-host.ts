// Reader LAYOUT 层 · digest-host 域（右栏 Digest 面板定位器，本阶段纯增量、
// 无消费方，项目行为零变化）。
//
// 职责：计算右栏 rect 并写入 #boc-reading-view 的 CSS 变量
// --boc-digest-left/top/width/height。定位 CSS（阶段 2）才会消费这些变量，
// 本模块只负责「算 + 写」；浮层形态（降级 2）不写变量，改设
// data-boc-digest-float="1" 属性，让阶段 2 的 CSS 回落到 reader.css 既有的
// 居中浮层基础样式。
//
// 阶段 4b：面板宽度不再跟随锚点夹取 [300, 420]，改为读
// state.reader.readingContentWidth 档位（narrow 340 / standard 380 / wide 440 /
// float 强制浮层）——步进器「面板宽度」档即本模块的消费方。
//
// 阶段 3：player-host 整页接管已退役，本模块是 LAYOUT 层唯一的布局调度器
//（rAF 合帧 + 脏检查，思路源自候选10 批1 的旧 player-host 调度器）——digest-host
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
// 面板宽度档（阶段 4b：readerContentWidth 语义 = 面板宽度档）。贴栏形态的
// 面板宽度由档位决定（不再跟随锚点宽度），右缘对齐锚点；夹取区间只作安全
// 下限/上限，档位宽度始终落在区间内。
const PANEL_MIN_WIDTH = 300;
const PANEL_MAX_WIDTH = 460;
// narrow/standard/wide 三档的目标宽度；float 档不走贴栏，强制浮层形态。
export const PANEL_WIDTH_BY_MODE: Record<string, number> = {
  narrow: 340,
  standard: 380,
  wide: 440
};
const DEFAULT_PANEL_WIDTH = PANEL_WIDTH_BY_MODE.standard;

// 贴播放器右缘时的间距与视口安全边距。
const PLAYER_GAP = 12;
const VIEWPORT_MARGIN = 16;
// 窄于该值不进贴栏形态（1000 是估计值，TODO(阶段2): 手工验证时对照 B 站
// 右栏折叠断点校准后再定）。
const FLOAT_VIEWPORT_MIN_WIDTH = 1000;
// 定时自查间隔：SPA 换页把锚点节点换掉后靠它重锚（不用 MutationObserver，
// 理由见文件头注）。
const REANCHOR_INTERVAL_MS = 800;

// 当前档位的目标面板宽度：未知值（含 float）回落 standard。
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

  // 降级 1：锚点全落空但视口够宽且有播放器——贴播放器右缘。
  if (window.innerWidth >= FLOAT_VIEWPORT_MIN_WIDTH) {
    const playerRect = getPlayerRect();
    if (playerRect) {
      const left = playerRect.right + PLAYER_GAP;
      const width = Math.min(getPanelTargetWidth(), window.innerWidth - left - VIEWPORT_MARGIN);
      if (width >= PANEL_MIN_WIDTH) {
        applyPinnedRect(readingView, {
          left,
          top: playerRect.top,
          width,
          height: playerRect.height
        });
        return;
      }
    }
  }

  // 降级 2：窄窗 / 连播放器都没有——浮层形态。不写四个变量，改设浮层
  // 属性，阶段 2 的 CSS 让面板回落到 reader.css 居中浮层基础样式。
  applyFloating();
}

// 命中锚点后取面板 rect：宽度 = 当前档位目标宽（夹在安全区间内），left 相应
// 左移保持右缘与锚点右缘对齐。
function clampAnchorRect(rect: DOMRect): { left: number; top: number; width: number; height: number } {
  const width = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, getPanelTargetWidth()));
  const left = rect.right - width;
  return { left, top: rect.top, width, height: rect.height };
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
