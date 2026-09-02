// extension/chat/conversation-store.ts
// 会话持久化 + 上下文绑定关注点（sidepanel-split ticket #05 抽出；PR5 自
// extension/pages/sidepanel-conversation-store.ts 迁入 chat 域，逻辑零语义改动；
// arch-slim 工单 05：渲染面反转为能力事件，见下）。
//
// 本模块从 extension/pages/sidepanel.js 抽出「会话列表的存取、按视频上下文
// 绑定/恢复、增删改」这条关注点。会话状态本体收拢在 ./chat-state.js
// 的 chatSessionState，本模块直接 import 读写。
//
// 工单 05（渲染编排反转）：原 14 键 deps 里 9 个 caller 必学的渲染/行为回调
// （renderHistoryList / renderInitialState / updateContextChip /
// show·removeConversationContextNotice / showConversationContextError /
// hideHistoryPopover / stopActiveChat）收窄为 3 个能力事件——store 自己编排
// 渲染时机，caller 只订阅结果：
//   - onConversationChanged(change)：会话相关状态已写入后发出；历史列表恒随
//     事件重渲，change 标志（refreshContextChip / historyCleared / resetView）
//     声明其余需要刷新的呈现面。发火点与反转前各渲染回调的位点逐一对齐：
//     loadAll/save（仅列表）、hydratePages/apply/hydratePinned 成功（列表+chip）、
//     applyById/删当前/清空（列表+chip+视图重建；清空另收 popover）。
//   - onStreamInterrupted()：当前会话被拆除（恢复无匹配 / 删当前会话 / 清空
//     全部）时同步发出——必须先于任何 await 落盘（原 stopActiveChat dep 的
//     承重时序：流式身份守卫在 id 清空前依赖同步断流，防会话复活）。
//   - onContextNotice(notice)：上下文补水提示生命周期（pending 展示 / clear
//     撤除 / error 展示），消息文案属补水结果，由 store 提供。
//
// 纯函数（`needsConversationPageHydration`）直接 export，可在无 store 实例时测试。
// 工厂返回的窄接口仅暴露组合根真正调用的方法。

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
import { chatSessionState as _chatSessionState } from "./chat-state.js";

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

export interface ChatSessionState {
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

// 能力事件一：会话相关状态变更声明。历史列表恒随事件重渲；其余呈现面由标志
// 声明（store 编排「何时」，caller 只实现「各表面怎么刷」）。
export interface ConversationChange {
  // 上下文绑定呈现需刷新（contextData / currentContextKey / currentConversationMeta 已写入）
  refreshContextChip?: boolean;
  // 存档已整体清空（clearAll）——caller 收起历史 popover
  historyCleared?: boolean;
  // 当前会话视图需按最新会话状态重建（applyById / 流式中删除当前会话 / clearAll）
  resetView?: boolean;
}

// 能力事件三：上下文补水提示生命周期。pending = 补水开始（applyById 载入旧会话）；
// clear = 一次补水尝试收尾（成功失败均发，与反转前 removeConversationContextNotice
// 的 5 个位点一致）；error = 补水失败的用户可见文案（silent 路径不发）。
export type ConversationContextNotice =
  | { kind: "pending"; message: string }
  | { kind: "clear" }
  | { kind: "error"; message: string };

export interface CreateConversationStoreDeps {
  // ---- 上下文获取（数据面，非渲染） ----
  // live 快照静默重取（hydratePinned 分支 2：targetKey === liveContextKey 时
  // 先刷新 live 快照再写入，ok=false 落回网络解析）。
  loadContextState: (opts: LoadContextStateOptions) => Promise<boolean | object>;
  // 会话引用解析单接缝（工单 05 合并原 resolveAiConversationContext /
  // resolveAiConversationPageRef 两个同形 dep）：purpose="context" 解析整份
  // 对话上下文（pinned 补水；组合根接工单 04 的进程内短路 + 网络复合适配器），
  // purpose="page" 解析分页信息（hydratePages 的会话分页补水）。
  resolveAiConversationRef: (
    contextRef: ConversationContextRef,
    purpose: "context" | "page"
  ) => Promise<Record<string, unknown>>;
  // ---- 能力事件（store 编排渲染时机；caller 只订阅结果） ----
  onConversationChanged: (change: ConversationChange) => void;
  onStreamInterrupted: () => void;
  onContextNotice: (notice: ConversationContextNotice) => void;
  // ---- 存储（可选；测试注入，缺省 chrome.storage.local） ----
  storage?: StorageArea;
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

// 本地窄视图（store 实际读写的字段形态）经断言对齐 chat-state 的宽类型：
// currentConversationMeta 的完整形态由 ConversationMeta 承载，宽侧只约束读写面。
const chatSessionState = _chatSessionState as ChatSessionState;

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

// 存档存储键与容量上限（工单 05 收窄：原 deps 可选键收进模块常量——唯一生产
// 宿主组合根传的正是这两个值，测试无一覆盖）。
const CONVERSATIONS_STORAGE_KEY = "boc_ai_conversations_v1";

export function createConversationStore(deps: CreateConversationStoreDeps): ConversationStore {
  // 工厂期校验（缺 dep 早失败；原为调用期 requireDep 逐点检查，单宿主下等价）
  for (const key of [
    "loadContextState",
    "resolveAiConversationRef",
    "onConversationChanged",
    "onStreamInterrupted",
    "onContextNotice"
  ] as const) {
    if (typeof deps[key] !== "function") {
      throw new Error(`createConversationStore: deps.${key} is required (must be a function)`);
    }
  }
  const { loadContextState, resolveAiConversationRef, onConversationChanged, onStreamInterrupted, onContextNotice } = deps;
  const storage = deps.storage || (typeof chrome !== "undefined" && chrome?.storage?.local) || undefined;
  const conversationsStorageKey = CONVERSATIONS_STORAGE_KEY;
  const maxSavedConversations = MAX_SAVED_CONVERSATIONS;

  // 能力事件出心：change 事件统一经此发出（detail 缺省 = 仅历史列表面）
  function emitChange(change: ConversationChange = {}): void {
    onConversationChanged(change);
  }

  function saved(): Conversation[] {
    return chatSessionState.savedConversations;
  }
  function commitSaved(next: Conversation[]): void {
    chatSessionState.savedConversations = next;
  }

  async function loadAll(): Promise<void> {
    const data = await storage
      ?.get([conversationsStorageKey])
      .catch(() => ({}) as Record<string, unknown>);
    commitSaved(_normalizeConversations(data?.[conversationsStorageKey]));
    emitChange({});
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
      let response: { ok?: boolean; payload?: unknown; error?: string } = { ok: false };
      try {
        const payload = await resolveAiConversationRef(contextRef, "page");
        response = { ok: true, payload };
      } catch (error: unknown) {
        response = { ok: false, error: (error as Error)?.message || String(error || "") };
      }
      if (!response.ok || !response.payload) {
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

    const currentId = chatSessionState.currentConversationId;
    if (currentId) {
      const activeConversation = conversations.find((item) => item.id === currentId);
      if (activeConversation) {
        chatSessionState.currentConversationMeta = {
          ...chatSessionState.currentConversationMeta,
          title: activeConversation.title,
          contextKey: activeConversation.contextKey,
          contextUrl: activeConversation.contextUrl,
          contextRef: activeConversation.contextRef
        } as ConversationMeta;
      }
    }
    emitChange({ refreshContextChip: true });
    await saveConversations();
  }

  async function saveConversations(): Promise<void> {
    await storage?.set({
      [conversationsStorageKey]: saved().slice(0, maxSavedConversations)
    });
    emitChange({});
  }

  async function restoreLatest(): Promise<boolean> {
    const targetContextKey = chatSessionState.liveContextKey || chatSessionState.currentContextKey;
    const currentRef = chatSessionState.liveContextData || chatSessionState.contextData;
    const conversations = saved();
    const latest = conversations.find((item) =>
      _doesConversationMatchCurrentContext(item, currentRef, targetContextKey)
    );
    if (!latest) {
      // 当前会话拆除：同步断流（先于下方状态清空与任何 await——流式身份守卫的
      // 承重时序，会话复活回归防线）。原编排此处不重渲列表/chip/视图。
      onStreamInterrupted();
      chatSessionState.currentConversationId = "";
      chatSessionState.currentConversationMeta = null;
      chatSessionState.chatHistory = [];
      return false;
    }
    apply(latest);
    return true;
  }

  // change 缺省仅声明 chip 刷新（apply 的上下文写入语义）；resetView 由
  // applyById 等会话重建入口追加。
  function apply(conversation: Conversation | null | undefined, change: ConversationChange = {}): void {
    if (!conversation) {
      return;
    }
    chatSessionState.currentConversationId = conversation.id;
    chatSessionState.currentConversationMeta = {
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
    chatSessionState.chatHistory = Array.isArray(conversation.messages)
      ? conversation.messages.map((item) => ({ role: item.role, content: String(item.content || "") }))
      : [];
    const liveData = chatSessionState.liveContextData;
    const liveKey = chatSessionState.liveContextKey;
    if (liveData && conversation.contextKey && conversation.contextKey === liveKey) {
      chatSessionState.contextData = { ...liveData };
      chatSessionState.currentContextKey = liveKey;
      chatSessionState.currentConversationMeta = {
        ...chatSessionState.currentConversationMeta,
        resolvedContext: { ...liveData }
      } as ConversationMeta;
    } else if (conversation.contextRef) {
      chatSessionState.contextData = _buildContextPlaceholder(conversation.contextRef);
      chatSessionState.currentContextKey = conversation.contextKey || _buildContextKey(chatSessionState.contextData);
    }
    emitChange({ refreshContextChip: true, ...change });
  }

  function applyById(id: string): void {
    const conversation = saved().find((item) => item.id === id);
    if (!conversation) {
      return;
    }
    // 单次 change 声明全部呈现面（反转前为 apply 的 chip+列表、随后的
    // renderInitialState 两段渲染；合成一次发火，次序 list→chip→reset 与
    // 原 chip→list→reset 的最终 DOM 一致——各面均为幂等状态投影）。
    apply(conversation, { resetView: true });
    if (conversation.contextKey && conversation.contextKey !== chatSessionState.liveContextKey) {
      onContextNotice({ kind: "pending", message: "正在加载原视频上下文..." });
      void hydratePinned({ silent: true });
    }
  }

  async function deleteById(id: string): Promise<void> {
    const wasCurrent = id && id === chatSessionState.currentConversationId;
    if (wasCurrent) {
      // 断流先于落盘（同步，见 restoreLatest 注记）
      onStreamInterrupted();
    }
    const next = saved().filter((item) => item.id !== id);
    commitSaved(next);
    await saveConversations();
    if (!wasCurrent) {
      return;
    }
    chatSessionState.currentConversationId = "";
    chatSessionState.currentConversationMeta = null;
    chatSessionState.chatHistory = [];
    const liveData = chatSessionState.liveContextData;
    if (liveData) {
      chatSessionState.contextData = { ...liveData };
      chatSessionState.currentContextKey = chatSessionState.liveContextKey || _buildContextKey(liveData);
    }
    emitChange({ refreshContextChip: true, resetView: true });
  }

  async function clearAll(): Promise<void> {
    if (!saved().length) {
      return;
    }
    if (!confirm("确定要清空全部历史对话吗？")) {
      return;
    }
    commitSaved([]);
    onStreamInterrupted();
    chatSessionState.currentConversationId = "";
    chatSessionState.currentConversationMeta = null;
    chatSessionState.chatHistory = [];
    await saveConversations();
    const liveData = chatSessionState.liveContextData;
    if (liveData) {
      chatSessionState.contextData = { ...liveData };
      chatSessionState.currentContextKey = chatSessionState.liveContextKey || _buildContextKey(liveData);
    }
    // 原编排：save 后收起 popover → live 回填 + chip → renderInitialState；
    // 合成一次发火（历史列表已随 save 的 change 重渲，此处各面幂等）。
    emitChange({ refreshContextChip: true, historyCleared: true, resetView: true });
  }

  function isCurrent(id: string): boolean {
    return id === chatSessionState.currentConversationId;
  }

  async function persistCurrent(): Promise<void> {
    const chat = chatSessionState.chatHistory;
    const context = chatSessionState.contextData;
    if (!chat.length || !context) {
      return;
    }
    const now = Date.now();
    let currentId = chatSessionState.currentConversationId;
    let meta = chatSessionState.currentConversationMeta;
    if (!currentId) {
      currentId = _generateConversationId();
      chatSessionState.currentConversationId = currentId;
      meta = {
        id: currentId,
        title: _buildConversationTitle(context),
        createdAt: now,
        updatedAt: now,
        contextKey: chatSessionState.currentContextKey,
        contextTitle: String(context.title || "").trim(),
        contextUrl: String(context.url || "").trim(),
        isVideoContext: context.isVideoContext !== false,
        pinnedContext: true,
        contextRef: _buildAiContextRef(context),
        resolvedContext: { ...context }
      };
      chatSessionState.currentConversationMeta = meta;
    }
    const nextConversation: Conversation = {
      id: currentId,
      title: meta?.title || _buildConversationTitle(context),
      contextKey: String(meta?.contextKey || chatSessionState.currentContextKey || "").trim(),
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
    chatSessionState.currentConversationMeta = {
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
    let meta = chatSessionState.currentConversationMeta;
    const targetKey = String(meta?.contextKey || "").trim();
    const cachedResolvedContext = meta?.resolvedContext;
    if (cachedResolvedContext && typeof cachedResolvedContext === "object") {
      chatSessionState.contextData = { ...cachedResolvedContext };
      chatSessionState.currentContextKey = targetKey || _buildContextKey(chatSessionState.contextData);
      emitChange({ refreshContextChip: true });
      onContextNotice({ kind: "clear" });
      return true;
    }

    if (targetKey && chatSessionState.liveContextKey && targetKey === chatSessionState.liveContextKey) {
      const ok = await loadContextState({ forceRefresh: false, silent: true });
      const context = chatSessionState.contextData;
      if (ok && context) {
        chatSessionState.currentContextKey = targetKey;
        meta = chatSessionState.currentConversationMeta;
        chatSessionState.currentConversationMeta = {
          ...meta,
          resolvedContext: { ...context }
        } as ConversationMeta;
        emitChange({ refreshContextChip: true });
        onContextNotice({ kind: "clear" });
        return true;
      }
    }

    const contextRef = chatSessionState.currentConversationMeta?.contextRef || null;
    if (!contextRef) {
      onContextNotice({ kind: "clear" });
      if (!silent) {
        onContextNotice({ kind: "error", message: "历史对话缺少原视频信息，无法继续。" });
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
      onContextNotice({ kind: "clear" });
      if (!silent) {
        onContextNotice({ kind: "error", message: `历史视频上下文获取失败：${response?.error || "未知错误"}` });
      }
      return false;
    }

    const resolved = response.payload as Record<string, unknown>;
    chatSessionState.contextData = resolved;
    chatSessionState.currentContextKey = targetKey || _buildContextKey(resolved);
    meta = chatSessionState.currentConversationMeta;
    chatSessionState.currentConversationMeta = {
      ...meta,
      contextKey: chatSessionState.currentContextKey,
      contextTitle: String(resolved.title || meta?.contextTitle || "").trim(),
      contextUrl: String(resolved.url || meta?.contextUrl || "").trim(),
      contextRef: _buildAiContextRef(resolved),
      resolvedContext: { ...resolved }
    } as ConversationMeta;
    emitChange({ refreshContextChip: true });
    onContextNotice({ kind: "clear" });
    return true;
  }

  async function resolveContext(
    contextRef: ConversationContextRef
  ): Promise<{ ok?: boolean; payload?: unknown; error?: string }> {
    try {
      const payload = await resolveAiConversationRef(contextRef, "context");
      return { ok: true, payload };
    } catch (error: unknown) {
      return { ok: false, error: (error as Error)?.message || String(error || "") };
    }
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
