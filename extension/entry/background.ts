import {
  DEFAULT_SETTINGS,
  DEFAULT_PLAYER_AI_QUICK_PROMPT
} from "../core/defaults.js";
import { PRESETS, ASR_PROVIDER_PRESETS } from "../core/presets.js";
import { normalizePlayerAiQuickPrompt } from "../core/validators.js";
import { isSupportedBilibiliPage } from "../bilibili/video-id-shared.js";
import {
  injectReaderContent,
  probeContentScriptVersion,
  triggerReaderModeInTab
} from "../core/content-orchestration-wiring.js";
import { sendMessageToTab } from "../shared/tab-utils.js";
import { getMergedSettings, normalizeSettings, saveSettings } from "../core/settings-store.js";
import {
  aiProviderStore,
  handleAiProvidersModels as fetchAiProviderModels
} from "../core/ai-provider-store.js";
import { asrProviderStore } from "../asr/asr-provider-store.js";
import {
  createProviderMessageHandlers,
  createAsrRuntimeConfigHandler
} from "../core/provider-handlers.js";
import { bgFetchJson, isBiliUrl } from "../bilibili/gateway.js";
// digest-only-ui：侧边栏设置面板的 host 权限代申请（collectOrigins 纯函数）
import { collectOrigins } from "../core/host-permissions.js";
// PR5：对话 tab 的 offscreen 文档 ensure 通道（background 侧唯一合法创建点）
import { ensureChatOffscreenDocument } from "../chat/offscreen-ensure.js";
import { handleAsrDecodePrepare, handleAsrDecodeCleanup } from "../asr/offscreen-bridge.bg.js";
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
  getMergedSettings()
    .then((settings) => sendResponse({ ok: true, settings }))
    .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleSaveSettings(message: Msg<"save-settings">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  saveSettings(message.settings || {})
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: (error as Error).message }));
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
  chrome.permissions
    .request({ origins })
    .then((granted) => {
      if (!granted) {
        sendResponse({
          ok: false,
          error: `未授权 ${origins.join("、")}，保存已中止：请重新点击「保存设置」并在弹窗中选择允许`
        });
        return;
      }
      sendResponse({ ok: true });
    })
    .catch((error: Error) => sendResponse({ ok: false, error: `申请域名权限失败：${error.message}` }));
  return true;
}

// PR5：对话 tab（content script）发送前的 offscreen 文档自愈 ensure。chrome.offscreen
// / chrome.runtime.getContexts 仅扩展上下文可用，content script 经此消息委托
// background 幂等创建（sidepanel 扩展页内直调 ensureChatOffscreenDocument 的
// 等价通道）。ensure 失败不阻断发送——connect 由连接结果兜底（与 sidepanel 的
// connectPort 自愈设计一致）。
function handleEnsureOffscreenChat(_message: Msg<"ensure-offscreen-chat">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  ensureChatOffscreenDocument()
    .then((ensured) => sendResponse({ ok: true, ensured }))
    .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

// player-ai 悬浮按钮语义反转（工单 08 决议 2）：不再打开 AI 侧边栏 + 写
// storage 信箱（boc_player_ai_quick_action_v1 已退役），改为「进入/聚焦阅读
// 模式 + 定位对话 tab + 自动发送快捷提示词」——triggerReaderModeInTab 复用
// reader-enter 链（空 readerUrl = 已在阅读模式内，只聚焦），
// 提示词组装后经 player-ai-quick-action-chat 直发 content script，由 reader
// 侧对话 seam runQuickActionPrompt 消费。
function handlePlayerAiQuickAction(message: Msg<"player-ai-quick-action">, sender: MessageSender, sendResponse: SendResponse): boolean {
  const tabId = Number(message.tabId || sender.tab?.id || 0) || 0;
  if (!tabId) {
    sendResponse({ ok: false, error: "找不到当前标签页。" });
    return false;
  }

  getMergedSettings()
    .then(async (settings) => {
      if (!settings.enablePlayerAiQuickAction) {
        throw new Error("AI 按钮未开启");
      }
      const prompt = normalizePlayerAiQuickPrompt(settings.playerAiQuickPrompt || DEFAULT_PLAYER_AI_QUICK_PROMPT);
      const triggered = await triggerReaderModeInTab(tabId, "");
      if (!triggered) {
        throw new Error("阅读模式触发失败，请刷新浏览器网页重试");
      }
      await sendMessageToTab(tabId, { type: "player-ai-quick-action-chat", prompt });
      sendResponse({ ok: true });
    })
    .catch((error: Error) => sendResponse({ ok: false, error: error.message || "打开 AI 对话失败" }));
  return true;
}

// AI 对话入口改道（PR5c）：先经 reader-enter 链打开/进入阅读
// 模式，再把「激活对话 tab + 发送快捷提示词」的意图直发 content script——
// 消费端在 core/message-handler.ts（ensureChatTabActivated + runQuickActionPrompt）。
function handleReaderEnterChat(message: Msg<"reader-enter-chat">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  const tabId = Number(_sender.tab?.id || 0) || 0;
  if (!tabId) {
    sendResponse({ ok: false, error: "找不到当前标签页。" });
    return false;
  }

  getMergedSettings()
    .then(async (settings) => {
      const prompt = normalizePlayerAiQuickPrompt(settings.playerAiQuickPrompt || DEFAULT_PLAYER_AI_QUICK_PROMPT);
      const readerUrl = String(message.readerUrl || "").trim();
      let url = readerUrl;
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
      const triggered = await triggerReaderModeInTab(tabId, url);
      if (!triggered) {
        throw new Error("阅读视图触发失败，请刷新浏览器网页重试");
      }
      await sendMessageToTab(tabId, { type: "reader-enter-chat", prompt });
      sendResponse({ ok: true });
    })
    .catch((error: Error) => sendResponse({ ok: false, error: error.message || "打开 AI 对话失败" }));
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

  bgFetchJson(url)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => {
      // JSON 解析失败（200 但非 JSON 响应）时给用户稳定的可读文案，而非引擎原生 SyntaxError。
      const message = error instanceof SyntaxError ? "Invalid JSON response" : (error as Error).message;
      sendResponse({ ok: false, error: message });
    });
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
  fetchAiProviderModels({
    baseUrl,
    apiKey: String(message.apiKey || "").trim(),
    providerId: String(message.providerId || "").trim()
  })
    .then((payload) => sendResponse(payload))
    .catch((error) => sendResponse({ ok: false, error: (error as Error | undefined)?.message || String(error) }));
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

const messageHandlers = new Map<BackgroundMessageType, BackgroundHandler>([
  ["get-settings", handleGetSettings as BackgroundHandler],
  ["save-settings", handleSaveSettings as BackgroundHandler],
  // digest-only-ui：open-options 处理器已随 options 页删除（设置已全部并入
  // 侧边栏面板，无独立设置页可开）。
  ["request-provider-origins", handleRequestProviderOrigins as BackgroundHandler],
  ["ensure-offscreen-chat", handleEnsureOffscreenChat as BackgroundHandler],
  ["player-ai-quick-action", handlePlayerAiQuickAction as BackgroundHandler],
  ["reader-enter-chat", handleReaderEnterChat as BackgroundHandler],
  ["fetch-json", handleFetchJson as BackgroundHandler],
  ["ai-providers-list", aiProviderHandlers.list as BackgroundHandler],
  ["ai-presets-list", handleAiPresetsList as BackgroundHandler],
  ["get-ai-provider-key", aiProviderHandlers.get as BackgroundHandler],
  ["ai-providers-save", aiProviderHandlers.save as BackgroundHandler],
  ["ai-providers-delete", aiProviderHandlers.remove as BackgroundHandler],
  ["ai-providers-models", handleAiProvidersModels as BackgroundHandler],
  ["asr-presets-list", handleAsrPresetsList as BackgroundHandler],
  ["asr-providers-list", asrProviderHandlers.list as BackgroundHandler],
  ["asr-providers-save", asrProviderHandlers.save as BackgroundHandler],
  ["asr-providers-delete", asrProviderHandlers.remove as BackgroundHandler],
  ["get-asr-runtime-config", handleGetAsrRuntimeConfig as BackgroundHandler],
  ["offload-task", handleOffloadTask as BackgroundHandler]
]);

const EXPECTED_CONTENT_SCRIPT_VERSION = chrome.runtime.getManifest().version || "";

chrome.runtime.onInstalled.addListener(async () => {
  await initializeSettingsStorage();
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

// ===== 入口监听 =====

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

  return handler(message, sender, sendResponse);
});

async function initializeSettingsStorage() {
  const syncCurrent = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  // 安装/更新迁移：合并结果先经 normalizeSettings 收口再落盘，存量 LEGACY
  // 默认提示词等旧值在此一次性改写为当前值，而不是每次读取时重复映射。
  await chrome.storage.sync.set(normalizeSettings({ ...DEFAULT_SETTINGS, ...syncCurrent }));
}
