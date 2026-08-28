// defaults.js / validators.js 纯函数归一化测试：
// aiThinkingLevel（思考档位）默认 off，非法值回落 off。

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { normalizeAiThinkingLevel } from "../../extension/core/validators.js";

describe("normalizeAiThinkingLevel", () => {
  it("off / low / high 原样保留", () => {
    expect(normalizeAiThinkingLevel("off")).toBe("off");
    expect(normalizeAiThinkingLevel("low")).toBe("low");
    expect(normalizeAiThinkingLevel("high")).toBe("high");
  });

  it("非法值（含未定义/空串）回落为 off", () => {
    expect(normalizeAiThinkingLevel("medium")).toBe("off");
    expect(normalizeAiThinkingLevel("")).toBe("off");
    expect(normalizeAiThinkingLevel(undefined)).toBe("off");
    expect(normalizeAiThinkingLevel(null)).toBe("off");
  });
});

describe("DEFAULT_SETTINGS.aiThinkingLevel", () => {
  it("默认值为 off", () => {
    expect(DEFAULT_SETTINGS.aiThinkingLevel).toBe("off");
  });
});
