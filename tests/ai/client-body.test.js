// ai/client.js 请求体构造测试：
// 验证 buildChatRequestBody 在思考档位 off 时不含 reasoning_effort，
// low/high 时映射为对应取值，非法档位回落到 off。

import { describe, expect, it } from "vitest";
import { buildChatRequestBody, normalizeThinkingLevel } from "../../extension/ai/client.js";

describe("buildChatRequestBody 思考档位", () => {
  it("off（默认）：不发送任何思考参数", () => {
    const body = buildChatRequestBody({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      thinkingLevel: "off"
    });
    expect(body).toEqual({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      stream: true
    });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("low / high：映射为 OpenAI 兼容的 reasoning_effort", () => {
    const base = { model: "test-model", messages: [] };
    expect(buildChatRequestBody({ ...base, thinkingLevel: "low" })).toMatchObject({
      reasoning_effort: "low"
    });
    expect(buildChatRequestBody({ ...base, thinkingLevel: "high" })).toMatchObject({
      reasoning_effort: "high"
    });
  });

  it("省略或非法档位：回落为 off，不发参数", () => {
    const base = { model: "test-model", messages: [] };
    expect(buildChatRequestBody({ ...base })).not.toHaveProperty("reasoning_effort");
    expect(buildChatRequestBody({ ...base, thinkingLevel: "medium" })).not.toHaveProperty("reasoning_effort");
  });
});

describe("normalizeThinkingLevel", () => {
  it("只接受 off/low/high，其余回落 off", () => {
    expect(normalizeThinkingLevel("off")).toBe("off");
    expect(normalizeThinkingLevel("low")).toBe("low");
    expect(normalizeThinkingLevel("high")).toBe("high");
    expect(normalizeThinkingLevel("medium")).toBe("off");
    expect(normalizeThinkingLevel(undefined)).toBe("off");
    expect(normalizeThinkingLevel(null)).toBe("off");
  });
});
