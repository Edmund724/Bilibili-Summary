// 三条通道（content script、service worker、offscreen document）之间的消息协议。
// 所有 runtime 消息与 offscreen port 消息统一建模为 discriminated union，
// 以既有代码中的协议字面量为事实来源，不引入新的运行时常量。
//
// 响应半边（arch-slim-2/02）：每条请求消息在其声明处并列声明响应类型（服务端
// 处理器的 sendResponse 载荷即事实锚点），汇成 ResponseOf<T> 条件映射——
// sendRuntimeMessage 泛型化后，调用点以消息字面量即得完整响应形状，不再手猜。
// 响应形状取「平面接口」（ok 恒为 boolean；payload 字段仅在成功分支实发，失败
// 分支可带 error），与全部消费点既有的防御式读取（resp?.x || 兜底）同构。本文件
// 引用的域类型一律 type-only import：编译期擦除，不向 core/ai/asr 引入任何
// 运行时依赖边。

import type { Settings } from "../core/defaults.js";
import type { AiProviderPreset, AsrProviderPreset } from "../core/presets.js";
import type { AiProvider, HotComment } from "../ai/types.js";
import type { AsrProvider } from "../asr/asr-provider-store.js";

// ===== content script 处理的 runtime 消息 =====

export type ReaderEnterMessage = {
  type: "reader-enter";
  readerUrl?: string;
  // 快捷对话负载（可省）：带 chat = 进入阅读模式并在进入事务内激活对话 tab，
  // prompt 非空时自动发送快捷提示词（消费端 entry/message-handler.ts →
  // reader/shell.ts chat 档）。
  chat?: { prompt?: string };
};

// 响应锚点：entry/message-handler.ts reader-enter 处理器——命令已受理入队即答
// { ok: true }，不代表进入完成；shell 装载失败回 { ok: false, error }
//（arch-slim-2/09 shell 静态边改动态）。
export type ReaderEnterResponse = { ok: boolean };

// 退出阅读模式（SW 侧 triggerReaderModeCloseInTab 的重试发送；面板关闭按钮走
// 页内直调 reader 域，不经消息）。消费端（entry/message-handler.ts）收敛地址栏
// 后交 reader 域 closeReadingView + 摘阅读表（工单 02 起由 exitReaderShell 收口）。
export type ReaderCloseMessage = {
  type: "reader-close";
};

// 响应锚点：entry/message-handler.ts reader-close 处理器——退出事务完成后回包，
// 失败带可读 error。
export type ReaderCloseResponse = { ok: boolean; error?: string };

// 阅读视图自愈恢复（ui/digest-button.ts 的 800ms 自查在失同步时派发）：
// URL 带 boc_reader=1 而视图没开（直达进入失败）、或状态开着而壳被页面重渲染
// 摘掉（状态-DOM 失同步）时，按 DOM 实况收敛状态后重走进入链。readerUrl 语义
// 同 reader-enter。仅 content 页内源使用（dispatchContentScriptMessage）。
export type ReaderRestoreMessage = {
  type: "reader-restore";
  readerUrl?: string;
};

// 响应锚点：entry/message-handler.ts reader-restore 处理器——同 reader-enter 的
// 即答语义，恒 { ok: true }。
export type ReaderRestoreResponse = { ok: boolean };

export type ReaderGetHotCommentsMessage = {
  type: "reader-get-hot-comments";
};

// 响应锚点：entry/message-handler.ts hot-comments 处理器——无失败分支，无法获取
// aid / 拉取失败都降级为空列表 + note 说明。
export type ReaderGetHotCommentsResponse = {
  ok: boolean;
  comments: HotComment[];
  note?: string;
};

export type ReaderSeekVideoTimeMessage = {
  type: "reader-seek-video-time";
  seconds?: number | string;
};

// 响应锚点：entry/message-handler.ts reader-seek-video-time 处理器——成功带定位后
// 的 currentTime，失败（无播放器/未绑定）带可读 error。
export type ReaderSeekVideoTimeResponse = {
  ok: boolean;
  currentTime?: number;
  error?: string;
};

export type ContentScriptMessage =
  | ReaderEnterMessage
  | ReaderCloseMessage
  | ReaderRestoreMessage
  | ReaderGetHotCommentsMessage
  | ReaderSeekVideoTimeMessage;

export type ContentScriptMessageType = ContentScriptMessage["type"];

// ===== service worker 处理的 runtime 消息 =====

export type GetSettingsMessage = { type: "get-settings" };
// 响应锚点：entry/background.ts handleGetSettings——getMergedSettings 的合并快照
//（已过 normalizeSettings 收口）。
export type GetSettingsResponse = {
  ok: boolean;
  settings?: Settings;
  error?: string;
};
export type SaveSettingsMessage = { type: "save-settings"; settings?: unknown };
// 响应锚点：entry/background.ts handleSaveSettings——落盘成功仅 { ok: true }。
export type SaveSettingsResponse = { ok: boolean; error?: string };
// digest-only-ui：content script 语境没有 chrome.permissions API（仅扩展自有
// 页面/SW 可用），侧边栏设置面板保存时的 host 权限申请改走此消息由 SW 代为
// 申请。用户手势经一次 runtime 消息传导；SW 处理器必须在调用
// chrome.permissions.request 前零 await（见 entry/background.ts）。
export type RequestProviderOriginsMessage = {
  type: "request-provider-origins";
  baseUrls?: unknown;
};
// 响应锚点：entry/background.ts handleRequestProviderOrigins——用户拒绝 / 环境
// 不支持 / SW 报错时 error 为可操作提示文案。
export type RequestProviderOriginsResponse = { ok: boolean; error?: string };
// PR5：对话 tab（content script）发送前的 offscreen 文档自愈 ensure——
// chrome.offscreen / getContexts 仅扩展上下文可用，content script 经此消息
// 委托 background 幂等创建（扩展页内直调 ensureChatOffscreenDocument 的
// 等价物，见 reader/chat-tab.ts 的 connectPort）。
export type EnsureOffscreenChatMessage = { type: "ensure-offscreen-chat" };
// 响应锚点：entry/background.ts handleEnsureOffscreenChat——ensured 为幂等创建
// 结果（ensureChatOffscreenDocument 的 boolean）。
export type EnsureOffscreenChatResponse = {
  ok: boolean;
  ensured?: boolean;
  error?: string;
};
export type PlayerAiQuickActionMessage = {
  type: "player-ai-quick-action";
  tabId?: number;
};
// 响应锚点：entry/background.ts handlePlayerAiQuickAction——失败带可读 error
//（找不到标签页 / 按钮未开启 / 触发失败）。
export type PlayerAiQuickActionResponse = { ok: boolean; error?: string };
export type FetchJsonMessage = { type: "fetch-json"; url?: string };
// 响应锚点：entry/background.ts handleFetchJson——data 为目标 JSON 原文（具体
// 形状由调用方的泛型参数收口），失败带可读 error（含 "Invalid JSON response"）。
export type FetchJsonResponse = {
  ok: boolean;
  data?: unknown;
  error?: string;
};

// provider 列表响应条目：core/provider-store 的 list 载荷——Key 不明文回传，
// 只带 hasSavedKey 占位。
export type ProviderListEntry = AiProvider & { hasSavedKey: boolean };
export type AsrProviderListEntry = AsrProvider & { hasSavedKey: boolean };

export type AiProvidersListMessage = { type: "ai-providers-list" };
// 响应锚点：core/provider-handlers.ts list——{ ok: true, providers }，失败经
// withOkResponse 统一映射为 { ok: false, error }（下同）。
export type AiProvidersListResponse = {
  ok: boolean;
  providers?: ProviderListEntry[];
  error?: string;
};
export type AiPresetsListMessage = { type: "ai-presets-list" };
// 响应锚点：entry/background.ts handleAiPresetsList。
export type AiPresetsListResponse = {
  ok: boolean;
  presets?: AiProviderPreset[];
  error?: string;
};
export type GetAiProviderKeyMessage = {
  type: "get-ai-provider-key";
  providerId?: string;
};
// 响应锚点：core/provider-handlers.ts get——缺 providerId 同步回
// { ok: false, error: "缺少 providerId" }。
export type GetAiProviderKeyResponse = {
  ok: boolean;
  apiKey?: string;
  error?: string;
};
export type AiProvidersSaveMessage = { type: "ai-providers-save"; providers?: unknown };
// 响应锚点：core/provider-handlers.ts save——回最新列表（含 hasSavedKey）。
export type AiProvidersSaveResponse = {
  ok: boolean;
  providers?: ProviderListEntry[];
  error?: string;
};
export type AiProvidersDeleteMessage = {
  type: "ai-providers-delete";
  providerId?: string;
};
// 响应锚点：core/provider-handlers.ts remove——回删除后存活列表。
export type AiProvidersDeleteResponse = {
  ok: boolean;
  providers?: ProviderListEntry[];
  error?: string;
};
export type AiProvidersModelsMessage = {
  type: "ai-providers-models";
  baseUrl?: string;
  apiKey?: string;
  providerId?: string;
};
// 响应锚点：ai/provider-models.ts handleAiProvidersModels（AiProvidersModelsResult，arch-slim-2/09 自 core/ai-provider-store.ts 搬入）。
export type AiProvidersModelsResponse = {
  ok: boolean;
  models?: string[];
  error?: string;
};
// arch-slim-3/09：「激活平台」单趟解析——offscreen 聊天链与 content 侧概览/
// 选区解释共用（CONTEXT.md 域词条「激活平台」）。providerId 给定 = 精确匹配
//（offscreen 语义）；缺省 = 设置 defaultModel → 首个启用平台回落（content
// 语义）。requiresKey 平台密钥缺失在解析期即报可读错误（此前 content 侧会
// 拖到 HTTP 期才失败）。
export type ResolveAiProviderMessage = {
  type: "resolve-ai-provider";
  providerId?: string;
};
// 响应锚点：core/provider-handlers.ts createAiResolvedProviderHandler——
// provider 为平台记录（不含明文 Key，与列表条目同形），apiKey 单列回传。
export type ResolveAiProviderResponse = {
  ok: boolean;
  provider?: ProviderListEntry;
  apiKey?: string;
  error?: string;
};

// ===== offscreen 段缓存消息族 =====
// 平台事实（chrome.offscreen 官方文档）：offscreen 文档仅支持 chrome.runtime，
// 无 chrome.storage。段缓存（ai/segment-cache.js 的 boc_lvs_summary_* /
// boc_lvs_raw_* 两族）宿主是 SW——offscreen 的 Map-Reduce / 追问链经本族消息
// 读写（arch-review-2026-09/05，替下 storage-local-bridge 垫片），SW 端 handler
// 直调 segment-cache 单源（键位装配也在 SW 完成，消息只带 context 字段）。
export type SegmentCacheMessage = {
  type: "segment-cache";
  op: "load-summary" | "save-summary" | "save-raw" | "load-stored-raw";
  // context 形字段（bvid/cid/selectedSubtitleId/selectedSubtitleUrl/subtitleLang），
  // SW 端经 segmentCacheKeyFields 归一为键位字段
  context?: Record<string, unknown>;
  segmentIndex?: number | string;
  // unknown 透传：budgetScaleSuffix 的 Number() 归一在 SW 的 segment-cache 单源
  // 完成，与迁移前直连调用的口径逐字一致
  budgetScale?: unknown;
  // save-summary 的载荷 / save-raw 的原始段条目
  summary?: string;
  segments?: unknown[];
};
export type SegmentCacheResponse = {
  ok: boolean;
  // load-summary 回包：小结文本（未命中为 null）
  summary?: string | null;
  // load-stored-raw 回包：按段序排列的落盘原始段（无命中为空数组）
  storedSegments?: unknown[];
  error?: string;
};

export type AsrPresetsListMessage = { type: "asr-presets-list" };
// 响应锚点：entry/background.ts handleAsrPresetsList。
export type AsrPresetsListResponse = {
  ok: boolean;
  presets?: AsrProviderPreset[];
  error?: string;
};
export type AsrProvidersListMessage = { type: "asr-providers-list" };
// 响应锚点：core/provider-handlers.ts list（ASR 家族与 AI 同契约）。
export type AsrProvidersListResponse = {
  ok: boolean;
  providers?: AsrProviderListEntry[];
  error?: string;
};
export type AsrProvidersSaveMessage = { type: "asr-providers-save"; providers?: unknown };
// 响应锚点：core/provider-handlers.ts save。
export type AsrProvidersSaveResponse = {
  ok: boolean;
  providers?: AsrProviderListEntry[];
  error?: string;
};
export type AsrProvidersDeleteMessage = {
  type: "asr-providers-delete";
  providerId?: string;
};
// 响应锚点：core/provider-handlers.ts remove。
export type AsrProvidersDeleteResponse = {
  ok: boolean;
  providers?: AsrProviderListEntry[];
  error?: string;
};
export type GetAsrRuntimeConfigMessage = { type: "get-asr-runtime-config" };
// 响应锚点：core/provider-handlers.ts createAsrRuntimeConfigHandler——settings
// 标量 + provider 列表 + 激活平台 Key 一次回包（Key 只进 offscreen context）。
export type GetAsrRuntimeConfigResponse = {
  ok: boolean;
  providers?: AsrProviderListEntry[];
  activeAsrProviderId?: string;
  activeKey?: string;
  asrLanguage?: string;
  asrAutoFallback?: boolean;
  error?: string;
};

export type OffloadTaskMessage = {
  type: "offload-task";
  taskType?: string;
  [key: string]: unknown;
};
// 响应锚点：asr/offscreen-bridge.bg.ts prepare/cleanup 执行器 + entry/background.ts
// handleOffloadTask 的未知任务类型拒绝——prepare 成功带回本任务独立分配的
// ruleId，cleanup 成功仅 { ok: true }，失败一律 { ok: false, error }。
export type OffloadTaskResponse = {
  ok: boolean;
  ruleId?: number;
  error?: string;
};

export type BackgroundMessage =
  | GetSettingsMessage
  | SaveSettingsMessage
  | RequestProviderOriginsMessage
  | EnsureOffscreenChatMessage
  | PlayerAiQuickActionMessage
  | FetchJsonMessage
  | AiProvidersListMessage
  | AiPresetsListMessage
  | GetAiProviderKeyMessage
  | AiProvidersSaveMessage
  | AiProvidersDeleteMessage
  | AiProvidersModelsMessage
  | ResolveAiProviderMessage
  | AsrPresetsListMessage
  | AsrProvidersListMessage
  | AsrProvidersSaveMessage
  | AsrProvidersDeleteMessage
  | GetAsrRuntimeConfigMessage
  | SegmentCacheMessage
  | OffloadTaskMessage;

export type BackgroundMessageType = BackgroundMessage["type"];

// ===== offscreen document 发出的 runtime 请求 =====

export type OffscreenRuntimeRequest =
  | ResolveAiProviderMessage
  | GetAsrRuntimeConfigMessage
  | SegmentCacheMessage;

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

// ===== 响应类型映射（arch-slim-2/02）=====

// ResponseOf<M> 按消息类型分发到其响应类型：sendRuntimeMessage 泛型化后，调用
// 点以消息字面量（如 { type: "get-settings" }）即得完整响应形状（设计 A 案）。
// 新增消息漏配响应条目时 M 解析为 never——tests/shared/messaging-response-map.guard.ts
// 的类型级穷尽断言会在 tsc 门禁报错，不会静默退化为 unknown。
export type ResponseOf<M> = M extends ReaderEnterMessage ? ReaderEnterResponse
  : M extends ReaderCloseMessage ? ReaderCloseResponse
  : M extends ReaderRestoreMessage ? ReaderRestoreResponse
  : M extends ReaderGetHotCommentsMessage ? ReaderGetHotCommentsResponse
  : M extends ReaderSeekVideoTimeMessage ? ReaderSeekVideoTimeResponse
  : M extends GetSettingsMessage ? GetSettingsResponse
  : M extends SaveSettingsMessage ? SaveSettingsResponse
  : M extends RequestProviderOriginsMessage ? RequestProviderOriginsResponse
  : M extends EnsureOffscreenChatMessage ? EnsureOffscreenChatResponse
  : M extends PlayerAiQuickActionMessage ? PlayerAiQuickActionResponse
  : M extends FetchJsonMessage ? FetchJsonResponse
  : M extends AiProvidersListMessage ? AiProvidersListResponse
  : M extends AiPresetsListMessage ? AiPresetsListResponse
  : M extends GetAiProviderKeyMessage ? GetAiProviderKeyResponse
  : M extends AiProvidersSaveMessage ? AiProvidersSaveResponse
  : M extends AiProvidersDeleteMessage ? AiProvidersDeleteResponse
  : M extends AiProvidersModelsMessage ? AiProvidersModelsResponse
  : M extends ResolveAiProviderMessage ? ResolveAiProviderResponse
  : M extends AsrPresetsListMessage ? AsrPresetsListResponse
  : M extends AsrProvidersListMessage ? AsrProvidersListResponse
  : M extends AsrProvidersSaveMessage ? AsrProvidersSaveResponse
  : M extends AsrProvidersDeleteMessage ? AsrProvidersDeleteResponse
  : M extends GetAsrRuntimeConfigMessage ? GetAsrRuntimeConfigResponse
  : M extends SegmentCacheMessage ? SegmentCacheResponse
  : M extends OffloadTaskMessage ? OffloadTaskResponse
  : never;

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
