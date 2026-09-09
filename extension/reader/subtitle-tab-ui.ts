// 字幕 tab 的模板段 + 绑定段（arch-slim-2/06：自 ui/ui-renderer.ts 下放同居）。
//
// 覆盖字幕 tab body 的四段壳结构：工具条（句内搜索 + 字幕轨 select + 复制/
// 导出，PR3）、转写中间态横幅（显隐由 reader/transcribe-banner.ts 驱动，
// 「谁绑定谁拥有」裁定：横幅无事件绑定、布局上属字幕 tab 排版序列，模板随
// 字幕 tab 叶子走；驱动逻辑不动）、字幕列表容器（分批渲染目标）、Follow
// playback 悬浮按钮。绑定段为对应交互接线，handler 逻辑保持各域单源：
//   - 搜索输入/键盘 → reader/subtitle-search.ts（refresh/move 转发，重域经
//     ui/reader-gate.ts 的 withReader 动态装载）；
//   - 字幕轨切换 → subtitle/lazy.ts 的 ensureSummarizeChain（loadSubtitle 属
//     总结链）+ reader 域重渲/同步串联；
//   - 复制/导出 → 总结链 copySubtitleTranscript/downloadSubtitle（实现就在
//     subtitle/ui.ts，零转发）；
//   - Follow 按钮 / 列表 scroll/wheel/pointerdown/click → reader/sync.ts
//     （noteManualReaderInteraction/onReadingSubtitleClick/resumeReaderFollowPlayback）。
//
// 本模块是壳可静态携带的轻叶子：不 import reader 重域与总结链重实现，动态
// 边全部在 ui/reader-gate.ts 与 subtitle/lazy.ts 内部（chunk 边不变形）。
// 绑定随壳构建（bindUiEvents）同步执行、forceRecreate 重建后随壳重绑。

import { state } from "../core/state.js";
import { byId } from "../shared/dom-utils.js";
import { logWarn } from "../shared/logging.js";
import { ensureSummarizeChain } from "../subtitle/lazy.js";
import { isProgrammaticScrolling, ids } from "./state.js";
import { withReader } from "../ui/reader-gate.js";

export function buildSubtitleTabBodyHtml(): string {
  return `
            <div class="boc-reading-sub-toolbar">
              <div class="boc-reading-search">
                <input
                  id="${ids.readingSearchInput}"
                  class="boc-reading-search-input"
                  type="text"
                  placeholder="搜索字幕…"
                  aria-label="搜索字幕"
                />
                <span id="${ids.readingSearchCount}" class="boc-reading-search-count" aria-live="polite"></span>
                <button
                  id="${ids.readingSearchPrevBtn}"
                  type="button"
                  class="boc-reading-search-nav"
                  title="上一条（Shift+Enter）"
                  aria-label="上一条搜索结果"
                  disabled
                >↑</button>
                <button
                  id="${ids.readingSearchNextBtn}"
                  type="button"
                  class="boc-reading-search-nav"
                  title="下一条（Enter）"
                  aria-label="下一条搜索结果"
                  disabled
                >↓</button>
              </div>
              <select id="${ids.readingSubtitleSelect}" class="boc-reading-select boc-reading-select-sm" aria-label="字幕语言"></select>
              <button id="${ids.readingCopySubtitleBtn}" type="button" class="boc-reading-mini-btn">复制</button>
              <button id="${ids.readingExportSubtitleBtn}" type="button" class="boc-reading-mini-btn">导出</button>
            </div>

            <!-- 转写中间态（PR3）：显隐由 reader/transcribe-banner.ts 按
                 shared/subtitle-status-bus 的进程内相位驱动；进度为不确定样式
                 （页面侧拿不到片 x/y），进度行实时显示状态栏文本 -->
            <aside id="${ids.readingTranscribeBanner}" class="boc-reading-asr-banner" hidden>
              <div class="boc-reading-asr-title">该视频无字幕，正在进行音频转写…</div>
              <p class="boc-reading-asr-copy">转写完成后字幕与概览将自动出现，期间可先看视频</p>
              <div class="boc-reading-asr-track" aria-hidden="true"><div class="boc-reading-asr-fill"></div></div>
              <div id="${ids.readingTranscribeProgress}" class="boc-reading-asr-foot">正在准备转写…</div>
            </aside>

            <section class="boc-reading-main">
              <div id="${ids.readingSubtitleList}" class="boc-reading-subtitle"></div>
            </section>

            <!-- Follow playback 悬浮按钮：显隐只由 data-boc-reader-follow
                 （manual/auto）的 CSS 驱动，点击恢复跟随并跳回当前句 -->
            <button id="${ids.readingFollowBtn}" type="button" class="boc-reading-follow-btn">↓ 跟随播放</button>
  `;
}

export function bindSubtitleTabEvents(): void {
  // ===== 字幕轨切换 =====
  // loadSubtitle 属总结链；重渲/同步由 loadSubtitle 内字幕接受事务的
  // subtitle-ready 通知驱动（唯一 emit 点，见 commit.ts），此处补调即双渲染。
  byId(ids.readingSubtitleSelect).addEventListener("change", async (event) => {
    const selectTarget = event.target as HTMLSelectElement;
    const option = selectTarget.options[selectTarget.selectedIndex];
    const url = String(option?.value || "");
    if (!url) return;
    try {
      const chain = await ensureSummarizeChain();
      await chain.loadSubtitle(url, String(option.dataset.lang || "unknown"), state.clip.fetchRunId, String(option.dataset.id || ""));
    } catch (error) {
      logWarn("[BOC] failed to switch subtitle in reading view", error);
    }
  });

  const readingSearchInput = byId(ids.readingSearchInput) as HTMLInputElement;
  // ===== PR3 句内搜索（输入/键盘/上下条）：搜索状态与高亮逻辑在
  // reader/subtitle-search.ts（重域：补渲染走分批渲染状态机），交互回调经
  // ui/reader-gate 的 withReader 装载后转发（首次输入多一次本地动态 import，
  // 其后命中缓存 promise，与滚动/点击回调同款）。
  //
  // input 路径 180ms trailing 防抖：逐键的全量流水线（清高亮→matchAll→逐命中
  // DOM 重建→smooth scroll）聚簇为停顿后一次。防抖状态挂本函数闭包（随壳
  // forceRecreate 重建自然重置，与 handleReaderManualScroll 先例同款）。防抖只
  // 包 input 事件；Enter/Escape/prev/next 先冲刷未兑现的防抖再动作——
  // moveReadingSubtitleSearch 读模块闭包 matches（不读输入框），不冲刷就会在
  // 旧词的匹配上导航。重渲重放路径（lifecycle 渲染尾部 refresh({scroll:false})）
  // 不走防抖，高亮即时恢复。
  const SEARCH_DEBOUNCE_MS = 180;
  let searchDebounceTimer: number | null = null;
  const searchRefresh = () => {
    withReader("subtitle search refresh", (reader) => reader.refreshReadingSubtitleSearch());
  };
  const flushSearchDebounce = () => {
    if (searchDebounceTimer === null) {
      return;
    }
    window.clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
    searchRefresh();
  };
  readingSearchInput.addEventListener("input", () => {
    if (searchDebounceTimer !== null) {
      window.clearTimeout(searchDebounceTimer);
    }
    searchDebounceTimer = window.setTimeout(() => {
      searchDebounceTimer = null;
      searchRefresh();
    }, SEARCH_DEBOUNCE_MS);
  });
  readingSearchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    flushSearchDebounce();
    withReader("subtitle search keydown", (reader) => {
      if (event.key === "Enter") {
        reader.moveReadingSubtitleSearch(event.shiftKey ? -1 : 1);
        return;
      }
      // Escape：清输入恢复原文本（焦点留在输入框便于再次输入）
      readingSearchInput.value = "";
      reader.refreshReadingSubtitleSearch({ scroll: false });
      readingSearchInput.focus();
    });
  });
  byId(ids.readingSearchPrevBtn).addEventListener("click", () => {
    flushSearchDebounce();
    withReader("subtitle search prev", (reader) => reader.moveReadingSubtitleSearch(-1));
  });
  byId(ids.readingSearchNextBtn).addEventListener("click", () => {
    flushSearchDebounce();
    withReader("subtitle search next", (reader) => reader.moveReadingSubtitleSearch(1));
  });

  // ===== PR3 复制 / 导出（纯接线，逻辑在总结链 subtitle/ui.ts） =====
  // 复制 = 字幕纯文本（copySubtitleTranscript，buildTxt 管线，transcript 语义）；
  // 导出 = SRT/TXT（downloadSubtitle，按 downloadFormat 设置）。
  byId(ids.readingCopySubtitleBtn).addEventListener("click", async () => {
    try {
      const chain = await ensureSummarizeChain();
      await chain.copySubtitleTranscript();
    } catch (error) {
      logWarn("[BOC] copy subtitle transcript failed", error);
    }
  });
  byId(ids.readingExportSubtitleBtn).addEventListener("click", async () => {
    try {
      const chain = await ensureSummarizeChain();
      await chain.downloadSubtitle();
    } catch (error) {
      logWarn("[BOC] download subtitle failed", error);
    }
  });

  // ===== PR3 Follow playback 悬浮按钮 =====
  // 显隐由 data-boc-reader-follow 的 CSS 驱动；点击恢复跟随并跳回当前句
  //（resumeReaderFollowPlayback，不改播放进度）。
  byId(ids.readingFollowBtn).addEventListener("click", () => {
    withReader("resume reader follow", (reader) => reader.resumeReaderFollowPlayback());
  });

  // ===== 字幕列表交互（手动滚动暂停 + 点句跳转；实现在 reader/sync.ts） =====
  const subtitleList = byId(ids.readingSubtitleList);
  // scroll/wheel 是高频路径，每事件一次 withReader 都要分配 promise：250ms
  // 节流（与 sync tick 同档）首发立即透传、窗口内丢弃。节流间隔远小于手动
  // 暂停窗口（noteManualReaderInteraction 默认 durationMs=3000），滚动期间
  // 自动同步照样保持暂停。
  const MANUAL_SCROLL_THROTTLE_MS = 250;
  let lastManualScrollAt = 0;
  const handleReaderManualScroll = () => {
    if (isProgrammaticScrolling()) {
      return;
    }
    const now = Date.now();
    if (now - lastManualScrollAt < MANUAL_SCROLL_THROTTLE_MS) {
      return;
    }
    lastManualScrollAt = now;
    // 高频路径：首次交互装载 reader 域，其后命中缓存 promise；装载失败静默
    //（下次交互自然重试，避免滚动期间刷日志）。
    withReader(null, (reader) => reader.noteManualReaderInteraction());
  };
  subtitleList.addEventListener("scroll", handleReaderManualScroll);
  subtitleList.addEventListener("wheel", handleReaderManualScroll, { passive: true });
  subtitleList.addEventListener("pointerdown", () => {
    withReader(null, (reader) => reader.noteManualReaderInteraction(3500));
  });
  subtitleList.addEventListener("click", (event) => {
    withReader(null, (reader) => reader.onReadingSubtitleClick(event));
  });
}
