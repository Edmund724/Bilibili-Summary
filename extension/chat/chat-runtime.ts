// extension/chat/chat-runtime.ts — chat + stream state machine orchestration layer
// extracted out of extension/pages/sidepanel.js (ticket 07 of sidepanel-split;
// PR5 自 extension/pages/sidepanel-chat-runtime.ts 迁入 chat 域).
//
// Responsibility: orchestrate "send message → stream receive → render assistant
// tokens → stop/error handling". It owns the stream runtime state
// (activePort / activeAssistantNode / activeUserPrompt / thinkingNode /
// streamSlowNoticeTimer / streamFirstTokenReceived), performs the DOM node
// operations for the live chat message area (.sp-msg-* nodes, scrolling), and
// delegates persistence (conversation-store, injected via deps) and markdown
// rendering (../ui/markdown.js, pulled in directly).
//
// 候选07：offscreen port 消息协议（reasoning/token/stream-reset/done/stopped/
// error/notice/cost-guard）统一经 dispatchChatPortMessage 分派——真实 port
// 监听器与公开的协议测试入口 handleChatPortMessage 共用；done/stopped/error
// 三条终态路径的六步收尾时序收敛为唯一的 endStream 实现。返回面收窄为
// 9 个 sidepanel 消费方法 + handleChatPortMessage，内部步骤全部私有化。
//
// PR5 改造（宿主解耦补齐）：cost-guard 的确认通道经 deps.confirmCostGuard
// 注入，缺省仍为 window.confirm（sidepanel 过渡期行为不变；reader 壳任务再
// 注入面板内确认 UI）。endStream 的输入框聚焦（deps.input.focus()）本就经
// deps 注入，无需改动。
//
// Boundary: this module does NOT touch sidepanel module-level layout variables
// or the surrounding chrome (header/popovers/context chip). Conversation state
// (chatHistory / conversation meta / context / aiPrefs / thinking level) lives
// in ./chat-state.js and is imported directly; everything else it needs —
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
import { linkifyAssistantTimestamps, type TimestampNavDeps } from "../ui/timestamp-nav.js";
import type { ConversationStore } from "./conversation-store.js";
import { sidepanelState } from "./chat-state.js";

const STREAM_SLOW_NOTICE_MS = 15000;

// ---------------------------------------------------------------------------
// offscreen chat port 的窄视图（chrome.runtime.Port 的结构子集，测试假 port 同构）
// ---------------------------------------------------------------------------

export interface ChatPort {
  name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
  };
}

// offscreen → sidepanel 的 port 消息协议（七分派）。reasoning/token/stream-reset/
// done/stopped/error/notice/cost-guard 的载荷字段按分派分支收窄；所有分支都
// 可携带 cachedContextKey（offscreen 单槽字幕体缓存的当前 key 回执）。
export type ChatPortMessage =
  | { type: "reasoning"; data?: unknown; cachedContextKey?: string }
  | { type: "token"; data?: unknown; cachedContextKey?: string }
  | { type: "stream-reset"; cachedContextKey?: string }
  | { type: "done"; cachedContextKey?: string }
  | { type: "stopped"; reason?: string; cachedContextKey?: string }
  | { type: "error"; code?: string; error?: unknown; cachedContextKey?: string }
  | { type: "notice"; data: string; cachedContextKey?: string }
  | { type: "cost-guard"; data?: { message?: unknown }; cachedContextKey?: string };

// chat-runtime 消费的最窄 store 面（会话身份守卫 + 在途一问一答持久化）
export interface ChatRuntimeStore {
  isCurrent(id: string): boolean;
  persistCurrent(): Promise<void>;
}

// UI 门面（sidepanel 布局回调的纯分组，方法名不变）
export interface ChatRuntimeUi {
  setStreamingUiState: (isStreaming: boolean, options?: { stopping?: boolean }) => void;
  showConversationContextNotice: (message: string, autoHideMs?: number, options?: { openSettingsAction?: boolean }) => void;
  removeConversationContextNotice: () => void;
  hidePresetPopover: () => void;
  hideHistoryPopover: () => void;
  removeCenteredState: () => void;
  removeSuggestions: () => void;
  resetConversationView: (stateHtml?: string) => void;
  autosizeInput: () => void;
}

export interface CreateChatRuntimeDeps {
  // ---- DOM container / element refs (sidepanel module-level `els`) ----
  messages: HTMLElement;
  input: HTMLTextAreaElement;
  stopBtn: HTMLButtonElement | null;
  // ---- conversation-store narrow interface (ticket 05) ----
  store: ChatRuntimeStore;
  // ---- UI 门面 ----
  ui: ChatRuntimeUi;
  // ---- context/transport helpers (AI domain, chat local) ----
  ensureCurrentContextForSend: () => Promise<boolean | string>;
  getProviderId: () => string;
  getTimestampNavDeps: () => TimestampNavDeps;
  normalizeMarkdownForSectionPaste: (raw: string, baseLevel?: number) => string;
  connectPort: () => Promise<ChatPort> | ChatPort;
  // cost-guard 确认通道（offscreen 发起 Map-Reduce 前的成本护栏）。缺省
  // window.confirm——sidepanel 过渡期行为不变；reader 壳任务注入面板内
  // 确认 UI（window.confirm 在页面语境下不可用/体验不符）。
  confirmCostGuard?: (message: string) => boolean;
}

// 流式 token 累加器（按节点存放在 WeakMap）：base = 已 flush 的全量文本，
// pending = 未 flush 的增量帧，stableText/stableEl/tailEl 为双容器渲染状态。
interface TokenStreamState {
  base: string;
  pending: string[];
  stableText: string;
  stableEl: HTMLDivElement | null;
  tailEl: HTMLDivElement | null;
}

// 思考文本的截断显示状态（头缓冲 + 溢出计数）
interface ThinkingDisplayState {
  head: string;
  overflow: number;
}

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
   *     confirmCostGuard,                  // (message) => boolean（可选；缺省 window.confirm。cost-guard 确认通道）
   *   }
 *
 * @returns {object} method set (all closures; stream state only via the
 *   runtime's own closure variables — sidepanel queries it with isStreaming() /
 *   hasPendingUserPrompt(), never by reading runtime internals)。
 *   候选07：接口面刻意收窄为 9 + 1——只暴露 sidepanel 实际消费的 9 个方法 +
 *   1 个协议测试入口；内部渲染/收尾步骤（首 token、计时器、占位、token 追加、
 *   三类终态收口、thinking 节点等）全部私有化，测试经 sendMessage + 假 port
 *   或 handleChatPortMessage 以协议消息驱动，不直接戳内部步骤：
 *   {
 *     sendMessage,                 // () => Promise<void>
 *     stopActiveStream,            // () => void
 *     renderAssistantMessage,      // (node, raw, { userPrompt }) => void
 *     appendUserMessage,           // (text, shouldScroll) => void
 *     // ---- auto-scroll (flag owned by this closure; sidepanel writes via
 *     // these narrow entries, flush/finalize read it internally) ----
 *     setAutoScroll,               // (value) => void  (scroll listener / reset points)
 *     scrollToBottom,              // (force?) => void
 *     // ---- stream state queries / reset (sidepanel reads runtime state) ----
 *     isStreaming,                 // () => boolean   (activePort !== null)
 *     hasPendingUserPrompt,        // () => boolean   (activeUserPrompt !== "")
 *     resetStreamState,            // () => void  (clear + disconnect + null state)
 *     // ---- 协议测试入口：offscreen port 消息对象进、UI/状态变化出 ----
 *     handleChatPortMessage,       // (msg) => void  (与 port.onMessage 监听器同分派)
 *   }
 */
export function createChatRuntime(deps: CreateChatRuntimeDeps) {
  // ---- stream runtime state (closure-local) ----
  let activePort: ChatPort | null = null;
  let activeAssistantNode: HTMLDivElement | null = null;
  let activeUserPrompt = "";
  // 会话身份快照：sendMessage 发起时捕获 currentConversationId，finalize /
  // stopped 持久化前经 deps.store.isCurrent(快照) 判定（守卫逻辑单点收在
  // store，见 sidepanel-conversation-store.js）。发送后当前会话被删除/清空/
  // 切换（id 已变）则只更新 DOM，不 push 进 chatHistory、不 persistCurrent——
  // 流式中删除当前会话导致会话"复活"的竞态兜底（第一道防线是 store reset 路
  // 径注入的 stopActiveChat）。
  let activeConversationId = "";
  // 思考节点生命周期三态，thinkingNode 只表示「本代际思考节点是否存在」：
  // null = 本代际尚未创建思考节点（reasoning 首事件到达时创建）；节点引用 =
  // 本代际思考进行中；thinkingEnded = true 表示「本代际思考已收尾」——token
  // 首帧渲染移除了思考节点（thinkingNode 归 null），其后到达的 reasoning 事件
  //（某些实现的收尾 reasoning 事件）不能重新附着到已移除的旧节点，必须为
  // 下一条消息在 activeAssistantNode 上新建。两语义（未创建 vs 已结束）此前
  // 都折叠进 thinkingNode === null，导致跨消息 reasoning 串进游离节点。
  let thinkingNode: HTMLDivElement | null = null;
  let thinkingEnded = false;
  let streamSlowNoticeTimer = 0;
  // 慢响应计时器与首 token 标志的分离（见 startStreamSlowNoticeTimer /
  // handleFirstStreamToken / clearStreamRuntimeState）：
  // - streamSlowNoticeTimer 只表达「慢响应计时器挂起中」；clearStreamRuntimeState
  //   清它（每代际一次，done/stopped/error/断连/流重置时）；
  // - streamFirstTokenReceived 是「本代际已收到首 token」的一代际语义标志，
  //   由发送时置 false、首 token 置 true，slow 计时器与「首 token 后不再重弹」
  //   都读它。它不能被 clearStreamRuntimeState 复位——clear 也会在收尾时被调，
  //   一旦复位，收尾后到达的下一带 reasoning/token 事件会再次触发
  //   handleFirstStreamToken 的清理副作用（计时器其实已清、无可见后果，但
  //   reasoning 收尾事件可能误清下一条消息的提示状态）——见 handleFirstStreamToken。
  let streamFirstTokenReceived = false;
  // 双发竞态闸：「发送中」标志（区别于 activePort——connectPort await 窗口内
  // 端口未建立，但发送流程已在进行）。sendMessage 入口置位、发送完成/失败/
  // 中断后复位；重复进入 sendMessage 直接忽略。
  let sendInFlight = false;
  // 自动滚动标志（原 sidepanel 模块级 shouldAutoScrollMessages，归位到本闭包）：
  // scroll 监听与恢复点经 setAutoScroll 写入，token flush / finalize /
  // error / stopped 的非强制滚动在此读取。
  let shouldAutoScrollMessages = true;
  // 候选5：offscreen 侧已确认缓存字幕体的 contextKey（从其每次回执的
  // cachedContextKey 读到）。追问消息据此省略整份 subtitleBody——长视频单份
  // 字幕体可达数 MB，逐条追问经 port 重传纯属浪费。null = 未确认（首条消息、
  // port 断连、字幕体缺失错误之后），必然全量携带。
  let lastAckedContextKey: string | null = null;

  // ---- internal helpers ----
  function setStreamingUiState(isStreaming: boolean, { stopping = false }: { stopping?: boolean } = {}): void {
    deps.ui.setStreamingUiState(isStreaming, { stopping });
  }

  function scrollToBottom(force = false): void {
    if (!force && !shouldAutoScrollMessages) {
      return;
    }
    deps.messages.scrollTop = deps.messages.scrollHeight;
  }

  // =========================================================================
  // dispatchChatPortMessage — offscreen port 消息的协议分派（七分派 + 代际重置）
  // =========================================================================
  // sendMessage 内 port.onMessage 监听器的函数体与公开的 handleChatPortMessage
  // （协议测试入口）共用同一份分派。port 参数仅用于 cost-guard 的确认回执：
  // 真实监听器传当前 port；测试入口传 activePort。
  function dispatchChatPortMessage(msg: ChatPortMessage | null | undefined, port: ChatPort | null): void {
    if (!msg) return;
    // 候选5：offscreen 每次回执都带 cachedContextKey（其单槽字幕体缓存当前
    // 持有的 key）——推进 lastAcked，后续追问省略 subtitleBody。字幕体缺失
    // 错误不带该字段，由下方 error 分支显式重置。
    if (typeof msg.cachedContextKey === "string" && msg.cachedContextKey) {
      lastAckedContextKey = msg.cachedContextKey;
    }
    if (msg.type === "reasoning") {
      handleFirstStreamToken();
      // 本代际思考已收尾（token 首帧渲染移除思考节点）后仍到达的 reasoning
      // 收尾事件：为下一条消息新建思考节点（附着当前活动 assistant 节点——
      // 跨消息时 activeAssistantNode 可能已换到新回合），不再写进游离旧节点。
      if (!thinkingNode && thinkingEnded) {
        thinkingEnded = false;
      }
      if (!thinkingNode) thinkingNode = createThinkingNode(activeAssistantNode);
      appendThinkingText(thinkingNode, msg.data);
    } else if (msg.type === "token") {
      handleFirstStreamToken();
      thinkingNode = null;
      thinkingEnded = true;
      appendToken(activeAssistantNode, msg.data);
    } else if (msg.type === "stream-reset") {
      // 读流中断重试（offscreen 重新从头生成）：已吐 token 撤不回且新流不保证
      // 前缀一致，清空本条消息缓冲整体重放，避免两代流拼接成重复文本。
      resetAssistantStream(activeAssistantNode);
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
      // offscreen 发起 Map-Reduce 前弹成本护栏，等待确认后回执。确认通道经
      // deps 注入（缺省 window.confirm，sidepanel 过渡期行为不变）。
      const confirmCostGuard = deps.confirmCostGuard || ((message: string) => window.confirm(message));
      const ok = confirmCostGuard(String(msg.data?.message || "预计会有多次调用，是否继续？"));
      port!.postMessage({ action: "cost-guard-confirm", ok });
    }
  }

  // =========================================================================
  // sendMessage — entry point of the chat flow
  // =========================================================================
  async function sendMessage(): Promise<void> {
    const text = deps.input.value.trim();
    // 双发竞态闸：activePort 已建（流式进行中）或发送流程已在进行
    //（ensureCurrentContextForSend / connectPort 的 await 窗口内端口未建、
    // 但 UI 已进流式态）都直接忽略——否则窗口内第二次 sendMessage 会开出
    // 第二条流（第一、二条回执交错到两个 assistant 节点）。返回契约不变：
    // 调用方（sidepanel.js keydown / 快捷动作 / 预设 chip）不读返回值。
    if (!text || activePort || sendInFlight) {
      return;
    }
    sendInFlight = true;
    try {
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
      // 新代际：思考状态复位——thinkingNode 可能还持着上一代残留的孤儿引用
      //（收尾 reasoning 在已渲染节点上新建的节点，被终态重渲染打成脱离 DOM
      // 的孤儿），不清理的话本代际 reasoning 会写进游离节点；thinkingEnded
      // 复位为「思考未创建/未结束」。
      thinkingNode = null;
      thinkingEnded = false;

      // connectPort 现为 async（发送前先 ensure offscreen 文档，文档死亡后
      // 自愈重建）；await 兼容旧的同步返回 Port 的 deps 实现。
      const port = await deps.connectPort();
      activePort = port;

      port.onMessage.addListener((msg) => {
        dispatchChatPortMessage(msg as ChatPortMessage, port);
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
    } catch (err) {
      // connectPort 失败（ensure offscreen 文档/建连抛错）无回退：UI 卡流式
      // 态而 isStreaming() 为 false（activePort 从未置位，但 setStreamingUiState
      // (true) 已调用）。这里恢复全部半置位流状态并走用户可见错误路径——
      // 与 showAssistantError 同款机制（endStream 收口六步 + .sp-msg-error 占位）。
      console.error("[chat-runtime] sendMessage 失败：", err);
      sendInFlight = false;
      thinkingEnded = false;
      const node = activeAssistantNode;
      if (node) {
        showAssistantError(node, (err as Error)?.message || String(err));
      } else {
        // 失败发生在占位建立前（ensure/上下文阶段）：只复位流式 UI 与计时器。
        clearStreamRuntimeState();
        setStreamingUiState(false);
      }
      activeAssistantNode = null;
      return;
    }
    sendInFlight = false;
  }

  // =========================================================================
  // appendUserMessage
  // =========================================================================
  function appendUserMessage(text: string, shouldScroll = true): void {
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
  function appendAssistantPlaceholder(): HTMLDivElement {
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
  function createThinkingNode(assistantNode: HTMLDivElement | null): HTMLDivElement | null {
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
  const thinkingDisplayStates = new WeakMap<Element, ThinkingDisplayState>();
  const THINKING_TRUNCATION_SUFFIX = "\n…（思考内容过长，已截断显示）";

  function appendThinkingText(node: HTMLDivElement | null, text: unknown): void {
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
  const tokenStreamStates = new WeakMap<HTMLElement, TokenStreamState>();

  function resetTokenStreamState(node: HTMLElement): void {
    tokenStreamStates.set(node, { base: "", pending: [], stableText: "", stableEl: null, tailEl: null });
  }

  function getTokenStreamState(node: HTMLElement): TokenStreamState {
    let state = tokenStreamStates.get(node);
    if (!state) {
      state = { base: "", pending: [], stableText: "", stableEl: null, tailEl: null };
      tokenStreamStates.set(node, state);
    }
    return state;
  }

  // =========================================================================
  // resetAssistantStream — 流式代际重置（读流中断重试：整体重放）
  // =========================================================================
  // offscreen 侧重试流从头生成，已吐 token 撤不回且新流不保证前缀一致（模型
  // 生成非确定性），清空本条消息的流式缓冲与已渲染内容，从头接收重试流：
  // - 取消挂起的 flush 帧、重置 token 累加器（base/pending 清零）——与
  //   endStream 收口共享同一组原语（cancelTokenFlush / resetTokenStreamState，
  //   后者亦用于占位初始化）；但不走收口六步：流并未终止（activePort 不断开、
  //   流式 UI 不退出、慢响应计时器不关）；
  // - 移除已渲染的 stable/tail 容器与思考节点（光标先摘下来放回节点末尾，
  //   flush 时机随下一帧恢复）；思考节点随下一个 reasoning 事件重建。
  function resetAssistantStream(node: HTMLDivElement | null): void {
    if (!node) {
      return;
    }
    cancelTokenFlush();
    resetTokenStreamState(node);
    const cursor = node.querySelector(".sp-msg-cursor");
    node.querySelectorAll(".sp-stream-stable, .sp-stream-tail, .sp-thinking").forEach((el) => el.remove());
    if (cursor) {
      node.appendChild(cursor);
    }
    thinkingNode = null;
    thinkingEnded = false;
  }

  // 流式双容器懒创建（首帧 flush 时挂上；finalize / stopped 的整体重渲染会
  // 自然清掉它们）
  function ensureStreamContainers(node: HTMLDivElement, state: TokenStreamState): void {
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
  function getStreamRaw(node: HTMLElement): string {
    const state = tokenStreamStates.get(node);
    if (!state) {
      return "";
    }
    return state.base + state.pending.join("");
  }

  function cancelTokenFlush(): void {
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

  function appendToken(node: HTMLDivElement | null, token: unknown): void {
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
      // think 块先剥除再切分，保证未闭合的  ``` 不会横跨 stable/tail 切点
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
        state.stableEl!.innerHTML = renderMarkdown(stableText);
      }
      // 先取光标引用再重写 tail（innerHTML 赋值会清掉 tail 内的旧光标）
      const cursor = node.querySelector(".sp-msg-cursor");
      state.tailEl!.innerHTML = renderMarkdown(tailText);
      if (cursor) {
        state.tailEl!.appendChild(cursor);
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
  // endStream — 流生命周期收口（done / stopped / error 三条终态路径唯一实现）
  // =========================================================================
  // 六步时序只此一处（原 finalize/showError/stopped 三份抄写收口于此）：
  //   ① cancelTokenFlush          取消挂起的流式渲染帧；
  //   ② clearStreamRuntimeState   清慢响应计时器 / 首 token 标志 / 上下文 notice；
  //   ③ renderStep(node)          终态各自的 DOM / 持久化收尾（见下方三分支）；
  //   ④ 断开并清空 activePort；
  //   ⑤ setStreamingUiState(false)；
  //   ⑥ deps.input.focus() + scrollToBottom()。
  // activeUserPrompt 在 ③ 之后统一清空（③ 内的写回判定还要读它）。
  function endStream(node: HTMLDivElement, renderStep: ((node: HTMLDivElement) => void) | undefined): void {
    cancelTokenFlush();
    clearStreamRuntimeState();
    if (renderStep) {
      renderStep(node);
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

  // 在途一问一答写回（done / stopped 共享）：身份守卫判定收在 store
  // （deps.store.isCurrent）。发送后当前会话已变（删除/清空/切换）→ 不写回
  // chatHistory、不持久化（防会话复活 / 串话），DOM 仍由 renderStep 更新。
  function commitAssistantTurn(raw: string): void {
    if (activeUserPrompt && raw && deps.store.isCurrent(activeConversationId)) {
      sidepanelState.chatHistory.push({ role: "user", content: activeUserPrompt });
      sidepanelState.chatHistory.push({ role: "assistant", content: raw });
      void deps.store.persistCurrent();
    }
  }

  // -------------------------------------------------------------------------
  // 三条终态分派分支：各自只保留"步骤③"的特有 DOM / 持久化收尾
  // -------------------------------------------------------------------------

  // done：全量重渲染 + 写回一问一答
  function finalizeAssistant(node: HTMLDivElement | null): void {
    if (!node) {
      return;
    }
    endStream(node, (n) => {
      const raw = getStreamRaw(n);
      renderAssistantMessage(n, raw, { userPrompt: activeUserPrompt });
      commitAssistantTurn(raw);
    });
  }

  // error：错误占位（不渲染正文、不写回、不持久化）
  function showAssistantError(node: HTMLDivElement | null, error: unknown): void {
    if (!node) {
      return;
    }
    endStream(node, (n) => {
      n.innerHTML = "";
      const err = document.createElement("div");
      err.className = "sp-msg-error";
      err.textContent = `错误：${error}`;
      n.appendChild(err);
    });
  }

  // stopped：有正文则渲染正文 + 停止徽标（并写回）；无正文则只放停止徽标
  function handleAssistantStopped(node: HTMLDivElement | null, reason: string): void {
    if (!node) {
      return;
    }
    endStream(node, (n) => {
      const raw = getStreamRaw(n);
      const stopped = document.createElement("div");
      stopped.className = "sp-msg-stopped";
      stopped.textContent = reason || "已停止生成";
      if (raw.trim()) {
        renderAssistantMessage(n, raw, { userPrompt: activeUserPrompt });
        n.appendChild(stopped);
        commitAssistantTurn(raw);
      } else {
        n.innerHTML = "";
        n.appendChild(stopped);
      }
    });
  }

  // =========================================================================
  // stopActiveStream
  // =========================================================================
  function stopActiveStream(): void {
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
  function startStreamSlowNoticeTimer(): void {
    clearStreamRuntimeState();
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
  // 首 token 语义：本代际首个流事件（token 或 reasoning——两者都算"模型开始
  // 输出"）到达时撤下慢响应提示（每代际一次）。一代际只清一次：
  // streamFirstTokenReceived 置 true 后不再重复执行；clearStreamRuntimeState
  // 不复位它（见下方注释），下一代的重新武装由 sendMessage 在发送前显式
  // streamFirstTokenReceived = false 完成。
  function handleFirstStreamToken(): void {
    if (streamFirstTokenReceived) {
      return;
    }
    streamFirstTokenReceived = true;
    clearStreamRuntimeState();
  }

  // =========================================================================
  // clearStreamRuntimeState
  // =========================================================================
  // 「本代际收尾」的清理原语：清慢响应计时器、撤上下文 notice。endStream /
  // port 断连 / resetStreamState 都调它。
  //
  // 注意：不复位 streamFirstTokenReceived——它是一代际标志，不是"计时器挂起"
  // 标志。此前在 clear 里复位造成两个错位：
  // 1. 「只清一次」失效——done/stopped/error 收尾后（clear 被调、标志被复位），
  //    同一节点上到达的收尾 reasoning/token 事件（竞态）会让
  //    handleFirstStreamToken 再次执行、撤下下一条消息的上下文 notice；
  // 2. 慢响应提示的重新武装职责归位到 sendMessage（发送前置 false），
  //    clear 只管"当前代际内"的清计时器语义。
  function clearStreamRuntimeState(): void {
    if (streamSlowNoticeTimer) {
      window.clearTimeout(streamSlowNoticeTimer);
      streamSlowNoticeTimer = 0;
    }
    deps.ui.removeConversationContextNotice();
  }

  // =========================================================================
  // renderAssistantMessage
  // =========================================================================
  function renderAssistantMessage(node: HTMLDivElement | null, raw: unknown, { userPrompt = "" }: { userPrompt?: string } = {}): void {
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
  function setAutoScroll(value: boolean): void {
    shouldAutoScrollMessages = Boolean(value);
  }

  // =========================================================================
  // isStreaming / hasPendingUserPrompt / resetStreamState — state queries and
  // the reset entry point for sidepanel (replaces direct reads of the old
  // module-level variables)
  // =========================================================================
  function isStreaming(): boolean {
    return activePort !== null;
  }

  function hasPendingUserPrompt(): boolean {
    return activeUserPrompt !== "";
  }

  function resetStreamState(): void {
    // 挂起的流式渲染帧（rAF flush）必须先取消：flush 闭包捕获的是节点引用，
    // 不清的话会向已脱离的旧节点渲染（首帧还会把新消息的思考节点当旧的移除）。
    cancelTokenFlush();
    clearStreamRuntimeState();
    if (activePort) {
      try { activePort.disconnect(); } catch {}
      activePort = null;
    }
    activeAssistantNode = null;
    activeUserPrompt = "";
    thinkingNode = null;
    thinkingEnded = false;
    // 复位在途发送标志：resetStreamState 可能在 connectPort await 窗口内被调
    //（store reset / restartChat 路径）。sendMessage 恢复后仍会继续完成发送
    //（与旧行为一致），但标志若不清，此后用户的新发送会被永久拦下。
    sendInFlight = false;
  }

  // =========================================================================
  // handleChatPortMessage — 协议分派的公开测试入口
  // =========================================================================
  // 与 sendMessage 内注册的 port.onMessage 监听器走同一份
  // dispatchChatPortMessage：协议消息对象进、DOM/状态变化出。测试以此喂
  // reasoning / token / stream-reset / done / stopped / error / notice /
  // cost-guard，无需触达任何内部渲染步骤函数。
  function handleChatPortMessage(msg: ChatPortMessage | null | undefined): void {
    dispatchChatPortMessage(msg, activePort);
  }

  // 返回面恰好 10 键（候选07）：9 个 sidepanel 消费方法 + 1 个协议测试入口。
  // 内部步骤（handleFirstStreamToken / clearStreamRuntimeState /
  // startStreamSlowNoticeTimer / appendAssistantPlaceholder / appendToken /
  // finalizeAssistant / handleAssistantStopped / showAssistantError /
  // createThinkingNode / appendThinkingText）不再外露。
  return {
    sendMessage,
    stopActiveStream,
    renderAssistantMessage,
    appendUserMessage,
    setAutoScroll,
    scrollToBottom,
    isStreaming,
    hasPendingUserPrompt,
    resetStreamState,
    handleChatPortMessage
  };
}
