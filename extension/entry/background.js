import {
  DEFAULT_SETTINGS,
  DEFAULT_PLAYER_AI_QUICK_PROMPT,
  DEFAULT_AI_SYSTEM_PROMPT,
  DEFAULT_INITIAL_QUICK_PROMPTS,
  DEFAULT_PRESET_PROMPTS,
  PLAYER_AI_QUICK_ACTION_STORAGE_KEY,
  PRESETS,
  getPresetById,
  normalizeDownloadFormat,
  normalizeIncludeHotCommentsInNote,
  normalizeEnablePlayerAiQuickAction,
  normalizePlayerAiQuickPrompt,
  normalizeReaderTheme,
  normalizeReaderFontScale,
  normalizeReaderLetterSpacing,
  normalizeReaderLineHeight,
  normalizeReaderContentWidth,
  normalizeReaderChapterVisibility,
  normalizeReaderTranscriptVisible,
  normalizeFixedFrontmatterProperties,
  normalizeNotePlaceholderSections,
  normalizeAiSystemPrompt,
  normalizeAiInitialQuickPrompts,
  normalizeAiPresetPrompts,
  normalizeDefaultModel,
  normalizeBaseUrl,
  isSupportedBilibiliPage,
  sleep
} from "../core/shared-defaults.js";
import { formatCompactTimestamp } from "../shared/string-utils.js";
import { getSubtitleCacheKey, loadSubtitleFromCache } from "../subtitle/cache.js";
import { fetchVideoMeta, fetchSubtitleBundle, fetchSubtitleBody, fetchHotComments, bgFetchJson, isBiliUrl } from "../bili-gateway.js";
import { extractBvidFromUrl, extractPageIndexFromUrl, buildCanonicalVideoUrl } from "../bilibili/video-id-shared.js";
import {
  pickPreferredSubtitle as pickPreferredSubtitleTrack,
  normalizeSubtitleTracks
} from "../subtitle/selection.js";

const EXPECTED_CONTENT_SCRIPT_VERSION = chrome.runtime.getManifest().version || "";

// ===== 消息路由表（Candidate 8） =====

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

function handleFetchJson(message, sender, sendResponse) {
  const url = typeof message.url === "string" ? message.url : "";
  if (!url) {
    sendResponse({ ok: false, error: "Missing subtitle URL" });
    return false;
  }

  const isBiliRequest = isBiliUrl(url);
  const headers = new Headers();
  if (isBiliRequest) {
    headers.set("Accept", "application/json, text/plain, */*");
    headers.set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
    headers.set("Cache-Control", "no-cache");
    headers.set("Pragma", "no-cache");
  }

  const fetchOptions = {
    method: "GET",
    credentials: "include",
    cache: "no-store"
  };
  if (headers.size > 0) {
    fetchOptions.headers = headers;
  }
  if (isBiliRequest) {
    fetchOptions.referrer = "https://www.bilibili.com/";
    fetchOptions.referrerPolicy = "strict-origin-when-cross-origin";
  }

  fetch(url, fetchOptions)
    .then(async (response) => {
      if (!response.ok) {
        sendResponse({ ok: false, error: `HTTP ${response.status}` });
        return;
      }

      const text = await response.text();
      try {
        const data = JSON.parse(text);
        sendResponse({ ok: true, data });
      } catch {
        sendResponse({ ok: false, error: "Invalid JSON response" });
      }
    })
    .catch((error) => sendResponse({ ok: false, error: error.message }));
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
  try {
    const baseUrl = String(message.baseUrl || "").trim();
    const apiKey = String(message.apiKey || "").trim();
    const providerId = String(message.providerId || "").trim();
    if (!baseUrl) {
      sendResponse({ ok: false, error: "请填写 baseUrl" });
      return true;
    }
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
    const headers = { Accept: "application/json" };
    let timer = null;
    let responded = false;

    const respond = (payload) => {
      try {
        if (responded) {
          console.warn("[ai-providers-models] duplicate respond ignored");
          return;
        }
        responded = true;
        if (timer) { clearTimeout(timer); timer = null; }
        console.log("[ai-providers-models] responding", payload);
        sendResponse(payload);
      } catch (err) {
        console.error("[ai-providers-models] sendResponse failed", err?.message || err);
      }
    };

    console.log("[ai-providers-models] fetching", normalizedBaseUrl, "providerId", providerId, "hasApiKey", Boolean(apiKey));

    Promise.resolve()
      .then(async () => {
        if (apiKey) return apiKey;
        if (!providerId) return "";
        const keys = await loadAiProviderKeys();
        return String(keys[providerId] || "").trim();
      })
      .then((resolvedKey) => {
        if (resolvedKey) headers["Authorization"] = `Bearer ${resolvedKey}`;
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), 15000);
        console.log("[ai-providers-models] requesting", `${normalizedBaseUrl}/v1/models`);
        return fetch(`${normalizedBaseUrl}/v1/models`, { headers, method: "GET", signal: controller.signal })
          .then((resp) => {
            console.log("[ai-providers-models] response status", resp.status, resp.statusText);
            if (!resp.ok) {
              return resp.text().then((text) => {
                throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
              });
            }
            return resp.json().then((data) => ({ ok: true, data })).catch((err) => {
              throw new Error(`无法解析模型列表：${err?.message || String(err)}`);
            });
          })
          .then(({ data }) => {
            const models = [];
            if (Array.isArray(data?.data)) {
              for (const item of data.data) {
                if (item?.id) models.push(String(item.id));
              }
            }
            console.log("[ai-providers-models] parsed models", models.length);
            return models;
          });
      })
      .then((models) => respond({ ok: true, models }))
      .catch((error) => {
        console.error("[ai-providers-models] fetch error", error?.name, error?.message || error);
        if (error?.name === "AbortError") {
          respond({ ok: false, error: "请求超时，请检查 baseUrl 或稍后重试" });
        } else {
          respond({ ok: false, error: error?.message || String(error) });
        }
      });

    // Safety net: ensure we always respond within the timeout window.
    timer = setTimeout(() => {
      console.warn("[ai-providers-models] safety net triggered");
      respond({ ok: false, error: "请求超时，请检查 baseUrl 或稍后重试" });
    }, 16000);
  } catch (error) {
    console.error("[ai-providers-models] handler error", error?.message || error);
    sendResponse({ ok: false, error: error?.message || String(error) });
  }
  return true;
}

function handleAiSidepanelGetState(message, sender, sendResponse) {
  const tabId = Number(message.tabId || 0) || 0;
  const forceRefresh = message.forceRefresh === true;
  getAiSidepanelState(tabId, { forceRefresh })
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
  ["fetch-json", handleFetchJson],
  ["ai-providers-list", handleAiProvidersList],
  ["ai-presets-list", handleAiPresetsList],
  ["get-ai-provider-key", handleGetAiProviderKey],
  ["ai-providers-save", handleAiProvidersSave],
  ["ai-provider-set-key", handleAiProviderSetKey],
  ["ai-providers-delete", handleAiProvidersDelete],
  ["ai-providers-test", handleAiProvidersTest],
  ["ai-providers-models", handleAiProvidersModels],
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



async function getAiSidepanelState(tabId, { forceRefresh = false } = {}) {
  if (!tabId) {
    throw new Error("缺少标签页信息");
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id) {
    throw new Error("找不到当前标签页。");
  }

  if (!isSupportedBilibiliPage(tab.url)) {
    return {
      title: String(tab.title || "").trim(),
      url: String(tab.url || "").trim(),
      author: "",
      uploadDate: "",
      subtitleMarkdown: "",
      subtitleBody: [],
      hotComments: [],
      isVideoContext: false
    };
  }

  await ensureReaderContentReady(tab.id);

  let contextResp = await sendMessageToTab(tab.id, { type: "sidepanel-get-context" });
  const hasPayload = Boolean(contextResp?.ok && contextResp?.payload);
  const hasLoadedClip = Boolean(
    contextResp?.payload?.bvid ||
    contextResp?.payload?.aid ||
    contextResp?.payload?.title
  );
  const needsRefresh =
    forceRefresh ||
    !hasPayload ||
    (!hasLoadedClip && (!Array.isArray(contextResp.payload.subtitleBody) || !contextResp.payload.subtitleBody.length));

  if (needsRefresh) {
    const refreshResp = await sendMessageToTab(tab.id, { type: "popup-refresh" });
    if (!refreshResp?.ok) {
      throw new Error(refreshResp?.error || "当前视频上下文加载失败");
    }
    contextResp = await sendMessageToTab(tab.id, { type: "sidepanel-get-context" });
  }

  if (!contextResp?.ok || !contextResp?.payload) {
    throw new Error("当前页面上下文读取失败");
  }

  let hotComments = [];
  try {
    const commentsResp = await sendMessageToTab(tab.id, { type: "sidepanel-get-hot-comments" });
    if (commentsResp?.ok && Array.isArray(commentsResp.comments)) {
      hotComments = commentsResp.comments;
    }
  } catch {
    // 评论失败时静默降级，避免阻断主流程
  }

  return {
    ...contextResp.payload,
    hotComments,
    isVideoContext: true
  };
}

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

function normalizeAiContextRef(ref) {
  const value = ref && typeof ref === "object" ? ref : {};
  return {
    title: String(value.title || "").trim(),
    url: String(value.url || "").trim(),
    author: String(value.author || "").trim(),
    uploadDate: String(value.uploadDate || "").trim(),
    bvid: String(value.bvid || extractBvidFromUrl(value.url) || "").trim(),
    cid: String(value.cid || "").trim(),
    aid: String(value.aid || "").trim(),
    pageIndex: Number(value.pageIndex) > 0 ? Number(value.pageIndex) : 1,
    pageCount: Number(value.pageCount) > 0 ? Number(value.pageCount) : 0,
    pageTitle: String(value.pageTitle || "").trim(),
    subtitleLang: String(value.subtitleLang || "").trim(),
    selectedSubtitleId: String(value.selectedSubtitleId || "").trim(),
    selectedSubtitleUrl: String(value.selectedSubtitleUrl || "").trim(),
    isVideoContext: value.isVideoContext !== false
  };
}

function pickPageForAiContext(pages, ref) {
  const safePages = Array.isArray(pages) ? pages : [];
  const targetCid = String(ref?.cid || "").trim();
  if (targetCid) {
    const byCid = safePages.find((item) => String(item?.cid || "") === targetCid);
    if (byCid) {
      return byCid;
    }
  }

  const pageIndex = extractPageIndexFromUrl(ref?.url || "");
  const byPage = safePages.find((item) => Number(item?.page) === pageIndex);
  if (byPage) {
    return byPage;
  }
}

function shouldShowHoursInAiNote(meta, body) {
  const subtitleMaxTo = (body || []).reduce((max, item) => Math.max(max, Number(item?.to || 0) || 0), 0);
  const chapterMaxTo = (meta?.chapters || []).reduce((max, item) => Math.max(max, Number(item?.from || 0) || 0, Number(item?.to || 0) || 0), 0);
  const duration = Number(meta?.videoDuration || 0) || 0;
  return Math.max(subtitleMaxTo, chapterMaxTo, duration) >= 3600;
}

function buildAiSubtitleLine(item, includeTimestampInBody, withHours) {
  const text = String(item?.content || "").trim();
  if (!text) {
    return "";
  }
  if (!includeTimestampInBody) {
    return text;
  }
  return `\`${formatCompactTimestamp(item.from, withHours)}\` ${text}`;
}

function buildAiSubtitleSectionLines(body, chapters, includeTimestampInBody, withHours) {
  const subtitleItems = (body || [])
    .map((item, index) => ({ ...item, _index: index, text: String(item?.content || "").trim() }))
    .filter((item) => item.text);
  if (!subtitleItems.length) {
    return ["（暂无字幕）"];
  }

  if (!Array.isArray(chapters) || !chapters.length) {
    return subtitleItems.map((item) => buildAiSubtitleLine(item, includeTimestampInBody, withHours));
  }

  const lines = [];
  const usedIndexes = new Set();
  chapters.forEach((chapter, idx) => {
    const start = Number(chapter.from || 0) || 0;
    const next = chapters[idx + 1];
    const chapterTo = Number(chapter.to || 0) || 0;
    let end = Infinity;
    if (next && Number(next.from) > start) {
      end = Number(next.from);
    } else if (chapterTo > start) {
      end = chapterTo;
    }
    const sectionItems = subtitleItems.filter((item) => {
      const from = Number(item.from || 0) || 0;
      return from + 0.001 >= start && (end === Infinity ? true : from < end);
    });
    if (!sectionItems.length) {
      return;
    }
    const chapterStamp = includeTimestampInBody ? ` \`${formatCompactTimestamp(start, withHours)}\`` : "";
    lines.push(`### ${chapter.title}${chapterStamp}`, "");
    sectionItems.forEach((item) => {
      usedIndexes.add(item._index);
      lines.push(buildAiSubtitleLine(item, includeTimestampInBody, withHours));
    });
    lines.push("");
  });

  const remaining = subtitleItems.filter((item) => !usedIndexes.has(item._index));
  if (remaining.length) {
    lines.push("### 其他片段", "");
    remaining.forEach((item) => lines.push(buildAiSubtitleLine(item, includeTimestampInBody, withHours)));
  }

  while (lines.length && !lines[lines.length - 1]) {
    lines.pop();
  }
  return lines;
}

function buildAiConversationMarkdown(meta, body, settings) {
  const includeTimestampInBody = settings?.includeTimestampInBody !== false;
  const withHours = shouldShowHoursInAiNote(meta, body);
  const lines = [];
  const chapters = Array.isArray(meta?.chapters) ? meta.chapters : [];
  if (chapters.length) {
    lines.push("## 章节", "");
    chapters.forEach((item) => {
      const stamp = includeTimestampInBody ? `\`${formatCompactTimestamp(item.from, withHours)}\` ` : "";
      lines.push(`- ${stamp}${item.title}`);
    });
    lines.push("");
  }
  lines.push("## 字幕", "", ...buildAiSubtitleSectionLines(body, chapters, includeTimestampInBody, withHours));
  return lines.join("\n");
}

async function resolveAiSidepanelContext(contextRef) {
  const ref = normalizeAiContextRef(contextRef);
  if (!ref.isVideoContext || !ref.bvid) {
    return {
      title: ref.title,
      url: ref.url,
      author: ref.author,
      uploadDate: ref.uploadDate,
      subtitleMarkdown: "",
      subtitleBody: [],
      hotComments: [],
      isVideoContext: false
    };
  }

  const settings = await getMergedSettings();
  const videoMeta = await fetchVideoMeta(bgFetchJson, ref.bvid);
  const page = pickPageForAiContext(videoMeta.pages, ref);
  const cid = String(page?.cid || ref.cid || videoMeta.defaultCid || "").trim();
  if (!cid) {
    throw new Error("无法定位原视频分P");
  }
  const aid = String(videoMeta.aid || ref.aid || "").trim();
  const subtitleBundle = await fetchSubtitleBundle(bgFetchJson, { bvid: ref.bvid, cid, aid });
  const tracks = normalizeSubtitleTracks(subtitleBundle.tracks || []);
  if (!tracks.length) {
    throw new Error("原视频暂时没有可用字幕");
  }
  const selectedTrack = pickPreferredSubtitleTrack(tracks, {
    previousId: ref.selectedSubtitleId,
    previousUrl: ref.selectedSubtitleUrl,
    previousLang: ref.subtitleLang
  }) || tracks[0];
  const cacheKey = getSubtitleCacheKey({
    bvid: ref.bvid,
    cid,
    subtitleId: selectedTrack.id,
    subtitleUrl: selectedTrack.subtitleUrl,
    lang: selectedTrack.lanDoc || selectedTrack.lan
  });
  const cachedBody = await loadSubtitleFromCache(cacheKey);
  const body = Array.isArray(cachedBody) && cachedBody.length > 0
    ? cachedBody
    : await fetchSubtitleBody(bgFetchJson, selectedTrack.subtitleUrl);
  if (!body.length) {
    throw new Error("原视频字幕为空");
  }

  const pageIndex = Number(page?.page || extractPageIndexFromUrl(ref.url) || 1) || 1;
  const hotComments = await fetchHotComments(bgFetchJson, aid);
  const title = String(videoMeta.title || ref.title || "").trim();
  const author = String(videoMeta.author || ref.author || "").trim();
  const uploadDate = String(videoMeta.uploadDate || ref.uploadDate || "").trim();
  const pageTitle = String(page?.part || ref.pageTitle || "").trim();
  const url = buildCanonicalVideoUrl(ref.bvid, pageIndex) || ref.url;
  const contextMeta = {
    title,
    chapters: subtitleBundle.chapters || [],
    videoDuration: Number(page?.duration || videoMeta.defaultDuration || 0) || 0
  };

  return {
    title,
    url,
    author,
    uploadDate,
    bvid: ref.bvid,
    cid,
    aid,
    pageIndex,
    pageTitle,
    subtitleLang: String(selectedTrack.lanDoc || selectedTrack.lan || "").trim(),
    selectedSubtitleId: String(selectedTrack.id || "").trim(),
    selectedSubtitleUrl: String(selectedTrack.subtitleUrl || "").trim(),
    subtitleBody: body,
    subtitleMarkdown: buildAiConversationMarkdown(contextMeta, body, settings),
    subtitleOptions: tracks.map((item) => ({
      id: String(item.id || "").trim(),
      url: String(item.subtitleUrl || "").trim(),
      lang: String(item.lanDoc || item.lan || "").trim()
    })),
    hotComments,
    isVideoContext: true
  };
}

async function resolveAiSidepanelPageRef(contextRef) {
  const ref = normalizeAiContextRef(contextRef);
  if (!ref.isVideoContext || !ref.bvid) {
    return {
      url: ref.url,
      bvid: ref.bvid,
      cid: ref.cid,
      pageIndex: Number(ref.pageIndex) > 0 ? Number(ref.pageIndex) : 1,
      pageTitle: ref.pageTitle
    };
  }

  const videoMeta = await fetchVideoMeta(bgFetchJson, ref.bvid);
  const page = pickPageForAiContext(videoMeta.pages, ref);
  const pageIndex = Number(page?.page || ref.pageIndex || extractPageIndexFromUrl(ref.url) || 1) || 1;
  return {
    url: buildCanonicalVideoUrl(ref.bvid, pageIndex) || ref.url,
    bvid: ref.bvid,
    cid: String(page?.cid || ref.cid || "").trim(),
    pageIndex,
    pageTitle: String(page?.part || ref.pageTitle || "").trim()
  };
}

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

async function getMergedSettings(timeoutMs = 5000) {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("storage timeout")), timeoutMs);
  });
  const syncSettings = await Promise.race([
    chrome.storage.sync.get(DEFAULT_SETTINGS),
    timeoutPromise
  ]).catch(() => ({}));

  const merged = { ...DEFAULT_SETTINGS, ...syncSettings };
  merged.downloadFormat = normalizeDownloadFormat(merged.downloadFormat);
  merged.includeHotCommentsInNote = normalizeIncludeHotCommentsInNote(merged.includeHotCommentsInNote);
  merged.enablePlayerAiQuickAction = normalizeEnablePlayerAiQuickAction(merged.enablePlayerAiQuickAction);
  merged.playerAiQuickPrompt = normalizePlayerAiQuickPrompt(merged.playerAiQuickPrompt);
  merged.readerTheme = normalizeReaderTheme(merged.readerTheme);
  merged.readerFontScale = normalizeReaderFontScale(merged.readerFontScale);
  merged.readerLetterSpacing = normalizeReaderLetterSpacing(merged.readerLetterSpacing ?? merged.readerLineHeight);
  merged.readerLineHeight = normalizeReaderLineHeight(merged.readerLineHeight);
  merged.readerContentWidth = normalizeReaderContentWidth(merged.readerContentWidth);
  merged.readerChapterVisibility = normalizeReaderChapterVisibility(merged.readerChapterVisibility);
  merged.readerTranscriptVisible = normalizeReaderTranscriptVisible(merged.readerTranscriptVisible);
  merged.fixedFrontmatterProperties = normalizeFixedFrontmatterProperties(merged.fixedFrontmatterProperties);
  merged.notePlaceholderSections = normalizeNotePlaceholderSections(merged.notePlaceholderSections);
  merged.aiSystemPrompt = normalizeAiSystemPrompt(merged.aiSystemPrompt);
  merged.aiInitialQuickPrompts = normalizeAiInitialQuickPrompts(merged.aiInitialQuickPrompts);
  merged.aiPresetPrompts = normalizeAiPresetPrompts(merged.aiPresetPrompts);
  merged.defaultModel = normalizeDefaultModel(merged.defaultModel);

  return merged;
}

async function saveSettings(settings) {
  const payload = settings && typeof settings === "object" ? settings : {};
  const syncPayload = { ...payload };
  syncPayload.downloadFormat = normalizeDownloadFormat(syncPayload.downloadFormat);
  syncPayload.includeHotCommentsInNote = normalizeIncludeHotCommentsInNote(syncPayload.includeHotCommentsInNote);
  syncPayload.enablePlayerAiQuickAction = normalizeEnablePlayerAiQuickAction(syncPayload.enablePlayerAiQuickAction);
  syncPayload.playerAiQuickPrompt = normalizePlayerAiQuickPrompt(syncPayload.playerAiQuickPrompt);
  syncPayload.readerTheme = normalizeReaderTheme(syncPayload.readerTheme);
  syncPayload.readerFontScale = normalizeReaderFontScale(syncPayload.readerFontScale);
  syncPayload.readerLetterSpacing = normalizeReaderLetterSpacing(
    syncPayload.readerLetterSpacing ?? syncPayload.readerLineHeight
  );
  syncPayload.readerLineHeight = normalizeReaderLineHeight(syncPayload.readerLineHeight);
  syncPayload.readerContentWidth = normalizeReaderContentWidth(syncPayload.readerContentWidth);
  syncPayload.readerChapterVisibility = normalizeReaderChapterVisibility(syncPayload.readerChapterVisibility);
  syncPayload.readerTranscriptVisible = normalizeReaderTranscriptVisible(syncPayload.readerTranscriptVisible);
  syncPayload.fixedFrontmatterProperties = normalizeFixedFrontmatterProperties(syncPayload.fixedFrontmatterProperties);
  syncPayload.notePlaceholderSections = normalizeNotePlaceholderSections(syncPayload.notePlaceholderSections);
  syncPayload.aiSystemPrompt = normalizeAiSystemPrompt(syncPayload.aiSystemPrompt);
  syncPayload.aiInitialQuickPrompts = normalizeAiInitialQuickPrompts(syncPayload.aiInitialQuickPrompts);
  syncPayload.aiPresetPrompts = normalizeAiPresetPrompts(syncPayload.aiPresetPrompts);
  syncPayload.defaultModel = normalizeDefaultModel(syncPayload.defaultModel);

  await chrome.storage.sync.set(syncPayload);
}

// ===== AI 模型平台存储 =====

const AI_PROVIDER_KEYS_STORAGE = "aiProviderKeys";

function normalizeAiProvider(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || "").trim();
  if (!id) return null;
  return {
    id,
    presetId: String(item.presetId || "custom"),
    name: String(item.name || "自定义").trim() || "自定义",
    baseUrl: String(item.baseUrl || "").trim().replace(/\/+$/, ""),
    model: String(item.model || "").trim(),
    requiresKey: item.requiresKey !== false,
    enabled: item.enabled !== false
  };
}

async function loadAiProviders() {
  const [syncData, keys] = await Promise.all([
    chrome.storage.sync.get(["aiProviders"]),
    loadAiProviderKeys()
  ]);
  const list = Array.isArray(syncData.aiProviders) ? syncData.aiProviders : [];
  return list
    .map(normalizeAiProvider)
    .filter(Boolean)
    .map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
}

async function saveAiProviders(items) {
  const rawList = Array.isArray(items) ? items : [];
  const keys = await loadAiProviderKeys();
  const nextList = [];
  for (const raw of rawList) {
    const normalized = normalizeAiProvider(raw);
    if (!normalized) continue;
    nextList.push(normalized);
    const incomingKey = String(raw?.apiKey || "").trim();
    if (incomingKey) {
      keys[normalized.id] = incomingKey;
    }
  }
  await Promise.all([
    chrome.storage.sync.set({ aiProviders: nextList }),
    chrome.storage.local.set({ [AI_PROVIDER_KEYS_STORAGE]: keys })
  ]);
  // 返回带 hasSavedKey 的列表，方便前端渲染占位
  return nextList.map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
}

async function deleteAiProvider(providerId) {
  const list = await loadAiProviders();
  const next = list.filter((p) => p.id !== providerId);
  await chrome.storage.sync.set({ aiProviders: next });
  const keys = await loadAiProviderKeys();
  if (keys && providerId in keys) {
    delete keys[providerId];
    await chrome.storage.local.set({ [AI_PROVIDER_KEYS_STORAGE]: keys });
  }
  return next;
}

async function loadAiProviderKeys() {
  const localData = await chrome.storage.local.get([AI_PROVIDER_KEYS_STORAGE]);
  const keys = localData?.[AI_PROVIDER_KEYS_STORAGE];
  return keys && typeof keys === "object" ? keys : {};
}

async function saveAiProviderKey(providerId, apiKey) {
  const keys = await loadAiProviderKeys();
  const trimmed = String(apiKey || "").trim();
  if (trimmed) {
    keys[providerId] = trimmed;
  } else {
    delete keys[providerId];
  }
  await chrome.storage.local.set({ [AI_PROVIDER_KEYS_STORAGE]: keys });
  return keys;
}

async function testAiConnection({ baseUrl, apiKey, model }) {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  const normalizedModel = String(model || "").trim();
  if (!normalizedBaseUrl) {
    return { ok: false, error: "请填写 baseUrl" };
  }
  if (!normalizedModel) {
    return { ok: false, error: "请填写模型名" };
  }

  const headers = { Accept: "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  return probeAiChatCompletion({
    baseUrl: normalizedBaseUrl,
    apiKey,
    model: normalizedModel,
    headers
  });
}

async function probeAiChatCompletion({ baseUrl, apiKey, model, headers }) {
  const requestHeaders = headers || { Accept: "application/json" };
  if (apiKey && !requestHeaders.Authorization) {
    requestHeaders.Authorization = `Bearer ${apiKey}`;
  }
  requestHeaders["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }]
      })
    });
  } catch (error) {
    return { ok: false, error: `无法连接：${error?.message || error}` };
  }

  if (response.ok) {
    return { ok: true };
  }

  let detail = "";
  try {
    detail = (await response.text()).slice(0, 200);
  } catch {}
  return { ok: false, error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
}
