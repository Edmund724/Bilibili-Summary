// extension/chat/tab-domain.ts — 对话 tab 内核链组装（arch-review-2026-09/08，
// 自 reader/chat-tab.ts 收口）。createChatTabDomain(deps) 是 chat 域对对话 tab
// 组合根的单一深入口：pinned 补水解析器（core/context-assembly）+
// conversation-store + chat-runtime + context-load（含内联
// createInProcessContextFetch）五件在本模块组装；DOM 编排六件
//（feedback/lists/popovers/presets/providers/subtitle-wait）与页面级编排函数
// 留在 reader/chat-tab.ts，经 deps 注入。
//
// 组装内的实例级硬边顺序（唯一顺序约束，逐字保持自 chat-tab 原组装位）：
//   pinnedResolver → store → contextLoad → runtime。
// 其余跨实例引用一律惰性箭头（回调执行时实例已存在），不显式化：
//   store.loadContextState → contextLoad（后建）；contextLoad.restoreLatest →
//   store（先建）；contextLoad.isStreaming / hasPendingUserPrompt → runtime
//（后建）。
//
// deps 面（reader/chat-tab 侧实现注入）：
//   - DOM 元素：messages / input / contextChip（对话 tab 壳的 readingChat* id）；
//   - ui 门面：ChatRuntimeUi（chat-runtime 的布局/UI 回调纯分组，8 件回调由
//     组合根实现）+ store 能力事件三件（渲染编排反转：store 编排时机，组合根
//     订阅结果）+ contextLoad 的四个渲染编排回调（renderHistoryList /
//     renderInitialState / renderSuggestions / restartChat）；
//   - storage：store 存档读写（测试可注入，缺省 chrome.storage.local）；
//   - 状态 getter：clip / settings（进程内装配链两条路的运行时输入，与
//     core/context-assembly 的注入口径一致）；
//   - runtime 传输/AI 回调：ensureCurrentContextForSend / getProviderId /
//     getTimestampNavDeps / normalizeMarkdownForSectionPaste / connectPort
//    （闭包连着组合根的页面级状态与 DOM，留在 chat-tab）。
//
// 门面 re-exports：组合根仍需的 chat 域零散出口（chatSessionState、
// subtitle-wait、no-subtitle、context-policy 文案与谓词、offscreen 端口名、
// presets/providers 工厂）统一自本模块转出——chat-tab 的 chat 域 import 面
// 收敛为本模块一处（工单 08 验收：10 → 1）。
import type { TimestampNavDeps } from "../ui/timestamp-nav.js";
import type { ClipState } from "../core/state.js";
import type { Settings } from "../core/defaults.js";
import {
  createInProcessContextFetch,
  createInProcessPinnedContextResolver
} from "../core/context-assembly.js";
// pinned 补水未命中时落回的网络路径（ai/context-resolver 纯网络适配器，装配链
// 不复制其装配知识）；purpose="page" 的分页补水同源。
import { resolveAiConversationContext, resolveAiConversationPageRef } from "../ai/context-resolver.js";
import { createChatRuntime, type ChatPort, type ChatRuntimeUi } from "./chat-runtime.js";
import {
  createConversationStore,
  type ConversationChange,
  type ConversationContextNotice,
  type ConversationStore,
  type StorageArea
} from "./conversation-store.js";
import { createContextLoad, type ContextLoad } from "./context-load.js";

// ---- 门面 re-exports（对话 tab 组合根的单点 chat 域出口，见头注）----
export { chatSessionState } from "./chat-state.js";
export { createSubtitleWaiter, isContextPending } from "./subtitle-wait.js";
export {
  NO_SUBTITLE_SEND_BLOCKED,
  buildNoSubtitleNotice,
  isNoSubtitleEmptyContext,
  type NoSubtitleReason
} from "./no-subtitle.js";
export { CONTEXT_READ_FAILED_MESSAGE, isPinnedContextTruthy } from "./context-policy.js";
// offscreen 聊天端口名单源（chat/protocol.ts，ticket 08，原裸写字面量收口）。
export { OFFSCREEN_CHAT_PORT_NAME } from "./protocol.js";
export { createPresetPrompts } from "./presets.js";
export { createProviderPrefs } from "./providers.js";

export interface CreateChatTabDomainDeps {
  // ---- DOM 元素（reader/chat-tab 模块级 `els` 的壳三件）----
  messages: HTMLElement;
  input: HTMLTextAreaElement;
  contextChip: HTMLButtonElement;
  // ---- ui 门面（ChatRuntimeUi，组合根实现注入）----
  ui: ChatRuntimeUi;
  // ---- store 能力事件（渲染编排反转，组合根订阅结果）----
  onConversationChanged: (change: ConversationChange) => void;
  onStreamInterrupted: () => void;
  onContextNotice: (notice: ConversationContextNotice) => void;
  // ---- contextLoad 的渲染编排回调（DOM 编排留在组合根）----
  renderHistoryList: () => void;
  renderInitialState: () => void;
  renderSuggestions: () => void;
  restartChat: (opts?: { keepContext?: boolean }) => void;
  // ---- 存储（可选；测试注入，缺省 chrome.storage.local）----
  storage?: StorageArea;
  // ---- 状态 getter（进程内装配链的运行时输入）----
  clip: () => Partial<ClipState>;
  settings: () => Partial<Settings>;
  // ---- chat-runtime 传输/AI 回调（组合根闭包）----
  ensureCurrentContextForSend: () => Promise<boolean | string>;
  getProviderId: () => string;
  getTimestampNavDeps: () => TimestampNavDeps;
  normalizeMarkdownForSectionPaste: (raw: string, baseLevel?: number) => string;
  connectPort: () => Promise<ChatPort> | ChatPort;
}

export function createChatTabDomain(deps: CreateChatTabDomainDeps): {
  runtime: ReturnType<typeof createChatRuntime>;
  store: ConversationStore;
  contextLoad: ContextLoad;
} {
  // pinned 补水的 context 解析（工单 04 身份短路）接在 resolveAiConversationRef
  // 的 purpose="context" 用途上：会话 contextRef 与当前 clip 一致 → 进程内快照
  // 装配（零网络解析、不重下字幕正文）；未命中（换视频/换分P/换轨/无页面）→
  // ai/context-resolver 的网络路径原样兜底。
  const resolveConversationContext = createInProcessPinnedContextResolver({
    clip: deps.clip,
    settings: deps.settings,
    resolveNetwork: resolveAiConversationContext
  });
  // 会话状态（会话列表/当前会话/上下文）收拢在 chatSessionState，store 直接
  // import 读写；能力事件三件由组合根订阅（工单 05 渲染编排反转：store 自己
  // 编排渲染时机，组合根只订阅结果——历史列表恒随 onConversationChanged 重渲，
  // 标志驱动 chip/popover/视图重建）。
  const store = createConversationStore({
    loadContextState: (opts) => contextLoad.loadContextState(opts),
    resolveAiConversationRef: (contextRef, purpose) =>
      purpose === "page" ? resolveAiConversationPageRef(contextRef) : resolveConversationContext(contextRef),
    onConversationChanged: deps.onConversationChanged,
    onStreamInterrupted: deps.onStreamInterrupted,
    onContextNotice: deps.onContextNotice,
    storage: deps.storage
  });
  // 上下文状态加载（读当前页状态 → 按策略动作执行编排副作用）+ context chip。
  // 流式守卫判定惰性取 runtime（回调执行时实例已存在）。
  // 拉数据一段为 ContextFetch 策略注入——reader 与 content 同进程，用
  // createInProcessContextFetch 直读 state.clip（不走扩展页消息链；装配策略
  // 自工单 07 起收口在 core/context-assembly 的唯一装配链）。
  const contextLoad = createContextLoad({
    fetchContext: createInProcessContextFetch({
      clip: deps.clip,
      settings: deps.settings
    }),
    contextChip: deps.contextChip,
    renderHistoryList: deps.renderHistoryList,
    renderInitialState: deps.renderInitialState,
    renderSuggestions: deps.renderSuggestions,
    resetConversationView: deps.ui.resetConversationView,
    restartChat: deps.restartChat,
    restoreLatest: () => store.restoreLatest(),
    isStreaming: () => runtime.isStreaming(),
    hasPendingUserPrompt: () => runtime.hasPendingUserPrompt()
  });
  // chat 流状态机：自身流状态（activePort 等）与自动滚动标志（shouldAutoScroll-
  // Messages）都在 runtime 闭包内；会话状态读 chatSessionState；deps 只剩 DOM
  // 容器/元素引用、store 实例与 UI/transport 回调。
  const runtime = createChatRuntime({
    // ---- DOM 容器 / 元素引用 ----
    messages: deps.messages,
    input: deps.input,
    // ---- conversation-store 窄接口（实例；isCurrent 为会话身份守卫的单一判定
    // 点，chat-runtime finalize/stopped 持久化前调用）----
    store,
    // ---- UI 门面 ----
    ui: deps.ui,
    // ---- AI 域 / 上下文 / 传输辅助 ----
    ensureCurrentContextForSend: deps.ensureCurrentContextForSend,
    getProviderId: deps.getProviderId,
    getTimestampNavDeps: deps.getTimestampNavDeps,
    normalizeMarkdownForSectionPaste: deps.normalizeMarkdownForSectionPaste,
    connectPort: deps.connectPort
  });
  return { runtime, store, contextLoad };
}
