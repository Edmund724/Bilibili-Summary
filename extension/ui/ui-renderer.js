import { state, uiState } from "../core/state.js";
import { byId } from "../shared/dom-utils.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { getErrorMessage, toReadableText, isExtensionContextInvalidated } from "../shared/error-helpers.js";
import { replaceReaderModeUrl } from "../bilibili/reader-url.js";
import {
  isReaderMode,
  stripReaderModeUrl
} from "../bilibili/video-id-shared.js";
import { escapeHtml } from "../shared/string-utils.js";
import { READING_HEADER_ICONS } from "./reading-header-icons.js";
// 候选02 分层惰性：本模块保持常驻（ensureUiReady 启动建 UI 壳），静态 import
// 只允许常驻叶子——reader 私有 id 表（./reader/ids.js）、轻呈现（./reader/
// presentation.js）、状态 accessor（./reader/view-state.js）与共享滚动叶子
//（./reader/scroll-state.js）。reader 重域（sync/lifecycle 的交互处理）与
// 总结链（fetcher/subtitle-ui）一律在回调内经 ensure 动态装载后调用：注册
// 监听是启动同步操作，监听体只有用户操作/视图交互时才执行。
import { ids } from "../reader/ids.js";
import {
  buildReaderStepperControl,
  bindReaderStepperControl
} from "../reader/presentation.js";
import { isReaderViewOpen } from "../reader/view-state.js";
// 滚动暂停 / 程序化滚动状态位于 reader 域的共享叶子模块（不再经 reader/index.js 转发）
import { resetManualScrollPause, isProgrammaticScrolling } from "../reader/scroll-state.js";
// 日志直接取自 shared/logging.js（不再经 reader/index.js 转发）
import { logWarn } from "../shared/logging.js";
// 总结链与 reader 域的按需加载器（常驻轻文件，动态边在其内部）。
import { ensureSummarizeChain } from "../subtitle/lazy.js";
import { ensureReaderDomain } from "../core/lazy-reader.js";

// 打开设置页（原 core/runtime.js 提供；因 runtime 不得依赖 ui 域，且本模块是
// 唯一使用方，搬到此处）。成功无提示；失败按扩展上下文是否失效给出对应文案。
function requestOpenOptions() {
  sendRuntimeMessage({ type: "open-options" })
    .then((resp) => {
      if (!resp?.ok) {
        setMessage(`打开设置失败：${toReadableText(resp?.error, "未知错误")}`);
      }
    })
    .catch((error) => {
      if (isExtensionContextInvalidated(error)) {
        setMessage("扩展刚刚更新，请刷新当前页面后重试。");
        return;
      }
      setMessage(`打开设置失败：${getErrorMessage(error)}`);
    });
}

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
                ${READING_HEADER_ICONS.theme}
              </button>
              <button id="${ids.readingSettingsBtn}" type="button" class="boc-reading-icon-btn" title="设置" aria-label="设置">
                ${READING_HEADER_ICONS.settings}
              </button>
              <button id="${ids.readingCloseBtn}" type="button" class="boc-reading-icon-btn" title="退出" aria-label="退出阅读视图">
                ${READING_HEADER_ICONS.close}
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
  // ===== 总结链按钮回调（候选02）：refreshClip/onSubtitleChange/copyMarkdown/
  // downloadSubtitle 属链层，点击时经 ensureSummarizeChain 装载后调用（首次
  // 点击多一次本地动态 import ~10ms；promise 缓存后为直取）。
  refreshBtn.addEventListener("click", () => {
    ensureSummarizeChain()
      .then((chain) => chain.refreshClip())
      .catch((error) => logWarn("[BOC] refresh clip failed", error));
  });
  select.addEventListener("change", (event) => {
    ensureSummarizeChain()
      .then((chain) => chain.onSubtitleChange(event))
      .catch((error) => logWarn("[BOC] subtitle change failed", error));
  });
  copyBtn.addEventListener("click", () => {
    ensureSummarizeChain()
      .then((chain) => chain.copyMarkdown())
      .catch((error) => logWarn("[BOC] copy markdown failed", error));
  });
  downloadBtn.addEventListener("click", () => {
    ensureSummarizeChain()
      .then((chain) => chain.downloadSubtitle())
      .catch((error) => logWarn("[BOC] download subtitle failed", error));
  });
  settingsBtn.addEventListener("click", requestOpenOptions);
  // ===== 阅读视图交互回调（候选02）：closeReadingView/sync/click 等属 reader
  // 重域，交互时经 ensureReaderDomain 装载后调用（视图开着 ⇒ 域几乎必然已装载
  // ，ensure 命中缓存 promise）。
  readingCloseBtn.addEventListener("click", () => {
    if (isReaderMode()) {
      replaceReaderModeUrl(stripReaderModeUrl(location.href));
    }
    ensureReaderDomain()
      .then((reader) => reader.closeReadingView())
      .catch((error) => logWarn("[BOC] close reading view failed", error));
  });
  readingAutoScroll.addEventListener("change", (event) => {
    state.reader.setAutoScroll(Boolean(event.target.checked));
    if (state.reader.readingAutoScroll) {
      resetManualScrollPause();
    }
    ensureReaderDomain()
      .then((reader) => {
        if (state.reader.readingAutoScroll) {
          reader.syncReadingViewPlayback(true);
        }
        reader.updateReaderFollowState();
      })
      .catch((error) => logWarn("[BOC] reader autoscroll sync failed", error));
  });
  readingTranscriptVisible.addEventListener("change", (event) => {
    // 候选02：updateReaderPreferences 属 reader 动态 chunk（视图开着 ⇒ 已装载），
    // 经 ensure 转发；手动兜底的 main 显隐写在偏好应用之后（与旧顺序一致）。
    ensureReaderDomain()
      .then((reader) => {
        reader.updateReaderPreferences({ readerTranscriptVisible: Boolean(event.target.checked) }, { persist: true });
        const main = document.querySelector(".boc-reading-main");
        if (main) {
          main.style.display = event.target.checked ? "" : "none";
        }
      })
      .catch((error) => logWarn("[BOC] reader transcript visibility failed", error));
  });
  const readingChapterVisible = byId(ids.readingChapterVisible);
  if (readingChapterVisible) {
    readingChapterVisible.addEventListener("change", (event) => {
      ensureReaderDomain()
        .then((reader) =>
          reader.updateReaderPreferences({ readerChapterVisible: Boolean(event.target.checked) }, { persist: true })
        )
        .catch((error) => logWarn("[BOC] reader chapter visibility failed", error));
    });
  }
  readingThemeSelect.addEventListener("click", () => {
    const themes = ["light", "dark", "paper"];
    const current = state.reader.readingTheme || "light";
    const nextIndex = (themes.indexOf(current) + 1) % themes.length;
    ensureReaderDomain()
      .then((reader) => {
        reader.updateReaderPreferences({ readerTheme: themes[nextIndex] }, { persist: true });
        readingThemeSelect.classList.add("is-active");
        setTimeout(() => readingThemeSelect.classList.remove("is-active"), 300);
      })
      .catch((error) => logWarn("[BOC] reader theme switch failed", error));
  });
  readingSettingsToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    state.reader.setSettingsExpanded(!state.reader.readingSettingsExpanded);
    ensureReaderDomain()
      .then((reader) => reader.renderReaderPanels())
      .catch((error) => logWarn("[BOC] reader panels render failed", error));
  });
  readingDescriptionBtn.addEventListener("click", () => {
    state.reader.setDescriptionExpanded(!state.reader.readingDescriptionExpanded);
    ensureReaderDomain()
      .then((reader) => reader.renderReadingInfoPanel())
      .catch((error) => logWarn("[BOC] reader info panel render failed", error));
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
    // 候选02：loadSubtitle 属总结链、renderReadingView/sync 属 reader 域——
    // 按层各自 ensure 后串联，顺序与搬迁前一致（先装载字幕，再重渲与同步）。
    ensureSummarizeChain()
      .then((chain) =>
        chain.loadSubtitle(url, String(option.dataset.lang || "unknown"), state.clip.fetchRunId, String(option.dataset.id || ""))
      )
      .then(() => ensureReaderDomain())
      .then((reader) => {
        reader.renderReadingView();
        reader.syncReadingViewPlayback(true);
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
        state.reader.setSettingsExpanded(false);
        ensureReaderDomain()
          .then((reader) => reader.renderReaderPanels())
          .catch(() => {});
      }
    });
    state.reader.readingDocumentClickBound = true;
  }

  const handleReaderManualScroll = () => {
    if (isProgrammaticScrolling()) {
      return;
    }
    // 高频路径：首次交互装载 reader 域，其后命中缓存 promise；装载失败静默
    // （下次交互自然重试，避免滚动期间刷日志）。
    ensureReaderDomain()
      .then((reader) => reader.noteManualReaderInteraction())
      .catch(() => {});
  };
  transcriptList.addEventListener("scroll", handleReaderManualScroll);
  transcriptList.addEventListener("wheel", handleReaderManualScroll, { passive: true });
  chapterList.addEventListener("wheel", handleReaderManualScroll, { passive: true });
  chapterList.addEventListener("pointerdown", () => {
    ensureReaderDomain()
      .then((reader) => reader.noteManualReaderInteraction(3500))
      .catch(() => {});
  });
  transcriptList.addEventListener("pointerdown", () => {
    ensureReaderDomain()
      .then((reader) => reader.noteManualReaderInteraction(3500))
      .catch(() => {});
  });
  chapterList.addEventListener("click", (event) => {
    ensureReaderDomain()
      .then((reader) => reader.onReadingChapterClick(event))
      .catch(() => {});
  });
  transcriptList.addEventListener("click", (event) => {
    ensureReaderDomain()
      .then((reader) => reader.onReadingTranscriptClick(event))
      .catch(() => {});
  });
  readingView.addEventListener("transitionend", () => {
    if (!isReaderViewOpen()) {
      ensureReaderDomain()
        .then((reader) => reader.stopReadingViewSync())
        .catch(() => {});
    }
  });
}

export function ensureUiReady({ forceRecreate = false } = {}) {
  const existingRoot = document.getElementById(ids.root);
  if (existingRoot && forceRecreate) {
    existingRoot.remove();
    uiState.setEventsBound(false);
  }

  let root = document.getElementById(ids.root);
  if (!root) {
    root = document.createElement("div");
    root.id = ids.root;
    root.innerHTML = buildUiHtml();
    document.body.appendChild(root);
    uiState.setEventsBound(false);
  }

  if (!state.ui.uiEventsBound) {
    bindUiEvents();
    uiState.setEventsBound(true);
  }
}

export function setBusyState(disabled) {
  byId(ids.copyBtn).disabled = disabled;
  byId(ids.downloadBtn).disabled = disabled;
  byId(ids.refreshBtn).disabled = disabled;
  byId(ids.settingsBtn).disabled = disabled;
  byId(ids.subtitleSelect).disabled = disabled || state.clip.subtitles.length === 0;
}

// renderMeta / renderSubtitleSelect 已移往 subtitle/ui.js（候选02 分层惰性）：
// 两者只渲染「抓取结果」（视频属性 + 字幕轨列表），唯一调用方是总结链
//（fetcher 的抓取收尾/重置）与 message-handler 的 popup-select-subtitle
//（该处理器本就经 ensureSummarizeChain 装载链后调用）。留在本模块会把
// selection.js（isAiSubtitle）及其依赖 cache/cache-lru 拖回常驻。
// setStatus/setMessage 保留：URL 变化编排与本模块自身的错误提示在启动期使用。

export function setStatus(text) {
  uiState.setStatusText(String(text || ""));
  byId(ids.status).textContent = state.ui.statusText;
}

export function setMessage(text) {
  uiState.setMessageText(String(text || ""));
  byId(ids.message).textContent = state.ui.messageText;
}
