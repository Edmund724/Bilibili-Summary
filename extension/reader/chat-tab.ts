// extension/reader/chat-tab.ts — 阅读模式「AI 对话」tab 组合根（PR5）。
//
// sidepanel.ts 的 reader 等价物：工厂组装 + init 时序 + bindEvents + 页面级编排。
// 四个页面级编排函数（syncLiveContextState / ensureCurrentContextForSend /
// restartChat / renderInitialState）**整段迁自 extension/pages/sidepanel.ts**，
// 只换宿主 DOM 引用（readingChat* id）与两处 reader 语境适配（见各自函数头注），
// 分支顺序/时序咬合逐字保持——subtitle-wait 轮询、no-subtitle 拦截、pinned
// 补水、流式守卫在侧栏版被时序咬合得很紧（context-policy.ts :58-61 两个 pinned
// 谓词的疑义记录仍在），按新 UI 心态重写必引入行为漂移（盘点报告风险 4）。
//
// 组装面（与 sidepanel.ts 同构，内核全部来自 ../chat/*）：
//   conversation-store（pinned 补水的 context 解析 dep 接复合适配器：会话
//     contextRef 与当前 clip 身份一致 → 进程内快照装配（工单 04 短路，零网络
//     解析）；未命中走 ai/context-resolver 的 bgFetchJson 通道，content script
//     可用）+ context-load（createInProcessContextFetch：进程内
//     直读 state.clip，工单 08 三事已配测试）+ providers + presets +
//     subtitle-wait + no-subtitle + notices/lists/popovers（三壳重建于
//     reader/chat-{notices,lists,popovers}.ts，逻辑照抄）。URL 变化的实时上下文
//     同步调度（原 chat/context-sync.ts 的防抖状态机，工单 05 并回为本地闭包）
//     由 boc:urlchange 触发，reader 打开/关闭的恢复折叠进本组合根的激活路径。
//   - offscreen 连接：chrome.offscreen/getContexts 仅扩展上下文可用，content
//     script 经 "ensure-offscreen-chat" 消息委托 background 幂等 ensure，再
//     connect "offscreen-chat" 端口——sidepanel.ts connectPort 的自愈设计照搬。
//   - subtitleWaiter.kick 的触发源：content script 收不到自己的
//     boc-subtitle-status 广播（PR3 已核实），改订阅 shared/subtitle-status-bus
//     的进程内相位（asr-transcribing/done/failed），语义与侧栏广播监听一致。
//   - 外点关闭：popovers 的 handleDocumentClick 经 chat-tab-bridge 注册槽并入
//     ui-renderer 的单一文档级委托（风险 6，不双监听）。
//
// 生命周期（懒加载 + 会话收尾，工单 08 决议）：
//   - 二级惰性：本模块经 core/lazy-chat-tab.ts 动态装载，首次切到对话 tab（或
//     解释卡片「去对话追问」/概览笔记按钮触达 seam）才 init；
//   - 关闭阅读模式即断流（closeReadingView → closeChatSession：resetStreamState
//     断 port、pending 的 subtitle-wait 立即失效、摘全局触发源）；重开从会话
//     历史恢复（激活路径 loadContextState → restoreLatest → renderInitialState）；
//     对话 tab 的流式中关闭不做后台续跑（connectPort 的 closed 闸兜底）。
//
// 测试注意：els 在模块求值时解析（对话 tab 只在面板壳存在后装载，与 sidepanel
// 的页面加载时序同构）；模块级单例状态（chatSessionState + 本文件闭包）在测试里
// 靠 vi.resetModules 换纪元重置。

import { state } from "../core/state.js";
import { buildContextKey, doesTabMatchContextUrl } from "../ai/conversation.js";
import { escapeHtml, formatCompactTimestamp } from "../shared/string-utils.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import {
  resolveAiConversationContext,
  resolveAiConversationPageRef
} from "../ai/context-resolver.js";
import { normalizeMarkdownForSectionPaste } from "../notes/paste.js";
// 对话内核（PR5a 已迁 chat 域）：零语义搬运的工厂 + 共享状态单例。
import { createChatRuntime } from "../chat/chat-runtime.js";
import { createSubtitleWaiter, isContextPending } from "../chat/subtitle-wait.js";
import {
  NO_SUBTITLE_SEND_BLOCKED,
  buildNoSubtitleNotice,
  isNoSubtitleEmptyContext,
  type NoSubtitleReason
} from "../chat/no-subtitle.js";
import { createConversationStore } from "../chat/conversation-store.js";
import { chatSessionState } from "../chat/chat-state.js";
import { createPresetPrompts } from "../chat/presets.js";
import { createProviderPrefs } from "../chat/providers.js";
import { createContextLoad, createInProcessContextFetch, createInProcessPinnedContextResolver } from "../chat/context-load.js";
// 上下文加载失败文案：ensureCurrentContextForSend 的失败闸共用策略模块常量。
import { CONTEXT_READ_FAILED_MESSAGE, isPinnedContextTruthy } from "../chat/context-policy.js";
import { updateModelSelectWidth } from "../ui/model-select-width.js";
// reader 触发源与进程内相位（content script 收不到自己的 runtime 广播）。
import { BOC_URL_CHANGE_EVENT } from "../core/url-watcher.js";
import {
  getSubtitleStatusPhase,
  subscribeSubtitleStatusPhase
} from "../shared/subtitle-status-bus.js";
// PR3 契约：待解释意图 peek/consume/clear（消费落在本组合根）。
import {
  peekPendingExplainIntent,
  consumePendingExplainIntent,
  clearPendingExplainIntent
} from "./explain-intent.js";
// 壳三件（重建于 reader 域）+ 外点关闭桥接槽 + tab 定位 + reader ids。
import { createReaderChatLists } from "./chat-lists.js";
import { createReaderChatFeedback } from "./chat-notices.js";
import { createReaderChatPopovers } from "./chat-popovers.js";
import { setChatTabOutsideClickHandler } from "./chat-tab-bridge.js";
import { setReaderDigestTab, openReaderSettingsPanel } from "../ui/ui-renderer.js";
import { ids } from "./state.js";
// 时间戳跳转的进程内 seek（reader 域唯一定位入口，见 getTimestampNavDeps）。
import { seekReadingTarget } from "./sync.js";

const NON_VIDEO_CONTEXT_MESSAGE = "当前页非 B 站视频页面，<br>无法获取当前页面信息作为对话上下文，<br>仅支持 AI 对话。";

const els = {
  root: document.getElementById(ids.readingChatRoot) as HTMLElement,
  contextChip: document.getElementById(ids.readingChatContextChip) as HTMLButtonElement,
  refreshBtn: document.getElementById(ids.readingChatRefreshBtn) as HTMLButtonElement,
  modelSelect: document.getElementById(ids.readingChatModelSelect) as HTMLSelectElement,
  thinkingToggle: document.getElementById(ids.readingChatThinkingToggle) as HTMLElement,
  thinkingBtns: document.querySelectorAll<HTMLElement>(`#${ids.readingChatThinkingToggle} .chat-thinking-btn`),
  newChatBtn: document.getElementById(ids.readingChatNewBtn) as HTMLButtonElement,
  presetBtn: document.getElementById(ids.readingChatPresetBtn) as HTMLButtonElement,
  historyBtn: document.getElementById(ids.readingChatHistoryBtn) as HTMLButtonElement,
  toolbar: document.querySelector<HTMLElement>(`#${ids.readingChatRoot} .chat-toolbar`),
  presetPopover: document.getElementById(ids.readingChatPresetPopover) as HTMLElement,
  presetList: document.getElementById(ids.readingChatPresetList) as HTMLElement,
  presetInput: document.getElementById(ids.readingChatPresetInput) as HTMLInputElement,
  presetAddBtn: document.getElementById(ids.readingChatPresetAddBtn) as HTMLButtonElement,
  historyPopover: document.getElementById(ids.readingChatHistoryPopover) as HTMLElement,
  historyList: document.getElementById(ids.readingChatHistoryList) as HTMLElement,
  historyClearBtn: document.getElementById(ids.readingChatHistoryClearBtn) as HTMLButtonElement | null,
  messages: document.getElementById(ids.readingChatMessages) as HTMLElement,
  input: document.getElementById(ids.readingChatInput) as HTMLTextAreaElement,
  stopBtn: document.getElementById(ids.readingChatStopBtn) as HTMLButtonElement | null,
  asrNotice: document.getElementById(ids.readingChatAsrNotice) as HTMLElement | null,
  intentCard: document.getElementById(ids.readingChatIntent) as HTMLElement | null
};

function requireShell(): void {
  if (!els.root || !els.messages || !els.input) {
    throw new Error("AI 对话 tab 壳未就绪（readingChat* DOM 缺失）");
  }
}

// 无字幕视频做音频转写时，转写编排经进程内相位镜像广播阶段；刷新键转圈等待
// 期间据此显示一行转写提示，替代仅有图标旋转却没有说明的状态。只在转写阶段
// 展示，其余阶段（含转写结束后未再发布的情况）经由 setRefreshing(false) 与
// phase 判断隐藏。asr-done/asr-failed：一键总结若正在等待转写
//（subtitleWaiter.wait），立即触发一轮上下文轮询，不必等 4 秒间隔。
// （sidepanel 版监听 chrome.runtime.onMessage 的 boc-subtitle-status 广播；
// reader 与转写编排同进程收不到自己的广播，改订阅 shared/subtitle-status-bus。）
let unsubscribeStatusBus: (() => void) | null = null;

function updateAsrNotice(): void {
  if (!els.asrNotice) {
    return;
  }
  els.asrNotice.hidden = getSubtitleStatusPhase() !== "asr-transcribing";
}

function bindSubtitleStatusBus(): void {
  if (unsubscribeStatusBus) {
    return;
  }
  unsubscribeStatusBus = subscribeSubtitleStatusPhase((phase) => {
    if (phase === "asr-transcribing") {
      chatSessionState.asrTranscribingActive = true;
    } else if (phase === "asr-done" || phase === "asr-failed") {
      chatSessionState.asrTranscribingActive = false;
      subtitleWaiter.kick();
    }
    updateAsrNotice();
  });
  // 订阅不回放当前相位：按当前相位恢复提示行呈现（打开晚于转写发起的窗口）。
  updateAsrNotice();
}

function unbindSubtitleStatusBus(): void {
  unsubscribeStatusBus?.();
  unsubscribeStatusBus = null;
}

// reader 触发源：boc:urlchange（core/url-watcher 广播）→ 强刷快档（切 P/切视频
// 必须全网络重拉）。调度状态机原在 chat/context-sync.ts 的
// createLiveContextSync（工单 05 并回）：~40 行纯间接层里 reader 只消费
// onUrlChange 一个触发源（sidepanel 世界的 visibility/focus/tabs handler 无
// 调用方，onReaderOpened/Closed 的恢复折叠进激活路径 restoreChatSession），
// 单宿主现实下保留其防抖语义即可——120ms 快档，重复触发即防抖重置（触发源
// 恒为强刷，原「弱刷不覆盖强刷」的合并分支无单宿主场景）。
let urlChangeSyncTimer = 0;
let urlChangeHandler: (() => void) | null = null;

function scheduleLiveContextSync(): void {
  if (urlChangeSyncTimer) {
    window.clearTimeout(urlChangeSyncTimer);
  }
  urlChangeSyncTimer = window.setTimeout(() => {
    urlChangeSyncTimer = 0;
    void syncLiveContextState(true);
  }, 120);
}

function bindUrlChangeTrigger(): void {
  if (urlChangeHandler) {
    return;
  }
  urlChangeHandler = () => scheduleLiveContextSync();
  window.addEventListener(BOC_URL_CHANGE_EVENT, urlChangeHandler);
}

function unbindUrlChangeTrigger(): void {
  if (!urlChangeHandler) {
    return;
  }
  window.removeEventListener(BOC_URL_CHANGE_EVENT, urlChangeHandler);
  urlChangeHandler = null;
}

// 外部设置变更 → 刷新平台/偏好（与 sidepanel bindEvents 的 storage.onChanged
// 监听同语义；player-ai 信箱键的监听属摘除任务，不在 reader 消费）。
let storageChangedHandler: ((changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => void) | null = null;

function bindStorageWatcher(): void {
  if (storageChangedHandler) {
    return;
  }
  storageChangedHandler = (changes, areaName) => {
    if (
      (areaName === "sync" &&
        (changes.aiProviders || changes.aiSystemPrompt || changes.aiInitialQuickPrompts || changes.aiPresetPrompts || changes.defaultModel || changes.aiThinkingLevel)) ||
      (areaName === "local" && changes.aiProviderKeys)
    ) {
      void refreshProvidersAndPrefsAfterExternalChange();
    }
  };
  chrome.storage.onChanged.addListener(storageChangedHandler);
}

function unbindStorageWatcher(): void {
  if (!storageChangedHandler) {
    return;
  }
  chrome.storage.onChanged.removeListener(storageChangedHandler);
  storageChangedHandler = null;
}

// 跨模块共享状态（contextData / currentContextKey / providers / chatHistory /
// savedConversations / currentConversationId / currentConversationMeta /
// liveContextData / liveContextKey / liveTabUrl / aiPrefs / asrTranscribingActive /
// aiThinkingLevel）收拢在 ../chat/chat-state.ts 的 chatSessionState，本文件与各
// 子模块直接 import 读写。以下为纯局部单例。
let suggestionsNode: HTMLElement | null = null;
let initialized = false;
let initInFlight: Promise<void> | null = null;
// 会话收尾标志（closeChatSession 置位、激活路径复位）：闸住关闭后仍会兑现的
// 发送流程（subtitle-wait 等待中的 pollContext 与 connectPort），落实「关闭即
// 断流、不做后台续跑」。
let sessionClosed = false;

// 消息区反馈（通知条/居中错误/建议区清理/近底判定）：contextNoticeTimer 是
// notices 模块闭包私有状态；定时器用 window（测试可注入 fake）。
const feedback = createReaderChatFeedback({
  messages: els.messages,
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => window.clearTimeout(handle),
  scrollToBottom: () => chatRuntime.scrollToBottom(),
  getSuggestionsNode: () => suggestionsNode,
  setSuggestionsNode: (node) => {
    suggestionsNode = node;
  },
  // digest-only-ui：提示条「前往设置」打开侧边栏设置抽屉（open-options 已删）
  onOpenSettings: () => openReaderSettingsPanel()
});
const {
  showConversationContextNotice,
  removeConversationContextNotice,
  showConversationContextError,
  removeCenteredState,
  removeSuggestions,
  isMessagesNearBottom
} = feedback;

// 会话状态（会话列表/当前会话/上下文）已收拢至 chatSessionState，store 直接
// import 读写；deps 只剩上下文获取 dep、三个能力事件与 storage 抽象（工单 05
// 渲染编排反转：store 自己编排渲染时机，本组合根只订阅结果——历史列表恒随
// onConversationChanged 重渲，标志驱动 chip/popover/视图重建）。
// pinned 补水的 context 解析（工单 04 身份短路）接在 resolveAiConversationRef
// 的 purpose="context" 用途上：会话 contextRef 与当前 clip 一致 → 进程内快照
// 装配（零网络解析、不重下字幕正文）；未命中（换视频/换分P/换轨/无页面）→
// ai/context-resolver 的网络路径原样兜底。
const resolveConversationContext = createInProcessPinnedContextResolver({
  clip: () => state.clip,
  settings: () => state.settings,
  resolveNetwork: resolveAiConversationContext
});
const conversationStore = createConversationStore({
  loadContextState: (opts) => contextLoad.loadContextState(opts),
  resolveAiConversationRef: (contextRef, purpose) =>
    purpose === "page" ? resolveAiConversationPageRef(contextRef) : resolveConversationContext(contextRef),
  onConversationChanged: (change) => {
    lists.renderHistoryList();
    if (change.refreshContextChip) {
      contextLoad.updateContextChip();
    }
    if (change.historyCleared) {
      popovers.hideHistoryPopover();
    }
    if (change.resetView) {
      renderInitialState();
    }
  },
  // 流式中删除当前会话 / 清空全部 / restoreLatest 无匹配时由 store 同步发出：
  // 断 port、清在途一问一答、清消息区并退出流式 UI 态（对应 restartChat 的
  // 清理动作，但不清会话状态——那由 store 自己做）。store 不直接 import
  // chatRuntime，依赖方向由本文件组装；回调幂等（非流式时为无害空操作）。
  onStreamInterrupted: () => {
    chatRuntime.resetStreamState();
    resetConversationView();
    setStreamingUiState(false);
  },
  onContextNotice: (notice) => {
    if (notice.kind === "pending") {
      showConversationContextNotice(notice.message);
    } else if (notice.kind === "clear") {
      removeConversationContextNotice();
    } else {
      showConversationContextError(notice.message);
    }
  },
  storage: chrome.storage.local
});

// 三列表渲染（建议/预设/历史）+ 预设提示词插入。insertPresetPrompt /
// hidePresetPopover / hideHistoryPopover 与本实例/popovers 实例互引，惰性
// 箭头接线（回调执行时实例已存在）。
const lists = createReaderChatLists({
  presetList: els.presetList,
  historyList: els.historyList,
  historyClearBtn: els.historyClearBtn,
  input: els.input,
  applyById: (id) => conversationStore.applyById(id),
  deleteById: (id) => conversationStore.deleteById(id),
  removePresetPrompt: (index) => presets.removePresetPrompt(index),
  autosizeInput,
  onSuggestionClick: () => chatRuntime.sendMessage(),
  getSuggestionsNode: () => suggestionsNode,
  insertPresetPrompt: (prompt) => lists.insertPresetPrompt(prompt),
  hidePresetPopover: () => popovers.hidePresetPopover(),
  hideHistoryPopover: () => popovers.hideHistoryPopover()
});

// 预设/历史 popover 开合；文档级外点关闭经 chat-tab-bridge 并入 ui-renderer 的
// 单一 document click 委托（组合根在激活/收尾时注册/摘除，见 bindGlobalTriggers）。
const popovers = createReaderChatPopovers({
  presetPopover: els.presetPopover,
  historyPopover: els.historyPopover,
  presetBtn: els.presetBtn,
  historyBtn: els.historyBtn,
  presetInput: els.presetInput,
  renderPresetPrompts: () => lists.renderPresetPrompts(),
  renderHistoryList: () => lists.renderHistoryList()
});

// 上下文状态加载（读当前页状态 → 按策略动作执行编排副作用）+ context chip。
// 流式守卫判定惰性取 chatRuntime（回调执行时实例已存在）。
// PR5：拉数据一段为 ContextFetch 策略注入——reader 与 content 同进程，用
// createInProcessContextFetch 直读 state.clip（不走扩展页消息链）。
const contextLoad = createContextLoad({
  fetchContext: createInProcessContextFetch({
    clip: () => state.clip,
    settings: () => state.settings
  }),
  contextChip: els.contextChip,
  renderHistoryList: () => lists.renderHistoryList(),
  renderInitialState,
  renderSuggestions: () => lists.renderSuggestions(),
  resetConversationView,
  restartChat: (opts) => restartChat(opts),
  restoreLatest: () => conversationStore.restoreLatest(),
  isStreaming: () => chatRuntime.isStreaming(),
  hasPendingUserPrompt: () => chatRuntime.hasPendingUserPrompt()
});
const { loadContextState, updateContextChip } = contextLoad;

// chat 流状态机：自身流状态（activePort 等）与自动滚动标志（shouldAutoScroll-
// Messages）都在 runtime 闭包内；会话状态读 chatSessionState；deps 只剩 DOM
// 容器/元素引用、store 实例与 UI/transport 回调。
const chatRuntime = createChatRuntime({
  // ---- DOM 容器 / 元素引用（本文件模块级 `els`）----
  messages: els.messages,
  input: els.input,
  stopBtn: els.stopBtn,
  // ---- conversation-store 窄接口（实例；isCurrent 为会话身份守卫的单一判定
  // 点，chat-runtime finalize/stopped 持久化前调用）----
  store: conversationStore,
  // ---- UI 门面（布局 / UI 回调的纯分组，DOM 布局留在本组合根）----
  ui: {
    setStreamingUiState,
    showConversationContextNotice,
    removeConversationContextNotice,
    hidePresetPopover: () => popovers.hidePresetPopover(),
    hideHistoryPopover: () => popovers.hideHistoryPopover(),
    removeCenteredState,
    removeSuggestions,
    resetConversationView,
    autosizeInput
  },
  // ---- AI 域 / 上下文 / 传输辅助 ----
  ensureCurrentContextForSend,
  getProviderId: () => els.modelSelect.value,
  getTimestampNavDeps,
  normalizeMarkdownForSectionPaste,
  // 发送前 ensure offscreen 文档再连端口：文档死亡后自愈重建（ensure 失败
  // 不阻断 connect，维持历史行为，由连接结果兜底）。chrome.offscreen 仅扩展
  // 上下文可用：content script 经 "ensure-offscreen-chat" 消息委托 background
  // 幂等 ensure（sidepanel 直调同款自愈设计的 reader 通道）。关闭会话后不再
  // 发起流（工单 08：关闭即断流，不做后台续跑）。
  connectPort: async () => {
    if (sessionClosed) {
      throw new Error("阅读模式已关闭，对话已中止。");
    }
    await sendRuntimeMessage({ type: "ensure-offscreen-chat" }).catch(() => null);
    return chrome.runtime.connect({ name: "offscreen-chat" });
  }
});

// 预设提示词 CRUD（deps 注入本文件的编排回调与 DOM 引用）。
const presets = createPresetPrompts({
  presetInput: els.presetInput,
  renderPresetPrompts: () => lists.renderPresetPrompts()
});

// AI 平台加载渲染 + 思考档位（widthEls 即本文件模块级 `els`，含度量所需的
// toolbar/thinkingToggle/presetBtn）；persistAiPresetPrompts 惰性互引 presets。
const providerPrefs = createProviderPrefs({
  modelSelect: els.modelSelect,
  thinkingBtns: els.thinkingBtns,
  widthEls: els,
  renderPresetPrompts: () => lists.renderPresetPrompts(),
  persistAiPresetPrompts: () => presets.persistAiPresetPrompts()
});
const { loadProvidersAndPrefs, setThinkingLevel } = providerPrefs;

// 抓取/音频转写进行中（content 的 subtitleFetchState 为 loading 且字幕体为空）
// 时等待其完成再放行发送流程，状态机本体在 ../chat/subtitle-wait.ts（可测）。
// 这里只组装 deps：轮询读当前上下文、提示走消息区 notice、定时器用 window。
// 引用的 loadContextState / 通知函数都是组装后的实例方法（惰性接线）。
const SUBTITLE_WAIT_POLL_MS = 4000;
const subtitleWaiter = createSubtitleWaiter({
  pollIntervalMs: SUBTITLE_WAIT_POLL_MS,
  pollContext: async () => {
    // 会话已收尾：立即失败放行（wait 兑现 false → 发送流程提前返回），
    // 不让关闭后的后台轮询继续养着一次「迟早会发」的发送。
    if (sessionClosed) {
      return { ok: false, pending: false };
    }
    const ok = await loadContextState({ forceRefresh: false, silent: true }).catch(() => false);
    // loadContextState 无论走哪个分支都会先更新 liveContextData；等待期间
    // 可能有流式守卫冻结 contextData，读 liveContextData 保证数据不断供。
    const snapshot = ok ? (chatSessionState.liveContextData || chatSessionState.contextData) : null;
    return {
      ok: Boolean(snapshot),
      pending: isContextPending(snapshot, { asrTranscribingActive: chatSessionState.asrTranscribingActive })
    };
  },
  showWaitingNotice: () => showConversationContextNotice("正在等待音频转写完成，完成后自动开始总结…", 0),
  removeNotice: removeConversationContextNotice,
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => window.clearTimeout(handle)
});

// ============================================================
// 激活 / 会话收尾（对外入口，经 core/lazy-chat-tab 暴露）
// ============================================================

function bindGlobalTriggers(): void {
  bindSubtitleStatusBus();
  bindUrlChangeTrigger();
  bindStorageWatcher();
  // 外点关闭单委托：注册进 ui-renderer 的文档级 click 委托（chat-tab-bridge）。
  setChatTabOutsideClickHandler(popovers.handleDocumentClick);
}

function unbindGlobalTriggers(): void {
  unbindSubtitleStatusBus();
  unbindUrlChangeTrigger();
  unbindStorageWatcher();
  setChatTabOutsideClickHandler(null);
}

async function initChatTab({ consumeIntent }: { consumeIntent: boolean }): Promise<void> {
  requireShell();
  bindEvents();
  bindGlobalTriggers();
  // 创建 Offscreen Document（经 background 委托），把 SSE 流式请求移到隐藏页面。
  // 与每次聊天发送前（connectPort）复用：文档意外死亡后下一封消息自动重建，
  // 聊天不再静默坏到面板重开。ensure 失败不阻断 init（catch 吞掉）。
  await sendRuntimeMessage({ type: "ensure-offscreen-chat" }).catch(() => null);
  await loadProvidersAndPrefs();
  await conversationStore.loadAll();
  await loadContextState();
  await conversationStore.restoreLatest();
  renderInitialState();
  autosizeInput();
  initialized = true;
  // PR3 契约消费：有待解释意图 → 渲染引用卡 + 自动发送（发送成功即 consume）。
  // 快捷动作路径传 consumeIntent:false 跳过（与快捷发送互不踩踏）。
  if (consumeIntent) {
    await consumeExplainIntentIfPending();
  }
}

// 重开/重进的恢复路径（工单 08：重开从会话历史恢复）：静默重取上下文（签名
// 短路便宜）→ 恢复匹配当前上下文的最近会话 → 按会话历史重渲消息区（顺带清掉
// 关闭时残留的流式半截节点）。
async function restoreChatSession(): Promise<void> {
  const ok = await loadContextState({ forceRefresh: false, silent: true }).catch(() => false);
  if (!ok) {
    return;
  }
  await conversationStore.restoreLatest();
  renderInitialState();
  autosizeInput();
}

export async function ensureChatTabActivated({ consumeIntent = true }: { consumeIntent?: boolean } = {}): Promise<void> {
  if (!initialized) {
    if (!initInFlight) {
      initInFlight = initChatTab({ consumeIntent }).finally(() => {
        initInFlight = null;
      });
    }
    await initInFlight;
    return;
  }
  if (sessionClosed) {
    sessionClosed = false;
    bindGlobalTriggers();
    await restoreChatSession();
  }
  // 已初始化的普通激活（tab 切回）：消费可能新写入的待解释意图（解释卡片
  // 「去对话追问」在对话 tab 已装载时点击 / 上次挂起的意图重试）。无意图时为无害 no-op。
  if (consumeIntent) {
    await consumeExplainIntentIfPending();
  }
}

export function closeChatSession(): void {
  if (!initialized) {
    return;
  }
  sessionClosed = true;
  // 断流收口（chat-runtime 断连路径已兜底 UI 态）：断 port、清在途一问一答与
  // 慢响应计时器；未流式时为无害空操作。
  chatRuntime.resetStreamState();
  setStreamingUiState(false);
  // 挂起中的 subtitle-wait 立即失效（pollContext 的 closed 闸 → wait 兑现
  // false → 发送流程提前返回并清等待提示）。
  subtitleWaiter.kick();
  popovers.hidePresetPopover();
  popovers.hideHistoryPopover();
  removeConversationContextNotice();
  updateAsrNotice();
  // 会话收尾（意图已被 lifecycle.clearPendingExplainIntent 清掉）：引用卡随之
  // 隐藏，下次激活按无意图渲染。
  hideExplainIntentCard();
  unbindGlobalTriggers();
}

// ============================================================
// player-ai 快捷动作消费 seam（工单 08 决议：阅读模式内点击 = 定位/聚焦对话
// tab + 自动发送快捷提示词；PR4b 概览「生成完整笔记」按钮同 seam 直发）
// ============================================================

export async function runQuickActionPrompt(prompt: string): Promise<boolean> {
  // 定位/聚焦对话 tab（不触达字幕 tab 的滚动状态）。
  setReaderDigestTab("chat");
  // 首次调用完成装载；已装载时为幂等 no-op（不消费待解释意图——与快捷动作
  // 发送互不踩踏）。
  await ensureChatTabActivated({ consumeIntent: false });
  const text = String(prompt || "").trim();
  if (!text) {
    autosizeInput();
    els.input?.focus?.();
    return false;
  }
  await startNewConversation();
  els.input.value = text;
  autosizeInput();
  await chatRuntime.sendMessage();
  // 受理成功 = 发送路径清空了输入框（ensureCurrentContextForSend 通过后才会
  // 清）；false = 被 provider/上下文/无字幕闸拦下（notice 已显示）。
  return els.input.value === "" || chatRuntime.hasPendingUserPrompt();
}

// ============================================================
// PR3 契约消费：待解释意图 → 引用卡（时间戳 pill 母题）+ 自动发送
// ============================================================

// 解释提示词模板：引用句 + 时间戳 pill 文案，发送出去的消息自带引用上下文。
// 两种口径：卡片「去对话追问」带选中片段 → 解释这个词句；整句意图（无
// selection）→ 解释这句字幕。
function buildExplainPrompt(intent: { from: number; content: string; selection?: string }): string {
  const stamp = formatCompactTimestamp(intent.from, intent.from >= 3600);
  if (intent.selection) {
    return `请结合视频上下文解释我选中的词句：「${intent.selection}」。它出自字幕句「${intent.content}」（${stamp}）。说明它的含义、背景，以及在这句话里指什么。`;
  }
  return `请结合视频上下文解释这句字幕：「${intent.content}」（${stamp}）。说明它的含义、背景，以及与前后文的关系。`;
}

function renderExplainIntentCard(intent: { from: number; content: string; selection?: string }): void {
  if (!els.intentCard) {
    return;
  }
  const quote = els.intentCard.querySelector<HTMLElement>(".boc-reading-chat-intent-quote");
  if (quote) {
    quote.textContent = intent.selection ? `「${intent.selection}」｜${intent.content}` : `「${intent.content}」`;
  }
  const stamp = els.intentCard.querySelector<HTMLElement>(".boc-reading-chat-intent-time");
  if (stamp) {
    stamp.textContent = formatCompactTimestamp(intent.from, intent.from >= 3600);
  }
  els.intentCard.hidden = false;
}

function hideExplainIntentCard(): void {
  if (els.intentCard) {
    els.intentCard.hidden = true;
  }
}

// peek 意图 → 渲染引用卡 → 自动发送解释提示词；发送成功（发送流程受理）才
// consumePendingExplainIntent——一次意图只发一次。发送被 subtitle-wait 挂起时
// sendMessage 的 promise 不提前兑现（等待在其内部 await），意图保持 pending
// 直到真正发出或用户取消（引用卡上的取消按钮）。
async function consumeExplainIntentIfPending(): Promise<void> {
  const intent = peekPendingExplainIntent();
  if (!intent || !intent.content) {
    hideExplainIntentCard();
    return;
  }
  renderExplainIntentCard(intent);
  const sent = await autoSendPrompt(buildExplainPrompt(intent));
  if (sent) {
    consumePendingExplainIntent();
    hideExplainIntentCard();
  }
}

// 自动发送共用体：填输入框 → sendMessage → 折算是否受理。流式中/有待发 prompt
// 时不注入第二次发送（双发竞态闸也会拦下），返回 false 让意图保持 pending。
async function autoSendPrompt(text: string): Promise<boolean> {
  if (!text.trim()) {
    return false;
  }
  if (chatRuntime.isStreaming() || chatRuntime.hasPendingUserPrompt()) {
    return false;
  }
  els.input.value = text;
  autosizeInput();
  await chatRuntime.sendMessage();
  // sendMessage 兑现即发送流程已出结果（subtitle-wait 挂起在其内部 await）。
  // 受理成功 = 发送路径清空了输入框（ensure 通过后才会清）。
  return els.input.value === "" || chatRuntime.hasPendingUserPrompt();
}

// ============================================================
// bindEvents（元素级绑定；全局触发源见 bindGlobalTriggers）
// ============================================================

function bindEvents(): void {
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      chatRuntime.sendMessage();
    }
  });
  els.input.addEventListener("input", autosizeInput);
  els.messages.addEventListener("scroll", () => {
    chatRuntime.setAutoScroll(isMessagesNearBottom());
  });
  els.contextChip.addEventListener("click", () => {
    void openCurrentContextInReader();
  });
  els.newChatBtn.addEventListener("click", () => {
    void startNewConversation();
  });
  els.refreshBtn.addEventListener("click", () => refreshContextManually());
  els.presetBtn.addEventListener("click", popovers.togglePresetPopover);
  els.historyBtn.addEventListener("click", popovers.toggleHistoryPopover);
  els.historyClearBtn?.addEventListener("click", () => {
    void conversationStore.clearAll();
  });
  els.stopBtn?.addEventListener("click", () => {
    chatRuntime.stopActiveStream();
  });
  els.presetAddBtn.addEventListener("click", () => presets.addPresetPrompt());
  els.presetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      presets.addPresetPrompt();
    }
  });
  els.modelSelect.addEventListener("change", () => {
    const providerId = els.modelSelect.value;
    if (providerId) {
      // 选中平台的持久化通道 = chrome.storage.local（providers 模块的
      // setSelectedProvider）；sync settings 的 defaultModel 双写与 sidepanel 一致。
      providerPrefs.setSelectedProvider(providerId);
      chatSessionState.aiPrefs.defaultModel = providerId;
      chrome.storage.sync.set({ defaultModel: providerId }).catch(() => {});
    } else {
      chatSessionState.aiPrefs.defaultModel = "";
      chrome.storage.sync.set({ defaultModel: "" }).catch(() => {});
    }
    updateModelSelectWidth(els);
  });
  els.thinkingBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      void setThinkingLevel(btn.dataset.level || "off");
    });
  });
  window.addEventListener("resize", onWindowResize);
  // 引用卡取消（容器层委托：对话 tab 根节点上的 [data-chat-intent-action] 点击，
  // 对齐 batched-render 头注的容器委托先例）。
  els.root.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-chat-intent-action]");
    if (!target || target.dataset.chatIntentAction !== "cancel") {
      return;
    }
    clearPendingExplainIntent();
    hideExplainIntentCard();
  });
}

function onWindowResize(): void {
  updateModelSelectWidth(els);
}

// chip 点击的 reader 适配（sidepanel 版为 openCurrentContextUrl：chrome.tabs.update
// 跳转活动标签页）。content script 无 chrome.tabs：同视频只做静默强刷；绑定会话
// 指向别的视频时页内导航到目标 URL（保留 boc_reader=1，阅读模式随 URL 恢复）。
async function openCurrentContextInReader(): Promise<void> {
  const targetUrl = String(chatSessionState.contextData?.url || chatSessionState.currentConversationMeta?.contextUrl || "").trim();
  if (!targetUrl) {
    return;
  }
  try {
    if (doesTabMatchContextUrl(location.href, targetUrl)) {
      await loadContextState({ forceRefresh: true, silent: true });
      return;
    }
    let next = targetUrl;
    try {
      const parsed = new URL(targetUrl);
      parsed.searchParams.set("boc_reader", "1");
      next = parsed.toString();
    } catch {}
    location.href = next;
  } catch {}
}

function autosizeInput(): void {
  els.input.style.height = "auto";
  const next = Math.min(els.input.scrollHeight, 320);
  const minHeight = els.root.classList.contains("chat-non-video-context") ? 72 : 94;
  els.input.style.height = `${Math.max(next, minHeight)}px`;
}

function setStreamingUiState(isStreaming: boolean, { stopping = false }: { stopping?: boolean } = {}): void {
  els.input.disabled = isStreaming;
  if (els.stopBtn) {
    els.stopBtn.hidden = !isStreaming;
    els.stopBtn.disabled = stopping;
    els.stopBtn.textContent = stopping ? "停止中..." : "停止";
  }
}

// AI 平台 / 预设：实现在 ../chat/providers.ts，本文件只组装 deps 并保留「外部
// 设置变更 → 刷新」编排（流式守卫 + 重渲染留在组合根）。
async function refreshProvidersAndPrefsAfterExternalChange(): Promise<void> {
  // 选中平台回退取 providers 模块的 storage 闭包缓存。
  const previousProviderId = String(els.modelSelect?.value || providerPrefs.getStoredSelectedProviderId() || "").trim();
  await loadProvidersAndPrefs({ preferredProviderId: previousProviderId });
  if (chatRuntime.isStreaming()) {
    return;
  }
  lists.renderHistoryList();
  renderInitialState();
}

// ============================================================
// 上下文状态加载 / context chip：编排壳在 ../chat/context-load.ts（策略判定在
// ../chat/context-policy.ts）；下方为整段迁自 sidepanel.ts 的页面级编排函数。
// ============================================================

// 【整段迁移自 sidepanel.ts】post-sync 分支编排：流式守卫 + 三个渲染回调。
async function syncLiveContextState(forceRefresh = false): Promise<void> {
  const ok = await loadContextState({ forceRefresh, silent: true }).catch(() => false);
  if (chatSessionState.currentConversationMeta?.pinnedContext || chatRuntime.isStreaming() || chatRuntime.hasPendingUserPrompt()) {
    updateContextChip();
    return;
  }
  if (!ok || !chatSessionState.contextData || !chatSessionState.providers.length || !chatSessionState.chatHistory.length) {
    renderInitialState();
    return;
  }
  lists.renderSuggestions();
}

// 【整段迁移自 sidepanel.ts】初始态渲染：无上下文 / 无平台 / 会话回放 / 非视频
// 四态分支逐字保持；无平台分支的「前往设置」换 readingChatOpenSettings id——
// 点击绑定上收在 ui-renderer（打开侧边栏设置抽屉；open-options 消息已删除）。
function renderInitialState(): void {
  updateChatLayoutState();
  if (!chatSessionState.contextData) {
    resetConversationView("当前页面不是 B 站视频页，无法读取视频信息。");
    return;
  }
  if (!chatSessionState.providers.length) {
    resetConversationView(`还没有配置 AI 平台，<a href="#" id="${ids.readingChatOpenSettings}">前往设置</a>`);
    return;
  }
  if (chatSessionState.chatHistory.length) {
    renderConversationMessages();
    return;
  }
  if (chatSessionState.contextData.isVideoContext === false) {
    resetConversationView(NON_VIDEO_CONTEXT_MESSAGE);
    return;
  }
  resetConversationView("");
}

// 【迁移自 sidepanel.ts resetConversationView】消息区重建 + 建议区/预设列表刷新。
function resetConversationView(stateHtml = ""): void {
  updateChatLayoutState();
  els.messages.innerHTML = "";
  if (stateHtml) {
    const stateNode = document.createElement("div");
    stateNode.className = "chat-center-error";
    stateNode.innerHTML = stateHtml;
    els.messages.appendChild(stateNode);
  }
  suggestionsNode = document.createElement("div");
  suggestionsNode.className = "chat-suggestions";
  suggestionsNode.id = ids.readingChatSuggestions;
  els.messages.appendChild(suggestionsNode);
  lists.renderSuggestions();
  lists.renderPresetPrompts();
  chatRuntime.setAutoScroll(true);
  chatRuntime.scrollToBottom(true);
}

// 【整段迁移自 sidepanel.ts】布局状态：紧凑输入判定写在对话 tab 根元素
//（sidepanel 写 document.body 的 chat-non-video-context）。
function updateChatLayoutState(): void {
  const useCompactInput = Boolean(
    chatSessionState.contextData &&
    chatSessionState.contextData.isVideoContext === false &&
    !chatSessionState.chatHistory.length &&
    !chatSessionState.currentConversationMeta?.pinnedContext
  );
  els.root.classList.toggle("chat-non-video-context", useCompactInput);
  if (els.input) {
    autosizeInput();
  }
}

// 【整段迁移自 sidepanel.ts】手动刷新（含刷新键 loading 与转写提示收尾）。
async function refreshContextManually(): Promise<void> {
  if (els.refreshBtn.disabled) {
    return;
  }
  setRefreshing(true);
  try {
    const ok = await loadContextState({ forceRefresh: true });
    if (ok) {
      if (!chatSessionState.contextData || !chatSessionState.providers.length || !chatSessionState.chatHistory.length) {
        renderInitialState();
      } else {
        lists.renderSuggestions();
      }
    }
  } finally {
    setRefreshing(false);
  }
}

function setRefreshing(isRefreshing: boolean): void {
  els.refreshBtn.disabled = isRefreshing;
  els.refreshBtn.classList.toggle("is-loading", isRefreshing);
  if (isRefreshing) {
    els.refreshBtn.setAttribute("aria-busy", "true");
  } else {
    els.refreshBtn.removeAttribute("aria-busy");
    // 刷新结束即转写（若有）收尾，收起“正在音频转写”提示（非转写相位时隐藏）。
    updateAsrNotice();
  }
}

// 【整段迁移自 sidepanel.ts】开启新会话：隐藏 popover → 强刷静默取上下文 →
// live 快照落地主上下文 → restartChat(keepContext) → 初始态渲染。
async function startNewConversation(): Promise<void> {
  popovers.hidePresetPopover();
  popovers.hideHistoryPopover();
  setRefreshing(true);
  try {
    await loadContextState({ forceRefresh: true, silent: true });
  } finally {
    setRefreshing(false);
  }
  if (chatSessionState.liveContextData) {
    chatSessionState.contextData = { ...chatSessionState.liveContextData };
    chatSessionState.currentContextKey = chatSessionState.liveContextKey || buildContextKey(chatSessionState.liveContextData);
    updateContextChip();
  }
  restartChat({ keepContext: true });
  renderInitialState();
}

// ============================================================
// 消息区渲染（历史对话回放 → chat-runtime 渲染）
// ============================================================
function renderConversationMessages(): void {
  updateChatLayoutState();
  els.messages.innerHTML = "";
  suggestionsNode = null;
  if (!chatSessionState.chatHistory.length) {
    resetConversationView("");
    return;
  }
  chatSessionState.chatHistory.forEach((message, index) => {
    if (message.role === "user") {
      chatRuntime.appendUserMessage(message.content, false);
      return;
    }
    const node = document.createElement("div");
    node.className = "chat-msg chat-msg-assistant";
    chatRuntime.renderAssistantMessage(node, String(message.content || ""), {
      userPrompt: findPreviousUserPrompt(index)
    });
    els.messages.appendChild(node);
  });
  chatRuntime.setAutoScroll(true);
  chatRuntime.scrollToBottom(true);
}

// 历史回放时找该助手消息的前一条用户消息（注入 renderAssistantMessage 的 userPrompt）
function findPreviousUserPrompt(index: number): string {
  for (let i = Number(index) - 1; i >= 0; i -= 1) {
    const item = chatSessionState.chatHistory[i];
    if (item?.role === "user" && typeof item.content === "string") {
      return item.content;
    }
  }
  return "";
}

// 【整段迁移自 sidepanel.ts】发送前确保当前上下文就绪（pinned 对话补水 / 普通
// 对话读当前页；抓取或音频转写进行中时先等待，避免空字幕上下文直接发给模型）。
// 最终快照若是「无字幕收尾」（empty 且字幕体为空）则拦截发送：返回
// NO_SUBTITLE_SEND_BLOCKED 类型化信号让 sendMessage 提前返回（不追加用户消息、
// 不落 chatHistory、不发起 port），并按 noSubtitleReason 显示对应 notice。
async function ensureCurrentContextForSend(): Promise<boolean | string> {
  // pinned 判定沿用本调用点的原始语义（真值判断，与 loadContextState 的严格
  // 相等不同——见 ../chat/context-policy.ts 两个谓词的疑义记录）。
  if (isPinnedContextTruthy(chatSessionState.currentConversationMeta)) {
    await loadContextState({ forceRefresh: false, silent: true }).catch(() => null);
    return conversationStore.hydratePinned();
  }
  // 失败闸把「无标签页」与「读取失败」合并为同一文案（与策略模块的
  // resolveNoTabPlan 语义不同：这里即使静默加载也会重置视图），保持原状。
  const ok = await loadContextState({ forceRefresh: false, silent: true });
  if (!ok || !chatSessionState.contextData) {
    resetConversationView(CONTEXT_READ_FAILED_MESSAGE);
    return false;
  }
  const ready = await subtitleWaiter.wait();
  if (!ready) {
    resetConversationView(CONTEXT_READ_FAILED_MESSAGE);
    return false;
  }
  // 等待期间 contextData 可能停在旧快照（守卫分支或就绪瞬间），放行前重取
  // 一次，确保发送出去的是转写完成后的完整字幕。
  await loadContextState({ forceRefresh: false, silent: true }).catch(() => null);
  if (!chatSessionState.contextData) {
    resetConversationView(CONTEXT_READ_FAILED_MESSAGE);
    return false;
  }
  if (isNoSubtitleEmptyContext(chatSessionState.contextData)) {
    const notice = buildNoSubtitleNotice(chatSessionState.contextData.noSubtitleReason as NoSubtitleReason);
    showConversationContextNotice(notice.message, 0, { openSettingsAction: notice.openSettings });
    return NO_SUBTITLE_SEND_BLOCKED;
  }
  return true;
}

// 时间戳跳转依赖包（注入 timestamp-nav）。reader 适配：seek 走进程内直调
// seekReadingTarget（reader 域唯一定位入口，content script 无 chrome.tabs 消息
// 链），deps 形状保持 timestamp-nav 契约——getActiveTab 恒返回当前页伪 tab、
// matchContextUrl 恒 true（同一页面）、sendMessageToActiveTab 折算成 seek 回包。
function getTimestampNavDeps() {
  return {
    contextUrl: String(chatSessionState.contextData?.url || chatSessionState.currentConversationMeta?.contextUrl || "").trim(),
    notice: showConversationContextNotice,
    getActiveTab: async () => ({ id: 0, url: location.href }),
    matchContextUrl: () => true,
    sendMessageToActiveTab: async (_tabId: number, message: unknown) => {
      const seconds = Number((message as { seconds?: unknown } | null)?.seconds ?? 0);
      const applied = seekReadingTarget(seconds);
      return applied === null ? { ok: false, error: "视频时间跳转失败" } : { ok: true };
    }
  };
}

// 【整段迁移自 sidepanel.ts】重启对话：清流状态 + 清会话状态 + 重置消息区
//（编排入口，被新对话/上下文切换复用）。
function restartChat({ keepContext = false }: { keepContext?: boolean } = {}): void {
  chatRuntime.resetStreamState();
  chatSessionState.chatHistory = [];
  chatSessionState.currentConversationId = "";
  chatSessionState.currentConversationMeta = null;
  if (!keepContext) {
    chatSessionState.currentContextKey = buildContextKey(chatSessionState.contextData);
  }
  updateContextChip();
  resetConversationView("");
  setStreamingUiState(false);
  els.input.value = "";
  autosizeInput();
}
