import {
  DEFAULT_SETTINGS,
  DEFAULT_PLAYER_AI_QUICK_PROMPT
} from "../core/defaults.js";
import { PRESETS, ASR_PROVIDER_PRESETS } from "../core/presets.js";
import { normalizePlayerAiQuickPrompt } from "../core/validators.js";
import { buildReaderModeUrl, isSupportedBilibiliPage } from "../bilibili/video-id-shared.js";
import {
  EXPECTED_CONTENT_SCRIPT_VERSION,
  injectReaderContent,
  probeContentScriptVersion,
  triggerReaderModeInTab
} from "../core/content-orchestration-wiring.js";
import { getMergedSettings, normalizeSettings, saveSettings } from "../core/settings-store.js";
// 安装/更新一次性设置迁移（2026-09 AI 键默认开：存量显式 false 清位）
import { applyPlayerAiQuickActionDefaultOnMigration } from "./settings-migration.js";
// 调试日志门三宿主接线（shared/logging 的 registerDebugGate 消费方）
import { registerDebugLogGate } from "../shared/debug-log-gate.js";
import { logWarn } from "../shared/logging.js";
import {
  aiProviderStore
} from "../core/ai-provider-store.js";
import { asrProviderStore } from "../asr/asr-provider-store.js";
// 模型列表探测（fetch 原语）归 ai 域（arch-slim-2/09）；纯存储仍在 core/。
import { handleAiProvidersModels as fetchAiProviderModels } from "../ai/provider-models.js";
import {
  createProviderMessageHandlers,
  createAsrRuntimeConfigHandler,
  createAiResolvedProviderHandler,
  withOkResponse
} from "../core/provider-handlers.js";
// offscreen 段缓存消息族 SW 端 handler（offscreen 文档无 chrome.storage，
// 段缓存读写经消息直调 ai/segment-cache 单源——arch-review-2026-09/05）
import { createSegmentCacheHandler } from "../ai/segment-cache-handler.js";
// SW 静态图只进传输叶（arch-slim-2/04）：bgFetchJson/isBiliUrl 拆至 gateway-core，
// 不经 gateway 拖入 state/video-probe/selection→cache 链。
import { bgFetchJson, isBiliUrl } from "../bilibili/gateway-core.js";
// digest-only-ui：侧边栏设置面板的 host 权限代申请（collectOrigins 纯函数）
import { collectOrigins } from "../core/host-permissions.js";
// PR5：对话 tab 的 offscreen 文档 ensure 通道（background 侧唯一合法创建点）
import { ensureChatOffscreenDocument } from "../chat/offscreen-ensure.js";
import { handleAsrDecodePrepare, handleAsrDecodeCleanup, handleOffscreenRequestClose, isOffscreenDocumentSender } from "../asr/offscreen-bridge.bg.js";
import { ASR_TASK_PREPARE, ASR_TASK_CLEANUP } from "../asr/protocol.js";
import type {
  BackgroundMessage,
  BackgroundMessageType,
  MessageHandler,
  MessageSender,
  SendResponse
} from "../shared/messaging-protocol.js";

// ===== 消息路由表 =====

type BackgroundHandler = MessageHandler<BackgroundMessage>;
type Msg<T extends BackgroundMessageType> = Extract<BackgroundMessage, { type: T }>;

function handleGetSettings(_message: Msg<"get-settings">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  // 异步错误回包统一走 withOkResponse（arch-slim-2/03 单源）；同步错误回包
  // （缺参/拒绝处理等）保持处理器内直写。
  withOkResponse(
    (async () => ({ ok: true, settings: await getMergedSettings() }))(),
    sendResponse
  );
  return true;
}

function handleSaveSettings(message: Msg<"save-settings">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  withOkResponse(
    (async () => {
      await saveSettings(message.settings || {});
      return { ok: true };
    })(),
    sendResponse
  );
  return true;
}

// digest-only-ui：侧边栏设置面板（content script）保存时的 host 权限代申请。
// content script 无 chrome.permissions API，用户手势经本次 runtime 消息传导到
// 本处理器——chrome.permissions.request 必须是处理器内的第一个动作（任何先行
// await 都会耗尽手势，被 Chrome 以「缺少用户手势」拒绝，见
// core/host-permissions.ts 的 requestProviderOriginsViaBackground）。
function handleRequestProviderOrigins(message: Msg<"request-provider-origins">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  const origins = collectOrigins(message.baseUrls);
  if (origins.length === 0) {
    sendResponse({ ok: true });
    return false;
  }
  if (typeof chrome.permissions?.request !== "function") {
    sendResponse({ ok: false, error: "当前环境不支持申请权限" });
    return false;
  }
  // chrome.permissions.request 仍是处理器内的第一个动作（手势不变式，见上方
  // 注释）：async 函数体在首个 await 前同步执行，request 在其中同步发起、
  // await 只落在其返回的 promise 上；拒绝文案带固定前缀，经 withOkResponse
  // 的 toError 保持逐字一致。
  withOkResponse(
    (async () => {
      const requestTask = chrome.permissions.request({ origins });
      const granted = await requestTask;
      return granted
        ? { ok: true }
        : {
            ok: false,
            error: `未授权 ${origins.join("、")}，保存已中止：请重新点击「保存设置」并在弹窗中选择允许`
          };
    })(),
    sendResponse,
    (error) => `申请域名权限失败：${(error as Error).message}`
  );
  return true;
}

// PR5：对话 tab（content script）发送前的 offscreen 文档自愈 ensure。chrome.offscreen
// / chrome.runtime.getContexts 仅扩展上下文可用，content script 经此消息委托
// background 幂等创建（sidepanel 扩展页内直调 ensureChatOffscreenDocument 的
// 等价通道）。ensure 失败不再吞掉（工单 03）：ensureChatOffscreenDocument 的
// 原始错误经 withOkResponse 回 { ok:false, error }——调用方 catch 后仍由
// connect 结果兜底（发送链不中断），但失败原因不再无声丢失。
function handleEnsureOffscreenChat(_message: Msg<"ensure-offscreen-chat">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  withOkResponse(
    (async () => ({ ok: true, ensured: await ensureChatOffscreenDocument() }))(),
    sendResponse
  );
  return true;
}

// 「进/聚焦阅读模式 + 定位对话 tab + 自动发送快捷提示词」的统一编排
//（arch-slim-3/04 收口）：单条带 chat 负载的 reader-enter 命令直达 content 侧
//（进入事务内激活对话 tab），不再即答后二次直发——双消息直发的进入/对话竞态
// 在消息序上收口。触发失败回可读文案。
const readerTriggerFailedText = "阅读模式触发失败，请刷新浏览器网页重试";

async function triggerReaderChatInTab(
  tabId: number,
  options: {
    requireQuickActionEnabled: boolean;
    readerUrl: string;
  }
): Promise<{ ok: true }> {
  const settings = await getMergedSettings();
  if (options.requireQuickActionEnabled && !settings.enablePlayerAiQuickAction) {
    throw new Error("AI 按钮未开启");
  }
  const prompt = normalizePlayerAiQuickPrompt(settings.playerAiQuickPrompt || DEFAULT_PLAYER_AI_QUICK_PROMPT);
  let url = options.readerUrl;
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== "www.bilibili.com") {
        throw new Error("当前网页不是 B 站视频页");
      }
      parsed.searchParams.set("boc_reader", "1");
      url = parsed.toString();
    } catch (error) {
      throw new Error((error as Error).message || "阅读视图地址无效");
    }
  }
  const triggered = await triggerReaderModeInTab(tabId, url, { prompt });
  if (!triggered) {
    throw new Error(readerTriggerFailedText);
  }
  return { ok: true };
}

// player-ai 悬浮按钮语义反转（工单 08 决议 2）：不再打开 AI 侧边栏/写 storage
// 信箱（boc_player_ai_quick_action_v1 已退役），改为「进入/聚焦阅读模式 +
// 定位对话 tab + 自动发送快捷提示词」——单条带 chat 负载的 reader-enter 走
// triggerReaderModeInTab 链（空 readerUrl = 已在阅读模式内，只聚焦），
// 提示词组装后由 content 侧进入事务内的对话 seam runQuickActionPrompt 消费。
function handlePlayerAiQuickAction(message: Msg<"player-ai-quick-action">, sender: MessageSender, sendResponse: SendResponse): boolean {
  const senderTabId = Number(sender.tab?.id) || 0;
  const requestedTabId = Number(message.tabId) || 0;
  // 标签页归属（工单 03）：带 sender.tab 的来源（content script）只能操作
  // 自己所在的标签页——message.tabId 与 sender.tab.id 同时存在且不一致即
  // 跨标签页伪造，拒绝且不执行任何副作用。
  if (senderTabId && requestedTabId && requestedTabId !== senderTabId) {
    sendResponse({ ok: false, error: "请求目标与发送者标签页不一致，已拒绝。" });
    return false;
  }
  const tabId = senderTabId || requestedTabId;
  if (!tabId) {
    sendResponse({ ok: false, error: "找不到当前标签页。" });
    return false;
  }

  withOkResponse(
    triggerReaderChatInTab(tabId, {
      requireQuickActionEnabled: true,
      readerUrl: ""
    }),
    sendResponse,
    (error) => (error as Error).message || "打开 AI 对话失败"
  );
  return true;
}

function handleFetchJson(message: Msg<"fetch-json">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  const url = typeof message.url === "string" ? message.url : "";
  if (!url) {
    sendResponse({ ok: false, error: "Missing subtitle URL" });
    return false;
  }
  // 策略收口到通道：本处理器只为 B 站 API/字幕 CDN 带 cookie 代理取数，
  // 非 B 站 URL 一律拒绝——调用方（gateway 的 isBiliUrl 前置过滤）之外再挡一层，
  // 防止未来新调用方漏掉前置过滤时把本通道当成任意 URL 的带凭据代理。
  if (!isBiliUrl(url)) {
    sendResponse({ ok: false, error: "Non-Bilibili URL" });
    return false;
  }

  // withOkResponse 收口（arch-slim-2/03）：JSON 解析失败（200 但非 JSON 响应）
  // 时给用户稳定的可读文案，而非引擎原生 SyntaxError。
  withOkResponse(
    (async () => ({ ok: true, data: await bgFetchJson(url) }))(),
    sendResponse,
    (error) => (error instanceof SyntaxError ? "Invalid JSON response" : (error as Error).message)
  );
  return true;
}

// Provider CRUD 消息：AI / ASR 两个家族形状相同，统一由
// core/provider-handlers.js 的工厂装配。响应负载与消息名保持不变，
// 路由表只换处理器指向。AI / ASR 的连通性测试（ai-providers-test /
// asr-providers-test）均已移出 SW：options 页分别直调 ai/provider-test.js 与
// asr/provider-test.js（host_permissions 对扩展页面同样生效），探针的 completion /
// wav-encode 链不再进 SW 图（候选 04 拆链），故本工厂不再注入 probe。
const aiProviderHandlers = createProviderMessageHandlers({
  loadProviders: aiProviderStore.loadProviders,
  saveProviders: aiProviderStore.saveProviders,
  deleteProvider: aiProviderStore.deleteProvider,
  loadKeys: aiProviderStore.loadKeys
});

// 「激活平台」单趟解析（arch-slim-3/09）：offscreen 聊天链与 content 侧
// 概览/选区解释共用，解析策略与密钥校验单源在处理器内。
const aiResolvedProviderHandler = createAiResolvedProviderHandler({
  getMergedSettings,
  loadProviders: aiProviderStore.loadProviders,
  loadKeys: aiProviderStore.loadKeys
});

function handleAiPresetsList(_message: Msg<"ai-presets-list">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  sendResponse({ ok: true, presets: PRESETS.slice() });
  return false;
}

function handleAiProvidersModels(message: Msg<"ai-providers-models">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  const baseUrl = String(message.baseUrl || "").trim();
  if (!baseUrl) {
    sendResponse({ ok: false, error: "请填写 baseUrl" });
    return true;
  }
  withOkResponse(
    fetchAiProviderModels({
      baseUrl,
      apiKey: String(message.apiKey || "").trim(),
      providerId: String(message.providerId || "").trim()
    }),
    sendResponse,
    (error) => (error as Error | undefined)?.message || String(error)
  );
  return true;
}

// ===== ASR 平台消息处理 =====

function handleAsrPresetsList(_message: Msg<"asr-presets-list">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  sendResponse({ ok: true, presets: ASR_PROVIDER_PRESETS.slice() });
  return false;
}

// ASR 平台 CRUD 处理器：连通性测试已迁出 SW，本工厂只负责列表 / Key 的
// 消息路由，与 AI 家族共用同一套契约。
const asrProviderHandlers = createProviderMessageHandlers({
  loadProviders: asrProviderStore.loadProviders,
  saveProviders: asrProviderStore.saveProviders,
  deleteProvider: asrProviderStore.deleteProvider,
  loadKeys: asrProviderStore.loadKeys
});

// 内容脚本 ASR 回退的运行时配置：settings 标量 + provider-store 列表 + 激活
// 平台 Key 一次回包，provider-store 存储层不再进内容 bundle（契约见
// provider-handlers.js）。
const handleGetAsrRuntimeConfig = createAsrRuntimeConfigHandler({
  getMergedSettings,
  loadProviders: asrProviderStore.loadProviders,
  getAsrProviderKey: asrProviderStore.getKey
});

// offscreen 段缓存消息族：offscreen 文档只有 chrome.runtime（平台限制），
// Map-Reduce / 追问链的段缓存读写经此 handler 直调 ai/segment-cache 落真实
// chrome.storage.local（arch-review-2026-09/05，替下 storage-local-bridge 垫片）。
const handleSegmentCache = createSegmentCacheHandler();

// ===== 通用 offscreen 任务通道 =====

// 把任务转发给"临时创建的 offscreen 文档"执行：asr-decode-prepare 建文档 +
// 加防盗链规则（页面侧随后直连 offscreen 的 asr-decode 端口传下载解码任务），
// asr-decode-cleanup 清规则。消息类型分发给对应执行函数。
const offloadTaskHandlers = new Map<string, (message: unknown, sender: MessageSender, sendResponse: SendResponse) => void>([
  [ASR_TASK_PREPARE, handleAsrDecodePrepare],
  [ASR_TASK_CLEANUP, handleAsrDecodeCleanup]
]);

function handleOffloadTask(message: Msg<"offload-task">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  const taskType = String(message.taskType || "").trim();
  const handler = offloadTaskHandlers.get(taskType);
  if (!handler) {
    sendResponse({ ok: false, error: "不支持的 offscreen 任务类型：" + taskType });
    return false;
  }
  handler(message, _sender, sendResponse);
  return true;
}

// 工单 03：offscreen 文档自关闭的代执行（offscreen 无 chrome.offscreen）。
// 发送者校验在执行器内（isOffscreenDocumentSender，与入口守卫共用判定）。
function handleOffscreenRequestCloseMsg(_message: Msg<"offscreen-request-close">, sender: MessageSender, sendResponse: SendResponse): boolean {
  void handleOffscreenRequestClose(_message, sender, sendResponse);
  return true;
}

// 工单 03：offscreen 侧调试日志门的初始开关（offscreen 无 chrome.storage，
// SW 是 storage 的独占读者；变更经下方 onChanged 监听广播）。
function handleGetDebugLogGate(_message: Msg<"get-debug-log-gate">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  withOkResponse(
    (async () => {
      const data = await chrome.storage.sync.get("enableDebugLogs");
      return { ok: true, enabled: Boolean((data as { enableDebugLogs?: unknown })?.enableDebugLogs) };
    })(),
    sendResponse
  );
  return true;
}

// 编译期穷尽路由表（arch-slim-2/02）：字面量表经 satisfies 对
// { [K in BackgroundMessageType]: MessageHandler<Msg<K>> } 校验——
// 消息名 typo / 漏注册 handler / 多注册未知名在 typecheck 即报错（此前 Map +
// 逐条 `as BackgroundHandler` 断言对这一切零捕获）；每个条目的处理器同时按其
// 具体消息形状 Msg<K> 校验，签名与消息类型不匹配同样报错。digest-only-ui：
// open-options 处理器已随 options 页删除（设置已全部并入侧边栏面板，无独立
// 设置页可开）。
const messageHandlerTable = {
  "get-settings": handleGetSettings,
  "save-settings": handleSaveSettings,
  "request-provider-origins": handleRequestProviderOrigins,
  "ensure-offscreen-chat": handleEnsureOffscreenChat,
  "player-ai-quick-action": handlePlayerAiQuickAction,
  "fetch-json": handleFetchJson,
  "ai-providers-list": aiProviderHandlers.list,
  "ai-presets-list": handleAiPresetsList,
  "get-ai-provider-key": aiProviderHandlers.get,
  "ai-providers-save": aiProviderHandlers.save,
  "ai-providers-delete": aiProviderHandlers.remove,
  "ai-providers-models": handleAiProvidersModels,
  "resolve-ai-provider": aiResolvedProviderHandler,
  "asr-presets-list": handleAsrPresetsList,
  "asr-providers-list": asrProviderHandlers.list,
  "asr-providers-save": asrProviderHandlers.save,
  "asr-providers-delete": asrProviderHandlers.remove,
  "get-asr-runtime-config": handleGetAsrRuntimeConfig,
  "segment-cache": handleSegmentCache,
  "offload-task": handleOffloadTask,
  "offscreen-request-close": handleOffscreenRequestCloseMsg,
  "get-debug-log-gate": handleGetDebugLogGate
} satisfies { [K in BackgroundMessageType]: MessageHandler<Msg<K>> };

const messageHandlers = new Map<BackgroundMessageType, BackgroundHandler>(
  Object.entries(messageHandlerTable) as Array<[BackgroundMessageType, BackgroundHandler]>
);

// EXPECTED_CONTENT_SCRIPT_VERSION 单源在 core/content-orchestration-wiring.ts
//（arch-slim-3/04 收编，本文件经 import 消费）。

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await initializeSettingsStorage();
  } catch (error) {
    // 安装/更新迁移失败不进 SW unhandled rejection，只记日志（下次安装/更新
    // 会重试整段迁移）。
    logWarn("[BOC] settings storage init on install/update failed", error);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url) return;
  if (!isSupportedBilibiliPage(tab.url)) return;

  try {
    const loadedVersion = await probeContentScriptVersion(tabId);
    if (loadedVersion !== EXPECTED_CONTENT_SCRIPT_VERSION) {
      await injectReaderContent(tabId);
    }
  } catch (error) {
    // ignore injection failure; user may need a hard refresh
  }
});

// ===== 工具栏 action 点击（工单 02-toolbar-icon-opens-digest）=====

// chrome-types.d.ts 尚未声明 action 命名空间（本工单 scope 外），此处局部最小
// 契约收窄；归并进统一声明后本 cast 可删（TowerFinding 已记录）。可选链守卫：
// 既有测试环境的 chrome stub 可能缺 action 命名空间（生产 MV3 + manifest.action
// 恒有），顶层注册不可因缺命名空间抛错。
interface ActionOnClickedEvent {
  addListener(listener: (tab: chrome.tabs.Tab) => void): void;
}

// 与页内 Digest 按钮同一条 reader-enter 事务：经 triggerReaderModeInTab 的
// 重试/注入链发 reader-enter，content 侧落 entry/message-handler.ts →
// ensureReaderShell 进入事务——不建 popup / Side Panel / 第二套打开流程。
// 目标标签页只取 onClicked 事件自带的活动标签页：reader-enter 载荷没有 tabId
// 字段，跨标签页消息无从伪造目标；非受支持的 B 站视频/稍后再看页直接忽略。
// readerUrl 与页内按钮同源 buildReaderModeUrl（单源 bilibili/video-id-shared.ts，
// SW 侧不 import 拖 core/state 的 bilibili/reader-url.ts）。监听器顶层同步注册
//（MV3：SW 可被重启，事件监听器必须在首个事件前同步就位）。
(chrome as unknown as { action?: { onClicked?: ActionOnClickedEvent } }).action?.onClicked?.addListener(
  async (tab) => {
    const tabId = tab.id ?? 0;
    if (!tabId || !isSupportedBilibiliPage(tab.url)) {
      return;
    }
    const triggered = await triggerReaderModeInTab(tabId, buildReaderModeUrl(tab.url || ""));
    if (!triggered) {
      logWarn("[BOC] toolbar action click: reader-enter 触发失败（重试耗尽）");
    }
  }
);

// ===== 入口监听 =====

// 调试日志门：SW 自读 storage（此前门读 state.settings，SW 里恒为缺省关，
// 用户开的调试日志在 SW 静默）。
registerDebugLogGate();

// 调试日志门变更广播（工单 03）：offscreen 文档没有 chrome.storage，其调试
// 门靠本广播保活（初始开关走 get-debug-log-gate 消息）。无接收方（offscreen
// 未开、扩展页全关）时 sendMessage 会 reject——广播即止，不进 unhandled rejection。
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes.enableDebugLogs) {
    return;
  }
  void Promise.resolve(
    chrome.runtime.sendMessage({
      type: "debug-log-gate-changed",
      enabled: Boolean(changes.enableDebugLogs.newValue)
    })
  ).catch(() => {});
});

// ===== 消息入口守卫（工单 03）：发送者来源 + 内部 schema =====

// 内部消息 schema 的最小校验 + offscreen 专属消息族的来源校验（只拦形状
// 明显非法/来源不合法的请求，业务归一仍归处理器）。offscreen 专属族：扩展级
// 副作用能力只开放给 offscreen 文档本身（SW 代执行的另一面），判定与关闭
// 执行器共用 isOffscreenDocumentSender（asr/offscreen-bridge.bg.ts）。
function illegalMessageReason(message: BackgroundMessage, sender: MessageSender): string | null {
  if (
    (message.type === "segment-cache" || message.type === "offscreen-request-close")
    && !isOffscreenDocumentSender(sender)
  ) {
    return "仅接受 offscreen 文档发送";
  }
  const badShape =
    (message.type === "save-settings" && message.settings != null
      && (typeof message.settings !== "object" || Array.isArray(message.settings)))
    || ((message.type === "ai-providers-save" || message.type === "asr-providers-save")
      && message.providers !== undefined && !Array.isArray(message.providers))
    || (message.type === "player-ai-quick-action" && message.tabId !== undefined
      && !Number.isFinite(message.tabId));
  return badShape ? "消息载荷不合法" : null;
}

chrome.runtime.onMessage.addListener((rawMessage, rawSender, sendResponse: SendResponse) => {
  if (!rawMessage || typeof rawMessage !== "object") {
    return false;
  }

  const message = rawMessage as BackgroundMessage;
  const sender = rawSender as MessageSender;
  const handler = messageHandlers.get(message.type);
  if (!handler) {
    return false;
  }

  // 守卫在路由之后、处理器执行之前：非法来源/载荷在产生任何副作用前被拒绝，
  // 并明确回 { ok:false }（不静默吞，也不让调用方空等）。
  const illegalReason = illegalMessageReason(message, sender);
  if (illegalReason) {
    sendResponse({ ok: false, error: illegalReason });
    return false;
  }

  return handler(message, sender, sendResponse);
});

async function initializeSettingsStorage() {
  const syncCurrent = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  // 2026-09 AI 键默认开一次性迁移：存量显式 false 清位（清位后下方合并以新
  // 默认 true 写回），旗标随本次全量写落盘（语义见 entry/settings-migration.ts）。
  applyPlayerAiQuickActionDefaultOnMigration(syncCurrent);
  // 安装/更新迁移：合并结果先经 normalizeSettings 收口再落盘，存量 LEGACY
  // 默认提示词等旧值在此一次性改写为当前值，而不是每次读取时重复映射。
  await chrome.storage.sync.set(normalizeSettings({ ...DEFAULT_SETTINGS, ...syncCurrent }));
}
