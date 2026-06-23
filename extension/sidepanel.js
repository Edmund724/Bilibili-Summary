import { buildSuggestedPrompts } from "./ai/context.js";

const SELECTED_PROVIDER_KEY = "boc_ai_selected_provider";
const CONVERSATIONS_STORAGE_KEY = "boc_ai_conversations_v1";
const PLAYER_AI_QUICK_ACTION_STORAGE_KEY = "boc_player_ai_quick_action_v1";
const MAX_SAVED_CONVERSATIONS = 60;
const NON_VIDEO_CONTEXT_MESSAGE = "当前页非 B 站视频页面，<br>无法获取当前页面信息作为对话上下文，<br>仅支持 AI 对话。";
const DEFAULT_PRESET_PROMPTS = [
  "生成视频摘要和结论",
  "按章节整理视频内容",
  "生成带时间轴的笔记"
];
const DEFAULT_PLAYER_AI_QUICK_PROMPT = "整理这期视频的内容，输出结构化总结：主题、核心观点、关键细节、结论与可执行启发。";
const STREAM_SLOW_NOTICE_MS = 15000;

const els = {
  header: document.querySelector(".sp-header"),
  contextChip: document.getElementById("spContextChip"),
  refreshBtn: document.getElementById("spRefreshBtn"),
  modelSelect: document.getElementById("spModelSelect"),
  settingsBtn: document.getElementById("spSettingsBtn"),
  newChatBtn: document.getElementById("spNewChatBtn"),
  presetBtn: document.getElementById("spPresetBtn"),
  historyBtn: document.getElementById("spHistoryBtn"),
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
  aiPresetPrompts: DEFAULT_PRESET_PROMPTS.slice()
};

let contextData = null;
let currentContextKey = "";
let providers = [];
let activePort = null;
let activeAssistantNode = null;
let activeUserPrompt = "";
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
let liveContextSyncTimer = 0;
let liveContextSyncForceRefresh = false;
let modelSelectMeasureCanvas = null;
let streamSlowNoticeTimer = 0;
let streamFirstTokenReceived = false;
let initCompleted = false;

init().catch((err) => {
  resetConversationView(`初始化失败：${escapeHtml(err?.message || err)}`);
});

async function init() {
  bindEvents();
  await loadProvidersAndPrefs();
  await loadSavedConversations();
  await loadContextState();
  await restoreLatestConversationForCurrentContext();
  renderInitialState();
  autosizeInput();
  initCompleted = true;
  await consumePendingPlayerAiQuickAction();
}

function bindEvents() {
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
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
    void clearAllConversations();
  });
  els.stopBtn?.addEventListener("click", () => {
    stopActiveStream();
  });
  els.presetAddBtn.addEventListener("click", addPresetPrompt);
  els.presetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      addPresetPrompt();
    }
  });
  els.modelSelect.addEventListener("change", () => {
    if (els.modelSelect.value) {
      localStorage.setItem(SELECTED_PROVIDER_KEY, els.modelSelect.value);
    }
    updateModelSelectWidth();
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
      (areaName === "sync" && (changes.aiProviders || changes.aiSystemPrompt || changes.aiPresetPrompts)) ||
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
    aiPresetPrompts: Array.isArray(settingsResp?.settings?.aiPresetPrompts)
      ? settingsResp.settings.aiPresetPrompts.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12)
      : []
  };
  if (!aiPrefs.aiPresetPrompts.length) {
    aiPrefs.aiPresetPrompts = DEFAULT_PRESET_PROMPTS.slice();
    void persistAiPresetPrompts();
  }
  renderModelSelect(preferredProviderId);
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

  const savedProviderId = String(preferredProviderId || localStorage.getItem(SELECTED_PROVIDER_KEY) || "").trim();
  const matchedProvider = providers.find((item) => item.id === savedProviderId) || providers[0];
  els.modelSelect.value = matchedProvider?.id || "";
  els.modelSelect.disabled = false;
  updateModelSelectWidth();
}

async function refreshProvidersAndPrefsAfterExternalChange() {
  const previousProviderId = String(els.modelSelect?.value || localStorage.getItem(SELECTED_PROVIDER_KEY) || "").trim();
  await loadProvidersAndPrefs({ preferredProviderId: previousProviderId });
  if (activePort) {
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
  await sendMessage();
}

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
  const header = els.header;
  if (!header || !els.contextChip || !els.refreshBtn || !els.settingsBtn) {
    return 172;
  }
  const style = window.getComputedStyle(header);
  const gap = Number.parseFloat(style.columnGap || style.gap || "0") || 0;
  const paddingLeft = Number.parseFloat(style.paddingLeft || "0") || 0;
  const paddingRight = Number.parseFloat(style.paddingRight || "0") || 0;
  const contentWidth = header.clientWidth - paddingLeft - paddingRight;
  const siblingWidth =
    els.contextChip.offsetWidth +
    els.refreshBtn.offsetWidth +
    els.settingsBtn.offsetWidth +
    gap * 3;
  return Math.max(92, Math.floor(contentWidth - siblingWidth));
}

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

  const contextChanged = applyContextPayload(resp.payload);
  renderHistoryList();
  if (contextChanged) {
    await restoreLatestConversationForCurrentContext();
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

  if (contextChanged) {
    restartChat({ keepContext: true });
  } else {
    renderSuggestions();
  }
  return contextChanged;
}

function buildContextKey(payload) {
  if (!payload) {
    return "";
  }
  const bvid = String(payload.bvid || "").trim();
  const cid = String(payload.cid || "").trim();
  const aid = String(payload.aid || "").trim();
  if (bvid || cid || aid) {
    return `video:${bvid}|${cid || aid}`;
  }
  const normalizedUrl = normalizeContextUrlForKey(payload.url);
  return normalizedUrl ? `url:${normalizedUrl}` : "";
}

function normalizeContextUrlForKey(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  try {
    const parsed = new URL(text);
    parsed.hash = "";
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return text;
  }
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
  const prompts = buildSuggestedPrompts(contextData);
  suggestionsNode.innerHTML = prompts
    .map((prompt) => `<button type="button" class="sp-chip">${escapeHtml(prompt)}</button>`)
    .join("");
  suggestionsNode.querySelectorAll(".sp-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.input.value = btn.textContent || "";
      autosizeInput();
      sendMessage();
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
      loadConversationById(id);
      hideHistoryPopover();
    });
  });

  els.historyList.querySelectorAll(".sp-history-remove").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const id = String(btn.getAttribute("data-id") || "");
      await deleteConversation(id);
    });
  });
}

async function loadSavedConversations() {
  const data = await chrome.storage.local.get([CONVERSATIONS_STORAGE_KEY]).catch(() => ({}));
  savedConversations = normalizeConversations(data?.[CONVERSATIONS_STORAGE_KEY]);
  renderHistoryList();
  void hydrateConversationPageMetadata();
}

function normalizeConversations(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const messages = Array.isArray(item?.messages)
        ? item.messages
            .filter((msg) => msg && (msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string")
            .map((msg) => ({ role: msg.role, content: String(msg.content) }))
        : [];
      const id = String(item?.id || "").trim();
      if (!id || !messages.length) {
        return null;
      }
      const contextTitle = String(item?.contextTitle || "").trim();
      const contextRef = normalizeConversationContextRef(item?.contextRef || item?.contextSnapshot || item);
      const contextUrl = String(item?.contextUrl || "").trim();
      return {
        id,
        title: normalizeConversationTitle(item?.title, contextTitle, contextRef, contextUrl),
        contextKey: resolveConversationStorageKey(item?.contextKey, contextRef, contextUrl),
        contextTitle,
        contextUrl,
        isVideoContext: item?.isVideoContext !== false,
        createdAt: Number(item?.createdAt) || Date.now(),
        updatedAt: Number(item?.updatedAt) || Date.now(),
        contextRef,
        messages
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_SAVED_CONVERSATIONS);
}

function resolveConversationStorageKey(rawKey, contextRef, contextUrl = "") {
  const normalizedRefKey = buildContextKey(contextRef);
  if (normalizedRefKey) {
    return normalizedRefKey;
  }
  const normalizedUrlKey = buildContextKey({ url: contextUrl });
  if (normalizedUrlKey) {
    return normalizedUrlKey;
  }
  return String(rawKey || "").trim();
}

async function hydrateConversationPageMetadata() {
  const candidates = savedConversations
    .filter((item) => needsConversationPageHydration(item))
    .slice(0, 12);
  if (!candidates.length) {
    return;
  }

  let changed = false;
  for (const conversation of candidates) {
    const contextRef = conversation.contextRef || null;
    if (!contextRef?.bvid || !contextRef?.cid) {
      continue;
    }
    const response = await sendRuntimeMessage({
      type: "ai-sidepanel-resolve-page-ref",
      contextRef
    }).catch(() => null);
    if (!response?.ok || !response.payload) {
      continue;
    }

    const payload = response.payload;
    const nextPageIndex = Number(payload.pageIndex) > 0 ? Number(payload.pageIndex) : 1;
    const nextUrl = String(payload.url || conversation.contextUrl || contextRef.url || "").trim();
    const nextContextRef = {
      ...contextRef,
      url: nextUrl,
      cid: String(payload.cid || contextRef.cid || "").trim(),
      pageIndex: nextPageIndex,
      pageTitle: String(payload.pageTitle || contextRef.pageTitle || "").trim()
    };
    const nextTitle = normalizeConversationTitle(conversation.title, conversation.contextTitle, nextContextRef, nextUrl);
    const nextContextKey = resolveConversationStorageKey(conversation.contextKey, nextContextRef, nextUrl);
    if (
      nextTitle === conversation.title &&
      nextUrl === conversation.contextUrl &&
      nextContextKey === conversation.contextKey &&
      Number(conversation.contextRef?.pageIndex || 1) === nextPageIndex
    ) {
      continue;
    }

    conversation.title = nextTitle;
    conversation.contextUrl = nextUrl;
    conversation.contextKey = nextContextKey;
    conversation.contextRef = nextContextRef;
    changed = true;
  }

  if (!changed) {
    return;
  }

  if (currentConversationId) {
    const activeConversation = savedConversations.find((item) => item.id === currentConversationId);
    if (activeConversation) {
      currentConversationMeta = {
        ...currentConversationMeta,
        title: activeConversation.title,
        contextKey: activeConversation.contextKey,
        contextUrl: activeConversation.contextUrl,
        contextRef: activeConversation.contextRef
      };
    }
  }
  renderHistoryList();
  updateContextChip();
  await saveConversations();
}

function needsConversationPageHydration(conversation) {
  if (!conversation?.isVideoContext) {
    return false;
  }
  if (/-P\d+$/i.test(String(conversation.title || "").trim())) {
    return false;
  }
  const pageIndex = Number(conversation.contextRef?.pageIndex || 0) || 0;
  if (pageIndex > 1) {
    return true;
  }
  const urlPageIndex = extractPageIndexFromContextUrl(conversation.contextUrl || conversation.contextRef?.url || "");
  if (urlPageIndex > 1) {
    return true;
  }
  return Boolean(conversation.contextRef?.bvid && conversation.contextRef?.cid);
}

async function saveConversations() {
  savedConversations = normalizeConversations(savedConversations);
  await chrome.storage.local.set({
    [CONVERSATIONS_STORAGE_KEY]: savedConversations.slice(0, MAX_SAVED_CONVERSATIONS)
  });
  renderHistoryList();
}

async function restoreLatestConversationForCurrentContext() {
  const targetContextKey = liveContextKey || currentContextKey;
  const currentRef = liveContextData || contextData;
  const latest = savedConversations.find((item) => doesConversationMatchCurrentContext(item, currentRef, targetContextKey));
  if (!latest) {
    currentConversationId = "";
    currentConversationMeta = null;
    chatHistory = [];
    return false;
  }
  applyConversation(latest);
  return true;
}

function doesConversationMatchCurrentContext(conversation, currentRef, targetContextKey = "") {
  if (!conversation) {
    return false;
  }
  const normalizedConversationKey = resolveConversationStorageKey(
    conversation.contextKey,
    conversation.contextRef,
    conversation.contextUrl
  );
  const normalizedTargetKey = String(targetContextKey || buildContextKey(currentRef)).trim();
  if (normalizedConversationKey && normalizedTargetKey && normalizedConversationKey === normalizedTargetKey) {
    return true;
  }

  const conversationUrl = String(conversation.contextUrl || conversation.contextRef?.url || "").trim();
  const currentUrl = String(currentRef?.url || "").trim();
  if (conversationUrl && currentUrl) {
    return doesTabMatchContextUrl(currentUrl, conversationUrl);
  }
  return false;
}

function applyConversation(conversation) {
  if (!conversation) {
    return;
  }
  currentConversationId = conversation.id;
  currentConversationMeta = {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    contextKey: conversation.contextKey,
    contextTitle: conversation.contextTitle,
    contextUrl: conversation.contextUrl,
    isVideoContext: conversation.isVideoContext !== false,
    pinnedContext: true,
    contextRef: conversation.contextRef || null,
    resolvedContext: null
  };
  chatHistory = Array.isArray(conversation.messages)
    ? conversation.messages.map((item) => ({ role: item.role, content: String(item.content || "") }))
    : [];
  if (liveContextData && conversation.contextKey && conversation.contextKey === liveContextKey) {
    contextData = { ...liveContextData };
    currentContextKey = liveContextKey;
    currentConversationMeta.resolvedContext = { ...liveContextData };
  } else if (conversation.contextRef) {
    contextData = buildContextPlaceholder(conversation.contextRef);
    currentContextKey = conversation.contextKey || buildContextKey(contextData);
  }
  updateContextChip();
  renderHistoryList();
}

function loadConversationById(id) {
  const conversation = savedConversations.find((item) => item.id === id);
  if (!conversation) {
    return;
  }
  applyConversation(conversation);
  renderInitialState();
  if (conversation.contextKey && conversation.contextKey !== liveContextKey) {
    showConversationContextNotice("正在加载原视频上下文...");
    void hydratePinnedConversationContext({ silent: true });
  }
}

async function deleteConversation(id) {
  const wasCurrent = id && id === currentConversationId;
  savedConversations = savedConversations.filter((item) => item.id !== id);
  await saveConversations();
  if (!wasCurrent) {
    return;
  }
  currentConversationId = "";
  currentConversationMeta = null;
  chatHistory = [];
  if (liveContextData) {
    contextData = { ...liveContextData };
    currentContextKey = liveContextKey || buildContextKey(liveContextData);
    updateContextChip();
  }
  renderInitialState();
}

async function clearAllConversations() {
  if (!savedConversations.length) {
    return;
  }
  if (!confirm("确定要清空全部历史对话吗？")) {
    return;
  }
  savedConversations = [];
  currentConversationId = "";
  currentConversationMeta = null;
  chatHistory = [];
  await saveConversations();
  hideHistoryPopover();
  if (liveContextData) {
    contextData = { ...liveContextData };
    currentContextKey = liveContextKey || buildContextKey(liveContextData);
    updateContextChip();
  }
  renderInitialState();
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
  if (currentConversationMeta?.pinnedContext || activePort || activeUserPrompt) {
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

function renderConversationMessages() {
  updateSidepanelLayoutState();
  els.messages.innerHTML = "";
  suggestionsNode = null;
  if (!chatHistory.length) {
    resetConversationView("");
    return;
  }
  chatHistory.forEach((message) => {
    if (message.role === "user") {
      appendUserMessage(message.content, false);
      return;
    }
    const node = document.createElement("div");
    node.className = "sp-msg sp-msg-assistant";
    node.dataset.raw = String(message.content || "");
    renderAssistantMessage(node, String(message.content || ""));
    els.messages.appendChild(node);
  });
  shouldAutoScrollMessages = true;
  scrollToBottom(true);
}

function buildConversationTitle(context) {
  const rawTitle = String(context?.title || "当前页面").trim() || "当前页面";
  const baseTitle = extractConversationBaseTitle(rawTitle);
  return appendConversationPageSuffix(baseTitle, context);
}

function buildConversationContextRef(context) {
  if (!context || typeof context !== "object") {
    return null;
  }
  return {
    title: String(context.title || "").trim(),
    url: String(context.url || "").trim(),
    author: String(context.author || "").trim(),
    uploadDate: String(context.uploadDate || "").trim(),
    bvid: String(context.bvid || "").trim(),
    cid: String(context.cid || "").trim(),
    aid: String(context.aid || "").trim(),
    pageIndex: Number(context.pageIndex) > 0 ? Number(context.pageIndex) : 1,
    pageCount: Number(context.pageCount) > 0 ? Number(context.pageCount) : 0,
    pageTitle: String(context.pageTitle || "").trim(),
    subtitleLang: String(context.subtitleLang || "").trim(),
    selectedSubtitleId: String(context.selectedSubtitleId || "").trim(),
    selectedSubtitleUrl: String(context.selectedSubtitleUrl || "").trim(),
    isVideoContext: context.isVideoContext !== false
  };
}

function normalizeConversationContextRef(ref) {
  return buildConversationContextRef(ref);
}

function buildContextPlaceholder(ref) {
  if (!ref || typeof ref !== "object") {
    return null;
  }
  return {
    title: String(ref.title || "").trim(),
    url: String(ref.url || "").trim(),
    author: String(ref.author || "").trim(),
    uploadDate: String(ref.uploadDate || "").trim(),
    bvid: String(ref.bvid || "").trim(),
    cid: String(ref.cid || "").trim(),
    aid: String(ref.aid || "").trim(),
    pageIndex: Number(ref.pageIndex) > 0 ? Number(ref.pageIndex) : 1,
    pageCount: Number(ref.pageCount) > 0 ? Number(ref.pageCount) : 0,
    pageTitle: String(ref.pageTitle || "").trim(),
    subtitleLang: String(ref.subtitleLang || "").trim(),
    selectedSubtitleId: String(ref.selectedSubtitleId || "").trim(),
    selectedSubtitleUrl: String(ref.selectedSubtitleUrl || "").trim(),
    subtitleMarkdown: "",
    hotComments: [],
    isVideoContext: ref.isVideoContext !== false
  };
}

function normalizeConversationTitle(title, contextTitle = "", contextRef = null, contextUrl = "") {
  const preferredTitle = String(contextTitle || "").trim() || String(title || "").trim();
  const baseTitle = extractConversationBaseTitle(preferredTitle);
  return appendConversationPageSuffix(baseTitle || "历史对话", contextRef || { url: contextUrl });
}

function generateConversationId() {
  return `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function extractConversationBaseTitle(title) {
  const raw = String(title || "").trim();
  if (!raw) {
    return "当前页面";
  }
  const normalizedRaw = raw.replace(/-P\d+$/i, "").trim();
  const parts = normalizedRaw
    .split(/\s+[|｜]\s+|\s+-\s+|\s+[—–]\s+|\s+[·•]\s+|\r?\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return parts[0] || normalizedRaw;
}

function truncateConversationTitle(title, maxChars = 22) {
  const value = String(title || "").trim();
  const match = value.match(/^(.*?)(-P\d+)$/i);
  if (match) {
    const baseTitle = String(match[1] || "").trim();
    const suffix = String(match[2] || "").trim();
    const truncatedBase = baseTitle.length > maxChars ? `${baseTitle.slice(0, maxChars)}...` : baseTitle;
    return `${truncatedBase}${suffix}`;
  }
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}

function buildConversationTitleDisplay(title, maxChars = 22) {
  const value = String(title || "").trim();
  const match = value.match(/^(.*?)(-P\d+)$/i);
  if (!match) {
    return {
      main: value.length > maxChars ? `${value.slice(0, maxChars)}...` : value,
      suffix: ""
    };
  }

  const suffix = String(match[2] || "").trim();
  const baseTitle = String(match[1] || "").trim();
  const reservedChars = Math.max(suffix.length + 3, 6);
  const availableChars = Math.max(maxChars - reservedChars, 8);
  return {
    main: baseTitle.length > availableChars ? `${baseTitle.slice(0, availableChars)}...` : baseTitle,
    suffix
  };
}

function appendConversationPageSuffix(title, context) {
  const baseTitle = String(title || "").trim() || "历史对话";
  const existingSuffixMatch = baseTitle.match(/-P\d+$/i);
  const cleanTitle = existingSuffixMatch ? baseTitle.replace(/-P\d+$/i, "").trim() : baseTitle;
  const pageSuffix = extractConversationPageSuffix(context);
  return pageSuffix ? `${cleanTitle}${pageSuffix}` : cleanTitle;
}

function extractConversationPageSuffix(context) {
  const pageIndex = Number(context?.pageIndex || context?.page || 0) || extractPageIndexFromContextUrl(context?.url);
  return pageIndex > 1 ? `-P${pageIndex}` : "";
}

function extractPageIndexFromContextUrl(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    const page = Number(parsed.searchParams.get("p") || "1");
    return Number.isFinite(page) && page > 0 ? page : 1;
  } catch {
    return 1;
  }
}

function formatConversationTimestamp(value) {
  const date = new Date(Number(value) || Date.now());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

async function persistCurrentConversation() {
  if (!chatHistory.length || !contextData) {
    return;
  }
  const now = Date.now();
  if (!currentConversationId) {
    currentConversationId = generateConversationId();
    currentConversationMeta = {
      id: currentConversationId,
      title: buildConversationTitle(contextData),
      createdAt: now,
      contextKey: currentContextKey,
      contextTitle: String(contextData.title || "").trim(),
      contextUrl: String(contextData.url || "").trim(),
      isVideoContext: contextData.isVideoContext !== false,
      pinnedContext: true,
      contextRef: buildConversationContextRef(contextData),
      resolvedContext: { ...contextData }
    };
  }
  const nextConversation = {
    id: currentConversationId,
    title: currentConversationMeta?.title || buildConversationTitle(contextData),
    contextKey: String(currentConversationMeta?.contextKey || currentContextKey || "").trim(),
    contextTitle: String(currentConversationMeta?.contextTitle || contextData.title || "").trim(),
    contextUrl: String(currentConversationMeta?.contextUrl || contextData.url || "").trim(),
    isVideoContext: currentConversationMeta?.isVideoContext !== false,
    createdAt: Number(currentConversationMeta?.createdAt) || now,
    updatedAt: now,
    contextRef: currentConversationMeta?.contextRef || buildConversationContextRef(contextData),
    messages: chatHistory.map((item) => ({ role: item.role, content: String(item.content || "") }))
  };
  savedConversations = [
    nextConversation,
    ...savedConversations.filter((item) => item.id !== currentConversationId)
  ];
  currentConversationMeta = {
    id: nextConversation.id,
    title: nextConversation.title,
    createdAt: nextConversation.createdAt,
    updatedAt: nextConversation.updatedAt,
    contextKey: nextConversation.contextKey,
    contextTitle: nextConversation.contextTitle,
    contextUrl: nextConversation.contextUrl,
    isVideoContext: nextConversation.isVideoContext,
    pinnedContext: true,
    contextRef: nextConversation.contextRef,
    resolvedContext: currentConversationMeta?.resolvedContext ? { ...currentConversationMeta.resolvedContext } : { ...contextData }
  };
  await saveConversations();
}

async function ensureCurrentContextForSend() {
  if (currentConversationMeta?.pinnedContext) {
    await loadContextState({ forceRefresh: false, silent: true }).catch(() => null);
    return hydratePinnedConversationContext();
  }
  const ok = await loadContextState({ forceRefresh: false, silent: true });
  if (!ok || !contextData) {
    resetConversationView("当前页面上下文读取失败。");
    return false;
  }
  return true;
}

async function hydratePinnedConversationContext({ silent = false } = {}) {
  const targetKey = String(currentConversationMeta?.contextKey || "").trim();
  const cachedResolvedContext = currentConversationMeta?.resolvedContext;
  if (cachedResolvedContext && typeof cachedResolvedContext === "object") {
    contextData = { ...cachedResolvedContext };
    currentContextKey = targetKey || buildContextKey(contextData);
    updateContextChip();
    removeConversationContextNotice();
    return true;
  }

  if (targetKey && liveContextKey && targetKey === liveContextKey) {
    const ok = await loadContextState({ forceRefresh: false, silent: true });
    if (ok && contextData) {
      currentContextKey = targetKey;
      currentConversationMeta = {
        ...currentConversationMeta,
        resolvedContext: { ...contextData }
      };
      updateContextChip();
      removeConversationContextNotice();
      return true;
    }
  }

  const contextRef = currentConversationMeta?.contextRef || null;
  if (!contextRef) {
    removeConversationContextNotice();
    if (!silent) {
      showConversationContextError("历史对话缺少原视频信息，无法继续。");
    }
    return false;
  }

  const response = await resolveConversationContext(contextRef).catch((error) => ({
    ok: false,
    error: error?.message || String(error || "")
  }));
  if (!response?.ok || !response.payload) {
    removeConversationContextNotice();
    if (!silent) {
      showConversationContextError(`历史视频上下文获取失败：${response?.error || "未知错误"}`);
    }
    return false;
  }

  contextData = response.payload;
  currentContextKey = targetKey || buildContextKey(contextData);
  currentConversationMeta = {
    ...currentConversationMeta,
    contextKey: currentContextKey,
    contextTitle: String(contextData.title || currentConversationMeta?.contextTitle || "").trim(),
    contextUrl: String(contextData.url || currentConversationMeta?.contextUrl || "").trim(),
    contextRef: buildConversationContextRef(contextData),
    resolvedContext: { ...contextData }
  };
  updateContextChip();
  removeConversationContextNotice();
  return true;
}

async function resolveConversationContext(contextRef) {
  const tab = await getActiveTab().catch(() => null);
  return sendRuntimeMessage({
    type: "ai-sidepanel-resolve-context",
    tabId: Number(tab?.id || 0) || 0,
    contextRef
  });
}

async function sendMessage() {
  const text = els.input.value.trim();
  if (!text || activePort) {
    return;
  }
  hidePresetPopover();
  hideHistoryPopover();

  const providerId = els.modelSelect.value;
  if (!providerId) {
    resetConversationView("请先在设置页配置并启用一个 AI 平台。");
    return;
  }

  const hasContext = await ensureCurrentContextForSend();
  if (!hasContext) {
    return;
  }
  if (!currentConversationMeta?.pinnedContext && currentConversationMeta?.contextKey && currentConversationMeta.contextKey !== currentContextKey) {
    currentConversationId = "";
    currentConversationMeta = null;
  }

  if (activePort) {
    try {
      activePort.disconnect();
    } catch {}
    activePort = null;
  }

  suggestionsNode?.remove();
  suggestionsNode = null;
  removeCenteredState();

  appendUserMessage(text);
  els.input.value = "";
  autosizeInput();
  setStreamingUiState(true);
  activeUserPrompt = text;
  activeAssistantNode = appendAssistantPlaceholder();
  startStreamSlowNoticeTimer();
  streamFirstTokenReceived = false;

  activePort = chrome.runtime.connect({ name: "sidepanel-chat" });
  activePort.onMessage.addListener((msg) => {
    if (!msg) {
      return;
    }
    if (msg.type === "token") {
      handleFirstStreamToken();
      appendToken(activeAssistantNode, msg.data);
    } else if (msg.type === "done") {
      finalizeAssistant(activeAssistantNode);
    } else if (msg.type === "stopped") {
      handleAssistantStopped(activeAssistantNode, msg.reason || "已停止生成");
    } else if (msg.type === "error") {
      showAssistantError(activeAssistantNode, msg.error || "未知错误");
    }
  });
  activePort.onDisconnect.addListener(() => {
    clearStreamRuntimeState();
    setStreamingUiState(false);
    activePort = null;
  });

  activePort.postMessage({
    action: "chat",
    providerId,
    context: {
      ...contextData,
      aiSystemPrompt: aiPrefs.aiSystemPrompt
    },
    prompt: text,
    history: chatHistory
  });
}

function appendUserMessage(text, shouldScroll = true) {
  const node = document.createElement("div");
  node.className = "sp-msg sp-msg-user";
  node.textContent = text;
  els.messages.appendChild(node);
  if (shouldScroll) {
    shouldAutoScrollMessages = true;
    scrollToBottom(true);
  }
}

function appendAssistantPlaceholder() {
  const node = document.createElement("div");
  node.className = "sp-msg sp-msg-assistant";
  node.dataset.raw = "";
  const cursor = document.createElement("span");
  cursor.className = "sp-msg-cursor";
  node.appendChild(cursor);
  els.messages.appendChild(node);
  shouldAutoScrollMessages = true;
  scrollToBottom(true);
  return node;
}

function appendToken(node, token) {
  if (!node) {
    return;
  }
  const raw = (node.dataset.raw || "") + String(token || "");
  node.dataset.raw = raw;
  node.innerHTML = renderMarkdown(raw) + '<span class="sp-msg-cursor"></span>';
  scrollToBottom();
}

function finalizeAssistant(node) {
  if (!node) {
    return;
  }
  clearStreamRuntimeState();
  const raw = node.dataset.raw || "";
  renderAssistantMessage(node, raw);
  if (activeUserPrompt && raw) {
    chatHistory.push({ role: "user", content: activeUserPrompt });
    chatHistory.push({ role: "assistant", content: raw });
    activeUserPrompt = "";
    void persistCurrentConversation();
  }
  if (activePort) {
    try {
      activePort.disconnect();
    } catch {}
    activePort = null;
  }
  setStreamingUiState(false);
  els.input.focus();
  scrollToBottom();
}

function showAssistantError(node, error) {
  if (!node) {
    return;
  }
  clearStreamRuntimeState();
  node.innerHTML = "";
  const err = document.createElement("div");
  err.className = "sp-msg-error";
  err.textContent = `错误：${error}`;
  node.appendChild(err);
  activeUserPrompt = "";
  if (activePort) {
    try {
      activePort.disconnect();
    } catch {}
    activePort = null;
  }
  setStreamingUiState(false);
  els.input.focus();
  scrollToBottom();
}

function handleAssistantStopped(node, reason) {
  if (!node) {
    return;
  }
  clearStreamRuntimeState();
  const raw = String(node.dataset.raw || "");
  if (raw.trim()) {
    renderAssistantMessage(node, raw);
    const stopped = document.createElement("div");
    stopped.className = "sp-msg-stopped";
    stopped.textContent = reason || "已停止生成";
    node.appendChild(stopped);
    if (activeUserPrompt) {
      chatHistory.push({ role: "user", content: activeUserPrompt });
      chatHistory.push({ role: "assistant", content: raw });
      activeUserPrompt = "";
      void persistCurrentConversation();
    }
  } else {
    node.innerHTML = "";
    const stopped = document.createElement("div");
    stopped.className = "sp-msg-stopped";
    stopped.textContent = reason || "已停止生成";
    node.appendChild(stopped);
    activeUserPrompt = "";
  }
  if (activePort) {
    try {
      activePort.disconnect();
    } catch {}
    activePort = null;
  }
  setStreamingUiState(false);
  els.input.focus();
  scrollToBottom();
}

function stopActiveStream() {
  if (!activePort) {
    return;
  }
  if (els.stopBtn) {
    els.stopBtn.disabled = true;
    els.stopBtn.textContent = "停止中...";
  }
  try {
    activePort.postMessage({ action: "stop" });
  } catch {
    try {
      activePort.disconnect();
    } catch {}
  }
}

function startStreamSlowNoticeTimer() {
  clearStreamRuntimeState();
  streamFirstTokenReceived = false;
  streamSlowNoticeTimer = window.setTimeout(() => {
    if (!activePort || streamFirstTokenReceived) {
      return;
    }
    showConversationContextNotice("模型响应较慢，仍在等待服务器返回...", 0);
  }, STREAM_SLOW_NOTICE_MS);
}

function handleFirstStreamToken() {
  if (streamFirstTokenReceived) {
    return;
  }
  streamFirstTokenReceived = true;
  clearStreamRuntimeState();
}

function clearStreamRuntimeState() {
  if (streamSlowNoticeTimer) {
    window.clearTimeout(streamSlowNoticeTimer);
    streamSlowNoticeTimer = 0;
  }
  streamFirstTokenReceived = false;
  removeConversationContextNotice();
}

function renderAssistantMessage(node, raw) {
  if (!node) {
    return;
  }
  node.innerHTML = "";
  const cleanedRaw = stripThinkBlocks(raw);
  const pasteReadyRaw = normalizeMarkdownForSectionPaste(cleanedRaw);

  const content = document.createElement("div");
  content.className = "sp-msg-assistant-body";
  content.innerHTML = renderMarkdown(cleanedRaw);
  linkifyAssistantTimestamps(content);
  node.appendChild(content);

  const actions = document.createElement("div");
  actions.className = "sp-msg-actions";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "sp-msg-copy-btn";
  copyBtn.setAttribute("aria-label", "复制回复");
  copyBtn.setAttribute("title", "复制回复");
  copyBtn.innerHTML = `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <rect x="9" y="9" width="10" height="10" rx="2"></rect>
      <path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1"></path>
    </svg>
  `;
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pasteReadyRaw);
      copyBtn.disabled = true;
      window.setTimeout(() => {
        copyBtn.disabled = false;
      }, 500);
    } catch {
      copyBtn.disabled = true;
      window.setTimeout(() => {
        copyBtn.disabled = false;
      }, 500);
    }
  });
  actions.appendChild(copyBtn);
  node.appendChild(actions);
}

function normalizeMarkdownForSectionPaste(raw, baseLevel = 2) {
  const shift = Math.max(0, Number(baseLevel) || 0);
  const lines = String(raw || "").split("\n");
  const normalized = [];
  let inFence = false;

  lines.forEach((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      normalized.push(line);
      return;
    }

    if (inFence) {
      normalized.push(line);
      return;
    }

    const headingMatch = line.match(/^(\s*)(#{1,3})(\s+.*)$/);
    if (!headingMatch) {
      normalized.push(line);
      return;
    }

    const [, indent, hashes, suffix] = headingMatch;
    normalized.push(`${indent}${"#".repeat(hashes.length + shift)}${suffix}`);
  });

  return normalized.join("\n");
}

const TIMESTAMP_PATTERN = /\b\d{1,3}:\d{2}(?::\d{2})?\b/g;

function linkifyAssistantTimestamps(root) {
  if (!root) {
    return;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    const current = walker.currentNode;
    if (!(current instanceof Text)) {
      continue;
    }
    const parent = current.parentElement;
    if (!parent || parent.closest("a, code, pre, button")) {
      continue;
    }
    TIMESTAMP_PATTERN.lastIndex = 0;
    if (!TIMESTAMP_PATTERN.test(current.textContent || "")) {
      continue;
    }
    textNodes.push(current);
  }

  textNodes.forEach((node) => {
    const text = node.textContent || "";
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let hasMatch = false;
    TIMESTAMP_PATTERN.lastIndex = 0;
    let match;
    while ((match = TIMESTAMP_PATTERN.exec(text))) {
      hasMatch = true;
      if (match.index > lastIndex) {
        fragment.append(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const timestamp = match[0];
      const seconds = parseTimestampToSeconds(timestamp);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sp-timestamp-link";
      button.textContent = timestamp;
      button.setAttribute("title", `跳转到 ${timestamp}`);
      button.addEventListener("click", () => {
        void jumpToAssistantTimestamp(seconds, timestamp);
      });
      fragment.append(button);
      lastIndex = match.index + timestamp.length;
    }
    if (!hasMatch) {
      return;
    }
    if (lastIndex < text.length) {
      fragment.append(document.createTextNode(text.slice(lastIndex)));
    }
    node.replaceWith(fragment);
  });
}

function parseTimestampToSeconds(value) {
  const parts = String(value || "")
    .trim()
    .split(":")
    .map((item) => Number(item));
  if (!parts.length || parts.some((item) => !Number.isFinite(item) || item < 0)) {
    return 0;
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}

async function jumpToAssistantTimestamp(seconds, label = "") {
  const safeSeconds = Math.max(0, Number(seconds || 0) || 0);
  const targetUrl = String(contextData?.url || currentConversationMeta?.contextUrl || "").trim();
  if (!targetUrl) {
    showConversationContextNotice("当前没有可跳转的视频上下文。", 2200);
    return;
  }

  const tab = await getActiveTab().catch(() => null);
  if (!tab?.id) {
    showConversationContextNotice("找不到当前标签页。", 2200);
    return;
  }

  showConversationContextNotice(`正在跳转到 ${label || formatSecondsAsTimestamp(safeSeconds)}...`, 1800);

  try {
    const sameVideo = doesTabMatchContextUrl(tab.url || "", targetUrl);
    if (!sameVideo) {
      await chrome.tabs.update(tab.id, { url: targetUrl });
      await waitForTabComplete(tab.id);
    }
    const response = await sendMessageToActiveTab(tab.id, {
      type: "sidepanel-seek-video-time",
      seconds: safeSeconds
    });
    if (!response?.ok) {
      throw new Error(response?.error || "视频时间跳转失败");
    }
  } catch (error) {
    showConversationContextNotice(`时间跳转失败：${error?.message || error}`, 2600);
  }
}

function doesTabMatchContextUrl(tabUrl, targetUrl) {
  const current = extractVideoIdentity(tabUrl);
  const target = extractVideoIdentity(targetUrl);
  if (!current.bvid || !target.bvid) {
    return String(tabUrl || "").trim() === String(targetUrl || "").trim();
  }
  return current.bvid === target.bvid && current.page === target.page;
}

function extractVideoIdentity(url) {
  const text = String(url || "").trim();
  const bvidMatch = text.match(/\/video\/(BV[0-9A-Za-z]+)/i) || text.match(/[?&]bvid=(BV[0-9A-Za-z]+)/i);
  let page = 1;
  try {
    page = Number(new URL(text).searchParams.get("p") || "1");
    if (!Number.isFinite(page) || page <= 0) {
      page = 1;
    }
  } catch {
    page = 1;
  }
  return {
    bvid: String(bvidMatch?.[1] || "").trim(),
    page
  };
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") {
      return true;
    }
    await delay(250);
  }
  throw new Error("视频页面加载超时");
}

async function sendMessageToActiveTab(tabId, message, retries = 12) {
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(resp);
        });
      });
    } catch (error) {
      lastError = error;
      await delay(220);
    }
  }
  throw lastError || new Error("无法连接视频页面");
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatSecondsAsTimestamp(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const hour = Math.floor(safe / 3600);
  const minute = Math.floor((safe % 3600) / 60);
  const second = safe % 60;
  if (hour > 0) {
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  }
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function restartChat({ keepContext = false } = {}) {
  clearStreamRuntimeState();
  if (activePort) {
    try {
      activePort.disconnect();
    } catch {}
    activePort = null;
  }

  activeAssistantNode = null;
  activeUserPrompt = "";
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

function showConversationContextNotice(message, autoHideMs = 0) {
  removeConversationContextNotice();
  const notice = document.createElement("div");
  notice.className = "sp-context-notice";
  notice.textContent = String(message || "").trim();
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

function renderMarkdown(text) {
  let escaped = escapeHtml(stripThinkBlocks(text));
  const codeBlocks = [];
  escaped = escaped.replace(/```([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code);
    return `\u0001BOC_CODE_${codeBlocks.length - 1}\u0001`;
  });

  const lines = escaped.split("\n");
  const out = [];
  let listType = "";
  let listStartNumber = 1;
  let paraBuf = [];

  const flushPara = () => {
    if (paraBuf.length) {
      out.push(`<p>${renderInline(paraBuf.join(" "))}</p>`);
      paraBuf = [];
    }
  };
  const closeList = () => {
    if (!listType) {
      return;
    }
    out.push(listType === "ul" ? "</ul>" : "</ol>");
    listType = "";
    listStartNumber = 1;
  };
  const openList = (nextType, startNumber = 1) => {
    if (listType === nextType && (nextType !== "ol" || listStartNumber === startNumber)) {
      return;
    }
    closeList();
    listType = nextType;
    listStartNumber = nextType === "ol" ? startNumber : 1;
    if (nextType === "ul") {
      out.push("<ul>");
      return;
    }
    out.push(startNumber > 1 ? `<ol start="${startNumber}">` : "<ol>");
  };
  const getNextListType = (startIndex) => {
    for (let index = startIndex; index < lines.length; index += 1) {
      const nextLine = lines[index].trim();
      if (!nextLine) {
        continue;
      }
      if (/^[-*+]\s+(.+)$/.test(nextLine)) {
        return "ul";
      }
      if (/^\d+\.\s+(.+)$/.test(nextLine)) {
        return "ol";
      }
      break;
    }
    return "";
  };
  const isTableSeparatorLine = (value) => /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(value);
  const isTableRowLine = (value) => /^\|.+\|$/.test(value);
  const splitTableCells = (value) =>
    value
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => renderInline(cell.trim()));

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    const codeMatch = line.match(/^\u0001BOC_CODE_(\d+)\u0001$/);
    if (codeMatch) {
      flushPara();
      closeList();
      out.push(`<pre><code>${codeBlocks[Number(codeMatch[1])]}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length + 2;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (
      isTableRowLine(line) &&
      index + 1 < lines.length &&
      isTableSeparatorLine(lines[index + 1].trim())
    ) {
      flushPara();
      closeList();
      const headers = splitTableCells(line);
      const bodyRows = [];
      index += 2;
      while (index < lines.length) {
        const tableLine = lines[index].trim();
        if (!isTableRowLine(tableLine)) {
          index -= 1;
          break;
        }
        bodyRows.push(splitTableCells(tableLine));
        index += 1;
      }
      out.push(
        `<table><thead><tr>${headers.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${
          bodyRows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")
        }</tbody></table>`
      );
      continue;
    }

    const ul = line.match(/^[-*+]\s+(.+)$/);
    if (ul) {
      flushPara();
      openList("ul");
      out.push(`<li>${renderInline(ul[1])}</li>`);
      continue;
    }

    const ol = line.match(/^(\d+)\.\s+(.+)$/);
    if (ol) {
      flushPara();
      const orderNumber = Number(ol[1]) || 1;
      openList("ol", orderNumber);
      out.push(`<li>${renderInline(ol[2])}</li>`);
      continue;
    }

    if (!line) {
      flushPara();
      if (listType && getNextListType(index + 1) === listType) {
        continue;
      }
      closeList();
      continue;
    }

    paraBuf.push(line);
  }

  flushPara();
  closeList();
  return out.join("");
}

function renderInline(text) {
  return text
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, (_, c) => `<strong>${c}</strong>`)
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, pre, c) => `${pre}<em>${c}</em>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
      const safeUrl = /^(https?:|mailto:|#)/i.test(u) ? u : "#";
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${t}</a>`;
    });
}

function stripThinkBlocks(text) {
  return String(text || "")
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<\/think>/gi, "")
    .replace(/^\s*<\/?think\b[^>]*>\s*$/gim, "")
    .trim();
}

function scrollToBottom(force = false) {
  if (!force && !shouldAutoScrollMessages) {
    return;
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(value, max) {
  const s = String(value || "");
  return s.length > max ? s.slice(0, max) + "..." : s;
}
