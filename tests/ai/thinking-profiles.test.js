// ai/thinking-profiles.js 思考参数表 + resolver 测试：
// 识别优先级（例外表 >> 模式表 >> provider.unknownClass >> UNKNOWN 哨兵）、
// off 级联（never 静默 / always·被阻断的 hybrid 落 low + offUnavailable / 无 low 不发）、
// offFallback 显式级联去向（03 号票 UI 长短版文案区分）、streamOnly 非流式阻断、
// baseUrl host 推断、presetId 参数位（02 票穿线预留）、tokenParam 随表返回
//（04 票消费）以及表校验器（Q2B）每条规则的正反用例。
// 平台×档位×代表模型→精确请求体的 golden 用例在 thinking-golden.test.js。

import { describe, expect, it } from "vitest";
import {
  CLASSES,
  TAXONOMY,
  EXCEPTIONS,
  PROVIDERS,
  resolveThinkingProfile,
  validateThinkingTables
} from "../../extension/ai/thinking-profiles.js";

// 与 core/presets.ts 的 AI preset baseUrl 一致（host 推断的输入形状）。
const OPENAI_URL = "https://api.openai.com/v1";
const DEEPSEEK_URL = "https://api.deepseek.com/v1";
const QWEN_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const KIMI_URL = "https://api.kimi.com/coding/v1";
const MIMO_URL = "https://api.mimo.ai/v1";
const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const MODELSCOPE_URL = "https://api-inference.modelscope.cn/v1";
const OLLAMA_URL = "http://localhost:11434/v1";
const SILICONFLOW_URL = "https://api.siliconflow.cn/v1";

const resolve = (overrides) => resolveThinkingProfile({ model: "m", level: "off", stream: false, ...overrides });

describe("识别优先级：例外表 >> 模式表 >> unknownClass >> UNKNOWN", () => {
  it("例外表压过模式表：qwen3.8-max 命中例外（effort 档），qwen3.8- 前缀其余模型走模式表开关", () => {
    expect(resolve({ baseUrl: QWEN_URL, model: "qwen3.8-max", level: "high" }).fields).toEqual({
      reasoning_effort: "xhigh"
    });
    expect(resolve({ baseUrl: QWEN_URL, model: "qwen3.8-plus", level: "high" }).fields).toEqual({
      enable_thinking: true
    });
  });

  it("模式表数组序=优先级：glm-5.2 条目先于 glm-5 前缀命中（effort 而非开关）", () => {
    expect(resolve({ baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.2", level: "high" }).fields).toEqual({
      reasoning_effort: "high"
    });
  });

  it("模式为前缀匹配：日期快照/变体后缀自然命中（gpt-5.1-2025-11-13 off → effort none）", () => {
    expect(resolve({ baseUrl: OPENAI_URL, model: "gpt-5.1-2025-11-13", level: "off" }).fields).toEqual({
      reasoning_effort: "none"
    });
  });

  it("模式内嵌 * 为两端锚定通配：qwen3-next-80b-a3b-thinking → 永远思考", () => {
    expect(resolve({ baseUrl: QWEN_URL, model: "qwen3-next-80b-a3b-thinking", level: "off" }).thinkingClass).toBe("always");
  });

  it("模型名大小写归一：MiniMax-M2 命中 minimax 模式表", () => {
    expect(resolve({ baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M2", level: "off" }).thinkingClass).toBe("always");
  });

  it("模式表压过 unknownClass：Ollama 上的 deepseek-r1:8b 按血统落永远思考，不吃平台 effort 兜底", () => {
    const r = resolve({ baseUrl: OLLAMA_URL, model: "deepseek-r1:8b", level: "off" });
    expect(r.thinkingClass).toBe("always");
    expect(r.fields).toEqual({});
  });

  it("unknownClass 兜底平台无关词汇：Ollama 未列模型走 effort 词汇（off=none）", () => {
    const r = resolve({ baseUrl: OLLAMA_URL, model: "llama3.2", level: "off" });
    expect(r.fields).toEqual({ reasoning_effort: "none" });
    expect(r.thinkingClass).toBe("hybrid");
  });

  it("无任何事实 → 显式 UNKNOWN 哨兵：三档均不发、offUnavailable=false（UI 无提示）", () => {
    for (const level of ["off", "low", "high"]) {
      expect(resolve({ baseUrl: "https://api.example.com/v1", model: "totally-unknown", level })).toEqual({
        fields: {},
        offUnavailable: false,
        offFallback: null,
        thinkingClass: "unknown"
      });
    }
  });

  it("模型名空串 → unknown（不发任何字段）", () => {
    expect(resolve({ baseUrl: DEEPSEEK_URL, model: "" })).toEqual({
      fields: {},
      offUnavailable: false,
      offFallback: null,
      thinkingClass: "unknown"
    });
  });
});

describe("off 级联（spec 最终版）", () => {
  it("never：off 不发且静默（offUnavailable=false，关思考已天然成立）", () => {
    const r = resolve({ baseUrl: DEEPSEEK_URL, model: "deepseek-chat", level: "off" });
    expect(r.fields).toEqual({});
    expect(r.offUnavailable).toBe(false);
    expect(r.thinkingClass).toBe("never");
  });

  it("always 无 low 档：off 不发但标记 offUnavailable（minimax 无档位参数）", () => {
    const r = resolve({ baseUrl: "https://api.minimaxi.com/v1", model: "minimax-m2", level: "off" });
    expect(r.fields).toEqual({});
    expect(r.offUnavailable).toBe(true);
    expect(r.thinkingClass).toBe("always");
  });

  it("always 有 low 档：off 落 low patch + offUnavailable（kimi-k3 → effort low）", () => {
    const r = resolve({ baseUrl: KIMI_URL, model: "kimi-k3", level: "off" });
    expect(r.fields).toEqual({ reasoning_effort: "low" });
    expect(r.offUnavailable).toBe(true);
  });

  it("hybrid off 声明存在时直接发（无级联、无标记）", () => {
    const r = resolve({ baseUrl: QWEN_URL, model: "qwen3-max", level: "off" });
    expect(r.fields).toEqual({ enable_thinking: false });
    expect(r.offUnavailable).toBe(false);
  });

  it("Q12C：low/high 缺档不 clamp、不发（kimi-k2.7-code 无档位）", () => {
    expect(resolve({ baseUrl: KIMI_URL, model: "kimi-k2.7-code", level: "low" }).fields).toEqual({});
    expect(resolve({ baseUrl: KIMI_URL, model: "kimi-k2.7-code", level: "high" }).fields).toEqual({});
  });
});

describe("offFallback：off 级联去向的显式字段（03 号票 UI 长短版文案区分）", () => {
  it("级联落 low：offFallback=\"low\"（kimi-k3 → effort low，UI 长版提示）", () => {
    expect(resolve({ baseUrl: KIMI_URL, model: "kimi-k3", level: "off" }).offFallback).toBe("low");
  });

  it("无 low 可落：offFallback=null 且 offUnavailable=true（minimax 无档位参数，UI 短版提示）", () => {
    const r = resolve({ baseUrl: "https://api.minimaxi.com/v1", model: "minimax-m2", level: "off" });
    expect(r.offUnavailable).toBe(true);
    expect(r.offFallback).toBe(null);
  });

  it("off 正常可用 / never 静默 / unknown：恒为 null（UI 均无提示）", () => {
    expect(resolve({ baseUrl: QWEN_URL, model: "qwen3-max", level: "off" }).offFallback).toBe(null);
    expect(resolve({ baseUrl: DEEPSEEK_URL, model: "deepseek-chat", level: "off" }).offFallback).toBe(null);
    expect(resolve({ baseUrl: "https://api.example.com/v1", model: "totally-unknown", level: "off" }).offFallback).toBe(null);
  });

  it("streamOnly 流式放行时无级联：offFallback=null（对话流式判定不误报，如 qwen3-235b）", () => {
    const r = resolve({ baseUrl: QWEN_URL, model: "qwen3-235b", level: "off", stream: true });
    expect(r.fields).toEqual({ enable_thinking: false });
    expect(r.offUnavailable).toBe(false);
    expect(r.offFallback).toBe(null);
  });
});

describe("纯 resolver 判定与 DOM 无关（工单 03 守护：后台路径不渲染提示）", () => {
  it("概览/解释/Map-Reduce 走同款级联判定也不触碰 DOM：resolve 前后文档无变化", () => {
    const bodyHtml = document.body.innerHTML;
    const elementCount = document.getElementsByTagName("*").length;

    // 后台路径（非流式）同款判定：级联标记照常返回，但不产生任何 DOM 副作用
    // ——提示渲染是对话 tab UI 层（reader/chat-tab.ts）的专属职责。
    const r = resolveThinkingProfile({ baseUrl: KIMI_URL, model: "kimi-k3", level: "off", stream: false });
    expect(r.offUnavailable).toBe(true);
    expect(r.offFallback).toBe("low");

    expect(document.body.innerHTML).toBe(bodyHtml);
    expect(document.getElementsByTagName("*").length).toBe(elementCount);
  });
});

describe("streamOnly（Q14A：流式限制规则遇非流式按无事实处理）", () => {
  it("流式：off 照发 enable_thinking:false", () => {
    const r = resolve({ baseUrl: QWEN_URL, model: "qwen3-32b", level: "off", stream: true });
    expect(r.fields).toEqual({ enable_thinking: false });
    expect(r.offUnavailable).toBe(false);
  });

  it("非流式：off 被阻断 → 级联落 low（开关型=on 写点）+ offUnavailable", () => {
    const r = resolve({ baseUrl: QWEN_URL, model: "qwen3-32b", level: "off", stream: false });
    expect(r.fields).toEqual({ enable_thinking: true });
    expect(r.offUnavailable).toBe(true);
    expect(r.thinkingClass).toBe("hybrid");
  });

  it("thinking-2507 变体不吃 streamOnly 前缀例外：qwen3-235b-a22b-thinking-2507 是永远思考（off 级联无 low 可落）", () => {
    const r = resolve({ baseUrl: QWEN_URL, model: "qwen3-235b-a22b-thinking-2507", level: "off", stream: false });
    expect(r.thinkingClass).toBe("always");
    expect(r.fields).toEqual({});
    expect(r.offUnavailable).toBe(true);
  });
});

describe("baseUrl host 推断（本票生效的 provider 识别路径）", () => {
  it("host 命中 AI preset → 平台词汇生效（mimo enable_thinking）", () => {
    expect(resolve({ baseUrl: MIMO_URL, model: "mimo-v2.5-pro", level: "off" }).fields).toEqual({
      enable_thinking: false
    });
  });

  it("SiliconFlow 无 AI preset（仅 ASR 登记同域名）→ host 别名命中 enable_thinking 词汇", () => {
    const r = resolve({ baseUrl: SILICONFLOW_URL, model: "deepseek-ai/DeepSeek-V4", level: "off" });
    expect(r.fields).toEqual({ enable_thinking: false });
    expect(r.thinkingClass).toBe("hybrid");
  });

  it("Opencode Go（api.doubao.com）域名已死不写 provider 规则：平台未列模型落 unknown", () => {
    expect(resolve({ baseUrl: "https://api.doubao.com/v1", model: "skylark-2-pro", level: "off" })).toEqual({
      fields: {},
      offUnavailable: false,
      offFallback: null,
      thinkingClass: "unknown"
    });
  });

  it("未知 host 等价于无 provider 规则（custom 平台指向陌生网关）", () => {
    expect(resolve({ baseUrl: "https://gateway.internal.example/v1", model: "vendor-model", level: "low" })).toEqual({
      fields: {},
      offUnavailable: false,
      offFallback: null,
      thinkingClass: "unknown"
    });
  });

  it("host 推断只看 hostname、不看路径与 scheme 大小写", () => {
    expect(resolve({ baseUrl: "HTTPS://API.DEEPSEEK.COM/v1", model: "deepseek-v4-pro", level: "off" }).fields).toEqual({
      thinking: { type: "disabled" }
    });
  });
});

describe("presetId 参数位（02 票穿线预留，本票仅 resolver 侧可用）", () => {
  it("presetId 命中 PROVIDERS：presetId 识别优先于 host", () => {
    const r = resolve({ presetId: "deepseek", baseUrl: "https://mirror.example.com/v1", model: "deepseek-v4-pro", level: "off" });
    expect(r.fields).toEqual({ thinking: { type: "disabled" } });
  });

  it("presetId 未命中（如 provider store 的记录 id）→ 回落 host 推断", () => {
    const r = resolve({ presetId: "rec_abc123", baseUrl: DEEPSEEK_URL, model: "deepseek-v4-pro", level: "off" });
    expect(r.fields).toEqual({ thinking: { type: "disabled" } });
  });
});

describe("provider override 型（OpenRouter 对任何模型整体替换 class 规则）", () => {
  it("已知血统模型也走 override（off→effort none，而非该血统的原生关闭字段）", () => {
    const r = resolve({ baseUrl: OPENROUTER_URL, model: "deepseek-v4-pro", level: "off" });
    expect(r.fields).toEqual({ reasoning_effort: "none" });
  });

  it("未列模型同样生效（override 无视 taxonomy/unknownClass）", () => {
    expect(resolve({ baseUrl: OPENROUTER_URL, model: "vendor/some-future-model", level: "low" }).fields).toEqual({
      reasoning_effort: "low"
    });
  });

  it("永不思考模型也被 override 覆盖（OpenRouter 透传上游，由上游解释）", () => {
    const r = resolve({ baseUrl: OPENROUTER_URL, model: "kimi-k2-instruct", level: "off" });
    expect(r.fields).toEqual({ reasoning_effort: "none" });
    expect(r.thinkingClass).toBe("hybrid");
  });
});

describe("tokenParam 随表返回（04 票消费；本票请求体仍用 max_tokens）", () => {
  it("openai-reasoning 系 → max_completion_tokens", () => {
    expect(resolve({ baseUrl: OPENAI_URL, model: "gpt-5.1", level: "low" }).tokenParam).toBe("max_completion_tokens");
    expect(resolve({ baseUrl: OPENAI_URL, model: "o3", level: "low" }).tokenParam).toBe("max_completion_tokens");
  });

  it("其余（含 unknown 与 OpenRouter override）不返回 tokenParam（默认 max_tokens 现状）", () => {
    expect(resolve({ baseUrl: DEEPSEEK_URL, model: "deepseek-v4-pro", level: "low" }).tokenParam).toBeUndefined();
    expect(resolve({ baseUrl: OPENROUTER_URL, model: "m", level: "low" }).tokenParam).toBeUndefined();
    expect(resolve({ baseUrl: "https://api.example.com/v1", model: "m", level: "low" }).tokenParam).toBeUndefined();
  });
});

// ===== 表校验器（Q2B：omp「编译器」角色的移植；工单 AC 第 6 条逐条用例）=====

// 深拷贝真实表供逐条注入违规（表数据全是 JSON 可序列化的纯结构）。
function tablesWith() {
  return {
    classes: JSON.parse(JSON.stringify(CLASSES)),
    taxonomy: JSON.parse(JSON.stringify(TAXONOMY)),
    exceptions: JSON.parse(JSON.stringify(EXCEPTIONS)),
    providers: JSON.parse(JSON.stringify(PROVIDERS))
  };
}

describe("表校验器（工单 AC 第 6 条）", () => {
  it("真实表自检通过（空错误列表）", () => {
    expect(validateThinkingTables()).toEqual([]);
  });

  it("fields 白名单：温度类字段报错，白名单字段放行", () => {
    const tables = tablesWith();
    tables.classes["deepseek-hybrid-effort"].off.fields.temperature = 0.6;
    const errors = validateThinkingTables(tables);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("temperature");
    expect(errors[0]).toContain("白名单");
  });

  it("thinkingClass 三态必填：缺失或非法值都报错", () => {
    const missing = tablesWith();
    delete missing.classes["minimax-always"].thinkingClass;
    expect(validateThinkingTables(missing)[0]).toContain("thinkingClass");

    const badValue = tablesWith();
    badValue.classes["minimax-always"].thinkingClass = "sometimes";
    expect(validateThinkingTables(badValue)[0]).toContain("thinkingClass");
  });

  it("hybrid 必有 off 声明", () => {
    const tables = tablesWith();
    delete tables.classes["qwen-hybrid-switch"].off;
    const errors = validateThinkingTables(tables);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("off");
  });

  it("always / never 不得有 off", () => {
    const always = tablesWith();
    always.classes["minimax-always"].off = { fields: { enable_thinking: false } };
    const errorsAlways = validateThinkingTables(always);
    expect(errorsAlways).toHaveLength(1);
    expect(errorsAlways[0]).toContain("off");

    const never = tablesWith();
    never.classes["deepseek-chat-never"].off = { fields: { enable_thinking: false } };
    expect(validateThinkingTables(never)).toHaveLength(1);
  });

  it("never 无任何档位（on/low/high 都不得有）", () => {
    const tables = tablesWith();
    tables.classes["deepseek-chat-never"].low = { fields: { reasoning_effort: "low" } };
    const errors = validateThinkingTables(tables);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("never");
  });

  it("taxonomy / 例外引用的 class 必须存在", () => {
    const taxonomy = tablesWith();
    taxonomy.taxonomy[0].class = "no-such-class";
    const errorsTaxonomy = validateThinkingTables(taxonomy);
    expect(errorsTaxonomy).toHaveLength(1);
    expect(errorsTaxonomy[0]).toContain("TAXONOMY");

    const exceptions = tablesWith();
    exceptions.exceptions[0].class = "no-such-class";
    const errorsExceptions = validateThinkingTables(exceptions);
    expect(errorsExceptions).toHaveLength(1);
    expect(errorsExceptions[0]).toContain("EXCEPTIONS");
  });

  it("同级冲突：on 与 low/high 同存报错（开关型 low/high 的写点歧义）", () => {
    const tables = tablesWith();
    tables.classes["qwen-hybrid-switch"].low = { fields: { reasoning_effort: "low" } };
    const errors = validateThinkingTables(tables);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("冲突");
  });

  it("provider.unknownClass 引用不存在的 class 报错", () => {
    const tables = tablesWith();
    tables.providers.ollama.unknownClass = "no-such-class";
    const errors = validateThinkingTables(tables);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("ollama");
  });

  it("tokenParam 只允许 max_tokens / max_completion_tokens", () => {
    const tables = tablesWith();
    tables.classes["openai-reasoning"].tokenParam = "completion_tokens";
    const errors = validateThinkingTables(tables);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("tokenParam");
  });
});
