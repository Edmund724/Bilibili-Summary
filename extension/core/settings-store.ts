// extension/core/settings-store.ts
// 全局设置（reader/AI/ASR/下载域共 21 个受管字段）的归一化 + 读写存储。
// 从 extension/core/ai-provider-store.ts 拆出：原先「AI provider 存储」文件
// 实际承载了全部设置域的归一化，导致 ASR 域（asr/asr-provider-store.js）
// 反向依赖「AI 域」文件，名实不符。本模块只与 chrome.storage 交互，
// 不涉及消息路由。provider 列表（asrProviders）不在受管字段内：列表+Key 归
// provider-store（asr/asr-provider-store.js），经 asr-providers-save 消息写回，
// settings 只存 ASR 标量（activeAsrProviderId / asrAutoFallback / asrLanguage）。

import { DEFAULT_SETTINGS, type Settings } from "./defaults.js";
import { normalizeAsrLanguage } from "./presets.js";
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
  normalizeReaderSubtitleVisible,
  normalizeFixedFrontmatterProperties,
  normalizeNotePlaceholderSections,
  normalizeAiSystemPrompt,
  normalizeAiInitialQuickPrompts,
  normalizeAiPresetPrompts,
  normalizeDefaultModel,
  normalizeAiThinkingLevel
} from "./validators.js";

// ===== 设置归一化 + 存储 =====

// asrAutoFallback 标量兜底（asrProviders 列表已摘出 settings，归 provider-store）。
function normalizeAsrAutoFallback(value: unknown): boolean {
  return value !== false; // 默认 true，仅显式 false 关闭
}

type NormalizerStep = [string, (m: Record<string, unknown>) => unknown];

// 归一化步骤表：[key, normalizeField]，normalizeField 接收完整对象、返回该 key
// 的归一化值。readerLetterSpacing 依赖同一对象里尚未归一化的 readerLineHeight
// （缺失时派生兜底），因此步骤顺序即历史内联顺序，不可调整。
const SETTINGS_NORMALIZER_STEPS: NormalizerStep[] = [
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
  ["readerTranscriptVisible", (m) => normalizeReaderSubtitleVisible(m.readerTranscriptVisible)],
  ["fixedFrontmatterProperties", (m) => normalizeFixedFrontmatterProperties(m.fixedFrontmatterProperties)],
  ["notePlaceholderSections", (m) => normalizeNotePlaceholderSections(m.notePlaceholderSections)],
  ["aiSystemPrompt", (m) => normalizeAiSystemPrompt(m.aiSystemPrompt)],
  ["aiInitialQuickPrompts", (m) => normalizeAiInitialQuickPrompts(m.aiInitialQuickPrompts)],
  ["aiPresetPrompts", (m) => normalizeAiPresetPrompts(m.aiPresetPrompts)],
  ["defaultModel", (m) => normalizeDefaultModel(m.defaultModel)],
  ["aiThinkingLevel", (m) => normalizeAiThinkingLevel(m.aiThinkingLevel)],
  ["activeAsrProviderId", (m) => String(m.activeAsrProviderId || "").trim()],
  ["asrAutoFallback", (m) => normalizeAsrAutoFallback(m.asrAutoFallback)],
  ["asrLanguage", (m) => normalizeAsrLanguage(m.asrLanguage)]
];

// 设置归一化的唯一收口：对 21 个受管字段按步骤表逐项归一化，返回新对象
// （不改入参）。读路径（getMergedSettings）、写路径（saveSettings）与安装/
// 更新迁移（background 的 initializeSettingsStorage）统一经由这里。
// aiSystemPrompt 在此把 LEGACY 默认提示词映射为当前默认（LEGACY 常量保留
// 一个版本周期）；落盘收口后，存储里的旧值会被一次性改写而非反复映射。
export function normalizeSettings(merged: Record<string, unknown>): Settings {
  const normalized: Record<string, unknown> = { ...merged };
  for (const [key, normalizeField] of SETTINGS_NORMALIZER_STEPS) {
    normalized[key] = normalizeField(normalized);
  }
  return normalized as Settings;
}

export async function getMergedSettings(timeoutMs = 5000): Promise<Settings> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("storage timeout")), timeoutMs);
  });
  const syncSettings = await Promise.race([
    chrome.storage.sync.get(DEFAULT_SETTINGS),
    timeoutPromise
  ]).catch(() => ({}));

  return normalizeSettings({ ...DEFAULT_SETTINGS, ...(syncSettings as Record<string, unknown>) });
}

// 写入白名单：settings 域的键面 = DEFAULT_SETTINGS 声明的键集。除归一化步骤表
// 覆盖的字段外，tags / readerChapterVisible 等透传字段也经 save-settings 落盘，
// 因此白名单取键面全集而非步骤表键集。saveSettings 据此剔除键面外的键。
const SETTINGS_STORAGE_KEYS = new Set<string>(Object.keys(DEFAULT_SETTINGS));

export async function saveSettings(settings: unknown): Promise<void> {
  const payload = settings && typeof settings === "object" ? settings as Record<string, unknown> : {};
  const syncPayload: Record<string, unknown> = { ...payload };
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
  // 写入边界（白名单）：只落盘 settings 键面内的 key，payload 里的非设置键
  // （如 content.js 整对象写回里的 asrProviders）不再经 save-settings 落盘、
  // 陈旧快照无法借此复活；写回 asrProviders 请走 asr-providers-save 消息
  // （provider-store 收口，见 asr/asr-provider-store.js）。
  const whitelisted: Record<string, unknown> = {};
  for (const key of Object.keys(syncPayload)) {
    if (SETTINGS_STORAGE_KEYS.has(key)) whitelisted[key] = syncPayload[key];
  }

  await chrome.storage.sync.set(whitelisted);
}
