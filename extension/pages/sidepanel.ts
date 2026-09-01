// sidepanel.ts — UI 绑定 + 编排薄层（sidepanel-split ticket 08 收尾产物）。
//
// 02-07 已把各域实现抽走：helper 消重到 shared/notes/bilibili（02）、markdown
// 渲染到 ../ui/markdown.js（03）、时间戳跳转到 ../ui/timestamp-nav.js（04）、
// 对话持久化到 ./sidepanel-conversation-store.ts（05）、笔记粘贴归一化到
// ../notes/paste.js（06）、chat 流状态机到 ./sidepanel-chat-runtime.ts（07）。
//
// 本文件只剩四类东西：
//   1. init / bindEvents（启动编排、事件绑定）
//   2. 上下文 chip、各列表（历史/建议/预设）与消息区渲染
//   3. 滚动与布局更新、popover toggle、autosizeInput、通知显示
//   4. 对 02-07 模块的编排调用（loadContextState、上下文同步调度、新对话/
//      刷新等页面级流程）
// 候选09 又自本文件迁出三块：player AI 快捷动作消费 →
// ./sidepanel-player-ai-requests.ts、预设提示词 CRUD + 双存储同步 →
// ./sidepanel-presets.ts、modelSelect 宽度度量 → ../ui/model-select-width.js
//（本文件只做 import 与工厂组装/调用点适配）。
// 候选08 再把 loadContextState 的四态分支判定抽到 ./sidepanel-context-policy.ts
//（纯函数「输入 → 动作」映射，可直测），loadContextState /
// ensureCurrentContextForSend 只负责拉数据、按动作执行编排副作用。
// 跨子模块共享的可变状态（上下文/会话/AI 偏好等 13 个字段）收拢在
// ./sidepanel-state.ts 的 sidepanelState，本文件与 conversation-store /
// chat-runtime 直接 import 读写，deps 只剩回调与 DOM/storage。
// 页面级 transport 辅助（delay / waitForTabComplete / sendMessageToActiveTab）
// 由 ../shared/tab-utils.js 提供（08 新增共享模块，同时供
// ui/timestamp-nav.js 的 seek 流程复用）；truncate 由 ../shared/string-utils.js
// 提供；sendRuntimeMessage 由 ../shared/messaging.js 提供（shared 传输层）。

import {
  DEFAULT_PRESET_PROMPTS,
  PLAYER_AI_QUICK_ACTION_STORAGE_KEY
} from "../core/defaults.js";
import type { Settings } from "../core/defaults.js";
import {
  normalizeAiInitialQuickPrompts,
  normalizeAiPresetPrompts,
  normalizeAiThinkingLevel
} from "../core/validators.js";

import {
  buildContextKey,
  doesConversationMatchCurrentContext,
  doesTabMatchContextUrl,
  formatConversationTimestamp,
  buildConversationTitleDisplay,
  MAX_SAVED_CONVERSATIONS
} from "../ai/conversation.js";
import { escapeHtml, truncate } from "../shared/string-utils.js";
import { sendMessageToActiveTab, sendMessageToTab, waitForTabComplete } from "../shared/tab-utils.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { renderMarkdown, stripThinkBlocks } from "../ui/markdown.js";
import { ensureReaderContentReady } from "../core/content-orchestration-wiring.js";
import {
  getAiSidepanelState,
  resolveAiSidepanelContext,
  resolveAiSidepanelPageRef
} from "../ai/context-resolver.js";
import { linkifyAssistantTimestamps } from "../ui/timestamp-nav.js";
import { normalizeMarkdownForSectionPaste } from "../notes/paste.js";
import { createChatRuntime } from "./sidepanel-chat-runtime.js";
import { createSubtitleWaiter, isContextPending } from "./sidepanel-subtitle-wait.js";
import {
  NO_SUBTITLE_SEND_BLOCKED,
  buildNoSubtitleNotice,
  isNoSubtitleEmptyContext,
  type NoSubtitleReason
} from "./sidepanel-no-subtitle.js";
import { createConversationStore, type CreateConversationStoreDeps } from "./sidepanel-conversation-store.js";
import { ensureChatOffscreenDocument } from "./sidepanel-offscreen-ensure.js";
import { sidepanelState } from "./sidepanel-state.js";
import type { SidepanelContextSnapshot, SidepanelProvider } from "./sidepanel-state.js";
// 候选09：player AI 快捷动作消费 / 预设提示词 CRUD / modelSelect 宽度度量
// 三块实现迁出，本文件只组装 deps 与调用。
import { createPlayerAiQuickActions } from "./sidepanel-player-ai-requests.js";
import { createPresetPrompts } from "./sidepanel-presets.js";
import { updateModelSelectWidth } from "../ui/model-select-width.js";
// 上下文加载策略：no-tab / skip-unchanged / error / apply-pinned /
// blocked-streaming / apply-live 的「输入 → 动作」映射与失败文案常量。
import {
  CONTEXT_READ_FAILED_MESSAGE,
  LOAD_CONTEXT_ACTION,
  isPinnedContextStrict,
  isPinnedContextTruthy,
  resolveLoadContextAction,
  resolveNoTabPlan
} from "./sidepanel-context-policy.js";
import type { LoadContextStateOptions } from "./sidepanel-conversation-store.js";

const SELECTED_PROVIDER_KEY = "boc_ai_selected_provider";
const THINKING_LEVEL_KEY = "boc_ai_thinking_level";
const CONVERSATIONS_STORAGE_KEY = "boc_ai_conversations_v1";
const NON_VIDEO_CONTEXT_MESSAGE = "当前页非 B 站视频页面，<br>无法获取当前页面信息作为对话上下文，<br>仅支持 AI 对话。";

// getAiSidepanelState 的响应信封（payload 为 content 侧上下文快照；缺省
// 字段由运行时真值判定兜底，这里断言 payload 不为 undefined）
interface SidepanelStateResponse {
  ok?: boolean;
  error?: unknown;
  payload: SidepanelContextSnapshot | null;
}

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

// 抓取/音频转写进行中（content 的 subtitleFetchState 为 loading 且字幕体为空）
// 时等待其完成再放行发送流程，状态机本体在 ./sidepanel-subtitle-wait.ts（可测）。
// 这里只组装 deps：轮询读当前上下文、提示走消息区 notice、定时器用 window。
// 引用的 loadContextState / 通知函数都是函数声明（有提升），回调执行时才读
// contextData，放在广播监听之前只为保证监听触发时组装已完成。
// asr-transcribing 广播活跃标志：content 侧转写进行中的兜底信号。快照的
// subtitleFetchState 可能在转写中因辅助抓取失败被 content 清掉（resetClipState），
// 此时靠这个标志继续等待，不放行空字幕。标志本体在 sidepanelState.
// asrTranscribingActive（./sidepanel-state.ts，广播监听与轮询双侧读写）。
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
// aiThinkingLevel）收拢在 ./sidepanel-state.ts 的 sidepanelState，本文件与
// conversation-store / chat-runtime 直接 import 读写。以下为纯局部单例。
let suggestionsNode: HTMLElement | null = null;
let contextNoticeTimer = 0;
let liveContextSyncTimer = 0;
let liveContextSyncForceRefresh = false;
let initCompleted = false;

// 会话状态（会话列表/当前会话/上下文）已收拢至 sidepanelState，store 直接
// import 读写；deps 只剩 UI/transport 回调、storage 抽象与常量。
const conversationStore = createConversationStore({
  renderHistoryList,
  renderInitialState,
  updateContextChip,
  showConversationContextNotice,
  showConversationContextError,
  removeConversationContextNotice,
  hideHistoryPopover,
  loadContextState,
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
    hidePresetPopover,
    hideHistoryPopover,
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
  renderPresetPrompts
});

init().catch((err) => {
  resetConversationView(`初始化失败：${escapeHtml((err as Error)?.message || err)}`);
});

async function init(): Promise<void> {
  // Chrome 114+：让 Side Panel 不随标签页关闭而销毁，切换网站时保持对话
  try {
    await chrome.sidePanel.setPanelBehavior({ panelBehavior: "separate" });
  } catch {}

  // 创建 Offscreen Document，把 SSE 流式请求移到隐藏页面，避免 Side Panel 被
  // 冻结。创建参数抽在 ensureChatOffscreenDocument（./sidepanel-offscreen-ensure.ts），
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
  els.presetBtn.addEventListener("click", togglePresetPopover);
  els.historyBtn.addEventListener("click", toggleHistoryPopover);
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
      localStorage.setItem(SELECTED_PROVIDER_KEY, providerId);
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
  document.addEventListener("click", handleDocumentClick);
  // 候选5：可见性/聚焦/切签恢复这三类高频同步一律 forceRefresh=false——
  // 全网络重拉（content 侧 popup-refresh → refreshClip 全量重抓字幕）不是
  // 它们的语义，状态是否有变交给签名短路判定：content 侧未变时一次往返即
  // 返回 unchanged，不再有任何字幕/热评网络开销。
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scheduleLiveContextSync(false);
    }
  });
  window.addEventListener("focus", () => {
    scheduleLiveContextSync(false);
  });
  chrome.tabs.onActivated.addListener(() => {
    scheduleLiveContextSync(false);
  });
  chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: { status?: string; url?: string }, tab) => {
    if (!tab?.active) {
      return;
    }
    if (!changeInfo.url && changeInfo.status !== "complete") {
      return;
    }
    // URL 变化保持 forceRefresh=true：切 P/切视频必须全网络重拉（会与
    // debounce 里已挂起的 false 合并取强）。status==="complete" 保持 false：
    // 若 content 已随加载重建了状态，签名必然不同会走全量；相同则短路，
    // 不再借完成事件做无谓的强制重拉。
    scheduleLiveContextSync(Boolean(changeInfo.url));
  });
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

// ============================================================
// AI 平台 / 预设（providers + aiPrefs 加载，settings 获取走 core 域）
// ============================================================
async function loadProvidersAndPrefs({ preferredProviderId = "" }: { preferredProviderId?: string } = {}): Promise<void> {
  const [providersResp, settingsResp] = await Promise.all([
    sendRuntimeMessage({ type: "ai-providers-list" }),
    sendRuntimeMessage({ type: "get-settings" }).catch(() => ({ ok: false }))
  ]) as [
    { providers?: SidepanelProvider[] },
    { ok?: boolean; settings?: Partial<Settings> }
  ];
  sidepanelState.providers = Array.isArray(providersResp?.providers)
    ? providersResp.providers.filter((p) => p.enabled)
    : [];
  sidepanelState.aiPrefs = {
    aiSystemPrompt: String(settingsResp?.settings?.aiSystemPrompt || "").trim(),
    aiInitialQuickPrompts: normalizeAiInitialQuickPrompts(settingsResp?.settings?.aiInitialQuickPrompts),
    aiPresetPrompts: normalizeAiPresetPrompts(settingsResp?.settings?.aiPresetPrompts),
    defaultModel: String(settingsResp?.settings?.defaultModel || "").trim()
  };
  sidepanelState.aiThinkingLevel = normalizeAiThinkingLevel(
    settingsResp?.settings?.aiThinkingLevel ?? localStorage.getItem(THINKING_LEVEL_KEY)
  );
  if (!sidepanelState.aiPrefs.aiPresetPrompts.length) {
    sidepanelState.aiPrefs.aiPresetPrompts = DEFAULT_PRESET_PROMPTS.slice();
    void presets.persistAiPresetPrompts();
  }
  renderModelSelect(preferredProviderId);
  renderThinkingLevel();
  renderPresetPrompts();
}

// ai-providers-list 响应里的平台条目由 SidepanelProvider（sidepanel-state.ts）
// 描述：id 必填，name/model/enabled 宽松可选。

function renderModelSelect(preferredProviderId = ""): void {
  if (!sidepanelState.providers.length) {
    els.modelSelect.innerHTML = '<option value="">未配置平台</option>';
    els.modelSelect.disabled = true;
    els.modelSelect.style.width = "96px";
    return;
  }

  els.modelSelect.innerHTML = sidepanelState.providers
    .map((p) => {
      const label = String(p.model || p.name || "").trim();
      return `<option value="${escapeHtml(p.id)}">${escapeHtml(label)}</option>`;
    })
    .join("");

  const savedProviderId = String(preferredProviderId || sidepanelState.aiPrefs.defaultModel || localStorage.getItem(SELECTED_PROVIDER_KEY) || "").trim();
  const matchedProvider = sidepanelState.providers.find((item) => item.id === savedProviderId) || sidepanelState.providers[0];
  els.modelSelect.value = matchedProvider?.id || "";
  els.modelSelect.disabled = false;
  updateModelSelectWidth(els);
}

// ============================================================
// 思考档位（off / low / high）— 三档分段按钮，选中态持久化到 sync 设置
// ============================================================
function renderThinkingLevel(): void {
  els.thinkingBtns.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.level === sidepanelState.aiThinkingLevel);
    btn.setAttribute("aria-pressed", btn.dataset.level === sidepanelState.aiThinkingLevel ? "true" : "false");
  });
}

async function setThinkingLevel(level: string): Promise<void> {
  sidepanelState.aiThinkingLevel = normalizeAiThinkingLevel(level);
  renderThinkingLevel();
  localStorage.setItem(THINKING_LEVEL_KEY, sidepanelState.aiThinkingLevel);
  await sendRuntimeMessage({ type: "save-settings", settings: { aiThinkingLevel: sidepanelState.aiThinkingLevel } }).catch(() => null);
}

async function refreshProvidersAndPrefsAfterExternalChange(): Promise<void> {
  const previousProviderId = String(els.modelSelect?.value || localStorage.getItem(SELECTED_PROVIDER_KEY) || "").trim();
  await loadProvidersAndPrefs({ preferredProviderId: previousProviderId });
  if (chatRuntime.isStreaming()) {
    return;
  }
  renderHistoryList();
  renderInitialState();
}

// 候选09：player AI 快捷动作消费（consumePendingPlayerAiQuickAction /
// normalizePlayerAiQuickActionRequest / handlePlayerAiQuickActionRequest /
// runPlayerAiQuickActionPrompt）迁往 ./sidepanel-player-ai-requests.ts，实例
// playerAiQuickActions 在文件头组装。

// ============================================================
// 上下文状态加载（侧面板编排核心：读标签页状态 → 应用上下文 → 恢复对话）
// 分支判定收敛在 ./sidepanel-context-policy.ts（纯函数），本函数只按动作执行。
// ============================================================
async function loadContextState({ forceRefresh = false, silent = false }: LoadContextStateOptions = {}): Promise<boolean> {
  const hasPinnedConversation = isPinnedContextStrict(sidepanelState.currentConversationMeta);
  const tab = await getActiveTab();
  if (!tab?.id) {
    // 决策点一（消息往返之前）：无可用标签页，按计划做失败清理（文案/清上下文/
    // 重置视图的取舍全部来自策略计划）。
    const plan = resolveNoTabPlan({ hasPinnedConversation, silent });
    sidepanelState.liveContextData = null;
    sidepanelState.liveContextKey = "";
    sidepanelState.liveTabUrl = "";
    if (plan.clearContext) {
      sidepanelState.contextData = null;
      sidepanelState.currentContextKey = "";
    }
    updateContextChip();
    if (plan.resetView) {
      resetConversationView(plan.message as string);
    }
    return plan.returnValue;
  }

  const resp = await getAiSidepanelState(
    tab.id,
    {
      forceRefresh,
      // 候选5：带上次全量快照的签名，content 侧状态未变时一次往返即短路返回
      //（不重发整份字幕体、不拉热评）。forceRefresh=true 时 content 忽略签名，
      // 手动刷新语义不变。liveContextData 为空（首次/此前失败）时签名为空串，
      // content 必走全量。
      ifSignature: String(sidepanelState.liveContextData?.signature || "")
    },
    { ensureReaderContentReady, sendMessageToTab }
  )
    .then((payload) => ({ ok: true, payload }) as SidepanelStateResponse)
    .catch((error: unknown) => ({ ok: false, error: (error as Error).message }) as SidepanelStateResponse);
  sidepanelState.liveTabUrl = String(tab.url || "").trim();

  // 决策点二（消息往返之后）：「输入 → 动作」映射全部交给策略模块。forceRefresh
  // 只随消息透传给 content，不参与动作判定；isStreaming / hasPendingUserPrompt
  // 是 chat-runtime 的纯闭包读取，此处取值时点不改变可观察行为。
  const plan = resolveLoadContextAction({
    response: resp,
    hasPinnedConversation,
    silent,
    isStreaming: chatRuntime.isStreaming(),
    hasPendingUserPrompt: chatRuntime.hasPendingUserPrompt()
  });

  // 候选5：content 状态未变 → 保持现状不动（不 applyContextPayload、不重渲染、
  // 不刷新 live 快照、不转 spinner）。liveContextData 仍持有带 signature 的
  // 上次全量 payload：既是下一轮 ifSignature 的来源，也是等待轮询
  // （subtitle-wait）的判定数据源——返回 true 让轮询按旧快照继续判 pending，
  // ASR 完成时签名必然变化（subtitleFetchState/body.length），全量快照自然到位。
  if (plan.action === LOAD_CONTEXT_ACTION.SKIP_UNCHANGED) {
    return plan.returnValue;
  }

  if (plan.action === LOAD_CONTEXT_ACTION.ERROR) {
    sidepanelState.liveContextData = null;
    sidepanelState.liveContextKey = "";
    if (plan.clearContext) {
      sidepanelState.contextData = null;
      sidepanelState.currentContextKey = "";
    }
    updateContextChip();
    if (plan.resetView) {
      resetConversationView(plan.message as string);
    }
    return plan.returnValue;
  }

  // 三个成功动作（pinned / 流式守卫 / live）的公共前缀：live 快照照常落地，
  // 保证轮询与补水的数据源不断供。
  sidepanelState.liveContextData = resp.payload;
  sidepanelState.liveContextKey = buildContextKey(resp.payload);

  // pinned 与流式守卫的执行体逐字节相同：只落地 live 快照，不进主上下文。
  if (
    plan.action === LOAD_CONTEXT_ACTION.APPLY_PINNED ||
    plan.action === LOAD_CONTEXT_ACTION.BLOCKED_STREAMING
  ) {
    renderHistoryList();
    updateContextChip();
    return plan.returnValue;
  }

  // apply-live：正常路径，上下文变化时恢复最近对话并重渲染初始态。
  const contextChanged = applyContextPayload(resp.payload);
  renderHistoryList();
  if (contextChanged) {
    await conversationStore.restoreLatest();
    renderInitialState();
  }
  return plan.returnValue;
}

function applyContextPayload(payload: SidepanelContextSnapshot | null): boolean {
  const nextContext = payload && typeof payload === "object" ? payload : null;
  const nextKey = buildContextKey(nextContext);
  const contextChanged = Boolean(sidepanelState.currentContextKey && nextKey && nextKey !== sidepanelState.currentContextKey);

  sidepanelState.contextData = nextContext;
  sidepanelState.currentContextKey = nextKey;
  updateContextChip();

  if (contextChanged && !chatRuntime.isStreaming() && !chatRuntime.hasPendingUserPrompt()) {
    restartChat({ keepContext: true });
  } else {
    renderSuggestions();
  }
  return contextChanged;
}

function updateContextChip(): void {
  if (!sidepanelState.contextData) {
    els.contextChip.textContent = "无上下文";
    els.contextChip.title = "";
    els.contextChip.disabled = true;
    els.contextChip.classList.remove("is-mismatch");
    return;
  }

  const shortTitle = sidepanelState.contextData.title ? truncate(sidepanelState.contextData.title, 19) : "未知视频";
  els.contextChip.textContent = shortTitle;
  const mismatch = isBoundConversationMismatched();
  els.contextChip.classList.toggle("is-mismatch", mismatch);
  els.contextChip.title = sidepanelState.contextData.url
    ? `${sidepanelState.contextData.title || ""}${mismatch ? "\n当前页不是这个对话绑定的视频" : ""}\n点击跳转目标视频，或开启新对话`
    : sidepanelState.contextData.title || "";
  els.contextChip.disabled = !String(sidepanelState.contextData.url || "").trim();
}

function isBoundConversationMismatched(): boolean {
  if (sidepanelState.currentConversationMeta?.pinnedContext !== true) {
    return false;
  }
  const targetUrl = String(sidepanelState.currentConversationMeta?.contextUrl || sidepanelState.contextData?.url || "").trim();
  if (!targetUrl) {
    return false;
  }
  if (!sidepanelState.liveTabUrl) {
    return true;
  }
  return !doesTabMatchContextUrl(sidepanelState.liveTabUrl, targetUrl);
}

async function openCurrentContextUrl(): Promise<void> {
  const targetUrl = String(sidepanelState.contextData?.url || sidepanelState.currentConversationMeta?.contextUrl || "").trim();
  if (!targetUrl) {
    return;
  }
  const tab = await getActiveTab().catch(() => null);
  if (!tab?.id) {
    return;
  }
  try {
    const sameVideo = doesTabMatchContextUrl(tab.url || "", targetUrl);
    if (!sameVideo) {
      await chrome.tabs.update(tab.id, { url: targetUrl });
      await waitForTabComplete(tab.id);
    }
    await loadContextState({ forceRefresh: true, silent: true });
  } catch {}
}

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
  renderSuggestions();
  renderPresetPrompts();
  chatRuntime.setAutoScroll(true);
  chatRuntime.scrollToBottom(true);
}

function renderSuggestions(): void {
  if (!suggestionsNode) {
    return;
  }
  if (!sidepanelState.contextData || !sidepanelState.providers.length || sidepanelState.chatHistory.length || sidepanelState.contextData.isVideoContext === false) {
    suggestionsNode.innerHTML = "";
    return;
  }
  const prompts = normalizeAiInitialQuickPrompts(sidepanelState.aiPrefs.aiInitialQuickPrompts).filter(Boolean);
  suggestionsNode.innerHTML = prompts
    .map((prompt) => `<button type="button" class="sp-chip">${escapeHtml(prompt)}</button>`)
    .join("");
  suggestionsNode.querySelectorAll(".sp-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.input.value = btn.textContent || "";
      autosizeInput();
      chatRuntime.sendMessage();
    });
  });
}

function renderPresetPrompts(): void {
  if (!els.presetList) {
    return;
  }
  const prompts = Array.isArray(sidepanelState.aiPrefs.aiPresetPrompts) ? sidepanelState.aiPrefs.aiPresetPrompts : [];
  if (!prompts.length) {
    els.presetList.innerHTML = '<span class="sp-preset-empty">还没有预设提示词</span>';
    return;
  }
  els.presetList.innerHTML = prompts
    .map((prompt, index) => `
      <span class="sp-preset-item">
        <button type="button" class="sp-preset-chip" data-index="${index}" title="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>
        <button type="button" class="sp-preset-remove" data-index="${index}" aria-label="删除预设提示词">×</button>
      </span>
    `)
    .join("");
  els.presetList.querySelectorAll(".sp-preset-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const index = Number(btn.getAttribute("data-index") || -1);
      insertPresetPrompt(prompts[index] || "");
      hidePresetPopover();
    });
  });
  els.presetList.querySelectorAll(".sp-preset-remove").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const index = Number(btn.getAttribute("data-index") || -1);
      await presets.removePresetPrompt(index);
    });
  });
}

function renderHistoryList(): void {
  if (!els.historyList) {
    return;
  }
  if (els.historyClearBtn) {
    els.historyClearBtn.hidden = sidepanelState.savedConversations.length === 0;
  }
  if (!sidepanelState.savedConversations.length) {
    els.historyList.innerHTML = '<span class="sp-history-empty">还没有历史对话</span>';
    return;
  }

  const liveVideoRef = sidepanelState.liveContextData?.isVideoContext ? sidepanelState.liveContextData : null;
  const canHighlightLiveMatches = Boolean(
    liveVideoRef &&
    sidepanelState.currentConversationMeta?.pinnedContext &&
    sidepanelState.currentConversationMeta?.contextUrl &&
    !doesTabMatchContextUrl(liveVideoRef.url || sidepanelState.liveTabUrl, sidepanelState.currentConversationMeta.contextUrl || "")
  );

  els.historyList.innerHTML = sidepanelState.savedConversations
    .map((conversation) => {
      const isActive = conversation.id === sidepanelState.currentConversationId;
      const isLiveMatch = Boolean(
        !isActive &&
        canHighlightLiveMatches &&
        doesConversationMatchCurrentContext(conversation, liveVideoRef, sidepanelState.liveContextKey)
      );
      const metaText = formatConversationTimestamp(conversation.updatedAt || conversation.createdAt);
      const titleDisplay = buildConversationTitleDisplay(conversation.title, 30);
      return `
        <div class="sp-history-item ${isActive ? "is-active" : ""} ${isLiveMatch ? "is-live-match" : ""}" data-id="${escapeHtml(conversation.id)}">
          <button type="button" class="sp-history-open" data-id="${escapeHtml(conversation.id)}">
            <span class="sp-history-title" title="${escapeHtml(conversation.title)}">
              <span class="sp-history-title-main">${escapeHtml(titleDisplay.main)}</span>
              ${titleDisplay.suffix ? `<span class="sp-history-title-suffix">${escapeHtml(titleDisplay.suffix)}</span>` : ""}
            </span>
            <span class="sp-history-meta" title="${escapeHtml(metaText)}">${escapeHtml(metaText)}</span>
          </button>
          <button type="button" class="sp-history-remove" data-id="${escapeHtml(conversation.id)}" aria-label="删除历史对话">×</button>
        </div>
      `;
    })
    .join("");

  els.historyList.querySelectorAll(".sp-history-open").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = String(btn.getAttribute("data-id") || "");
      conversationStore.applyById(id);
      hideHistoryPopover();
    });
  });

  els.historyList.querySelectorAll(".sp-history-remove").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const id = String(btn.getAttribute("data-id") || "");
      await conversationStore.deleteById(id);
    });
  });
}

function insertPresetPrompt(prompt: string): void {
  const text = String(prompt || "").trim();
  if (!text) {
    return;
  }
  const current = els.input.value.trim();
  els.input.value = current ? `${current}\n${text}` : text;
  els.input.focus();
  autosizeInput();
}

function togglePresetPopover(event?: Event): void {
  event?.stopPropagation();
  hideHistoryPopover();
  const willShow = els.presetPopover.hidden;
  els.presetPopover.hidden = !willShow;
  if (willShow) {
    renderPresetPrompts();
    els.presetInput.value = "";
    els.presetInput.focus();
  }
}

function hidePresetPopover(): void {
  els.presetPopover.hidden = true;
}

function toggleHistoryPopover(event?: Event): void {
  event?.stopPropagation();
  hidePresetPopover();
  const willShow = els.historyPopover.hidden;
  els.historyPopover.hidden = !willShow;
  if (willShow) {
    renderHistoryList();
  }
}

function hideHistoryPopover(): void {
  els.historyPopover.hidden = true;
}

function handleDocumentClick(event: MouseEvent): void {
  if (els.presetPopover.hidden && els.historyPopover.hidden) {
    return;
  }
  if (!(event.target instanceof Element)) {
    hidePresetPopover();
    hideHistoryPopover();
    return;
  }
  if (event.target.closest("#spPresetPopover") || event.target.closest("#spPresetBtn")) {
    return;
  }
  if (event.target.closest("#spHistoryPopover") || event.target.closest("#spHistoryBtn")) {
    return;
  }
  hidePresetPopover();
  hideHistoryPopover();
}

function scheduleLiveContextSync(forceRefresh = false): void {
  liveContextSyncForceRefresh = liveContextSyncForceRefresh || forceRefresh;
  if (liveContextSyncTimer) {
    window.clearTimeout(liveContextSyncTimer);
  }
  liveContextSyncTimer = window.setTimeout(() => {
    const nextForceRefresh = liveContextSyncForceRefresh;
    liveContextSyncTimer = 0;
    liveContextSyncForceRefresh = false;
    void syncLiveContextState(nextForceRefresh);
  }, forceRefresh ? 120 : 220);
}

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
  renderSuggestions();
}

// 候选09：预设提示词 CRUD + 双存储同步（addPresetPrompt / removePresetPrompt /
// persistAiPresetPrompts）迁往 ./sidepanel-presets.ts，实例 presets 在文件头组装。

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
        renderSuggestions();
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
  hidePresetPopover();
  hideHistoryPopover();
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
  // 相等不同——见 sidepanel-context-policy.ts 两个谓词的疑义记录）。
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

function removeCenteredState(): void {
  els.messages.querySelectorAll(".sp-center-error").forEach((node) => node.remove());
}

// ============================================================
// 消息区提示 / 滚动（通知显示、自动滚动判定，纯 UI 杂项）
// ============================================================
function removeSuggestions(): void {
  suggestionsNode?.remove();
  suggestionsNode = null;
}

function showConversationContextError(message: string): void {
  if (!String(message || "").trim()) {
    return;
  }
  removeConversationContextNotice();
  removeCenteredState();
  const stateNode = document.createElement("div");
  stateNode.className = "sp-center-error";
  stateNode.textContent = String(message);
  els.messages.appendChild(stateNode);
  chatRuntime.scrollToBottom();
}

// 消息区通知条。第三参 options.openSettingsAction 为 true 时在文案末尾附
// 「前往设置」链接（打开方式与 .sp-center-error 里的设置链接一致：
// chrome.runtime.openOptionsPage）。文本走 textContent（不受文案内容影响），
// 链接为静态文案、单独 createElement 挂载。
function showConversationContextNotice(message: string, autoHideMs = 0, { openSettingsAction = false }: { openSettingsAction?: boolean } = {}): void {
  removeConversationContextNotice();
  const notice = document.createElement("div");
  notice.className = "sp-context-notice";
  notice.textContent = String(message || "").trim();
  if (openSettingsAction) {
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = "前往设置";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    notice.appendChild(document.createTextNode(" "));
    notice.appendChild(link);
  }
  els.messages.prepend(notice);
  if (autoHideMs > 0) {
    contextNoticeTimer = window.setTimeout(() => {
      removeConversationContextNotice();
    }, autoHideMs);
  }
}

function removeConversationContextNotice(): void {
  if (contextNoticeTimer) {
    window.clearTimeout(contextNoticeTimer);
    contextNoticeTimer = 0;
  }
  els.messages.querySelectorAll(".sp-context-notice").forEach((node) => node.remove());
}

function isMessagesNearBottom(threshold = 56): boolean {
  const { scrollTop, scrollHeight, clientHeight } = els.messages;
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}

// 获取当前活动标签页（transport 辅助，注入 store/timestamp-nav）
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}
