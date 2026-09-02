// 三条通道（content script、service worker、offscreen document）之间的消息协议。
// 所有 runtime 消息与 offscreen port 消息统一建模为 discriminated union，
// 以既有代码中的协议字面量为事实来源，不引入新的运行时常量。

// ===== content script 处理的 runtime 消息 =====

export type PopupGetStateMessage = {
  type: "popup-get-state";
};

export type PopupRefreshMessage = {
  type: "popup-refresh";
};

export type PopupSelectSubtitleMessage = {
  type: "popup-select-subtitle";
  url?: string;
  lang?: string;
  subtitleId?: string;
};

export type PopupTriggerReadingViewMessage = {
  type: "popup-trigger-reading-view";
  readerUrl?: string;
};

export type PopupCloseReadingViewMessage = {
  type: "popup-close-reading-view";
};

// 阅读视图自愈恢复（ui/digest-button.ts 的 800ms 自查在失同步时派发）：
// URL 带 boc_reader=1 而视图没开（直达进入失败）、或状态开着而壳被页面重渲染
// 摘掉（状态-DOM 失同步）时，按 DOM 实况收敛状态后重走进入链。readerUrl 语义
// 同 popup-trigger-reading-view。仅 content 页内源使用（dispatchContentScriptMessage）。
export type PopupRestoreReadingViewMessage = {
  type: "popup-restore-reading-view";
  readerUrl?: string;
};

// 打开/进入阅读模式并激活「AI 对话」tab：readerUrl 语义同
// popup-trigger-reading-view（空串 = 已在阅读模式内，只定位/聚焦）；prompt
// 语义同 player-ai-quick-action（空串 = 只激活对话 tab，不发送）。
// 消费端（core/message-handler.ts）先处理打开/进入，再经 core/lazy-chat-tab
// 的 ensureChatTabActivated + runQuickActionPrompt 消费。
export type PopupTriggerReadingChatMessage = {
  type: "popup-trigger-reading-chat";
  readerUrl?: string;
  prompt?: string;
};

// 消息类型为 reader 中性命名（PR5c 自原 sidepanel-* 改名；兼容别名已随存量
// 消费方迁移到期移除）。
export type ReaderGetContextMessage = {
  type: "reader-get-context";
  forceRefresh?: boolean;
  ifSignature?: string;
};

export type ReaderGetHotCommentsMessage = {
  type: "reader-get-hot-comments";
};

export type ReaderSeekVideoTimeMessage = {
  type: "reader-seek-video-time";
  seconds?: number | string;
};

export type ContentScriptMessage =
  | PopupGetStateMessage
  | PopupRefreshMessage
  | PopupSelectSubtitleMessage
  | PopupTriggerReadingViewMessage
  | PopupTriggerReadingChatMessage
  | PopupRestoreReadingViewMessage
  | PopupCloseReadingViewMessage
  | ReaderGetContextMessage
  | ReaderGetHotCommentsMessage
  | ReaderSeekVideoTimeMessage
  // background → content 直发：player-ai 悬浮按钮语义反转后的快捷动作消费
  //（进入/聚焦阅读模式的编排已由 background 完成，content 只消费 prompt）。
  | PlayerAiQuickActionChatMessage;

export type ContentScriptMessageType = ContentScriptMessage["type"];

// ===== service worker 处理的 runtime 消息 =====

export type GetSettingsMessage = { type: "get-settings" };
export type SaveSettingsMessage = { type: "save-settings"; settings?: unknown };
// digest-only-ui：content script 语境没有 chrome.permissions API（仅扩展自有
// 页面/SW 可用），侧边栏设置面板保存时的 host 权限申请改走此消息由 SW 代为
// 申请。用户手势经一次 runtime 消息传导；SW 处理器必须在调用
// chrome.permissions.request 前零 await（见 entry/background.ts）。
export type RequestProviderOriginsMessage = {
  type: "request-provider-origins";
  baseUrls?: unknown;
};
// PR5：对话 tab（content script）发送前的 offscreen 文档自愈 ensure——
// chrome.offscreen / getContexts 仅扩展上下文可用，content script 经此消息
// 委托 background 幂等创建（扩展页内直调 ensureChatOffscreenDocument 的
// 等价物，见 reader/chat-tab.ts 的 connectPort）。
export type EnsureOffscreenChatMessage = { type: "ensure-offscreen-chat" };
export type PlayerAiQuickActionMessage = {
  type: "player-ai-quick-action";
  tabId?: number;
};
// player-ai 悬浮按钮语义反转后的消息（工单 08 决议 2）：background 不再打开
// 侧边栏/写 storage 信箱，改为「进入/聚焦阅读模式 + 定位 AI 对话 tab + 自动
// 发送快捷提示词」。prompt 由 background 组装，content 侧经 runQuickActionPrompt
// 消费。
export type PlayerAiQuickActionChatMessage = {
  type: "player-ai-quick-action-chat";
  prompt?: string;
};
export type OpenReadingViewTabMessage = {
  type: "open-reading-view-tab";
  url?: string;
  tabId?: number;
};
export type CloseReadingViewTabMessage = {
  type: "close-reading-view-tab";
  tabId?: number;
};
export type FetchJsonMessage = { type: "fetch-json"; url?: string };

export type AiProvidersListMessage = { type: "ai-providers-list" };
export type AiPresetsListMessage = { type: "ai-presets-list" };
export type GetAiProviderKeyMessage = {
  type: "get-ai-provider-key";
  providerId?: string;
};
export type AiProvidersSaveMessage = { type: "ai-providers-save"; providers?: unknown };
export type AiProviderSetKeyMessage = {
  type: "ai-provider-set-key";
  providerId?: string;
  apiKey?: string;
};
export type AiProvidersDeleteMessage = {
  type: "ai-providers-delete";
  providerId?: string;
};
export type AiProvidersModelsMessage = {
  type: "ai-providers-models";
  baseUrl?: string;
  apiKey?: string;
  providerId?: string;
};

export type AsrPresetsListMessage = { type: "asr-presets-list" };
export type AsrProvidersListMessage = { type: "asr-providers-list" };
export type AsrProvidersSaveMessage = { type: "asr-providers-save"; providers?: unknown };
export type AsrProvidersDeleteMessage = {
  type: "asr-providers-delete";
  providerId?: string;
};
export type GetAsrProviderKeyMessage = {
  type: "get-asr-provider-key";
  providerId?: string;
};
export type GetAsrRuntimeConfigMessage = { type: "get-asr-runtime-config" };

export type OffloadTaskMessage = {
  type: "offload-task";
  taskType?: string;
  [key: string]: unknown;
};

export type BackgroundMessage =
  | GetSettingsMessage
  | SaveSettingsMessage
  | RequestProviderOriginsMessage
  | EnsureOffscreenChatMessage
  | PlayerAiQuickActionMessage
  | PopupTriggerReadingChatMessage
  | OpenReadingViewTabMessage
  | CloseReadingViewTabMessage
  | FetchJsonMessage
  | AiProvidersListMessage
  | AiPresetsListMessage
  | GetAiProviderKeyMessage
  | AiProvidersSaveMessage
  | AiProviderSetKeyMessage
  | AiProvidersDeleteMessage
  | AiProvidersModelsMessage
  | AsrPresetsListMessage
  | AsrProvidersListMessage
  | AsrProvidersSaveMessage
  | AsrProvidersDeleteMessage
  | GetAsrProviderKeyMessage
  | GetAsrRuntimeConfigMessage
  | OffloadTaskMessage;

export type BackgroundMessageType = BackgroundMessage["type"];

// ===== offscreen document 发出的 runtime 请求 =====

export type OffscreenRuntimeRequest =
  | AiProvidersListMessage
  | GetAiProviderKeyMessage
  | GetAsrRuntimeConfigMessage;

// ===== offscreen document 接收的 port 消息 =====

export type OffscreenChatMessage = {
  action: "chat";
  providerId?: string;
  subtitleBody?: unknown;
  [key: string]: unknown;
};

export type OffscreenStopMessage = { action: "stop" };

export type OffscreenCostGuardConfirmMessage = {
  action: "cost-guard-confirm";
  ok?: boolean;
};

export type OffscreenChatPortMessage =
  | OffscreenChatMessage
  | OffscreenStopMessage
  | OffscreenCostGuardConfirmMessage;

export type OffscreenAsrPortMessage = {
  action: "asr-decode";
  task: {
    audioUrl?: string;
    backupUrls?: string[];
    [key: string]: unknown;
  };
};

export type OffscreenPortMessage = OffscreenChatPortMessage | OffscreenAsrPortMessage;

// ===== 通用处理函数签名 =====

export type MessageResponse = unknown;

export type SendResponse = (response?: MessageResponse) => void;

export type MessageSender = {
  tab?: { id?: number; url?: string };
  url?: string;
  id?: string;
};

export type MessageHandler<M> = (
  message: M,
  sender: MessageSender,
  sendResponse: SendResponse
) => boolean | void;
