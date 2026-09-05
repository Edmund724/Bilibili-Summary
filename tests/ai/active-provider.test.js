// ai/active-provider.js content 侧解析链测试（工单 02：presetId 穿线）。
// 消息链（get-settings → ai-providers-list → get-ai-provider-key）经 chrome
// stub 的 sendMessage 注入（callback 风格，沿 tests/setup.js 默认桩形状）。
// 断言解析结果的 provider 对象带回记录的 presetId（preset 词表键，非记录 id）：
// 这是概览 / 选区解释两条 content 链的平台识别主路径来源——baseUrl host 推断
// 退为兜底（custom 用户改过反代域名时识别不失效）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let activeProvider;

function stubMessages({ providers, defaultModel = "p1", keyOk = true } = {}) {
  globalThis.chrome.runtime.sendMessage.mockImplementation((message, callback) => {
    if (message?.type === "get-settings") {
      callback({ ok: true, settings: { defaultModel } });
    } else if (message?.type === "ai-providers-list") {
      callback({ ok: true, providers });
    } else if (message?.type === "get-ai-provider-key") {
      callback(keyOk ? { ok: true, apiKey: "sk-test" } : { ok: false, error: "读取失败" });
    } else {
      callback({ ok: true });
    }
    return undefined;
  });
}

beforeEach(async () => {
  resetModuleState();
  activeProvider = await import("../../extension/ai/active-provider.js");
});

describe("resolveActiveProvider presetId 穿线", () => {
  it("解析结果带回记录的 presetId（反代场景下是概览/解释链唯一的平台识别线索）", async () => {
    stubMessages({
      providers: [{
        id: "p1",
        presetId: "qwen",
        name: "反代百炼",
        baseUrl: "https://thinking-proxy.example.com/v1",
        model: "qwen3-max",
        enabled: true
      }]
    });

    const provider = await activeProvider.resolveActiveProvider();

    expect(provider).toEqual({
      baseUrl: "https://thinking-proxy.example.com/v1",
      apiKey: "sk-test",
      model: "qwen3-max",
      presetId: "qwen"
    });
  });

  it("旧消息形状无 presetId 字段 → 回传空串（resolver 端回落 host/模型名，不臆造平台）", async () => {
    stubMessages({
      providers: [{ id: "p1", name: "旧记录", baseUrl: "https://api.openai.com/v1", model: "gpt-5.1", enabled: true }]
    });

    const provider = await activeProvider.resolveActiveProvider();

    expect(provider.presetId).toBe("");
  });
});
