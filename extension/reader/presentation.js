// Reader 排版/设置呈现层（候选02 分层惰性：自 lifecycle.js / page-frame.js /
// player-host.js 迁出的常驻微模块）。
//
// 这里只收拢「启动路径必需」的轻呈现函数：阅读视图的排版应用
//（applyReadingViewPresentation）、设置水合（hydrateReaderStateFromSettings）、
// 状态栏文案（renderReadingStatus）、内联宿主呈现（applyInlineHostPresentation）
// 与步进器控件的静态模板/监听绑定（buildReaderStepperControl /
// bindReaderStepperControl）。它们是启动路径（content.js init 的 hydrate/apply、
// ui-renderer 建 UI 壳的 stepper 模板）的直接依赖——留在 lifecycle.js/
// player-host.js 会把整个 reader 域拖回常驻。
//
// 阅读视图打开后才用到的交互呈现（updateReaderPreferences / renderReaderPanels /
// renderReadingInfoPanel / renderReaderStepperState / setReaderPreference →
// applyReaderStepperPreference）已移回 lifecycle.js（reader 动态 chunk）：
// 本层与 ui-renderer 的相关回调一律经 ensureReaderDomain() 装载后调用，避免为
// 一次面板交互在常驻侧保留 ~4.5KB。
// 函数体逐字搬自原文件对应分节，行为零变化。依赖全部为常驻叶子
//（core/state、core/validators、shared/dom-utils、shared/string-utils、./ids）。
import { state } from "../core/state.js";
import { getReaderElement } from "../shared/dom-utils.js";
import {
  normalizeReaderTheme,
  normalizeReaderFontScale,
  normalizeReaderLetterSpacing,
  normalizeReaderLineHeight,
  normalizeReaderContentWidth,
  normalizeReaderTranscriptVisible
} from "../core/validators.js";
import { escapeHtml } from "../shared/string-utils.js";
import { ids } from "./ids.js";
import { ensureReaderDomain } from "../core/lazy-reader.js";

// ===== 状态栏文案（自 player-host.js 迁入；sync/lifecycle 域内继续经本模块取用） =====

export function renderReadingStatus(text) {
  const node = getReaderElement(ids.readingStatus);
  const next = String(text || "");
  // 候选10 批1：250ms tick 会反复写同一文案，值未变时跳过 textContent 写入，
  // 避免无谓的 DOM 变更（节点缺失时仍按原样经 byId 抛错，行为不变）。
  if (node.textContent === next) {
    return;
  }
  node.textContent = next;
}

// ===== 内联宿主呈现（自 page-frame.js 迁入；moveReadingMainInline 经本模块取用） =====

export function applyInlineHostPresentation() {
  const inlineHost = document.getElementById("boc-reading-inline-host");
  if (!inlineHost) {
    return;
  }
  const leftContainer = document.querySelector(".left-container");
  const bgColor = leftContainer ? getComputedStyle(leftContainer).backgroundColor : "";
  if (state.reader.readingTranscriptVisible) {
    inlineHost.style.border = "";
    inlineHost.style.background = "";
    inlineHost.style.marginTop = "";
    inlineHost.style.boxShadow = "";
    inlineHost.style.borderRadius = "";
  } else {
    inlineHost.style.border = "none";
    inlineHost.style.background = bgColor;
    inlineHost.style.marginTop = "0";
    inlineHost.style.boxShadow = "none";
    inlineHost.style.borderRadius = "0";
  }
}

// ===== 设置水合与排版应用（自 lifecycle.js 迁入） =====

export function hydrateReaderStateFromSettings(settings = state.settings) {
  state.reader.setTheme(normalizeReaderTheme(settings?.readerTheme));
  state.reader.setFontScale(normalizeReaderFontScale(settings?.readerFontScale));
  state.reader.setLetterSpacing(normalizeReaderLetterSpacing(settings?.readerLetterSpacing ?? settings?.readerLineHeight));
  state.reader.setLineHeight(normalizeReaderLineHeight(settings?.readerLineHeight));
  state.reader.setContentWidth(normalizeReaderContentWidth(settings?.readerContentWidth));
  state.reader.setChapterVisible(settings?.readerChapterVisible !== undefined ? Boolean(settings.readerChapterVisible) : true);
  state.reader.setTranscriptVisible(normalizeReaderTranscriptVisible(settings?.readerTranscriptVisible));
}

export function applyReadingViewPresentation() {
  const readingView = getReaderElement(ids.readingView);
  readingView.dataset.theme = state.reader.readingTheme;
  readingView.dataset.fontScale = state.reader.readingFontScale;
  readingView.dataset.letterSpacing = state.reader.readingLetterSpacing;
  readingView.dataset.lineHeight = state.reader.readingLineHeight;
  readingView.dataset.contentWidth = state.reader.readingContentWidth;
  readingView.dataset.chapterVisibility = state.reader.readingChapterVisible ? "auto" : "hide";
  readingView.dataset.transcriptVisible = state.reader.readingTranscriptVisible ? "1" : "0";
  document.documentElement.dataset.bocReaderTheme = state.reader.readingTheme;
  document.documentElement.dataset.bocReaderFontScale = state.reader.readingFontScale;
  document.documentElement.dataset.bocReaderLetterSpacing = state.reader.readingLetterSpacing;
  document.documentElement.dataset.bocReaderLineHeight = state.reader.readingLineHeight;
  document.documentElement.dataset.bocReaderContentWidth = state.reader.readingContentWidth;
  document.documentElement.dataset.bocReaderChapterVisibility = state.reader.readingChapterVisible ? "auto" : "hide";
  document.documentElement.dataset.bocReaderTranscriptVisible = state.reader.readingTranscriptVisible ? "1" : "0";
  document.body.dataset.bocReaderTheme = state.reader.readingTheme;
  document.body.dataset.bocReaderFontScale = state.reader.readingFontScale;
  document.body.dataset.bocReaderLetterSpacing = state.reader.readingLetterSpacing;
  document.body.dataset.bocReaderLineHeight = state.reader.readingLineHeight;
  document.body.dataset.bocReaderContentWidth = state.reader.readingContentWidth;
  document.body.dataset.bocReaderChapterVisibility = state.reader.readingChapterVisible ? "auto" : "hide";
  document.body.dataset.bocReaderTranscriptVisible = state.reader.readingTranscriptVisible ? "1" : "0";
  const readingChapterVisibleEl = getReaderElement(ids.readingChapterVisible);
  if (readingChapterVisibleEl) {
    readingChapterVisibleEl.checked = state.reader.readingChapterVisible;
  }
  const main = document.querySelector(".boc-reading-main");
  if (main) {
    main.style.display = state.reader.readingTranscriptVisible ? "" : "none";
  }
  applyInlineHostPresentation();
}

// updateReaderPreferences / persistReaderSettings / renderReaderPanels /
// renderReadingInfoPanel / buildReadingSummaryItems / renderReaderStepperState /
// setReaderPreference（现更名 applyReaderStepperPreference 导出）已移回
// lifecycle.js（reader 动态 chunk）——它们只在阅读视图交互时执行，常驻侧经
// ensureReaderDomain 转发（见下方 bindReaderStepperControl 与 ui-renderer）。

// ===== 设置面板渲染（自 lifecycle.js 迁入；仅步进器模板/绑定属启动路径） =====

function getToggleLabel(key, value) {
  const labels = {
    fontScale: { xs: "最小", s: "偏小", m: "标准", l: "偏大", xl: "最大" },
    letterSpacing: { tighter: "最紧", tight: "偏紧", normal: "标准", relaxed: "偏松", loose: "最松" },
    lineHeight: { compact: "最紧", tight: "偏紧", normal: "标准", relaxed: "偏松", loose: "最松" },
    contentWidth: { compact: "最窄", narrow: "偏窄", medium: "标准", wide: "偏宽", full: "最宽" }
  };
  return labels[key]?.[value] || "标准";
}

// 步进器配置表：buildReaderStepperControl（本模块，启动模板）与 reader 域的
// applyReaderStepperPreference/renderReaderStepperState（lifecycle.js，交互）
// 共用，故导出。
export function getReaderStepperConfig(settingKey) {
  const configs = {
    readerFontScale: {
      options: ["xs", "s", "m", "l", "xl"],
      labelKey: "fontScale",
      getCurrent: () => state.reader.readingFontScale,
      buildPayload: (value) => ({ readerFontScale: value })
    },
    readerLetterSpacing: {
      options: ["tighter", "tight", "normal", "relaxed", "loose"],
      labelKey: "letterSpacing",
      getCurrent: () => state.reader.readingLetterSpacing,
      buildPayload: (value) => ({ readerLetterSpacing: value })
    },
    readerLineHeight: {
      options: ["compact", "tight", "normal", "relaxed", "loose"],
      labelKey: "lineHeight",
      getCurrent: () => state.reader.readingLineHeight,
      buildPayload: (value) => ({ readerLineHeight: value })
    },
    readerContentWidth: {
      options: ["compact", "narrow", "medium", "wide", "full"],
      labelKey: "contentWidth",
      getCurrent: () => state.reader.readingContentWidth,
      buildPayload: (value) => ({ readerContentWidth: value })
    }
  };
  return configs[settingKey] || null;
}

export function buildReaderStepperControl({
  id,
  title,
  settingKey
}) {
  const config = getReaderStepperConfig(settingKey);
  if (!config) {
    return "";
  }
  return `
    <div id="${id}" class="boc-reading-stepper" data-reader-setting-id="${id}">
      <span class="boc-reading-stepper-title">${escapeHtml(title)}</span>
      <div class="boc-reading-stepper-buttons" role="group" aria-label="${escapeHtml(title)}">
        ${config.options
          .map(
            (option, index) => `
          <button
            type="button"
            class="boc-reading-stepper-btn"
            data-value="${escapeHtml(option)}"
            aria-label="${escapeHtml(title)} ${escapeHtml(getToggleLabel(config.labelKey, option))}"
            title="${escapeHtml(getToggleLabel(config.labelKey, option))}"
          >${index + 1}</button>
        `
          )
          .join("")}
      </div>
    </div>
  `;
}

export function bindReaderStepperControl(node, settingKey) {
  if (!node || node.dataset.bocBound === "1") {
    return;
  }

  // 候选02：偏好应用（值校验 + updateReaderPreferences）在 reader 动态 chunk 的
  // applyReaderStepperPreference（原 setReaderPreference）。监听绑定保持启动
  // 同步；回调经 ensureReaderDomain 转发（视图开着 ⇒ 域已装载，命中缓存）。
  node.addEventListener("click", (event) => {
    const button = event.target.closest("[data-value]");
    if (!button) {
      return;
    }
    ensureReaderDomain()
      .then((reader) => reader.applyReaderStepperPreference(settingKey, button.dataset.value || ""))
      .catch(() => {});
  });
  node.dataset.bocBound = "1";
}
