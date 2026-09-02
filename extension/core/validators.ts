// extension/core/validators.ts
// Pure normalizers / validators for stored settings: reader preferences,
// download format, AI prompts, fixed frontmatter properties and note
// placeholder sections. No Chrome APIs, no DOM. Default constants live in
// defaults.ts; provider presets in presets.ts.
import {
  DEFAULT_AI_SYSTEM_PROMPT,
  DEFAULT_INITIAL_QUICK_PROMPTS,
  DEFAULT_SETTINGS,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT,
  type FixedFrontmatterProperty,
  type NotePlaceholderSection,
  type Settings
} from "./defaults.js";

// ===== Shared string helper =====
export function toString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// ===== Reader normalizers =====
// 候选02 备注：曾尝试把 normalizeReaderTheme/FontScale/LetterSpacing/LineHeight/
// ContentWidth/SubtitleVisible 六个函数迁往 reader/presentation.ts 以便让本
// 模块退出 content 常驻——但 core/settings-store.ts（后台设置归一化）静态依赖
// 它们，迁移会破坏后台 bundle 与其测试，故留守本模块（content 常驻多 ~0.7KB，
// 换取后台共享面不动）。
export function normalizeReaderTheme(value: unknown): string {
  return value === "dark" || value === "paper" ? value : "light";
}

export function normalizeReaderFontScale(value: unknown): string {
  return ["xs", "s", "m", "l", "xl"].includes(value as string) ? (value as string) : "m";
}

export function normalizeReaderLetterSpacing(value: unknown): string {
  return ["tighter", "tight", "normal", "relaxed", "loose"].includes(value as string)
    ? (value as string)
    : "normal";
}

export function normalizeReaderLineHeight(value: unknown): string {
  return ["compact", "tight", "normal", "relaxed", "loose"].includes(value as string)
    ? (value as string)
    : "tight";
}

export function normalizeReaderContentWidth(value: unknown): string {
  // fit（填满）是默认档：字幕列表常驻右侧面板后主体只剩标题与视频，固定宽度
  // 上限徒留空白。旧默认 medium（860px）不在允许列表内，按 fit 迁移。
  return ["compact", "narrow", "wide", "full", "fit"].includes(value as string)
    ? (value as string)
    : "fit";
}

export function normalizeReaderChapterVisibility(value: unknown): string {
  return value === "hide" || value === "auto" ? value : "show";
}

export function normalizeReaderSubtitleVisible(value: unknown): boolean {
  return value !== false;
}

// ===== Download / AI normalizers =====
export function normalizeDownloadFormat(value: unknown): string {
  return value === "txt" ? "txt" : "srt";
}

export function normalizeIncludeHotCommentsInNote(value: unknown): boolean {
  return value === true;
}

export function normalizeEnablePlayerAiQuickAction(value: unknown): boolean {
  return value === true;
}

export function normalizePlayerAiQuickPrompt(value: unknown): string {
  return toString(value).trim();
}

export function normalizeAiSystemPrompt(value: unknown): string {
  const normalized = toString(value).trim();
  if (normalized === LEGACY_DEFAULT_AI_SYSTEM_PROMPT) {
    return DEFAULT_AI_SYSTEM_PROMPT;
  }
  return normalized;
}

export function normalizeAiPresetPrompts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(function (item: unknown) { return toString(item).trim(); })
    .filter(Boolean)
    .slice(0, 12);
}

export function normalizeAiInitialQuickPrompts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return DEFAULT_INITIAL_QUICK_PROMPTS.slice();
  }
  return value
    .map(function (item: unknown) { return toString(item).trim(); })
    .slice(0, 4);
}

export function normalizeDefaultModel(value: unknown): string {
  return toString(value).trim();
}

// 思考档位（off / low / high），off 为默认且不发任何思考参数
export function normalizeAiThinkingLevel(value: unknown): "off" | "low" | "high" {
  return value === "low" || value === "high" ? value : "off";
}

// ===== Frontmatter normalizers =====
export function normalizeFixedPropertyType(value: unknown): FixedFrontmatterProperty["type"] {
  const type = toString(value).trim().toLowerCase();
  return type === "number" || type === "checkbox" || type === "list" || type === "date" ? type : "text";
}

export function normalizeFixedPropertyValue(type: unknown, value: unknown): string {
  const normalizedType = normalizeFixedPropertyType(type);
  if (normalizedType === "checkbox") {
    return toString(value).trim().toLowerCase();
  }
  return toString(value).trim();
}

export function isFixedPropertyRowEffectivelyEmpty(type: unknown, value: unknown): boolean {
  return !toString(value).trim();
}

export function normalizeFixedFrontmatterProperties(value: unknown): FixedFrontmatterProperty[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(function (item: unknown) {
      const raw = item as Partial<FixedFrontmatterProperty>;
      return {
        key: toString(raw.key).trim(),
        type: normalizeFixedPropertyType(raw.type),
        value: normalizeFixedPropertyValue(raw.type, raw.value)
      };
    })
    .filter(function (item) { return item.key && !isFixedPropertyRowEffectivelyEmpty(item.type, item.value); });
}

const SYSTEM_FRONTMATTER_FIELDS = new Set(
  DEFAULT_SETTINGS.frontmatterFields.map((field) => String(field).toLowerCase())
);

interface ValidationResult {
  ok: boolean;
  row?: unknown;
  message?: string;
}

// ===== Frontmatter / note-section validation =====
export function validateFixedFrontmatterProperties(items: unknown[]): ValidationResult {
  const systemFrontmatterFields = SYSTEM_FRONTMATTER_FIELDS;
  const customPropertyKeyPattern = /^[\p{L}\p{N}_\-\s]+$/u;
  const frontmatterDateValueRe = /^\d{4}-\d{2}-\d{2}$/;
  const seenKeys = new Set<string>();
  const rows = Array.isArray(items) ? items : [];
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i];
    const raw = item as Partial<FixedFrontmatterProperty>;
    const key = String(raw.key || "").trim();
    const type = normalizeFixedPropertyType(raw.type);
    const value = raw.value;
    const lowerKey = key.toLowerCase();
    const valueText = typeof value === "string" ? value.trim() : "";

    if (!key && isFixedPropertyRowEffectivelyEmpty(type, value)) {
      continue;
    }
    if (!key) {
      return { ok: false, row: item, message: "请填写固定属性的属性名" };
    }
    if (!customPropertyKeyPattern.test(key)) {
      return { ok: false, row: item, message: "属性名仅支持中文、英文、数字、空格、下划线和短横线" };
    }
    const hasTemplateToken = containsFrontmatterTemplateToken(valueText);

    if (type === "number") {
      if (!valueText) {
        return { ok: false, row: item, message: "请填写数字类型的属性值" };
      }
      if (!hasTemplateToken && !Number.isFinite(Number(valueText))) {
        return { ok: false, row: item, message: "数字类型的属性值必须是有效数字" };
      }
    } else if (type === "checkbox") {
      if (!valueText) {
        return { ok: false, row: item, message: "请填写复选框类型的属性值" };
      }
      const normalizedCheckboxValue = valueText.toLowerCase();
      if (!hasTemplateToken && normalizedCheckboxValue !== "true" && normalizedCheckboxValue !== "false") {
        return { ok: false, row: item, message: "复选框类型的属性值只能填写 true 或 false" };
      }
    } else if (type === "date") {
      if (!valueText) {
        return { ok: false, row: item, message: "请填写日期类型的属性值" };
      }
      if (!hasTemplateToken && !frontmatterDateValueRe.test(valueText)) {
        return { ok: false, row: item, message: "日期类型请填写 YYYY-MM-DD，或使用 {{upload_date}} 这类变量" };
      }
    } else if (!valueText) {
      return { ok: false, row: item, message: "请填写固定属性的属性值" };
    }
    if (systemFrontmatterFields.has(lowerKey)) {
      return { ok: false, row: item, message: "该属性名与系统字段重复，请换一个名称" };
    }
    if (seenKeys.has(lowerKey)) {
      return { ok: false, row: item, message: "固定属性名不能重复" };
    }
    seenKeys.add(lowerKey);
  }

  return { ok: true };
}

export function normalizeNoteSectionPosition(value: unknown): NotePlaceholderSection["position"] {
  const key = toString(value).trim().toLowerCase();
  return key === "before_chapters" || key === "before_subtitle" ? key : "before_intro";
}

export function validateNotePlaceholderSections(items: unknown[]): ValidationResult {
  const allowedPositions = new Set<NotePlaceholderSection["position"]>(["before_intro", "before_chapters", "before_subtitle"]);
  const maxSections = 5;
  const rows = Array.isArray(items) ? items : [];
  if (rows.length > maxSections) {
    return { ok: false, message: "正文附加段落最多添加 " + maxSections + " 个" };
  }
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i];
    const raw = item as Partial<NotePlaceholderSection>;
    const title = String(raw.title || "").trim();
    const position = normalizeNoteSectionPosition(raw.position);
    const content = String(raw.content || "").trim();
    if (!title && !content) {
      continue;
    }
    if (!title) {
      return { ok: false, row: item, message: "请填写段落标题" };
    }
    if (!allowedPositions.has(position)) {
      return { ok: false, row: item, message: "请选择有效的位置" };
    }
  }
  return { ok: true };
}

interface AiProviderValidationInput {
  baseUrl?: unknown;
  requiresKey?: unknown;
  apiKey?: unknown;
  hasSavedKey?: unknown;
  model?: unknown;
  id?: unknown;
  name?: unknown;
}

// ===== AI provider validation =====
export function validateAiProviders(items: unknown[]): ValidationResult {
  const seenIds = new Set<string>();
  for (let i = 0; i < (items as unknown[]).length; i++) {
    const item = (items as unknown[])[i] as AiProviderValidationInput;
    if (!item.baseUrl) {
      return { ok: false, message: "每个平台都需要填写 baseUrl" };
    }
    try {
      const u = new URL(String(item.baseUrl));
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return { ok: false, message: "baseUrl 必须以 http(s):// 开头（" + item.baseUrl + "）" };
      }
    } catch {
      return { ok: false, message: "baseUrl 格式不正确：" + item.baseUrl };
    }
    if (item.requiresKey && !item.apiKey && !item.hasSavedKey) {
      return { ok: false, message: "平台「" + item.name + "」需要填写 API Key" };
    }
    if (!item.model) {
      return { ok: false, message: "平台「" + item.name + "」需要填写模型名" };
    }
    if (seenIds.has(String(item.id))) {
      return { ok: false, message: "平台 id 重复，请刷新页面后重试" };
    }
    seenIds.add(String(item.id));
  }
  return { ok: true };
}

function containsFrontmatterTemplateToken(value: unknown): boolean {
  return /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/.test(String(value || "").trim());
}

// ===== Note placeholder sections =====
export function normalizeNotePlaceholderSections(items: unknown): NotePlaceholderSection[] {
  const allowedPositions = new Set<NotePlaceholderSection["position"]>(["before_intro", "before_chapters", "before_subtitle"]);
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map(function (item: unknown) {
      const title = toString((item as Partial<NotePlaceholderSection>).title).trim();
      const content = toString((item as Partial<NotePlaceholderSection>).content).trim();
      const rawPosition = toString((item as Partial<NotePlaceholderSection>).position).trim();
      const position = allowedPositions.has(rawPosition as NotePlaceholderSection["position"])
        ? (rawPosition as NotePlaceholderSection["position"])
        : "before_intro";
      return {
        title,
        position,
        content
      };
    })
    .filter(function (item) { return item.title; })
    .slice(0, 5);
}

export type { FixedFrontmatterProperty, NotePlaceholderSection, Settings };
