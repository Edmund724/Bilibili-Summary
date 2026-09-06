// ui/digest-button.ts — 播放页工具栏「Digest」按钮（统一 Digest 阅读模式 PR1，
// 工单 .scratch/tickets/digest-reader/issues/04-digest-button-anchor.md）。
//
// 装载模式仿 ai/player-ai.ts 的惰性域模块：经 ui/lazy-digest-button.ts 动态
// import（arch-slim-2/09 加载器归位 ui/），content.ts 的 getSettings().then
// 两个分支（非阅读模式分支 + 阅读模式直达分支）都触发装载；模块求值即自管
// 「等 hydration 稳定 → 自查注入/摘除 → setInterval 定时自查 + visibilitychange
// 即时自查」生命周期，无设置项、常驻。
// 阅读直达分支也装载的原因：直达路径上按钮模块同时承担视图失同步自愈（见
// syncDigestButton）——视图关闭后把按钮补回来、视图壳被页面重渲染摘走或进入
// 链半途失败时自动恢复，这些失同步在直达路径同样可能发生。
//
// 与 player-ai 的有意差异：工具栏按钮场景用定时自查而非 MutationObserver——
// 观察 body 时弹幕每飘一条都是变更事件，白烧 CPU 且防抖等不到空档；定时器
// 顺带覆盖 SPA 换页（不触发事件）。纪律与水合等待均照搬参考仓库
// .scratch/bilibili-digest/content.js（工单调查报告 §二）。
//
// 点击行为：不发 background 消息。直接构造 reader-enter 消息交给
// content 侧处理器（entry/message-handler.ts 已实现的阅读模式进入路径，
// arch-slim-2/09 组合根归位 entry/），readerUrl 拼法单源在 bilibili/reader-url.ts
// 的 buildReaderModeUrl（cleanVideoUrl 清成规范视频 URL 再加 boc_reader=1；
// arch-slim-2/03 收口，原本地 buildReaderUrl 与 shell.ts 各抄一份）。经
// dispatchContentScriptMessage 分发而非 chrome.runtime.sendMessage：content
// script 的 sendMessage 不会回环到本文档自己的 onMessage 监听器，分发主体抽出
// 后监听器与按钮共用同一条处理器路径。失同步自愈同理：自查派发 reader-restore
//（阅读壳 restore 档先按 DOM 实况收敛失同步状态，再走与点击完全相同的进入链）。
//
// 自愈调度（arch-slim-2/09 收口）：自查节拍 800ms 单源 shared/self-heal.js 的
// SELF_HEAL_INTERVAL_MS（与 reader/digest-host.ts 的重锚节拍同源）。阅读壳打开
// 且完好期间按钮恒被守卫摘除、自查只会空跑 isReaderShellIntact 的 DOM 查询，
// interval 降频至 PAUSED_INTERVAL_MS 兜底（恢复事件丢失时按钮延迟上限 2s）；
// 视图关闭（exitReaderShell 派发 READER_CLOSED_EVENT 窗口事件，不建静态
// import 边）时恢复常速并立即自查一轮补按钮，visibilitychange 现有链保持。

import { isReaderMode, isSupportedVideoPage } from "../bilibili/video-id-shared.js";
import { buildReaderModeUrl } from "../bilibili/reader-url.js";
// 页内分发原语（arch-slim-2/09）：分发主体住 entry/message-handler.ts，于
// bindRuntimeEvents 时注册进 shared 的原语槽——本模块只依赖 shared 叶子，
// 不建 ui → entry 的静态边。
import { dispatchContentScriptMessage } from "../shared/messaging.js";
import { isReaderViewOpen } from "../reader/state.js";
// 阅读壳（工单 arch-slim/02）：失同步判定收口为壳的唯一完好性自查
//（restore 档自愈与本守卫共用同一 predicate，不再本地手抄）。
import { isReaderShellIntact } from "../reader/shell.js";
// 自愈调度共享常量（arch-slim-2/09 单源）：自查节拍 + 视图关闭恢复事件名。
import { READER_CLOSED_EVENT, SELF_HEAL_INTERVAL_MS } from "../shared/self-heal.js";

const DIGEST_BUTTON_ID = "boc-digest-button";
const DIGEST_OVERLAY_ID = "boc-digest-overlay";

// hydration 稳定前不碰 DOM：SSR + Vue hydration 期间向 Vue 管的容器插节点会被
// 判定两端不一致、整树推倒重渲染（表现为视频加载两遍）。没有公开的「hydration
// 完成」信号，用三条件近似：window.load 已发生 + <video> 已挂上 + 余量。
const SETTLE_DELAY_MS = 1200;
const PLAYER_POLL_MS = 200;
const PLAYER_WAIT_TIMEOUT_MS = 15000;
// 定时自查间隔：B 站重渲染 / SPA 换页把节点带走后靠它补回（注入幂等）。
// 单源 shared/self-heal.js（与 digest-host 重锚节拍同一口径）。
const REINJECT_INTERVAL_MS = SELF_HEAL_INTERVAL_MS;
// 暂停期兜底节拍：阅读壳打开且完好时按钮恒被摘除，自查只剩空跑 DOM 查询，
// 降频至此（不是全停——恢复事件丢失时按钮最迟一个兜底 tick 补回，风险上限
// 2s，见文件头「自愈调度」注）。
const PAUSED_INTERVAL_MS = 2000;

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
  syncDigestButton();
  setTickInterval(REINJECT_INTERVAL_MS);
  // 切回标签页立即自查一轮：hidden 期间定时器被 Chrome 强力节流（5 分钟后
  // 至多 1 次/分钟），靠它恢复会让「切走再切回」场景的白屏时间拉长到下一个
  // 节流 tick；visibilitychange 回来的第一次自查与定时器共用 brokenTicks
  // 连击确认，不会抢先误恢复。（若视图仍开着且完好，本轮自查会重新降频——
  // 暂停态对可见性变化是幂等的。）
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      setTickInterval(REINJECT_INTERVAL_MS);
      syncDigestButton();
    }
  });
  // 阅读壳退出（exitReaderShell 完成退出事务后派发，事件名单源
  // shared/self-heal.js）：恢复常速自查 + 立即自查一轮补按钮——这是「视图
  // 关闭后补回按钮」的主恢复触发点（暂停期兜底 tick 只是丢事件时的兜底）。
  window.addEventListener(READER_CLOSED_EVENT, () => {
    setTickInterval(REINJECT_INTERVAL_MS);
    syncDigestButton();
  });
});

// ===== 自查节拍（arch-slim-2/09 暂停/恢复收口） =====
//
// 单一 interval 句柄 + 档位切换：常速 REINJECT_INTERVAL_MS（按钮在场 / 失同步
// 自愈中，需要 800ms 级节奏）与暂停档 PAUSED_INTERVAL_MS（阅读壳打开且完好，
// 自查空跑）之间按每轮自查的结论切换。setInterval 回调持有人不变，换档只换
// 周期，已挂出的定时器整体重建（幂等：同档不重建）。
let tickTimer = 0;
let tickIntervalMs = 0;

function setTickInterval(ms: number): void {
  if (tickTimer && tickIntervalMs === ms) {
    return;
  }
  if (tickTimer) {
    window.clearInterval(tickTimer);
  }
  tickTimer = window.setInterval(syncDigestButton, ms);
  tickIntervalMs = ms;
}

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

// ===== 定时自查：补按钮 / 摘按钮 / 视图失同步自愈 =====

// 失同步恢复的节奏控制：连续 RESTORE_CONFIRM_TICKS 个自查周期都处于失同步态才
// 派发恢复（点击路径上「URL 已改写、enterReaderMode 未完成」「状态已置开、
// .open 未挂上」的亚秒瞬态不触发）；两次恢复派发之间至少隔 RESTORE_RETRY_BACKOFF_MS
// （进入链自身失败时退避，不每 800ms 空转重试）。
const RESTORE_CONFIRM_TICKS = 3;
const RESTORE_RETRY_BACKOFF_MS = 4000;
let brokenTicks = 0;
let lastRestoreAt = 0;

function syncDigestButton(): void {
  // SPA 换到非视频页：工具栏按钮无意义，主动摘除。口径单源
  // video-id-shared 的 isSupportedVideoPage（与 content.ts isSupportedUrl
  // 共用）——稍后再看等列表播放页（/list/watchlater?bvid=）由该 predicate
  // 覆盖，不能只看 /video/ pathname（否则按钮在装载后一个自查周期就被摘掉）。
  if (!isSupportedVideoPage()) {
    brokenTicks = 0;
    setTickInterval(REINJECT_INTERVAL_MS);
    removeDigestButton();
    return;
  }
  const viewOpen = isReaderViewOpen();
  const readerUrlMode = isReaderMode();
  // 阅读视图开着且壳完整：正常接管态，按钮保持摘除（视图关闭后由
  // READER_CLOSED_EVENT 触发首轮补回；本自查降频为暂停档兜底，仅防恢复事件
  // 丢失）。壳完好性判定收口到阅读壳的唯一实现 isReaderShellIntact
  //（reader/shell.ts）。
  if (viewOpen && isReaderShellIntact()) {
    brokenTicks = 0;
    setTickInterval(PAUSED_INTERVAL_MS);
    removeDigestButton();
    return;
  }
  // 失同步两态，交由 reader-restore 处理器自愈（连续确认 + 退避见
  // 上方常量注）。自愈期恢复常速节拍——brokenTicks 连击确认的节奏以
  // REINJECT_INTERVAL_MS 为基准，暂停档会拉长确认窗口。
  //   - 状态开着而壳失整：面板被页面重渲染摘走，按钮被守卫永久压住——用户看到
  //     「侧边栏和按钮一起消失，只能刷新」的正是它；
  //   - URL 带 boc_reader=1 而视图没开：进入链半途失败（直达启动失败 / 中途
  //     状态被清），失败文案写进隐藏面板用户看不见。
  if (viewOpen || readerUrlMode) {
    setTickInterval(REINJECT_INTERVAL_MS);
    if (++brokenTicks >= RESTORE_CONFIRM_TICKS) {
      const now = Date.now();
      if (now - lastRestoreAt >= RESTORE_RETRY_BACKOFF_MS) {
        brokenTicks = 0;
        lastRestoreAt = now;
        dispatchContentScriptMessage(
          { type: "reader-restore", readerUrl: buildReaderModeUrl(location.href) },
          () => {}
        );
      }
    }
    return;
  }
  // 视图没开也不在阅读模式：健康态，补按钮（brokenTicks 一并归位，避免上一轮
  // 失同步的残留计数让下一轮瞬态误触发恢复）。
  brokenTicks = 0;
  setTickInterval(REINJECT_INTERVAL_MS);
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
// 匹配，类名变更时文本兜底。#arc_toolbar_report 宿主在稍后再看等列表播放页
// 不存在，落空时退到全局类名查询（文本判定兜底）。
function findComplaintNode(): HTMLElement | null {
  const scoped = document.querySelectorAll("#arc_toolbar_report .video-complaint");
  const candidates = scoped.length > 0 ? scoped : document.querySelectorAll(".video-complaint");
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
    { type: "reader-enter", readerUrl: buildReaderModeUrl(location.href) },
    () => {}
  );
}
