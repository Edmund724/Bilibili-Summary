// sidepanel-conversation-store.ts
// 会话持久化 + 上下文绑定关注点（sidepanel-split ticket #05）。
//
// 本模块从 extension/pages/sidepanel.js 抽出「会话列表的存取、按视频上下文
// 绑定/恢复、增删改」这条关注点。会话状态本体收拢在 ./sidepanel-state.js
// 的 sidepanelState，本模块直接 import 读写；deps 只剩 UI/transport 回调、
// storage 抽象与常量。
//
// 纯函数（`needsConversationPageHydration`）直接 export，可在无 store 实例时测试。
// 工厂返回的窄接口仅暴露 sidepanel 真正调用的方法。

import {
  buildAiContextRef,
  buildContextKey,
  buildContextPlaceholder,
  buildConversationTitle,
  generateConversationId,
  normalizeConversations,
  resolveConversationStorageKey,
  normalizeConversationTitle,
  doesConversationMatchCurrentContext,
  MAX_SAVED_CONVERSATIONS
} from "../ai/conversation.js";
import { extractPageIndexFromUrl } from "../bilibili/video-id-shared.js";
import { sidepanelState as _sidepanelState } from "./sidepanel-state.js";

// ---------------------------------------------------------------------------
// 本地类型契约
// ---------------------------------------------------------------------------

export interface ConversationContextRef {
  title?: string;
  url?: string;
  author?: string;
  uploadDate?: string;
  bvid?: string;
  cid?: string;
  aid?: string;
  pageIndex?: number;
  pageCount?: number;
  pageTitle?: string;
  subtitleLang?: string;
  selectedSubtitleId?: string;
  selectedSubtitleUrl?: string;
  chapters?: unknown[];
  isVideoContext?: boolean;
}

export interface ConversationMessage {
  role: string;
  content: string;
}

export interface Conversation {
  id: string;
  title: string;
  contextKey: string;
  contextTitle: string;
  contextUrl: string;
  isVideoContext: boolean;
  createdAt: number;
  updatedAt: number;
  contextRef: ConversationContextRef;
  messages: ConversationMessage[];
}

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  contextKey: string;
  contextTitle: string;
  contextUrl: string;
  isVideoContext: boolean;
  pinnedContext: boolean;
  contextRef: ConversationContextRef | null;
  resolvedContext?: Record<string, unknown> | null;
}

export interface SidepanelState {
  contextData: Record<string, unknown> | null;
  currentContextKey: string;
  providers: unknown[];
  chatHistory: ConversationMessage[];
  savedConversations: Conversation[];
  currentConversationId: string;
  currentConversationMeta: ConversationMeta | null;
  liveContextData: Record<string, unknown> | null;
  liveContextKey: string;
  liveTabUrl: string;
  aiPrefs: {
    aiSystemPrompt: string;
    aiInitialQuickPrompts: string[];
    aiPresetPrompts: string[];
  };
  asrTranscribingActive: boolean;
  aiThinkingLevel: string;
}

export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface LoadContextStateOptions {
  forceRefresh?: boolean;
  silent?: boolean;
}

export interface HydratePinnedOptions {
  silent?: boolean;
}

export interface CreateConversationStoreDeps {
  renderHistoryList: () => void;
  renderInitialState: () => void;
  updateContextChip: () => void;
  showConversationContextNotice: (message: string, autoHideMs?: number) => void;
  showConversationContextError: (message: string) => void;
  removeConversationContextNotice: () => void;
  hideHistoryPopover: () => void;
  loadContextState: (opts: LoadContextStateOptions) => Promise<boolean | object>;
  getActiveTab: () => Promise<{ id?: number; url?: string } | null>;
  sendRuntimeMessage: (message: unknown, opts?: unknown) => Promise<{ ok?: boolean; payload?: unknown; error?: string }>;
  stopActiveChat: () => void;
  storage?: StorageArea;
  conversationsStorageKey?: string;
  maxSavedConversations?: number;
}

export interface ConversationStore {
  loadAll: () => Promise<void>;
  hydratePages: () => Promise<void>;
  isCurrent: (id: string) => boolean;
  persistCurrent: () => Promise<void>;
  applyById: (id: string) => void;
  apply: (conversation: Conversation | null | undefined) => void;
  deleteById: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
  restoreLatest: () => Promise<boolean>;
  resolveContext: (contextRef: ConversationContextRef) => Promise<{ ok?: boolean; payload?: unknown; error?: string }>;
  hydratePinned: (opts?: HydratePinnedOptions) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// 从 JS 模块导入的函数在 checkJs:false 下无类型；用本地接口断言到实际契约。
// ---------------------------------------------------------------------------

const sidepanelState = _sidepanelState as SidepanelState;

const _buildAiContextRef = buildAiContextRef as unknown as (context: unknown) => ConversationContextRef;
const _buildContextKey = buildContextKey as unknown as (payload: unknown) => string;
const _buildContextPlaceholder = buildContextPlaceholder as unknown as (
  ref: ConversationContextRef
) => Record<string, unknown> | null;
const _buildConversationTitle = buildConversationTitle as unknown as (context: unknown) => string;
const _generateConversationId = generateConversationId as unknown as () => string;
const _normalizeConversations = normalizeConversations as unknown as (value: unknown) => Conversation[];
const _resolveConversationStorageKey = resolveConversationStorageKey as unknown as (
  rawKey: unknown,
  contextRef: ConversationContextRef,
  contextUrl?: string
) => string;
const _normalizeConversationTitle = normalizeConversationTitle as unknown as (
  title: unknown,
  contextTitle: unknown,
  contextRef: ConversationContextRef | null,
  contextUrl?: string
) => string;
const _doesConversationMatchCurrentContext = doesConversationMatchCurrentContext as unknown as (
  conversation: Conversation,
  currentRef: unknown,
  targetContextKey?: string
) => boolean;
const _extractPageIndexFromUrl = extractPageIndexFromUrl as unknown as (url: string) => number;

// ---------------------------------------------------------------------------
// 纯函数（直接 export，无需 store 实例即可测试）
// ---------------------------------------------------------------------------

export function needsConversationPageHydration(conversation: Conversation | null | undefined): boolean {
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
  const urlPageIndex = _extractPageIndexFromUrl(conversation.contextUrl || conversation.contextRef?.url || "");
  if (urlPageIndex > 1) {
    return true;
  }
  return Boolean(conversation.contextRef?.bvid && conversation.contextRef?.cid);
}

// ---------------------------------------------------------------------------
// 工厂：createConversationStore(deps)
// ---------------------------------------------------------------------------

export function createConversationStore(deps: CreateConversationStoreDeps): ConversationStore {
  const {
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
    stopActiveChat,
    storage = (typeof chrome !== "undefined" && chrome?.storage?.local) || undefined,
    conversationsStorageKey = "boc_ai_conversations_v1",
    maxSavedConversations = MAX_SAVED_CONVERSATIONS
  } = deps;

  function requireDep<T>(name: string, value: T | undefined): T {
    if (typeof value !== "function" && name !== "storage") {
      throw new Error(`createConversationStore: deps.${name} is required (must be a function)`);
    }
    if (value === undefined) {
      throw new Error(`createConversationStore: deps.${name} is required`);
    }
    return value;
  }

  function saved(): Conversation[] {
    return sidepanelState.savedConversations;
  }
  function commitSaved(next: Conversation[]): void {
    sidepanelState.savedConversations = next;
  }

  async function loadAll(): Promise<void> {
    const data = await requireDep("storage", storage)
      .get([conversationsStorageKey])
      .catch(() => ({}) as Record<string, unknown>);
    commitSaved(_normalizeConversations(data[conversationsStorageKey]));
    requireDep("renderHistoryList", renderHistoryList)();
    void hydratePages();
  }

  async function hydratePages(): Promise<void> {
    const conversations = saved();
    const candidates = conversations.filter((item) => needsConversationPageHydration(item)).slice(0, 12);
    if (!candidates.length) {
      return;
    }

    let changed = false;
    for (const conversation of candidates) {
      const contextRef = conversation.contextRef || null;
      if (!contextRef?.bvid || !contextRef?.cid) {
        continue;
      }
      const response = await requireDep("sendRuntimeMessage", sendRuntimeMessage)({
        type: "ai-sidepanel-resolve-page-ref",
        contextRef
      }).catch(() => null);
      if (!response?.ok || !response.payload) {
        continue;
      }

      const payload = response.payload as {
        pageIndex?: number;
        url?: string;
        cid?: string;
        pageTitle?: string;
      };
      const nextPageIndex = Number(payload.pageIndex) > 0 ? Number(payload.pageIndex) : 1;
      const nextUrl = String(payload.url || conversation.contextUrl || contextRef.url || "").trim();
      const nextContextRef: ConversationContextRef = {
        ...contextRef,
        url: nextUrl,
        cid: String(payload.cid || contextRef.cid || "").trim(),
        pageIndex: nextPageIndex,
        pageTitle: String(payload.pageTitle || contextRef.pageTitle || "").trim()
      };
      const nextTitle = _normalizeConversationTitle(
        conversation.title,
        conversation.contextTitle,
        nextContextRef,
        nextUrl
      );
      const nextContextKey = _resolveConversationStorageKey(conversation.contextKey, nextContextRef, nextUrl);
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

    const currentId = sidepanelState.currentConversationId;
    if (currentId) {
      const activeConversation = conversations.find((item) => item.id === currentId);
      if (activeConversation) {
        sidepanelState.currentConversationMeta = {
          ...sidepanelState.currentConversationMeta,
          title: activeConversation.title,
          contextKey: activeConversation.contextKey,
          contextUrl: activeConversation.contextUrl,
          contextRef: activeConversation.contextRef
        } as ConversationMeta;
      }
    }
    requireDep("renderHistoryList", renderHistoryList)();
    requireDep("updateContextChip", updateContextChip)();
    await saveConversations();
  }

  async function saveConversations(): Promise<void> {
    await requireDep("storage", storage).set({
      [conversationsStorageKey]: saved().slice(0, maxSavedConversations)
    });
    requireDep("renderHistoryList", renderHistoryList)();
  }

  async function restoreLatest(): Promise<boolean> {
    const targetContextKey = sidepanelState.liveContextKey || sidepanelState.currentContextKey;
    const currentRef = sidepanelState.liveContextData || sidepanelState.contextData;
    const conversations = saved();
    const latest = conversations.find((item) =>
      _doesConversationMatchCurrentContext(item, currentRef, targetContextKey)
    );
    if (!latest) {
      requireDep("stopActiveChat", stopActiveChat)();
      sidepanelState.currentConversationId = "";
      sidepanelState.currentConversationMeta = null;
      sidepanelState.chatHistory = [];
      return false;
    }
    apply(latest);
    return true;
  }

  function apply(conversation: Conversation | null | undefined): void {
    if (!conversation) {
      return;
    }
    sidepanelState.currentConversationId = conversation.id;
    sidepanelState.currentConversationMeta = {
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
    sidepanelState.chatHistory = Array.isArray(conversation.messages)
      ? conversation.messages.map((item) => ({ role: item.role, content: String(item.content || "") }))
      : [];
    const liveData = sidepanelState.liveContextData;
    const liveKey = sidepanelState.liveContextKey;
    if (liveData && conversation.contextKey && conversation.contextKey === liveKey) {
      sidepanelState.contextData = { ...liveData };
      sidepanelState.currentContextKey = liveKey;
      sidepanelState.currentConversationMeta = {
        ...sidepanelState.currentConversationMeta,
        resolvedContext: { ...liveData }
      } as ConversationMeta;
    } else if (conversation.contextRef) {
      sidepanelState.contextData = _buildContextPlaceholder(conversation.contextRef);
      sidepanelState.currentContextKey = conversation.contextKey || _buildContextKey(sidepanelState.contextData);
    }
    requireDep("updateContextChip", updateContextChip)();
    requireDep("renderHistoryList", renderHistoryList)();
  }

  function applyById(id: string): void {
    const conversation = saved().find((item) => item.id === id);
    if (!conversation) {
      return;
    }
    apply(conversation);
    requireDep("renderInitialState", renderInitialState)();
    if (conversation.contextKey && conversation.contextKey !== sidepanelState.liveContextKey) {
      requireDep("showConversationContextNotice", showConversationContextNotice)("正在加载原视频上下文...");
      void hydratePinned({ silent: true });
    }
  }

  async function deleteById(id: string): Promise<void> {
    const wasCurrent = id && id === sidepanelState.currentConversationId;
    if (wasCurrent) {
      requireDep("stopActiveChat", stopActiveChat)();
    }
    const next = saved().filter((item) => item.id !== id);
    commitSaved(next);
    await saveConversations();
    if (!wasCurrent) {
      return;
    }
    sidepanelState.currentConversationId = "";
    sidepanelState.currentConversationMeta = null;
    sidepanelState.chatHistory = [];
    const liveData = sidepanelState.liveContextData;
    if (liveData) {
      sidepanelState.contextData = { ...liveData };
      sidepanelState.currentContextKey = sidepanelState.liveContextKey || _buildContextKey(liveData);
      requireDep("updateContextChip", updateContextChip)();
    }
    requireDep("renderInitialState", renderInitialState)();
  }

  async function clearAll(): Promise<void> {
    if (!saved().length) {
      return;
    }
    if (!confirm("确定要清空全部历史对话吗？")) {
      return;
    }
    commitSaved([]);
    requireDep("stopActiveChat", stopActiveChat)();
    sidepanelState.currentConversationId = "";
    sidepanelState.currentConversationMeta = null;
    sidepanelState.chatHistory = [];
    await saveConversations();
    requireDep("hideHistoryPopover", hideHistoryPopover)();
    const liveData = sidepanelState.liveContextData;
    if (liveData) {
      sidepanelState.contextData = { ...liveData };
      sidepanelState.currentContextKey = sidepanelState.liveContextKey || _buildContextKey(liveData);
      requireDep("updateContextChip", updateContextChip)();
    }
    requireDep("renderInitialState", renderInitialState)();
  }

  function isCurrent(id: string): boolean {
    return id === sidepanelState.currentConversationId;
  }

  async function persistCurrent(): Promise<void> {
    const chat = sidepanelState.chatHistory;
    const context = sidepanelState.contextData;
    if (!chat.length || !context) {
      return;
    }
    const now = Date.now();
    let currentId = sidepanelState.currentConversationId;
    let meta = sidepanelState.currentConversationMeta;
    if (!currentId) {
      currentId = _generateConversationId();
      sidepanelState.currentConversationId = currentId;
      meta = {
        id: currentId,
        title: _buildConversationTitle(context),
        createdAt: now,
        updatedAt: now,
        contextKey: sidepanelState.currentContextKey,
        contextTitle: String(context.title || "").trim(),
        contextUrl: String(context.url || "").trim(),
        isVideoContext: context.isVideoContext !== false,
        pinnedContext: true,
        contextRef: _buildAiContextRef(context),
        resolvedContext: { ...context }
      };
      sidepanelState.currentConversationMeta = meta;
    }
    const nextConversation: Conversation = {
      id: currentId,
      title: meta?.title || _buildConversationTitle(context),
      contextKey: String(meta?.contextKey || sidepanelState.currentContextKey || "").trim(),
      contextTitle: String(meta?.contextTitle || context.title || "").trim(),
      contextUrl: String(meta?.contextUrl || context.url || "").trim(),
      isVideoContext: meta?.isVideoContext !== false,
      createdAt: Number(meta?.createdAt) || now,
      updatedAt: now,
      contextRef: meta?.contextRef || _buildAiContextRef(context),
      messages: chat.map((item) => ({ role: item.role, content: String(item.content || "") }))
    };
    const filtered = saved().filter((item) => item.id !== currentId);
    commitSaved([nextConversation, ...filtered].slice(0, maxSavedConversations));
    sidepanelState.currentConversationMeta = {
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
      resolvedContext: meta?.resolvedContext ? { ...meta.resolvedContext } : { ...context }
    };
    await saveConversations();
  }

  async function hydratePinned({ silent = false }: HydratePinnedOptions = {}): Promise<boolean> {
    let meta = sidepanelState.currentConversationMeta;
    const targetKey = String(meta?.contextKey || "").trim();
    const cachedResolvedContext = meta?.resolvedContext;
    if (cachedResolvedContext && typeof cachedResolvedContext === "object") {
      sidepanelState.contextData = { ...cachedResolvedContext };
      sidepanelState.currentContextKey = targetKey || _buildContextKey(sidepanelState.contextData);
      requireDep("updateContextChip", updateContextChip)();
      requireDep("removeConversationContextNotice", removeConversationContextNotice)();
      return true;
    }

    if (targetKey && sidepanelState.liveContextKey && targetKey === sidepanelState.liveContextKey) {
      const ok = await requireDep("loadContextState", loadContextState)({ forceRefresh: false, silent: true });
      const context = sidepanelState.contextData;
      if (ok && context) {
        sidepanelState.currentContextKey = targetKey;
        meta = sidepanelState.currentConversationMeta;
        sidepanelState.currentConversationMeta = {
          ...meta,
          resolvedContext: { ...context }
        } as ConversationMeta;
        requireDep("updateContextChip", updateContextChip)();
        requireDep("removeConversationContextNotice", removeConversationContextNotice)();
        return true;
      }
    }

    const contextRef = sidepanelState.currentConversationMeta?.contextRef || null;
    if (!contextRef) {
      requireDep("removeConversationContextNotice", removeConversationContextNotice)();
      if (!silent) {
        requireDep("showConversationContextError", showConversationContextError)("历史对话缺少原视频信息，无法继续。");
      }
      return false;
    }

    const response: { ok?: boolean; payload?: unknown; error?: string } = await resolveContext(
      contextRef
    ).catch((error: unknown) => ({
      ok: false,
      error: (error as Error)?.message || String(error || "")
    }));
    if (!response?.ok || !response.payload) {
      requireDep("removeConversationContextNotice", removeConversationContextNotice)();
      if (!silent) {
        requireDep("showConversationContextError", showConversationContextError)(
          `历史视频上下文获取失败：${response?.error || "未知错误"}`
        );
      }
      return false;
    }

    const resolved = response.payload as Record<string, unknown>;
    sidepanelState.contextData = resolved;
    sidepanelState.currentContextKey = targetKey || _buildContextKey(resolved);
    meta = sidepanelState.currentConversationMeta;
    sidepanelState.currentConversationMeta = {
      ...meta,
      contextKey: sidepanelState.currentContextKey,
      contextTitle: String(resolved.title || meta?.contextTitle || "").trim(),
      contextUrl: String(resolved.url || meta?.contextUrl || "").trim(),
      contextRef: _buildAiContextRef(resolved),
      resolvedContext: { ...resolved }
    } as ConversationMeta;
    requireDep("updateContextChip", updateContextChip)();
    requireDep("removeConversationContextNotice", removeConversationContextNotice)();
    return true;
  }

  async function resolveContext(
    contextRef: ConversationContextRef
  ): Promise<{ ok?: boolean; payload?: unknown; error?: string }> {
    const tab = await requireDep("getActiveTab", getActiveTab)().catch(() => null);
    return requireDep("sendRuntimeMessage", sendRuntimeMessage)({
      type: "ai-sidepanel-resolve-context",
      tabId: Number(tab?.id || 0) || 0,
      contextRef
    });
  }

  return {
    loadAll,
    hydratePages,
    isCurrent,
    persistCurrent,
    applyById,
    apply,
    deleteById,
    clearAll,
    restoreLatest,
    resolveContext,
    hydratePinned
  };
}
