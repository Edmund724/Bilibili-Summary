// extension/core/defaults.ts
// Default settings and default prompt constants shared across extension
// contexts. Pure data only — no logic; normalizers live in validators.ts /
// presets.ts, generic utils in shared/utils.ts.

// ===== Version =====
// Single source of truth for the extension version; consumed by the content
// script and the background side panel. Kept in sync with manifest.json's
// "version" by scripts/build-content.js' version guard.
// 实体在 core/version.ts（bootstrap 只打包这一个常量，不连带全部默认设置），
// 这里 re-export 维持既有 import 路径不变。
export { BOC_VERSION } from "./version.js";

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

// PR5c：player-ai 的 storage 信箱（boc_player_ai_quick_action_v1）已随 AI
// 侧边栏摘除退役——快捷动作改走消息直发（player-ai-quick-action-chat），
// 信箱键不再读写；存量键留存在用户 storage 中，无害。

export interface FixedFrontmatterProperty {
  key: string;
  type: "text" | "number" | "checkbox" | "list" | "date";
  value: string;
}

export interface NotePlaceholderSection {
  title: string;
  position: "before_intro" | "before_chapters" | "before_subtitle";
  content: string;
}

export interface Settings {
  [key: string]: unknown;
  tags: string;
  downloadFormat: string;
  includeDateInFilename: boolean;
  includeHotCommentsInNote: boolean;
  enablePlayerAiQuickAction: boolean;
  playerAiQuickPrompt: string;
  includeTimestampInBody: boolean;
  enableDebugLogs: boolean;
  readerTheme: string;
  readerFontScale: string;
  readerLetterSpacing: string;
  readerLineHeight: string;
  readerContentWidth: string;
  readerChapterVisibility: string;
  readerChapterVisible: boolean;
  readerTranscriptVisible: boolean;
  frontmatterFields: string[];
  fixedFrontmatterProperties: FixedFrontmatterProperty[];
  notePlaceholderSections: NotePlaceholderSection[];
  aiSystemPrompt: string;
  aiInitialQuickPrompts: string[];
  aiPresetPrompts: string[];
  defaultModel: string;
  aiThinkingLevel: "off" | "low" | "high";
  activeAsrProviderId: string;
  asrAutoFallback: boolean;
  asrLanguage: string;
}

// ===== Merged default settings =====
export const DEFAULT_SETTINGS: Settings = {
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
  // asrProviders 列表不在此处：provider 列表归 asr/asr-provider-store.js
  // （provider-store 收口，经 asr-providers-save 消息写回），settings 只存标量。
  activeAsrProviderId: "",   // 当前选用的 ASR 平台 id
  asrAutoFallback: true,     // 无字幕轨时自动走 ASR；false 则仅提示
  asrLanguage: "auto"        // 转写语言档位（auto/zh/en），zh/en 传给平台
};
