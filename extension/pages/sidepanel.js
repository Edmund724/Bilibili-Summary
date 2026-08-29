// sidepanel.js — UI 绑定 + 编排薄层（sidepanel-split ticket 08 收尾产物）。
//
// 02-07 已把各域实现抽走：helper 消重到 shared/notes/bilibili（02）、markdown
// 渲染到 ../ui/markdown.js（03）、时间戳跳转到 ../ui/timestamp-nav.js（04）、
// 对话持久化到 ./sidepanel-conversation-store.js（05）、笔记粘贴归一化到
// ../notes/paste.js（06）、chat 流状态机到 ./sidepanel-chat-runtime.js（07）。
//
// 本文件只剩四类东西：
//   1. init / bindEvents（启动编排、事件绑定）
//   2. 上下文 chip、各列表（历史/建议/预设）与消息区渲染
//   3. 滚动与布局更新、popover toggle、autosizeInput、modelSelect 宽度、通知显示
//   4. 对 02-07 模块的编排调用（loadContextState、player AI 快捷动作、上下文
//      同步调度、新对话/刷新等页面级流程）
// 页面级 transport 辅助（delay / waitForTabComplete / sendMessageToActiveTab）
// 由 ../shared/tab-utils.js 提供（08 新增共享模块，同时供
// ui/timestamp-nav.js 的 seek 流程复用）；truncate 由 ../shared/string-utils.js
// 提供；sendRuntimeMessage 由 ../core/runtime.js 提供（core 域）。

import {
  DEFAULT_INITIAL_QUICK_PROMPTS,
  DEFAULT_PRESET_PROMPTS,
  PLAYER_AI_QUICK_ACTION_STORAGE_KEY
} from "../core/defaults.js";
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
import { sendMessageToActiveTab, waitForTabComplete } from "../shared/tab-utils.js";
import { sendRuntimeMessage } from "../core/runtime.js";
import { renderMarkdown, stripThinkBlocks } from "../ui/markdown.js";
import { linkifyAssistantTimestamps } from "../ui/timestamp-nav.js";
import { normalizeMarkdownForSectionPaste } from "../notes/paste.js";
import { createChatRuntime } from "./sidepanel-chat-runtime.js";
import { createSubtitleWaiter, isContextPending } from "./sidepanel-subtitle-wait.js";
import {
  NO_SUBTITLE_SEND_BLOCKED,
  buildNoSubtitleNotice,
  isNoSubtitleEmptyContext
} from "./sidepanel-no-subtitle.js";
import { createConversationStore } from "./sidepanel-conversation-store.js";
import { ensureChatOffscreenDocument } from "./sidepanel-offscreen-ensure.js";

const SELECTED_PROVIDER_KEY = "boc_ai_selected_provider";
const THINKING_LEVEL_KEY = "boc_ai_thinking_level";
const CONVERSATIONS_STORAGE_KEY = "boc_ai_conversations_v1";
const NON_VIDEO_CONTEXT_MESSAGE = "当前页非 B 站视频页面，<br>无法获取当前页面信息作为对话上下文，<br>仅支持 AI 对话。";

const els = {
  header: document.querySelector(".sp-header"),
  contextChip: document.getElementById("spContextChip"),
  refreshBtn: document.getElementById("spRefreshBtn"),
  modelSelect: document.getElementById("spModelSelect"),
  thinkingToggle: document.querySelector(".sp-thinking-toggle"),
  thinkingBtns: document.querySelectorAll(".sp-thinking-btn"),
  settingsBtn: document.getElementById("spSettingsBtn"),
  newChatBtn: document.getElementById("spNewChatBtn"),
  presetBtn: document.getElementById("spPresetBtn"),
  historyBtn: document.getElementById("spHistoryBtn"),
  toolbar: document.querySelector(".sp-toolbar"),
  presetPopover: document.getElementById("spPresetPopover"),
  presetList: document.getElementById("spPresetList"),
  presetInput: document.getElementById("spPresetInput"),
  presetAddBtn: document.getElementById("spPresetAddBtn"),
  historyPopover: document.getElementById("spHistoryPopover"),
  historyList: document.getElementById("spHistoryList"),
  historyClearBtn: document.getElementById("spHistoryClearBtn"),
  messages: document.getElementById("spMessages"),
  input: document.getElementById("spInput"),
  stopBtn: document.getElementById("spStopBtn"),
};

const DEFAULT_AI_PREFS = {
  aiSystemPrompt: "",
  aiInitialQuickPrompts: DEFAULT_INITIAL_QUICK_PROMPTS.slice(),
  aiPresetPrompts: DEFAULT_PRESET_PROMPTS.slice()
};

// 抓取/音频转写进行中（content 的 subtitleFetchState 为 loading 且字幕体为空）
// 时等待其完成再放行发送流程，状态机本体在 ./sidepanel-subtitle-wait.js（可测）。
// 这里只组装 deps：轮询读当前上下文、提示走消息区 notice、定时器用 window。
// 引用的 loadContextState / 通知函数都是函数声明（有提升），回调执行时才读
// contextData，放在广播监听之前只为保证监听触发时组装已完成。
// asr-transcribing 广播活跃标志：content 侧转写进行中的兜底信号。快照的
// subtitleFetchState 可能在转写中因辅助抓取失败被 content 清掉（resetClipState），
// 此时靠这个标志继续等待，不放行空字幕。
let asrTranscribingActive = false;
const SUBTITLE_WAIT_POLL_MS = 4000;
const subtitleWaiter = createSubtitleWaiter({
  pollIntervalMs: SUBTITLE_WAIT_POLL_MS,
  pollContext: async () => {
    const ok = await loadContextState({ forceRefresh: false, silent: true }).catch(() => false);
    // loadContextState 无论走哪个分支都会先更新 liveContextData；等待期间
    // 可能有流式守卫冻结 contextData，读 liveContextData 保证数据不断供。
    const snapshot = ok ? (liveContextData || contextData) : null;
    return {
      ok: Boolean(snapshot),
      pending: isContextPending(snapshot, { asrTranscribingActive })
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
  if (message?.type !== "boc-subtitle-status") {
    return;
  }
  const notice = document.getElementById("spAsrNotice");
  if (notice) {
    notice.hidden = message.phase !== "asr-transcribing";
  }
  if (message.phase === "asr-transcribing") {
    asrTranscribingActive = true;
  } else if (message.phase === "asr-done" || message.phase === "asr-failed") {
    asrTranscribingActive = false;
    subtitleWaiter.kick();
  }
});

let contextData = null;
let currentContextKey = "";
let providers = [];
let chatHistory = [];
let suggestionsNode = null;
let aiPrefs = { ...DEFAULT_AI_PREFS };
let savedConversations = [];
let currentConversationId = "";
let currentConversationMeta = null;
let liveContextData = null;
let liveContextKey = "";
let liveTabUrl = "";
let contextNoticeTimer = 0;
let shouldAutoScrollMessages = true;
let aiThinkingLevel = "off";
let liveContextSyncTimer = 0;
let liveContextSyncForceRefresh = false;
let modelSelectMeasureCanvas = null;
let initCompleted = false;

const conversationStore = createConversationStore({
  getSavedConversations: () => savedConversations,
  setSavedConversations: (v) => { savedConversations = v; },
  getCurrentConversationId: () => currentConversationId,
  setCurrentConversationId: (v) => { currentConversationId = v; },
  getCurrentConversationMeta: () => currentConversationMeta,
  setCurrentConversationMeta: (v) => { currentConversationMeta = v; },
  getChatHistory: () => chatHistory,
  setChatHistory: (v) => { chatHistory = v; },
  getContextData: () => contextData,
  setContextData: (v) => { contextData = v; },
  getCurrentContextKey: () => currentContextKey,
  setCurrentContextKey: (v) => { currentContextKey = v; },
  getLiveContextData: () => liveContextData,
  getLiveContextKey: () => liveContextKey,
  renderHistoryList,
  renderInitialState,
  updateContextChip,
  showConversationContextNotice,
  showConversationContextError,
  removeConversationContextNotice,
  hideHistoryPopover,
  loadContextState,
  getActiveTab,
  sendRuntimeMessage,
  storage: chrome.storage.local,
  conversationsStorageKey: CONVERSATIONS_STORAGE_KEY,
  maxSavedConversations: MAX_SAVED_CONVERSATIONS
});

const chatRuntime = createChatRuntime({
  // ---- DOM 容器 / 元素引用（sidepanel 模块级 `els`）----
  messages: els.messages,
  input: els.input,
  stopBtn: els.stopBtn,
  // ---- conversation-store 窄接口（05 产出实例）----
  store: conversationStore,
  // ---- 会话状态访问器（sidepanel 模块级变量）----
  getChatHistory: () => chatHistory,
  getCurrentConversationMeta: () => currentConversationMeta,
  setCurrentConversationMeta: (v) => { currentConversationMeta = v; },
  getCurrentContextKey: () => currentContextKey,
  setCurrentConversationId: (v) => { currentConversationId = v; },
  getContextData: () => contextData,
  getAiPrefs: () => aiPrefs,
  getThinkingLevel: () => aiThinkingLevel,
  setThinkingLevel: (v) => { aiThinkingLevel = normalizeAiThinkingLevel(v); },
  // ---- 布局 / UI 回调（DOM 布局留在 sidepanel）----
  setStreamingUiState,
  showConversationContextNotice,
  removeConversationContextNotice,
  hidePresetPopover,
  hideHistoryPopover,
  removeCenteredState,
  removeSuggestions,
  resetConversationView,
  autosizeInput,
  shouldAutoScrollMessagesEnabled: () => shouldAutoScrollMessages,
  setShouldAutoScrollMessages: (v) => { shouldAutoScrollMessages = v; },
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

init().catch((err) => {
  resetConversationView(`初始化失败：${escapeHtml(err?.message || err)}`);
});

async function init() {
  // Chrome 114+：让 Side Panel 不随标签页关闭而销毁，切换网站时保持对话
  try {
    await chrome.sidePanel.setPanelBehavior({ panelBehavior: "separate" });
  } catch {}

  // 创建 Offscreen Document，把 SSE 流式请求移到隐藏页面，避免 Side Panel 被
  // 冻结。创建参数抽在 ensureChatOffscreenDocument（./sidepanel-offscreen-ensure.js），
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
  await consumePendingPlayerAiQuickAction();
}

function bindEvents() {
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      chatRuntime.sendMessage();
    }
  });
  els.input.addEventListener("input", autosizeInput);
  els.messages.addEventListener("scroll", () => {
    shouldAutoScrollMessages = isMessagesNearBottom();
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
  els.presetAddBtn.addEventListener("click", addPresetPrompt);
  els.presetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      addPresetPrompt();
    }
  });
  els.modelSelect.addEventListener("change", () => {
    const providerId = els.modelSelect.value;
    if (providerId) {
      localStorage.setItem(SELECTED_PROVIDER_KEY, providerId);
      aiPrefs.defaultModel = providerId;
      chrome.storage.sync.set({ defaultModel: providerId }).catch(() => {});
    } else {
      aiPrefs.defaultModel = "";
      chrome.storage.sync.set({ defaultModel: "" }).catch(() => {});
    }
    updateModelSelectWidth();
  });
  els.thinkingBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      void setThinkingLevel(btn.dataset.level || "off");
    });
  });
  window.addEventListener("resize", updateModelSelectWidth);
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scheduleLiveContextSync(true);
    }
  });
  window.addEventListener("focus", () => {
    scheduleLiveContextSync(true);
  });
  chrome.tabs.onActivated.addListener(() => {
    scheduleLiveContextSync(true);
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab?.active) {
      return;
    }
    if (!changeInfo.url && changeInfo.status !== "complete") {
      return;
    }
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
      void handlePlayerAiQuickActionRequest(changes[PLAYER_AI_QUICK_ACTION_STORAGE_KEY].newValue);
    }
  });
}

function autosizeInput() {
  els.input.style.height = "auto";
  const next = Math.min(els.input.scrollHeight, 320);
  const minHeight = document.body.classList.contains("sp-non-video-context") ? 72 : 94;
  els.input.style.height = `${Math.max(next, minHeight)}px`;
}

function setStreamingUiState(isStreaming, { stopping = false } = {}) {
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
async function loadProvidersAndPrefs({ preferredProviderId = "" } = {}) {
  const [providersResp, settingsResp] = await Promise.all([
    sendRuntimeMessage({ type: "ai-providers-list" }),
    sendRuntimeMessage({ type: "get-settings" }).catch(() => ({ ok: false }))
  ]);
  providers = Array.isArray(providersResp?.providers)
    ? providersResp.providers.filter((p) => p.enabled)
    : [];
  aiPrefs = {
    aiSystemPrompt: String(settingsResp?.settings?.aiSystemPrompt || "").trim(),
    aiInitialQuickPrompts: normalizeAiInitialQuickPrompts(settingsResp?.settings?.aiInitialQuickPrompts),
    aiPresetPrompts: normalizeAiPresetPrompts(settingsResp?.settings?.aiPresetPrompts),
    defaultModel: String(settingsResp?.settings?.defaultModel || "").trim()
  };
  aiThinkingLevel = normalizeAiThinkingLevel(
    settingsResp?.settings?.aiThinkingLevel ?? localStorage.getItem(THINKING_LEVEL_KEY)
  );
  if (!aiPrefs.aiPresetPrompts.length) {
    aiPrefs.aiPresetPrompts = DEFAULT_PRESET_PROMPTS.slice();
    void persistAiPresetPrompts();
  }
  renderModelSelect(preferredProviderId);
  renderThinkingLevel();
  renderPresetPrompts();
}

function renderModelSelect(preferredProviderId = "") {
  if (!providers.length) {
    els.modelSelect.innerHTML = '<option value="">未配置平台</option>';
    els.modelSelect.disabled = true;
    els.modelSelect.style.width = "96px";
    return;
  }

  els.modelSelect.innerHTML = providers
    .map((p) => {
      const label = String(p.model || p.name || "").trim();
      return `<option value="${escapeHtml(p.id)}">${escapeHtml(label)}</option>`;
    })
    .join("");

  const savedProviderId = String(preferredProviderId || aiPrefs.defaultModel || localStorage.getItem(SELECTED_PROVIDER_KEY) || "").trim();
  const matchedProvider = providers.find((item) => item.id === savedProviderId) || providers[0];
  els.modelSelect.value = matchedProvider?.id || "";
  els.modelSelect.disabled = false;
  updateModelSelectWidth();
}

// ============================================================
// 思考档位（off / low / high）— 三档分段按钮，选中态持久化到 sync 设置
// ============================================================
function renderThinkingLevel() {
  els.thinkingBtns.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.level === aiThinkingLevel);
    btn.setAttribute("aria-pressed", btn.dataset.level === aiThinkingLevel ? "true" : "false");
  });
}

async function setThinkingLevel(level) {
  aiThinkingLevel = normalizeAiThinkingLevel(level);
  renderThinkingLevel();
  localStorage.setItem(THINKING_LEVEL_KEY, aiThinkingLevel);
  await sendRuntimeMessage({ type: "save-settings", settings: { aiThinkingLevel } }).catch(() => null);
}

async function refreshProvidersAndPrefsAfterExternalChange() {
  const previousProviderId = String(els.modelSelect?.value || localStorage.getItem(SELECTED_PROVIDER_KEY) || "").trim();
  await loadProvidersAndPrefs({ preferredProviderId: previousProviderId });
  if (chatRuntime.isStreaming()) {
    return;
  }
  renderHistoryList();
  renderInitialState();
}

async function consumePendingPlayerAiQuickAction() {
  const data = await chrome.storage.local.get([PLAYER_AI_QUICK_ACTION_STORAGE_KEY]).catch(() => ({}));
  const request = normalizePlayerAiQuickActionRequest(data?.[PLAYER_AI_QUICK_ACTION_STORAGE_KEY]);
  if (!request) {
    return false;
  }
  return handlePlayerAiQuickActionRequest(request, { fromStorageChange: false });
}

function normalizePlayerAiQuickActionRequest(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const id = String(value.id || "").trim();
  const prompt = String(value.prompt || "").trim();
  const tabId = Number(value.tabId || 0) || 0;
  if (!id || !tabId) {
    return null;
  }
  return {
    id,
    prompt,
    tabId,
    createdAt: Number(value.createdAt) || Date.now()
  };
}

async function handlePlayerAiQuickActionRequest(value, { fromStorageChange = true } = {}) {
  const request = normalizePlayerAiQuickActionRequest(value);
  if (!request) {
    return false;
  }

  const activeTab = await getActiveTab().catch(() => null);
  if (activeTab?.id && request.tabId !== activeTab.id) {
    return false;
  }

  if (fromStorageChange) {
    await chrome.storage.local.remove(PLAYER_AI_QUICK_ACTION_STORAGE_KEY).catch(() => null);
  } else {
    const latest = await chrome.storage.local.get([PLAYER_AI_QUICK_ACTION_STORAGE_KEY]).catch(() => ({}));
    const latestId = String(latest?.[PLAYER_AI_QUICK_ACTION_STORAGE_KEY]?.id || "").trim();
    if (latestId && latestId !== request.id) {
      return false;
    }
    await chrome.storage.local.remove(PLAYER_AI_QUICK_ACTION_STORAGE_KEY).catch(() => null);
  }

  await runPlayerAiQuickActionPrompt(request.prompt);
  return true;
}

async function runPlayerAiQuickActionPrompt(prompt) {
  const text = String(prompt || "").trim();
  if (!text) {
    autosizeInput();
    els.input?.focus?.();
    return;
  }
  await startNewConversation();
  els.input.value = text;
  autosizeInput();
  await chatRuntime.sendMessage();
}

// ============================================================
// modelSelect 宽度（canvas 测量 + toolbar 布局计算，纯 UI 杂项）
// ============================================================
function updateModelSelectWidth() {
  if (!els.modelSelect) {
    return;
  }
  const selectedOption = els.modelSelect.options[els.modelSelect.selectedIndex];
  const text = String(selectedOption?.textContent || "").trim() || "未配置平台";
  const computedStyle = window.getComputedStyle(els.modelSelect);
  const measuredTextWidth = measureTextWidth(text, computedStyle);
  const extraCharsWidth = measureTextWidth("000", computedStyle);
  const desiredWidth = Math.ceil(measuredTextWidth + extraCharsWidth + 36);
  const minWidth = 92;
  const maxWidth = getModelSelectMaxWidth();
  const nextWidth = Math.max(minWidth, Math.min(desiredWidth, maxWidth));
  els.modelSelect.style.width = `${nextWidth}px`;
}

function measureTextWidth(text, style) {
  if (!modelSelectMeasureCanvas) {
    modelSelectMeasureCanvas = document.createElement("canvas");
  }
  const ctx = modelSelectMeasureCanvas.getContext("2d");
  if (!ctx) {
    return text.length * 8;
  }
  const fontStyle = style?.fontStyle || "normal";
  const fontVariant = style?.fontVariant || "normal";
  const fontWeight = style?.fontWeight || "400";
  const fontSize = style?.fontSize || "11px";
  const fontFamily = style?.fontFamily || "sans-serif";
  ctx.font = `${fontStyle} ${fontVariant} ${fontWeight} ${fontSize} ${fontFamily}`;
  return ctx.measureText(text).width;
}

function getModelSelectMaxWidth() {
  const toolbar = els.toolbar;
  if (!toolbar || !els.thinkingToggle || !els.presetBtn) {
    return 232;
  }
  const style = window.getComputedStyle(toolbar);
  const gap = Number.parseFloat(style.columnGap || style.gap || "0") || 0;
  const paddingLeft = Number.parseFloat(style.paddingLeft || "0") || 0;
  const paddingRight = Number.parseFloat(style.paddingRight || "0") || 0;
  const contentWidth = toolbar.clientWidth - paddingLeft - paddingRight;
  const siblingWidth =
    els.thinkingToggle.offsetWidth + els.presetBtn.offsetWidth + gap * 2;
  return Math.max(92, Math.floor(contentWidth - siblingWidth));
}

// ============================================================
// 上下文状态加载（侧面板编排核心：读标签页状态 → 应用上下文 → 恢复对话）
// ============================================================
async function loadContextState({ forceRefresh = false, silent = false } = {}) {
  const hasPinnedConversation = currentConversationMeta?.pinnedContext === true;
  const tab = await getActiveTab();
  if (!tab?.id) {
    liveContextData = null;
    liveContextKey = "";
    liveTabUrl = "";
    if (!hasPinnedConversation) {
      contextData = null;
      currentContextKey = "";
    }
    updateContextChip();
    if (!silent && !hasPinnedConversation) {
      resetConversationView("找不到当前标签页。");
    }
    return false;
  }

  const resp = await sendRuntimeMessage({
    type: "ai-sidepanel-get-state",
    tabId: tab.id,
    forceRefresh
  }).catch((error) => ({ ok: false, error: error.message }));
  liveTabUrl = String(tab.url || "").trim();

  if (!resp?.ok || !resp.payload) {
    liveContextData = null;
    liveContextKey = "";
    if (!hasPinnedConversation) {
      contextData = null;
      currentContextKey = "";
    }
    updateContextChip();
    if (!silent && !hasPinnedConversation) {
      resetConversationView(resp?.error || "当前页面上下文读取失败。");
    }
    return false;
  }

  liveContextData = resp.payload;
  liveContextKey = buildContextKey(resp.payload);
  if (hasPinnedConversation) {
    renderHistoryList();
    updateContextChip();
    return true;
  }

  if (chatRuntime.isStreaming() || chatRuntime.hasPendingUserPrompt()) {
    renderHistoryList();
    updateContextChip();
    return true;
  }

  const contextChanged = applyContextPayload(resp.payload);
  renderHistoryList();
  if (contextChanged) {
    await conversationStore.restoreLatest();
    renderInitialState();
  }
  return true;
}

function applyContextPayload(payload) {
  const nextContext = payload && typeof payload === "object" ? payload : null;
  const nextKey = buildContextKey(nextContext);
  const contextChanged = Boolean(currentContextKey && nextKey && nextKey !== currentContextKey);

  contextData = nextContext;
  currentContextKey = nextKey;
  updateContextChip();

  if (contextChanged && !chatRuntime.isStreaming() && !chatRuntime.hasPendingUserPrompt()) {
    restartChat({ keepContext: true });
  } else {
    renderSuggestions();
  }
  return contextChanged;
}

function updateContextChip() {
  if (!contextData) {
    els.contextChip.textContent = "无上下文";
    els.contextChip.title = "";
    els.contextChip.disabled = true;
    els.contextChip.classList.remove("is-mismatch");
    return;
  }

  const shortTitle = contextData.title ? truncate(contextData.title, 19) : "未知视频";
  els.contextChip.textContent = shortTitle;
  const mismatch = isBoundConversationMismatched();
  els.contextChip.classList.toggle("is-mismatch", mismatch);
  els.contextChip.title = contextData.url
    ? `${contextData.title || ""}${mismatch ? "\n当前页不是这个对话绑定的视频" : ""}\n点击跳转目标视频，或开启新对话`
    : contextData.title || "";
  els.contextChip.disabled = !String(contextData.url || "").trim();
}

function isBoundConversationMismatched() {
  if (currentConversationMeta?.pinnedContext !== true) {
    return false;
  }
  const targetUrl = String(currentConversationMeta?.contextUrl || contextData?.url || "").trim();
  if (!targetUrl) {
    return false;
  }
  if (!liveTabUrl) {
    return true;
  }
  return !doesTabMatchContextUrl(liveTabUrl, targetUrl);
}

async function openCurrentContextUrl() {
  const targetUrl = String(contextData?.url || currentConversationMeta?.contextUrl || "").trim();
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

function renderInitialState() {
  updateSidepanelLayoutState();
  if (!contextData) {
    resetConversationView("当前页面不是 B 站视频页，无法读取视频信息。");
    return;
  }
  if (!providers.length) {
    resetConversationView('还没有配置 AI 平台，<a href="#" id="spOpenSettings">前往设置</a>');
    document.getElementById("spOpenSettings")?.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    return;
  }
  if (chatHistory.length) {
    renderConversationMessages();
    return;
  }
  if (contextData.isVideoContext === false) {
    resetConversationView(NON_VIDEO_CONTEXT_MESSAGE);
    return;
  }
  resetConversationView("");
}

function resetConversationView(stateHtml = "") {
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
  shouldAutoScrollMessages = true;
  scrollToBottom(true);
}

function renderSuggestions() {
  if (!suggestionsNode) {
    return;
  }
  if (!contextData || !providers.length || chatHistory.length || contextData.isVideoContext === false) {
    suggestionsNode.innerHTML = "";
    return;
  }
  const prompts = normalizeAiInitialQuickPrompts(aiPrefs.aiInitialQuickPrompts).filter(Boolean);
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

function renderPresetPrompts() {
  if (!els.presetList) {
    return;
  }
  const prompts = Array.isArray(aiPrefs.aiPresetPrompts) ? aiPrefs.aiPresetPrompts : [];
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
      await removePresetPrompt(index);
    });
  });
}

function renderHistoryList() {
  if (!els.historyList) {
    return;
  }
  if (els.historyClearBtn) {
    els.historyClearBtn.hidden = savedConversations.length === 0;
  }
  if (!savedConversations.length) {
    els.historyList.innerHTML = '<span class="sp-history-empty">还没有历史对话</span>';
    return;
  }

  const liveVideoRef = liveContextData?.isVideoContext ? liveContextData : null;
  const canHighlightLiveMatches = Boolean(
    liveVideoRef &&
    currentConversationMeta?.pinnedContext &&
    currentConversationMeta?.contextUrl &&
    !doesTabMatchContextUrl(liveVideoRef.url || liveTabUrl, currentConversationMeta.contextUrl || "")
  );

  els.historyList.innerHTML = savedConversations
    .map((conversation) => {
      const isActive = conversation.id === currentConversationId;
      const isLiveMatch = Boolean(
        !isActive &&
        canHighlightLiveMatches &&
        doesConversationMatchCurrentContext(conversation, liveVideoRef, liveContextKey)
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

function insertPresetPrompt(prompt) {
  const text = String(prompt || "").trim();
  if (!text) {
    return;
  }
  const current = els.input.value.trim();
  els.input.value = current ? `${current}\n${text}` : text;
  els.input.focus();
  autosizeInput();
}

function togglePresetPopover(event) {
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

function hidePresetPopover() {
  els.presetPopover.hidden = true;
}

function toggleHistoryPopover(event) {
  event?.stopPropagation();
  hidePresetPopover();
  const willShow = els.historyPopover.hidden;
  els.historyPopover.hidden = !willShow;
  if (willShow) {
    renderHistoryList();
  }
}

function hideHistoryPopover() {
  els.historyPopover.hidden = true;
}

function handleDocumentClick(event) {
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

function scheduleLiveContextSync(forceRefresh = false) {
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

async function syncLiveContextState(forceRefresh = false) {
  const ok = await loadContextState({ forceRefresh, silent: true }).catch(() => false);
  if (currentConversationMeta?.pinnedContext || chatRuntime.isStreaming() || chatRuntime.hasPendingUserPrompt()) {
    updateContextChip();
    return;
  }
  if (!ok || !contextData || !providers.length || !chatHistory.length) {
    renderInitialState();
    return;
  }
  renderSuggestions();
}

async function addPresetPrompt() {
  const text = String(els.presetInput.value || "").trim();
  if (!text) {
    return;
  }
  const nextPrompts = [...(aiPrefs.aiPresetPrompts || [])];
  if (!nextPrompts.includes(text)) {
    nextPrompts.push(text);
  }
  aiPrefs.aiPresetPrompts = nextPrompts.slice(0, 12);
  await persistAiPresetPrompts();
  els.presetInput.value = "";
  renderPresetPrompts();
}

async function removePresetPrompt(index) {
  if (index < 0) {
    return;
  }
  aiPrefs.aiPresetPrompts = (aiPrefs.aiPresetPrompts || []).filter((_, itemIndex) => itemIndex !== index);
  await persistAiPresetPrompts();
  renderPresetPrompts();
}

async function persistAiPresetPrompts() {
  const settingsResp = await sendRuntimeMessage({ type: "get-settings" }).catch(() => ({ ok: false }));
  if (!settingsResp?.ok || !settingsResp.settings) {
    return;
  }
  const nextSettings = {
    ...settingsResp.settings,
    aiPresetPrompts: (aiPrefs.aiPresetPrompts || []).slice(0, 12)
  };
  await sendRuntimeMessage({ type: "save-settings", settings: nextSettings }).catch(() => null);
}

function updateSidepanelLayoutState() {
  const useCompactInput = Boolean(
    contextData &&
    contextData.isVideoContext === false &&
    !chatHistory.length &&
    !currentConversationMeta?.pinnedContext
  );
  document.body.classList.toggle("sp-non-video-context", useCompactInput);
  if (els.input) {
    autosizeInput();
  }
}

async function refreshContextManually() {
  if (els.refreshBtn.disabled) {
    return;
  }
  setRefreshing(true);
  try {
    const ok = await loadContextState({ forceRefresh: true });
    if (ok) {
      if (!contextData || !providers.length || !chatHistory.length) {
        renderInitialState();
      } else {
        renderSuggestions();
      }
    }
  } finally {
    setRefreshing(false);
  }
}

function setRefreshing(isRefreshing) {
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

async function startNewConversation() {
  hidePresetPopover();
  hideHistoryPopover();
  setRefreshing(true);
  try {
    await loadContextState({ forceRefresh: true, silent: true });
  } finally {
    setRefreshing(false);
  }
  if (liveContextData) {
    contextData = { ...liveContextData };
    currentContextKey = liveContextKey || buildContextKey(liveContextData);
    updateContextChip();
  }
  restartChat({ keepContext: true });
  renderInitialState();
}

// ============================================================
// 消息区渲染（历史对话回放 → chat-runtime 渲染）
// ============================================================
function renderConversationMessages() {
  updateSidepanelLayoutState();
  els.messages.innerHTML = "";
  suggestionsNode = null;
  if (!chatHistory.length) {
    resetConversationView("");
    return;
  }
  chatHistory.forEach((message, index) => {
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
  shouldAutoScrollMessages = true;
  scrollToBottom(true);
}

// 历史回放时找该助手消息的前一条用户消息（注入 renderAssistantMessage 的 userPrompt）
function findPreviousUserPrompt(index) {
  for (let i = Number(index) - 1; i >= 0; i -= 1) {
    const item = chatHistory[i];
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
async function ensureCurrentContextForSend() {
  if (currentConversationMeta?.pinnedContext) {
    await loadContextState({ forceRefresh: false, silent: true }).catch(() => null);
    return conversationStore.hydratePinned();
  }
  const ok = await loadContextState({ forceRefresh: false, silent: true });
  if (!ok || !contextData) {
    resetConversationView("当前页面上下文读取失败。");
    return false;
  }
  const ready = await subtitleWaiter.wait();
  if (!ready) {
    resetConversationView("当前页面上下文读取失败。");
    return false;
  }
  // 等待期间 contextData 可能停在旧快照（守卫分支或就绪瞬间），放行前重取
  // 一次，确保发送出去的是转写完成后的完整字幕。
  await loadContextState({ forceRefresh: false, silent: true }).catch(() => null);
  if (!contextData) {
    resetConversationView("当前页面上下文读取失败。");
    return false;
  }
  if (isNoSubtitleEmptyContext(contextData)) {
    const notice = buildNoSubtitleNotice(contextData.noSubtitleReason);
    showConversationContextNotice(notice.message, 0, { openSettingsAction: notice.openSettings });
    return NO_SUBTITLE_SEND_BLOCKED;
  }
  return true;
}

// 时间戳跳转依赖包（注入 timestamp-nav，seek 复用 shared 的 sendMessageToActiveTab）
function getTimestampNavDeps() {
  return {
    contextUrl: String(contextData?.url || currentConversationMeta?.contextUrl || "").trim(),
    notice: showConversationContextNotice,
    getActiveTab,
    matchContextUrl: doesTabMatchContextUrl,
    sendMessageToActiveTab
  };
}

// 重启对话：清流状态 + 清会话状态 + 重置消息区（编排入口，被新对话/上下文切换复用）
function restartChat({ keepContext = false } = {}) {
  chatRuntime.resetStreamState();
  chatHistory = [];
  currentConversationId = "";
  currentConversationMeta = null;
  if (!keepContext) {
    currentContextKey = buildContextKey(contextData);
  }
  updateContextChip();
  resetConversationView("");
  setStreamingUiState(false);
  els.input.value = "";
  autosizeInput();
}

function removeCenteredState() {
  els.messages.querySelectorAll(".sp-center-error").forEach((node) => node.remove());
}

// ============================================================
// 消息区提示 / 滚动（通知显示、自动滚动判定，纯 UI 杂项）
// ============================================================
function removeSuggestions() {
  suggestionsNode?.remove();
  suggestionsNode = null;
}

function showConversationContextError(message) {
  if (!String(message || "").trim()) {
    return;
  }
  removeConversationContextNotice();
  removeCenteredState();
  const stateNode = document.createElement("div");
  stateNode.className = "sp-center-error";
  stateNode.textContent = String(message);
  els.messages.appendChild(stateNode);
  scrollToBottom();
}

// 消息区通知条。第三参 options.openSettingsAction 为 true 时在文案末尾附
// 「前往设置」链接（打开方式与 .sp-center-error 里的设置链接一致：
// chrome.runtime.openOptionsPage）。文本走 textContent（不受文案内容影响），
// 链接为静态文案、单独 createElement 挂载。
function showConversationContextNotice(message, autoHideMs = 0, { openSettingsAction = false } = {}) {
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

function removeConversationContextNotice() {
  if (contextNoticeTimer) {
    window.clearTimeout(contextNoticeTimer);
    contextNoticeTimer = 0;
  }
  els.messages.querySelectorAll(".sp-context-notice").forEach((node) => node.remove());
}

function isMessagesNearBottom(threshold = 56) {
  const { scrollTop, scrollHeight, clientHeight } = els.messages;
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}

function scrollToBottom(force = false) {
  if (!force && !shouldAutoScrollMessages) {
    return;
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

// 获取当前活动标签页（transport 辅助，注入 store/timestamp-nav）
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}
