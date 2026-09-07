import { state, uiState } from "../core/state.js";
import { byId } from "../shared/dom-utils.js";
import { escapeHtml } from "../shared/string-utils.js";
import { READING_HEADER_ICONS } from "./reading-header-icons.js";
// PR5 AI 对话 tab 的二级惰性加载器（常驻轻叶子，动态边在 reader/lazy-chat-tab 内）：
// 首次切到对话 tab / 解释卡片「去对话追问」触达时才装载对话组合根（reader/chat-tab.ts）。
import { ensureReaderChatTab } from "../reader/lazy-chat-tab.js";
// PR5 外点关闭单委托：对话 tab popovers 的文档级外点关闭经桥接叶子并入本模块
// 的单一 document click 委托（原双监听互踩风险收口，见 chat-tab-bridge.ts）。
import { dispatchChatTabOutsideClick } from "../reader/chat-tab-bridge.js";
// 候选03 常驻瘦身：本模块（面板 + 阅读视图壳构建、事件绑定）已整体惰性化，
// 经 ui/lazy-ui.js 动态装载。静态 import 只允许常驻叶子——reader 状态微模块
//（./reader/state.js，含 ids/view-state/scroll-state）、轻状态栏写入器
//（../shared/ui-status.js）、reader 域懒加载转发助手（./reader-gate.js，动态边
// 在 reader/lazy-reader 内部）。
import { classes, ids, isReaderViewOpen } from "../reader/state.js";
// 日志直接取自 shared/logging.js（不再经 reader/index.js 转发）
import { logWarn } from "../shared/logging.js";
// 阅读壳（工单 arch-slim/02）：关闭按钮的关闭链退化为退出事务委托
//（URL 收敛 → closeReadingView → 摘阅读表，唯一实现在 reader/shell.ts）。
import { exitReaderShell } from "../reader/shell.js";
// 对话分区表（arch-slim-4/07）：切到对话 tab 的全部入口都先经
// setReaderDigestTab("chat")，chat 分支同步挂载（reader/chat-tab.ts 模块顶层
// 另兜底挂一次）；不建 onload 门控——无样式窗口只落在未激活的静默空态上。
import { ensureReaderChatStyles } from "../shared/style-injector.js";
// arch-slim-2/06 ui 按 tab 全量收口：三 tab 的模板段+绑定段同居各自域叶子，
// 壳只组装与接线。叶子均为轻模块（ids 表 + reader-gate 转发助手，动态边在
// 叶子依赖内部），不把 reader 重域/总结链拖进壳闭包：
//   - reader/chat-template.ts：对话 tab 模板（绑定全在 reader/chat-tab.ts
//     组合根，含 els 表与 bindEvents；无平台空态「前往设置」的容器委托也在
//     该域——死绑定修复，见其 bindEvents 注释）；
//   - reader/subtitle-tab-ui.ts：字幕 tab 工具条/转写横幅/列表容器/Follow
//     的模板 + 搜索/切轨/复制导出/Follow/列表交互绑定；
//   - reader/explain-pop-ui.ts：选区解释浮层与卡片宿主模板 + 选区监听/定位/
//     快照/卡片委托绑定（卡片状态机在 reader/explain-card.ts）；
//   - reader/overview-ui.ts：概览占位模板 + 点击委托（状态机在 reader/overview.ts）；
//   - ui/reader-gate.ts：withReader/whenReaderReady 转发助手单源（壳与 tab
//     叶子共用，禁止复制）。
import { withReader } from "./reader-gate.js";
import { buildChatTabBodyHtml } from "../reader/chat-template.js";
import { buildSubtitleTabBodyHtml, bindSubtitleTabEvents } from "../reader/subtitle-tab-ui.js";
import { buildExplainPopHtml, buildExplainCardHostHtml, bindReadingExplainEvents } from "../reader/explain-pop-ui.js";
import { buildOverviewTabBodyHtml, bindReadingOverviewEvents } from "../reader/overview-ui.js";

export function buildUiHtml(): string {
  return `
    <section id="${ids.readingView}" aria-hidden="true" data-boc-reader-ready="0" aria-busy="true">
      <!-- 统一 Digest 面板（B 形态）：右栏面板壳，三标签 = 字幕 / 概览 /
           AI 对话。rail（章节栏）与 stage（状态栏/播放器槽）已随整页接管退役
           ——章节列表由概览 tab 提供，播放器保持 B 站原生布局不动；
           readingStatus 挪进面板 header 下方（id 不变，subtitle/ai/chat 各域
           经 shared/ui-status.js 持续写入）。三 tab body 的内容模板随各自域
           叶子（arch-slim-2/06：壳只懂面板骨架与 tab 切换） -->
      <aside id="${ids.readingDigestPanel}" class="boc-reading-digest-panel" aria-label="Digest 面板">
            <header class="boc-reading-header">
              <div class="boc-reading-header-copy">
                <strong class="${classes.readingTitle}">${escapeHtml(state.clip.title || "B站字幕阅读")}</strong>
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

            <!-- 字幕 tab body：工具条/转写横幅/列表容器/Follow 模板与交互绑定
                 在 reader/subtitle-tab-ui.ts；选区「解释」浮层与卡片宿主在
                 reader/explain-pop-ui.ts（arch-slim-2/06 下放） -->
            <div id="${ids.readingTabBodySubtitle}" class="boc-reading-tab-body is-active" role="tabpanel" aria-label="字幕">
              ${buildSubtitleTabBodyHtml()}
              ${buildExplainPopHtml()}
              ${buildExplainCardHostHtml()}
            </div>

            <!-- 概览 tab（PR4）：占位模板 + 点击委托在 reader/overview-ui.ts，
                 状态机/渲染在 reader/overview.ts（PR4 状态机宿主），内容由
                 lifecycle/ui 触发路径按阶段整块重建——idle/generating/ready/
                 partial/error/empty 全诚实态，不放假数据。此为未生成初值。 -->
            <div id="${ids.readingTabBodyOverview}" class="boc-reading-tab-body" role="tabpanel" aria-label="概览" hidden>
              ${buildOverviewTabBodyHtml()}
            </div>

            <!-- AI 对话 tab（PR5）：真对话 UI 壳模板在 reader/chat-template.ts
                 叶子（arch-slim-2/06 下放；组合根 reader/chat-tab.ts 首次激活时
                 接线，含容器级事件委托），未激活前壳保持静默空态（空消息区 +
                 空输入框），不放假数据。 -->
            <div id="${ids.readingTabBodyChat}" class="boc-reading-tab-body" role="tabpanel" aria-label="AI 对话" hidden>
              ${buildChatTabBodyHtml()}
            </div>
      </aside>
    </section>
  `;
}

// ===== 统一 Digest 面板三标签（PR2） =====
//
// 标签切换是纯壳交互（class/aria/hidden 写入），不触碰 reader 域状态；唯一
// 例外是对话 tab 的分区表挂载（arch-slim-4/07，见 setReaderDigestTab）。
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
  // 对话分区表按需装载（arch-slim-4/07）：切到对话 tab 的三个入口（tab 点击 /
  // 解释卡「去对话追问」/ player-ai 快捷动作）都先经本函数，同步挂载保证首开
  // 即在场；ensure 内部 mounted Map 去重，重入零成本。
  if (tab === "chat") {
    ensureReaderChatStyles();
  }
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
  withReader("reader panels render", (reader) => reader.renderReaderPanels());
}

export function bindUiEvents(): void {
  // digest-only-ui：A 形态经典侧栏面板已删除，模板不再包含旧壳节点
  //（boc-panel/boc-status/boc-preview 等）；面板交互只有阅读视图（Digest）。
  const readingView = byId(ids.readingView);
  const readingCloseBtn = byId(ids.readingCloseBtn);
  const readingThemeSelect = byId(ids.readingThemeSelect);
  const readingSettingsToggleBtn = byId(ids.readingSettingsBtn);

  // arch-slim-2/06：三 tab 的专属绑定随模板同居各自域叶子（见文件头 import 注），
  // 壳的 bindUiEvents 只保留面板骨架交互 + 各叶子接线的一次性触发。
  bindSubtitleTabEvents();
  bindReadingExplainEvents();
  bindReadingOverviewEvents();

  // Digest 面板三标签切换（纯壳交互，见上方 setReaderDigestTab 注释）。
  // 切到 AI 对话 tab（PR5）：二级惰性激活对话组合根（首次装载 + 恢复路径 +
  // 消费待解释意图，见 activateReaderChatTab）。
  // 切到概览 tab（PR4）：未生成则自动触发生成（idle 才触发，生成中复用进行中
  // promise，已生成不重跑）；reader 域交互按惯例经 ui/reader-gate 装载后转发。
  for (const def of DIGEST_TAB_DEFS) {
    byId(def.buttonId).addEventListener("click", () => {
      setReaderDigestTab(def.name);
      if (def.name === "chat") {
        activateReaderChatTab();
      }
      if (def.name === "overview") {
        withReader("overview tab enter", (reader) => reader.ensureReaderOverviewTab());
      }
    });
  }

  // digest-only-ui：经典侧栏面板的按钮绑定（close/refresh/select/copy/
  // download/settings）已随 A 形态模板删除；刷新/复制/导出等动作由字幕 tab
  // 工具条与面板 header 的动作按钮承接，绑定见 reader/subtitle-tab-ui.ts。
  // ===== 阅读视图交互回调（候选02）：closeReadingView/sync/click 等属 reader
  // 重域，交互时经 ensureReaderDomain 装载后调用（视图开着 ⇒ 域几乎必然已装载
  // ，ensure 命中缓存 promise）。关闭按钮：退出事务统一走阅读壳（工单
  // arch-slim/02），与 reader-close 消息路径同一实现。
  readingCloseBtn.addEventListener("click", () => {
    exitReaderShell().catch((error) => logWarn("[BOC] close reading view failed", error));
  });
  readingThemeSelect.addEventListener("click", () => {
    const themes = ["light", "dark", "paper"];
    const current = state.reader.readingTheme || "light";
    const nextIndex = (themes.indexOf(current) + 1) % themes.length;
    withReader("reader theme switch", (reader) => {
      reader.updateReaderPreferences({ readerTheme: themes[nextIndex] }, { persist: true });
      readingThemeSelect.classList.add("is-active");
      setTimeout(() => readingThemeSelect.classList.remove("is-active"), 300);
    });
  });
  readingSettingsToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    state.reader.setSettingsExpanded(!state.reader.readingSettingsExpanded);
    withReader("reader panels render", (reader) => reader.renderReaderPanels());
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
        withReader(null, (reader) => reader.renderReaderPanels());
      }
    });
    state.reader.readingDocumentClickBound = true;
  }

  readingView.addEventListener("transitionend", () => {
    if (!isReaderViewOpen()) {
      withReader(null, (reader) => reader.stopReadingViewSync());
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

// renderMeta / renderSubtitleSelect / setBusyState 已随经典侧栏面板删除
//（digest-only-ui：阅读视图的元信息/字幕轨由 reader 域渲染，复制/导出由字幕
// tab 工具条接线）；setStatus / setMessage 已迁往 ../shared/ui-status.js，宿主
// 收敛到 #boc-reading-status。
// arch-slim-2/06：三 tab 的模板与专属绑定已同居各自域叶子（对话 reader/
// chat-template.ts + chat-tab.ts；字幕 reader/subtitle-tab-ui.ts；选区解释
// reader/explain-pop-ui.ts + explain-card.ts；概览 reader/overview-ui.ts +
// overview.ts），本壳只保留面板骨架、tab 状态机、文档级委托与懒加载转发。
