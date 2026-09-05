// 思考参数 golden 测试：13 平台 × {off,low,high} × 代表模型 → 精确请求体。
// 代表模型按矩阵报告（.scratch/reports/model-thinking-matrix-20260905.md）各平台
// 实际有的模型选：混合（可开关） / 永远思考 / 永不思考各至少一；平台没有某血统时
// 用「未列模型」代位断言三档不发（unknown 哨兵）并注明。字段名与值全断言；
// offUnavailable 标记的语义断言在 thinking-profiles.test.js（请求体不携带该标记）。

import { describe, expect, it } from "vitest";
import { buildChatRequestBody } from "../../extension/ai/completion.js";

const MESSAGES = [{ role: "user", content: "hi" }];

// 走请求构造单缝（buildChatRequestBody）：host 推断即由 baseUrl 承载；
// presetId（provider 记录的 presetId，02 号票穿线）是识别主路径，不传即回落
// host 推断（上面的平台矩阵 golden 均为 host 路径，锁定 01 行为）。
function bodyFor({ baseUrl, presetId, model, level, stream = false, maxTokens }) {
  return buildChatRequestBody({ model, messages: MESSAGES, stream, thinkingLevel: level, baseUrl, presetId, maxTokens });
}

// 每个平台的代表模型与三档期望字段（{} = 不发任何思考字段）。
const PLATFORMS = [
  {
    name: "OpenAI（api.openai.com，严格 400）",
    baseUrl: "https://api.openai.com/v1",
    cases: [
      {
        kind: "混合（例外表：5.1/5.2 off=effort none）",
        model: "gpt-5.1",
        off: { reasoning_effort: "none" },
        low: { reasoning_effort: "low" },
        high: { reasoning_effort: "high" }
      },
      {
        kind: "永远思考（o3/o4/gpt-6 无 none；gpt-5.0 同类——off 级联落 low）",
        model: "o3",
        off: { reasoning_effort: "low" },
        low: { reasoning_effort: "low" },
        high: { reasoning_effort: "high" }
      },
      {
        kind: "矩阵未列模型（gpt-4o 不在 taxonomy → unknown 三档不发；平台无永不思考代表）",
        model: "gpt-4o",
        off: {},
        low: {},
        high: {}
      }
    ]
  },
  {
    name: "DeepSeek（api.deepseek.com）",
    baseUrl: "https://api.deepseek.com/v1",
    cases: [
      {
        kind: "混合（off=thinking 开关，low/high=effort）",
        model: "deepseek-v4-pro",
        off: { thinking: { type: "disabled" } },
        low: { reasoning_effort: "low" },
        high: { reasoning_effort: "high" }
      },
      {
        kind: "永远思考（reasoner 无档位；off 级联无 low 可落 → 不发 + offUnavailable）",
        model: "deepseek-reasoner",
        off: {},
        low: {},
        high: {}
      },
      {
        kind: "永不思考（deepseek-chat off 静默）",
        model: "deepseek-chat",
        off: {},
        low: {},
        high: {}
      }
    ]
  },
  {
    name: "Qwen/百炼（dashscope.aliyuncs.com）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    cases: [
      {
        kind: "混合开关（qwen3-max/plus/flash/turbo 默认关）",
        model: "qwen3-max",
        off: { enable_thinking: false },
        low: { enable_thinking: true },
        high: { enable_thinking: true }
      },
      {
        kind: "混合 effort（例外表 qwen3.8-max：high→xhigh）",
        model: "qwen3.8-max",
        off: { enable_thinking: false },
        low: { reasoning_effort: "low" },
        high: { reasoning_effort: "xhigh" }
      },
      {
        kind: "永远思考（thinking 系/qwq 无档位）",
        model: "qwen3-next-80b-a3b-thinking",
        off: {},
        low: {},
        high: {}
      },
      {
        kind: "矩阵未列模型（qwen2.5 → unknown 三档不发；百炼无永不思考代表）",
        model: "qwen2.5-72b-instruct",
        off: {},
        low: {},
        high: {}
      }
    ]
  },
  {
    name: "GLM 智谱（open.bigmodel.cn）",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    cases: [
      {
        kind: "混合开关（glm-4.5~5.1）",
        model: "glm-4.6",
        off: { thinking: { type: "disabled" } },
        low: { thinking: { type: "enabled" } },
        high: { thinking: { type: "enabled" } }
      },
      {
        kind: "混合三档（glm-5.2 起 effort）",
        model: "glm-5.2",
        off: { thinking: { type: "disabled" } },
        low: { reasoning_effort: "low" },
        high: { reasoning_effort: "high" }
      },
      {
        kind: "永远思考（glm-5.3 disabled 直接报错；无档位 → off 不发 + offUnavailable）",
        model: "glm-5.3",
        off: {},
        low: {},
        high: {}
      }
    ]
  },
  {
    name: "Kimi For Coding（api.kimi.com）",
    baseUrl: "https://api.kimi.com/coding/v1",
    cases: [
      {
        kind: "混合开关（kimi-k2.5/k2.6）",
        model: "kimi-k2.6",
        off: { thinking: { type: "disabled" } },
        low: { thinking: { type: "enabled" } },
        high: { thinking: { type: "enabled" } }
      },
      {
        kind: "永远思考 + effort（kimi-k3；off 级联落 low）",
        model: "kimi-k3",
        off: { reasoning_effort: "low" },
        low: { reasoning_effort: "low" },
        high: { reasoning_effort: "high" }
      },
      {
        kind: "永远思考（kimi-k2.7 强制 keep:all，无档位 → off 不发 + offUnavailable）",
        model: "kimi-k2.7-code",
        off: {},
        low: {},
        high: {}
      },
      {
        kind: "永不思考（kimi-k2 instruct 系）",
        model: "kimi-k2-instruct",
        off: {},
        low: {},
        high: {}
      }
    ]
  },
  {
    name: "MiniMax（api.minimaxi.com，M1~M3 永远思考无开关）",
    baseUrl: "https://api.minimaxi.com/v1",
    cases: [
      {
        kind: "永远思考（无开关无档位；off 级联无 low 可落 → 不发 + offUnavailable）",
        model: "MiniMax-M2",
        off: {},
        low: {},
        high: {}
      },
      {
        kind: "矩阵未列模型（unknown 三档不发；平台无混合/永不代表）",
        model: "abab6.5s-chat",
        off: {},
        low: {},
        high: {}
      }
    ]
  },
  {
    name: "Mimo 小米（api.mimo.ai）",
    baseUrl: "https://api.mimo.ai/v1",
    cases: [
      {
        kind: "混合开关（mimo-v2.5-pro / mimo-v2-flash）",
        model: "mimo-v2.5-pro",
        off: { enable_thinking: false },
        low: { enable_thinking: true },
        high: { enable_thinking: true }
      },
      {
        kind: "unknownClass 兜底（Mimo 词汇平台无关：未列模型也吃 enable_thinking）",
        model: "mimo-7b",
        off: { enable_thinking: false },
        low: { enable_thinking: true },
        high: { enable_thinking: true }
      }
    ]
  },
  {
    name: "Opencode Go（api.doubao.com，域名已死：不写 provider 规则）",
    baseUrl: "https://api.doubao.com/v1",
    cases: [
      {
        kind: "模式表命中（doubao-seed 混合开关——平台无规则但模型血统仍识别；域名本身 NXDOMAIN）",
        model: "doubao-seed-1.6",
        off: { thinking: { type: "disabled" } },
        low: { thinking: { type: "enabled" } },
        high: { thinking: { type: "enabled" } }
      },
      {
        kind: "平台未列模型（unknown 三档不发）",
        model: "skylark-2-pro",
        off: {},
        low: {},
        high: {}
      }
    ]
  },
  {
    name: "OpenRouter（openrouter.ai，override 对任何模型整体替换）",
    baseUrl: "https://openrouter.ai/api/v1",
    cases: [
      {
        kind: "已知血统模型也走 override（off=effort none 而非原生关闭字段）",
        model: "deepseek-v4-pro",
        off: { reasoning_effort: "none" },
        low: { reasoning_effort: "low" },
        high: { reasoning_effort: "high" }
      },
      {
        kind: "未列模型同样生效（override 无视 taxonomy/unknownClass）",
        model: "vendor/some-future-model",
        off: { reasoning_effort: "none" },
        low: { reasoning_effort: "low" },
        high: { reasoning_effort: "high" }
      }
    ]
  },
  {
    name: "StepFun（api.stepfun.com step_plan）",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
    cases: [
      {
        kind: "永远思考 + effort（step-3.7 三档；off 级联落 low）",
        model: "step-3.7-flash",
        off: { reasoning_effort: "low" },
        low: { reasoning_effort: "low" },
        high: { reasoning_effort: "high" }
      },
      {
        kind: "永远思考（step-3/3.5 无档位参数 → off 不发 + offUnavailable）",
        model: "step-3",
        off: {},
        low: {},
        high: {}
      },
      {
        kind: "矩阵未列模型（unknown 三档不发）",
        model: "step-2-16k",
        off: {},
        low: {},
        high: {}
      }
    ]
  },
  {
    name: "ModelScope（api-inference.modelscope.cn，unknownClass=enable_thinking）",
    baseUrl: "https://api-inference.modelscope.cn/v1",
    cases: [
      {
        kind: "混合开关（裸 id 命中模式表；非流式 off 被 streamOnly 阻断 → 级联落 on）",
        model: "qwen3-32b",
        off: { enable_thinking: true },
        low: { enable_thinking: true },
        high: { enable_thinking: true }
      },
      {
        kind: "org 限定 id 不命中模式表 → unknownClass 兜底（enable_thinking 词汇照发）",
        model: "Qwen/Qwen3-32B",
        off: { enable_thinking: false },
        low: { enable_thinking: true },
        high: { enable_thinking: true }
      },
      {
        kind: "org 限定 id（unknownClass 兜底；平台无永不思考代表）",
        model: "deepseek-ai/DeepSeek-V4",
        off: { enable_thinking: false },
        low: { enable_thinking: true },
        high: { enable_thinking: true }
      }
    ]
  },
  {
    name: "Ollama（localhost:11434，unknownClass=effort 词汇）",
    baseUrl: "http://localhost:11434/v1",
    cases: [
      {
        kind: "unknownClass 兜底（未列模型 effort 词汇：off=none）",
        model: "llama3.2",
        off: { reasoning_effort: "none" },
        low: { reasoning_effort: "low" },
        high: { reasoning_effort: "high" }
      },
      {
        kind: "模式表命中（deepseek-r1 永远思考无档位；off 级联无 low 可落 → 不发）",
        model: "deepseek-r1:8b",
        off: {},
        low: {},
        high: {}
      },
      {
        kind: "unknownClass 兜底（另一血统 gpt-oss 同吃 effort 词汇）",
        model: "gpt-oss:20b",
        off: { reasoning_effort: "none" },
        low: { reasoning_effort: "low" },
        high: { reasoning_effort: "high" }
      }
    ]
  },
  {
    name: "SiliconFlow（api.siliconflow.cn，无 AI preset：host 别名识别，unknownClass=enable_thinking）",
    baseUrl: "https://api.siliconflow.cn/v1",
    cases: [
      {
        kind: "org 限定 id → unknownClass 兜底（enable_thinking 词汇）",
        model: "deepseek-ai/DeepSeek-V4",
        off: { enable_thinking: false },
        low: { enable_thinking: true },
        high: { enable_thinking: true }
      },
      {
        kind: "裸 id 命中模式表（qwen3 混合开关）",
        model: "qwen3-max",
        off: { enable_thinking: false },
        low: { enable_thinking: true },
        high: { enable_thinking: true }
      },
      {
        kind: "org 限定 id（unknownClass 兜底；平台无永不思考代表）",
        model: "Qwen/Qwen2.5-72B-Instruct",
        off: { enable_thinking: false },
        low: { enable_thinking: true },
        high: { enable_thinking: true }
      }
    ]
  }
];

for (const platform of PLATFORMS) {
  describe(`golden：${platform.name}`, () => {
    for (const c of platform.cases) {
      for (const level of ["off", "low", "high"]) {
        it(`${c.model}（${c.kind}）· ${level}`, () => {
          expect(bodyFor({ baseUrl: platform.baseUrl, model: c.model, level })).toEqual({
            model: c.model,
            messages: MESSAGES,
            stream: false,
            ...c[level]
          });
        });
      }
    }
  });
}

// ===== presetId 穿线（02 号票）=====
// 识别三层：presetId 为主 → baseUrl host 表兜底 → 模型名。provider 记录的
// presetId 从解析链穿到请求构造后，custom 用户改过反代 baseUrl（host 表查不到）
// 平台识别也不失效；旧记录（无 presetId，normalize 落 "custom"）回落 host/模型
// 名识别，与 01 落地行为完全一致。
describe("golden：presetId 穿线（presetId 为主，host 表兜底）", () => {
  // host 表查不到的陌生反代域名：host 推断无规则，唯一识别线索是 presetId
  const PROXY = "https://thinking-proxy.example.com/v1";

  it("presetId 与 host 推断冲突时 presetId 赢：host 命中 Mimo（enable_thinking 族）但记录是 ollama → effort 词汇", () => {
    // baseUrl 指向 Mimo 官方域：host 推断本会落 mimo unknownClass（enable_thinking）；
    // presetId 主路径生效则整体改按 ollama 规则（reasoning_effort），字段族切换是
    // 「谁赢」的可观测判据
    expect(bodyFor({ baseUrl: "https://api.mimo.ai/v1", presetId: "ollama", model: "llama3.2", level: "off" })).toEqual({
      model: "llama3.2",
      messages: MESSAGES,
      stream: false,
      reasoning_effort: "none"
    });
    // 工单 golden 原例：陌生反代 + presetId="qwen" → 按 qwen 规则出 enable_thinking 族
    expect(bodyFor({ baseUrl: PROXY, presetId: "qwen", model: "qwen3-max", level: "off" })).toEqual({
      model: "qwen3-max",
      messages: MESSAGES,
      stream: false,
      enable_thinking: false
    });
    expect(bodyFor({ baseUrl: PROXY, presetId: "qwen", model: "qwen3-max", level: "high" })).toEqual({
      model: "qwen3-max",
      messages: MESSAGES,
      stream: false,
      enable_thinking: true
    });
  });

  it("custom + presetId='custom' → 回落 host 兜底：Mimo host 的 unknownClass 对未列模型生效", () => {
    // mimo-7b 不在模式表：host 查不到就落 unknown（不发），查到（兜底生效）则发
    expect(bodyFor({ baseUrl: "https://api.mimo.ai/v1", presetId: "custom", model: "mimo-7b", level: "off" })).toEqual({
      model: "mimo-7b",
      messages: MESSAGES,
      stream: false,
      enable_thinking: false
    });
  });

  it("custom + 陌生反代 → 回落模型名识别（taxonomy 命中 DeepSeek 规则）", () => {
    expect(bodyFor({ baseUrl: PROXY, presetId: "custom", model: "deepseek-v4-pro", level: "off" })).toEqual({
      model: "deepseek-v4-pro",
      messages: MESSAGES,
      stream: false,
      thinking: { type: "disabled" }
    });
  });

  it("custom + 陌生反代 + 未列模型 → unknown 哨兵三档不发（软失败优于硬 400）", () => {
    for (const level of ["off", "low", "high"]) {
      expect(bodyFor({ baseUrl: PROXY, presetId: "custom", model: "vendor-future-1", level })).toEqual({
        model: "vendor-future-1",
        messages: MESSAGES,
        stream: false
      });
    }
  });

  it("旧记录无 presetId：host 推断照常生效，行为与 01 落地一致（golden 锁定）", () => {
    expect(bodyFor({ baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3-max", level: "off" })).toEqual({
      model: "qwen3-max",
      messages: MESSAGES,
      stream: false,
      enable_thinking: false
    });
    // host 也查不到（陌生反代 + 无 presetId）+ 模式表未列模型（qwen2.5）→
    // 与 01 一致：unknown 哨兵，不发任何思考字段
    expect(bodyFor({ baseUrl: PROXY, model: "qwen2.5-72b-instruct", level: "off" })).toEqual({
      model: "qwen2.5-72b-instruct",
      messages: MESSAGES,
      stream: false
    });
  });
});

// streamOnly 的请求体形态：流式照发 / 非流式被阻断走级联（offUnavailable 标记
// 在 resolver 单测断言）。
describe("golden：streamOnly（qwen3-235b/32b/30b 仅流式可关）", () => {
  it("qwen3-32b 流式 off：照发 enable_thinking:false", () => {
    expect(bodyFor({ baseUrl: PLATFORMS[2].baseUrl, model: "qwen3-32b", level: "off", stream: true })).toEqual({
      model: "qwen3-32b",
      messages: MESSAGES,
      stream: true,
      enable_thinking: false
    });
  });

  it("qwen3-32b 非流式 off：被阻断 → 级联落 low（开关型=on 写点 enable_thinking:true）", () => {
    expect(bodyFor({ baseUrl: PLATFORMS[2].baseUrl, model: "qwen3-32b", level: "off", stream: false })).toEqual({
      model: "qwen3-32b",
      messages: MESSAGES,
      stream: false,
      enable_thinking: true
    });
  });
});
