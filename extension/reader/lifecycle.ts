// Reader shell: lifecycle + settings domain (extracted from reader-impl.js,
// formerly the shell.js segment, issue 06+).
//
// Deep module owning the reader view lifecycle (enter/close), the settings
// rendering/steppers and the page-state guards. It depends
// on the base LAYOUT layer (page-frame.js + player-host.js + hover-chrome.js)
// and on ./sync.js; neither may import it, so the dependency graph stays acyclic:
//
//   ports.js        显式回调端口叶子（本模块在文件尾单点注册全部端口实现）
//   LAYOUT          page-frame.js + player-host.js + hover-chrome.js → ports
//   SYNC            sync.js                           → LAYOUT + ports
//   LIFECYCLE       lifecycle.js（本文件）            → SYNC + LAYOUT + ports
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
  normalizeReaderSubtitleVisible
} from "../core/validators.js";
import { isReaderMode } from "../bilibili/video-id-shared.js";
import { findReaderPlayerHost, getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { getErrorMessage, isStaleRunError } from "../shared/error-helpers.js";
import {
  getReadingSubtitleItems,
  getReadingSubtitlePlaceholderText
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
// 的重活：进入/退出生命周期、阅读视图渲染、偏好/面板呈现与 presenter 通知
// 处理体（候选09 迁出：字幕分批渲染状态机 → ./batched-render.js，调试快照 →
// ./debug-snapshot.js，控制条/头部悬停 chrome → ./hover-chrome.js）。
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
  updateReadingSubtitleTailSpacer
} from "./page-frame.js";
// LAYOUT (player-host) functions this module drives:
import {
  getPlayerHost,
  isReaderPresentationStable,
  layoutReaderPlayerHost,
  startReaderPlayerObserver,
  stopReaderPlayerObserver,
  ensureReaderPlayerMounted,
  scheduleReaderMiniPlayerDismiss,
  cleanupReaderPlayerHost,
  unbindReaderLayout
} from "./player-host.js";
// 候选09：控制条自动隐藏/恢复与头部悬停 chrome 迁往 ./hover-chrome.js；本文件
// 经该模块驱动头部悬停接线（finishEnterReaderMode）。
import { bindReaderHeaderActionsHover } from "./hover-chrome.js";
import { resetManualScrollPause, setProgrammaticScrollUntil } from "./state.js";
// 候选06 端口半边：reader 域唯一显式端口的单点注册入口（见文件尾注册区）。
import { registerReaderPorts } from "./ports.js";
// 候选09：字幕分批渲染状态机（rAF 任务/游标/spacer 收敛）迁往 ./batched-render.js；
// flush 端口实现与首屏批/取消/任务启动入口经下方 import 取用。
import {
  SUBTITLE_FIRST_BATCH,
  buildReadingSubtitleItemHtml,
  cancelReadingSubtitleAppend,
  ensureReadingSubtitleRenderedUpTo,
  startReadingSubtitleAppendTask
} from "./batched-render.js";

// playerRetryTimer（readingPlayerRetryTimer）自 reader-impl.js 闭包迁入：属主启动
//（scheduleReaderPlayerRetry）与清除（closeReadingView、presenter reset）都在本
// 模块，直读局部变量，不再经 get/setPlayerRetryTimer 访问器。
let playerRetryTimer = 0;

// ===== 候选06 端口半边：reader 域唯一显式端口的单点注册 =====
//
// 本模块是 reader 域的组装根（合法依赖 SYNC + LAYOUT），在模块求值时把全部
// 端口实现一次性注册进 ./ports.js：
//   - syncReadingViewPlayback / noteManualReaderInteraction：SYNC 域实现
//    （LAYOUT 两域经端口回调，替代已删除的 sync-adapter.js 注册槽）；
//   - flushReadingSubtitleToIndex → ensureReadingSubtitleRenderedUpTo：
//     本域的分批补渲染实现（实现在 ./batched-render.js，由本模块单点注册；
//     SYNC 经端口回调，替代已删除的 player-host setReadingSubtitleFlush
//     基座槽——旧槽无实现时静默返回 true，现缺失即抛错）。SYNC → LIFECYCLE
//     是依赖图禁止的边，经端口叶子反转。
// 函数声明有提升，模块求值时表已完整；重复注册由端口侧报错拦截。
registerReaderPorts({
  syncReadingViewPlayback: syncReadingViewPlayback as (...args: unknown[]) => unknown,
  noteManualReaderInteraction: noteManualReaderInteraction as (...args: unknown[]) => unknown,
  flushReadingSubtitleToIndex: ensureReadingSubtitleRenderedUpTo as (...args: unknown[]) => unknown
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
  if (state.clip.subtitleBody.length > 0) {
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
export function handleReaderPresenterNotification(kind: string, text?: string | number | null) {
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
  const select = getReaderElement(ids.readingSubtitleSelect) as HTMLSelectElement;
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

export function waitForVideoMetadata(timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve) => {
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
  // 标志），不再手抄。相对旧清单的修正：html/body 补清 subtitle-visible——
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
  cancelReadingSubtitleAppend();
  stopReadingViewSync();
  unbindReaderLayout();
  cleanupReaderPlayerHost();
  clearReaderPageFocus();
  const sendingBar = document.querySelector<HTMLElement>(".bpx-player-sending-bar");
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
  cancelReadingSubtitleAppend();
  const titleNode = document.querySelector(".boc-reading-title");
  const metaNode = getReaderElement(ids.readingMeta);
  const chapterList = getReaderElement(ids.readingChapterList);
  const subtitleList = getReaderElement(ids.readingSubtitleList);
  const chapters = normalizeChapters(state.clip.chapters || []);
  const body = Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
  const subtitleItems = getReadingSubtitleItems();
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

  if (subtitleItems.length === 0) {
    subtitleList.innerHTML = `<div class="boc-reading-empty">${escapeHtml(
      getReadingSubtitlePlaceholderText()
    )}</div>`;
  } else {
    // 候选10 批2：首屏只渲染前 SUBTITLE_FIRST_BATCH 条，其余走 rAF 分批追加
    //（./batched-render.js 的 rAF 状态机）。首屏 HTML 形态与整段重建逐字一致。
    const firstEnd = Math.min(subtitleItems.length, SUBTITLE_FIRST_BATCH);
    let firstHtml = "";
    for (let i = 0; i < firstEnd; i += 1) {
      firstHtml += buildReadingSubtitleItemHtml(subtitleItems[i], withHours);
    }
    subtitleList.innerHTML = firstHtml;
    subtitleList.insertAdjacentHTML(
      "beforeend",
      `<div id="${ids.readingSubtitleTailSpacer}" class="boc-reading-tail-spacer" aria-hidden="true"></div>`
    );
    if (firstEnd < subtitleItems.length) {
      startReadingSubtitleAppendTask({
        listEl: subtitleList,
        items: subtitleItems,
        cursor: firstEnd,
        withHours
      });
    }
  }

  updateReaderChapterPresence(hasChapters);
  renderReadingInfoPanel();
  renderReadingSubtitleSelect();
  renderReaderPanels();
  applyReadingViewPresentation();
  updateReadingSubtitleTailSpacer();
  state.reader.setActiveSubtitleIndex(-1);
  state.reader.setActiveChapterIndex(-1);
}

// hydrateReaderStateFromSettings / applyReadingViewPresentation 已迁往
// ./presentation.js（常驻微模块）；enterReaderMode/renderReadingView 等
// 域内调用方经文件头 import 的 presentation 绑定取用。

export function updateReaderChapterPresence(hasChapters: boolean) {
  const value = hasChapters ? "1" : "0";
  const readingView = getReaderElement(ids.readingView);
  readingView.dataset.hasChapters = value;
  document.documentElement.dataset.bocReaderHasChapters = value;
  document.body.dataset.bocReaderHasChapters = value;
}

// ===== 设置面板/步进器/偏好更新（候选02：自 presentation.js 移回本域——
// 仅在阅读视图交互时执行，常驻侧经 ensureReaderDomain 转发到这些导出） =====

export function updateReaderPreferences(next: Partial<Record<string, unknown>>, { persist = true } = {}) {
  state.reader.setTheme(normalizeReaderTheme(next.readerTheme ?? state.reader.readingTheme));
  state.reader.setFontScale(normalizeReaderFontScale(next.readerFontScale ?? state.reader.readingFontScale));
  state.reader.setLetterSpacing(
    normalizeReaderLetterSpacing(next.readerLetterSpacing ?? state.reader.readingLetterSpacing)
  );
  state.reader.setLineHeight(normalizeReaderLineHeight(next.readerLineHeight ?? state.reader.readingLineHeight));
  state.reader.setContentWidth(normalizeReaderContentWidth(next.readerContentWidth ?? state.reader.readingContentWidth));
  state.reader.setChapterVisible(next.readerChapterVisible !== undefined ? Boolean(next.readerChapterVisible) : state.reader.readingChapterVisible);
  state.reader.setSubtitleVisible(
    normalizeReaderSubtitleVisible(next.readerTranscriptVisible ?? state.reader.readingSubtitleVisible)
  );
  state.setSettings({
    ...state.settings,
    readerTheme: state.reader.readingTheme,
    readerFontScale: state.reader.readingFontScale,
    readerLetterSpacing: state.reader.readingLetterSpacing,
    readerLineHeight: state.reader.readingLineHeight,
    readerContentWidth: state.reader.readingContentWidth,
    readerChapterVisible: state.reader.readingChapterVisible,
    readerTranscriptVisible: state.reader.readingSubtitleVisible
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
export function applyReaderStepperPreference(settingKey: string, nextValue: string) {
  const config = getReaderStepperConfig(settingKey as import("./presentation.js").StepperSettingKey);
  if (!config) {
    return;
  }

  const current = config.getCurrent();
  if (!config.options.includes(nextValue) || nextValue === current) {
    return;
  }
  updateReaderPreferences(config.buildPayload(nextValue), { persist: true });
}

function renderReaderStepperState(node: HTMLElement, settingKey: string) {
  const config = getReaderStepperConfig(settingKey as import("./presentation.js").StepperSettingKey);
  if (!node || !config) {
    return;
  }

  const current = config.getCurrent();
  node.querySelectorAll<HTMLElement>("[data-value]").forEach((button) => {
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
  (getReaderElement(ids.readingAutoScroll) as HTMLInputElement).checked = state.reader.readingAutoScroll;
  (getReaderElement(ids.readingSubtitleVisible) as HTMLInputElement).checked = state.reader.readingSubtitleVisible;
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

function setReadingViewReady(ready: boolean) {
  state.reader.setViewReady(Boolean(ready));
  const readingView = document.getElementById(ids.readingView);
  if (!readingView) {
    return;
  }
  readingView.setAttribute("data-boc-reader-ready", state.reader.readingViewReady ? "1" : "0");
  readingView.setAttribute("aria-busy", state.reader.readingViewReady ? "false" : "true");
}


