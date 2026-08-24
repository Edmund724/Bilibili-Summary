// extension/defaults.js
// Shared defaults and pure normalizers across extension contexts.
// Load this classic script before other scripts in the same context.

// ===== AI Prompts =====
const DEFAULT_PLAYER_AI_QUICK_PROMPT = "整理这期视频的内容，输出结构化总结：主题、核心观点、关键细节、结论与可执行启发。";

const DEFAULT_PRESET_PROMPTS = [
  "生成视频摘要和结论",
  "按章节整理视频内容",
  "生成带时间轴的笔记"
];

const DEFAULT_INITIAL_QUICK_PROMPTS = [
  "用 3 句话总结这个视频",
  "提炼这个视频的 5 个重点",
  "按时间顺序整理这期视频的内容",
  "根据评论总结观众的看法"
];

const LEGACY_DEFAULT_AI_SYSTEM_PROMPT = [
  "你是一名专业的视频内容分析助手。基于字幕与评论提炼高价值信息，不要复述内容，不要输出思考过程或 think 标签。",
  "优先输出：主题与核心观点、关键数据与事实、逻辑链路与重要结论、可执行建议。",
  "回答应结构化、信息密度高、便于收藏和复习；自动过滤广告、废话和重复表达。",
  "信息不足时明确说明，不得猜测或编造；涉及专业内容时，区分事实、数据、推测与作者观点。",
  "输出时间戳时请使用普通正文格式，如 09:15、01:09:15，不要使用反引号、代码块或表格代码格式包裹时间戳。"
].join("\n");

const DEFAULT_AI_SYSTEM_PROMPT = [
  "你是一名专业的视频内容分析助手。",
  "基于字幕与评论提炼高价值信息，不要复述内容，不要输出思考过程或 think 标签。",
  "优先输出：主题与核心观点、关键数据与事实、逻辑链路与重要结论、可执行建议。",
  "回答应结构化、信息密度高、便于收藏和复习，可适当使用 Emoji、列表和表格。",
  "自动过滤广告、废话和重复表达。",
  "信息不足时明确说明，不得猜测或编造；涉及专业内容时，区分事实、数据、推测与作者观点。",
  "输出时间戳时请使用普通正文格式，如 09:15、01:09:15，不要使用反引号、代码块或表格代码格式包裹时间戳。"
].join("\n");

const PLAYER_AI_QUICK_ACTION_STORAGE_KEY = "boc_player_ai_quick_action_v1";

// ===== Utilities =====
function toString(value) {
  return typeof value === "string" ? value : "";
}

function sleep(ms) {
  return new Promise(function (resolve) { return setTimeout(resolve, ms); });
}

// ===== Reader normalizers =====
function normalizeReaderTheme(value) {
  return value === "dark" || value === "paper" ? value : "light";
}

function normalizeReaderFontScale(value) {
  return ["xs", "s", "m", "l", "xl"].includes(value) ? value : "m";
}

function normalizeReaderLetterSpacing(value) {
  return ["tighter", "tight", "normal", "relaxed", "loose"].includes(value) ? value : "normal";
}

function normalizeReaderLineHeight(value) {
  return ["compact", "tight", "normal", "relaxed", "loose"].includes(value) ? value : "tight";
}

function normalizeReaderContentWidth(value) {
  return ["compact", "narrow", "medium", "wide", "full"].includes(value) ? value : "medium";
}

function normalizeReaderChapterVisibility(value) {
  return value === "hide" || value === "auto" ? value : "show";
}

function normalizeReaderTranscriptVisible(value) {
  return value !== false;
}

// ===== Download / AI normalizers =====
function normalizeDownloadFormat(value) {
  return value === "txt" ? "txt" : "srt";
}

function normalizeIncludeHotCommentsInNote(value) {
  return value === true;
}

function normalizeEnablePlayerAiQuickAction(value) {
  return value === true;
}

function normalizePlayerAiQuickPrompt(value) {
  return toString(value).trim();
}

function normalizeAiSystemPrompt(value) {
  var normalized = toString(value).trim();
  if (normalized === LEGACY_DEFAULT_AI_SYSTEM_PROMPT) {
    return DEFAULT_AI_SYSTEM_PROMPT;
  }
  return normalized;
}

function normalizeAiPresetPrompts(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(function (item) { return toString(item).trim(); })
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeAiInitialQuickPrompts(value) {
  if (!Array.isArray(value)) {
    return DEFAULT_INITIAL_QUICK_PROMPTS.slice();
  }
  return value
    .map(function (item) { return toString(item).trim(); })
    .slice(0, 4);
}

function normalizeDefaultModel(value) {
  return toString(value).trim();
}

// ===== Frontmatter normalizers =====
function normalizeFixedPropertyType(value) {
  var type = toString(value).trim().toLowerCase();
  return type === "number" || type === "checkbox" || type === "list" || type === "date" ? type : "text";
}

function normalizeFixedPropertyValue(type, value) {
  var normalizedType = normalizeFixedPropertyType(type);
  if (normalizedType === "checkbox") {
    return toString(value).trim().toLowerCase();
  }
  return toString(value).trim();
}

function isFixedPropertyRowEffectivelyEmpty(type, value) {
  return !toString(value).trim();
}

function normalizeFixedFrontmatterProperties(value) {
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

// ===== Date / URL utils =====
function formatLocalDate(value) {
  if (value === undefined) value = Date.now();
  var date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

function isSupportedBilibiliPage(url) {
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
