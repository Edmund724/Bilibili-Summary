// extension/core/settings-store.js
// 全局设置（reader/AI/ASR/下载域共 22 个受管字段）的归一化 + 读写存储。
// 从 extension/core/ai-provider-store.js 拆出：原先「AI provider 存储」文件
// 实际承载了全部设置域的归一化，导致 ASR 域（asr/asr-provider-store.js）
// 反向依赖「AI 域」文件，名实不符。本模块只与 chrome.storage 交互，
// 不涉及消息路由。

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
