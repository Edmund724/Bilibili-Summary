// sidepanel-conversation-store.js
// 会话持久化 + 上下文绑定关注点（sidepanel-split ticket #05）。
//
// 本模块从 extension/pages/sidepanel.js 抽出「会话列表的存取、按视频上下文
// 绑定/恢复、增删改」这条关注点。会话状态本体（savedConversations /
// currentConversationId / currentConversationMeta / chatHistory / contextData /
// currentContextKey / liveContextData / liveContextKey）收拢在
// ./sidepanel-state.js 的 sidepanelState，本模块直接 import 读写（后续收拢：
// 原 deps 里的 14 个状态 getter/setter 访问器已删）；deps 只剩 UI/transport
// 回调、storage 抽象与常量。
//
// 纯函数（`needsConversationPageHydration`）直接 export，可在无 store 实例时测试。
// 工厂返回的窄接口仅暴露 sidepanel 真正调用的方法。
//
// 依赖方向（无环）：
//   sidepanel-conversation-store.js → ../ai/conversation.js（纯函数）
//   sidepanel-conversation-store.js → ./sidepanel-state.js（共享可变状态叶子）
// sidepanel.js 不在本模块的 import 图中。

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
import { sidepanelState } from "./sidepanel-state.js";

// ---------------------------------------------------------------------------
// 纯函数（直接 export，无需 store 实例即可测试）
// ---------------------------------------------------------------------------

/**
 * 判断一条历史会话是否需要「页面元信息补水」。
 *
 * 规则（与原 sidepanel 行为一致，逐字搬迁）：
 *   - 非视频上下文 → false
 *   - 标题以 `-P\d+` 结尾（已带分页后缀）→ false
 *   - contextRef.pageIndex > 1 → true
 *   - contextUrl 里解析出的 pageIndex > 1 → true
 *   - 否则当 contextRef 同时有 bvid+cid → true（需补全分页/标题）
 *
 * @param {object|null|undefined} conversation
 * @returns {boolean}
 */
export function needsConversationPageHydration(conversation) {
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
  const urlPageIndex = extractPageIndexFromUrl(conversation.contextUrl || conversation.contextRef?.url || "");
  if (urlPageIndex > 1) {
    return true;
  }
  return Boolean(conversation.contextRef?.bvid && conversation.contextRef?.cid);
}

// ---------------------------------------------------------------------------
// 工厂：createConversationStore(deps)
// ---------------------------------------------------------------------------

/**
 * 创建一个对话存储编排器。会话状态直接读写 sidepanelState（./sidepanel-state.js），
 * deps 只注入 UI/transport 回调、storage 抽象与常量；store 自身不持有可变状态。
 *
 * deps 形状（UI/transport 回调，由 sidepanel 在构造时绑定）：
 *   renderHistoryList, renderInitialState, updateContextChip
 *   showConversationContextNotice(message, autoHideMs?)
 *   showConversationContextError(message)
 *   removeConversationContextNotice()
 *   hideHistoryPopover()
 *   loadContextState({ forceRefresh?, silent? }) → Promise<boolean|object>
 *   getActiveTab() → Promise<object|null>
 *   sendRuntimeMessage(message, opts?) → Promise<object>
 *   stopActiveChat() → void
 *     流式中删除当前会话 / 清空全部 / restoreLatest 无匹配时，由本模块同步调用：
 *     sidepanel 组装为实现 chatRuntime.resetStreamState() + 清消息区的纯回调
 *     （store 不直接 import chatRuntime，依赖方向由 sidepanel 组装）。回调必须
 *     幂等——restoreLatest 无匹配发生在 init/上下文切换时，流必然未启动。
 *   存储抽象（默认 chrome.storage.local）：
 *     storage = { get(keys) → Promise<object>, set(obj) → Promise<void> }
 *   常量（与 sidepanel 原局部常量保持一致）：
 *     conversationsStorageKey  默认 "boc_ai_conversations_v1"
 *     maxSavedConversations    默认 60
 *
 * 返回窄接口（仅 sidepanel 真正调用的方法，命名已文档化）：
 *   {
 *     loadAll,                  // → loadSavedConversations
 *     hydratePages,            // → hydrateConversationPageMetadata
 *     isCurrent(id),           // → 会话身份守卫（见下方 isCurrent 注释）
 *     persistCurrent,          // → persistCurrentConversation
 *     applyById,               // → loadConversationById
 *     apply(conversation),     // → applyConversation（内部也被 load/restore 复用）
 *     deleteById,              // → deleteConversation
 *     clearAll,                // → clearAllConversations
 *     restoreLatest,           // → restoreLatestConversationForCurrentContext
 *     resolveContext(ref),     // → resolveConversationContext
 *     hydratePinned(opts),     // → hydratePinnedConversationContext
 *   }
 *
 * @param {object} deps
 * @returns {object} 窄接口
 */
export function createConversationStore(deps) {
  // 解构全部依赖，缺省取合理默认（storage 默认 chrome.storage.local，常量默认与
  // sidepanel 原局部常量一致）。任何未提供的回调在使用时会抛出明确错误，
  // 避免静默调用 undefined。
  const {
    // UI/transport 回调
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
    // 存储抽象 + 常量
    storage = (typeof chrome !== "undefined" && chrome?.storage?.local) || undefined,
    conversationsStorageKey = "boc_ai_conversations_v1",
    maxSavedConversations = MAX_SAVED_CONVERSATIONS
  } = deps;

  // 简单的守卫：调用方漏绑某个依赖时给出明确报错，而不是隐式读到 undefined。
  function requireDep(name, value) {
    if (typeof value !== "function" && (name !== "storage")) {
      throw new Error(`createConversationStore: deps.${name} is required (must be a function)`);
    }
    return value;
  }

  // ---- 读取/写入会话状态的薄封装（状态本体在 sidepanelState） ----
  function saved() {
    return sidepanelState.savedConversations;
  }
  function commitSaved(next) {
    sidepanelState.savedConversations = next;
  }

  // ===========================================================================
  // loadSavedConversations
  // ===========================================================================
  async function loadAll() {
    const data = await requireDep("storage", storage)
      .get([conversationsStorageKey])
      .catch(() => ({}));
    commitSaved(normalizeConversations(data?.[conversationsStorageKey]));
    requireDep("renderHistoryList", renderHistoryList)();
    void hydratePages();
  }

  // ===========================================================================
  // hydrateConversationPageMetadata
  // ===========================================================================
  async function hydratePages() {
    const conversations = saved();
    const candidates = conversations
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
      const response = await requireDep("sendRuntimeMessage", sendRuntimeMessage)({
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
        };
      }
    }
    requireDep("renderHistoryList", renderHistoryList)();
    requireDep("updateContextChip", updateContextChip)();
    await saveConversations();
  }

  // ===========================================================================
  // saveConversations（内部辅助，被多处复用；不单独暴露给 sidepanel）
  // ===========================================================================
  async function saveConversations() {
    const normalized = normalizeConversations(saved());
    commitSaved(normalized);
    await requireDep("storage", storage).set({
      [conversationsStorageKey]: normalized.slice(0, maxSavedConversations)
    });
    requireDep("renderHistoryList", renderHistoryList)();
  }

  // ===========================================================================
  // restoreLatestConversationForCurrentContext
  // ===========================================================================
  async function restoreLatest() {
    const targetContextKey = sidepanelState.liveContextKey || sidepanelState.currentContextKey;
    const currentRef = sidepanelState.liveContextData || sidepanelState.contextData;
    const conversations = saved();
    const latest = conversations.find((item) => doesConversationMatchCurrentContext(item, currentRef, targetContextKey));
    if (!latest) {
      // 无匹配 → 当前会话状态清空。先同步停流（init/上下文切换时流必然未启动，
      // 回调幂等），避免任何在途流把问答写回即将清空的会话。
      requireDep("stopActiveChat", stopActiveChat)();
      sidepanelState.currentConversationId = "";
      sidepanelState.currentConversationMeta = null;
      sidepanelState.chatHistory = [];
      return false;
    }
    apply(latest);
    return true;
  }

  // ===========================================================================
  // applyConversation（公开为 apply；也被 restoreLatest/loadById 复用）
  // ===========================================================================
  function apply(conversation) {
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
    sidepanelState.chatHistory =
      Array.isArray(conversation.messages)
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
      };
    } else if (conversation.contextRef) {
      sidepanelState.contextData = buildContextPlaceholder(conversation.contextRef);
      sidepanelState.currentContextKey = conversation.contextKey || buildContextKey(sidepanelState.contextData);
    }
    requireDep("updateContextChip", updateContextChip)();
    requireDep("renderHistoryList", renderHistoryList)();
  }

  // ===========================================================================
  // loadConversationById
  // ===========================================================================
  function applyById(id) {
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

  // ===========================================================================
  // deleteConversation
  // ===========================================================================
  async function deleteById(id) {
    const wasCurrent = id && id === sidepanelState.currentConversationId;
    if (wasCurrent) {
      // 流式中删除当前会话：在所有 await 之前同步停流（断 port、清在途一问一答、
      // 清消息区）。若放到下方 await saveConversations() 之后，done 消息可能在
      // 间隙里把在途问答 push 回刚清空的 chatHistory 并 persistCurrent——
      // 凭空复活出会话。非流式时回调为无害空操作（幂等）。
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
      sidepanelState.currentContextKey = sidepanelState.liveContextKey || buildContextKey(liveData);
      requireDep("updateContextChip", updateContextChip)();
    }
    requireDep("renderInitialState", renderInitialState)();
  }

  // ===========================================================================
  // clearAllConversations
  // ===========================================================================
  async function clearAll() {
    if (!saved().length) {
      return;
    }
    if (!confirm("确定要清空全部历史对话吗？")) {
      return;
    }
    commitSaved([]);
    // 清空全部同样先同步停流再清当前会话状态（理由同 deleteById；清空语义下
    // 在途问答也不应复活）。
    requireDep("stopActiveChat", stopActiveChat)();
    sidepanelState.currentConversationId = "";
    sidepanelState.currentConversationMeta = null;
    sidepanelState.chatHistory = [];
    await saveConversations();
    requireDep("hideHistoryPopover", hideHistoryPopover)();
    const liveData = sidepanelState.liveContextData;
    if (liveData) {
      sidepanelState.contextData = { ...liveData };
      sidepanelState.currentContextKey = sidepanelState.liveContextKey || buildContextKey(liveData);
      requireDep("updateContextChip", updateContextChip)();
    }
    requireDep("renderInitialState", renderInitialState)();
  }

  // ===========================================================================
  // isCurrent — 会话身份守卫的单一判定点
  // ===========================================================================
  // 判定「id 是否仍是发起流式时的当前会话」：与 sidepanelState.currentConversationId
  // 严格相等。语义与旧 chat-runtime 内联比对（currentConversationId === 快照）逐
  // 字等价，包括空 id：新会话首发时快照与当前 id 均为空串 → true（照常写回并
  // persistCurrent，由 persistCurrent 现场生成会话 id）；快照为空而当前 id 非空
  // （流式中切换/恢复了会话）→ false，不写回。会话删除/清空/切换后当前 id 已变
  // 或已清 → false，拦截在途问答复活会话。
  function isCurrent(id) {
    return id === sidepanelState.currentConversationId;
  }

  // ===========================================================================
  // persistCurrentConversation
  // ===========================================================================
  async function persistCurrent() {
    const chat = sidepanelState.chatHistory;
    const context = sidepanelState.contextData;
    if (!chat.length || !context) {
      return;
    }
    const now = Date.now();
    let currentId = sidepanelState.currentConversationId;
    let meta = sidepanelState.currentConversationMeta;
    if (!currentId) {
      currentId = generateConversationId();
      sidepanelState.currentConversationId = currentId;
      meta = {
        id: currentId,
        title: buildConversationTitle(context),
        createdAt: now,
        contextKey: sidepanelState.currentContextKey,
        contextTitle: String(context.title || "").trim(),
        contextUrl: String(context.url || "").trim(),
        isVideoContext: context.isVideoContext !== false,
        pinnedContext: true,
        contextRef: buildAiContextRef(context),
        resolvedContext: { ...context }
      };
      sidepanelState.currentConversationMeta = meta;
    }
    const nextConversation = {
      id: currentId,
      title: meta?.title || buildConversationTitle(context),
      contextKey: String(meta?.contextKey || sidepanelState.currentContextKey || "").trim(),
      contextTitle: String(meta?.contextTitle || context.title || "").trim(),
      contextUrl: String(meta?.contextUrl || context.url || "").trim(),
      isVideoContext: meta?.isVideoContext !== false,
      createdAt: Number(meta?.createdAt) || now,
      updatedAt: now,
      contextRef: meta?.contextRef || buildAiContextRef(context),
      messages: chat.map((item) => ({ role: item.role, content: String(item.content || "") }))
    };
    const filtered = saved().filter((item) => item.id !== currentId);
    commitSaved([nextConversation, ...filtered]);
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

  // ===========================================================================
  // hydratePinnedConversationContext
  // ===========================================================================
  async function hydratePinned({ silent = false } = {}) {
    let meta = sidepanelState.currentConversationMeta;
    const targetKey = String(meta?.contextKey || "").trim();
    const cachedResolvedContext = meta?.resolvedContext;
    if (cachedResolvedContext && typeof cachedResolvedContext === "object") {
      sidepanelState.contextData = { ...cachedResolvedContext };
      sidepanelState.currentContextKey = targetKey || buildContextKey(sidepanelState.contextData);
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
        };
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

    const response = await resolveContext(contextRef).catch((error) => ({
      ok: false,
      error: error?.message || String(error || "")
    }));
    if (!response?.ok || !response.payload) {
      requireDep("removeConversationContextNotice", removeConversationContextNotice)();
      if (!silent) {
        requireDep("showConversationContextError", showConversationContextError)(`历史视频上下文获取失败：${response?.error || "未知错误"}`);
      }
      return false;
    }

    const resolved = response.payload;
    sidepanelState.contextData = resolved;
    sidepanelState.currentContextKey = targetKey || buildContextKey(resolved);
    meta = sidepanelState.currentConversationMeta;
    sidepanelState.currentConversationMeta = {
      ...meta,
      contextKey: sidepanelState.currentContextKey,
      contextTitle: String(resolved.title || meta?.contextTitle || "").trim(),
      contextUrl: String(resolved.url || meta?.contextUrl || "").trim(),
      contextRef: buildAiContextRef(resolved),
      resolvedContext: { ...resolved }
    };
    requireDep("updateContextChip", updateContextChip)();
    requireDep("removeConversationContextNotice", removeConversationContextNotice)();
    return true;
  }

  // ===========================================================================
  // resolveConversationContext
  // ===========================================================================
  async function resolveContext(contextRef) {
    const tab = await requireDep("getActiveTab", getActiveTab)().catch(() => null);
    return requireDep("sendRuntimeMessage", sendRuntimeMessage)({
      type: "ai-sidepanel-resolve-context",
      tabId: Number(tab?.id || 0) || 0,
      contextRef
    });
  }

  // ---- 窄公开接口 ----
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
