// extension/core/ai-provider-store.js
// AI 平台 Provider/Key 的设置存储 + 连接测试/模型探测。
// 从 extension/entry/background.js 提取的深模块：只与 chrome.storage / fetch 交互，
// 不涉及消息路由。所有函数返回 Promise，由 background.js 的消息处理函数调用。

import { DEFAULT_SETTINGS } from "./defaults.js";
import { normalizeAsrProvider, normalizeAsrLanguage } from "./presets.js";
import {
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
  normalizeAiThinkingLevel
} from "./validators.js";
import { createProviderStore } from "./provider-store.js";

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

// 归一化步骤表：[key, normalizeField]，normalizeField 接收完整对象、返回该 key
// 的归一化值。readerLetterSpacing 依赖同一对象里尚未归一化的 readerLineHeight
// （缺失时派生兜底），因此步骤顺序即历史内联顺序，不可调整。
const SETTINGS_NORMALIZER_STEPS = [
  ["downloadFormat", (m) => normalizeDownloadFormat(m.downloadFormat)],
  ["includeHotCommentsInNote", (m) => normalizeIncludeHotCommentsInNote(m.includeHotCommentsInNote)],
  ["enablePlayerAiQuickAction", (m) => normalizeEnablePlayerAiQuickAction(m.enablePlayerAiQuickAction)],
  ["playerAiQuickPrompt", (m) => normalizePlayerAiQuickPrompt(m.playerAiQuickPrompt)],
  ["readerTheme", (m) => normalizeReaderTheme(m.readerTheme)],
  ["readerFontScale", (m) => normalizeReaderFontScale(m.readerFontScale)],
  ["readerLetterSpacing", (m) => normalizeReaderLetterSpacing(m.readerLetterSpacing ?? m.readerLineHeight)],
  ["readerLineHeight", (m) => normalizeReaderLineHeight(m.readerLineHeight)],
  ["readerContentWidth", (m) => normalizeReaderContentWidth(m.readerContentWidth)],
  ["readerChapterVisibility", (m) => normalizeReaderChapterVisibility(m.readerChapterVisibility)],
  ["readerTranscriptVisible", (m) => normalizeReaderTranscriptVisible(m.readerTranscriptVisible)],
  ["fixedFrontmatterProperties", (m) => normalizeFixedFrontmatterProperties(m.fixedFrontmatterProperties)],
  ["notePlaceholderSections", (m) => normalizeNotePlaceholderSections(m.notePlaceholderSections)],
  ["aiSystemPrompt", (m) => normalizeAiSystemPrompt(m.aiSystemPrompt)],
  ["aiInitialQuickPrompts", (m) => normalizeAiInitialQuickPrompts(m.aiInitialQuickPrompts)],
  ["aiPresetPrompts", (m) => normalizeAiPresetPrompts(m.aiPresetPrompts)],
  ["defaultModel", (m) => normalizeDefaultModel(m.defaultModel)],
  ["aiThinkingLevel", (m) => normalizeAiThinkingLevel(m.aiThinkingLevel)],
  ["asrProviders", (m) => normalizeAsrProvidersList(m.asrProviders)],
  ["activeAsrProviderId", (m) => String(m.activeAsrProviderId || "").trim()],
  ["asrAutoFallback", (m) => normalizeAsrAutoFallback(m.asrAutoFallback)],
  ["asrLanguage", (m) => normalizeAsrLanguage(m.asrLanguage)]
];

// 设置归一化的唯一收口：对 22 个受管字段按步骤表逐项归一化，返回新对象
// （不改入参）。读路径（getMergedSettings）、写路径（saveSettings）与安装/
// 更新迁移（background 的 initializeSettingsStorage）统一经由这里。
// aiSystemPrompt 在此把 LEGACY 默认提示词映射为当前默认（LEGACY 常量保留
// 一个版本周期）；落盘收口后，存储里的旧值会被一次性改写而非反复映射。
export function normalizeSettings(merged) {
  const normalized = { ...merged };
  for (const [key, normalizeField] of SETTINGS_NORMALIZER_STEPS) {
    normalized[key] = normalizeField(normalized);
  }
  return normalized;
}

export async function getMergedSettings(timeoutMs = 5000) {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("storage timeout")), timeoutMs);
  });
  const syncSettings = await Promise.race([
    chrome.storage.sync.get(DEFAULT_SETTINGS),
    timeoutPromise
  ]).catch(() => ({}));

  return normalizeSettings({ ...DEFAULT_SETTINGS, ...syncSettings });
}

export async function saveSettings(settings) {
  const payload = settings && typeof settings === "object" ? settings : {};
  const syncPayload = { ...payload };
  // 值为 undefined 的 key 视为缺失，不写入存储，
  // 避免部分保存时把空值覆盖到其它设置项。
  for (const key of Object.keys(syncPayload)) {
    if (syncPayload[key] === undefined) delete syncPayload[key];
  }
  // 写路径收口：与 normalizeSettings 共用同一套步骤表，但只归一化 payload 中
  // 实际存在的 key；缺失的 key 不写入，避免部分保存（如只传 aiThinkingLevel）
  // 把其它设置覆盖成默认值。
  for (const [key, normalizeField] of SETTINGS_NORMALIZER_STEPS) {
    if (key in syncPayload) syncPayload[key] = normalizeField(syncPayload);
  }

  await chrome.storage.sync.set(syncPayload);
}

// ===== AI 模型平台存储 =====
// 列表 CRUD（load/save/delete/Key 读写）委托给通用工厂 createProviderStore，
// 本模块只提供 storage key 与 AI 专属的 normalizeProvider。不变式
// “apiKey 永不进同步列表”由工厂统一保证。

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

const providerStore = createProviderStore({
  listStorageKey: "aiProviders",
  keysStorageKey: AI_PROVIDER_KEYS_STORAGE,
  normalizeProvider: normalizeAiProvider
});

export async function loadAiProviders() {
  return providerStore.loadProviders();
}

export async function saveAiProviders(items) {
  return providerStore.saveProviders(items);
}

export async function deleteAiProvider(providerId) {
  return providerStore.deleteProvider(providerId);
}

export async function loadAiProviderKeys() {
  return providerStore.loadKeys();
}

export async function saveAiProviderKey(providerId, apiKey) {
  return providerStore.saveKey(providerId, apiKey);
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
