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
// 贴栏宽度下限（digest-only-ui 排版定稿）：面板宽度档已定死 380px，可填宽度
// 不足时左缘向左延伸补足。
//
// player-host 整页接管退役后，本模块是 LAYOUT 层唯一的布局调度器
//（rAF 合帧 + 脏检查，思路源自旧 player-host 调度器）——digest-host
// 的写组是四个 CSS 变量与一个浮层属性，快照结构独立。
//
// 为什么不用 MutationObserver：弹幕每飘一条都是变更事件，白烧 CPU（见
// ui/digest-button.ts 头注）；SPA 换页换掉锚点节点的场景由 2s 定时自查
// 覆盖（节拍与拆单源的理由见 REANCHOR_INTERVAL_MS 处注释，与 digest-button
// 的按钮自愈相互独立，不复用 shared/self-heal.js 的 800ms 常量）。

import { findReaderPlayerHost } from "../bilibili/video-probe.js";
// #boc-reading-view 的 id 单源（arch-slim-2/03）：reader/state.js 的 id 表就是
// 为此存在，本模块四处手抄字面量收口到 ids.readingView。
import { ids } from "./state.js";

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
// 贴栏宽度下限（定死值 = 380px，digest-only-ui 排版定稿）：贴栏面板正常吃掉
// 锚点左缘到视口右缘的整条右侧，仅当可填宽度不足时左缘左移补足。
const PANEL_MIN_WIDTH = 300;
const PANEL_TARGET_WIDTH = 380;

// 贴播放器右缘时的间距。贴栏纵向钳进一屏的最低高度保底（视口过矮时
// top 不再上移，宁可口子贴底）。
const PLAYER_GAP = 12;
const PINNED_MIN_HEIGHT = 240;
// 窄于该值不进贴栏形态（1000 是估计值，TODO: 手工验证时对照 B 站
// 右栏折叠断点校准后再定）。
const FLOAT_VIEWPORT_MIN_WIDTH = 1000;
// 定时自查间隔：SPA 换页把锚点节点换掉后靠它重锚（不用 MutationObserver，
// 理由见文件头注）。有意不再沿用 shared/self-heal.js 的 800ms（按钮自愈
// 节拍，仍是其唯一消费者）：面板跑位是「降级表现」，滚动/resize 的 rAF
// 合帧与 ResizeObserver 自带重锚（applyDigestRect 每拍比对换锚），此拍只在
// 「用户完全不动 + 无 observer 事件」期间兜底自愈，与按钮「功能失效恢复」
// 的语义本就独立，不必同档——兜底延迟上限放宽到 2s。
const REANCHOR_INTERVAL_MS = 2000;

// 贴栏宽度下限：定死 380px。

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
  window.removeEventListener("resize", requestDigestLayout);
  window.removeEventListener("scroll", requestDigestLayout);
  lastSnapshot = null;
  const readingView = document.getElementById(ids.readingView);
  if (!readingView) {
    return;
  }
  for (const name of DIGEST_VARS) {
    readingView.style.removeProperty(DIGEST_VAR_PREFIX + name);
  }
  readingView.removeAttribute(FLOAT_ATTR);
}

// ===== 重算机制 =====

function bindDigestHostListeners(): void {
  // 事件监听走零参入口 requestDigestLayout：Event 实参由它丢弃，且具名函数
  // 保证 add/remove 拿到同一引用（箭头每次新建，remove 永不命中、监听泄漏）。
  window.addEventListener("resize", requestDigestLayout);
  window.addEventListener("scroll", requestDigestLayout, { passive: true });
}

// 事件路径入口：丢弃 Event 实参，转调合帧入口（不带 finding 的纯重算）。
function requestDigestLayout(): void {
  scheduleDigestLayout();
}

// rAF 合帧入口：置脏标志（rafId 非 0 即有未消费请求），一帧至多跑一次
// 「读→算→写」。finding 为自查拍（checkReanchor）搜到的锚点与 rect，原样
// 透传给本帧的 applyDigestRect（同拍复用，不重搜）；事件路径不传 finding，
// 一帧内的重复请求合并为一帧（rAF 只认 fn 引用，不认形参）。
function scheduleDigestLayout(finding?: AnchorFinding): void {
  if (layoutRafId) {
    return;
  }
  layoutRafId = window.requestAnimationFrame(() => runDigestLayout(finding));
}

function runDigestLayout(finding?: AnchorFinding): void {
  layoutRafId = 0;
  // 阅读视图节点已被移除（扩展根被清理/测试 teardown）时静默丢弃本帧：
  // 没有可写变量/属性的对象。
  if (!document.getElementById(ids.readingView)) {
    return;
  }
  applyDigestRect(finding);
}

// 2s 自查：锚点节点被 B 站换掉（SPA 换页/重渲染）时重锚。自查只做一次
// 搜索（锚点与 rect 一并得到），经 rAF 合帧把结果交给 applyDigestRect 复用
//（一拍一搜：自查路径全拍 findDigestAnchor 恰一次、rect 恰一次），换观察
// 对象的判断收在 applyDigestRect——自查自身不换锚，只触发合帧。
function checkReanchor(): void {
  if (!reanchorTimer) {
    return;
  }
  scheduleDigestLayout(findDigestAnchor() ?? undefined);
}

// ===== 锚点与形态计算 =====

// findDigestAnchor 的返回：命中的锚点与其筛选时量得的 rect（rect 一并给出，
// 调用方复用、不重复量）；全落空返回 null。
type AnchorFinding = { anchor: Element; rect: DOMRect } | null;

// 按优先级取第一个有效的右栏锚点：存在、rect.width >= 280 且 rect.right
// 未超出视口。隐藏副本（width 0）与滚出视口的候选都被跳过。rect 随命中
// 一并返回（筛选时已量），调用方复用、不再重复读。
function findDigestAnchor(): AnchorFinding {
  for (const selector of ANCHOR_SELECTORS) {
    const candidate = document.querySelector(selector);
    if (!candidate) {
      continue;
    }
    const rect = candidate.getBoundingClientRect();
    if (rect.width >= ANCHOR_MIN_WIDTH && rect.right <= window.innerWidth) {
      return { anchor: candidate, rect };
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

// 读→算→写一拍。所有路径（open/事件合帧/自查）最终都到这里，形态计算与
// 写组只有这一条路径。finding 为空即事件路径（rAF 合帧/初始化），函数自查
// 锚点；自查路径（checkReanchor）传入其拍内已找到的锚点与 rect（搜索时
// 一并量得），跳过 findDigestAnchor 与重复 rect 读。观察对象的换锚判断在
// 此单点收口，两条路径同样过这段。
function applyDigestRect(finding?: AnchorFinding): void {
  const readingView = document.getElementById(ids.readingView);
  if (!readingView) {
    return;
  }

  const found = finding ?? findDigestAnchor();
  const anchor = found?.anchor ?? null;
  if (anchor !== observedAnchor) {
    observeDigestAnchor(anchor);
  }

  // 锚点命中且视口够宽：贴栏形态，宽度下限定死 380px。
  const anchorRect = found?.rect;
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
// 下限宽时左缘向左延伸补足（窄窗/窄栏兜底）。
function clampAnchorRect(rect: DOMRect): { left: number; top: number; width: number; height: number } {
  const right = getViewportRightBound();
  const left = Math.min(rect.left, right - PANEL_TARGET_WIDTH);
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
  const readingView = document.getElementById(ids.readingView);
  if (!readingView) {
    return;
  }
  for (const name of DIGEST_VARS) {
    readingView.style.removeProperty(DIGEST_VAR_PREFIX + name);
  }
  readingView.setAttribute(FLOAT_ATTR, "1");
}
