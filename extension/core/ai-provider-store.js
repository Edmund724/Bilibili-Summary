// extension/core/ai-provider-store.js
// AI 平台 Provider/Key 的设置存储 + 连接测试/模型探测。
// 从 extension/entry/background.js 提取的深模块：只与 chrome.storage / fetch 交互，
// 不涉及消息路由。所有函数返回 Promise，由 background.js 的消息处理函数调用。

import {
  DEFAULT_SETTINGS,
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
  normalizeAiThinkingLevel,
  normalizeAsrProvider
} from "./shared-defaults.js";

// ===== 设置归一化 + 存储 =====

// ASR 默认项归一化：asrProviders 列表逐项走 normalizeAsrProvider，
// asrAutoFallback 标量兜底。
function normalizeAsrProvidersList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeAsrProvider).filter(Boolean);
}

function normalizeAsrAutoFallback(value) {
  return value !== false; // 默认 true，仅显式 false 关闭
}

export async function getMergedSettings(timeoutMs = 5000) {
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
  merged.aiThinkingLevel = normalizeAiThinkingLevel(merged.aiThinkingLevel);
  merged.asrProviders = normalizeAsrProvidersList(merged.asrProviders);
  merged.activeAsrProviderId = String(merged.activeAsrProviderId || "").trim();
  merged.asrAutoFallback = normalizeAsrAutoFallback(merged.asrAutoFallback);

  return merged;
}

export async function saveSettings(settings) {
  const payload = settings && typeof settings === "object" ? settings : {};
  const syncPayload = { ...payload };
  // 值为 undefined 的 key 视为缺失，不写入存储，
  // 避免部分保存时把空值覆盖到其它设置项。
  for (const key of Object.keys(syncPayload)) {
    if (syncPayload[key] === undefined) delete syncPayload[key];
  }
  // 只归一化 payload 中实际存在的 key；缺失的 key 不写入，
  // 避免部分保存（如只传 aiThinkingLevel）把其它设置覆盖成默认值。
  if ("downloadFormat" in syncPayload) syncPayload.downloadFormat = normalizeDownloadFormat(syncPayload.downloadFormat);
  if ("includeHotCommentsInNote" in syncPayload) syncPayload.includeHotCommentsInNote = normalizeIncludeHotCommentsInNote(syncPayload.includeHotCommentsInNote);
  if ("enablePlayerAiQuickAction" in syncPayload) syncPayload.enablePlayerAiQuickAction = normalizeEnablePlayerAiQuickAction(syncPayload.enablePlayerAiQuickAction);
  if ("playerAiQuickPrompt" in syncPayload) syncPayload.playerAiQuickPrompt = normalizePlayerAiQuickPrompt(syncPayload.playerAiQuickPrompt);
  if ("readerTheme" in syncPayload) syncPayload.readerTheme = normalizeReaderTheme(syncPayload.readerTheme);
  if ("readerFontScale" in syncPayload) syncPayload.readerFontScale = normalizeReaderFontScale(syncPayload.readerFontScale);
  if ("readerLetterSpacing" in syncPayload) {
    syncPayload.readerLetterSpacing = normalizeReaderLetterSpacing(
      syncPayload.readerLetterSpacing ?? syncPayload.readerLineHeight
    );
  }
  if ("readerLineHeight" in syncPayload) syncPayload.readerLineHeight = normalizeReaderLineHeight(syncPayload.readerLineHeight);
  if ("readerContentWidth" in syncPayload) syncPayload.readerContentWidth = normalizeReaderContentWidth(syncPayload.readerContentWidth);
  if ("readerChapterVisibility" in syncPayload) syncPayload.readerChapterVisibility = normalizeReaderChapterVisibility(syncPayload.readerChapterVisibility);
  if ("readerTranscriptVisible" in syncPayload) syncPayload.readerTranscriptVisible = normalizeReaderTranscriptVisible(syncPayload.readerTranscriptVisible);
  if ("fixedFrontmatterProperties" in syncPayload) syncPayload.fixedFrontmatterProperties = normalizeFixedFrontmatterProperties(syncPayload.fixedFrontmatterProperties);
  if ("notePlaceholderSections" in syncPayload) syncPayload.notePlaceholderSections = normalizeNotePlaceholderSections(syncPayload.notePlaceholderSections);
  if ("aiSystemPrompt" in syncPayload) syncPayload.aiSystemPrompt = normalizeAiSystemPrompt(syncPayload.aiSystemPrompt);
  if ("aiInitialQuickPrompts" in syncPayload) syncPayload.aiInitialQuickPrompts = normalizeAiInitialQuickPrompts(syncPayload.aiInitialQuickPrompts);
  if ("aiPresetPrompts" in syncPayload) syncPayload.aiPresetPrompts = normalizeAiPresetPrompts(syncPayload.aiPresetPrompts);
  if ("defaultModel" in syncPayload) syncPayload.defaultModel = normalizeDefaultModel(syncPayload.defaultModel);
  if ("aiThinkingLevel" in syncPayload) syncPayload.aiThinkingLevel = normalizeAiThinkingLevel(syncPayload.aiThinkingLevel);
  if ("asrProviders" in syncPayload) syncPayload.asrProviders = normalizeAsrProvidersList(syncPayload.asrProviders);
  if ("activeAsrProviderId" in syncPayload) syncPayload.activeAsrProviderId = String(syncPayload.activeAsrProviderId || "").trim();
  if ("asrAutoFallback" in syncPayload) syncPayload.asrAutoFallback = normalizeAsrAutoFallback(syncPayload.asrAutoFallback);

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

export async function loadAiProviders() {
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

export async function saveAiProviders(items) {
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

export async function deleteAiProvider(providerId) {
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

export async function loadAiProviderKeys() {
  const localData = await chrome.storage.local.get([AI_PROVIDER_KEYS_STORAGE]);
  const keys = localData?.[AI_PROVIDER_KEYS_STORAGE];
  return keys && typeof keys === "object" ? keys : {};
}

export async function saveAiProviderKey(providerId, apiKey) {
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

// ===== 连接测试 / 模型探测 =====

export async function testAiConnection({ baseUrl, apiKey, model }) {
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

export async function probeAiChatCompletion({ baseUrl, apiKey, model, headers }) {
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

export async function handleAiProvidersModels({ baseUrl, apiKey, providerId }) {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
  const headers = { Accept: "application/json" };
  let controller = null;
  let timer = null;

  const cleanup = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  try {
    if (!apiKey) {
      const keys = providerId ? await loadAiProviderKeys() : {};
      apiKey = String(keys[providerId] || "").trim();
    }
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(`${normalizedBaseUrl}/v1/models`, {
      headers,
      method: "GET",
      signal: controller.signal
    });
    cleanup();
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    const data = await resp.json();
    const models = [];
    if (Array.isArray(data?.data)) {
      for (const item of data.data) {
        if (item?.id) models.push(String(item.id));
      }
    }
    return { ok: true, models };
  } catch (error) {
    cleanup();
    if (error?.name === "AbortError") {
      return { ok: false, error: "请求超时，请检查 baseUrl 或稍后重试" };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, error: "无法解析模型列表" };
    }
    return { ok: false, error: error?.message || String(error) };
  }
}
