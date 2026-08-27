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

// ===== ASR（语音转写）平台预设 =====
// 字段含义见 spec.md 第 4 节。type 决定走哪个适配器，共一种：
//   openai-transcriptions：OpenAI 兼容 multipart 端点（SiliconFlow / 本地 Whisper / 自定义）
// maxBytes / maxDurationSec 用于切片决策；supportsTimestamps 决定时间戳合成方式。
// ASR 转写语言档位：auto（自动检测）/ zh / en。zh/en 以查询参数传给平台：
// SiliconFlow 辰星（XingChen）系列模型只有传 ?language=english 才走英文转写，
// 否则纯英文音频静默返回空文本；本地 Whisper 忽略该参数（服务端自动识别）。
export const ASR_LANGUAGE_OPTIONS = [
  { value: "auto", label: "自动检测（推荐）" },
  { value: "zh", label: "中文" },
  { value: "en", label: "English（英文视频选此项）" }
];

export const ASR_PROVIDER_PRESETS = [
  {
    id: "siliconflow-sensevoice",
    name: "SiliconFlow 硅基流动（免费）",
    type: "openai-transcriptions",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "XingChenAGI/XingChenASR-V3.2",
    // 模型名固定为四选一下拉；Qwen3-ASR 为收费模型，其余免费。
    modelOptions: [
      { value: "Qwen/Qwen3-ASR-1.7B", label: "Qwen/Qwen3-ASR-1.7B（收费）" },
      { value: "XingChenAGI/XingChenASR-V3.2", label: "XingChenAGI/XingChenASR-V3.2" },
      { value: "XingChenAGI/XingChenASR-Diarize-V3.0", label: "XingChenAGI/XingChenASR-Diarize-V3.0" },
      { value: "XingChenAGI/XingChenASR-V3.2-Ultra", label: "XingChenAGI/XingChenASR-V3.2-Ultra" }
    ],
    maxBytes: 50 * 1024 * 1024, // 50MB
    maxDurationSec: 60 * 60, // 1 小时
    supportsTimestamps: true,
    // 辰星（XingChen）系列 / SenseVoice 的英文识别依赖 ?language=english 查询参数，
    // 中英混说也可选 auto；纯英文视频务必选 English。
    language: "zh",
    note: "模型名从下拉四选一；Qwen/Qwen3-ASR-1.7B 为收费模型。纯英文视频请在平台行选择 English 语言。"
  },
  {
    id: "local-whisper",
    name: "本地 Whisper 服务",
    type: "openai-transcriptions",
    baseUrl: "http://localhost:8000/v1",
    model: "whisper-large-v3",
    maxBytes: 0, // 取决于本地部署，0 表示不限制
    maxDurationSec: 0, // 不限制
    supportsTimestamps: true, // verbose_json segments
    language: "auto", // Whisper 服务端自动检测语言，不传 language 参数
    note: "本地部署，音频不上传任何外部服务。model 可按本地部署情况修改。"
  },
  {
    id: "custom",
    name: "自定义",
    type: "openai-transcriptions",
    baseUrl: "",
    model: "",
    maxBytes: 0,
    maxDurationSec: 0,
    supportsTimestamps: true, // 自动探测
    language: "auto",
    note: "兼容 OpenAI transcriptions 协议的自定义端点。"
  }
];

// 合法的 ASR 适配器类型，决定请求构造与响应解析方式
const ASR_PROVIDER_TYPES = new Set([
  "openai-transcriptions"
]);

export function getAsrPresetById(id) {
  return ASR_PROVIDER_PRESETS.find((p) => p.id === id) || null;
}

// 归一化单个 ASR provider：字段齐全 + type 合法值校验。
// 与 normalizeAiProvider 平行：持久化层只存"明文可回传"字段，
// apiKey 单独存放在 chrome.storage.local，不进列表，故此处不带 apiKey。
export function normalizeAsrProvider(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || "").trim();
  if (!id) return null;
  const type = String(item.type || "").trim();
  if (!ASR_PROVIDER_TYPES.has(type)) return null;
  return {
    id,
    presetId: String(item.presetId || "custom"),
    name: String(item.name || "自定义").trim() || "自定义",
    type,
    baseUrl: String(item.baseUrl || "").trim().replace(/\/+$/, ""),
    model: String(item.model || "").trim(),
    maxBytes: Number(item.maxBytes) || 0,
    maxDurationSec: Number(item.maxDurationSec) || 0,
    supportsTimestamps: item.supportsTimestamps !== false,
    // 转写语言档位（auto/zh/en），非法值回落 auto
    language: ASR_LANGUAGE_OPTIONS.some((o) => o.value === item.language) ? item.language : "auto",
    enabled: item.enabled !== false
  };
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

// ===== Date / URL utils =====
export function formatLocalDate(value) {
  if (value === undefined) value = Date.now();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

export function isSupportedBilibiliPage(url) {
  try {
    const parsed = new URL(String(url || ""));
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
  readerChapterVisible: true,
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
  defaultModel: "",
  aiThinkingLevel: "off",
  // ===== ASR（语音转写）回退配置 =====
  asrProviders: [],          // [{id, name, type, baseUrl, model, language, maxBytes, maxDurationSec, ...}]
  activeAsrProviderId: "",   // 当前选用的 ASR 平台 id
  asrAutoFallback: true,     // 无字幕轨时自动走 ASR；false 则仅提示
  asrLanguage: "auto"        // 转写语言档位（auto/zh/en），zh/en 传给平台
};

const SYSTEM_FRONTMATTER_FIELDS = new Set(
  DEFAULT_SETTINGS.frontmatterFields.map((field) => String(field).toLowerCase())
);
