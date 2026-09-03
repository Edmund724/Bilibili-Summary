// extension/core/presets.ts
// AI / ASR platform presets plus the provider normalizers built on them.
// Pure data + pure functions; no Chrome APIs, no DOM.

// ===== ASR（语音转写）平台预设 =====
// 字段含义见 spec.md 第 4 节。type 决定走哪个适配器，共一种：
//   openai-transcriptions：OpenAI 兼容 multipart 端点（SiliconFlow / 本地 Whisper / 自定义）
// supportsTimestamps 决定时间戳合成方式。

export interface AsrProviderPreset {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  model: string;
  supportsTimestamps: boolean;
  note?: string;
  language?: string;
}

export const ASR_PROVIDER_PRESETS: readonly AsrProviderPreset[] = [
  {
    id: "siliconflow-sensevoice",
    name: "SiliconFlow 硅基流动（免费）",
    type: "openai-transcriptions",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "FunAudioLLM/SenseVoiceSmall",
    supportsTimestamps: true,
    note: "模型名默认 FunAudioLLM/SenseVoiceSmall，可自行填写其他模型。英文视频请在插件页顶部切换为 English 后重新刷新。"
  },
  {
    id: "local-whisper",
    name: "本地 Whisper 服务",
    type: "openai-transcriptions",
    baseUrl: "http://localhost:8000/v1",
    model: "whisper-large-v3",
    supportsTimestamps: true, // verbose_json segments
    note: "本地部署，音频不上传任何外部服务。model 可按本地部署情况修改。"
  },
  {
    id: "custom",
    name: "自定义",
    type: "openai-transcriptions",
    baseUrl: "",
    model: "",
    supportsTimestamps: true, // 自动探测
    language: "auto",
    note: "兼容 OpenAI transcriptions 协议的自定义端点。"
  }
];

// 合法的 ASR 适配器类型，决定请求构造与响应解析方式
const ASR_PROVIDER_TYPES = new Set([
  "openai-transcriptions"
]);

export interface AsrProvider {
  id: string;
  presetId: string;
  name: string;
  type: string;
  baseUrl: string;
  model: string;
  supportsTimestamps: boolean;
  enabled: boolean;
}

// 归一化单个 ASR provider：字段齐全 + type 合法值校验。
// 与 normalizeAiProvider 平行：持久化层只存"明文可回传"字段，
// apiKey 单独存放在 chrome.storage.local，不进列表，故此处不带 apiKey。
export function normalizeAsrProvider(item: unknown): AsrProvider | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Partial<AsrProvider>;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const type = String(raw.type || "").trim();
  if (!ASR_PROVIDER_TYPES.has(type)) return null;
  return {
    id,
    presetId: String(raw.presetId || "custom"),
    name: String(raw.name || "自定义").trim() || "自定义",
    type,
    baseUrl: String(raw.baseUrl || "").trim().replace(/\/+$/, ""),
    model: String(raw.model || "").trim(),
    supportsTimestamps: raw.supportsTimestamps !== false,
    enabled: raw.enabled !== false
  };
}

// ===== AI platform presets =====
export interface AiProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  requiresKey: boolean;
}

export const PRESETS: readonly AiProviderPreset[] = [
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

export function normalizeBaseUrl(value: unknown): string {
  return String(value || "").trim().replace(/\/+$/, "");
}

// ASR 转写语言档位（全局设置 asrLanguage，auto / zh / en），auto 为默认，
// 非法值回落 auto。zh/en 由适配器转为查询参数传给平台：SiliconFlow 辰星
// （XingChen）系列模型只有传 ?language=english 才走英文转写，否则纯英文
// 音频静默返回空文本；本地 Whisper 忽略该参数（服务端自动识别）。
// 该设置只出现在 popup 顶部。
export function normalizeAsrLanguage(value: unknown): "auto" | "zh" | "en" {
  const lang = String(value || "").trim().toLowerCase();
  return lang === "zh" || lang === "en" ? lang : "auto";
}
