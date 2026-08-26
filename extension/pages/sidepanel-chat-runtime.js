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
 *     connectPort,                       // () => chrome.runtime.Port (name "offscreen-chat")
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

    const port = deps.connectPort();
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
    node.dataset.raw = "";
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
  function appendThinkingText(node, text) {
    if (!node) {
      return;
    }
    const textNode = node.querySelector(".sp-thinking-text");
    if (!textNode) {
      return;
    }
    const MAX_DISPLAY_CHARS = 4000;
    const acc = (textNode.dataset.acc || "") + String(text || "");
    textNode.dataset.acc = acc;
    if (acc.length > MAX_DISPLAY_CHARS) {
      textNode.textContent = acc.slice(0, MAX_DISPLAY_CHARS) + "\n…（思考内容过长，已截断显示）";
    } else {
      textNode.textContent = acc;
    }
    textNode.scrollTop = textNode.scrollHeight;
  }

  // =========================================================================
  // appendToken
  // =========================================================================
  // 流式渲染优化：流式过程中仅按帧批量把原文写入一个文本节点（每帧最多一次
  // 写入，不再逐 token 全量 renderMarkdown + innerHTML，避免长回复 O(n²)）。
  // markdown 的最终渲染由 finalizeAssistant / handleAssistantStopped 出口完成，
  // 结果与之前逐 token 渲染一致。光标 span 保留在文本节点之后——textContent
  // 整体赋值会清掉光标，所以用独立文本节点并缓存引用。
  let tokenFlushFrame = 0;
  const streamTextNodes = new WeakMap();

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
    node.dataset.raw = (node.dataset.raw || "") + String(token || "");
    if (tokenFlushFrame) {
      return;
    }
    const flush = () => {
      tokenFlushFrame = 0;
      let text = streamTextNodes.get(node);
      if (!text || !text.isConnected) {
        // 首次写入（或节点被重建）：保留光标，其余（如思考节点）按旧行为清掉
        const cursor = node.querySelector(".sp-msg-cursor");
        text = document.createTextNode("");
        node.replaceChildren(text);
        if (cursor) {
          node.appendChild(cursor);
        }
        streamTextNodes.set(node, text);
      }
      text.data = node.dataset.raw || "";
      scrollToBottom();
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
    const raw = node.dataset.raw || "";
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
    const raw = String(node.dataset.raw || "");
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
