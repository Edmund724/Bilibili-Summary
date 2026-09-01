// ui/digest-button.ts — 播放页工具栏「Digest」按钮（统一 Digest 阅读模式 PR1，
// 工单 .scratch/tickets/digest-reader/issues/04-digest-button-anchor.md）。
//
// 装载模式仿 ai/player-ai.ts 的惰性域模块：经 core/lazy-digest-button.ts 动态
// import，content.ts 的 getSettings().then 非阅读模式分支触发装载；模块求值即
// 自管「等 hydration 稳定 → 注入 → setInterval 定时自查」生命周期，无设置项、
// 常驻（按钮是阅读模式的替代入口）。
//
// 与 player-ai 的有意差异：工具栏按钮场景用定时自查而非 MutationObserver——
// 观察 body 时弹幕每飘一条都是变更事件，白烧 CPU 且防抖等不到空档；定时器
// 顺带覆盖 SPA 换页（不触发事件）。纪律与水合等待均照搬参考仓库
// .scratch/bilibili-digest/content.js（工单调查报告 §二）。
//
// 点击行为：不发 background 消息。直接构造 popup-trigger-reading-view 消息交给
// content 侧处理器（core/message-handler.ts 已实现的阅读模式进入路径），
// readerUrl 用 cleanVideoUrl 清成规范视频 URL 再加 boc_reader=1，与 background
// handleOpenReadingViewTab 的拼法一致。经 dispatchContentScriptMessage 分发而非
// chrome.runtime.sendMessage：content script 的 sendMessage 不会回环到本文档
// 自己的 onMessage 监听器，分发主体抽出后监听器与按钮共用同一条处理器路径。

import { cleanVideoUrl, isReaderMode } from "../bilibili/video-id-shared.js";
import { dispatchContentScriptMessage } from "../core/message-handler.js";
import { isReaderViewOpen } from "../reader/state.js";

const DIGEST_BUTTON_ID = "boc-digest-button";
const DIGEST_OVERLAY_ID = "boc-digest-overlay";

// hydration 稳定前不碰 DOM：SSR + Vue hydration 期间向 Vue 管的容器插节点会被
// 判定两端不一致、整树推倒重渲染（表现为视频加载两遍）。没有公开的「hydration
// 完成」信号，用三条件近似：window.load 已发生 + <video> 已挂上 + 余量。
const SETTLE_DELAY_MS = 1200;
const PLAYER_POLL_MS = 200;
const PLAYER_WAIT_TIMEOUT_MS = 15000;
// 定时自查间隔：B 站重渲染 / SPA 换页把节点带走后靠它补回（注入幂等）。
const REINJECT_INTERVAL_MS = 800;

// 浮动降级宿主候选（参考仓库 PLAYER_SELECTORS）。硬约束：不能挂进直接包着
// <video> 的那层——那层归播放器管，插外来节点会让它推倒重建、视频加载两遍。
const PLAYER_SELECTORS = [
  "#bilibili-player .bpx-player-primary-area",
  "#bilibili-player",
  ".bpx-player-container",
  "#playerWrap"
];

const BUTTON_BASE_STYLE =
  "display:inline-flex;align-items:center;gap:6px;padding:8px 18px;border:none;" +
  "border-radius:6px;cursor:pointer;font-size:14px;line-height:1.4;color:#fff;white-space:nowrap;";

// ===== 模块求值即启动生命周期（content.ts 只在非阅读模式分支装载本模块） =====

void waitForHydrationSettled().then(() => {
  injectDigestButton();
  window.setInterval(syncDigestButton, REINJECT_INTERVAL_MS);
});

// 水合等待链：等不到 <video>（特殊页面形态）也别一直等，超时后照常尝试注入。
async function waitForHydrationSettled(): Promise<void> {
  await whenWindowLoaded();
  await whenVideoMounted();
  await delay(SETTLE_DELAY_MS);
}

function whenWindowLoaded(): Promise<void> {
  if (document.readyState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    window.addEventListener("load", () => resolve(), { once: true });
  });
}

async function whenVideoMounted(): Promise<void> {
  const deadline = Date.now() + PLAYER_WAIT_TIMEOUT_MS;
  while (!document.querySelector("video") && Date.now() < deadline) {
    await delay(PLAYER_POLL_MS);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// ===== 定时自查：补按钮 / 摘按钮 =====

function syncDigestButton(): void {
  // SPA 换到非 /video/ 页：工具栏按钮无意义，主动摘除。
  if (!/\/video\//.test(location.pathname)) {
    removeDigestButton();
    return;
  }
  // 阅读模式接管整页后工具栏按钮无意义（player-ai 快捷按钮同款守卫）；
  // 视图关闭后自查会把按钮补回来。
  if (isReaderViewOpen() || isReaderMode()) {
    removeDigestButton();
    return;
  }
  injectDigestButton();
}

// ===== 注入 =====

export function injectDigestButton(): void {
  // 幂等：命中且仍在文档即返回（B 站重渲染会换掉节点，isConnected 兜住）。
  const existing = document.getElementById(DIGEST_BUTTON_ID);
  if (existing?.isConnected) {
    return;
  }

  const button = document.createElement("button");
  button.id = DIGEST_BUTTON_ID;
  button.type = "button";
  button.textContent = "Digest";
  button.title = "用 AI 总结这期视频";
  button.setAttribute("aria-label", "用 AI 总结这期视频");
  button.setAttribute("data-boc-extension-node", "digest-button");
  button.addEventListener("click", handleDigestButtonClick);

  // 锚点 1（新版播放页实测）：插到「稿件举报」左侧。类名单押不可靠，命中后
  // 用文本聚合兜底判定（player-ai.ts 字幕控件同款思路）。
  const complaint = findComplaintNode();
  if (complaint && complaint.parentElement) {
    styleDigestButton(button, { floating: false });
    complaint.parentElement.insertBefore(button, complaint);
    return;
  }

  // 锚点 2：右侧块尾部。
  const toolbarRight = document.querySelector(".video-toolbar-right");
  if (toolbarRight instanceof HTMLElement) {
    styleDigestButton(button, { floating: false });
    toolbarRight.appendChild(button);
    return;
  }

  // 锚点 3：旧版播放页兜底。
  const toolbarLeftMain = document.querySelector("#arc_toolbar_report .video-toolbar-left-main");
  if (toolbarLeftMain instanceof HTMLElement) {
    styleDigestButton(button, { floating: false });
    toolbarLeftMain.appendChild(button);
    return;
  }

  // 三个锚点全落空：播放器浮动降级。
  const overlay = ensureDigestOverlay();
  if (overlay) {
    styleDigestButton(button, { floating: true });
    overlay.appendChild(button);
  }
}

export function removeDigestButton(): void {
  document.getElementById(DIGEST_BUTTON_ID)?.remove();
  document.getElementById(DIGEST_OVERLAY_ID)?.remove();
}

// 「稿件举报」判定不靠类名单押：aria-label/title/data-text/textContent 聚合后
// 匹配，类名变更时文本兜底。
function findComplaintNode(): HTMLElement | null {
  const candidates = document.querySelectorAll("#arc_toolbar_report .video-complaint");
  for (const node of candidates) {
    if (!(node instanceof HTMLElement) || !node.parentElement) {
      continue;
    }
    const text = [
      node.getAttribute("aria-label"),
      node.getAttribute("title"),
      node.getAttribute("data-text"),
      node.textContent
    ]
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .join(" ");
    if (/稿件举报|投诉/.test(text)) {
      return node;
    }
  }
  return null;
}

function styleDigestButton(button: HTMLElement, { floating }: { floating: boolean }): void {
  button.style.cssText = floating
    ? `${BUTTON_BASE_STYLE}background:rgba(251,114,153,.92);box-shadow:0 2px 8px rgba(0,0,0,.2);`
    : `${BUTTON_BASE_STYLE}background:#fb7299;margin-right:16px;`;
}

// ===== 浮动降级 =====

function ensureDigestOverlay(): HTMLElement | null {
  const player = findFloatHost();
  if (!player) {
    return null;
  }
  const existing = player.querySelector(`#${DIGEST_OVERLAY_ID}`);
  if (existing instanceof HTMLElement && existing.isConnected) {
    return existing;
  }
  // 浮动定位需要定位上下文，播放器容器默认可能是 static。
  if (window.getComputedStyle(player).position === "static") {
    player.style.position = "relative";
  }
  const overlay = document.createElement("div");
  overlay.id = DIGEST_OVERLAY_ID;
  overlay.style.cssText =
    "position:absolute;top:12px;right:12px;z-index:9999;display:flex;flex-direction:column;align-items:flex-end;gap:8px;";
  player.appendChild(overlay);
  return overlay;
}

// 外层容器且不是 <video> 的直接父节点，才能安全挂东西。
function holdsVideoDirectly(element: Element): boolean {
  return Array.from(element.children).some((child) => child.tagName === "VIDEO");
}

function findFloatHost(): HTMLElement | null {
  for (const selector of PLAYER_SELECTORS) {
    const element = document.querySelector(selector);
    if (element instanceof HTMLElement && !holdsVideoDirectly(element)) {
      return element;
    }
  }
  return null;
}

// ===== 点击 =====

function handleDigestButtonClick(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
  // 阅读视图开着时按钮已被自查摘除，这里兜底不重复触发。
  if (isReaderViewOpen() || isReaderMode()) {
    return;
  }
  dispatchContentScriptMessage(
    { type: "popup-trigger-reading-view", readerUrl: buildReaderUrl() },
    () => {}
  );
}

function buildReaderUrl(): string {
  const base = cleanVideoUrl(location.href);
  try {
    const parsed = new URL(base);
    parsed.searchParams.set("boc_reader", "1");
    return parsed.toString();
  } catch {
    return base;
  }
}
