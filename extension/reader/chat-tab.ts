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
// 组装面（与 sidepanel.ts 同构；内核链五件自 arch-review-2026-09/08 起收进
// ../chat/tab-domain.ts 的 createChatTabDomain 单一深入口，本文件 chat 域
// import 面 10→1）：
//   conversation-store（pinned 补水的 context 解析 dep 接复合适配器：会话
//     contextRef 与当前 clip 身份一致 → 进程内快照装配（工单 04 短路，零网络
//     解析）；未命中走 ai/context-resolver 的 bgFetchJson 通道，content script
//     可用）+ context-load（编排壳）+ 装配链（createInProcessContextFetch /
//     createInProcessPinnedContextResolver：AiContext 装配唯一入口，工单 07
//     收口到 core/context-assembly，锚定 context-payload 的形状/签名单源；
//     工单 08 三事已配测试）+ providers + presets +
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
//   - 二级惰性：本模块经 reader/lazy-chat-tab.ts 动态装载，首次切到对话 tab（或
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
import { buildReaderModeUrl } from "../bilibili/reader-url.js";
import { buildContextKey, doesTabMatchContextUrl } from "../ai/conversation.js";
// 思考档位「关不掉」提示的判定入口（工单 03）：纯查表 resolver，host 推断 +
// 模型名 taxonomy，无 DOM 依赖（后台路径同款判定天然不渲染提示）。
import { resolveThinkingProfile } from "../ai/thinking-profiles.js";
import { formatClock } from "../shared/clock-text.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import { normalizeMarkdownForSectionPaste } from "../notes/paste.js";
// 对话域单一深入口（arch-review-2026-09/08）：内核链五件（pinned 补水解析器 +
// conversation-store + context-load（含内联 createInProcessContextFetch 进程内
// 直读装配策略）+ chat-runtime）在 ../chat/tab-domain.ts 组装；chat 域其余出口
//（状态单例、subtitle-wait、no-subtitle 文案、context-policy 谓词、offscreen
// 端口名、presets/providers 工厂）统一经该门面转出——本文件的 chat 域 import
// 面收敛为一处（10 → 1）。
import {
  CONTEXT_READ_FAILED_MESSAGE,
  NO_SUBTITLE_SEND_BLOCKED,
  OFFSCREEN_CHAT_PORT_NAME,
  buildNoSubtitleNotice,
  chatSessionState,
  createChatTabDomain,
  createPresetPrompts,
  createProviderPrefs,
  createSubtitleWaiter,
  isContextPending,
  isNoSubtitleEmptyContext,
  isPinnedContextTruthy,
  type NoSubtitleReason
} from "../chat/tab-domain.js";
import { updateModelSelectWidth } from "../chat/model-select-width.js";
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
// 壳命令通道（arch-review-2026-09/10 依赖反转）：快捷动作定位对话 tab 与空态
// 「前往设置」改发 reader-bus 具名命令，由 ui-renderer 注册的 handler 执行——
// 本文件不再静态 import ui/ui-renderer。
import { requestUiCommand } from "./reader-bus.js";
// 对话分区表模块顶兜底挂载（arch-slim-4/07，settings-panel.ts 顶挂载同款先例）：
// 主点在 ui-renderer setReaderDigestTab 的 chat 分支（盖住现役三入口），此处盖
// 住未来新入口——本模块被动态装载即样式在场；ensure 内部 mounted Map 去重。
import { ensureReaderChatStyles } from "../shared/style-injector.js";

ensureReaderChatStyles();

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
  // 思考档位「关不掉」提示行（工单 03，模板默认 hidden）
  thinkingHint: document.getElementById(ids.readingChatThinkingHint) as HTMLElement | null,
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

// 无字幕转写提示：本行只在转写相位（含等待发送期间）显示。原实现等待发送时在
// 消息区另起一条 .chat-context-notice（「正在等待音频转写完成…」），与状态行
// 「该视频无字幕，正在音频转写…」同屏重复——现按相位路由：转写相位下等待期并入
// 本行切换为合并句（唯一提示），非转写相位的等待（字幕抓取进行中）沿用消息区
// 通知（该场景状态行隐藏，无重复）。
const ASR_TRANSCRIBING_NOTICE = "该视频无字幕，正在音频转写…";
const ASR_WAITING_NOTICE = "该视频无字幕，正在音频转写，完成后自动开始总结…";
const SUBTITLE_WAIT_NOTICE = "正在等待音频转写完成，完成后自动开始总结…";
let asrWaitingActive = false;

function updateAsrNotice(): void {
  if (!els.asrNotice) {
    return;
  }
  els.asrNotice.hidden = getSubtitleStatusPhase() !== "asr-transcribing" && !asrWaitingActive;
  els.asrNotice.textContent = asrWaitingActive ? ASR_WAITING_NOTICE : ASR_TRANSCRIBING_NOTICE;
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
    if (phase !== "asr-transcribing") {
      // 转写相位结束：状态行从合并句回落基础句/隐藏，等待提示回消息区通知。
      asrWaitingActive = false;
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
// 区/键过滤经 shared/watch-storage-keys seam（R3 收口）：sync 区六键或
// local 区 aiProviderKeys，解绑改 unsubscribe。
let unwatchStorageKeys: (() => void) | null = null;

function bindStorageWatcher(): void {
  if (unwatchStorageKeys) {
    return;
  }
  unwatchStorageKeys = watchStorageKeys(() => {
    void refreshProvidersAndPrefsAfterExternalChange();
  }, {
    sync: [
      "aiProviders",
      "aiSystemPrompt",
      "aiInitialQuickPrompts",
      "aiPresetPrompts",
      "defaultModel",
      "aiThinkingLevel"
    ],
    local: ["aiProviderKeys"]
  });
}

function unbindStorageWatcher(): void {
  if (!unwatchStorageKeys) {
    return;
  }
  unwatchStorageKeys();
  unwatchStorageKeys = null;
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
  // digest-only-ui：提示条「前往设置」打开侧边栏设置抽屉（open-options 已删；
  // 经 reader-bus open-settings 命令由壳执行，arch-review-2026-09/10）
  onOpenSettings: () => requestUiCommand("open-settings")
});
const {
  showConversationContextNotice,
  removeConversationContextNotice,
  showConversationContextError,
  removeCenteredState,
  removeSuggestions,
  isMessagesNearBottom
} = feedback;

// 对话域内核链单一深入口（arch-review-2026-09/08）：pinned 补水解析器 +
// conversation-store + context-load（含内联 createInProcessContextFetch）+
// chat-runtime 在 ../chat/tab-domain.ts 组装——实例级硬边顺序 pinnedResolver →
// store → contextLoad → runtime 在组装模块内保持，其余 30+ 处跨实例互引保持
// 惰性箭头（回调执行时实例已存在）。本侧只注入 deps：壳 DOM 三件 + ui 门面
//（ChatRuntimeUi 8 件回调）+ store 能力事件订阅 + contextLoad 渲染编排回调 +
// storage + 状态 getter + runtime 传输/AI 回调（闭包连着本文件的页面级编排、
// 触发源状态与 DOM）。
// 会话状态（会话列表/当前会话/上下文）已收拢至 chatSessionState，store 直接
// import 读写。能力事件三件（工单 05 渲染编排反转：store 自己编排渲染时机，
// 本组合根只订阅结果）：
//   - onConversationChanged：历史列表恒随事件重渲，change 标志（refreshContext-
//     Chip / historyCleared / resetView）声明其余需要刷新的呈现面；
//   - onStreamInterrupted：流式中删除当前会话 / 清空全部 / restoreLatest 无匹配
//     时由 store 同步发出——断 port、清在途一问一答、清消息区并退出流式 UI 态
//    （对应 restartChat 的清理动作，但不清会话状态——那由 store 自己做）。
//     store 不直接 import chatRuntime，依赖方向由 tab-domain 组装；回调幂等
//    （非流式时为无害空操作）。
//   - onContextNotice：上下文补水提示生命周期（pending 展示 / clear 撤除 /
//     error 展示）。
const { runtime: chatRuntime, store: conversationStore, contextLoad } = createChatTabDomain({
  messages: els.messages,
  input: els.input,
  contextChip: els.contextChip,
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
  renderHistoryList: () => lists.renderHistoryList(),
  renderInitialState,
  renderSuggestions: () => lists.renderSuggestions(),
  restartChat,
  storage: chrome.storage.local,
  clip: () => state.clip,
  settings: () => state.settings,
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
    return chrome.runtime.connect({ name: OFFSCREEN_CHAT_PORT_NAME });
  }
});
const { loadContextState, updateContextChip } = contextLoad;

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

// 上下文状态加载编排壳（../chat/context-load.ts）与 chat 流状态机
//（../chat/chat-runtime.ts）均已收进上面的 createChatTabDomain 组装；本文件
// 经解构消费 contextLoad（loadContextState / updateContextChip，见上）与
// chatRuntime 实例方法。

// 预设提示词 CRUD（deps 注入本文件的编排回调与 DOM 引用）。
const presets = createPresetPrompts({
  presetInput: els.presetInput,
  renderPresetPrompts: () => lists.renderPresetPrompts()
});

// AI 平台加载渲染 + 思考档位（widthEls 即本文件模块级 `els`，含度量所需的
// toolbar/thinkingToggle/presetBtn）；persistAiPresetPrompts 惰性互引 presets。
// 思考档位「关不掉」提示（工单 03）的 DOM 与判定在本文件（updateThinkingHint），
// baseUrl 识别入参由 providers 模块自 ai-providers-list 载荷透传。
const providerPrefs = createProviderPrefs({
  modelSelect: els.modelSelect,
  thinkingBtns: els.thinkingBtns,
  widthEls: els,
  renderPresetPrompts: () => lists.renderPresetPrompts(),
  persistAiPresetPrompts: () => presets.persistAiPresetPrompts()
});
const { loadProvidersAndPrefs, setThinkingLevel } = providerPrefs;

// ============================================================
// 思考档位「关不掉」提示（工单 03，对话 tab 档位区唯一的 UI 增量）
// ============================================================

// 文案逐字给定（工单 03，勿改写）：长版 = 级联落了 low 档；短版 = 连 low 都没有。
const THINKING_OFF_FALLBACK_LOW_HINT = "当前模型不支持在本次请求中关闭思考，已使用最小思考档位";
const THINKING_OFF_UNAVAILABLE_HINT = "当前模型没办法关掉思考";

// 按当前档位 + 选中平台重判提示显隐。刷新点三处：模型选择 change、档位按钮
// 点击、平台列表重载（init 与外部设置变更后的 loadProvidersAndPrefs 之后）——
// 「关不掉」模型切回可关模型时提示随之消失。档位不是 Off、或 resolver 判 off
// 正常可用（含 never 模型静默与 unknown 哨兵）时一律隐藏。
function updateThinkingHint(): void {
  const hint = els.thinkingHint;
  if (!hint) {
    return;
  }
  hint.textContent = "";
  hint.hidden = true;
  if (chatSessionState.aiThinkingLevel !== "off") {
    return;
  }
  // 识别入参：baseUrl / presetId 沿 loadProvidersAndPrefs 已拉的
  // ai-providers-list 载荷（providers.ts 已透传进 chatSessionState.providers，
  // 不开新消息链）；模型名取选中平台记录的 model（modelSelect 选项文案同源）。
  // stream 传 true：对话请求是流式，streamOnly 关闭规则（如 qwen3-235b 的
  // enable_thinking:false）在对话里正常可用，不误报提示。
  const provider = chatSessionState.providers.find((item) => item.id === els.modelSelect.value);
  const resolution = resolveThinkingProfile({
    presetId: String(provider?.presetId || ""),
    baseUrl: String(provider?.baseUrl || ""),
    model: String(provider?.model || ""),
    level: "off",
    stream: true
  });
  if (!resolution.offUnavailable) {
    return;
  }
  hint.textContent = resolution.offFallback === "low" ? THINKING_OFF_FALLBACK_LOW_HINT : THINKING_OFF_UNAVAILABLE_HINT;
  hint.hidden = false;
}

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
  // 等待提示按相位路由：转写相位下并入转写状态行（合成一句，不另起消息区通知，
  // 顺带清掉此前非转写相位等期待遇残留的消息区通知）；非转写相位（如字幕抓取
  // 进行中状态行隐藏）沿用消息区通知，两者互斥不重复。
  showWaitingNotice: () => {
    if (getSubtitleStatusPhase() === "asr-transcribing") {
      asrWaitingActive = true;
      removeConversationContextNotice();
      updateAsrNotice();
      return;
    }
    showConversationContextNotice(SUBTITLE_WAIT_NOTICE, 0);
  },
  removeNotice: () => {
    if (asrWaitingActive) {
      asrWaitingActive = false;
      updateAsrNotice();
    }
    removeConversationContextNotice();
  },
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => window.clearTimeout(handle)
});

// ============================================================
// 激活 / 会话收尾（对外入口，经 reader/lazy-chat-tab 暴露）
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
  // 平台列表/档位落定后首判「关不掉」提示（此后由模型切换/档位点击/外部刷新续判）。
  updateThinkingHint();
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
  // 定位/聚焦对话 tab（不触达字幕 tab 的滚动状态）。切 tab + 激活由壳经
  // set-tab:chat 命令统一执行（arch-review-2026-09/10）；consumeIntent:false
  // 透传给壳的激活入口——与快捷发送互不踩踏，不消费待解释意图。下方再显式
  // await 激活：命令是 fire-and-forget，发送流程必须等装载/恢复落定。
  requestUiCommand("set-tab:chat", { consumeIntent: false });
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
  return sendViaInputBox(text);
}

// ============================================================
// PR3 契约消费：待解释意图 → 引用卡（时间戳 pill 母题）+ 自动发送
// ============================================================

// 解释提示词模板：引用句 + 时间戳 pill 文案，发送出去的消息自带引用上下文。
// 两种口径：卡片「去对话追问」带选中片段 → 解释这个词句；整句意图（无
// selection）→ 解释这句字幕。
function buildExplainPrompt(intent: { from: number; content: string; selection?: string }): string {
  const stamp = formatClock(intent.from, { hours: "auto" });
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
    stamp.textContent = formatClock(intent.from, { hours: "auto" });
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

// 发送芯（runQuickActionPrompt / autoSendPrompt 的共同尾部）：填输入框 →
// autosize → sendMessage → 折算是否受理。两函数头部的闸（新会话 vs 双发闸、
// 空串聚焦 vs 空串直 false）语义不同，不并入本芯。
// 受理成功 = 发送路径清空了输入框（ensureCurrentContextForSend 通过后才会清）；
// false = 被 provider/上下文/无字幕闸拦下（notice 已显示）。
async function sendViaInputBox(text: string): Promise<boolean> {
  els.input.value = text;
  autosizeInput();
  // sendMessage 兑现即发送流程已出结果（subtitle-wait 挂起在其内部 await）。
  await chatRuntime.sendMessage();
  return els.input.value === "" || chatRuntime.hasPendingUserPrompt();
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
  return sendViaInputBox(text);
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
    // 模型选择变化即重判提示（含从「关不掉」模型切回可关模型时消失）。
    updateThinkingHint();
  });
  els.thinkingBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      // setThinkingLevel 首行同步写 chatSessionState.aiThinkingLevel，紧随的
      // 重判读到的是新档位（档位切走即收提示，切回 Off 再现）。
      void setThinkingLevel(btn.dataset.level || "off");
      updateThinkingHint();
    });
  });
  window.addEventListener("resize", onWindowResize);
  // 容器层委托（对话 tab 根节点 #readingChatRoot，元素随态重建而容器不换，
  // 对齐 batched-render 头注的容器委托先例）：
  //   1. 引用卡取消：[data-chat-intent-action="cancel"] 点击；
  //   2. 无平台空态「前往设置」：[id=readingChatOpenSettings] 点击 → 打开侧边栏
  //      设置抽屉（arch-slim-2/06 死绑定修复——该链接由 renderInitialState →
  //      resetConversationView 用 innerHTML 后建，原先 ui-renderer 在壳构建时
  //      getElementById 直绑，绑定时点早于元素诞生、监听器永远挂不上；容器
  //      委托对每次重建的链接都生效。href="#" 的默认跳转一并 preventDefault）。
  els.root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const intentBtn = target?.closest<HTMLElement>("[data-chat-intent-action]");
    if (intentBtn && intentBtn.dataset.chatIntentAction === "cancel") {
      clearPendingExplainIntent();
      hideExplainIntentCard();
      return;
    }
    if (target?.closest<HTMLElement>(`[id="${ids.readingChatOpenSettings}"]`)) {
      // stopPropagation 必须有：打开抽屉的点击若继续冒泡到 ui-renderer 的文档级
      // click 委托，会被「settingsExpanded 已开 + 点在面板外」判定当成外点立即
      // 关闭（与壳内 readingSettingsToggleBtn 的 stopPropagation 同一先例）。
      event.preventDefault();
      event.stopPropagation();
      requestUiCommand("open-settings");
    }
  });
}

function onWindowResize(): void {
  updateModelSelectWidth(els);
}

// chip 点击的 reader 适配（sidepanel 版为 openCurrentContextUrl：chrome.tabs.update
// 跳转活动标签页）。content script 无 chrome.tabs：同视频只做静默强刷；绑定会话
// 指向别的视频时页内导航到目标 URL（保留 boc_reader=1，阅读模式随 URL 恢复）。
// URL 拼法单源在 bilibili/reader-url.ts 的 buildReaderModeUrl（arch-slim-2/03）。
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
    location.href = buildReaderModeUrl(targetUrl);
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
  // 外部变更可能整体替换平台列表/选中平台/档位：与 init 同口径重判提示。
  updateThinkingHint();
  if (chatRuntime.isStreaming()) {
    return;
  }
  lists.renderHistoryList();
  renderInitialState();
}

// ============================================================
// 上下文状态加载 / context chip：编排壳在 ../chat/context-load.ts（装配策略在
// ../core/context-assembly.ts，动作判定在 ../chat/context-policy.ts）；下方为
// 整段迁自 sidepanel.ts 的页面级编排函数。
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
// 点击经本文件 bindEvents 的 #readingChatRoot 容器委托打开侧边栏设置抽屉
//（arch-slim-2/06 死绑定修复；open-options 消息已删除）。
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
  // 「拆除会话」出口四（CONTEXT.md 词条；工单 arch-slim-2/07 D 半场）：断流
  // 双轨统一——经 conversationStore.detachForRestart 发出 onStreamInterrupted，
  // 本函数不再直调 chatRuntime.resetStreamState。断流仍先于会话身份清空（订阅
  // 回调同步先执行，时序与直调时代一致）；订阅处是 resetStreamState 的唯一接线
  // 点，runtime 直调仅剩该订阅处与会话关闭 closeChatSession（非拆除事务，不属
  // 本收口）——store 事件管断流通知，防再造第三轨。
  conversationStore.detachForRestart();
  if (!keepContext) {
    chatSessionState.currentContextKey = buildContextKey(chatSessionState.contextData);
  }
  updateContextChip();
  resetConversationView("");
  setStreamingUiState(false);
  els.input.value = "";
  autosizeInput();
}
