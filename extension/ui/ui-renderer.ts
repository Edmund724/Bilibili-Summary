import { state, uiState } from "../core/state.js";
import { byId } from "../shared/dom-utils.js";
import { replaceReaderModeUrl } from "../bilibili/reader-url.js";
import {
  isReaderMode,
  stripReaderModeUrl
} from "../bilibili/video-id-shared.js";
import { escapeHtml } from "../shared/string-utils.js";
import { READING_HEADER_ICONS } from "./reading-header-icons.js";
// 选区「解释」的两处接线都在本模块：选区监听 + 浮层定位（bindUiEvents 内），
// 以及点浮层后触达 reader 动态域的解释卡片（reader/explain-card.js，经
// ensureReaderDomain 装载）。卡片底部「去对话追问」才写待解释意图
// （reader/explain-intent.js 契约），由对话 tab 消费——常驻侧不再直连该契约。
// PR5 AI 对话 tab 的二级惰性加载器（常驻轻叶子，动态边在 core/lazy-chat-tab 内）：
// 首次切到对话 tab / 解释卡片「去对话追问」触达时才装载对话组合根（reader/chat-tab.ts）。
import { ensureReaderChatTab } from "../core/lazy-chat-tab.js";
// PR5 外点关闭单委托：对话 tab popovers 的文档级外点关闭经桥接叶子并入本模块
// 的单一 document click 委托（原双监听互踩风险收口，见 chat-tab-bridge.ts）。
import { dispatchChatTabOutsideClick } from "../reader/chat-tab-bridge.js";
// 候选03 常驻瘦身：本模块（面板 + 阅读视图壳构建、事件绑定）已整体惰性化，
// 经 core/lazy-ui.js 动态装载。静态 import 只允许常驻叶子——reader 状态微模块
//（./reader/state.js，含 ids/view-state/scroll-state）、轻状态栏写入器
//（../shared/ui-status.js）。reader 重域（sync/lifecycle 的交互处理）与总结链
//（fetcher/subtitle-ui）一律在回调内经 ensure 动态装载后调用。
import {
  ids,
  isReaderViewOpen,
  isProgrammaticScrolling
} from "../reader/state.js";
// 日志直接取自 shared/logging.js（不再经 reader/index.js 转发）
import { logWarn } from "../shared/logging.js";
// 总结链与 reader 域的按需加载器（常驻轻文件，动态边在其内部）。
import { ensureSummarizeChain } from "../subtitle/lazy.js";
import { ensureReaderDomain } from "../core/lazy-reader.js";

// ensureReaderDomain 的返回类型在 core/lazy-reader.ts 只声明了启动期窄接口
//（enterReaderMode/closeReadingView/waitForVideoMetadata/seekReadingTarget）；
// 本模块经 ensure 转发的交互回调落在 reader/index.ts 动态域入口的完整导出面上
//（syncReadingViewPlayback/updateReaderPreferences/renderReaderPanels 等）。
// 此处以动态域入口模块类型交叉收口，运行时对象不变（与原调用完全一致）。
type ReaderDomain = typeof import("../reader/index.js");
type UiReaderDomain = Awaited<ReturnType<typeof ensureReaderDomain>> & ReaderDomain;
const loadReaderDomain = ensureReaderDomain as () => Promise<UiReaderDomain>;

export function buildUiHtml(): string {
  return `
    <section id="${ids.readingView}" aria-hidden="true" data-boc-reader-ready="0" aria-busy="true">
      <!-- 统一 Digest 面板（B 形态）：右栏面板壳，三标签 = 字幕 / 概览 /
           AI 对话。rail（章节栏）与 stage（状态栏/播放器槽）已随整页接管退役
           ——章节列表由概览 tab 提供，播放器保持 B 站原生布局不动；
           readingStatus 挪进面板 header 下方（id 不变，subtitle/ai/chat 各域
           经 shared/ui-status.js 持续写入）。字幕列表整体挂进字幕 tab body
           （分批渲染/点句跳转/跟随播放等行为不变）；概览（PR4）与 AI 对话
           （PR5）分别由各自的状态机/组合根接管。 -->
      <aside id="${ids.readingDigestPanel}" class="boc-reading-digest-panel" aria-label="Digest 面板">
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

            <p id="${ids.readingStatus}" class="boc-reading-status">使用页面原生播放器联动章节和字幕。</p>

            <section id="${ids.readingSettingsPanel}" class="boc-reading-panel boc-reading-settings-panel" hidden>
              <!-- 扩展设置宿主（digest-only-ui）：原独立 options 页的全部设置项
                   由 ui/settings-panel.js 渲染进此容器（分节、可滚动），options
                   页面本体已删除。顶部滚动/字幕/章节三开关与字幕语言下拉已随
                   三开关退役移除——语言下拉移入字幕 tab 工具条（复制按钮左侧）。 -->
              <section class="boc-reading-settings-group boc-reading-settings-extension">
                <div id="${ids.readingSettingsHost}" class="boc-reading-settings-host"></div>
              </section>
            </section>

            <!-- 标签页 pill 分段控件（active 态 = accent 实底，见 prototype/direction-approved.md） -->
            <div class="boc-reading-tabs" role="tablist" aria-label="Digest 标签">
              <button id="${ids.readingTabSubtitle}" type="button" class="boc-reading-tab is-active" role="tab" aria-selected="true">字幕</button>
              <button id="${ids.readingTabOverview}" type="button" class="boc-reading-tab" role="tab" aria-selected="false">概览</button>
              <button id="${ids.readingTabChat}" type="button" class="boc-reading-tab" role="tab" aria-selected="false">AI 对话</button>
            </div>

            <!-- 字幕 tab：工具条（句内搜索 + 复制/导出，PR3）+ 转写中间态横幅 +
                 字幕列表整体搬家（分批渲染/尾 spacer/事件委托不变） +
                 Follow playback 悬浮按钮、选区「解释」浮层与解释卡片 -->
            <div id="${ids.readingTabBodySubtitle}" class="boc-reading-tab-body is-active" role="tabpanel" aria-label="字幕">
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

              <!-- 选区「解释」浮层：单实例、绝对定位在 tab body（不进列表滚动
                   容器，避免随滚动裁剪/漂移），在字幕句内选中词/句后定位到选区下方 -->
              <div id="${ids.readingExplainPop}" class="boc-reading-explain-pop" hidden>
                <button type="button" class="boc-reading-explain-btn">解释</button>
              </div>

              <!-- 选区「解释」卡片宿主：覆盖整个 tab body 的面板内弹层（遮罩 +
                   对话框），内容由 reader/explain-card.js 按状态机整块重建 -->
              <div id="${ids.readingExplainCard}" class="boc-reading-explain-card" hidden></div>
            </div>

            <!-- 概览 tab（PR4）：状态机渲染宿主（reader/overview.ts），内容由
                 lifecycle/ui 触发路径按阶段整块重建——idle/generating/ready/
                 partial/error/empty 全诚实态，不放假数据。此为未生成初值。 -->
            <div id="${ids.readingTabBodyOverview}" class="boc-reading-tab-body" role="tabpanel" aria-label="概览" hidden>
              <div id="${ids.readingOverviewBody}" class="boc-reading-overview">
                <div class="boc-reading-placeholder">
                  <div class="boc-reading-placeholder-title">概览还未生成</div>
                  <p class="boc-reading-placeholder-copy">切到概览标签页会自动开始生成章节与金句。</p>
                </div>
              </div>
            </div>

            <!-- AI 对话 tab（PR5）：真对话 UI 壳（结构对应 sidepanel.html 的 sp* 树，
                 id 换 readingChat* 前缀）。对话组合根（reader/chat-tab.ts）首次激活时
                 接线；未激活前壳保持静默空态（空消息区 + 空输入框），不放假数据。
                 待解释意图引用卡（PR3 契约）：由对话组合根按 pending 意图渲染，
                 自动发送成功即消费隐藏；卡上的取消按钮清意图。 -->
            <div id="${ids.readingTabBodyChat}" class="boc-reading-tab-body" role="tabpanel" aria-label="AI 对话" hidden>
              <div id="${ids.readingChatRoot}" class="boc-reading-chat">
                <header class="sp-header boc-reading-chat-header">
                  <button type="button" class="sp-context-chip" id="${ids.readingChatContextChip}" title="">加载中...</button>
                  <button id="${ids.readingChatHistoryBtn}" type="button" class="sp-toolbar-btn" title="历史对话">
                    <span>历史对话</span>
                  </button>
                  <button id="${ids.readingChatRefreshBtn}" type="button" class="sp-icon-btn" title="刷新当前视频上下文" aria-label="刷新上下文">
                    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
                      <path d="M21 3v5h-5"></path>
                      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path>
                      <path d="M8 16H3v5"></path>
                    </svg>
                  </button>
                  <button id="${ids.readingChatNewBtn}" type="button" class="sp-icon-btn" title="开启新会话" aria-label="开启新会话">
                    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                      <path d="M12 5v14"></path>
                      <path d="M5 12h14"></path>
                    </svg>
                  </button>
                </header>

                <div id="${ids.readingChatIntent}" class="boc-reading-chat-intent" hidden>
                  <div class="boc-reading-chat-intent-head">
                    <span class="boc-reading-chat-intent-title">待解释的字幕句</span>
                    <span class="boc-reading-chat-intent-time boc-reading-time">00:00</span>
                    <button type="button" class="boc-reading-chat-intent-cancel" data-chat-intent-action="cancel" title="取消解释" aria-label="取消解释">×</button>
                  </div>
                  <blockquote class="boc-reading-chat-intent-quote"></blockquote>
                </div>

                <div id="${ids.readingChatAsrNotice}" class="sp-asr-notice" hidden>该视频无字幕，正在音频转写…</div>
                <main class="sp-messages" id="${ids.readingChatMessages}">
                  <div class="sp-suggestions" id="${ids.readingChatSuggestions}"></div>
                </main>
                <footer class="sp-footer">
                  <div class="sp-toolbar">
                    <select id="${ids.readingChatModelSelect}" class="sp-model-select" aria-label="选择模型平台"></select>
                    <div id="${ids.readingChatThinkingToggle}" class="sp-thinking-toggle" role="group" aria-label="思考档位">
                      <button type="button" class="sp-thinking-btn" data-level="off">Off</button>
                      <button type="button" class="sp-thinking-btn" data-level="low">Low</button>
                      <button type="button" class="sp-thinking-btn" data-level="high">High</button>
                    </div>
                    <button id="${ids.readingChatPresetBtn}" type="button" class="sp-toolbar-btn" title="预设提示词">
                      <span>预设提示词</span>
                    </button>
                  </div>
                  <div id="${ids.readingChatPresetPopover}" class="sp-preset-popover" hidden>
                    <div id="${ids.readingChatPresetList}" class="sp-preset-list"></div>
                    <div class="sp-preset-editor">
                      <input id="${ids.readingChatPresetInput}" class="sp-preset-input" type="text" placeholder="添加预设提示词" />
                      <button id="${ids.readingChatPresetAddBtn}" type="button" class="sp-preset-add-btn">添加</button>
                    </div>
                  </div>
                  <div id="${ids.readingChatHistoryPopover}" class="sp-history-popover" hidden>
                    <div class="sp-history-popover-head">
                      <span class="sp-history-popover-title">历史对话</span>
                      <button id="${ids.readingChatHistoryClearBtn}" type="button" class="sp-history-clear-btn">清空全部</button>
                    </div>
                    <div id="${ids.readingChatHistoryList}" class="sp-history-list"></div>
                  </div>
                  <div class="sp-input-row">
                    <textarea
                      id="${ids.readingChatInput}"
                      rows="2"
                      placeholder="回车发送，Shift+Enter 换行"
                      autocomplete="off"
                    ></textarea>
                    <button id="${ids.readingChatStopBtn}" type="button" class="sp-stop-btn" hidden>停止</button>
                  </div>
                </footer>
              </div>
            </div>
      </aside>
    </section>
  `;
}

// ===== 统一 Digest 面板三标签（PR2） =====
//
// 标签切换是纯壳交互（class/aria/hidden 写入），不触碰 reader 域状态；
// active 态约定：tab 按钮 .is-active + aria-selected，tab body .is-active 且
// 去 hidden（CSS 双通道：.boc-reading-tab-body:not(.is-active) 与 [hidden]
// 都收敛为 display:none，防 UA 样式被作者 display 覆盖）。
export type ReaderDigestTab = "subtitle" | "overview" | "chat";

const DIGEST_TAB_DEFS: Array<{ name: ReaderDigestTab; buttonId: string; bodyId: string }> = [
  { name: "subtitle", buttonId: ids.readingTabSubtitle, bodyId: ids.readingTabBodySubtitle },
  { name: "overview", buttonId: ids.readingTabOverview, bodyId: ids.readingTabBodyOverview },
  { name: "chat", buttonId: ids.readingTabChat, bodyId: ids.readingTabBodyChat }
];

export function setReaderDigestTab(tab: ReaderDigestTab): void {
  for (const def of DIGEST_TAB_DEFS) {
    const button = document.getElementById(def.buttonId);
    const body = document.getElementById(def.bodyId);
    if (!button || !body) {
      continue;
    }
    const active = def.name === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    body.classList.toggle("is-active", active);
    if (active) {
      body.removeAttribute("hidden");
    } else {
      body.setAttribute("hidden", "");
    }
  }
}

// 进入阅读模式时回到默认「字幕」标签（lifecycle.enterReaderMode 调用）；
// 视图开着期间的渲染重渲不重置，避免打断用户所在标签。
export function resetReaderDigestTabs(): void {
  setReaderDigestTab("subtitle");
}

// PR5：AI 对话 tab 的二级惰性激活入口。首次切到对话 tab 时经
// ensureReaderChatTab 装载组合根（reader/chat-tab.ts）并 init；已装载时为
// 幂等的重开恢复 + 待解释意图消费。装载/激活失败只记日志（对话不可用不拖垮
// 阅读视图其余两 tab）。
export function activateReaderChatTab(): void {
  ensureReaderChatTab()
    .then((chat) => chat.ensureChatTabActivated())
    .catch((error) => logWarn("[BOC] chat tab activate failed", error));
}

// digest-only-ui：打开侧边栏设置抽屉（展开 + 渲染）。原「打开设置页」入口
//（open-options 消息/options 页）已删除，header 齿轮、对话 tab 设置按钮与
// 提示条「前往设置」都收敛到本函数；reader 域（lifecycle.renderReaderPanels）
// 在抽屉打开时装载设置面板。
export function openReaderSettingsPanel(): void {
  state.reader.setSettingsExpanded(true);
  loadReaderDomain()
    .then((reader) => reader.renderReaderPanels())
    .catch((error) => logWarn("[BOC] reader panels render failed", error));
}

export function bindUiEvents(): void {
  // digest-only-ui：A 形态经典侧栏面板已删除，模板不再包含旧壳节点
  //（boc-panel/boc-status/boc-preview 等）；面板交互只有阅读视图（Digest）。
  const readingView = byId(ids.readingView);
  const readingCloseBtn = byId(ids.readingCloseBtn);
  const readingThemeSelect = byId(ids.readingThemeSelect);
  const readingSettingsToggleBtn = byId(ids.readingSettingsBtn);
  // rail 章节列表 DOM 已随整页接管退役（章节跳转/手动滚动接管由概览
  // tab 的列表承接，见 readingOverviewBody 的委托）。
  const subtitleList = byId(ids.readingSubtitleList);

  // Digest 面板三标签切换（纯壳交互，见上方 setReaderDigestTab 注释）。
  // 切到 AI 对话 tab（PR5）：二级惰性激活对话组合根（首次装载 + 恢复路径 +
  // 消费待解释意图，见 activateReaderChatTab）。
  // 切到概览 tab（PR4）：未生成则自动触发生成（idle 才触发，生成中复用进行中
  // promise，已生成不重跑）；reader 域交互按惯例经 loadReaderDomain 装载后转发。
  for (const def of DIGEST_TAB_DEFS) {
    byId(def.buttonId).addEventListener("click", () => {
      setReaderDigestTab(def.name);
      if (def.name === "chat") {
        activateReaderChatTab();
      }
      if (def.name === "overview") {
        loadReaderDomain()
          .then((reader) => reader.ensureReaderOverviewTab())
          .catch((error) => logWarn("[BOC] overview tab enter failed", error));
      }
    });
  }

  // digest-only-ui：经典侧栏面板的按钮绑定（close/refresh/select/copy/
  // download/settings）已随 A 形态模板删除；刷新/复制/导出等动作由字幕 tab
  // 工具条与面板 header 的动作按钮承接，绑定见各自 id（readingRefreshBtn 等
  // 历史 id 已从模板移除，阅读视图的刷新链路改经字幕工具条/转写横幅触发）。
  // ===== 阅读视图交互回调（候选02）：closeReadingView/sync/click 等属 reader
  // 重域，交互时经 ensureReaderDomain 装载后调用（视图开着 ⇒ 域几乎必然已装载
  // ，ensure 命中缓存 promise）。
  readingCloseBtn.addEventListener("click", () => {
    if (isReaderMode()) {
      replaceReaderModeUrl(stripReaderModeUrl(location.href));
    }
    loadReaderDomain()
      .then((reader) => reader.closeReadingView())
      .catch((error) => logWarn("[BOC] close reading view failed", error));
  });
  readingThemeSelect.addEventListener("click", () => {
    const themes = ["light", "dark", "paper"];
    const current = state.reader.readingTheme || "light";
    const nextIndex = (themes.indexOf(current) + 1) % themes.length;
    loadReaderDomain()
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
    loadReaderDomain()
      .then((reader) => reader.renderReaderPanels())
      .catch((error) => logWarn("[BOC] reader panels render failed", error));
  });

  // digest-only-ui：无平台提示的「前往设置」打开侧边栏设置抽屉（原 open-options
  // 消息/独立设置页已删除）——展开面板并渲染。该链接由对话 tab 按态重建，
  // 非必存在（缺失时跳过，由 chat-tab 的 onOpenSettings 回调兜底）。
  const chatOpenSettingsLink = document.getElementById(ids.readingChatOpenSettings);
  if (chatOpenSettingsLink) {
    chatOpenSettingsLink.addEventListener("click", (e) => {
      e.preventDefault();
      openReaderSettingsPanel();
    });
  }

  const readingSubtitleSelect = byId(ids.readingSubtitleSelect);
  readingSubtitleSelect.addEventListener("change", (event) => {
    const selectTarget = event.target as HTMLSelectElement;
    const option = selectTarget.options[selectTarget.selectedIndex];
    const url = String(option?.value || "");
    if (!url) return;
    // 候选02：loadSubtitle 属总结链、renderReadingView/sync 属 reader 域——
    // 按层各自 ensure 后串联，顺序与搬迁前一致（先装载字幕，再重渲与同步）。
    ensureSummarizeChain()
      .then((chain) =>
        chain.loadSubtitle(url, String(option.dataset.lang || "unknown"), state.clip.fetchRunId, String(option.dataset.id || ""))
      )
      .then(() => loadReaderDomain())
      .then((reader) => {
        reader.renderReadingView();
        reader.syncReadingViewPlayback(true);
      })
      .catch((error) => {
        logWarn("[BOC] failed to switch subtitle in reading view", error);
      });
  });

  // ===== PR3 字幕 tab：句内搜索（输入/键盘/上下条） =====
  // 搜索状态与高亮逻辑在 reader/subtitle-search.js（重域：补渲染走分批渲染
  // 状态机），交互回调经 loadReaderDomain 装载后转发（首次输入多一次本地动态
  // import，其后命中缓存 promise，与滚动/点击回调同款）。
  const readingSearchInput = byId(ids.readingSearchInput) as HTMLInputElement;
  const searchRefresh = () => {
    loadReaderDomain()
      .then((reader) => reader.refreshReadingSubtitleSearch())
      .catch((error) => logWarn("[BOC] subtitle search refresh failed", error));
  };
  readingSearchInput.addEventListener("input", searchRefresh);
  readingSearchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    loadReaderDomain()
      .then((reader) => {
        if (event.key === "Enter") {
          reader.moveReadingSubtitleSearch(event.shiftKey ? -1 : 1);
          return;
        }
        // Escape：清输入恢复原文本（焦点留在输入框便于再次输入）
        readingSearchInput.value = "";
        reader.refreshReadingSubtitleSearch({ scroll: false });
        readingSearchInput.focus();
      })
      .catch((error) => logWarn("[BOC] subtitle search keydown failed", error));
  });
  byId(ids.readingSearchPrevBtn).addEventListener("click", () => {
    loadReaderDomain()
      .then((reader) => reader.moveReadingSubtitleSearch(-1))
      .catch((error) => logWarn("[BOC] subtitle search prev failed", error));
  });
  byId(ids.readingSearchNextBtn).addEventListener("click", () => {
    loadReaderDomain()
      .then((reader) => reader.moveReadingSubtitleSearch(1))
      .catch((error) => logWarn("[BOC] subtitle search next failed", error));
  });

  // ===== PR3 字幕 tab：复制 / 导出（纯接线，逻辑在总结链） =====
  // 复制 = 字幕纯文本（copySubtitleTranscript，buildTxt 管线，transcript 语义）；
  // 导出 = SRT/TXT（downloadSubtitle，按 downloadFormat 设置）。
  byId(ids.readingCopySubtitleBtn).addEventListener("click", () => {
    ensureSummarizeChain()
      .then((chain) => chain.copySubtitleTranscript())
      .catch((error) => logWarn("[BOC] copy subtitle transcript failed", error));
  });
  byId(ids.readingExportSubtitleBtn).addEventListener("click", () => {
    ensureSummarizeChain()
      .then((chain) => chain.downloadSubtitle())
      .catch((error) => logWarn("[BOC] download subtitle failed", error));
  });

  // ===== PR3 字幕 tab：Follow playback 悬浮按钮 =====
  // 显隐由 data-boc-reader-follow 的 CSS 驱动；点击恢复跟随并跳回当前句
  //（resumeReaderFollowPlayback，不改播放进度）。
  byId(ids.readingFollowBtn).addEventListener("click", () => {
    loadReaderDomain()
      .then((reader) => reader.resumeReaderFollowPlayback())
      .catch((error) => logWarn("[BOC] resume reader follow failed", error));
  });

  // ===== 字幕 tab：选区「解释」浮层 =====
  // 触发条件是「在字幕句里选中了词/句」，不再是 hover。选区变化经 document
  // selectionchange 单点委托（拖选/双击/键盘选区都覆盖），只在选区落在字幕列表
  // 内时显示浮层，并定位到选区下方；选区清空/移出列表/列表滚动时隐藏。
  // 浮层挂在本 tab body（非列表滚动容器）内，不进 .boc-reading-item 的点击委托
  // 链——点「解释」不会触发点句跳转。
  const readingExplainPop = byId(ids.readingExplainPop);
  const readingExplainBtn = readingExplainPop.querySelector("button") as HTMLButtonElement;
  const readingTabBodySubtitle = byId(ids.readingTabBodySubtitle);
  // 浮层显示时快照选区（条目索引 + 选中原文）：点「解释」时不再回读
  // window.getSelection()——彼时选区可能已被浏览器折叠，且快照语义更明确。
  let pendingExplainSelection: { itemIndex: string; selection: string } | null = null;
  const hideExplainPop = () => {
    // 热路径守卫：selectionchange 对页面任何输入框的选区变化都会触发，已隐藏时
    // 直接返回，避免每次敲键盘都写一遍 DOM。
    if (readingExplainPop.hidden && !pendingExplainSelection) {
      return;
    }
    readingExplainPop.hidden = true;
    delete readingExplainPop.dataset.itemIndex;
    pendingExplainSelection = null;
  };
  // 选区矩形：jsdom 无 Range.getBoundingClientRect，取不到时退回条目矩形
  //（测试环境两者都是零矩形，定位数值不参与断言）。
  const explainAnchorRect = (range: Range, item: HTMLElement) => {
    const rect = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
    if (rect && (rect.width || rect.height || rect.top || rect.left)) {
      return rect;
    }
    return item.getBoundingClientRect();
  };
  const showExplainPopForSelection = (item: HTMLElement, range: Range, selection: string) => {
    const bodyRect = readingTabBodySubtitle.getBoundingClientRect();
    const rect = explainAnchorRect(range, item);
    pendingExplainSelection = { itemIndex: item.dataset.index || "", selection };
    readingExplainPop.dataset.itemIndex = pendingExplainSelection.itemIndex;
    // 先显形再量宽：浮层宽度随文案变化。水平位置 = 选区中点正下方居中
    //（贴左右边界时收敛回 tab body 内），垂直位置 = 选区下缘留 4px。
    readingExplainPop.hidden = false;
    const popWidth = readingExplainPop.offsetWidth || 96;
    const selectionCenter = Math.round(rect.left + rect.width / 2 - bodyRect.left);
    const maxLeft = Math.max(8, Math.round(bodyRect.width) - popWidth - 8);
    readingExplainPop.style.left = `${Math.min(Math.max(8, selectionCenter - Math.round(popWidth / 2)), maxLeft)}px`;
    readingExplainPop.style.top = `${Math.max(0, Math.round(rect.bottom - bodyRect.top) + 4)}px`;
  };
  const syncExplainPopWithSelection = () => {
    const selection = window.getSelection?.();
    const text = selection?.toString().trim() || "";
    if (!selection || !text || selection.rangeCount === 0) {
      hideExplainPop();
      return;
    }
    const range = selection.getRangeAt(0);
    const anchorNode = range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement
      : (range.startContainer as HTMLElement | null);
    const item = anchorNode?.closest?.<HTMLElement>(".boc-reading-item");
    if (!item || !subtitleList.contains(item)) {
      hideExplainPop();
      return;
    }
    showExplainPopForSelection(item, range, text);
  };
  document.addEventListener("selectionchange", syncExplainPopWithSelection);
  // 按住「解释」按钮的 mousedown 必须吃掉默认动作：否则 Chrome 会先折叠页面
  // 选区 → selectionchange 把浮层连同快照一起清掉 → click 落点时已无选区可用。
  readingExplainPop.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  subtitleList.addEventListener("scroll", hideExplainPop, { passive: true });
  subtitleList.addEventListener("pointerdown", hideExplainPop);
  readingExplainBtn.addEventListener("click", () => {
    // 从渲染条目取选中所在整句（textContent + data-seconds），不回读 state 结构——
    // 语义就是「用户看到的这句」，也避免常驻侧依赖字幕数据链。
    // 索引缺失（浮层已隐藏/重复 click）按无效处理：不回退到第 0 条。
    const snapshot = pendingExplainSelection;
    const itemIndex = Number(snapshot?.itemIndex);
    const itemNode =
      snapshot && snapshot.itemIndex !== "" && Number.isFinite(itemIndex) && itemIndex >= 0
        ? subtitleList.querySelector<HTMLElement>(`[data-index="${itemIndex}"]`)
        : null;
    const line = itemNode?.querySelector(".boc-reading-text")?.textContent?.trim() || "";
    if (!itemNode || !line || !snapshot) {
      hideExplainPop();
      return;
    }
    const payload = {
      selection: snapshot.selection,
      line,
      from: Number(itemNode.dataset.seconds || 0) || 0,
      index: itemIndex
    };
    // 收起选区高亮与浮层：解释内容已取走，页面上残留的蓝色选区只剩干扰
    window.getSelection?.()?.removeAllRanges();
    hideExplainPop();
    // 解释卡片属 reader 动态域（要发 AI 请求），经 ensure 装载后调用；
    // 装载失败只记日志（解释不可用不拖垮字幕 tab 其余交互）。
    loadReaderDomain()
      .then((reader) => reader.openReaderExplainCard(payload))
      .catch((error) => logWarn("[BOC] open explain card failed", error));
  });

  // 解释卡片内点击委托（关闭 / 重试 / 去对话追问）：宿主容器不换、内容整块
  // 重建，与概览 tab 同款容器级委托；实现在 reader/explain-card.js。
  const readingExplainCard = byId(ids.readingExplainCard);
  readingExplainCard.addEventListener("click", (event) => {
    loadReaderDomain()
      .then((reader) => reader.onReaderExplainCardClick(event as MouseEvent))
      .catch((error) => logWarn("[BOC] explain card click failed", error));
  });

  // Click outside settings panel to close（单一文档级 click 委托：PR5 起同时
  // 承接对话 tab popovers 的外点关闭——chat-tab-bridge 注册槽转发，不另挂第二
  // 个 document 监听，避免双委托互踩。转发必须放在 settingsExpanded 早退之前）。
  if (!state.reader.readingDocumentClickBound) {
    document.addEventListener("click", (e) => {
      dispatchChatTabOutsideClick(e);
      if (!state.reader.readingSettingsExpanded) return;
      const settingsPanel = document.getElementById(ids.readingSettingsPanel);
      const settingsBtnEl = document.getElementById(ids.readingSettingsBtn);
      if (!settingsPanel || !settingsBtnEl) {
        return;
      }
      if (!settingsPanel.contains(e.target as Node | null) && !settingsBtnEl.contains(e.target as Node | null)) {
        state.reader.setSettingsExpanded(false);
        loadReaderDomain()
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
    loadReaderDomain()
      .then((reader) => reader.noteManualReaderInteraction())
      .catch(() => {});
  };
  subtitleList.addEventListener("scroll", handleReaderManualScroll);
  subtitleList.addEventListener("wheel", handleReaderManualScroll, { passive: true });
  subtitleList.addEventListener("pointerdown", () => {
    loadReaderDomain()
      .then((reader) => reader.noteManualReaderInteraction(3500))
      .catch(() => {});
  });
  subtitleList.addEventListener("click", (event) => {
    loadReaderDomain()
      .then((reader) => reader.onReadingSubtitleClick(event))
      .catch(() => {});
  });
  // ===== PR4 概览 tab：章节/金句点击跳播 + 重试/笔记按钮 =====
  // 事件委托挂概览渲染宿主（内容被状态机整块重建，容器不换）；逻辑在
  // reader/overview.js（跳播复用 seekReadingTarget 通道），经 loadReaderDomain
  // 装载后转发，与章节 rail / 字幕句点击同款接线。
  const readingOverviewBody = byId(ids.readingOverviewBody);
  readingOverviewBody.addEventListener("click", (event) => {
    loadReaderDomain()
      .then((reader) => reader.onReadingOverviewClick(event))
      .catch((error) => logWarn("[BOC] overview click failed", error));
  });

  readingView.addEventListener("transitionend", () => {
    if (!isReaderViewOpen()) {
      loadReaderDomain()
        .then((reader) => reader.stopReadingViewSync())
        .catch(() => {});
    }
  });
}

export function ensureUiReady({ forceRecreate = false }: { forceRecreate?: boolean } = {}): void {
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

export function setBusyState(): void {
  // digest-only-ui：经典侧栏面板按钮已删除（见 buildUiHtml），字幕 tab 的
  // 复制/导出按钮忙态由字幕工具条自己的渲染逻辑驱动，不再有全局忙态开关。
}

// renderMeta / renderSubtitleSelect / setBusyState 已随经典侧栏面板删除
//（digest-only-ui：阅读视图的元信息/字幕轨由 reader 域渲染，复制/导出由字幕
// tab 工具条接线）；setStatus / setMessage 已迁往 ../shared/ui-status.js，宿主
// 收敛到 #boc-reading-status。
