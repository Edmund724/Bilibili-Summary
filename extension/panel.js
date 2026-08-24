import { setMessage } from "./message.js";
import { DEFAULT_SETTINGS, normalizeDownloadFormat, sleep, formatLocalDate } from "./shared-defaults.js";
import { state, readerState, clipState, playerAiState, uiState } from "./state.js";
import {
  getSettings,
  byId,
  cleanVideoUrl,
  sendRuntimeMessage,
  requestOpenOptions,
  extractBvid,
  extractPageIndex,
  ensureRunActive,
  isStaleRunError,
  isRetryableNetworkError,
  computeCurrentClipSignature,
  getErrorMessage,
  findReaderPlayerHost,
  getRuntimeVideoElement,
  toReadableText
} from "./router.js";
import {
  readVideoTitle,
  readVideoAuthor,
  readUploadDate,
  rebuildDerivedContent
} from "./subtitle.js";
import {
  buildSubtitlePreview,
  escapeHtml,
  validateSubtitleByDuration,
  buildSubtitleSourceKey,
  clearSubtitleCacheByKey,
  saveSubtitleToCache,
  fetchSubtitleBody,
  fetchJson,
  fetchHotComments,
  buildMarkdown,
  buildSrt,
  buildTxt,
  getCurrentAid,
  normalizeHotComments,
  buildNoteFilename,
  buildFrontMatter,
  formatTimestamp,
  formatCompactTimestamp,
  normalizeSubtitleUrl,
  normalizeSubtitleUrlForCache,
  normalizeChapters,
  shouldShowHoursInNote,
  buildChapterLines,
  buildSubtitleSectionLines,
  buildHotCommentLines,
  pushOptionalLines,
  buildNotePlaceholderLines,
  buildFolderTemplateContext,
  buildFrontmatterTemplateContext,
  buildNotePlaceholderTemplateContext,
  buildSubtitleCandidates,
  buildSubtitleInfoRequests,
  groupNotePlaceholderSections,
  getEnabledFrontmatterFields,
  getFixedFrontmatterPropertyLines,
  isAiSubtitle,
  isRetryableError,
  isYamlDateValue,
  mapChaptersFromPlayerData,
  mapSubtitleTracks,
  normalizeChapterTime,
  normalizeFolder,
  normalizeNotePlaceholderSections,
  normalizeSubtitleTracks,
  parseFrontmatterArrayItems,
  pickPreferredSubtitle,
  readRuntimeVideoDuration,
  resolveFolderTemplate,
  resolveFrontmatterTemplateValue,
  sanitizeFileName,
  sanitizeFolderTemplateValue,
  shouldShowHoursInSubtitle,
  subtitlePriority,
  buildBiliApiError,
  buildBilibiliEmbedIframe,
  formatFixedPropertyYamlLine,
  formatSubtitleLine
} from "./formatters.js";
import {
  schedulePlayerAiQuickActionSync
} from "./player-ai.js";
import {
  hydrateReaderStateFromSettings,
  applyReadingViewPresentation,
  renderReadingView,
  closeReadingView,
  syncReadingViewPlayback,
  updateReaderPreferences,
  renderReaderPanels,
  renderReadingInfoPanel,
  updateReaderFollowState,
  bindReaderStepperControl,
  logInfo,
  logWarn,
  shouldDebugLog,
  ids,
  stopReadingViewSync,
  stopReaderPlayerObserver,
  extractOid,
  hasExplicitPageParam,
  pickPageFromPages,
  pickCidFromPages,
  pickDurationFromPages,
  pickPageIndexFromOid,
  startReadingViewSync,
  startReaderPlayerObserver,
  moveReadingMainInline
} from "./reader.js";

import {
  BOC_VERSION,
  CACHE_KEY_PREFIX,
  retryAsync,
  fetchVideoMeta,
  tryLoadSubtitleCandidates,
  getSubtitleCacheKey,
  resetClipState,
  refreshClip,
  onSubtitleChange,
  loadSubtitle,
  getPopupPayload,
  applyNoSubtitleState,
  readVideoDescription,
  fetchSubtitleBundle,
  refreshDerivedContent,
  copyMarkdown,
  downloadSubtitle,
  setBusyState,
  setStatus,
  renderMeta,
  renderSubtitleSelect
} from "./subtitle-fetcher.js";

export {
  BOC_VERSION,
  CACHE_KEY_PREFIX,
  retryAsync,
  fetchVideoMeta,
  tryLoadSubtitleCandidates,
  getSubtitleCacheKey,
  resetClipState,
  refreshClip,
  onSubtitleChange,
  loadSubtitle,
  getPopupPayload,
  applyNoSubtitleState,
  readVideoDescription,
  fetchSubtitleBundle,
  refreshDerivedContent,
  copyMarkdown,
  downloadSubtitle,
  setBusyState,
  setStatus,
  renderMeta,
  renderSubtitleSelect
};

export function buildUiHtml() {
  return `
    <aside id="${ids.panel}" aria-hidden="true">
      <header class="boc-header">
        <strong>Default</strong>
        <div class="boc-header-actions">
          <button id="${ids.settingsBtn}" type="button" title="插件设置">设置</button>
          <button id="${ids.closeBtn}" type="button" title="关闭">关闭</button>
        </div>
      </header>

      <p id="${ids.status}" class="boc-status">准备就绪，点击“刷新抓取”开始。</p>
      <div class="boc-props-head">属性</div>
      <div id="${ids.meta}" class="boc-meta"></div>

      <label class="boc-label" for="${ids.subtitleSelect}">字幕语言</label>
      <select id="${ids.subtitleSelect}" disabled>
        <option value="">暂无字幕</option>
      </select>

      <label class="boc-label" for="${ids.preview}">字幕预览</label>
      <textarea id="${ids.preview}" readonly></textarea>

      <div class="boc-actions">
        <button id="${ids.refreshBtn}" type="button">刷新抓取</button>
        <button id="${ids.copyBtn}" type="button">复制完整 Markdown</button>
        <button id="${ids.downloadBtn}" type="button">下载字幕</button>
      </div>
      <p id="${ids.message}" class="boc-message"></p>
    </aside>

    <section id="${ids.readingView}" aria-hidden="true" data-boc-reader-ready="0" aria-busy="true">
      <div class="boc-reading-layout">
        <aside class="boc-reading-rail">
          <div class="boc-reading-eyebrow">章节</div>
          <div id="${ids.readingChapterList}" class="boc-reading-list"></div>
        </aside>

        <section class="boc-reading-stage">
          <header class="boc-reading-header">
            <div class="boc-reading-header-copy">
              <strong class="boc-reading-title">${escapeHtml(state.clip.title || "B站字幕阅读")}</strong>
              <div id="${ids.readingMeta}" class="boc-reading-meta">bilibili.com</div>
            </div>
            <div class="boc-reading-actions">
              <button id="${ids.readingThemeSelect}" type="button" class="boc-reading-icon-btn" title="主题" aria-label="切换主题">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
              </button>
              <button id="${ids.readingSettingsBtn}" type="button" class="boc-reading-icon-btn" title="设置" aria-label="设置">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
              <button id="${ids.readingCloseBtn}" type="button" class="boc-reading-icon-btn" title="退出" aria-label="退出阅读视图">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
          </header>

          <section id="${ids.readingSettingsPanel}" class="boc-reading-panel boc-reading-settings-panel" hidden>
            <section class="boc-reading-settings-group">
              <div class="boc-reading-eyebrow">排版</div>
              <div class="boc-reading-stepper-list">
                ${buildReaderStepperControl({
                  id: ids.readingFontScaleSelect,
                  title: "字号",
                  settingKey: "readerFontScale"
                })}
                ${buildReaderStepperControl({
                  id: ids.readingLetterSpacingSelect,
                  title: "字间距",
                  settingKey: "readerLetterSpacing"
                })}
                ${buildReaderStepperControl({
                  id: ids.readingLineHeightSelect,
                  title: "行间距",
                  settingKey: "readerLineHeight"
                })}
                ${buildReaderStepperControl({
                  id: ids.readingContentWidthSelect,
                  title: "正文宽度",
                  settingKey: "readerContentWidth"
                })}
              </div>
            </section>

            <section class="boc-reading-settings-group">
              <div class="boc-reading-controls">
                <label class="boc-reading-toggle boc-reading-toggle-inline">
                  <input id="${ids.readingAutoScroll}" type="checkbox" checked />
                  <span>滚动</span>
                </label>
                <label class="boc-reading-toggle boc-reading-toggle-inline">
                  <input id="${ids.readingTranscriptVisible}" type="checkbox" checked />
                  <span>字幕</span>
                </label>
                <label class="boc-reading-toggle boc-reading-toggle-inline">
                  <input id="${ids.readingChapterVisible}" type="checkbox" checked />
                  <span>章节</span>
                </label>
              </div>
            </section>

            <section class="boc-reading-settings-group">
              <div class="boc-reading-controls">
                <select id="${ids.readingSubtitleSelect}" class="boc-reading-select boc-reading-select-sm" aria-label="字幕语言">
                </select>
              </div>
            </section>

            <section class="boc-reading-settings-group boc-reading-info-group">
              <div class="boc-reading-eyebrow">视频摘要</div>
              <div id="${ids.readingInfoSummary}" class="boc-reading-info-list"></div>
            </section>
            <section class="boc-reading-settings-group boc-reading-info-group">
              <div class="boc-reading-eyebrow">视频简介</div>
              <div id="${ids.readingInfoDescription}" class="boc-reading-info-copy"></div>
              <button id="${ids.readingDescriptionBtn}" type="button" class="boc-reading-text-btn">展开简介</button>
            </section>
          </section>

          <p id="${ids.readingStatus}" class="boc-reading-status">使用页面原生播放器联动章节和字幕。</p>

          <div class="boc-reading-player-shell">
            <div id="${ids.readingPlayerSlot}" class="boc-reading-player-slot"></div>
          </div>

          <section class="boc-reading-main">
            <div id="${ids.readingTranscriptList}" class="boc-reading-transcript"></div>
          </section>
        </section>
      </div>
    </section>
  `;
}

export function bindUiEvents() {
  const panel = byId(ids.panel);
  const closeBtn = byId(ids.closeBtn);
  const refreshBtn = byId(ids.refreshBtn);
  const select = byId(ids.subtitleSelect);
  const copyBtn = byId(ids.copyBtn);
  const downloadBtn = byId(ids.downloadBtn);
  const settingsBtn = byId(ids.settingsBtn);
  const readingView = byId(ids.readingView);
  const readingCloseBtn = byId(ids.readingCloseBtn);
  const readingAutoScroll = byId(ids.readingAutoScroll);
  const readingTranscriptVisible = byId(ids.readingTranscriptVisible);
  const readingThemeSelect = byId(ids.readingThemeSelect);
  const readingSettingsToggleBtn = byId(ids.readingSettingsBtn);
  const readingFontScaleSelect = byId(ids.readingFontScaleSelect);
  const readingLetterSpacingSelect = byId(ids.readingLetterSpacingSelect);
  const readingLineHeightSelect = byId(ids.readingLineHeightSelect);
  const readingContentWidthSelect = byId(ids.readingContentWidthSelect);
  const readingDescriptionBtn = byId(ids.readingDescriptionBtn);
  const chapterList = byId(ids.readingChapterList);
  const transcriptList = byId(ids.readingTranscriptList);

  closeBtn.addEventListener("click", () => panel.classList.remove("open"));
  refreshBtn.addEventListener("click", refreshClip);
  select.addEventListener("change", onSubtitleChange);
  copyBtn.addEventListener("click", copyMarkdown);
  downloadBtn.addEventListener("click", downloadSubtitle);
  settingsBtn.addEventListener("click", requestOpenOptions);
  readingCloseBtn.addEventListener("click", () => {
    if (isReaderMode()) {
      replaceReaderModeUrl(stripReaderModeUrl(location.href));
    }
    closeReadingView();
  });
  readingAutoScroll.addEventListener("change", (event) => {
    state.reader.readingAutoScroll = Boolean(event.target.checked);
    if (state.reader.readingAutoScroll) {
      state.reader.readingManualScrollPauseUntil = 0;
      syncReadingViewPlayback(true);
    }
    updateReaderFollowState();
  });
  readingTranscriptVisible.addEventListener("change", (event) => {
    updateReaderPreferences({ readerTranscriptVisible: Boolean(event.target.checked) }, { persist: true });
    const main = document.querySelector(".boc-reading-main");
    if (main) {
      main.style.display = event.target.checked ? "" : "none";
    }
  });
  const readingChapterVisible = byId(ids.readingChapterVisible);
  if (readingChapterVisible) {
    readingChapterVisible.addEventListener("change", (event) => {
      updateReaderPreferences({ readerChapterVisible: Boolean(event.target.checked) }, { persist: true });
    });
  }
  readingThemeSelect.addEventListener("click", () => {
    const themes = ["light", "dark", "paper"];
    const current = state.reader.readingTheme || "light";
    const nextIndex = (themes.indexOf(current) + 1) % themes.length;
    updateReaderPreferences({ readerTheme: themes[nextIndex] }, { persist: true });
    readingThemeSelect.classList.add("is-active");
    setTimeout(() => readingThemeSelect.classList.remove("is-active"), 300);
  });
  readingSettingsToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    state.reader.readingSettingsExpanded = !state.reader.readingSettingsExpanded;
    renderReaderPanels();
  });
  readingDescriptionBtn.addEventListener("click", () => {
    state.reader.readingDescriptionExpanded = !state.reader.readingDescriptionExpanded;
    renderReadingInfoPanel();
  });
  bindReaderStepperControl(readingFontScaleSelect, "readerFontScale");
  bindReaderStepperControl(readingLetterSpacingSelect, "readerLetterSpacing");
  bindReaderStepperControl(readingLineHeightSelect, "readerLineHeight");
  bindReaderStepperControl(readingContentWidthSelect, "readerContentWidth");

  const readingSubtitleSelect = byId(ids.readingSubtitleSelect);
  readingSubtitleSelect.addEventListener("change", (event) => {
    const option = event.target.options[event.target.selectedIndex];
    const url = String(option?.value || "");
    if (!url) return;
    loadSubtitle(url, String(option.dataset.lang || "unknown"), state.clip.fetchRunId, String(option.dataset.id || ""))
      .then(() => {
        renderReadingView();
        syncReadingViewPlayback(true);
      })
      .catch((error) => {
        logWarn("[BOC] failed to switch subtitle in reading view", error);
      });
  });

  // Click outside settings panel to close
  if (!state.reader.readingDocumentClickBound) {
    document.addEventListener("click", (e) => {
      if (!state.reader.readingSettingsExpanded) return;
      const settingsPanel = document.getElementById(ids.readingSettingsPanel);
      const settingsBtnEl = document.getElementById(ids.readingSettingsBtn);
      if (!settingsPanel || !settingsBtnEl) {
        return;
      }
      if (!settingsPanel.contains(e.target) && !settingsBtnEl.contains(e.target)) {
        state.reader.readingSettingsExpanded = false;
        renderReaderPanels();
      }
    });
    state.reader.readingDocumentClickBound = true;
  }

  const handleReaderManualScroll = () => {
    if (Date.now() <= state.reader.readingProgrammaticScrollUntil) {
      return;
    }
    noteManualReaderInteraction();
  };
  transcriptList.addEventListener("scroll", handleReaderManualScroll);
  transcriptList.addEventListener("wheel", handleReaderManualScroll, { passive: true });
  chapterList.addEventListener("wheel", handleReaderManualScroll, { passive: true });
  chapterList.addEventListener("pointerdown", () => noteManualReaderInteraction(3500));
  transcriptList.addEventListener("pointerdown", () => noteManualReaderInteraction(3500));
  chapterList.addEventListener("click", onReadingChapterClick);
  transcriptList.addEventListener("click", onReadingTranscriptClick);
  readingView.addEventListener("transitionend", () => {
    if (!state.reader.readingViewOpen) {
      stopReadingViewSync();
    }
  });
}

export function ensureUiReady({ forceRecreate = false } = {}) {
  const existingRoot = document.getElementById(ids.root);
  if (existingRoot && forceRecreate) {
    existingRoot.remove();
    state.ui.uiEventsBound = false;
  }

  let root = document.getElementById(ids.root);
  if (!root) {
    root = document.createElement("div");
    root.id = ids.root;
    root.innerHTML = buildUiHtml();
    document.body.appendChild(root);
    state.ui.uiEventsBound = false;
  }

  if (!state.ui.uiEventsBound) {
    bindUiEvents();
    state.ui.uiEventsBound = true;
  }
}
