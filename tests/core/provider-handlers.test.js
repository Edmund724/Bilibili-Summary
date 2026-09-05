// provider-handlers.js createProviderMessageHandlers 工厂测试。
// background.js 的 AI / ASR Provider 消息家族共用该工厂：验证标准处理器
// （list/get/save/remove）的响应负载契约、异步回包返回 true、同步失败回包
// 返回 false。（原 test 处理器与 probe/pickTestProvider 注入面的用例已随
// arch-slim-2/03 死能力退役一并删除：生产零注入，探针由 options 页直调
// ai/provider-test.js 与 asr/provider-test.js。）

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createProviderMessageHandlers, createAsrRuntimeConfigHandler } from "../../extension/core/provider-handlers.js";

// 捕获（可能异步的）sendResponse：回包即 resolve，测试 await response 即可
function makeChannel() {
  let resolveResponse;
  const response = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  const sendResponse = vi.fn((payload) => resolveResponse(payload));
  return { sendResponse, response };
}

function makeDeps(overrides = {}) {
  return {
    loadProviders: vi.fn(async () => [{ id: "p1", name: "P1", hasSavedKey: true }]),
    saveProviders: vi.fn(async (items) => items.map((p) => ({ ...p, hasSavedKey: false }))),
    deleteProvider: vi.fn(async () => [{ id: "p2", name: "P2", hasSavedKey: false }]),
    loadKeys: vi.fn(async () => ({ p1: "stored-key" })),
    ...overrides
  };
}

beforeEach(() => {
  resetModuleState();
});

describe("list / save / remove", () => {
  it("list 回包 { ok: true, providers }，异步路径返回 true", async () => {
    const deps = makeDeps();
    const handlers = createProviderMessageHandlers(deps);
    const { sendResponse, response } = makeChannel();

    expect(handlers.list({}, {}, sendResponse)).toBe(true);
    expect(await response).toEqual({
      ok: true,
      providers: [{ id: "p1", name: "P1", hasSavedKey: true }]
    });
    expect(deps.loadProviders).toHaveBeenCalledTimes(1);
  });

  it("save 把 message.providers 透传给 saveProviders，缺失时为空数组", async () => {
    const deps = makeDeps();
    const handlers = createProviderMessageHandlers(deps);

    const first = makeChannel();
    expect(handlers.save({ providers: [{ id: "p1" }] }, {}, first.sendResponse)).toBe(true);
    expect(await first.response).toEqual({ ok: true, providers: [{ id: "p1", hasSavedKey: false }] });
    expect(deps.saveProviders).toHaveBeenCalledWith([{ id: "p1" }]);

    const second = makeChannel();
    handlers.save({}, {}, second.sendResponse);
    expect(await second.response).toEqual({ ok: true, providers: [] });
    expect(deps.saveProviders).toHaveBeenLastCalledWith([]);
  });

  it("remove 透传 String(providerId)，回包 { ok: true, providers }", async () => {
    const deps = makeDeps();
    const handlers = createProviderMessageHandlers(deps);
    const { sendResponse, response } = makeChannel();

    expect(handlers.remove({ providerId: 42 }, {}, sendResponse)).toBe(true);
    expect(await response).toEqual({
      ok: true,
      providers: [{ id: "p2", name: "P2", hasSavedKey: false }]
    });
    expect(deps.deleteProvider).toHaveBeenCalledWith("42");
  });

  it("store 失败时回包 { ok: false, error }", async () => {
    const deps = makeDeps({
      loadProviders: vi.fn(async () => {
        throw new Error("storage down");
      })
    });
    const handlers = createProviderMessageHandlers(deps);
    const { sendResponse, response } = makeChannel();

    handlers.list({}, {}, sendResponse);
    expect(await response).toEqual({ ok: false, error: "storage down" });
  });
});

describe("get（读取已存 Key）", () => {
  it("回包 { ok: true, apiKey }（trim 后），异步路径返回 true", async () => {
    const deps = makeDeps({ loadKeys: vi.fn(async () => ({ p1: "  spaced  " })) });
    const handlers = createProviderMessageHandlers(deps);
    const { sendResponse, response } = makeChannel();

    expect(handlers.get({ providerId: " p1 " }, {}, sendResponse)).toBe(true);
    expect(await response).toEqual({ ok: true, apiKey: "spaced" });
  });

  it("未存 Key 的平台回空串", async () => {
    const deps = makeDeps();
    const handlers = createProviderMessageHandlers(deps);
    const { sendResponse, response } = makeChannel();

    handlers.get({ providerId: "nope" }, {}, sendResponse);
    expect(await response).toEqual({ ok: true, apiKey: "" });
  });

  it("缺 providerId 同步回包错误并返回 false，不读 Key 存储", () => {
    const deps = makeDeps();
    const handlers = createProviderMessageHandlers(deps);
    const { sendResponse } = makeChannel();

    expect(handlers.get({}, {}, sendResponse)).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "缺少 providerId" });
    expect(deps.loadKeys).not.toHaveBeenCalled();
  });
});

// ===== get-asr-runtime-config（内容脚本 ASR 回退的运行时配置 seam）=====

function makeRuntimeDeps(overrides = {}) {
  return {
    getMergedSettings: vi.fn(async () => ({
      activeAsrProviderId: " p1 ",
      asrLanguage: "auto",
      asrAutoFallback: true
    })),
    // provider 列表直读 provider-store（asrProviders 已摘出 settings）
    loadProviders: vi.fn(async () => [
      { id: "p1", type: "openai-transcriptions", name: "本地 Whisper", model: "whisper-large-v3" }
    ]),
    getAsrProviderKey: vi.fn(async () => "sk-local"),
    ...overrides
  };
}

describe("get-asr-runtime-config（createAsrRuntimeConfigHandler）", () => {
  it("回包一致快照：providers 无 Key，仅激活平台附 activeKey，异步路径返回 true", async () => {
    const deps = makeRuntimeDeps();
    const handler = createAsrRuntimeConfigHandler(deps);
    const { sendResponse, response } = makeChannel();

    expect(handler({}, {}, sendResponse)).toBe(true);
    expect(await response).toEqual({
      ok: true,
      providers: [{ id: "p1", type: "openai-transcriptions", name: "本地 Whisper", model: "whisper-large-v3" }],
      activeAsrProviderId: "p1",
      activeKey: "sk-local",
      asrLanguage: "auto",
      asrAutoFallback: true
    });
    // 列表直读 provider-store；Key 单查只针对激活平台 id（trim 后）
    expect(deps.loadProviders).toHaveBeenCalledTimes(1);
    expect(deps.getAsrProviderKey).toHaveBeenCalledTimes(1);
    expect(deps.getAsrProviderKey).toHaveBeenCalledWith("p1");
  });

  it("无激活平台时不读 Key 存储，activeKey 为空串", async () => {
    const deps = makeRuntimeDeps({
      getMergedSettings: vi.fn(async () => ({
        activeAsrProviderId: "",
        asrLanguage: "zh",
        asrAutoFallback: false
      })),
      loadProviders: vi.fn(async () => [])
    });
    const handler = createAsrRuntimeConfigHandler(deps);
    const { sendResponse, response } = makeChannel();

    handler({}, {}, sendResponse);
    expect(await response).toEqual({
      ok: true,
      providers: [],
      activeAsrProviderId: "",
      activeKey: "",
      asrLanguage: "zh",
      asrAutoFallback: false
    });
    expect(deps.getAsrProviderKey).not.toHaveBeenCalled();
  });

  it("settings 读取失败回包 { ok: false, error }", async () => {
    const deps = makeRuntimeDeps({
      getMergedSettings: vi.fn(async () => {
        throw new Error("storage timeout");
      })
    });
    const handler = createAsrRuntimeConfigHandler(deps);
    const { sendResponse, response } = makeChannel();

    handler({}, {}, sendResponse);
    expect(await response).toEqual({ ok: false, error: "storage timeout" });
    expect(deps.getAsrProviderKey).not.toHaveBeenCalled();
  });
});

// ===== 「激活平台」单趟解析处理器（arch-slim-3/09）=====

import { createAiResolvedProviderHandler } from "../../extension/core/provider-handlers.js";

function makeResolvedDeps(overrides = {}) {
  return {
    getMergedSettings: vi.fn(async () => ({ defaultModel: "p1" })),
    loadProviders: vi.fn(async () => [
      { id: "p1", name: "P1", model: "m1", enabled: true, hasSavedKey: true },
      { id: "p2", name: "P2", model: "m2", enabled: true, hasSavedKey: true }
    ]),
    loadKeys: vi.fn(async () => ({ p1: "key-p1", p2: "key-p2" })),
    ...overrides
  };
}

describe("createAiResolvedProviderHandler（resolve-ai-provider 单趟解析）", () => {
  it("providerId 精确匹配档：带 id 查找并回 provider 记录 + apiKey，不读 settings", async () => {
    const deps = makeResolvedDeps();
    const handler = createAiResolvedProviderHandler(deps);
    const { sendResponse, response } = makeChannel();

    expect(handler({ providerId: "p2" }, {}, sendResponse)).toBe(true);
    expect(await response).toEqual({
      ok: true,
      provider: { id: "p2", name: "P2", model: "m2", enabled: true, hasSavedKey: true },
      apiKey: "key-p2"
    });
    expect(deps.getMergedSettings).not.toHaveBeenCalled();
  });

  it("providerId 精确匹配落空 → { ok: false, error: 未找到选中的平台 }", async () => {
    const deps = makeResolvedDeps();
    const handler = createAiResolvedProviderHandler(deps);
    const { sendResponse, response } = makeChannel();

    handler({ providerId: "nope" }, {}, sendResponse);
    expect(await response).toEqual({ ok: false, error: "未找到选中的平台" });
  });

  it("缺省档：defaultModel 优先，无命中回落首个启用平台", async () => {
    const deps = makeResolvedDeps({
      getMergedSettings: vi.fn(async () => ({ defaultModel: "p2" }))
    });
    const handler = createAiResolvedProviderHandler(deps);
    const { sendResponse, response } = makeChannel();

    handler({}, {}, sendResponse);
    expect((await response).provider.id).toBe("p2");

    const fallbackDeps = makeResolvedDeps({
      getMergedSettings: vi.fn(async () => ({ defaultModel: "ghost" }))
    });
    const fallbackHandler = createAiResolvedProviderHandler(fallbackDeps);
    const fallbackChannel = makeChannel();
    fallbackHandler({}, {}, fallbackChannel.sendResponse);
    expect((await fallbackChannel.response).provider.id).toBe("p1");
  });

  it("无启用平台 → { ok: false, error: NO_ACTIVE_PROVIDER_MESSAGE }", async () => {
    const deps = makeResolvedDeps({ loadProviders: vi.fn(async () => []) });
    const handler = createAiResolvedProviderHandler(deps);
    const { sendResponse, response } = makeChannel();

    handler({}, {}, sendResponse);
    expect(await response).toEqual({
      ok: false,
      error: "还没有配置 AI 平台，请先在插件设置中添加并启用。"
    });
  });

  it("requiresKey !== false 且密钥缺失 → 解析期拒绝（content 侧统一收紧）", async () => {
    const deps = makeResolvedDeps({ loadKeys: vi.fn(async () => ({ p2: "key-p2" })) });
    const handler = createAiResolvedProviderHandler(deps);
    const { sendResponse, response } = makeChannel();

    handler({ providerId: "p1" }, {}, sendResponse);
    expect(await response).toEqual({ ok: false, error: "该平台 API Key 未配置" });
  });

  it("requiresKey === false 平台密钥缺失照常放行（本地端点）", async () => {
    const deps = makeResolvedDeps({
      loadProviders: vi.fn(async () => [
        { id: "local", name: "Ollama", model: "llama3.2", enabled: true, requiresKey: false, hasSavedKey: false }
      ]),
      loadKeys: vi.fn(async () => ({}))
    });
    const handler = createAiResolvedProviderHandler(deps);
    const { sendResponse, response } = makeChannel();

    handler({ providerId: "local" }, {}, sendResponse);
    const payload = await response;
    expect(payload.ok).toBe(true);
    expect(payload.apiKey).toBe("");
  });

  it("disabled 平台不参与解析（精确匹配与回落均跳过）", async () => {
    const deps = makeResolvedDeps({
      loadProviders: vi.fn(async () => [
        { id: "p1", name: "P1", model: "m1", enabled: false, hasSavedKey: true }
      ])
    });
    const handler = createAiResolvedProviderHandler(deps);

    const exact = makeChannel();
    handler({ providerId: "p1" }, {}, exact.sendResponse);
    expect(await exact.response).toEqual({ ok: false, error: "未找到选中的平台" });

    const fallback = makeChannel();
    handler({}, {}, fallback.sendResponse);
    expect(await fallback.response).toEqual({
      ok: false,
      error: "还没有配置 AI 平台，请先在插件设置中添加并启用。"
    });
  });
});
