// OpenAI 兼容协议常量与平台预设。
// 覆盖 OpenAI / DeepSeek / Qwen / Zhipu / Kimi / MiniMax / Mimo / Opencode Go / OpenRouter / Stepfun / Ollama（OpenAI 兼容模式）等。

export const OPENAI_COMPAT = {
  listModels: "/models",
  chatPath: "/chat/completions"
};

export const PRESETS = [
  { id: "openai_compat", name: "OpenAI 兼容", baseUrl: "https://api.openai.com/v1" },
  { id: "deepseek",      name: "DeepSeek",    baseUrl: "https://api.deepseek.com/v1" },
  { id: "qwen",          name: "Qwen",        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "zhipu",         name: "GLM",         baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "moonshot",      name: "Kimi",        baseUrl: "https://api.kimi.com/coding/v1" },
  { id: "minimax",       name: "MiniMax",     baseUrl: "https://api.minimaxi.com/v1" },
  { id: "mimo",          name: "Mimo",        baseUrl: "https://api.mimo.ai/v1" },
  { id: "opencodego",    name: "Opencode Go", baseUrl: "https://api.doubao.com/v1" },
  { id: "openrouter",    name: "OpenRouter",  baseUrl: "https://openrouter.ai/api/v1" },
  { id: "stepfun",       name: "Stepfun",     baseUrl: "https://api.stepfun.com/step_plan/v1" },
  { id: "modelscope",    name: "ModelScope",  baseUrl: "https://api-inference.modelscope.cn/v1" },
  { id: "ollama",        name: "Ollama (本地)", baseUrl: "http://localhost:11434/v1" },
  { id: "custom",        name: "自定义",      baseUrl: "" }
];

export function getPresetById(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

export function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}