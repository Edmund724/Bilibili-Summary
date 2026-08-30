// extension/core/validators.js
// Pure normalizers / validators for stored settings: reader preferences,
// download format, AI prompts, fixed frontmatter properties and note
// placeholder sections. No Chrome APIs, no DOM. Default constants live in
// defaults.js; provider presets in presets.js.
import {
  DEFAULT_AI_SYSTEM_PROMPT,
  DEFAULT_INITIAL_QUICK_PROMPTS,
  DEFAULT_SETTINGS,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT
} from "./defaults.js";

// ===== Shared string helper =====
export function toString(value) {
  return typeof value === "string" ? value : "";
}

// ===== Reader normalizers =====
// 候选02 备注：曾尝试把 normalizeReaderTheme/FontScale/LetterSpacing/LineHeight/
// ContentWidth/TranscriptVisible 六个函数迁往 reader/presentation.js 以便让本
// 模块退出 content 常驻——但 core/settings-store.js（后台设置归一化）静态依赖
// 它们，迁移会破坏后台 bundle 与其测试，故留守本模块（content 常驻多 ~0.7KB，
// 换取后台共享面不动）。
export function normalizeReaderTheme(value) {
  return value === "dark" || value === "paper" ? value : "light";
}

export function normalizeReaderFontScale(value) {
  return ["xs", "s", "m", "l", "xl"].includes(value) ? value : "m";
}

export function normalizeReaderLetterSpacing(value) {
  return ["tighter", "tight", "normal", "relaxed", "loose"].includes(value) ? value : "normal";
}

export function normalizeReaderLineHeight(value) {
  return ["compact", "tight", "normal", "relaxed", "loose"].includes(value) ? value : "tight";
}

export function normalizeReaderContentWidth(value) {
  return ["compact", "narrow", "medium", "wide", "full"].includes(value) ? value : "medium";
}

export function normalizeReaderChapterVisibility(value) {
  return value === "hide" || value === "auto" ? value : "show";
}

export function normalizeReaderTranscriptVisible(value) {
  return value !== false;
}

// ===== Download / AI normalizers =====
export function normalizeDownloadFormat(value) {
  return value === "txt" ? "txt" : "srt";
}

export function normalizeIncludeHotCommentsInNote(value) {
  return value === true;
}

export function normalizeEnablePlayerAiQuickAction(value) {
  return value === true;
}

export function normalizePlayerAiQuickPrompt(value) {
  return toString(value).trim();
}

export function normalizeAiSystemPrompt(value) {
  const normalized = toString(value).trim();
  if (normalized === LEGACY_DEFAULT_AI_SYSTEM_PROMPT) {
    return DEFAULT_AI_SYSTEM_PROMPT;
  }
  return normalized;
}

export function normalizeAiPresetPrompts(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(function (item) { return toString(item).trim(); })
    .filter(Boolean)
    .slice(0, 12);
}

export function normalizeAiInitialQuickPrompts(value) {
  if (!Array.isArray(value)) {
    return DEFAULT_INITIAL_QUICK_PROMPTS.slice();
  }
  return value
    .map(function (item) { return toString(item).trim(); })
    .slice(0, 4);
}

export function normalizeDefaultModel(value) {
  return toString(value).trim();
}

// 思考档位（off / low / high），off 为默认且不发任何思考参数
export function normalizeAiThinkingLevel(value) {
  return value === "low" || value === "high" ? value : "off";
}

// ===== Frontmatter normalizers =====
export function normalizeFixedPropertyType(value) {
  const type = toString(value).trim().toLowerCase();
  return type === "number" || type === "checkbox" || type === "list" || type === "date" ? type : "text";
}

export function normalizeFixedPropertyValue(type, value) {
  const normalizedType = normalizeFixedPropertyType(type);
  if (normalizedType === "checkbox") {
    return toString(value).trim().toLowerCase();
  }
  return toString(value).trim();
}

export function isFixedPropertyRowEffectivelyEmpty(type, value) {
  return !toString(value).trim();
}

export function normalizeFixedFrontmatterProperties(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(function (item) {
      return {
        key: toString(item?.key).trim(),
        type: normalizeFixedPropertyType(item?.type),
        value: normalizeFixedPropertyValue(item?.type, item?.value)
      };
    })
    .filter(function (item) { return item.key && !isFixedPropertyRowEffectivelyEmpty(item.type, item.value); });
}

const SYSTEM_FRONTMATTER_FIELDS = new Set(
  DEFAULT_SETTINGS.frontmatterFields.map((field) => String(field).toLowerCase())
);

// ===== Frontmatter / note-section validation =====
export function validateFixedFrontmatterProperties(items) {
  const systemFrontmatterFields = SYSTEM_FRONTMATTER_FIELDS;
  const customPropertyKeyPattern = /^[\p{L}\p{N}_\-\s]+$/u;
  const frontmatterDateValueRe = /^\d{4}-\d{2}-\d{2}$/;
  const seenKeys = new Set();
  const rows = Array.isArray(items) ? items : [];
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i];
    const key = String(item?.key || "").trim();
    const type = normalizeFixedPropertyType(item?.type);
    const value = item?.value;
    const lowerKey = key.toLowerCase();
    const valueText = typeof value === "string" ? value.trim() : "";

    if (!key && isFixedPropertyRowEffectivelyEmpty(type, value)) {
      continue;
    }
    if (!key) {
      return { ok: false, row: item.row, message: "请填写固定属性的属性名" };
    }
    if (!customPropertyKeyPattern.test(key)) {
      return { ok: false, row: item.row, message: "属性名仅支持中文、英文、数字、空格、下划线和短横线" };
    }
    const hasTemplateToken = containsFrontmatterTemplateToken(valueText);

    if (type === "number") {
      if (!valueText) {
        return { ok: false, row: item.row, message: "请填写数字类型的属性值" };
      }
      if (!hasTemplateToken && !Number.isFinite(Number(valueText))) {
        return { ok: false, row: item.row, message: "数字类型的属性值必须是有效数字" };
      }
    } else if (type === "checkbox") {
      if (!valueText) {
        return { ok: false, row: item.row, message: "请填写复选框类型的属性值" };
      }
      const normalizedCheckboxValue = valueText.toLowerCase();
      if (!hasTemplateToken && normalizedCheckboxValue !== "true" && normalizedCheckboxValue !== "false") {
        return { ok: false, row: item.row, message: "复选框类型的属性值只能填写 true 或 false" };
      }
    } else if (type === "date") {
      if (!valueText) {
        return { ok: false, row: item.row, message: "请填写日期类型的属性值" };
      }
      if (!hasTemplateToken && !frontmatterDateValueRe.test(valueText)) {
        return { ok: false, row: item.row, message: "日期类型请填写 YYYY-MM-DD，或使用 {{upload_date}} 这类变量" };
      }
    } else if (!valueText) {
      return { ok: false, row: item.row, message: "请填写固定属性的属性值" };
    }
    if (systemFrontmatterFields.has(lowerKey)) {
      return { ok: false, row: item.row, message: "该属性名与系统字段重复，请换一个名称" };
    }
    if (seenKeys.has(lowerKey)) {
      return { ok: false, row: item.row, message: "固定属性名不能重复" };
    }
    seenKeys.add(lowerKey);
  }

  return { ok: true };
}

export function normalizeNoteSectionPosition(value) {
  const key = toString(value).trim().toLowerCase();
  return key === "before_chapters" || key === "before_subtitle" ? key : "before_intro";
}

export function validateNotePlaceholderSections(items) {
  const allowedPositions = new Set(["before_intro", "before_chapters", "before_subtitle"]);
  const maxSections = 5;
  const rows = Array.isArray(items) ? items : [];
  if (rows.length > maxSections) {
    return { ok: false, message: "正文附加段落最多添加 " + maxSections + " 个" };
  }
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i];
    const title = String(item?.title || "").trim();
    const position = normalizeNoteSectionPosition(item?.position);
    const content = String(item?.content || "").trim();
    if (!title && !content) {
      continue;
    }
    if (!title) {
      return { ok: false, row: item.row, message: "请填写段落标题" };
    }
    if (!allowedPositions.has(position)) {
      return { ok: false, row: item.row, message: "请选择有效的位置" };
    }
  }
  return { ok: true };
}

// ===== AI provider validation =====
export function validateAiProviders(items) {
  const seenIds = new Set();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.baseUrl) {
      return { ok: false, message: "每个平台都需要填写 baseUrl" };
    }
    try {
      const u = new URL(item.baseUrl);
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
    if (seenIds.has(item.id)) {
      return { ok: false, message: "平台 id 重复，请刷新页面后重试" };
    }
    seenIds.add(item.id);
  }
  return { ok: true };
}

function containsFrontmatterTemplateToken(value) {
  return /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/.test(String(value || "").trim());
}

// ===== Note placeholder sections =====
export function normalizeNotePlaceholderSections(items) {
  const allowedPositions = new Set(["before_intro", "before_chapters", "before_subtitle"]);
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map(function (item) {
      const title = toString(item?.title).trim();
      const content = toString(item?.content).trim();
      const position = allowedPositions.has(toString(item?.position).trim())
        ? toString(item?.position).trim()
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
