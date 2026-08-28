import {
  DEFAULT_SETTINGS,
  DEFAULT_PLAYER_AI_QUICK_PROMPT,
  PLAYER_AI_QUICK_ACTION_STORAGE_KEY
} from "../core/defaults.js";
import { PRESETS, ASR_PROVIDER_PRESETS } from "../core/presets.js";
import { normalizePlayerAiQuickPrompt } from "../core/validators.js";
import { isSupportedBilibiliPage } from "../bilibili/video-id-shared.js";
import { sleep } from "../shared/utils.js";
import {
  getMergedSettings,
  normalizeSettings,
  saveSettings,
  loadAiProviders,
  saveAiProviders,
  deleteAiProvider,
  loadAiProviderKeys,
  saveAiProviderKey,
  testAiConnection,
  handleAiProvidersModels as fetchAiProviderModels
} from "../core/ai-provider-store.js";
import {
  loadAsrProviders,
  saveAsrProviders,
  deleteAsrProvider,
  loadAsrProviderKeys,
  getAsrProviderKey,
  testAsrConnection
} from "../asr/asr-provider-store.js";
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
import { handleAsrDecodePrepare, handleAsrDecodeCleanup } from "../asr/offscreen-bridge.js";

const EXPECTED_CONTENT_SCRIPT_VERSION = chrome.runtime.getManifest().version || "";

// ===== 消息路由表 =====

function handleGetSettings(message, sender, sendResponse) {
  getMergedSettings()
    .then((settings) => sendResponse({ ok: true, settings }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleSaveSettings(message, sender, sendResponse) {
  saveSettings(message.settings || {})
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleOpenOptions(message, sender, sendResponse) {
  chrome.tabs
    .create({ url: chrome.runtime.getURL("pages/options.html") })
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handlePlayerAiQuickAction(message, sender, sendResponse) {
  const tabId = Number(message.tabId || sender?.tab?.id || 0) || 0;
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
    .catch((error) => sendResponse({ ok: false, error: error.message || "打开 AI 侧边栏失败" }));
  return true;
}

function handleOpenReadingViewTab(message, sender, sendResponse) {
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
    sendResponse({ ok: false, error: error.message || "阅读视图地址无效" });
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
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleCloseReadingViewTab(message, sender, sendResponse) {
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
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleFetchJson(message, sender, sendResponse) {
  const url = typeof message.url === "string" ? message.url : "";
  if (!url) {
    sendResponse({ ok: false, error: "Missing subtitle URL" });
    return false;
  }

  bgFetchJson(url)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => {
      // JSON 解析失败（200 但非 JSON 响应）时给用户稳定的可读文案，而非引擎原生 SyntaxError。
      const message = error instanceof SyntaxError ? "Invalid JSON response" : error.message;
      sendResponse({ ok: false, error: message });
    });
  return true;
}

// Provider CRUD + 连通性测试消息：AI / ASR 两个家族形状相同，统一由
// core/provider-handlers.js 的工厂装配。响应负载与消息名保持不变，
// 路由表只换处理器指向。AI 的 test 消息是平铺字段（Key 可由处理器按
// providerId 代查），用工厂缺省的探针输入装配。
const aiProviderHandlers = createProviderMessageHandlers({
  loadProviders: loadAiProviders,
  saveProviders: saveAiProviders,
  deleteProvider: deleteAiProvider,
  loadKeys: loadAiProviderKeys,
  saveKey: saveAiProviderKey,
  probe: testAiConnection
});

function handleAiPresetsList(message, sender, sendResponse) {
  sendResponse({ ok: true, presets: PRESETS.slice() });
  return false;
}

function handleAiProvidersModels(message, sender, sendResponse) {
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
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
}

// ===== ASR 平台消息处理 =====

function handleAsrPresetsList(message, sender, sendResponse) {
  sendResponse({ ok: true, presets: ASR_PROVIDER_PRESETS.slice() });
  return false;
}

// ASR 的 test 消息把整个 provider 对象放在 message.provider（Key 由探针
// 自行解析），覆写探针输入装配；其余处理器与 AI 家族共用同一套契约。
const asrProviderHandlers = createProviderMessageHandlers({
  loadProviders: loadAsrProviders,
  saveProviders: saveAsrProviders,
  deleteProvider: deleteAsrProvider,
  loadKeys: loadAsrProviderKeys,
  probe: testAsrConnection,
  pickTestProvider: (message) => ({ provider: message.provider || {} })
});

// 内容脚本 ASR 回退的运行时配置：settings 归一化结果 + 激活平台 Key 一次
// 回包，provider-store 存储层不再进内容 bundle（契约见 provider-handlers.js）。
const handleGetAsrRuntimeConfig = createAsrRuntimeConfigHandler({
  getMergedSettings,
  getAsrProviderKey
});

// ===== 通用 offscreen 任务通道 =====

// 把任务转发给"临时创建的 offscreen 文档"执行：asr-decode-prepare 建文档 +
// 加防盗链规则（页面侧随后直连 offscreen 的 asr-decode 端口传下载解码任务），
// asr-decode-cleanup 清规则。消息类型分发给对应执行函数。
const offloadTaskHandlers = new Map([
  ["asr-decode-prepare", handleAsrDecodePrepare],
  ["asr-decode-cleanup", handleAsrDecodeCleanup]
]);

function handleOffloadTask(message, sender, sendResponse) {
  const taskType = String(message.taskType || "").trim();
  const handler = offloadTaskHandlers.get(taskType);
  if (!handler) {
    sendResponse({ ok: false, error: "不支持的 offscreen 任务类型：" + taskType });
    return false;
  }
  handler(message, sender, sendResponse);
  return true;
}

function handleAiSidepanelGetState(message, sender, sendResponse) {
  const tabId = Number(message.tabId || 0) || 0;
  const forceRefresh = message.forceRefresh === true;
  getAiSidepanelState(tabId, { forceRefresh }, {
    ensureReaderContentReady,
    sendMessageToTab
  })
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleAiSidepanelResolveContext(message, sender, sendResponse) {
  resolveAiSidepanelContext(message.contextRef || {})
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleAiSidepanelResolvePageRef(message, sender, sendResponse) {
  resolveAiSidepanelPageRef(message.contextRef || {})
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

const messageHandlers = new Map([
  ["get-settings", handleGetSettings],
  ["save-settings", handleSaveSettings],
  ["open-options", handleOpenOptions],
  ["player-ai-quick-action", handlePlayerAiQuickAction],
  ["open-reading-view-tab", handleOpenReadingViewTab],
  ["close-reading-view-tab", handleCloseReadingViewTab],
  ["fetch-json", handleFetchJson],
  ["ai-providers-list", aiProviderHandlers.list],
  ["ai-presets-list", handleAiPresetsList],
  ["get-ai-provider-key", aiProviderHandlers.get],
  ["ai-providers-save", aiProviderHandlers.save],
  ["ai-provider-set-key", aiProviderHandlers.setKey],
  ["ai-providers-delete", aiProviderHandlers.remove],
  ["ai-providers-test", aiProviderHandlers.test],
  ["ai-providers-models", handleAiProvidersModels],
  ["asr-presets-list", handleAsrPresetsList],
  ["asr-providers-list", asrProviderHandlers.list],
  ["asr-providers-save", asrProviderHandlers.save],
  ["asr-providers-delete", asrProviderHandlers.remove],
  ["get-asr-provider-key", asrProviderHandlers.get],
  ["asr-providers-test", asrProviderHandlers.test],
  ["get-asr-runtime-config", handleGetAsrRuntimeConfig],
  ["offload-task", handleOffloadTask],
  ["ai-sidepanel-get-state", handleAiSidepanelGetState],
  ["ai-sidepanel-resolve-context", handleAiSidepanelResolveContext],
  ["ai-sidepanel-resolve-page-ref", handleAiSidepanelResolvePageRef]
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

async function ensureReaderContentReady(tabId) {
  if (!chrome.scripting || !tabId) {
    return;
  }

  const loadedVersion = await probeContentScriptVersion(tabId);
  if (loadedVersion === EXPECTED_CONTENT_SCRIPT_VERSION) {
    return;
  }

  await injectReaderContent(tabId);
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      await sleep(150);
    }
    const reinjectedVersion = await probeContentScriptVersion(tabId);
    if (reinjectedVersion === EXPECTED_CONTENT_SCRIPT_VERSION) {
      return;
    }
  }

  if (loadedVersion && loadedVersion !== EXPECTED_CONTENT_SCRIPT_VERSION) {
    await chrome.tabs.reload(tabId);
    const ready = await waitForTabComplete(tabId);
    if (!ready) {
      throw new Error("扩展更新后页面未及时恢复，请刷新浏览器网页重试");
    }
    await sleep(120);
    await injectReaderContent(tabId);
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        await sleep(150);
      }
      const reloadedVersion = await probeContentScriptVersion(tabId);
      if (reloadedVersion === EXPECTED_CONTENT_SCRIPT_VERSION) {
        return;
      }
    }
  }

  throw new Error("扩展脚本未能和当前页面同步，请刷新浏览器网页重试");
}

async function probeContentScriptVersion(tabId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const probe = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => globalThis.__BOC_CONTENT_SCRIPT_LOADED__ || ""
      });
      const version = String(probe?.[0]?.result || "");
      if (version) {
        return version;
      }
    } catch {
      // ignore probe failures
    }
    if (attempt < 2) {
      await sleep(100);
    }
  }
  return "";
}

async function injectReaderContent(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["entry/content.css"]
  });

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["entry/content-classic.js"]
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (!message.includes("Identifier 'DEFAULT_SETTINGS' has already been declared")) {
      throw error;
    }
  }
}

async function waitForTabComplete(tabId, retries = 40, delayMs = 250) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") {
      return true;
    }
    await sleep(delayMs);
  }
  return false;
}

async function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

async function triggerReaderModeInTab(tabId, readerUrl = "", retries = 12, delayMs = 300) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (attempt > 0) {
      await sleep(delayMs);
    }

    try {
      const response = await sendMessageToTab(tabId, {
        type: "popup-trigger-reading-view",
        readerUrl
      });
      if (response?.ok) {
        return true;
      }
    } catch (error) {
      const message = String(error?.message || "");
      if (message.includes("Could not establish connection. Receiving end does not exist.")) {
        try {
          await ensureReaderContentReady(tabId);
        } catch {
          // keep retrying
        }
        continue;
      }
    }
  }

  return false;
}

async function triggerReaderModeCloseInTab(tabId, retries = 12, delayMs = 300) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (attempt > 0) {
      await sleep(delayMs);
    }

    try {
      const response = await sendMessageToTab(tabId, {
        type: "popup-close-reading-view"
      });
      if (response?.ok) {
        return true;
      }
    } catch (error) {
      // 忽略瞬时失败（消息端口被提前关闭等），下方会通过 URL 二次确认。
    }

    if (await isTabReaderModeOff(tabId)) {
      return true;
    }
  }

  return false;
}

async function isTabReaderModeOff(tabId) {
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

async function openAiSidepanelForTab(tabId) {
  if (globalThis.browser?.sidebarAction?.open) {
    await Promise.resolve(globalThis.browser.sidebarAction.open());
    return;
  }

  if (chrome.sidePanel?.open) {
    await chrome.sidePanel.open({ tabId });
    return;
  }

  throw new Error("当前浏览器不支持扩展侧边栏");
}

function buildPlayerAiQuickActionRequest(tabId, prompt) {
  const createdAt = Date.now();
  return {
    id: `player-ai-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    tabId: Number(tabId || 0) || 0,
    prompt: normalizePlayerAiQuickPrompt(prompt),
    createdAt
  };
}

// ===== 入口监听 =====

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

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
