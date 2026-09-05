// ai/thinking-profiles.ts — 思考档位（off/low/high）→ 平台请求字段的纯查表模块。
// 无 DOM/port/chrome 依赖；resolveThinkingProfile 是导出纯函数，请求构造单缝
// （ai/completion.ts）与后续 UI 票（对话 offUnavailable 提示）都直接调用。
//
// 每个事实唯一主人：
// - 平台 preset 列表 / baseUrl 数据唯一主人在 core/presets.ts，本模块只派生
//   host 索引（不复制 baseUrl）；
// - 模型血统事实（永远/混合/永不思考）只活在 TAXONOMY / EXCEPTIONS；
// - 参数逐格事实以矩阵报告为准：
//   .scratch/reports/model-thinking-matrix-20260905.md（13 平台 × 5 问矩阵 +
//   模型 taxonomy，官方文档确证为主），每格注释里简写出处域名。
// 设计机制（三层声明表 + 稀疏档位 + 测试期校验器）参考 hana-model-catalog
// （github.com/liliMozi/hana-model-catalog；无 LICENSE，仅参考未复制数据），
// 见 spec「出处与致谢」节。
//
// 解析语义（spec 最终版）：
//   provider = PROVIDERS[presetId] ?? HOST索引[baseUrl host] ?? 无
//   规则     = EXCEPTIONS（精确/前缀模型） >> TAXONOMY（模式→class）
//              >> provider.unknownClass >> UNKNOWN 哨兵
//   provider override 型（OpenRouter）：levels[level] 对任何模型整体替换
//   class 规则；其余平台只给 unknownClass（平台无关词汇）或不给（按模型定协议）。
//   patch = 规则[level]；streamOnly 规则遇非流式按「无事实」处理（Q14A）。
//   仅 off 级联：never → 不发、静默（关思考已天然成立）；其余有 low 声明
//   （开关型落 on 写点）→ 发 low + offUnavailable + offFallback:"low"；无 low
//   → 不发 + offUnavailable + offFallback:null。
//   low/high 缺档不 clamp、不发（Q12C）。
//   unknown 是显式哨兵（thinkingClass:"unknown"，非静默 false）：三档均不发
//   （Q4C——软失败优于硬 400）。

import { PRESETS } from "../core/presets.js";

// ===== 档位词表 =====
// UI 三档按钮与全局档位键的取值域（唯一主人自本票起收口至此；
// completion.ts re-export normalizeThinkingLevel 保住既有 import 路径）。
export const AI_THINKING_LEVELS = ["off", "low", "high"] as const;
export type ThinkingLevel = (typeof AI_THINKING_LEVELS)[number];

export function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  return (AI_THINKING_LEVELS as readonly string[]).includes(String(value))
    ? (String(value) as ThinkingLevel)
    : "off";
}

// ===== schema =====
// 单档字段补丁。fields 键白名单：thinking / enable_thinking / reasoning_effort
// （校验器强制）。温度类字段明令禁止——Kimi 等平台思考模式温度/top_p 固定且
// 官方明确不要显式传，本扩展从不发 temperature 是安全属性（矩阵报告现状判定节）。
export interface ThinkingPatch {
  fields?: Record<string, unknown>;
  // 仅流式可发（如 qwen3-235b/32b/30b 的 enable_thinking:false，百炼限制）；
  // 非流式请求遇此规则按「无事实」处理，走级联（Q14A）。
  streamOnly?: boolean;
}

// 模型血统规则。thinkingClass 是血统事实（校验器强制必填）：
// always=关不掉（off 缺失时级联）；hybrid=可开关（必有 off 声明，可 streamOnly）；
// never=从不思考（无任何档位，off 静默）。
// 开关型平台用 on 作为 low/high 的唯一写点（GLM/Kimi/Mimo/SiliconFlow 等——
// 档位只表达「开」，无力度差异）；三档型（effort/budget 系）写显式 low/high。
export interface ClassRule {
  thinkingClass: "always" | "hybrid" | "never";
  off?: ThinkingPatch;
  on?: ThinkingPatch;
  low?: ThinkingPatch;
  high?: ThinkingPatch;
  // token 上限参数的随表事实（openai-reasoning 系须 max_completion_tokens）；
  // 缺省 = max_tokens。本票只随 resolver 返回，请求体消费是 04 号票。
  tokenParam?: "max_tokens" | "max_completion_tokens";
}

// 模式表条目：patterns 为模型名前缀（小写比较），内嵌 * 为通配（两端锚定）。
// 数组序 = 优先级（先命中先得），靠序解决前缀包含关系（如 glm-5.2 先于 glm-5）。
export interface TaxonomyEntry {
  class: string;
  patterns: string[];
}

// 平台规则：unknownClass 给「词汇平台无关」平台的未列模型兜底；override 型
// （OpenRouter）对任何模型整体替换 class 规则。两者互斥使用。
export interface ProviderOverride {
  thinkingClass: "always" | "hybrid" | "never";
  levels: Partial<Record<ThinkingLevel, ThinkingPatch>>;
}

export interface ProviderRule {
  unknownClass?: string;
  override?: ProviderOverride;
}

// ===== CLASSES：class 规则（参数事实的写点，一格一事实）=====
export const CLASSES: Record<string, ClassRule> = {
  // --- OpenAI（developers.openai.com）---
  // gpt-5.x/o3/o4/gpt-6 血统：effort 档位，无 none 的模型关不掉 → always，off 级联落 low。
  "openai-reasoning": {
    thinkingClass: "always",
    low: { fields: { reasoning_effort: "low" } },
    high: { fields: { reasoning_effort: "high" } },
    // reasoning 模型不认 max_tokens（04 号票消费此事实）
    tokenParam: "max_completion_tokens"
  },
  // 例外表成员 gpt-5.1/5.2：支持 reasoning_effort:"none" → hybrid。
  "openai-reasoning-none": {
    thinkingClass: "hybrid",
    off: { fields: { reasoning_effort: "none" } },
    low: { fields: { reasoning_effort: "low" } },
    high: { fields: { reasoning_effort: "high" } },
    tokenParam: "max_completion_tokens"
  },

  // --- Qwen/百炼（alibabacloud.com 百炼 Deep Thinking；qwen.ai）---
  // 开关型：enable_thinking，档位无力度差异 → on 唯一写点。
  "qwen-hybrid-switch": {
    thinkingClass: "hybrid",
    off: { fields: { enable_thinking: false } },
    on: { fields: { enable_thinking: true } }
  },
  // 例外表成员 qwen3-235b*/qwen3-32b/qwen3-30b*：enable_thinking:false 仅流式可用。
  // （矩阵矩阵行只点名 235b/32b「仅流式」，spec/工单把 30b 一并标 streamOnly——
  // 从宽处理，非流式落级联最安全。）
  "qwen-hybrid-switch-streamonly": {
    thinkingClass: "hybrid",
    off: { fields: { enable_thinking: false }, streamOnly: true },
    on: { fields: { enable_thinking: true } }
  },
  // 例外表成员 qwen3.8-max*：开关 + effort 三档（high 映射 xhigh）。
  "qwen-hybrid-effort": {
    thinkingClass: "hybrid",
    off: { fields: { enable_thinking: false } },
    low: { fields: { reasoning_effort: "low" } },
    high: { fields: { reasoning_effort: "xhigh" } }
  },
  // thinking-2507 系 / qwen3-next-*-thinking / qwq / qwen3.7-max-preview /
  // qwen3.8-2.4t-a95b：永远思考，无关闭无档位。
  "qwen-always": { thinkingClass: "always" },

  // --- DeepSeek（api-docs.deepseek.com）---
  // v3.2/v4-pro/flash 现行混合：off 用 thinking 开关、low/high 用 effort。
  "deepseek-hybrid-effort": {
    thinkingClass: "hybrid",
    off: { fields: { thinking: { type: "disabled" } } },
    low: { fields: { reasoning_effort: "low" } },
    high: { fields: { reasoning_effort: "high" } }
  },
  // deepseek-reasoner（V3.2 时代）/ deepseek-r1 系：永远思考、无档位。
  "deepseek-reasoner-always": { thinkingClass: "always" },
  // deepseek-chat（V3.2-Exp 时代）：永不思考。
  "deepseek-chat-never": { thinkingClass: "never" },

  // --- GLM 智谱（docs.bigmodel.cn）---
  // glm-4.5~5.1：开关型 thinking.type。
  "glm-hybrid-switch": {
    thinkingClass: "hybrid",
    off: { fields: { thinking: { type: "disabled" } } },
    on: { fields: { thinking: { type: "enabled" } } }
  },
  // glm-5.2 起 effort 三档（关闭仍走 thinking 开关）。
  "glm-hybrid-effort": {
    thinkingClass: "hybrid",
    off: { fields: { thinking: { type: "disabled" } } },
    low: { fields: { reasoning_effort: "low" } },
    high: { fields: { reasoning_effort: "high" } }
  },
  // 例外表成员 glm-5.3*：disabled 直接报错 → 永远思考；档位无文档化事实，不写。
  "glm-always": { thinkingClass: "always" },

  // --- Kimi（platform.kimi.ai / kimi.com/code/docs）---
  // kimi-k2.5/k2.6：开关型 thinking.type（k2.x 无档位）。
  "kimi-hybrid-switch": {
    thinkingClass: "hybrid",
    off: { fields: { thinking: { type: "disabled" } } },
    on: { fields: { thinking: { type: "enabled" } } }
  },
  // 例外表成员 kimi-k3*：永远思考 + effort 三档（默认 max）。
  "kimi-k3-effort": {
    thinkingClass: "always",
    low: { fields: { reasoning_effort: "low" } },
    high: { fields: { reasoning_effort: "high" } }
  },
  // 例外表成员 kimi-k2.7*：强制 thinking:{type:"enabled",keep:"all"}（仅接受该形状）
  // → 永远思考；无档位 → off 级联不发（泛化的 enabled 形状也不发，缺事实不指定）。
  "kimi-always": { thinkingClass: "always" },
  // kimi-k2 instruct 系：永不思考。
  "kimi-instruct-never": { thinkingClass: "never" },

  // --- MiniMax（platform.minimax.io / github.com/MiniMax-AI）---
  // m1~m3 全系永远思考：无关闭开关、无档位参数。
  "minimax-always": { thinkingClass: "always" },

  // --- 豆包/火山方舟（volcengine.com 方舟深度思考）---
  // doubao-seed 系混合开关；depth 档位随模型不同、无逐模型事实 → 不写（Q8A）。
  "doubao-hybrid-switch": {
    thinkingClass: "hybrid",
    off: { fields: { thinking: { type: "disabled" } } },
    on: { fields: { thinking: { type: "enabled" } } }
  },

  // --- StepFun（platform.stepfun.ai step_plan reasoning API）---
  // 例外表成员 step-3.7：永远思考 + effort 三档（/think off 客户端语义即映射 low 档）。
  "step37-effort": {
    thinkingClass: "always",
    low: { fields: { reasoning_effort: "low" } },
    high: { fields: { reasoning_effort: "high" } }
  },
  // step-3 / step-3.5-flash：推理模型，无关闭参数、无已文档化档位参数（3.5 的
  // low-inference 是产品模式非请求参数）→ 不写 patch。
  "step-always": { thinkingClass: "always" },

  // --- Mimo 小米（aliyun.com 百炼代售页）---
  // 开关型 enable_thinking（v2.5-pro 默认开），无官方档位参数。
  "mimo-hybrid-switch": {
    thinkingClass: "hybrid",
    off: { fields: { enable_thinking: false } },
    on: { fields: { enable_thinking: true } }
  },

  // --- Ollama（docs.ollama.com OpenAI 兼容）---
  // effort 词汇：off=none、low/high=effort；thinking/enable_thinking 被静默忽略。
  // 作为 unknownClass 给未列模型兜底（hybrid=平台词汇可用、模型是否思考未知）。
  "ollama-effort": {
    thinkingClass: "hybrid",
    off: { fields: { reasoning_effort: "none" } },
    low: { fields: { reasoning_effort: "low" } },
    high: { fields: { reasoning_effort: "high" } }
  },

  // --- SiliconFlow（docs.siliconflow.cn）---
  // 开关型 enable_thinking（适用大多数推理模型），作为 unknownClass 兜底；
  // 其 effort/thinking_budget 只对特定模型文档化且未给逐模型事实 → 不写。
  "siliconflow-switch": {
    thinkingClass: "hybrid",
    off: { fields: { enable_thinking: false } },
    on: { fields: { enable_thinking: true } }
  }
};

// ===== EXCEPTIONS：精确/前缀模型例外（压过 TAXONOMY，Q11C：换线协议的新一代）=====
// 数组序 = 优先级；首条是刻意前置的 carve-out：*thinking-2507 变体若不先命中，
// 会被下面的 qwen3-235b/qwen3-30b 前缀误判成 streamOnly 混合（对永远思考模型
// 发 enable_thinking:false 会报错）。
export const EXCEPTIONS: readonly TaxonomyEntry[] = [
  // 百炼：qwen3-*-thinking-2507 永远思考（alibabacloud.com）
  { class: "qwen-always", patterns: ["qwen3-*-thinking-2507"] },
  // qwen3.8-max*：effort 档位、high→xhigh（alibabacloud.com / qwen.ai）
  { class: "qwen-hybrid-effort", patterns: ["qwen3.8-max"] },
  // qwen3-235b*/qwen3-32b/qwen3-30b*：off 规则仅流式（alibabacloud.com）
  { class: "qwen-hybrid-switch-streamonly", patterns: ["qwen3-235b", "qwen3-32b", "qwen3-30b"] },
  // glm-5.3*：disabled 直接报错 → 永远思考（docs.bigmodel.cn）
  { class: "glm-always", patterns: ["glm-5.3"] },
  // kimi-k2.7*：强制 keep:all → 永远思考（platform.kimi.ai）
  { class: "kimi-always", patterns: ["kimi-k2.7"] },
  // kimi-k3*：effort 三档 → 永远思考（platform.kimi.ai）
  { class: "kimi-k3-effort", patterns: ["kimi-k3"] },
  // gpt-5.1/5.2：off → reasoning_effort:"none"（developers.openai.com）
  { class: "openai-reasoning-none", patterns: ["gpt-5.1", "gpt-5.2"] },
  // gpt-6*/o3/o4*：无 none（传了 400）→ 永远思考（developers.openai.com）
  { class: "openai-reasoning", patterns: ["gpt-6", "o3", "o4"] }
];

// ===== TAXONOMY：模型名模式 → class（数组序 = 优先级）=====
// 矩阵报告「模型 taxonomy」表的逐行落地；模式统一小写前缀匹配（内嵌 * 通配）。
export const TAXONOMY: readonly TaxonomyEntry[] = [
  // 百炼永远思考族：qwen3-next-*-thinking / qwen3.7-max-preview /
  // qwen3.8-2.4t-a95b / qwq（thinking-2507 系在例外表前置 carve-out）
  { class: "qwen-always", patterns: ["qwen3-next-*-thinking", "qwen3.7-max-preview", "qwen3.8-2.4t-a95b", "qwq"] },
  // qwen3 商业族 + qwen3.5/3.6/3.7/3.8：混合开关（默认值随代际不同，不影响显式发参）
  { class: "qwen-hybrid-switch", patterns: ["qwen3-max", "qwen-plus", "qwen-flash", "qwen-turbo", "qwen3.5", "qwen3.6", "qwen3.7", "qwen3.8"] },
  // DeepSeek：chat 永不 / reasoner·r1 永远 / v3.2·v4 混合（api-docs.deepseek.com）
  { class: "deepseek-chat-never", patterns: ["deepseek-chat"] },
  { class: "deepseek-reasoner-always", patterns: ["deepseek-reasoner", "deepseek-r1"] },
  { class: "deepseek-hybrid-effort", patterns: ["deepseek-v3.2", "deepseek-v4"] },
  // GLM：5.2 先于 glm-5 前缀（数组序=优先级）；4.5~5.1 开关（docs.bigmodel.cn）
  { class: "glm-hybrid-effort", patterns: ["glm-5.2"] },
  { class: "glm-hybrid-switch", patterns: ["glm-5", "glm-5.1", "glm-4.5", "glm-4.6", "glm-4.7"] },
  // Kimi：k2-thinking/k-thinking 永远 → k2.5/2.6 混合 → k2- 前缀 instruct 永不
  // （顺序不可换：kimi-k2-thinking 也以 kimi-k2- 开头）（platform.kimi.ai）
  { class: "kimi-always", patterns: ["kimi-k2-thinking", "kimi-thinking"] },
  { class: "kimi-hybrid-switch", patterns: ["kimi-k2.5", "kimi-k2.6"] },
  { class: "kimi-instruct-never", patterns: ["kimi-k2-"] },
  // MiniMax m1~m3：永远思考（platform.minimax.io）
  { class: "minimax-always", patterns: ["minimax-m1", "minimax-m2", "minimax-m3"] },
  // 豆包 seed 系：混合开关（volcengine.com）
  { class: "doubao-hybrid-switch", patterns: ["doubao-seed"] },
  // OpenAI gpt-5 血统：effort 档位；5.1/5.2 的 off=none 在例外表（developers.openai.com）
  { class: "openai-reasoning", patterns: ["gpt-5"] },
  // StepFun：3.7 先于 step-3 前缀（platform.stepfun.ai）
  { class: "step37-effort", patterns: ["step-3.7"] },
  { class: "step-always", patterns: ["step-3"] },
  // Mimo v2 系：混合开关（aliyun.com）
  { class: "mimo-hybrid-switch", patterns: ["mimo-v2"] }
];

// ===== PROVIDERS：平台规则（键 = core/presets.ts 的 AI preset id）=====
// unknownClass 分工（spec）：词汇平台无关的（Ollama/SiliconFlow/ModelScope/Mimo）
// 给 provider 级默认；按模型定协议的（OpenAI/DeepSeek/Qwen/GLM/Kimi/MiniMax/
// StepFun）不给，未知模型落 unknown 哨兵。OpenRouter 是唯一 override 型。
// Opencode Go（api.doubao.com）域名已死（NXDOMAIN）：不写规则，落 unknown（Q16）。
export const PROVIDERS: Record<string, ProviderRule> = {
  openai_compat: {}, // 严格 400（developers.openai.com），未列模型宁可不发
  deepseek: {},      // 协议按模型定（api-docs.deepseek.com）
  qwen: {},          // 百炼模型族已覆盖 taxonomy；未列模型白名单制风险高，不发
  zhipu: {},         // docs.bigmodel.cn
  moonshot: {},      // platform.kimi.ai（未知字段容忍度未文档化）
  minimax: {},       // platform.minimax.io
  mimo: { unknownClass: "mimo-hybrid-switch" },
  openrouter: {
    // override 型：reasoning_effort 是官方顶层合法参数（含 none），对任何模型
    // 生效、透传上游解释（openrouter.ai/docs）。reasoning:{exclude} 语义是
    // 「藏思考」不是「关思考」，不用于 off。
    override: {
      thinkingClass: "hybrid",
      levels: {
        off: { fields: { reasoning_effort: "none" } },
        low: { fields: { reasoning_effort: "low" } },
        high: { fields: { reasoning_effort: "high" } }
      }
    }
  },
  stepfun: {}, // step_plan 订阅端点（platform.stepfun.ai），模型族已覆盖 taxonomy
  modelscope: { unknownClass: "qwen-hybrid-switch" }, // 托管模型用原生 enable_thinking（modelscope.cn）
  ollama: { unknownClass: "ollama-effort" },
  siliconflow: { unknownClass: "siliconflow-switch" }
};

// ===== host 索引：从 core/presets.ts 派生（baseUrl 数据不在此复制）=====
// AI preset 之外：SiliconFlow 只有 ASR preset 登记同域名，custom 平台填其 baseUrl
// 发 AI 请求时须经这条显式别名命中（PROVIDERS["siliconflow"]）。派生条目若在
// PROVIDERS 无对应键则惰性无效（查到无规则 = 无 provider → 落 unknown）。
const PRESET_HOST_INDEX = new Map<string, string>();

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // 无 scheme 的 baseUrl 进不了 fetch，同样进不了 host 索引
    return "";
  }
}

for (const preset of PRESETS) {
  const host = hostOf(preset.baseUrl);
  if (host) {
    PRESET_HOST_INDEX.set(host, preset.id);
  }
}
// 唯一的手工别名：SiliconFlow 只存在于 ASR preset（core/presets 的音频表），
// AI preset 表没有它，但它是思考适配收录的平台（enable_thinking 系）——
// 用户手填其 baseUrl 作 custom 平台时靠这条命中。表数据仍不复制 baseUrl。
PRESET_HOST_INDEX.set("api.siliconflow.cn", "siliconflow");

// ===== resolver =====

export type ResolvedThinkingClass = ClassRule["thinkingClass"] | "unknown";

export interface ResolveThinkingInput {
  // preset 识别主路径（provider 记录的 presetId）——02 号票穿线，本票仅参数位生效；
  // 未命中时回落 baseUrl host 推断。
  presetId?: string;
  baseUrl?: string;
  model: string;
  level: string;
  stream: boolean;
}

export interface ThinkingResolution {
  // 要并入请求体的思考字段；空对象 = 不发（软失败优于硬 400）。
  fields: Record<string, unknown>;
  // token 上限参数事实（04 号票消费）；unknown/override 平台不返回。
  tokenParam?: "max_tokens" | "max_completion_tokens";
  // off 不可用标记：级联落了 low 或无 low 可落时为 true（never 静默与
  // unknown 均为 false）——03 号票对话 UI 据此提示。
  offUnavailable: boolean;
  // off 级联去向的显式字段（03 号票对话 UI 区分长/短版文案）："low" = 落了
  // 最低思考档（长版提示）；null = 无 low 可落（短版提示）或 off 正常可用/
  // never 静默/unknown（均无提示）。
  offFallback: "low" | null;
  thinkingClass: ResolvedThinkingClass;
}

export function resolveThinkingProfile({ presetId, baseUrl, model, level, stream }: ResolveThinkingInput): ThinkingResolution {
  const normalizedLevel = normalizeThinkingLevel(level);
  const normalizedModel = String(model || "").trim().toLowerCase();
  const provider = resolveProvider(presetId, baseUrl);

  // override 型：对任何模型整体替换 class 规则（识别层直接短路）。
  if (provider?.override) {
    return applyRule(
      { thinkingClass: provider.override.thinkingClass, ...provider.override.levels },
      normalizedLevel,
      stream
    );
  }

  // 识别：例外表 >> 模式表 >> provider.unknownClass >> UNKNOWN 哨兵。
  const className = matchRuleClass(EXCEPTIONS, normalizedModel) ?? matchRuleClass(TAXONOMY, normalizedModel) ?? provider?.unknownClass;
  const rule = className ? CLASSES[className] : undefined;
  if (!rule) {
    return { fields: {}, offUnavailable: false, offFallback: null, thinkingClass: "unknown" };
  }
  return applyRule(rule, normalizedLevel, stream);
}

// provider 识别：presetId 优先（02 穿线），host 推断兜底（本票对 custom/直填
// baseUrl 的平台生效）。
function resolveProvider(presetId?: string, baseUrl?: string): ProviderRule | undefined {
  const byId = String(presetId || "").trim();
  if (byId && PROVIDERS[byId]) {
    return PROVIDERS[byId];
  }
  const hostPresetId = PRESET_HOST_INDEX.get(hostOf(String(baseUrl || "")));
  return hostPresetId ? PROVIDERS[hostPresetId] : undefined;
}

function matchRuleClass(entries: readonly TaxonomyEntry[], model: string): string | undefined {
  for (const entry of entries) {
    for (const pattern of entry.patterns) {
      if (modelMatches(pattern, model)) {
        return entry.class;
      }
    }
  }
  return undefined;
}

// 前缀匹配为主（日期快照/变体后缀自然命中，如 gpt-5.1-2025-11-13）；
// 内嵌 * 为通配、两端锚定（如 qwen3-next-*-thinking）。
function modelMatches(pattern: string, model: string): boolean {
  if (!pattern.includes("*")) {
    return model.startsWith(pattern);
  }
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return regex.test(model);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyRule(rule: ClassRule, level: ThinkingLevel, stream: boolean): ThinkingResolution {
  if (level === "off") {
    const offPatch = streamEnabledPatch(rule.off, stream);
    if (offPatch) {
      return withTokenParam({ fields: { ...(offPatch.fields ?? {}) }, offUnavailable: false, offFallback: null, thinkingClass: rule.thinkingClass }, rule);
    }
    // off 缺失（含 streamOnly 被非流式阻断）→ 级联。
    if (rule.thinkingClass === "never") {
      // 关思考已天然成立：不发、静默（03 号票对 never 不渲染提示）。
      return { fields: {}, offUnavailable: false, offFallback: null, thinkingClass: "never" };
    }
    const lowPatch = streamEnabledPatch(rule.low ?? rule.on, stream);
    if (lowPatch?.fields && Object.keys(lowPatch.fields).length > 0) {
      return withTokenParam({ fields: { ...lowPatch.fields }, offUnavailable: true, offFallback: "low", thinkingClass: rule.thinkingClass }, rule);
    }
    // 无 low 可落（如 minimax/k2.7-code 无档位参数）：不发 + 标记。
    return withTokenParam({ fields: {}, offUnavailable: true, offFallback: null, thinkingClass: rule.thinkingClass }, rule);
  }

  // low/high：开关型落 on 唯一写点；缺档不 clamp、不发（Q12C）。
  const patch = streamEnabledPatch(rule[level] ?? rule.on, stream);
  if (patch?.fields && Object.keys(patch.fields).length > 0) {
    return withTokenParam({ fields: { ...patch.fields }, offUnavailable: false, offFallback: null, thinkingClass: rule.thinkingClass }, rule);
  }
  return withTokenParam({ fields: {}, offUnavailable: false, offFallback: null, thinkingClass: rule.thinkingClass }, rule);
}

// Q14A：streamOnly 规则遇非流式按「无事实」处理（返回 undefined，走级联/缺档）。
function streamEnabledPatch(patch: ThinkingPatch | undefined, stream: boolean): ThinkingPatch | undefined {
  if (!patch || (patch.streamOnly && !stream)) {
    return undefined;
  }
  return patch;
}

function withTokenParam(resolution: ThinkingResolution, rule: ClassRule): ThinkingResolution {
  if (rule.tokenParam) {
    resolution.tokenParam = rule.tokenParam;
  }
  return resolution;
}

// ===== 表校验器（测试期「编译器」，Q2B）=====
// 校验真实表（无参调用）或注入违规后的表副本；返回中文错误列表（空 = 通过）。
// 工单 AC 第 6 条的每条规则在此各有一 checks，正反用例见 thinking-profiles.test.js。

const FIELD_WHITELIST = new Set(["thinking", "enable_thinking", "reasoning_effort"]);
const CLASS_FACTS = new Set(["always", "hybrid", "never"]);
const TOKEN_PARAMS = new Set(["max_tokens", "max_completion_tokens"]);
const LEVEL_KEYS = ["off", "on", "low", "high"] as const;

export interface ThinkingTables {
  classes?: Record<string, ClassRule>;
  taxonomy?: readonly TaxonomyEntry[];
  exceptions?: readonly TaxonomyEntry[];
  providers?: Record<string, ProviderRule>;
}

export function validateThinkingTables(tables: ThinkingTables = {}): string[] {
  const classes = tables.classes ?? CLASSES;
  const taxonomy = tables.taxonomy ?? TAXONOMY;
  const exceptions = tables.exceptions ?? EXCEPTIONS;
  const providers = tables.providers ?? PROVIDERS;
  const errors: string[] = [];

  for (const [name, rule] of Object.entries(classes)) {
    const at = `CLASSES.${name}`;
    if (!CLASS_FACTS.has(rule.thinkingClass)) {
      errors.push(`${at}: thinkingClass 必填，取值 always/hybrid/never`);
    }
    if (rule.thinkingClass === "hybrid" && !rule.off) {
      errors.push(`${at}: hybrid 必有 off 声明`);
    }
    if (rule.thinkingClass !== "hybrid" && rule.off) {
      errors.push(`${at}: ${rule.thinkingClass} 不得有 off`);
    }
    if (rule.thinkingClass === "never" && (rule.on || rule.low || rule.high)) {
      errors.push(`${at}: never 无任何档位`);
    }
    // 同级冲突：on 是开关型 low/high 的唯一写点，与显式 low/high 同存即写点歧义。
    if (rule.on && (rule.low || rule.high)) {
      errors.push(`${at}: on 与 low/high 同级冲突（开关型 low/high 唯一写点是 on）`);
    }
    for (const key of LEVEL_KEYS) {
      checkPatchFields(`${at}.${key}`, rule[key], errors);
    }
    if (rule.tokenParam && !TOKEN_PARAMS.has(rule.tokenParam)) {
      errors.push(`${at}: tokenParam 只允许 max_tokens/max_completion_tokens`);
    }
  }

  const entryTables: [string, readonly TaxonomyEntry[]][] = [
    ["TAXONOMY", taxonomy],
    ["EXCEPTIONS", exceptions]
  ];
  for (const [tableName, entries] of entryTables) {
    entries.forEach((entry, index) => {
      if (!entry.patterns || entry.patterns.length === 0) {
        errors.push(`${tableName}[${index}]: patterns 不能为空`);
      }
      if (!classes[entry.class]) {
        errors.push(`${tableName}[${index}]: 引用的 class "${entry.class}" 不存在`);
      }
    });
  }

  for (const [id, rule] of Object.entries(providers)) {
    const at = `PROVIDERS.${id}`;
    if (rule.unknownClass && !classes[rule.unknownClass]) {
      errors.push(`${at}: unknownClass "${rule.unknownClass}" 不存在`);
    }
    if (rule.override) {
      if (!CLASS_FACTS.has(rule.override.thinkingClass)) {
        errors.push(`${at}: override.thinkingClass 必填，取值 always/hybrid/never`);
      }
      if (rule.override.thinkingClass === "hybrid" && !rule.override.levels.off) {
        errors.push(`${at}: override hybrid 必有 off 档`);
      }
      for (const patch of Object.values(rule.override.levels)) {
        checkPatchFields(`${at}.override`, patch, errors);
      }
    }
  }

  return errors;
}

function checkPatchFields(at: string, patch: ThinkingPatch | undefined, errors: string[]): void {
  for (const field of Object.keys(patch?.fields ?? {})) {
    if (!FIELD_WHITELIST.has(field)) {
      errors.push(`${at}: 字段 "${field}" 不在白名单（thinking/enable_thinking/reasoning_effort）`);
    }
  }
}
