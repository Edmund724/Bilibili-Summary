import {
  DEFAULT_SETTINGS,
  DEFAULT_PLAYER_AI_QUICK_PROMPT,
  PLAYER_AI_QUICK_ACTION_STORAGE_KEY,
  PRESETS,
  ASR_PROVIDER_PRESETS,
  normalizePlayerAiQuickPrompt,
  isSupportedBilibiliPage,
  sleep
} from "../core/shared-defaults.js";
import {
  getMergedSettings,
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
  testAsrConnection
} from "../asr/asr-provider-store.js";
import {
  getAiSidepanelState,
  resolveAiSidepanelContext,
  resolveAiSidepanelPageRef
} from "../ai/context-resolver.js";
import { bgFetchJson } from "../bilibili/gateway.js";
import { handleAsrDownload } from "../asr/downloader.js";

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

function handleAiProvidersList(message, sender, sendResponse) {
  loadAiProviders()
    .then((items) => sendResponse({ ok: true, providers: items }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleAiPresetsList(message, sender, sendResponse) {
  sendResponse({ ok: true, presets: PRESETS.slice() });
  return false;
}

function handleGetAiProviderKey(message, sender, sendResponse) {
  const providerId = String(message.providerId || "").trim();
  if (!providerId) {
    sendResponse({ ok: false, error: "缺少 providerId" });
    return false;
  }
  loadAiProviderKeys()
    .then((keys) => {
      const apiKey = String(keys[providerId] || "").trim();
      sendResponse({ ok: true, apiKey });
    })
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleAiProvidersSave(message, sender, sendResponse) {
  saveAiProviders(message.providers || [])
    .then((items) => sendResponse({ ok: true, providers: items }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleAiProviderSetKey(message, sender, sendResponse) {
  saveAiProviderKey(String(message.providerId || ""), String(message.apiKey || ""))
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleAiProvidersDelete(message, sender, sendResponse) {
  deleteAiProvider(String(message.providerId || ""))
    .then((items) => sendResponse({ ok: true, providers: items }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleAiProvidersTest(message, sender, sendResponse) {
  const baseUrl = String(message.baseUrl || "").trim();
  const providerId = String(message.providerId || "").trim();
  const model = String(message.model || "").trim();
  if (!baseUrl) {
    sendResponse({ ok: false, error: "请填写 baseUrl" });
    return false;
  }
  Promise.resolve()
    .then(async () => {
      const directApiKey = String(message.apiKey || "").trim();
      if (directApiKey) {
        return directApiKey;
      }
      if (!providerId) {
        return "";
      }
      const keys = await loadAiProviderKeys();
      return String(keys[providerId] || "").trim();
    })
    .then((apiKey) => testAiConnection({ baseUrl, apiKey, model }))
    .then((resp) => sendResponse(resp))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
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

function handleAsrProvidersList(message, sender, sendResponse) {
  loadAsrProviders()
    .then((items) => sendResponse({ ok: true, providers: items }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleAsrProvidersSave(message, sender, sendResponse) {
  saveAsrProviders(message.providers || [])
    .then((items) => sendResponse({ ok: true, providers: items }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleAsrProvidersDelete(message, sender, sendResponse) {
  deleteAsrProvider(String(message.providerId || ""))
    .then((items) => sendResponse({ ok: true, providers: items }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleGetAsrProviderKey(message, sender, sendResponse) {
  const providerId = String(message.providerId || "").trim();
  if (!providerId) {
    sendResponse({ ok: false, error: "缺少 providerId" });
    return false;
  }
  loadAsrProviderKeys()
    .then((keys) => {
      const apiKey = String(keys[providerId] || "").trim();
      sendResponse({ ok: true, apiKey });
    })
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
}

function handleAsrProvidersTest(message, sender, sendResponse) {
  testAsrConnection(message.provider || {})
    .then((resp) => sendResponse(resp))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
}

// ===== ASR 音频下载 =====

// ASR_DOWNLOAD_AUDIO 走专用长连接：页面侧连 "asr-audio-chunk" 端口发
// { audioUrl, backupUrls }，background 侧下载后按块回传，见 asr/downloader.js。
function handleAsrDownloadAudio(message, sender, sendResponse) {
  const { port } = message;
  if (!port) {
    sendResponse({ ok: false, error: "缺少下载端口" });
    return false;
  }
  const audioUrl = typeof message.audioUrl === "string" ? message.audioUrl : "";
  if (!audioUrl) {
    sendResponse({ ok: false, error: "缺少音频地址" });
    return false;
  }
  handleAsrDownload(
    { audioUrl, backupUrls: Array.isArray(message.backupUrls) ? message.backupUrls : [] },
    port
  );
  return false;
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
  ["ai-providers-list", handleAiProvidersList],
  ["ai-presets-list", handleAiPresetsList],
  ["get-ai-provider-key", handleGetAiProviderKey],
  ["ai-providers-save", handleAiProvidersSave],
  ["ai-provider-set-key", handleAiProviderSetKey],
  ["ai-providers-delete", handleAiProvidersDelete],
  ["ai-providers-test", handleAiProvidersTest],
  ["ai-providers-models", handleAiProvidersModels],
  ["asr-presets-list", handleAsrPresetsList],
  ["asr-providers-list", handleAsrProvidersList],
  ["asr-providers-save", handleAsrProvidersSave],
  ["asr-providers-delete", handleAsrProvidersDelete],
  ["get-asr-provider-key", handleGetAsrProviderKey],
  ["asr-providers-test", handleAsrProvidersTest],
  ["asr-download-audio", handleAsrDownloadAudio],
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
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...syncCurrent });
}
