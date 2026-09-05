// ai/active-provider.ts content 侧解析测试（工单 02：presetId 穿线；arch-slim-3/09
// 单趟化随改）。解析走 resolve-ai-provider 合成消息单趟往返（策略与密钥校验
// 单源在 core/provider-handlers.ts 处理器），sendMessage 桩按新消息形状注入，
// 并断言「单趟」契约：全程恰一次 sendMessage。
// 断言解析结果的 provider 对象带回记录的 presetId（preset 词表键，非记录 id）：
// 这是概览 / 选区解释两条 content 链的平台识别主路径来源——baseUrl host 推断
// 退为兜底（custom 用户改过反代域名时识别不失效）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let activeProvider;

function stubMessages({ provider, apiKey = "sk-test", ok = true, error } = {}) {
  globalThis.chrome.runtime.sendMessage.mockImplementation((message, callback) => {
    if (message?.type === "resolve-ai-provider") {
      if (!ok) {
        callback({ ok: false, error });
      } else {
        callback({ ok: true, provider, apiKey });
      }
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

describe("resolveActiveProvider presetId 穿线（resolve-ai-provider 单趟）", () => {
  it("解析结果带回记录的 presetId（反代场景下是概览/解释链唯一的平台识别线索）", async () => {
    stubMessages({
      provider: {
        id: "p1",
        presetId: "qwen",
        name: "反代百炼",
        baseUrl: "https://thinking-proxy.example.com/v1",
        model: "qwen3-max",
        enabled: true,
        hasSavedKey: true
      }
    });

    const provider = await activeProvider.resolveActiveProvider();

    expect(provider).toEqual({
      baseUrl: "https://thinking-proxy.example.com/v1",
      apiKey: "sk-test",
      model: "qwen3-max",
      presetId: "qwen"
    });
  });

  it("旧记录无 presetId 字段 → 回传空串（resolver 端回落 host/模型名，不臆造平台）", async () => {
    stubMessages({
      provider: {
        id: "p1",
        name: "旧记录",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.1",
        enabled: true,
        hasSavedKey: true
      }
    });

    const provider = await activeProvider.resolveActiveProvider();

    expect(provider.presetId).toBe("");
  });

  it("单趟契约：解析全程恰一次 sendMessage（原三趟消息链收口防回焊）", async () => {
    stubMessages({
      provider: { id: "p1", name: "平台", baseUrl: "https://api.example.com/v1", model: "m1", enabled: true }
    });

    await activeProvider.resolveActiveProvider();

    expect(globalThis.chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(globalThis.chrome.runtime.sendMessage.mock.calls[0][0]).toEqual({
      type: "resolve-ai-provider"
    });
  });

  it("处理器回 ok:false → 错误文案原样上翻为异常", async () => {
    stubMessages({ ok: false, error: "还没有配置 AI 平台，请先在插件设置中添加并启用。" });

    await expect(activeProvider.resolveActiveProvider()).rejects.toThrow(
      "还没有配置 AI 平台，请先在插件设置中添加并启用。"
    );
  });
});
