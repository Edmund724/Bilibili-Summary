import {
  DEFAULT_SETTINGS,
  DEFAULT_PLAYER_AI_QUICK_PROMPT,
  PLAYER_AI_QUICK_ACTION_STORAGE_KEY
} from "../core/defaults.js";
import { PRESETS, ASR_PROVIDER_PRESETS } from "../core/presets.js";
import { normalizePlayerAiQuickPrompt } from "../core/validators.js";
import { isSupportedBilibiliPage } from "../bilibili/video-id-shared.js";
import { sendMessageToTab, waitForTabComplete } from "../shared/tab-utils.js";
import { createBackgroundContentOrchestrator } from "./background-content-orchestration.js";
import { getMergedSettings, normalizeSettings, saveSettings } from "../core/settings-store.js";
import {
  aiProviderStore,
  handleAiProvidersModels as fetchAiProviderModels
} from "../core/ai-provider-store.js";
import { asrProviderStore, testAsrConnection } from "../asr/asr-provider-store.js";
import {
  createProviderMessageHandlers,
  createAsrRuntimeConfigHandler
} from "../core/provider-handlers.js";
import {
  getAiSidepanelState,
  resolveAiSidepanelContext,
  resolveAiSidepanelPageRef
} from "../ai/context-resolver.js";
import { bgFetchJson } from "../bilibili/gateway.js";
import { handleAsrDecodePrepare, handleAsrDecodeCleanup } from "../asr/offscreen-bridge.bg.js";
import { ASR_TASK_PREPARE, ASR_TASK_CLEANUP } from "../asr/protocol.js";
import type {
  BackgroundMessage,
  BackgroundMessageType,
  MessageHandler,
  MessageSender,
  SendResponse
} from "../shared/messaging-protocol.js";

const EXPECTED_CONTENT_SCRIPT_VERSION = chrome.runtime.getManifest().version || "";

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

function handleOpenOptions(_message: Msg<"open-options">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  chrome.tabs
    .create({ url: chrome.runtime.getURL("pages/options.html") })
    .then(() => sendResponse({ ok: true }))
    .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handlePlayerAiQuickAction(message: Msg<"player-ai-quick-action">, sender: MessageSender, sendResponse: SendResponse): boolean {
  const tabId = Number(message.tabId || sender.tab?.id || 0) || 0;
  if (!tabId) {
    sendResponse({ ok: false, error: "找不到当前标签页。" });
    return false;
  }

  const openPromise = openAiSidepanelForTab(tabId);
  getMergedSettings()
    .then(async (settings) => {
      if (!settings.enablePlayerAiQuickAction) {
        throw new Error("AI 按钮未开启");
      }
      await openPromise;
      const request = buildPlayerAiQuickActionRequest(tabId, settings.playerAiQuickPrompt);
      await chrome.storage.local.set({ [PLAYER_AI_QUICK_ACTION_STORAGE_KEY]: request });
      sendResponse({ ok: true });
    })
    .catch((error: Error) => sendResponse({ ok: false, error: error.message || "打开 AI 侧边栏失败" }));
  return true;
}

function handleOpenReadingViewTab(message: Msg<"open-reading-view-tab">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  const url = String(message.url || "").trim();
  const tabId = Number(message.tabId || 0) || 0;
  if (!url) {
    sendResponse({ ok: false, error: "缺少视频地址" });
    return false;
  }
  if (!tabId) {
    sendResponse({ ok: false, error: "缺少标签页信息" });
    return false;
  }

  let readerUrl = "";
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "www.bilibili.com") {
      throw new Error("当前网页不是 B 站视频页");
    }
    parsed.searchParams.set("boc_reader", "1");
    readerUrl = parsed.toString();
  } catch (error) {
    sendResponse({ ok: false, error: (error as Error).message || "阅读视图地址无效" });
    return false;
  }

  ensureReaderContentReady(tabId)
    .then(() => triggerReaderModeInTab(tabId, readerUrl))
    .then((triggered) => {
      if (!triggered) {
        throw new Error("阅读视图触发失败，请刷新浏览器网页重试");
      }
      sendResponse({ ok: true });
    })
    .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleCloseReadingViewTab(message: Msg<"close-reading-view-tab">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  const tabId = Number(message.tabId || 0) || 0;
  if (!tabId) {
    sendResponse({ ok: false, error: "缺少标签页信息" });
    return false;
  }

  triggerReaderModeCloseInTab(tabId)
    .then((closed) => {
      if (!closed) {
        throw new Error("退出阅读视图失败，请刷新浏览器网页重试");
      }
      sendResponse({ ok: true });
    })
    .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleFetchJson(message: Msg<"fetch-json">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  const url = typeof message.url === "string" ? message.url : "";
  if (!url) {
    sendResponse({ ok: false, error: "Missing subtitle URL" });
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
// 路由表只换处理器指向。AI 的连通性测试（ai-providers-test）已移出 SW：
// options 页直调 ai/provider-test.js（host_permissions 对扩展页面同样生效），
// 探针的 completion 链不再进 SW 图（候选 04 拆链），故本工厂不再注入 probe。
// @ts-expect-error AI 家族不使用 test 处理器，probe 仅由 ASR 家族注入。
const aiProviderHandlers = createProviderMessageHandlers({
  loadProviders: aiProviderStore.loadProviders,
  saveProviders: aiProviderStore.saveProviders,
  deleteProvider: aiProviderStore.deleteProvider,
  loadKeys: aiProviderStore.loadKeys,
  saveKey: aiProviderStore.saveKey
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

// ASR 的 test 消息把整个 provider 对象放在 message.provider（Key 由探针
// 自行解析），覆写探针输入装配；其余处理器与 AI 家族共用同一套契约。
const asrProviderHandlers = createProviderMessageHandlers({
  loadProviders: asrProviderStore.loadProviders,
  saveProviders: asrProviderStore.saveProviders,
  deleteProvider: asrProviderStore.deleteProvider,
  loadKeys: asrProviderStore.loadKeys,
  probe: testAsrConnection,
  pickTestProvider: (message) => ({ provider: message.provider || {} })
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

function handleAiSidepanelGetState(message: Msg<"ai-sidepanel-get-state">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  const tabId = Number(message.tabId || 0) || 0;
  const forceRefresh = message.forceRefresh === true;
  // 候选5：透传 SP 上次全量快照的签名给 content 判短路（不可信输入按空串
  // 处理，空串 = 不短路走全量）；getAiSidepanelState 命中短路时返回
  // { unchanged: true }，经下方统一包装成 { ok, payload } 回给 SP。
  const ifSignature = String(message.ifSignature || "");
  getAiSidepanelState(tabId, { forceRefresh, ifSignature }, {
    ensureReaderContentReady,
    sendMessageToTab
  })
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleAiSidepanelResolveContext(message: Msg<"ai-sidepanel-resolve-context">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  resolveAiSidepanelContext(message.contextRef || {})
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleAiSidepanelResolvePageRef(message: Msg<"ai-sidepanel-resolve-page-ref">, _sender: MessageSender, sendResponse: SendResponse): boolean {
  resolveAiSidepanelPageRef(message.contextRef || {})
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

const messageHandlers = new Map<BackgroundMessageType, BackgroundHandler>([
  ["get-settings", handleGetSettings as BackgroundHandler],
  ["save-settings", handleSaveSettings as BackgroundHandler],
  ["open-options", handleOpenOptions as BackgroundHandler],
  ["player-ai-quick-action", handlePlayerAiQuickAction as BackgroundHandler],
  ["open-reading-view-tab", handleOpenReadingViewTab as BackgroundHandler],
  ["close-reading-view-tab", handleCloseReadingViewTab as BackgroundHandler],
  ["fetch-json", handleFetchJson as BackgroundHandler],
  ["ai-providers-list", aiProviderHandlers.list as BackgroundHandler],
  ["ai-presets-list", handleAiPresetsList as BackgroundHandler],
  ["get-ai-provider-key", aiProviderHandlers.get as BackgroundHandler],
  ["ai-providers-save", aiProviderHandlers.save as BackgroundHandler],
  ["ai-provider-set-key", aiProviderHandlers.setKey! as BackgroundHandler],
  ["ai-providers-delete", aiProviderHandlers.remove as BackgroundHandler],
  ["ai-providers-models", handleAiProvidersModels as BackgroundHandler],
  ["asr-presets-list", handleAsrPresetsList as BackgroundHandler],
  ["asr-providers-list", asrProviderHandlers.list as BackgroundHandler],
  ["asr-providers-save", asrProviderHandlers.save as BackgroundHandler],
  ["asr-providers-delete", asrProviderHandlers.remove as BackgroundHandler],
  ["get-asr-provider-key", asrProviderHandlers.get as BackgroundHandler],
  ["asr-providers-test", asrProviderHandlers.test as BackgroundHandler],
  ["get-asr-runtime-config", handleGetAsrRuntimeConfig as BackgroundHandler],
  ["offload-task", handleOffloadTask as BackgroundHandler],
  ["ai-sidepanel-get-state", handleAiSidepanelGetState as BackgroundHandler],
  ["ai-sidepanel-resolve-context", handleAiSidepanelResolveContext as BackgroundHandler],
  ["ai-sidepanel-resolve-page-ref", handleAiSidepanelResolvePageRef as BackgroundHandler]
]);

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

// ===== 内容脚本注入生命周期 =====
//
// 时序与错误分类编排在 entry/background-content-orchestration.js（行为契约由
// tests/entry/background-orchestration.test.js 用假时钟锁定）；本节只把真实
// chrome API 组装成编排所需的单发副作用并完成一次性接线。

// 版本探针单发：读页面里 content 主包置的版本哨兵，空串 = 未读到；API 抛错
// 交给编排层吞掉重试，单发自身不 try/catch。
function probeContentScriptVersionOnce(tabId: number) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: () => (globalThis as Record<string, unknown>).__BOC_CONTENT_SCRIPT_LOADED__ || ""
  }).then((probe) => String(probe?.[0]?.result || ""));
}

async function injectReaderAssets(tabId: number) {
  // S3 分层：修复注入语义是「补齐整页样式」（页面可能被 manifest 注入路径
  // 遗漏，阅读模式可能正处于开启状态），因此常驻表 + 阅读表全量注入；播放器
  // AI 表不需要——它只随 ai/player-ai.js 模块装载挂载，与内容脚本注入无关。
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["entry/styles/panel.css", "entry/styles/reader.css", "entry/styles/reader-gate.css"]
  });

  await chrome.scripting.executeScript({
    // 候选4 分包后这里注入 classic bootstrap：它置版本哨兵后异步拉起 ESM
    // 主包（manifest.content_scripts 指向同一文件，注入语义一致）。重复注入
    // 由 bootstrap 的 __BOC_CONTENT_BOOTSTRAP_STARTED__ 标志挡住；classic 重复
    // 注入的词法冲突哨兵（见 shared/content-error-sentinels.js）由编排层吞掉。
    target: { tabId },
    files: ["entry/content-bootstrap.iife.js"]
  });
}

const {
  ensureReaderContentReady,
  probeContentScriptVersion,
  injectReaderContent,
  triggerReaderModeInTab,
  triggerReaderModeCloseInTab
} = createBackgroundContentOrchestrator({
  // 单发副作用（chrome API 触点）
  probeOnce: probeContentScriptVersionOnce,
  injectAssets: injectReaderAssets,
  reloadTab: (tabId: number) => chrome.tabs.reload(tabId),
  waitForTabComplete,
  sendMessageToTab,
  isTabReaderModeOff,
  // 前置守卫：无 scripting 能力或无 tabId 时，编排按「无事可做」直接返回
  // （与抽离前 ensureReaderContentReady 开头的 `!chrome.scripting || !tabId` 等价）。
  canInject: (tabId: number) => Boolean(chrome.scripting) && Boolean(tabId),
  expectedVersion: EXPECTED_CONTENT_SCRIPT_VERSION
});

async function isTabReaderModeOff(tabId: number) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url) {
    return false;
  }
  try {
    return new URL(tab.url).searchParams.get("boc_reader") !== "1";
  } catch {
    return false;
  }
}

// ===== AI 侧边栏编排（打开面板 + 快速请求）=====

async function openAiSidepanelForTab(tabId: number) {
  // 仅支持 Chrome（ADR-0002）：侧边栏统一走 chrome.sidePanel，Firefox 的
  // sidebarAction fallback 已随 Firefox 兼容一并删除。
  if (chrome.sidePanel?.open) {
    await chrome.sidePanel.open({ tabId });
    return;
  }

  throw new Error("当前浏览器不支持扩展侧边栏");
}

function buildPlayerAiQuickActionRequest(tabId: number, prompt: string) {
  const createdAt = Date.now();
  return {
    id: `player-ai-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    tabId: Number(tabId || 0) || 0,
    prompt: normalizePlayerAiQuickPrompt(prompt),
    createdAt
  };
}

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
