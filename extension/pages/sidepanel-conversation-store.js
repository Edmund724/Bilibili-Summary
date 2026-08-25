// sidepanel-conversation-store.js
// 会话持久化 + 上下文绑定关注点（sidepanel-split ticket #05）。
//
// 本模块从 extension/pages/sidepanel.js 抽出「会话列表的存取、按视频上下文
// 绑定/恢复、增删改」这条关注点。它通过 `createConversationStore(deps)` 工厂
// 接收全部所需状态访问与副作用回调，从而**绝不直接读取** sidepanel 的模块级
// 全局（`currentConversationMeta`/`contextData`/`chatHistory`/`savedConversations`
// /`currentConversationId`/`currentContextKey`/`liveContextData`/`liveContextKey`）。
// 所有状态都经由 deps 的 getter/setter 注入；UI/transport 副作用也经由回调注入。
//
// 纯函数（`needsConversationPageHydration`）直接 export，可在无 store 实例时测试。
// 工厂返回的窄接口仅暴露 sidepanel 真正调用的方法。
//
// 依赖方向（无环）：
//   sidepanel-conversation-store.js → ../ai/conversation.js（纯函数）
// sidepanel.js 不在本模块的 import 图中。

import {
  buildContextKey,
  buildConversationContextRef,
  buildContextPlaceholder,
  buildConversationTitle,
  generateConversationId,
  normalizeConversations,
  resolveConversationStorageKey,
  normalizeConversationTitle,
  doesConversationMatchCurrentContext,
  extractPageIndexFromContextUrl
} from "../ai/conversation.js";

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
  const urlPageIndex = extractPageIndexFromContextUrl(conversation.contextUrl || conversation.contextRef?.url || "");
  if (urlPageIndex > 1) {
    return true;
  }
  return Boolean(conversation.contextRef?.bvid && conversation.contextRef?.cid);
}

// ---------------------------------------------------------------------------
// 工厂：createConversationStore(deps)
// ---------------------------------------------------------------------------

/**
 * 创建一个对话存储编排器。所有状态访问/副作用通过 deps 注入，store 自身
 * 不持有任何可变状态，也不读取任何 sidepanel 模块级全局。
 *
 * deps 形状（全部必填，由 sidepanel 在构造时绑定）：
 *   状态 getter/setter（映射 sidepanel 的 8 个模块级变量）：
 *     getSavedConversations, setSavedConversations
 *     getCurrentConversationId, setCurrentConversationId
 *     getCurrentConversationMeta, setCurrentConversationMeta
 *     getChatHistory, setChatHistory
 *     getContextData, setContextData
 *     getCurrentContextKey, setCurrentContextKey
 *     getLiveContextData, getLiveContextKey
 *   UI/transport 回调（留在 sidepanel，DOM 渲染不进 store）：
 *     renderHistoryList, renderInitialState, updateContextChip
 *     showConversationContextNotice(message, autoHideMs?)
 *     showConversationContextError(message)
 *     removeConversationContextNotice()
 *     hideHistoryPopover()
 *     loadContextState({ forceRefresh?, silent? }) → Promise<boolean|object>
 *     getActiveTab() → Promise<object|null>
 *     sendRuntimeMessage(message, opts?) → Promise<object>
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
  // sidepanel 原局部常量一致）。任何未提供的 getter/setter/回调在使用时会抛出
  // 明确错误，避免静默读取 sidepanel 全局。
  const {
    // 状态 getter/setter
    getSavedConversations,
    setSavedConversations,
    getCurrentConversationId,
    setCurrentConversationId,
    getCurrentConversationMeta,
    setCurrentConversationMeta,
    getChatHistory,
    setChatHistory,
    getContextData,
    setContextData,
    getCurrentContextKey,
    setCurrentContextKey,
    getLiveContextData,
    getLiveContextKey,
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
    // 存储抽象 + 常量
    storage = (typeof chrome !== "undefined" && chrome?.storage?.local) || undefined,
    conversationsStorageKey = "boc_ai_conversations_v1",
    maxSavedConversations = 60
  } = deps;

  // 简单的守卫：调用方漏绑某个依赖时给出明确报错，而不是隐式读到 undefined。
  function requireDep(name, value) {
    if (typeof value !== "function" && (name !== "storage")) {
      throw new Error(`createConversationStore: deps.${name} is required (must be a function)`);
    }
    return value;
  }

  // ---- 读取/写入状态的薄封装（语义与 sidepanel 原直读全局一致） ----
  function saved() {
    return getSavedConversations();
  }
  function commitSaved(next) {
    setSavedConversations(next);
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

    const currentId = getCurrentConversationId();
    if (currentId) {
      const activeConversation = conversations.find((item) => item.id === currentId);
      if (activeConversation) {
        setCurrentConversationMeta({
          ...getCurrentConversationMeta(),
          title: activeConversation.title,
          contextKey: activeConversation.contextKey,
          contextUrl: activeConversation.contextUrl,
          contextRef: activeConversation.contextRef
        });
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
    const targetContextKey = getLiveContextKey() || getCurrentContextKey();
    const currentRef = getLiveContextData() || getContextData();
    const conversations = saved();
    const latest = conversations.find((item) => doesConversationMatchCurrentContext(item, currentRef, targetContextKey));
    if (!latest) {
      setCurrentConversationId("");
      setCurrentConversationMeta(null);
      setChatHistory([]);
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
    setCurrentConversationId(conversation.id);
    setCurrentConversationMeta({
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
    });
    setChatHistory(
      Array.isArray(conversation.messages)
        ? conversation.messages.map((item) => ({ role: item.role, content: String(item.content || "") }))
        : []
    );
    const liveData = getLiveContextData();
    const liveKey = getLiveContextKey();
    if (liveData && conversation.contextKey && conversation.contextKey === liveKey) {
      setContextData({ ...liveData });
      setCurrentContextKey(liveKey);
      setCurrentConversationMeta({
        ...getCurrentConversationMeta(),
        resolvedContext: { ...liveData }
      });
    } else if (conversation.contextRef) {
      setContextData(buildContextPlaceholder(conversation.contextRef));
      setCurrentContextKey(conversation.contextKey || buildContextKey(getContextData()));
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
    if (conversation.contextKey && conversation.contextKey !== getLiveContextKey()) {
      requireDep("showConversationContextNotice", showConversationContextNotice)("正在加载原视频上下文...");
      void hydratePinned({ silent: true });
    }
  }

  // ===========================================================================
  // deleteConversation
  // ===========================================================================
  async function deleteById(id) {
    const wasCurrent = id && id === getCurrentConversationId();
    const next = saved().filter((item) => item.id !== id);
    commitSaved(next);
    await saveConversations();
    if (!wasCurrent) {
      return;
    }
    setCurrentConversationId("");
    setCurrentConversationMeta(null);
    setChatHistory([]);
    const liveData = getLiveContextData();
    if (liveData) {
      setContextData({ ...liveData });
      setCurrentContextKey(getLiveContextKey() || buildContextKey(liveData));
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
    setCurrentConversationId("");
    setCurrentConversationMeta(null);
    setChatHistory([]);
    await saveConversations();
    requireDep("hideHistoryPopover", hideHistoryPopover)();
    const liveData = getLiveContextData();
    if (liveData) {
      setContextData({ ...liveData });
      setCurrentContextKey(getLiveContextKey() || buildContextKey(liveData));
      requireDep("updateContextChip", updateContextChip)();
    }
    requireDep("renderInitialState", renderInitialState)();
  }

  // ===========================================================================
  // persistCurrentConversation
  // ===========================================================================
  async function persistCurrent() {
    const chat = getChatHistory();
    const context = getContextData();
    if (!chat.length || !context) {
      return;
    }
    const now = Date.now();
    let currentId = getCurrentConversationId();
    let meta = getCurrentConversationMeta();
    if (!currentId) {
      currentId = generateConversationId();
      setCurrentConversationId(currentId);
      meta = {
        id: currentId,
        title: buildConversationTitle(context),
        createdAt: now,
        contextKey: getCurrentContextKey(),
        contextTitle: String(context.title || "").trim(),
        contextUrl: String(context.url || "").trim(),
        isVideoContext: context.isVideoContext !== false,
        pinnedContext: true,
        contextRef: buildConversationContextRef(context),
        resolvedContext: { ...context }
      };
      setCurrentConversationMeta(meta);
    }
    const nextConversation = {
      id: currentId,
      title: meta?.title || buildConversationTitle(context),
      contextKey: String(meta?.contextKey || getCurrentContextKey() || "").trim(),
      contextTitle: String(meta?.contextTitle || context.title || "").trim(),
      contextUrl: String(meta?.contextUrl || context.url || "").trim(),
      isVideoContext: meta?.isVideoContext !== false,
      createdAt: Number(meta?.createdAt) || now,
      updatedAt: now,
      contextRef: meta?.contextRef || buildConversationContextRef(context),
      messages: chat.map((item) => ({ role: item.role, content: String(item.content || "") }))
    };
    const filtered = saved().filter((item) => item.id !== currentId);
    commitSaved([nextConversation, ...filtered]);
    setCurrentConversationMeta({
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
    });
    await saveConversations();
  }

  // ===========================================================================
  // hydratePinnedConversationContext
  // ===========================================================================
  async function hydratePinned({ silent = false } = {}) {
    let meta = getCurrentConversationMeta();
    const targetKey = String(meta?.contextKey || "").trim();
    const cachedResolvedContext = meta?.resolvedContext;
    if (cachedResolvedContext && typeof cachedResolvedContext === "object") {
      setContextData({ ...cachedResolvedContext });
      setCurrentContextKey(targetKey || buildContextKey(getContextData()));
      requireDep("updateContextChip", updateContextChip)();
      requireDep("removeConversationContextNotice", removeConversationContextNotice)();
      return true;
    }

    if (targetKey && getLiveContextKey() && targetKey === getLiveContextKey()) {
      const ok = await requireDep("loadContextState", loadContextState)({ forceRefresh: false, silent: true });
      const context = getContextData();
      if (ok && context) {
        setCurrentContextKey(targetKey);
        meta = getCurrentConversationMeta();
        setCurrentConversationMeta({
          ...meta,
          resolvedContext: { ...context }
        });
        requireDep("updateContextChip", updateContextChip)();
        requireDep("removeConversationContextNotice", removeConversationContextNotice)();
        return true;
      }
    }

    const contextRef = getCurrentConversationMeta()?.contextRef || null;
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
    setContextData(resolved);
    setCurrentContextKey(targetKey || buildContextKey(resolved));
    meta = getCurrentConversationMeta();
    setCurrentConversationMeta({
      ...meta,
      contextKey: getCurrentContextKey(),
      contextTitle: String(resolved.title || meta?.contextTitle || "").trim(),
      contextUrl: String(resolved.url || meta?.contextUrl || "").trim(),
      contextRef: buildConversationContextRef(resolved),
      resolvedContext: { ...resolved }
    });
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
