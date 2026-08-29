// sidepanel-chat-runtime.js — chat + stream state machine orchestration layer
// extracted out of extension/pages/sidepanel.js (ticket 07 of sidepanel-split).
//
// Responsibility: orchestrate "send message → stream receive → render assistant
// tokens → stop/error handling". It owns the stream runtime state
// (activePort / activeAssistantNode / activeUserPrompt / thinkingNode /
// streamSlowNoticeTimer / streamFirstTokenReceived), performs the DOM node
// operations for the live chat message area (.sp-msg-* nodes, scrolling), and
// delegates persistence (conversation-store, injected via deps) and markdown
// rendering (../ui/markdown.js, pulled in directly).
//
// Boundary: this module does NOT touch sidepanel module-level layout variables
// or the surrounding chrome (header/popovers/context chip). Everything it needs
// — layout callback, context notices, AI-domain helpers, DOM container
// references, input/stop-button element refs — arrives via the `deps` object of
// the `createChatRuntime(deps)` factory, or is read out of module-level state
// owned by this module itself.
//
// Top-level side effects: NONE (no document/chrome/window access at module
// scope) — unlike sidepanel.js, this module evaluates cleanly under a Node test
// harness without a DOM shim.
import { renderMarkdown, stripThinkBlocks } from "../ui/markdown.js";
import { linkifyAssistantTimestamps } from "../ui/timestamp-nav.js";

const STREAM_SLOW_NOTICE_MS = 15000;

/**
 * createChatRuntime(deps) — factory returning the chat runtime method set.
 *
 * The runtime owns the stream state machine; sidepanel keeps its own
 * module-level state (chatHistory / conversation meta / context / providers /
 * aiPrefs / suggestionsNode / shouldAutoScrollMessages) and injects accessors
 * plus UI callbacks via deps. The returned methods are bound closures over the
 * runtime's own closure state, so multiple factories would be isolated —
 * sidepanel constructs exactly one.
 *
 * @param {object} deps  every dependency, each sourced out of sidepanel's own
 *   module-level scope at factory-construction time:
 *   {
 *     // ---- DOM container / element refs (sidepanel module-level `els`) ----
 *     messages,        // els.messages  (messages scroll container)
 *     input,           // els.input
 *     stopBtn,         // els.stopBtn (optional)
 *     // ---- conversation-store narrow interface (ticket 05) ----
 *     store,           // conversationStore instance: { persistCurrent() }
 *     // ---- conversation state accessors (sidepanel module-level vars) ----
 *     getChatHistory,              // () => chatHistory
 *     getCurrentConversationMeta,  // () => currentConversationMeta
 *     setCurrentConversationMeta,  // (v) => { currentConversationMeta = v; }
 *     getCurrentContextKey,        // () => currentContextKey
 *     setCurrentConversationId,    // (v) => { currentConversationId = v; }
 *     getContextData,              // () => contextData
 *     getAiPrefs,                  // () => aiPrefs  (for aiSystemPrompt)
 *     getThinkingLevel,            // () => aiThinkingLevel  (off/low/high)
 *     // ---- layout / UI sidepanel callbacks (DOM layout stays in sidepanel) ----
 *     setStreamingUiState,               // (isStreaming, { stopping }) => void
 *     showConversationContextNotice,     // (message, autoHideMs) => void
 *     removeConversationContextNotice,   // () => void
 *     hidePresetPopover,                 // () => void
 *     hideHistoryPopover,                // () => void
 *     removeCenteredState,               // () => void
 *     removeSuggestions,                 // () => void  (removes + nulls suggestionsNode)
 *     resetConversationView,             // (stateHtml) => void
 *     autosizeInput,                     // () => void
 *     shouldAutoScrollMessagesEnabled,   // () => boolean (shouldAutoScrollMessages)
 *     setShouldAutoScrollMessages,       // (v) => void
 *     // ---- context/transport helpers (AI domain, sidepanel local) ----
 *     ensureCurrentContextForSend,       // () => Promise<boolean>
 *     getProviderId,                     // () => els.modelSelect.value
 *     getTimestampNavDeps,               // () => timestamp-nav deps object
 *     normalizeMarkdownForSectionPaste,  // (raw, baseLevel) => string
 *     connectPort,                       // () => Promise<chrome.runtime.Port> (name "offscreen-chat"; 先 ensure offscreen 文档)
 *   }
 *
 * @returns {object} method set (all closures; state only via the runtime's own
 *   closure variables — sidepanel queries it with isStreaming() /
 *   hasPendingUserPrompt(), never by reading runtime internals):
 *   {
 *     sendMessage,                 // () => Promise<void>
 *     stopActiveStream,            // () => void
 *     handleFirstStreamToken,      // () => void
 *     clearStreamRuntimeState,     // () => void
 *     startStreamSlowNoticeTimer,  // () => void
 *     appendAssistantPlaceholder,  // () => HTMLElement
 *     appendToken,                 // (node, token) => void
 *     finalizeAssistant,           // (node) => void
 *     handleAssistantStopped,      // (node, reason) => void
 *     showAssistantError,          // (node, error) => void
 *     renderAssistantMessage,      // (node, raw, { userPrompt }) => void
 *     appendUserMessage,           // (text, shouldScroll) => void
 *     createThinkingNode,          // (assistantNode) => HTMLElement|null
 *     appendThinkingText,          // (node, text) => void
 *     // ---- stream state queries / reset (sidepanel reads runtime state) ----
 *     isStreaming,                 // () => boolean   (activePort !== null)
 *     hasPendingUserPrompt,        // () => boolean   (activeUserPrompt !== "")
 *     resetStreamState,            // () => void  (clear + disconnect + null state)
 *   }
 */
export function createChatRuntime(deps) {
  // ---- stream runtime state (closure-local) ----
  let activePort = null;
  let activeAssistantNode = null;
  let activeUserPrompt = "";
  let thinkingNode = null;
  let streamSlowNoticeTimer = 0;
  let streamFirstTokenReceived = false;

  // ---- internal helpers (sidepanel-local utilities the chat flow needs) ----
  function chatHistory() {
    return deps.getChatHistory();
  }

  function setStreamingUiState(isStreaming, { stopping = false } = {}) {
    deps.setStreamingUiState(isStreaming, { stopping });
  }

  function shouldAutoScrollMessages() {
    return deps.shouldAutoScrollMessagesEnabled();
  }

  function setShouldAutoScrollMessages(value) {
    deps.setShouldAutoScrollMessages(value);
  }

  function scrollToBottom(force = false) {
    if (!force && !shouldAutoScrollMessages()) {
      return;
    }
    deps.messages.scrollTop = deps.messages.scrollHeight;
  }

  // =========================================================================
  // sendMessage — entry point of the chat flow
  // =========================================================================
  async function sendMessage() {
    const text = deps.input.value.trim();
    if (!text || activePort) {
      return;
    }
    deps.hidePresetPopover();
    deps.hideHistoryPopover();

    const providerId = deps.getProviderId();
    if (!providerId) {
      deps.resetConversationView("请先在设置页配置并启用一个 AI 平台。");
      return;
    }

    const hasContext = await deps.ensureCurrentContextForSend();
    if (!hasContext) {
      return;
    }
    const currentMeta = deps.getCurrentConversationMeta();
    if (!currentMeta?.pinnedContext && currentMeta?.contextKey && currentMeta.contextKey !== deps.getCurrentContextKey()) {
      deps.setCurrentConversationId("");
      deps.setCurrentConversationMeta(null);
    }

    deps.removeCenteredState();
    deps.removeSuggestions();

    appendUserMessage(text);
    deps.input.value = "";
    deps.autosizeInput();
    setStreamingUiState(true);
    activeUserPrompt = text;
    activeAssistantNode = appendAssistantPlaceholder();
    startStreamSlowNoticeTimer();
    streamFirstTokenReceived = false;

    // connectPort 现为 async（发送前先 ensure offscreen 文档，文档死亡后
    // 自愈重建）；await 兼容旧的同步返回 Port 的 deps 实现。
    const port = await deps.connectPort();
    activePort = port;

    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === "reasoning") {
        handleFirstStreamToken();
        if (!thinkingNode) thinkingNode = createThinkingNode(activeAssistantNode);
        appendThinkingText(thinkingNode, msg.data);
      } else if (msg.type === "token") {
        handleFirstStreamToken();
        thinkingNode = null;
        appendToken(activeAssistantNode, msg.data);
      } else if (msg.type === "done") {
        finalizeAssistant(activeAssistantNode);
      } else if (msg.type === "stopped") {
        handleAssistantStopped(activeAssistantNode, msg.reason || "已停止生成");
      } else if (msg.type === "error") {
        showAssistantError(activeAssistantNode, msg.error || "未知错误");
      } else if (msg.type === "notice") {
        deps.showConversationContextNotice(msg.data, 4000);
      } else if (msg.type === "cost-guard") {
        // offscreen 发起 Map-Reduce 前弹成本护栏，等待确认后回执。
        const ok = window.confirm(String(msg.data?.message || "预计会有多次调用，是否继续？"));
        port.postMessage({ action: "cost-guard-confirm", ok });
      }
    });

    port.onDisconnect.addListener(() => {
      activePort = null;
      clearStreamRuntimeState();
      setStreamingUiState(false);
    });

    port.postMessage({
      action: "chat",
      providerId,
      thinkingLevel: deps.getThinkingLevel(),
      context: {
        ...deps.getContextData(),
        aiSystemPrompt: deps.getAiPrefs().aiSystemPrompt,
        chatHistory: chatHistory()
      },
      prompt: text,
      history: chatHistory()
    });
  }

  // =========================================================================
  // appendUserMessage
  // =========================================================================
  function appendUserMessage(text, shouldScroll = true) {
    const node = document.createElement("div");
    node.className = "sp-msg sp-msg-user";
    node.textContent = text;
    deps.messages.appendChild(node);
    if (shouldScroll) {
      setShouldAutoScrollMessages(true);
      scrollToBottom(true);
    }
  }

  // =========================================================================
  // appendAssistantPlaceholder
  // =========================================================================
  function appendAssistantPlaceholder() {
    const node = document.createElement("div");
    node.className = "sp-msg sp-msg-assistant";
    // 流式 token 累加器（原 dataset.raw）随占位节点初始化/重置，
    // 保证第二条消息不会串上上一条的流式文本。
    resetTokenStreamState(node);
    const cursor = document.createElement("span");
    cursor.className = "sp-msg-cursor";
    node.appendChild(cursor);
    deps.messages.appendChild(node);
    setShouldAutoScrollMessages(true);
    scrollToBottom(true);
    return node;
  }

  // =========================================================================
  // createThinkingNode
  // =========================================================================
  function createThinkingNode(assistantNode) {
    if (!assistantNode) {
      return null;
    }
    const node = document.createElement("div");
    node.className = "sp-thinking";
    const label = document.createElement("span");
    label.className = "sp-thinking-label";
    label.textContent = "思考中…";
    const text = document.createElement("div");
    text.className = "sp-thinking-text";
    node.appendChild(label);
    node.appendChild(text);
    assistantNode.prepend(node);
    return node;
  }

  // =========================================================================
  // appendThinkingText
  // =========================================================================
  // 思考文本的流式累加器（原挂在 .sp-thinking-text 的 dataset.acc，每条增量
  // 全量复制旧串，O(n²) 且无上限——纯自用累加器，无任何外部读取方）。
  // 现改为 WeakMap 按节点存放"前 MAX_DISPLAY_CHARS 字符头缓冲 + 溢出计数"：
  // 每条增量只复制能进头缓冲的部分，其余仅累加计数，总复制量 O(n)。
  // 显示输出与旧逻辑逐字节一致：头缓冲 +（溢出时的截断提示）。
  // 头缓冲/计数随 thinking 节点（每条消息新建）走，跨消息天然隔离重置。
  const thinkingDisplayStates = new WeakMap();
  const THINKING_TRUNCATION_SUFFIX = "\n…（思考内容过长，已截断显示）";

  function appendThinkingText(node, text) {
    if (!node) {
      return;
    }
    const textNode = node.querySelector(".sp-thinking-text");
    if (!textNode) {
      return;
    }
    const MAX_DISPLAY_CHARS = 4000;
    let state = thinkingDisplayStates.get(textNode);
    if (!state) {
      state = { head: "", overflow: 0 };
      thinkingDisplayStates.set(textNode, state);
    }
    const chunk = String(text || "");
    const space = Math.max(MAX_DISPLAY_CHARS - state.head.length, 0);
    if (chunk.length <= space) {
      state.head += chunk;
    } else {
      state.head += chunk.slice(0, space);
      state.overflow += chunk.length - space;
    }
    if (state.overflow > 0) {
      textNode.textContent = state.head + THINKING_TRUNCATION_SUFFIX;
    } else {
      textNode.textContent = state.head;
    }
    textNode.scrollTop = textNode.scrollHeight;
  }

  // =========================================================================
  // appendToken
  // =========================================================================
  // 流式渲染优化：流式过程中按帧批量做增量 markdown 渲染（每帧最多一次
  // renderMarkdown + innerHTML，不再逐 token 全量渲染，避免长回复 O(n²)）。
  // 流式期间即显示正确的 markdown 结构（换行/缩进/列表等），而不是等流结束
  // 才由 finalizeAssistant / handleAssistantStopped 出口渲染。光标 span 保留
  // 在渲染内容之后——innerHTML 整体赋值会清掉光标，所以每帧重建时重新接回。
  let tokenFlushFrame = 0;

  // 流式 token 累加器（原挂在 assistant 节点的 dataset.raw，每 token 全量
  // 拼接旧串，O(n²) 复制——全仓读取方仅同流的 flush / finalize / stopped）。
  // 现改为 WeakMap 按节点存放 { base, pending: string[] }：append 推入
  // pending；flush 时 text = base + pending.join("")，渲染照旧（仍全量
  // renderMarkdown + innerHTML），渲染后 text 收进 base、清空 pending，
  // 每帧拼接量与帧间隔成正比，总复制量 O(n)。finalize / stopped 从这里
  // 取全量文本。随占位节点初始化（appendAssistantPlaceholder），跨消息
  // 天然隔离。
  const tokenStreamStates = new WeakMap();

  function resetTokenStreamState(node) {
    tokenStreamStates.set(node, { base: "", pending: [] });
  }

  function getTokenStreamState(node) {
    let state = tokenStreamStates.get(node);
    if (!state) {
      state = { base: "", pending: [] };
      tokenStreamStates.set(node, state);
    }
    return state;
  }

  // 全量流式文本 = base + 未 flush 的 pending（不做清空，供 finalize/stopped 只读）
  function getStreamRaw(node) {
    const state = tokenStreamStates.get(node);
    if (!state) {
      return "";
    }
    return state.base + state.pending.join("");
  }

  function cancelTokenFlush() {
    if (!tokenFlushFrame) {
      return;
    }
    if (typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(tokenFlushFrame);
    } else {
      window.clearTimeout(tokenFlushFrame);
    }
    tokenFlushFrame = 0;
  }

  function appendToken(node, token) {
    if (!node) {
      return;
    }
    getTokenStreamState(node).pending.push(String(token || ""));
    if (tokenFlushFrame) {
      return;
    }
    const flush = () => {
      tokenFlushFrame = 0;
      const state = getTokenStreamState(node);
      const text = state.base + state.pending.join("");
      const cursor = node.querySelector(".sp-msg-cursor");
      node.innerHTML = renderMarkdown(text || "");
      if (cursor) {
        node.appendChild(cursor);
      }
      scrollToBottom();
      state.base = text;
      state.pending.length = 0;
    };
    if (typeof window.requestAnimationFrame === "function") {
      tokenFlushFrame = window.requestAnimationFrame(flush);
    } else {
      tokenFlushFrame = window.setTimeout(flush, 16);
    }
  }

  // =========================================================================
  // finalizeAssistant
  // =========================================================================
  function finalizeAssistant(node) {
    if (!node) {
      return;
    }
    cancelTokenFlush();
    clearStreamRuntimeState();
    const raw = getStreamRaw(node);
    renderAssistantMessage(node, raw, { userPrompt: activeUserPrompt });
    if (activeUserPrompt && raw) {
      chatHistory().push({ role: "user", content: activeUserPrompt });
      chatHistory().push({ role: "assistant", content: raw });
      activeUserPrompt = "";
      void deps.store.persistCurrent();
    }
    if (activePort) {
      try { activePort.disconnect(); } catch {}
      activePort = null;
    }
    setStreamingUiState(false);
    deps.input.focus();
    scrollToBottom();
  }

  // =========================================================================
  // showAssistantError
  // =========================================================================
  function showAssistantError(node, error) {
    if (!node) {
      return;
    }
    cancelTokenFlush();
    clearStreamRuntimeState();
    node.innerHTML = "";
    const err = document.createElement("div");
    err.className = "sp-msg-error";
    err.textContent = `错误：${error}`;
    node.appendChild(err);
    activeUserPrompt = "";
    if (activePort) {
      try { activePort.disconnect(); } catch {}
      activePort = null;
    }
    setStreamingUiState(false);
    deps.input.focus();
    scrollToBottom();
  }

  // =========================================================================
  // handleAssistantStopped
  // =========================================================================
  function handleAssistantStopped(node, reason) {
    if (!node) {
      return;
    }
    cancelTokenFlush();
    clearStreamRuntimeState();
    const raw = getStreamRaw(node);
    if (raw.trim()) {
      renderAssistantMessage(node, raw, { userPrompt: activeUserPrompt });
      const stopped = document.createElement("div");
      stopped.className = "sp-msg-stopped";
      stopped.textContent = reason || "已停止生成";
      node.appendChild(stopped);
      if (activeUserPrompt) {
        chatHistory().push({ role: "user", content: activeUserPrompt });
        chatHistory().push({ role: "assistant", content: raw });
        activeUserPrompt = "";
        void deps.store.persistCurrent();
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
      try { activePort.disconnect(); } catch {}
      activePort = null;
    }
    setStreamingUiState(false);
    deps.input.focus();
    scrollToBottom();
  }

  // =========================================================================
  // stopActiveStream
  // =========================================================================
  function stopActiveStream() {
    if (!activePort) {
      return;
    }
    if (deps.stopBtn) {
      deps.stopBtn.disabled = true;
      deps.stopBtn.textContent = "停止中...";
    }
    try {
      activePort.postMessage({ action: "stop" });
    } catch {
      try { activePort.disconnect(); } catch {}
      activePort = null;
    }
  }

  // =========================================================================
  // startStreamSlowNoticeTimer
  // =========================================================================
  function startStreamSlowNoticeTimer() {
    clearStreamRuntimeState();
    streamFirstTokenReceived = false;
    streamSlowNoticeTimer = window.setTimeout(() => {
      if (!activePort || streamFirstTokenReceived) {
        return;
      }
      deps.showConversationContextNotice("模型响应较慢，可能正在思考，请稍候…", 0);
    }, STREAM_SLOW_NOTICE_MS);
  }

  // =========================================================================
  // handleFirstStreamToken
  // =========================================================================
  function handleFirstStreamToken() {
    if (streamFirstTokenReceived) {
      return;
    }
    streamFirstTokenReceived = true;
    clearStreamRuntimeState();
  }

  // =========================================================================
  // clearStreamRuntimeState
  // =========================================================================
  function clearStreamRuntimeState() {
    if (streamSlowNoticeTimer) {
      window.clearTimeout(streamSlowNoticeTimer);
      streamSlowNoticeTimer = 0;
    }
    streamFirstTokenReceived = false;
    deps.removeConversationContextNotice();
  }

  // =========================================================================
  // renderAssistantMessage
  // =========================================================================
  function renderAssistantMessage(node, raw, { userPrompt = "" } = {}) {
    if (!node) {
      return;
    }
    node.innerHTML = "";
    const cleanedRaw = stripThinkBlocks(raw);
    const pasteReadyRaw = deps.normalizeMarkdownForSectionPaste(cleanedRaw);

    const content = document.createElement("div");
    content.className = "sp-msg-assistant-body";
    content.innerHTML = renderMarkdown(cleanedRaw);
    linkifyAssistantTimestamps(content, deps.getTimestampNavDeps());
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

  // =========================================================================
  // isStreaming / hasPendingUserPrompt / resetStreamState — state queries and
  // the reset entry point for sidepanel (replaces direct reads of the old
  // module-level variables)
  // =========================================================================
  function isStreaming() {
    return activePort !== null;
  }

  function hasPendingUserPrompt() {
    return activeUserPrompt !== "";
  }

  function resetStreamState() {
    clearStreamRuntimeState();
    if (activePort) {
      try { activePort.disconnect(); } catch {}
      activePort = null;
    }
    activeAssistantNode = null;
    activeUserPrompt = "";
    thinkingNode = null;
  }

  return {
    sendMessage,
    stopActiveStream,
    handleFirstStreamToken,
    clearStreamRuntimeState,
    startStreamSlowNoticeTimer,
    appendAssistantPlaceholder,
    appendToken,
    finalizeAssistant,
    handleAssistantStopped,
    showAssistantError,
    renderAssistantMessage,
    appendUserMessage,
    createThinkingNode,
    appendThinkingText,
    isStreaming,
    hasPendingUserPrompt,
    resetStreamState
  };
}
