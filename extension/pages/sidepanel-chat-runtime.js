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
// or the surrounding chrome (header/popovers/context chip). Conversation state
// (chatHistory / conversation meta / context / aiPrefs / thinking level) lives
// in ./sidepanel-state.js and is imported directly; everything else it needs —
// layout callback, context notices, DOM container references, input/stop-button
// element refs — arrives via the `deps` object of the `createChatRuntime(deps)`
// factory. The auto-scroll flag (shouldAutoScrollMessages) is owned by this
// module's closure: sidepanel writes it through the narrow setAutoScroll() /
// scrollToBottom() entries, the token flush / finalize paths read it here.
//
// Top-level side effects: NONE (no document/chrome/window access at module
// scope) — unlike sidepanel.js, this module evaluates cleanly under a Node test
// harness without a DOM shim.
import { renderMarkdown, splitMarkdownTail, stripThinkBlocks } from "../ui/markdown.js";
import { linkifyAssistantTimestamps } from "../ui/timestamp-nav.js";
import { sidepanelState } from "./sidepanel-state.js";

const STREAM_SLOW_NOTICE_MS = 15000;

/**
 * createChatRuntime(deps) — factory returning the chat runtime method set.
 *
 * The runtime owns the stream state machine and the auto-scroll flag
 * (shouldAutoScrollMessages, closure-local); conversation state (chatHistory /
 * conversation meta / context / aiPrefs / thinking level) is read/written via
 * the shared sidepanelState module. deps only carries DOM refs, the store
 * instance and UI/transport callbacks. The returned methods are bound closures
 * over the runtime's own closure state, so multiple factories would be isolated —
 * sidepanel constructs exactly one.
 *
 * @param {object} deps
 *   {
 *     // ---- DOM container / element refs (sidepanel module-level `els`) ----
 *     messages,        // els.messages  (messages scroll container)
 *     input,           // els.input
 *     stopBtn,         // els.stopBtn (optional)
 *     // ---- conversation-store narrow interface (ticket 05) ----
 *     store,           // conversationStore instance: { isCurrent(id), persistCurrent() }
 *                      // isCurrent(id)：会话身份守卫的单一判定点（store 内实现，
 *                      // finalize/stopped 持久化前调用）
 *     // ---- UI 门面（sidepanel 布局回调的纯分组，方法名不变）----
 *     ui: {
 *       setStreamingUiState,               // (isStreaming, { stopping }) => void
 *       showConversationContextNotice,     // (message, autoHideMs) => void
 *       removeConversationContextNotice,   // () => void
 *       hidePresetPopover,                 // () => void
 *       hideHistoryPopover,                // () => void
 *       removeCenteredState,               // () => void
 *       removeSuggestions,                 // () => void  (removes + nulls suggestionsNode)
 *       resetConversationView,             // (stateHtml) => void
 *       autosizeInput,                     // () => void
 *     },
 *     // ---- context/transport helpers (AI domain, sidepanel local) ----
 *     ensureCurrentContextForSend,       // () => Promise<boolean | NO_SUBTITLE_SEND_BLOCKED>
 *                                        //    true=放行；false=读取失败；
 *                                        //    "no-subtitle-send-blocked"=无字幕拦截（notice 已显示）
 *     getProviderId,                     // () => els.modelSelect.value
 *     getTimestampNavDeps,               // () => timestamp-nav deps object
 *     normalizeMarkdownForSectionPaste,  // (raw, baseLevel) => string
 *     connectPort,                       // () => Promise<chrome.runtime.Port> (name "offscreen-chat"; 先 ensure offscreen 文档)
 *   }
 *
 * @returns {object} method set (all closures; stream state only via the
 *   runtime's own closure variables — sidepanel queries it with isStreaming() /
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
 *     // ---- auto-scroll (flag owned by this closure; sidepanel writes via
 *     // these narrow entries, flush/finalize read it internally) ----
 *     setAutoScroll,               // (value) => void  (scroll listener / reset points)
 *     scrollToBottom,              // (force?) => void
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
  // 会话身份快照：sendMessage 发起时捕获 currentConversationId，finalize /
  // stopped 持久化前经 deps.store.isCurrent(快照) 判定（守卫逻辑单点收在
  // store，见 sidepanel-conversation-store.js）。发送后当前会话被删除/清空/
  // 切换（id 已变）则只更新 DOM，不 push 进 chatHistory、不 persistCurrent——
  // 流式中删除当前会话导致会话"复活"的竞态兜底（第一道防线是 store reset 路
  // 径注入的 stopActiveChat）。
  let activeConversationId = "";
  let thinkingNode = null;
  let streamSlowNoticeTimer = 0;
  let streamFirstTokenReceived = false;
  // 自动滚动标志（原 sidepanel 模块级 shouldAutoScrollMessages，归位到本闭包）：
  // scroll 监听与恢复点经 setAutoScroll 写入，token flush / finalize /
  // error / stopped 的非强制滚动在此读取。
  let shouldAutoScrollMessages = true;
  // 候选5：offscreen 侧已确认缓存字幕体的 contextKey（从其每次回执的
  // cachedContextKey 读到）。追问消息据此省略整份 subtitleBody——长视频单份
  // 字幕体可达数 MB，逐条追问经 port 重传纯属浪费。null = 未确认（首条消息、
  // port 断连、字幕体缺失错误之后），必然全量携带。
  let lastAckedContextKey = null;

  // ---- internal helpers ----
  function setStreamingUiState(isStreaming, { stopping = false } = {}) {
    deps.ui.setStreamingUiState(isStreaming, { stopping });
  }

  function scrollToBottom(force = false) {
    if (!force && !shouldAutoScrollMessages) {
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
    deps.ui.hidePresetPopover();
    deps.ui.hideHistoryPopover();

    const providerId = deps.getProviderId();
    if (!providerId) {
      deps.ui.resetConversationView("请先在设置页配置并启用一个 AI 平台。");
      return;
    }

    const hasContext = await deps.ensureCurrentContextForSend();
    // 严格判 true：false（上下文读取失败）与 NO_SUBTITLE_SEND_BLOCKED（无字幕
    // 拦截，notice 已由 ensure 侧显示）都在此提前返回——不追加用户消息、
    // 不落 chatHistory、不发起 port。
    if (hasContext !== true) {
      return;
    }
    const currentMeta = sidepanelState.currentConversationMeta;
    if (!currentMeta?.pinnedContext && currentMeta?.contextKey && currentMeta.contextKey !== sidepanelState.currentContextKey) {
      sidepanelState.currentConversationId = "";
      sidepanelState.currentConversationMeta = null;
    }

    deps.ui.removeCenteredState();
    deps.ui.removeSuggestions();

    appendUserMessage(text);
    deps.input.value = "";
    deps.ui.autosizeInput();
    setStreamingUiState(true);
    activeUserPrompt = text;
    activeConversationId = sidepanelState.currentConversationId;
    activeAssistantNode = appendAssistantPlaceholder();
    startStreamSlowNoticeTimer();
    streamFirstTokenReceived = false;

    // connectPort 现为 async（发送前先 ensure offscreen 文档，文档死亡后
    // 自愈重建）；await 兼容旧的同步返回 Port 的 deps 实现。
    const port = await deps.connectPort();
    activePort = port;

    port.onMessage.addListener((msg) => {
      if (!msg) return;
      // 候选5：offscreen 每次回执都带 cachedContextKey（其单槽字幕体缓存当前
      // 持有的 key）——推进 lastAcked，后续追问省略 subtitleBody。字幕体缺失
      // 错误不带该字段，由下方 error 分支显式重置。
      if (typeof msg.cachedContextKey === "string" && msg.cachedContextKey) {
        lastAckedContextKey = msg.cachedContextKey;
      }
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
        // 候选5：offscreen 单槽缓存缺失（文档被回收后重启 / 槽 key 不匹配）回
        // 「字幕体缺失」→ 重置 lastAcked 让下一条消息重发全文。本条不自动重发，
        // 避免失败风暴；用户重发时自然走全量。
        if (msg.code === "subtitle-body-missing") {
          lastAckedContextKey = null;
        }
        showAssistantError(activeAssistantNode, msg.error || "未知错误");
      } else if (msg.type === "notice") {
        deps.ui.showConversationContextNotice(msg.data, 4000);
      } else if (msg.type === "cost-guard") {
        // offscreen 发起 Map-Reduce 前弹成本护栏，等待确认后回执。
        const ok = window.confirm(String(msg.data?.message || "预计会有多次调用，是否继续？"));
        port.postMessage({ action: "cost-guard-confirm", ok });
      }
    });

    port.onDisconnect.addListener(() => {
      activePort = null;
      // 候选5：断连意味着 offscreen 文档可能已被回收，其单槽字幕体缓存随文档
      // 消失——重置 lastAcked，下一条消息重发全文（宁多传不错发）。
      lastAckedContextKey = null;
      clearStreamRuntimeState();
      setStreamingUiState(false);
    });

    // 候选5：字幕体省略传输——offscreen 已确认缓存当前上下文的字幕体
    //（lastAckedContextKey === contextKey）时本条消息不再重传整份 subtitleBody；
    // contextKey 始终携带，offscreen 据此校验单槽匹配并在缺失时报错触发重置。
    // 其余元数据/history/aiSystemPrompt 保持全量（体积小且每条都可能变）。
    const context = {
      ...sidepanelState.contextData,
      aiSystemPrompt: sidepanelState.aiPrefs.aiSystemPrompt
    };
    const contextKey = String(sidepanelState.currentContextKey || "").trim();
    if (contextKey && lastAckedContextKey === contextKey) {
      delete context.subtitleBody;
    }

    port.postMessage({
      action: "chat",
      providerId,
      thinkingLevel: sidepanelState.aiThinkingLevel,
      context,
      contextKey,
      prompt: text,
      // 历史只走顶层 history（offscreen/ai 侧统一读 msg.history）；
      // 不再向 context 里塞 chatHistory 副本（无任何读取方的死负载）。
      history: sidepanelState.chatHistory
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
      shouldAutoScrollMessages = true;
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
    shouldAutoScrollMessages = true;
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
  // 流式渲染优化：流式过程中按帧做"稳定前缀 + 末块"增量 markdown 渲染。
  // 流式节点的 DOM 为两个堆叠的块级容器（.sp-stream-stable / .sp-stream-tail，
  // 无额外样式——markdown 输出本就是块级，与单容器渲染等价）：
  //   - stable：切点前已稳定的前缀块（splitMarkdownTail 按最后一个空行边界
  //     切分，且切点前围栏已闭合），只在增长时渲染一次；
  //   - tail：最后一个未完块（表格/列表单换行分块、未闭合围栏整段都在
  //     tail），每帧重渲染。
  // 长回复流式期间不再每帧全量 renderMarkdown + innerHTML 重建。光标 span
  // 每帧重接到 tail 尾部（tail 的 innerHTML 赋值会清掉它）。思考节点随首帧
  // 渲染移除（与旧的整节点 innerHTML 覆盖行为一致）。
  let tokenFlushFrame = 0;

  // 流式 token 累加器（原挂在 assistant 节点的 dataset.raw，每 token 全量
  // 拼接旧串，O(n²) 复制——全仓读取方仅同流的 flush / finalize / stopped）。
  // 现改为 WeakMap 按节点存放 { base, pending, stableText, stableEl, tailEl }：
  // append 推入 pending；flush 时 text = base + pending.join("")，剥 think 后
  // 切分渲染，渲染后 text 收进 base、清空 pending，每帧拼接量与帧间隔成正比，
  // 总复制量 O(n)。stableText 记录该节点上次渲染过的稳定前缀，用于跳过未
  // 增长的 stable 重渲染。finalize / stopped 从 base + pending 取全量文本。
  // 随占位节点初始化（appendAssistantPlaceholder），跨消息天然隔离。
  const tokenStreamStates = new WeakMap();

  function resetTokenStreamState(node) {
    tokenStreamStates.set(node, { base: "", pending: [], stableText: "", stableEl: null, tailEl: null });
  }

  function getTokenStreamState(node) {
    let state = tokenStreamStates.get(node);
    if (!state) {
      state = { base: "", pending: [], stableText: "", stableEl: null, tailEl: null };
      tokenStreamStates.set(node, state);
    }
    return state;
  }

  // 流式双容器懒创建（首帧 flush 时挂上；finalize / stopped 的整体重渲染会
  // 自然清掉它们）
  function ensureStreamContainers(node, state) {
    if (state.stableEl && state.tailEl) {
      return;
    }
    const stableEl = document.createElement("div");
    stableEl.className = "sp-stream-stable";
    const tailEl = document.createElement("div");
    tailEl.className = "sp-stream-tail";
    node.appendChild(stableEl);
    node.appendChild(tailEl);
    state.stableEl = stableEl;
    state.tailEl = tailEl;
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
      // think 块先剥除再切分，保证未闭合的 <think> 不会横跨 stable/tail 切点
      // （renderMarkdown 内部的再 strip 是无害幂等）。
      const cleaned = stripThinkBlocks(text);
      const { stableText, tailText } = splitMarkdownTail(cleaned);
      ensureStreamContainers(node, state);
      // 首帧渲染即移除思考节点（与旧的整节点 innerHTML 覆盖行为一致）
      const thinking = node.querySelector(".sp-thinking");
      if (thinking) {
        thinking.remove();
      }
      // 稳定前缀只在增长时渲染一次；末块每帧重渲染
      if (state.stableText !== stableText) {
        state.stableText = stableText;
        state.stableEl.innerHTML = renderMarkdown(stableText);
      }
      // 先取光标引用再重写 tail（innerHTML 赋值会清掉 tail 内的旧光标）
      const cursor = node.querySelector(".sp-msg-cursor");
      state.tailEl.innerHTML = renderMarkdown(tailText);
      if (cursor) {
        state.tailEl.appendChild(cursor);
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
    // 身份校验：守卫判定收在 store（deps.store.isCurrent）。发送后当前会话已变
    // （删除/清空/切换）→ 只更新 DOM，不写回 chatHistory、不持久化（防会话
    // 复活 / 串话）。
    if (activeUserPrompt && raw && deps.store.isCurrent(activeConversationId)) {
      sidepanelState.chatHistory.push({ role: "user", content: activeUserPrompt });
      sidepanelState.chatHistory.push({ role: "assistant", content: raw });
      void deps.store.persistCurrent();
    }
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
        // 身份校验同 finalizeAssistant：守卫判定收在 store（isCurrent），
        // 会话已变则不写回、不持久化
        if (deps.store.isCurrent(activeConversationId)) {
          sidepanelState.chatHistory.push({ role: "user", content: activeUserPrompt });
          sidepanelState.chatHistory.push({ role: "assistant", content: raw });
          void deps.store.persistCurrent();
        }
        activeUserPrompt = "";
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
      deps.ui.showConversationContextNotice("模型响应较慢，可能正在思考，请稍候…", 0);
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
    deps.ui.removeConversationContextNotice();
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
  // setAutoScroll — 自动滚动标志的窄写入口（sidepanel scroll 监听与消息区
  // 重建点调用；appendUserMessage / appendAssistantPlaceholder 直接写闭包）
  // =========================================================================
  function setAutoScroll(value) {
    shouldAutoScrollMessages = Boolean(value);
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
    setAutoScroll,
    scrollToBottom,
    isStreaming,
    hasPendingUserPrompt,
    resetStreamState
  };
}
