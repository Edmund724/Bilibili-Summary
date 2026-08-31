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

export type SidepanelGetContextMessage = {
  type: "sidepanel-get-context";
  forceRefresh?: boolean;
  ifSignature?: string;
};

export type SidepanelGetHotCommentsMessage = {
  type: "sidepanel-get-hot-comments";
};

export type SidepanelSeekVideoTimeMessage = {
  type: "sidepanel-seek-video-time";
  seconds?: number | string;
};

export type ContentScriptMessage =
  | PopupGetStateMessage
  | PopupRefreshMessage
  | PopupSelectSubtitleMessage
  | PopupTriggerReadingViewMessage
  | PopupCloseReadingViewMessage
  | SidepanelGetContextMessage
  | SidepanelGetHotCommentsMessage
  | SidepanelSeekVideoTimeMessage;

export type ContentScriptMessageType = ContentScriptMessage["type"];

// ===== service worker 处理的 runtime 消息 =====

export type GetSettingsMessage = { type: "get-settings" };
export type SaveSettingsMessage = { type: "save-settings"; settings?: unknown };
export type OpenOptionsMessage = { type: "open-options" };
export type PlayerAiQuickActionMessage = {
  type: "player-ai-quick-action";
  tabId?: number;
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
export type AsrProvidersTestMessage = {
  type: "asr-providers-test";
  provider?: unknown;
};
export type GetAsrRuntimeConfigMessage = { type: "get-asr-runtime-config" };

export type OffloadTaskMessage = {
  type: "offload-task";
  taskType?: string;
  [key: string]: unknown;
};

export type AiSidepanelGetStateMessage = {
  type: "ai-sidepanel-get-state";
  tabId?: number;
  forceRefresh?: boolean;
  ifSignature?: string;
};

export type AiSidepanelResolveContextMessage = {
  type: "ai-sidepanel-resolve-context";
  contextRef?: unknown;
};

export type AiSidepanelResolvePageRefMessage = {
  type: "ai-sidepanel-resolve-page-ref";
  contextRef?: unknown;
};

export type BackgroundMessage =
  | GetSettingsMessage
  | SaveSettingsMessage
  | OpenOptionsMessage
  | PlayerAiQuickActionMessage
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
  | AsrProvidersTestMessage
  | GetAsrRuntimeConfigMessage
  | OffloadTaskMessage
  | AiSidepanelGetStateMessage
  | AiSidepanelResolveContextMessage
  | AiSidepanelResolvePageRefMessage;

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
