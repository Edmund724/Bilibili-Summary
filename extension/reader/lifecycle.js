// Reader shell: lifecycle + settings domain (extracted from reader-impl.js,
// formerly the shell.js segment, issue 06+).
//
// Deep module owning the reader view lifecycle (enter/close), the settings
// rendering/steppers, the page-state guards and the debug snapshot. It depends
// on the base LAYOUT layer (page-frame.js + player-host.js) and on ./sync.js;
// neither may import it, so the dependency graph stays acyclic:
//
//   ports.js   显式回调端口叶子（本模块在文件尾单点注册全部端口实现）
//   LAYOUT     page-frame.js + player-host.js    → ports
//   SYNC       sync.js                           → LAYOUT + ports
//   LIFECYCLE  lifecycle.js（本文件）            → SYNC + LAYOUT + ports
//
// The player-host layout closure is read here through the exported accessors
// (getPlayerHost/...); playerRetryTimer's variable itself moved into this
// module (its owner starts/clears it here), so it is read/written directly.
import { state } from "../core/state.js";
import { getReaderElement } from "../shared/dom-utils.js";
import { sleep } from "../shared/utils.js";
// 候选02：updateReaderPreferences/renderReaderPanels 自 presentation.js 移回，
// 步进器取值归一化（validators）随之回到本文件的 import 列表。
import {
  normalizeReaderTheme,
  normalizeReaderFontScale,
  normalizeReaderLetterSpacing,
  normalizeReaderLineHeight,
  normalizeReaderContentWidth,
  normalizeReaderTranscriptVisible
} from "../core/validators.js";
import { isReaderMode, cleanVideoUrl } from "../bilibili/video-id-shared.js";
import { findReaderPlayerHost, getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { getErrorMessage, isStaleRunError } from "../shared/error-helpers.js";
import {
  getReadingTranscriptItems,
  getReadingTranscriptPlaceholderText
} from "../subtitle/core.js";
import {
  normalizeChapters,
  isAiSubtitle
} from "../subtitle/selection.js";
import {
  escapeHtml,
  formatCompactTimestamp
} from "../shared/string-utils.js";
import { shouldShowHoursInNote } from "../notes/render.js";
import { requestSubtitleRefresh, persistReaderSettingsThroughSeam } from "./presenter.js";

// 候选02 分层惰性：启动接线（bindReaderPresenter / installReaderDebugHelpers /
// bindSettingsWatcher）与启动期呈现（hydrate/apply/renderReadingStatus/stepper
// 模板）在常驻微模块 ./init-essentials.js、./presentation.js；阅读视图打开后
// 的交互呈现（updateReaderPreferences/renderReaderPanels/renderReadingInfoPanel
// /renderReaderStepperState/applyReaderStepperPreference）属本域重活，自
// presentation.js 移回此处（原 lifecycle.js 分节回归）。本文件只保留 reader 域
// 的重活：进入/退出生命周期、阅读视图渲染、偏好/面板呈现、调试快照与
// presenter 通知处理体。
import {
  renderReadingStatus,
  hydrateReaderStateFromSettings,
  applyReadingViewPresentation,
  getReaderStepperConfig
} from "./presentation.js";
import { READER_CLOSE_ATTRS } from "./presentation-fields.js";

// LAYOUT (page-frame) functions this module drives:
import {
  ids,
  alignReaderViewportToPlayer,
  applyReaderPageFocus,
  clearReaderPageFocus,
  moveReadingMainInline,
  restoreReadingMainInline,
  cleanupReaderFloatingArtifacts,
  // 候选06：转写尾部留白自 player-host 迁入 page-frame（内联宿主的滚动留白）。
  updateReadingTranscriptTailSpacer
} from "./page-frame.js";
// LAYOUT (player-host) functions this module drives:
import {
  getPlayerHost,
  getReaderPlayerWrapNode,
  hasNativeReaderPlayerLayoutIssue,
  isReaderPresentationStable,
  layoutReaderPlayerHost,
  startReaderPlayerObserver,
  stopReaderPlayerObserver,
  ensureReaderPlayerMounted,
  scheduleReaderMiniPlayerDismiss,
  bindReaderHeaderActionsHover,
  cleanupReaderPlayerHost,
  unbindReaderLayout
} from "./player-host.js";
import { resetManualScrollPause, setProgrammaticScrollUntil } from "./scroll-state.js";
// 候选06 端口半边：reader 域唯一显式端口的单点注册入口（见文件尾注册区）。
import { registerReaderPorts } from "./ports.js";

// playerRetryTimer（readingPlayerRetryTimer）自 reader-impl.js 闭包迁入：属主启动
//（scheduleReaderPlayerRetry）与清除（closeReadingView、presenter reset）都在本
// 模块，直读局部变量，不再经 get/setPlayerRetryTimer 访问器。
let playerRetryTimer = 0;

// ===== 候选10 批2：字幕列表分批渲染 =====
//
// 长视频字幕可达 1500+ 条，renderReadingView 原先整段模板字符串 join 后一次性
// innerHTML，主线程被 DOM 解析卡死数百毫秒（且随后立即读 scrollHeight /
// clientHeight 强制布局）。现改为首屏只渲染前 TRANSCRIPT_FIRST_BATCH 条，其余
// 经 rAF 每帧追加 TRANSCRIPT_APPEND_BATCH 条：
//   - 事件委托在容器层（ui-renderer 绑定 + sync.js closest 委托），追加的节点
//     天然可交互，无需逐条重绑；
//   - 每批追加后调 updateReadingTranscriptTailSpacer 廉价收敛 spacer（其内部
//     带脏检查），全部渲染完成后的最终布局与整段重建等价；
//   - 跳转/跟随目标未上屏时经 ensureReadingTranscriptRenderedUpTo 同步补渲染
//     （实现由本文件尾部的 registerReaderPorts 单点注册进显式端口，供 sync.js
//     经 readerPorts.flushReadingTranscriptToIndex 回调）；
//   - 渲染期间再次 renderReadingView（切轨/重进阅读模式）先取消上一轮任务。
// 章节列表量小（几十条），保持整段渲染不变。
const TRANSCRIPT_FIRST_BATCH = 120;
const TRANSCRIPT_APPEND_BATCH = 200;

// 进行中的追加任务：{ listEl, items, cursor, withHours }。listEl 持有列表容器
// 引用（innerHTML 重建不更换容器元素，容器身份稳定；再次 renderReadingView 会
// 先 cancel 旧任务，不存在旧任务写新列表的窗口）。
let transcriptAppendTask = null;
let transcriptAppendRafId = 0;

function buildReadingTranscriptItemHtml(item, withHours) {
  return `
    <button
      type="button"
      class="boc-reading-item"
      data-index="${item.index}"
      data-seconds="${item.from}"
    >
      <span class="boc-reading-time">${escapeHtml(
        formatCompactTimestamp(item.from, withHours)
      )}</span>
      <span class="boc-reading-text">${escapeHtml(item.content)}</span>
    </button>
  `;
}

// 把 items[from, to) 追加进列表。tail spacer 必须始终是列表最后一个子节点
// （滚动定位的尾部留白依赖它），因此插入点固定在 spacer 之前。
function insertReadingTranscriptRange(listEl, items, from, to, withHours) {
  if (to <= from) {
    return;
  }
  let html = "";
  for (let i = from; i < to; i += 1) {
    html += buildReadingTranscriptItemHtml(items[i], withHours);
  }
  const spacer = document.getElementById(ids.readingTranscriptTailSpacer);
  if (spacer && spacer.parentElement === listEl) {
    spacer.insertAdjacentHTML("beforebegin", html);
  } else {
    // spacer 缺失（异常形态）时退化为尾部追加，不影响条目可用性
    listEl.insertAdjacentHTML("beforeend", html);
  }
}

function cancelReadingTranscriptAppend() {
  if (transcriptAppendRafId) {
    window.cancelAnimationFrame(transcriptAppendRafId);
    transcriptAppendRafId = 0;
  }
  transcriptAppendTask = null;
}

function scheduleReadingTranscriptAppend() {
  if (transcriptAppendRafId) {
    return;
  }
  transcriptAppendRafId = window.requestAnimationFrame(appendReadingTranscriptBatch);
}

function appendReadingTranscriptBatch() {
  transcriptAppendRafId = 0;
  const task = transcriptAppendTask;
  if (!task) {
    return;
  }
  // 列表容器已脱离文档（阅读视图整体被移除/测试 teardown）：任务作废，
  // 等下一次 renderReadingView 重建。
  if (!task.listEl?.isConnected) {
    transcriptAppendTask = null;
    return;
  }
  const end = Math.min(task.items.length, task.cursor + TRANSCRIPT_APPEND_BATCH);
  insertReadingTranscriptRange(task.listEl, task.items, task.cursor, end, task.withHours);
  task.cursor = end;
  // 每批追加后廉价收敛 spacer 高度（内部脏检查：高度没变只多一次 clientHeight 读）
  updateReadingTranscriptTailSpacer();
  if (task.cursor < task.items.length) {
    scheduleReadingTranscriptAppend();
  } else {
    transcriptAppendTask = null;
  }
}

// 跳转/跟随定位的同步补渲染：把 [cursor, targetIndex] 一次性上屏后返回 true，
// 剩余条目继续走 rAF 分批。目标已在屏内（或无进行中任务）时原样返回 true，
// 调用方（sync.js）随后照常 querySelector。
function ensureReadingTranscriptRenderedUpTo(targetIndex) {
  const task = transcriptAppendTask;
  if (!task) {
    // 无任务：要么列表为空（无目标可渲染，调用方 querySelector 落空等同旧行为），
    // 要么已全部上屏
    return true;
  }
  if (!task.listEl?.isConnected) {
    transcriptAppendTask = null;
    return true;
  }
  if (targetIndex < task.cursor) {
    return true;
  }
  const end = Math.min(task.items.length, targetIndex + 1);
  insertReadingTranscriptRange(task.listEl, task.items, task.cursor, end, task.withHours);
  task.cursor = end;
  updateReadingTranscriptTailSpacer();
  if (task.cursor >= task.items.length) {
    transcriptAppendTask = null;
  } else {
    scheduleReadingTranscriptAppend();
  }
  return true;
}

// ===== 候选06 端口半边：reader 域唯一显式端口的单点注册 =====
//
// 本模块是 reader 域的组装根（合法依赖 SYNC + LAYOUT），在模块求值时把全部
// 端口实现一次性注册进 ./ports.js：
//   - syncReadingViewPlayback / noteManualReaderInteraction：SYNC 域实现
//    （LAYOUT 两域经端口回调，替代已删除的 sync-adapter.js 注册槽）；
//   - flushReadingTranscriptToIndex → ensureReadingTranscriptRenderedUpTo：
//     本域的分批补渲染实现（SYNC 经端口回调，替代已删除的 player-host
//     setReadingTranscriptFlush 基座槽——旧槽无实现时静默返回 true，现缺失
//     即抛错）。SYNC → LIFECYCLE 是依赖图禁止的边，经端口叶子反转。
// 函数声明有提升，模块求值时表已完整；重复注册由端口侧报错拦截。
registerReaderPorts({
  syncReadingViewPlayback,
  noteManualReaderInteraction,
  flushReadingTranscriptToIndex: ensureReadingTranscriptRenderedUpTo
});

// SYNC functions this module drives (from sync.js):
import {
  startReadingViewSync,
  stopReadingViewSync,
  syncReadingViewPlayback,
  noteManualReaderInteraction,
  updateReaderFollowState
} from "./sync.js";

function maybeRefreshReaderSubtitleInBackground() {
  if (state.clip.subtitleBody.length) {
    return;
  }
  waitForVideoMetadata().then(() => {
    requestSubtitleRefresh().catch((error) => {
      if (!isStaleRunError(error)) {
        renderReadingStatus(`字幕加载失败：${getErrorMessage(error)}`);
      }
    });
  });
}

// Presenter seam 通知的 reader 侧处理体（原 bindReaderPresenter 回调函数体
// 原样搬移）。注册接线在常驻微模块 ./init-essentials.js：回调经
// ensureReaderDomain() 惰性装载本域后转发到这里，因此本函数只在 reader 域
// 装载后被调用，行为与搬迁前逐字一致。
export function handleReaderPresenterNotification(kind, text) {
  switch (kind) {
    case "reset":
      stopReadingViewSync();
      // 原 clearLayoutTimersForSyncStop 内的 playerRetryTimer 清除分支随变量
      // 迁入本模块：stopReadingViewSync 不再清它，在此补齐同等清除。
      if (playerRetryTimer) {
        window.clearTimeout(playerRetryTimer);
        playerRetryTimer = 0;
      }
      stopReaderPlayerObserver();
      break;
    case "subtitle-ready":
      if (state.reader.readingViewOpen) {
        moveReadingMainInline();
        renderReadingView();
        renderReadingStatus(String(text || "") || "抓取完成，阅读视图已同步最新字幕。");
        startReadingViewSync();
        startReaderPlayerObserver();
        syncReadingViewPlayback(true);
      }
      break;
    case "rerender":
      if (state.reader.readingViewOpen) {
        renderReadingView();
      }
      break;
    case "status":
      renderReadingStatus(String(text || ""));
      break;
    default:
      break;
  }
}

function renderReadingSubtitleSelect() {
  const select = getReaderElement(ids.readingSubtitleSelect);
  const subtitles = state.clip.subtitles || [];

  if (subtitles.length === 0) {
    select.innerHTML = '<option value="">暂无字幕</option>';
    select.disabled = true;
    return;
  }

  select.innerHTML = subtitles
    .map((item) => {
      const selectedById =
        state.clip.selectedSubtitleId && String(item.id) === String(state.clip.selectedSubtitleId);
      const selectedByUrl = item.subtitleUrl === state.clip.selectedSubtitleUrl;
      const selected = selectedById || selectedByUrl ? "selected" : "";
      const label = item.lanDoc || item.lan || "unknown";
      const isAi = isAiSubtitle(item);
      const aiTag = isAi ? " [AI]" : "";
      const optionLabel = `${label}${aiTag}`;
      return `<option value="${escapeHtml(item.subtitleUrl)}" data-lang="${escapeHtml(
        label
      )}" data-id="${escapeHtml(String(item.id || ""))}" data-isai="${isAi}" ${selected}>${escapeHtml(
        optionLabel
      )}</option>`;
    })
    .join("");
  select.disabled = false;
}
export async function enterReaderMode() {
  const readingView = getReaderElement(ids.readingView);
  state.reader.setViewOpen(true);
  state.reader.setNativePageMode(true);
  document.body.setAttribute("data-boc-reading-active", "1");
  hydrateReaderStateFromSettings(state.settings);
  applyReadingViewPresentation();
  alignReaderViewportToPlayer();
  await sleep(0);
  openReaderViewShell(readingView);
  applyReaderPageFocus();
  renderReadingView();

  const earlyPlayerHost = findReaderPlayerHost(getRuntimeVideoElement());
  if (earlyPlayerHost) {
    earlyPlayerHost.setAttribute("data-boc-reader-fading", "1");
  }

  await sleep(0);

  // Try to mount player, with more retries for slower pages (like watch later)
  const mounted = await ensureReaderPlayerMounted({ retries: 50, delayMs: 150, forceLayout: true });
  const mountedPlayerHost = getPlayerHost() || earlyPlayerHost;
  if (mountedPlayerHost) {
    mountedPlayerHost.removeAttribute("data-boc-reader-fading");
  }
  if (!mounted) {
    // Don't throw - keep UI open and keep retrying in background
    renderReadingStatus("正在等待视频播放器就绪...");
    scheduleReaderPlayerRetry();
    return;
  }

  finishEnterReaderMode();
}

function scheduleReaderPlayerRetry() {
  if (playerRetryTimer) {
    window.clearTimeout(playerRetryTimer);
    playerRetryTimer = 0;
  }
  // Keep trying to mount player in background
  const tryMount = async () => {
    playerRetryTimer = 0;
    if (!state.reader.readingViewOpen || !isReaderMode()) return;
    const mounted = await ensureReaderPlayerMounted({ retries: 10, delayMs: 200, forceLayout: true });
    const retryHost = getPlayerHost();
    if (retryHost) {
      retryHost.removeAttribute("data-boc-reader-fading");
    }
    if (mounted) {
      finishEnterReaderMode();
    } else if (state.reader.readingViewOpen) {
      playerRetryTimer = window.setTimeout(tryMount, 500);
    }
  };
  playerRetryTimer = window.setTimeout(tryMount, 500);
}

function finishEnterReaderMode() {
  if (!state.reader.readingViewOpen || !isReaderMode()) return;

  alignReaderViewportToPlayer();
  moveReadingMainInline();
  scheduleReaderMiniPlayerDismiss();
  maybeRefreshReaderSubtitleInBackground();
  syncReaderModeAfterMount();
  settleReaderModePresentation();
  bindReaderHeaderActionsHover();
}

function openReaderViewShell(readingView = getReaderElement(ids.readingView)) {
  if (!readingView) {
    return;
  }
  readingView.classList.add("open", "reader-page");
  readingView.setAttribute("aria-hidden", "false");
  setReadingViewReady(false);
  renderReadingStatus("正在准备播放器和字幕...");
}

export function waitForVideoMetadata(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const video = getRuntimeVideoElement();
      const duration = Number(video?.duration);
      const ready = video && Number.isFinite(duration) && duration > 0;
      if (ready || Date.now() - start >= timeoutMs) {
        resolve();
        return;
      }
      window.setTimeout(check, 150);
    };
    check();
  });
}

function syncReaderModeAfterMount() {
  startReadingViewSync();
  startReaderPlayerObserver();
  layoutReaderPlayerHost();
  syncReadingViewPlayback(true);
  updateReaderFollowState();
}

function settleReaderModePresentation() {
  if (!isReaderPresentationStable()) {
    setReadingViewReady(false);
    renderReadingStatus("正在稳定播放器布局...");
    scheduleReaderPlayerRetry();
    return false;
  }
  setReadingViewReady(true);
  renderReadingStatus("阅读视图已就绪，播放视频时字幕会自动高亮。");
  return true;
}

export function closeReadingView() {
  cleanupReaderFloatingArtifacts();
  state.reader.setViewOpen(false);
  state.reader.setNativePageMode(false);
  state.reader.setViewReady(false);
  state.reader.setSettingsExpanded(false);
  state.reader.setNextScrollBehavior("smooth");
  // Scroll deadlines moved to sync.js with the sync domain; reset them there
  // so a later manual interaction is never swallowed by stale deadlines.
  resetManualScrollPause();
  setProgrammaticScrollUntil(0);
  if (playerRetryTimer) {
    window.clearTimeout(playerRetryTimer);
    playerRetryTimer = 0;
  }
  const readingView = getReaderElement(ids.readingView);
  readingView.classList.remove("open", "reader-page");
  readingView.setAttribute("aria-hidden", "true");
  readingView.setAttribute("data-boc-reader-ready", "0");
  // 候选06：移除清单从呈现属性表派生（presentation-fields.js 的 clearOnClose
  // 标志），不再手抄。相对旧清单的修正：html/body 补清 transcript-visible——
  // 153b976 引入该属性时只加了写入、漏补 close 清单，属走样而非故意（守卫
  // 清理清单与 CSS 消费方均按可清除对待，详见 presentation-fields.js 头注）。
  for (const attr of READER_CLOSE_ATTRS.readingView) {
    readingView.removeAttribute(attr);
  }
  for (const attr of READER_CLOSE_ATTRS.body) {
    document.body.removeAttribute(attr);
  }
  for (const attr of READER_CLOSE_ATTRS.html) {
    document.documentElement.removeAttribute(attr);
  }
  restoreReadingMainInline();
  // 候选10 批2：关闭阅读视图时取消未完成的字幕分批追加（rAF 与任务一并作废），
  // 避免关闭后还往已脱离上下文的列表追加节点。
  cancelReadingTranscriptAppend();
  stopReadingViewSync();
  unbindReaderLayout();
  cleanupReaderPlayerHost();
  clearReaderPageFocus();
  const sendingBar = document.querySelector(".bpx-player-sending-bar");
  if (sendingBar) {
    sendingBar.setAttribute("data-boc-reader-hide-sending-bar", "1");
    sendingBar.style.setProperty("display", "none", "important");
    window.setTimeout(() => {
      sendingBar.style.removeProperty("display");
      sendingBar.removeAttribute("data-boc-reader-hide-sending-bar");
    }, 200);
  }
  window.setTimeout(() => cleanupReaderFloatingArtifacts(), 40);
  window.setTimeout(() => cleanupReaderFloatingArtifacts(), 220);
}

export function renderReadingView() {
  // 候选10 批2：渲染期间再次触发（切轨/重进阅读模式/状态重渲）时，先取消上一轮
  // 未完成的追加任务，按新数据从头分批，避免旧任务把过期条目追加进新列表。
  cancelReadingTranscriptAppend();
  const titleNode = document.querySelector(".boc-reading-title");
  const metaNode = getReaderElement(ids.readingMeta);
  const chapterList = getReaderElement(ids.readingChapterList);
  const transcriptList = getReaderElement(ids.readingTranscriptList);
  const chapters = normalizeChapters(state.clip.chapters || []);
  const body = Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
  const transcriptItems = getReadingTranscriptItems();
  const withHours = shouldShowHoursInNote(state, body);
  const hasChapters = chapters.length > 0;

  if (titleNode) {
    titleNode.textContent = state.clip.title || "B站字幕阅读";
  }
  if (metaNode) {
    metaNode.textContent = buildReadingMetaLine();
  }

  if (chapters.length === 0) {
    chapterList.innerHTML = '<div class="boc-reading-empty">当前视频没有章节。</div>';
  } else {
    chapterList.innerHTML = chapters
      .map(
        (item, index) => `
          <button
            type="button"
            class="boc-reading-chapter"
            data-index="${index}"
            data-seconds="${Number(item.from || 0) || 0}"
          >
            <span class="boc-reading-chapter-time">${escapeHtml(
              formatCompactTimestamp(item.from, withHours)
            )}</span>
            <span class="boc-reading-chapter-title">${escapeHtml(item.title)}</span>
          </button>
        `
      )
      .join("");
  }

  if (transcriptItems.length === 0) {
    transcriptList.innerHTML = `<div class="boc-reading-empty">${escapeHtml(
      getReadingTranscriptPlaceholderText()
    )}</div>`;
  } else {
    // 候选10 批2：首屏只渲染前 TRANSCRIPT_FIRST_BATCH 条，其余走 rAF 分批追加
    //（appendReadingTranscriptBatch）。首屏 HTML 形态与整段重建逐字一致。
    const firstEnd = Math.min(transcriptItems.length, TRANSCRIPT_FIRST_BATCH);
    let firstHtml = "";
    for (let i = 0; i < firstEnd; i += 1) {
      firstHtml += buildReadingTranscriptItemHtml(transcriptItems[i], withHours);
    }
    transcriptList.innerHTML = firstHtml;
    transcriptList.insertAdjacentHTML(
      "beforeend",
      `<div id="${ids.readingTranscriptTailSpacer}" class="boc-reading-tail-spacer" aria-hidden="true"></div>`
    );
    if (firstEnd < transcriptItems.length) {
      transcriptAppendTask = {
        listEl: transcriptList,
        items: transcriptItems,
        cursor: firstEnd,
        withHours
      };
      scheduleReadingTranscriptAppend();
    }
  }

  updateReaderChapterPresence(hasChapters);
  renderReadingInfoPanel();
  renderReadingSubtitleSelect();
  renderReaderPanels();
  applyReadingViewPresentation();
  updateReadingTranscriptTailSpacer();
  state.reader.setActiveSubtitleIndex(-1);
  state.reader.setActiveChapterIndex(-1);
}

// hydrateReaderStateFromSettings / applyReadingViewPresentation 已迁往
// ./presentation.js（常驻微模块）；enterReaderMode/renderReadingView 等
// 域内调用方经文件头 import 的 presentation 绑定取用。

export function updateReaderChapterPresence(hasChapters) {
  const value = hasChapters ? "1" : "0";
  const readingView = getReaderElement(ids.readingView);
  readingView.dataset.hasChapters = value;
  document.documentElement.dataset.bocReaderHasChapters = value;
  document.body.dataset.bocReaderHasChapters = value;
}

// ===== 设置面板/步进器/偏好更新（候选02：自 presentation.js 移回本域——
// 仅在阅读视图交互时执行，常驻侧经 ensureReaderDomain 转发到这些导出） =====

export function updateReaderPreferences(next, { persist = true } = {}) {
  state.reader.setTheme(normalizeReaderTheme(next.readerTheme ?? state.reader.readingTheme));
  state.reader.setFontScale(normalizeReaderFontScale(next.readerFontScale ?? state.reader.readingFontScale));
  state.reader.setLetterSpacing(
    normalizeReaderLetterSpacing(next.readerLetterSpacing ?? state.reader.readingLetterSpacing)
  );
  state.reader.setLineHeight(normalizeReaderLineHeight(next.readerLineHeight ?? state.reader.readingLineHeight));
  state.reader.setContentWidth(normalizeReaderContentWidth(next.readerContentWidth ?? state.reader.readingContentWidth));
  state.reader.setChapterVisible(next.readerChapterVisible !== undefined ? Boolean(next.readerChapterVisible) : state.reader.readingChapterVisible);
  state.reader.setTranscriptVisible(
    normalizeReaderTranscriptVisible(next.readerTranscriptVisible ?? state.reader.readingTranscriptVisible)
  );
  state.setSettings({
    ...state.settings,
    readerTheme: state.reader.readingTheme,
    readerFontScale: state.reader.readingFontScale,
    readerLetterSpacing: state.reader.readingLetterSpacing,
    readerLineHeight: state.reader.readingLineHeight,
    readerContentWidth: state.reader.readingContentWidth,
    readerChapterVisible: state.reader.readingChapterVisible,
    readerTranscriptVisible: state.reader.readingTranscriptVisible
  });
  applyReadingViewPresentation();
  renderReaderPanels();
  if (persist) {
    persistReaderSettings();
  }
}

function persistReaderSettings() {
  persistReaderSettingsThroughSeam();
}

// 步进器点击的偏好应用（原 presentation.js 私有 setReaderPreference，候选02
// 更名导出：常驻侧 bindReaderStepperControl 的监听回调经 ensureReaderDomain
// 转发到这里）。值校验/去重语义与搬迁前逐字一致。
export function applyReaderStepperPreference(settingKey, nextValue) {
  const config = getReaderStepperConfig(settingKey);
  if (!config) {
    return;
  }

  const current = config.getCurrent();
  if (!config.options.includes(nextValue) || nextValue === current) {
    return;
  }
  updateReaderPreferences(config.buildPayload(nextValue), { persist: true });
}

function renderReaderStepperState(node, settingKey) {
  const config = getReaderStepperConfig(settingKey);
  if (!node || !config) {
    return;
  }

  const current = config.getCurrent();
  node.querySelectorAll("[data-value]").forEach((button) => {
    const isActive = button.dataset.value === current;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

export function renderReaderPanels() {
  const settingsPanel = getReaderElement(ids.readingSettingsPanel);
  const settingsBtn = getReaderElement(ids.readingSettingsBtn);
  settingsPanel.hidden = !state.reader.readingSettingsExpanded;
  settingsBtn.classList.toggle("is-active", state.reader.readingSettingsExpanded);
  getReaderElement(ids.readingAutoScroll).checked = state.reader.readingAutoScroll;
  getReaderElement(ids.readingTranscriptVisible).checked = state.reader.readingTranscriptVisible;
  renderReaderStepperState(getReaderElement(ids.readingFontScaleSelect), "readerFontScale");
  renderReaderStepperState(getReaderElement(ids.readingLetterSpacingSelect), "readerLetterSpacing");
  renderReaderStepperState(getReaderElement(ids.readingLineHeightSelect), "readerLineHeight");
  renderReaderStepperState(getReaderElement(ids.readingContentWidthSelect), "readerContentWidth");
}

export function renderReadingInfoPanel() {
  const summaryNode = getReaderElement(ids.readingInfoSummary);
  const descriptionNode = getReaderElement(ids.readingInfoDescription);
  const descriptionBtn = getReaderElement(ids.readingDescriptionBtn);
  const summaryItems = buildReadingSummaryItems();
  const description = String(state.clip.description || "").trim();

  summaryNode.innerHTML =
    summaryItems.length === 0
      ? '<div class="boc-reading-empty">当前视频信息还未就绪。</div>'
      : summaryItems
          .map(
            (item) => `
              <div class="boc-reading-info-item">
                <span class="boc-reading-info-label">${escapeHtml(item.label)}</span>
                <span class="boc-reading-info-value">${escapeHtml(item.value)}</span>
              </div>
            `
          )
          .join("");

  if (!description) {
    descriptionNode.innerHTML = '<div class="boc-reading-empty">当前视频没有简介。</div>';
    descriptionNode.classList.remove("is-collapsed");
    descriptionBtn.hidden = true;
  } else {
    descriptionNode.textContent = description;
    const fullScrollHeight = descriptionNode.scrollHeight;
    descriptionNode.classList.add("is-collapsed");
    const clampedClientHeight = descriptionNode.clientHeight;
    descriptionNode.classList.toggle("is-collapsed", !state.reader.readingDescriptionExpanded);
    const hasOverflow = fullScrollHeight > clampedClientHeight + 2;
    if (!hasOverflow) {
      descriptionNode.classList.remove("is-collapsed");
      descriptionBtn.hidden = true;
      return;
    }
    descriptionBtn.hidden = false;
    descriptionBtn.textContent = state.reader.readingDescriptionExpanded ? "收起简介" : "查看更多";
  }
}

function buildReadingSummaryItems() {
  const items = [];
  if (state.clip.title) {
    items.push({ label: "标题", value: state.clip.title });
  }
  if (state.clip.author) {
    items.push({ label: "作者", value: state.clip.author });
  }
  if (state.clip.uploadDate) {
    items.push({ label: "日期", value: state.clip.uploadDate });
  }
  if (Number(state.clip.pageCount) > 1) {
    const pageParts = [`P${Number(state.clip.pageIndex) > 0 ? Number(state.clip.pageIndex) : 1}`];
    if (state.clip.pageTitle) {
      pageParts.push(state.clip.pageTitle);
    }
    items.push({ label: "分P", value: pageParts.join(" ") });
  }
  return items;
}

function buildReadingMetaLine() {
  const parts = [];
  if (state.clip.author) {
    parts.push(state.clip.author);
  }
  if (state.clip.uploadDate) {
    parts.push(state.clip.uploadDate);
  }
  parts.push("bilibili.com");
  if (Number(state.clip.pageCount) > 1) {
    const pageParts = [`P${Number(state.clip.pageIndex) > 0 ? Number(state.clip.pageIndex) : 1}`];
    if (state.clip.pageTitle) {
      pageParts.push(state.clip.pageTitle);
    }
    parts.push(pageParts.join(" "));
  }
  if (state.clip.selectedSubtitleLang) {
    parts.push(`字幕：${state.clip.selectedSubtitleLang}`);
  }
  return parts.join(" · ");
}

function setReadingViewReady(ready) {
  state.reader.setViewReady(Boolean(ready));
  const readingView = document.getElementById(ids.readingView);
  if (!readingView) {
    return;
  }
  readingView.setAttribute("data-boc-reader-ready", state.reader.readingViewReady ? "1" : "0");
  readingView.setAttribute("aria-busy", state.reader.readingViewReady ? "false" : "true");
}

// 调试快照真身（常驻侧 __BOC_READER_DEBUG_SNAPSHOT__ 经 ensureReaderDomain
// 转发到这里）。注册在 ./init-essentials.js，本函数只在 reader 域装载后可达。
export function createReaderDebugSnapshot(label = "manual") {
  const pickNodeSnapshot = (selector) => {
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
        readerHidden: node.getAttribute("data-boc-reader-hidden"),
        readerReset: node.getAttribute("data-boc-reader-player-reset")
      }
    };
  };

  const playerHostNode = getPlayerHost() || findReaderPlayerHost(getRuntimeVideoElement());
  const wrapNode = getReaderPlayerWrapNode(playerHostNode);
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
      },
      readerReset: current.getAttribute("data-boc-reader-player-reset")
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
    readyStable: isReaderPresentationStable(playerHostNode),
    hasLayoutIssue: hasNativeReaderPlayerLayoutIssue(playerHostNode),
    hasRoot: Boolean(document.getElementById(ids.root)),
    hasReadingView: Boolean(document.getElementById(ids.readingView)),
    playerHost: playerHostNode
      ? {
          tag: playerHostNode.tagName,
          id: playerHostNode.id || "",
          className: typeof playerHostNode.className === "string" ? playerHostNode.className : ""
        }
      : null,
    wrapNode: wrapNode
      ? {
          tag: wrapNode.tagName,
          id: wrapNode.id || "",
          className: typeof wrapNode.className === "string" ? wrapNode.className : ""
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
      "#boc-reading-inline-host",
      "#boc-reading-view"
    ]
      .map((selector) => pickNodeSnapshot(selector))
      .filter(Boolean),
    hostChain
  };
}

