// extension/shared-defaults.js
// Shared defaults and pure normalizers across extension contexts.
// This module consolidates the common defaults previously duplicated across pages.

// ===== Version =====
// Single source of truth for the extension version; consumed by the content
// script and the background side panel. Kept in sync with manifest.json's
// "version" by scripts/build-content-classic.js' guard.
export const BOC_VERSION = "1.1.4";

// ===== AI Prompts =====
export const DEFAULT_PLAYER_AI_QUICK_PROMPT = "整理这期视频的内容，输出结构化总结：主题、核心观点、关键细节、结论与可执行启发。";

export const DEFAULT_PRESET_PROMPTS = [
  "生成视频摘要和结论",
  "按章节整理视频内容",
  "生成带时间轴的笔记"
];

export const DEFAULT_INITIAL_QUICK_PROMPTS = [
  "用 3 句话总结这个视频",
  "提炼这个视频的 5 个重点",
  "按时间顺序整理这期视频的内容",
  "根据评论总结观众的看法"
];

export const LEGACY_DEFAULT_AI_SYSTEM_PROMPT = [
  "你是一名专业的视频内容分析助手。基于字幕与评论提炼高价值信息，不要复述内容，不要输出思考过程或 think 标签。",
  "优先输出：主题与核心观点、关键数据与事实、逻辑链路与重要结论、可执行建议。",
  "回答应结构化、信息密度高、便于收藏和复习；自动过滤广告、废话和重复表达。",
  "信息不足时明确说明，不得猜测或编造；涉及专业内容时，区分事实、数据、推测与作者观点。",
  "输出时间戳时请使用普通正文格式，如 09:15、01:09:15，不要使用反引号、代码块或表格代码格式包裹时间戳。"
].join("\n");

export const DEFAULT_AI_SYSTEM_PROMPT = [
  "你是一名专业的视频内容分析助手。",
  "基于字幕与评论提炼高价值信息，不要复述内容，不要输出思考过程或 think 标签。",
  "优先输出：主题与核心观点、关键数据与事实、逻辑链路与重要结论、可执行建议。",
  "回答应结构化、信息密度高、便于收藏和复习，可适当使用 Emoji、列表和表格。",
  "自动过滤广告、废话和重复表达。",
  "信息不足时明确说明，不得猜测或编造；涉及专业内容时，区分事实、数据、推测与作者观点。",
  "输出时间戳时请使用普通正文格式，如 09:15、01:09:15，不要使用反引号、代码块或表格代码格式包裹时间戳。"
].join("\n");

export const PLAYER_AI_QUICK_ACTION_STORAGE_KEY = "boc_player_ai_quick_action_v1";

// ===== Utilities =====
export function toString(value) {
  return typeof value === "string" ? value : "";
}

export function sleep(ms) {
  return new Promise(function (resolve) { return setTimeout(resolve, ms); });
}

// ===== Reader normalizers =====
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
  var normalized = toString(value).trim();
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

// ===== AI platform presets =====
export const PRESETS = [
  { id: "openai_compat", name: "OpenAI 兼容", baseUrl: "https://api.openai.com/v1", requiresKey: true },
  { id: "deepseek",      name: "DeepSeek",    baseUrl: "https://api.deepseek.com/v1", requiresKey: true },
  { id: "qwen",          name: "Qwen",        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", requiresKey: true },
  { id: "zhipu",         name: "GLM",         baseUrl: "https://open.bigmodel.cn/api/paas/v4", requiresKey: true },
  { id: "moonshot",      name: "Kimi",        baseUrl: "https://api.kimi.com/coding/v1", requiresKey: true },
  { id: "minimax",       name: "MiniMax",     baseUrl: "https://api.minimaxi.com/v1", requiresKey: true },
  { id: "mimo",          name: "Mimo",        baseUrl: "https://api.mimo.ai/v1", requiresKey: true },
  { id: "opencodego",    name: "Opencode Go", baseUrl: "https://api.doubao.com/v1", requiresKey: true },
  { id: "openrouter",    name: "OpenRouter",  baseUrl: "https://openrouter.ai/api/v1", requiresKey: true },
  { id: "stepfun",       name: "Stepfun",     baseUrl: "https://api.stepfun.com/step_plan/v1", requiresKey: true },
  { id: "modelscope",    name: "ModelScope",  baseUrl: "https://api-inference.modelscope.cn/v1", requiresKey: true },
  { id: "ollama",        name: "Ollama (本地)", baseUrl: "http://localhost:11434/v1", requiresKey: false },
  { id: "custom",        name: "自定义",      baseUrl: "", requiresKey: true }
];

export function getPresetById(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

export function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

// ===== Frontmatter normalizers =====
export function normalizeFixedPropertyType(value) {
  var type = toString(value).trim().toLowerCase();
  return type === "number" || type === "checkbox" || type === "list" || type === "date" ? type : "text";
}

export function normalizeFixedPropertyValue(type, value) {
  var normalizedType = normalizeFixedPropertyType(type);
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

// ===== Frontmatter / note-section validation =====
export function validateFixedFrontmatterProperties(items) {
  var systemFrontmatterFields = SYSTEM_FRONTMATTER_FIELDS;
  var customPropertyKeyPattern = /^[\p{L}\p{N}_\-\s]+$/u;
  var frontmatterDateValueRe = /^\d{4}-\d{2}-\d{2}$/;
  var seenKeys = new Set();
  var rows = Array.isArray(items) ? items : [];
  for (var i = 0; i < rows.length; i++) {
    var item = rows[i];
    var key = String(item?.key || "").trim();
    var type = normalizeFixedPropertyType(item?.type);
    var value = item?.value;
    var lowerKey = key.toLowerCase();
    var valueText = typeof value === "string" ? value.trim() : "";

    if (!key && isFixedPropertyRowEffectivelyEmpty(type, value)) {
      continue;
    }
    if (!key) {
      return { ok: false, row: item.row, message: "请填写固定属性的属性名" };
    }
    if (!customPropertyKeyPattern.test(key)) {
      return { ok: false, row: item.row, message: "属性名仅支持中文、英文、数字、空格、下划线和短横线" };
    }
    var hasTemplateToken = containsFrontmatterTemplateToken(valueText);

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
      var normalizedCheckboxValue = valueText.toLowerCase();
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
  var key = toString(value).trim().toLowerCase();
  return key === "before_chapters" || key === "before_subtitle" ? key : "before_intro";
}

export function validateNotePlaceholderSections(items) {
  var allowedPositions = new Set(["before_intro", "before_chapters", "before_subtitle"]);
  var maxSections = 5;
  var rows = Array.isArray(items) ? items : [];
  if (rows.length > maxSections) {
    return { ok: false, message: "正文附加段落最多添加 " + maxSections + " 个" };
  }
  for (var i = 0; i < rows.length; i++) {
    var item = rows[i];
    var title = String(item?.title || "").trim();
    var position = normalizeNoteSectionPosition(item?.position);
    var content = String(item?.content || "").trim();
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
  var seenIds = new Set();
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item.baseUrl) {
      return { ok: false, message: "每个平台都需要填写 baseUrl" };
    }
    try {
      var u = new URL(item.baseUrl);
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

// ===== Date / URL utils =====
export function formatLocalDate(value) {
  if (value === undefined) value = Date.now();
  var date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

export function isSupportedBilibiliPage(url) {
  try {
    var parsed = new URL(String(url || ""));
    if (parsed.hostname !== "www.bilibili.com") {
      return false;
    }
    return (
      parsed.pathname === "/list/watchlater" ||
      parsed.pathname === "/list/watchlater/" ||
      parsed.pathname.startsWith("/video/")
    );
  } catch {
    return false;
  }
}

// ===== Note placeholder sections =====
export function normalizeNotePlaceholderSections(items) {
  const allowedPositions = new Set(["before_intro", "before_chapters", "before_subtitle"]);
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map(function (item) {
      var title = toString(item?.title).trim();
      var content = toString(item?.content).trim();
      var position = allowedPositions.has(toString(item?.position).trim())
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

// ===== Merged default settings =====
export const DEFAULT_SETTINGS = {
  tags: "clippings,bilibili",
  downloadFormat: "srt",
  includeDateInFilename: true,
  includeHotCommentsInNote: false,
  enablePlayerAiQuickAction: false,
  playerAiQuickPrompt: DEFAULT_PLAYER_AI_QUICK_PROMPT,
  includeTimestampInBody: true,
  enableDebugLogs: false,
  readerTheme: "light",
  readerFontScale: "m",
  readerLetterSpacing: "normal",
  readerLineHeight: "tight",
  readerContentWidth: "medium",
  readerChapterVisibility: "show",
  readerTranscriptVisible: true,
  frontmatterFields: [
    "title",
    "url",
    "bvid",
    "cid",
    "author",
    "upload_date",
    "subtitle_lang",
    "created",
    "tags"
  ],
  fixedFrontmatterProperties: [],
  notePlaceholderSections: [],
  aiSystemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
  aiInitialQuickPrompts: DEFAULT_INITIAL_QUICK_PROMPTS.slice(),
  aiPresetPrompts: DEFAULT_PRESET_PROMPTS.slice(),
  defaultModel: ""
};

const SYSTEM_FRONTMATTER_FIELDS = new Set(
  DEFAULT_SETTINGS.frontmatterFields.map((field) => String(field).toLowerCase())
);
