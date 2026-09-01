// sidepanel.ts — UI 绑定 + 编排薄层（sidepanel-split ticket 08 收尾产物）。
//
// 02-07 已把各域实现抽走：helper 消重到 shared/notes/bilibili（02）、markdown
// 渲染到 ../ui/markdown.js（03）、时间戳跳转到 ../ui/timestamp-nav.js（04）、
// 对话持久化到 ./sidepanel-conversation-store.ts（05）、笔记粘贴归一化到
// ../notes/paste.js（06）、chat 流状态机到 ./sidepanel-chat-runtime.ts（07）。
//
// 候选09 又自本文件迁出三块：player AI 快捷动作消费 →
// ./sidepanel-player-ai-requests.ts、预设提示词 CRUD + 双存储同步 →
// ./sidepanel-presets.ts、modelSelect 宽度度量 → ../ui/model-select-width.js
//（本文件只做 import 与工厂组装/调用点适配）。
// 候选08 再把 loadContextState 的四态分支判定抽到 ./sidepanel-context-policy.ts
//（纯函数「输入 → 动作」映射，可直测），loadContextState /
// ensureCurrentContextForSend 只负责拉数据、按动作执行编排副作用。
// 候选5 再迁出六块（本文件收敛为纯组合根：init / bindEvents 剩余部分 / 实例
// 组装 / 页面级编排）：
//   - 三列表渲染 + insertPresetPrompt   → ./sidepanel-lists.ts
//   - 消息区通知/错误/建议区清理/近底   → ./sidepanel-notices.ts
//   - AI 平台加载渲染 + 思考档位        → ./sidepanel-providers.ts
//   - 实时上下文同步调度 + 触发处理体   → ./sidepanel-context-sync.ts
//   - 上下文状态加载 + context chip     → ./sidepanel-context-load.ts
//   - 预设/历史 popover 开合            → ./sidepanel-popovers.ts
// 跨子模块共享的可变状态（上下文/会话/AI 偏好等 13 个字段）收拢在
// ./sidepanel-state.ts 的 sidepanelState，本文件与各子模块直接 import 读写，
// deps 只剩回调与 DOM/storage。页面级 transport 辅助（delay / waitForTabComplete
// / sendMessageToActiveTab）由 ../shared/tab-utils.js 提供（08 新增共享模块，
// 同时供 ui/timestamp-nav.js 的 seek 流程复用）；sendRuntimeMessage 由
// ../shared/messaging.js 提供（shared 传输层）。
// 随候选5 清理孤儿 import：renderMarkdown / stripThinkBlocks（ui/markdown）、
// linkifyAssistantTimestamps（ui/timestamp-nav）在本文件已无使用点。
//
// PR5 对话内核搬运：对话内核 11 个子模块（chat-runtime / chat-state /
// conversation-store / context-policy / subtitle-wait / no-subtitle /
// offscreen-ensure / presets / providers / context-sync / context-load）迁入
// ../chat/（上面历史注释里的旧路径仅作沿革记录）。本文件改 import 指向新家，
// sidepanel 功能保持完好（过渡期并存，工单 08 决议）；providers 的选中平台
// 持久化通道随迁移换 chrome.storage.local（模块内做 localStorage 一次性搬迁）。

import { PLAYER_AI_QUICK_ACTION_STORAGE_KEY } from "../core/defaults.js";

import { buildContextKey, doesTabMatchContextUrl, MAX_SAVED_CONVERSATIONS } from "../ai/conversation.js";
import { escapeHtml } from "../shared/string-utils.js";
import { sendMessageToActiveTab } from "../shared/tab-utils.js";
import { ensureReaderContentReady } from "../core/content-orchestration-wiring.js";
import {
  resolveAiSidepanelContext,
  resolveAiSidepanelPageRef
} from "../ai/context-resolver.js";
import { normalizeMarkdownForSectionPaste } from "../notes/paste.js";
// PR5 对话内核搬运：对话内核子模块迁入 ../chat/（sidepanel 过渡期保活，仅改
// import 指向；context-load 的消息链策略在此组装，进程内直读策略供 reader 壳
// 任务使用）。DOM 壳三件（lists/notices/popovers）与 player-ai 请求消费仍在本
// 目录（随各自任务迁出/摘除）。
import { createChatRuntime } from "../chat/chat-runtime.js";
import { createSubtitleWaiter, isContextPending } from "../chat/subtitle-wait.js";
import {
  NO_SUBTITLE_SEND_BLOCKED,
  buildNoSubtitleNotice,
  isNoSubtitleEmptyContext,
  type NoSubtitleReason
} from "../chat/no-subtitle.js";
import { createConversationStore } from "../chat/conversation-store.js";
import { ensureChatOffscreenDocument } from "../chat/offscreen-ensure.js";
import { sidepanelState } from "../chat/chat-state.js";
// ensureChatOffscreenDocument / context-load 的 content 就绪探针（带顶层
// chrome 副作用，仅在组合根 import）。
import { sendMessageToTab } from "../shared/tab-utils.js";
// 候选09：player AI 快捷动作消费 / 预设提示词 CRUD；候选5：六块 UI/编排子模块。
// 各工厂的 deps 组装见下文对应段落。
import { createPlayerAiQuickActions } from "./sidepanel-player-ai-requests.js";
import { createPresetPrompts } from "../chat/presets.js";
import { createSidepanelLists } from "./sidepanel-lists.js";
import { createConversationFeedback } from "./sidepanel-notices.js";
import { createProviderPrefs } from "../chat/providers.js";
import { createLiveContextSync } from "../chat/context-sync.js";
import { createContextLoad, createMessageChainContextFetch } from "../chat/context-load.js";
import { createPopovers } from "./sidepanel-popovers.js";
import { updateModelSelectWidth } from "../ui/model-select-width.js";
// 上下文加载失败文案：ensureCurrentContextForSend 的失败闸共用策略模块常量。
import { CONTEXT_READ_FAILED_MESSAGE, isPinnedContextTruthy } from "../chat/context-policy.js";

const CONVERSATIONS_STORAGE_KEY = "boc_ai_conversations_v1";
const NON_VIDEO_CONTEXT_MESSAGE = "当前页非 B 站视频页面，<br>无法获取当前页面信息作为对话上下文，<br>仅支持 AI 对话。";

const els = {
  header: document.querySelector<HTMLElement>(".sp-header"),
  contextChip: document.getElementById("spContextChip") as HTMLButtonElement,
  refreshBtn: document.getElementById("spRefreshBtn") as HTMLButtonElement,
  modelSelect: document.getElementById("spModelSelect") as HTMLSelectElement,
  thinkingToggle: document.querySelector<HTMLElement>(".sp-thinking-toggle"),
  thinkingBtns: document.querySelectorAll<HTMLElement>(".sp-thinking-btn"),
  settingsBtn: document.getElementById("spSettingsBtn") as HTMLButtonElement,
  newChatBtn: document.getElementById("spNewChatBtn") as HTMLButtonElement,
  presetBtn: document.getElementById("spPresetBtn") as HTMLButtonElement,
  historyBtn: document.getElementById("spHistoryBtn") as HTMLButtonElement,
  toolbar: document.querySelector<HTMLElement>(".sp-toolbar"),
  presetPopover: document.getElementById("spPresetPopover") as HTMLElement,
  presetList: document.getElementById("spPresetList") as HTMLElement,
  presetInput: document.getElementById("spPresetInput") as HTMLInputElement,
  presetAddBtn: document.getElementById("spPresetAddBtn") as HTMLButtonElement,
  historyPopover: document.getElementById("spHistoryPopover") as HTMLElement,
  historyList: document.getElementById("spHistoryList") as HTMLElement,
  historyClearBtn: document.getElementById("spHistoryClearBtn") as HTMLButtonElement | null,
  messages: document.getElementById("spMessages") as HTMLElement,
  input: document.getElementById("spInput") as HTMLTextAreaElement,
  stopBtn: document.getElementById("spStopBtn") as HTMLButtonElement | null,
};

// 无字幕视频做音频转写时，content 会广播阶段；刷新键转圈等待期间据此显示
// 一行转写提示，替代仅有图标旋转却没有说明的状态。只在转写阶段展示，其余
// 阶段（含转写结束后未再广播的情况）经由 setRefreshing(false) 与 phase 判断隐藏。
// asr-done/asr-failed：一键总结若正在等待转写（subtitleWaiter.wait），立即
// 触发一轮上下文轮询，不必等 4 秒间隔。
chrome.runtime.onMessage.addListener((message) => {
  const statusMessage = message as { type?: string; phase?: string } | null;
  if (statusMessage?.type !== "boc-subtitle-status") {
    return;
  }
  const notice = document.getElementById("spAsrNotice");
  if (notice) {
    notice.hidden = statusMessage.phase !== "asr-transcribing";
  }
  if (statusMessage.phase === "asr-transcribing") {
    sidepanelState.asrTranscribingActive = true;
  } else if (statusMessage.phase === "asr-done" || statusMessage.phase === "asr-failed") {
    sidepanelState.asrTranscribingActive = false;
    subtitleWaiter.kick();
  }
});

// 跨模块共享状态（contextData / currentContextKey / providers / chatHistory /
// savedConversations / currentConversationId / currentConversationMeta /
// liveContextData / liveContextKey / liveTabUrl / aiPrefs / asrTranscribingActive /
// aiThinkingLevel）收拢在 ../chat/chat-state.ts 的 sidepanelState，本文件与各
// 子模块直接 import 读写。以下为纯局部单例。
let suggestionsNode: HTMLElement | null = null;
let initCompleted = false;

// 消息区反馈（通知条/居中错误/建议区清理/近底判定）：contextNoticeTimer 是
// notices 模块闭包私有状态；定时器用 window（测试可注入 fake）。
const feedback = createConversationFeedback({
  messages: els.messages,
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => window.clearTimeout(handle),
  scrollToBottom: () => chatRuntime.scrollToBottom(),
  getSuggestionsNode: () => suggestionsNode,
  setSuggestionsNode: (node) => {
    suggestionsNode = node;
  }
});
const {
  showConversationContextNotice,
  removeConversationContextNotice,
  showConversationContextError,
  removeCenteredState,
  removeSuggestions,
  isMessagesNearBottom
} = feedback;

// 会话状态（会话列表/当前会话/上下文）已收拢至 sidepanelState，store 直接
// import 读写；deps 只剩 UI/transport 回调、storage 抽象与常量。
const conversationStore = createConversationStore({
  renderHistoryList: () => lists.renderHistoryList(),
  renderInitialState,
  updateContextChip: () => contextLoad.updateContextChip(),
  showConversationContextNotice,
  showConversationContextError,
  removeConversationContextNotice,
  hideHistoryPopover: () => popovers.hideHistoryPopover(),
  loadContextState: (opts) => contextLoad.loadContextState(opts),
  resolveAiSidepanelContext,
  resolveAiSidepanelPageRef,
  // 流式中删除当前会话 / 清空全部 / restoreLatest 无匹配时由 store 同步调用：
  // 断 port、清在途一问一答、清消息区并退出流式 UI 态（对应 restartChat 的
  // 清理动作，但不清会话状态——那由 store 自己做）。store 不直接 import
  // chatRuntime，依赖方向由本文件组装；回调幂等（非流式时为无害空操作）。
  stopActiveChat: () => {
    chatRuntime.resetStreamState();
    resetConversationView();
    setStreamingUiState(false);
  },
  storage: chrome.storage.local,
  conversationsStorageKey: CONVERSATIONS_STORAGE_KEY,
  maxSavedConversations: MAX_SAVED_CONVERSATIONS
});

// 三列表渲染（建议/预设/历史）+ 预设提示词插入。insertPresetPrompt /
// hidePresetPopover / hideHistoryPopover 与本实例/popovers 实例互引，惰性
// 箭头接线（回调执行时实例已存在）。
const lists = createSidepanelLists({
  presetList: els.presetList,
  historyList: els.historyList,
  historyClearBtn: els.historyClearBtn,
  input: els.input,
  applyById: (id) => conversationStore.applyById(id),
  deleteById: (id) => conversationStore.deleteById(id),
  removePresetPrompt: (index) => presets.removePresetPrompt(index),
  autosizeInput,
  onSuggestionClick: () => chatRuntime.sendMessage(),
  getSuggestionsNode: () => suggestionsNode,
  insertPresetPrompt: (prompt) => lists.insertPresetPrompt(prompt),
  hidePresetPopover: () => popovers.hidePresetPopover(),
  hideHistoryPopover: () => popovers.hideHistoryPopover()
});

// 预设/历史 popover 开合与文档级外点关闭。
const popovers = createPopovers({
  presetPopover: els.presetPopover,
  historyPopover: els.historyPopover,
  presetBtn: els.presetBtn,
  historyBtn: els.historyBtn,
  presetInput: els.presetInput,
  renderPresetPrompts: () => lists.renderPresetPrompts(),
  renderHistoryList: () => lists.renderHistoryList()
});

// 上下文状态加载（读标签页状态 → 按策略动作执行编排副作用）+ context chip。
// 流式守卫判定惰性取 chatRuntime（回调执行时实例已存在）。
// PR5：拉数据一段抽成 ContextFetch 策略注入点——sidepanel 过渡期用扩展页
// 消息链（getActiveTab + getAiSidepanelState，行为与迁移前一致）。
const contextLoad = createContextLoad({
  fetchContext: createMessageChainContextFetch({
    getActiveTab,
    ensureReaderContentReady: (tabId) => ensureReaderContentReady(tabId),
    sendMessageToTab: (tabId, message) => sendMessageToTab(tabId, message)
  }),
  getActiveTab,
  contextChip: els.contextChip,
  renderHistoryList: () => lists.renderHistoryList(),
  renderInitialState,
  renderSuggestions: () => lists.renderSuggestions(),
  resetConversationView,
  restartChat: (opts) => restartChat(opts),
  restoreLatest: () => conversationStore.restoreLatest(),
  isStreaming: () => chatRuntime.isStreaming(),
  hasPendingUserPrompt: () => chatRuntime.hasPendingUserPrompt()
});
const { loadContextState, updateContextChip, openCurrentContextUrl } = contextLoad;

// chat 流状态机：自身流状态（activePort 等）与自动滚动标志（shouldAutoScroll-
// Messages）都在 runtime 闭包内；会话状态读 sidepanelState；deps 只剩 DOM
// 容器/元素引用、store 实例与 UI/transport 回调。
const chatRuntime = createChatRuntime({
  // ---- DOM 容器 / 元素引用（sidepanel 模块级 `els`）----
  messages: els.messages,
  input: els.input,
  stopBtn: els.stopBtn,
  // ---- conversation-store 窄接口（05 产出实例；isCurrent 为会话身份守卫
  // 的单一判定点，chat-runtime finalize/stopped 持久化前调用）----
  store: conversationStore,
  // ---- UI 门面（布局 / UI 回调的纯分组，DOM 布局留在 sidepanel）----
  ui: {
    setStreamingUiState,
    showConversationContextNotice,
    removeConversationContextNotice,
    hidePresetPopover: () => popovers.hidePresetPopover(),
    hideHistoryPopover: () => popovers.hideHistoryPopover(),
    removeCenteredState,
    removeSuggestions,
    resetConversationView,
    autosizeInput
  },
  // ---- AI 域 / 上下文 / 传输辅助（sidepanel 本地）----
  ensureCurrentContextForSend,
  getProviderId: () => els.modelSelect.value,
  getTimestampNavDeps,
  normalizeMarkdownForSectionPaste,
  // 发送前 ensure offscreen 文档再连端口：文档死亡后自愈重建（ensure 失败
  // 不阻断 connect，维持历史行为，由连接结果兜底）
  connectPort: async () => {
    await ensureChatOffscreenDocument();
    return chrome.runtime.connect({ name: "offscreen-chat" });
  }
});

// 候选09：player AI 快捷动作消费与预设提示词 CRUD 的组装（deps 注入本文件的
// 编排回调与 DOM 引用；sendMessage 经惰性箭头取 chatRuntime，回调执行时才读）。
const playerAiQuickActions = createPlayerAiQuickActions({
  getActiveTab,
  startNewConversation,
  sendMessage: () => chatRuntime.sendMessage(),
  input: els.input,
  autosizeInput
});
const presets = createPresetPrompts({
  presetInput: els.presetInput,
  renderPresetPrompts: () => lists.renderPresetPrompts()
});

// AI 平台加载渲染 + 思考档位（widthEls 即本文件模块级 `els`，含度量所需的
// toolbar/thinkingToggle/presetBtn）；persistAiPresetPrompts 惰性互引 presets。
const providerPrefs = createProviderPrefs({
  modelSelect: els.modelSelect,
  thinkingBtns: els.thinkingBtns,
  widthEls: els,
  renderPresetPrompts: () => lists.renderPresetPrompts(),
  persistAiPresetPrompts: () => presets.persistAiPresetPrompts()
});
const { loadProvidersAndPrefs, renderModelSelect, setThinkingLevel } = providerPrefs;

// 实时上下文同步调度（防抖 + 强刷合并 + 触发处理体；post-sync 分支编排
// syncLiveContextState 留在组合根——流式守卫与三个渲染回调的组合是页面级职责）。
const liveContextSync = createLiveContextSync({
  sync: (forceRefresh = false) => syncLiveContextState(forceRefresh),
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => window.clearTimeout(handle)
});

init().catch((err) => {
  resetConversationView(`初始化失败：${escapeHtml((err as Error)?.message || err)}`);
});

// 抓取/音频转写进行中（content 的 subtitleFetchState 为 loading 且字幕体为空）
// 时等待其完成再放行发送流程，状态机本体在 ../chat/subtitle-wait.ts（可测）。
// 这里只组装 deps：轮询读当前上下文、提示走消息区 notice、定时器用 window。
// 引用的 loadContextState / 通知函数都是组装后的实例方法（惰性接线），放在
// 广播监听之前只为保证监听触发时组装已完成。
const SUBTITLE_WAIT_POLL_MS = 4000;
const subtitleWaiter = createSubtitleWaiter({
  pollIntervalMs: SUBTITLE_WAIT_POLL_MS,
  pollContext: async () => {
    const ok = await loadContextState({ forceRefresh: false, silent: true }).catch(() => false);
    // loadContextState 无论走哪个分支都会先更新 liveContextData；等待期间
    // 可能有流式守卫冻结 contextData，读 liveContextData 保证数据不断供。
    const snapshot = ok ? (sidepanelState.liveContextData || sidepanelState.contextData) : null;
    return {
      ok: Boolean(snapshot),
      pending: isContextPending(snapshot, { asrTranscribingActive: sidepanelState.asrTranscribingActive })
    };
  },
  showWaitingNotice: () => showConversationContextNotice("正在等待音频转写完成，完成后自动开始总结…", 0),
  removeNotice: removeConversationContextNotice,
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => window.clearTimeout(handle)
});

async function init(): Promise<void> {
  // Chrome 114+：让 Side Panel 不随标签页关闭而销毁，切换网站时保持对话
  try {
    await chrome.sidePanel.setPanelBehavior({ panelBehavior: "separate" });
  } catch {}

  // 创建 Offscreen Document，把 SSE 流式请求移到隐藏页面，避免 Side Panel 被
  // 冻结。创建参数抽在 ensureChatOffscreenDocument（../chat/offscreen-ensure.ts），
  // 与每次聊天发送前（connectPort）复用：文档意外死亡后下一封消息自动重建，
  // 聊天不再静默坏到面板重开。ensure 失败不阻断 init（helper 内部吞掉）。
  await ensureChatOffscreenDocument();

  bindEvents();
  await loadProvidersAndPrefs();
  await conversationStore.loadAll();
  await loadContextState();
  await conversationStore.restoreLatest();
  renderInitialState();
  autosizeInput();
  initCompleted = true;
  await playerAiQuickActions.consumePendingPlayerAiQuickAction();
}

function bindEvents(): void {
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      chatRuntime.sendMessage();
    }
  });
  els.input.addEventListener("input", autosizeInput);
  els.messages.addEventListener("scroll", () => {
    chatRuntime.setAutoScroll(isMessagesNearBottom());
  });
  els.settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  els.contextChip.addEventListener("click", () => {
    void openCurrentContextUrl();
  });
  els.newChatBtn.addEventListener("click", () => {
    void startNewConversation();
  });
  els.refreshBtn.addEventListener("click", () => refreshContextManually());
  els.presetBtn.addEventListener("click", popovers.togglePresetPopover);
  els.historyBtn.addEventListener("click", popovers.toggleHistoryPopover);
  els.historyClearBtn?.addEventListener("click", () => {
    void conversationStore.clearAll();
  });
  els.stopBtn?.addEventListener("click", () => {
    chatRuntime.stopActiveStream();
  });
  els.presetAddBtn.addEventListener("click", () => presets.addPresetPrompt());
  els.presetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      presets.addPresetPrompt();
    }
  });
  els.modelSelect.addEventListener("change", () => {
    const providerId = els.modelSelect.value;
    if (providerId) {
      // PR5：选中平台的持久化通道换 chrome.storage.local（providers 模块的
      // setSelectedProvider）；原 localStorage.setItem 随通道改造退役。
      providerPrefs.setSelectedProvider(providerId);
      sidepanelState.aiPrefs.defaultModel = providerId;
      chrome.storage.sync.set({ defaultModel: providerId }).catch(() => {});
    } else {
      sidepanelState.aiPrefs.defaultModel = "";
      chrome.storage.sync.set({ defaultModel: "" }).catch(() => {});
    }
    updateModelSelectWidth(els);
  });
  els.thinkingBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      void setThinkingLevel(btn.dataset.level || "off");
    });
  });
  window.addEventListener("resize", () => updateModelSelectWidth(els));
  document.addEventListener("click", popovers.handleDocumentClick);
  // 候选5：可见性/聚焦/切签恢复的触发处理体在 ../chat/context-sync.ts
  //（handlers，语义与迁移前一致），本文件只负责监听挂载。
  document.addEventListener("visibilitychange", liveContextSync.handlers.onVisibilityChange);
  window.addEventListener("focus", liveContextSync.handlers.onFocus);
  chrome.tabs.onActivated.addListener(liveContextSync.handlers.onTabActivated);
  chrome.tabs.onUpdated.addListener(liveContextSync.handlers.onTabUpdated);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      (areaName === "sync" &&
        (changes.aiProviders || changes.aiSystemPrompt || changes.aiInitialQuickPrompts || changes.aiPresetPrompts || changes.defaultModel || changes.aiThinkingLevel)) ||
      (areaName === "local" && changes.aiProviderKeys)
    ) {
      void refreshProvidersAndPrefsAfterExternalChange();
    }
    if (areaName === "local" && changes[PLAYER_AI_QUICK_ACTION_STORAGE_KEY] && initCompleted) {
      void playerAiQuickActions.handlePlayerAiQuickActionRequest(changes[PLAYER_AI_QUICK_ACTION_STORAGE_KEY].newValue);
    }
  });
}

function autosizeInput(): void {
  els.input.style.height = "auto";
  const next = Math.min(els.input.scrollHeight, 320);
  const minHeight = document.body.classList.contains("sp-non-video-context") ? 72 : 94;
  els.input.style.height = `${Math.max(next, minHeight)}px`;
}

function setStreamingUiState(isStreaming: boolean, { stopping = false }: { stopping?: boolean } = {}): void {
  els.input.disabled = isStreaming;
  if (els.stopBtn) {
    els.stopBtn.hidden = !isStreaming;
    els.stopBtn.disabled = stopping;
    els.stopBtn.textContent = stopping ? "停止中..." : "停止";
  }
}

// AI 平台 / 预设：实现在 ../chat/providers.ts（候选5 迁出；PR5 持久化通道
// localStorage → chrome.storage.local），本文件只组装 deps 并保留「外部设置
// 变更 → 刷新」编排（流式守卫 + 重渲染留在组合根）。
async function refreshProvidersAndPrefsAfterExternalChange(): Promise<void> {
  // 选中平台回退取 providers 模块的 storage 闭包缓存（原 localStorage.getItem
  // 的替代，值源相同）。
  const previousProviderId = String(els.modelSelect?.value || providerPrefs.getStoredSelectedProviderId() || "").trim();
  await loadProvidersAndPrefs({ preferredProviderId: previousProviderId });
  if (chatRuntime.isStreaming()) {
    return;
  }
  lists.renderHistoryList();
  renderInitialState();
}

// 候选09：player AI 快捷动作消费（consumePendingPlayerAiQuickAction /
// normalizePlayerAiQuickActionRequest / handlePlayerAiQuickActionRequest /
// runPlayerAiQuickActionPrompt）迁往 ./sidepanel-player-ai-requests.ts，实例
// playerAiQuickActions 在文件头组装。

// ============================================================
// 上下文状态加载 / context chip：实现在 ../chat/context-load.ts（候选5
// 迁出；PR5 起拉数据段为可注入 ContextFetch 策略，分支判定仍在
// ../chat/context-policy.ts）。
// ============================================================

function renderInitialState(): void {
  updateSidepanelLayoutState();
  if (!sidepanelState.contextData) {
    resetConversationView("当前页面不是 B 站视频页，无法读取视频信息。");
    return;
  }
  if (!sidepanelState.providers.length) {
    resetConversationView('还没有配置 AI 平台，<a href="#" id="spOpenSettings">前往设置</a>');
    document.getElementById("spOpenSettings")?.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    return;
  }
  if (sidepanelState.chatHistory.length) {
    renderConversationMessages();
    return;
  }
  if (sidepanelState.contextData.isVideoContext === false) {
    resetConversationView(NON_VIDEO_CONTEXT_MESSAGE);
    return;
  }
  resetConversationView("");
}

function resetConversationView(stateHtml = ""): void {
  updateSidepanelLayoutState();
  els.messages.innerHTML = "";
  if (stateHtml) {
    const stateNode = document.createElement("div");
    stateNode.className = "sp-center-error";
    stateNode.innerHTML = stateHtml;
    els.messages.appendChild(stateNode);
  }
  suggestionsNode = document.createElement("div");
  suggestionsNode.className = "sp-suggestions";
  suggestionsNode.id = "spSuggestions";
  els.messages.appendChild(suggestionsNode);
  lists.renderSuggestions();
  lists.renderPresetPrompts();
  chatRuntime.setAutoScroll(true);
  chatRuntime.scrollToBottom(true);
}

// 三列表渲染 / 预设插入：实现在 ./sidepanel-lists.ts（候选5 迁出）。

// 预设/历史 popover 开合：实现在 ./sidepanel-popovers.ts（候选5 迁出）。

// 实时上下文同步调度：实现在 ../chat/context-sync.ts（候选5 迁出，
// syncLiveContextState 的 post-sync 分支编排留在下方组合根）。

async function syncLiveContextState(forceRefresh = false): Promise<void> {
  const ok = await loadContextState({ forceRefresh, silent: true }).catch(() => false);
  if (sidepanelState.currentConversationMeta?.pinnedContext || chatRuntime.isStreaming() || chatRuntime.hasPendingUserPrompt()) {
    updateContextChip();
    return;
  }
  if (!ok || !sidepanelState.contextData || !sidepanelState.providers.length || !sidepanelState.chatHistory.length) {
    renderInitialState();
    return;
  }
  lists.renderSuggestions();
}

// 候选09：预设提示词 CRUD + 双存储同步（addPresetPrompt / removePresetPrompt /
// persistAiPresetPrompts）迁往 ../chat/presets.ts，实例 presets 在文件头组装。

function updateSidepanelLayoutState(): void {
  const useCompactInput = Boolean(
    sidepanelState.contextData &&
    sidepanelState.contextData.isVideoContext === false &&
    !sidepanelState.chatHistory.length &&
    !sidepanelState.currentConversationMeta?.pinnedContext
  );
  document.body.classList.toggle("sp-non-video-context", useCompactInput);
  if (els.input) {
    autosizeInput();
  }
}

async function refreshContextManually(): Promise<void> {
  if (els.refreshBtn.disabled) {
    return;
  }
  setRefreshing(true);
  try {
    const ok = await loadContextState({ forceRefresh: true });
    if (ok) {
      if (!sidepanelState.contextData || !sidepanelState.providers.length || !sidepanelState.chatHistory.length) {
        renderInitialState();
      } else {
        lists.renderSuggestions();
      }
    }
  } finally {
    setRefreshing(false);
  }
}

function setRefreshing(isRefreshing: boolean): void {
  els.refreshBtn.disabled = isRefreshing;
  els.refreshBtn.classList.toggle("is-loading", isRefreshing);
  if (isRefreshing) {
    els.refreshBtn.setAttribute("aria-busy", "true");
  } else {
    els.refreshBtn.removeAttribute("aria-busy");
    // 刷新结束即转写（若有）收尾，收起“正在音频转写”提示。
    const notice = document.getElementById("spAsrNotice");
    if (notice) {
      notice.hidden = true;
    }
  }
}

async function startNewConversation(): Promise<void> {
  popovers.hidePresetPopover();
  popovers.hideHistoryPopover();
  setRefreshing(true);
  try {
    await loadContextState({ forceRefresh: true, silent: true });
  } finally {
    setRefreshing(false);
  }
  if (sidepanelState.liveContextData) {
    sidepanelState.contextData = { ...sidepanelState.liveContextData };
    sidepanelState.currentContextKey = sidepanelState.liveContextKey || buildContextKey(sidepanelState.liveContextData);
    updateContextChip();
  }
  restartChat({ keepContext: true });
  renderInitialState();
}

// ============================================================
// 消息区渲染（历史对话回放 → chat-runtime 渲染）
// ============================================================
function renderConversationMessages(): void {
  updateSidepanelLayoutState();
  els.messages.innerHTML = "";
  suggestionsNode = null;
  if (!sidepanelState.chatHistory.length) {
    resetConversationView("");
    return;
  }
  sidepanelState.chatHistory.forEach((message, index) => {
    if (message.role === "user") {
      chatRuntime.appendUserMessage(message.content, false);
      return;
    }
    const node = document.createElement("div");
    node.className = "sp-msg sp-msg-assistant";
    chatRuntime.renderAssistantMessage(node, String(message.content || ""), {
      userPrompt: findPreviousUserPrompt(index)
    });
    els.messages.appendChild(node);
  });
  chatRuntime.setAutoScroll(true);
  chatRuntime.scrollToBottom(true);
}

// 历史回放时找该助手消息的前一条用户消息（注入 renderAssistantMessage 的 userPrompt）
function findPreviousUserPrompt(index: number): string {
  for (let i = Number(index) - 1; i >= 0; i -= 1) {
    const item = sidepanelState.chatHistory[i];
    if (item?.role === "user" && typeof item.content === "string") {
      return item.content;
    }
  }
  return "";
}

// 发送前确保当前上下文就绪（pinned 对话补水 / 普通对话读当前页；抓取或
// 音频转写进行中时先等待，避免空字幕上下文直接发给模型）。最终快照若是
// 「无字幕收尾」（empty 且字幕体为空）则拦截发送：返回 NO_SUBTITLE_SEND_
// BLOCKED 类型化信号让 sendMessage 提前返回（不追加用户消息、不落
// chatHistory、不发起 port），并按 noSubtitleReason 显示对应 notice。
async function ensureCurrentContextForSend(): Promise<boolean | string> {
  // pinned 判定沿用本调用点的原始语义（真值判断，与 loadContextState 的严格
  // 相等不同——见 ../chat/context-policy.ts 两个谓词的疑义记录）。
  if (isPinnedContextTruthy(sidepanelState.currentConversationMeta)) {
    await loadContextState({ forceRefresh: false, silent: true }).catch(() => null);
    return conversationStore.hydratePinned();
  }
  // 失败闸把「无标签页」与「读取失败」合并为同一文案（与策略模块的
  // resolveNoTabPlan 语义不同：这里即使静默加载也会重置视图），保持原状。
  const ok = await loadContextState({ forceRefresh: false, silent: true });
  if (!ok || !sidepanelState.contextData) {
    resetConversationView(CONTEXT_READ_FAILED_MESSAGE);
    return false;
  }
  const ready = await subtitleWaiter.wait();
  if (!ready) {
    resetConversationView(CONTEXT_READ_FAILED_MESSAGE);
    return false;
  }
  // 等待期间 contextData 可能停在旧快照（守卫分支或就绪瞬间），放行前重取
  // 一次，确保发送出去的是转写完成后的完整字幕。
  await loadContextState({ forceRefresh: false, silent: true }).catch(() => null);
  if (!sidepanelState.contextData) {
    resetConversationView(CONTEXT_READ_FAILED_MESSAGE);
    return false;
  }
  if (isNoSubtitleEmptyContext(sidepanelState.contextData)) {
    const notice = buildNoSubtitleNotice(sidepanelState.contextData.noSubtitleReason as NoSubtitleReason);
    showConversationContextNotice(notice.message, 0, { openSettingsAction: notice.openSettings });
    return NO_SUBTITLE_SEND_BLOCKED;
  }
  return true;
}

// 时间戳跳转依赖包（注入 timestamp-nav，seek 复用 shared 的 sendMessageToActiveTab）
function getTimestampNavDeps() {
  return {
    contextUrl: String(sidepanelState.contextData?.url || sidepanelState.currentConversationMeta?.contextUrl || "").trim(),
    notice: showConversationContextNotice,
    getActiveTab,
    matchContextUrl: doesTabMatchContextUrl,
    sendMessageToActiveTab: sendMessageToActiveTab<{ ok?: boolean; error?: string } | null>
  };
}

// 重启对话：清流状态 + 清会话状态 + 重置消息区（编排入口，被新对话/上下文切换复用）
function restartChat({ keepContext = false }: { keepContext?: boolean } = {}): void {
  chatRuntime.resetStreamState();
  sidepanelState.chatHistory = [];
  sidepanelState.currentConversationId = "";
  sidepanelState.currentConversationMeta = null;
  if (!keepContext) {
    sidepanelState.currentContextKey = buildContextKey(sidepanelState.contextData);
  }
  updateContextChip();
  resetConversationView("");
  setStreamingUiState(false);
  els.input.value = "";
  autosizeInput();
}

// 消息区提示 / 近底判定：实现在 ./sidepanel-notices.ts（候选5 迁出）。

// 获取当前活动标签页（transport 辅助，注入 store/timestamp-nav/context-load）
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}
