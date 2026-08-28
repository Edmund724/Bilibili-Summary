// provider-handlers.js createProviderMessageHandlers 工厂测试。
// background.js 的 AI / ASR Provider 消息家族共用该工厂：验证标准处理器
// （list/get/save/remove/test/setKey）的响应负载契约、异步回包返回 true、
// 同步失败回包返回 false，以及 test 对探针输入的装配（Key 优先取消息
// 直带值，否则按 providerId 读已存 Key）。用 fake deps 驱动，不碰
// chrome.storage。

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
    saveKey: vi.fn(async () => {}),
    probe: vi.fn(async () => ({ ok: true })),
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

describe("setKey（注入 saveKey 时才存在）", () => {
  it("透传 (providerId, apiKey) 并回包 { ok: true }", async () => {
    const deps = makeDeps();
    const handlers = createProviderMessageHandlers(deps);
    const { sendResponse, response } = makeChannel();

    expect(typeof handlers.setKey).toBe("function");
    expect(handlers.setKey({ providerId: "p1", apiKey: " new-key " }, {}, sendResponse)).toBe(true);
    expect(await response).toEqual({ ok: true });
    expect(deps.saveKey).toHaveBeenCalledWith("p1", " new-key ");
  });

  it("未注入 saveKey 的家族（ASR 形状）不带 setKey 处理器", () => {
    const { saveKey: _omit, ...rest } = makeDeps();
    const handlers = createProviderMessageHandlers(rest);
    expect(handlers.setKey).toBeUndefined();
    expect(Object.keys(handlers).sort()).toEqual(["get", "list", "remove", "save", "test"]);
  });
});

describe("test（平铺字段装配，AI 家族缺省路径）", () => {
  it("直带 apiKey 时 trim 后作为探针 Key，探针负载原样转发", async () => {
    const deps = makeDeps({ probe: vi.fn(async () => ({ ok: false, error: "HTTP 401" })) });
    const handlers = createProviderMessageHandlers(deps);
    const { sendResponse, response } = makeChannel();

    expect(
      handlers.test(
        { providerId: "p1", baseUrl: " https://api.example.com/ ", apiKey: " direct-key ", model: " gpt " },
        {},
        sendResponse
      )
    ).toBe(true);
    expect(await response).toEqual({ ok: false, error: "HTTP 401" });
    // 直带 Key 优先，不读已存 Key
    expect(deps.probe).toHaveBeenCalledWith({
      baseUrl: "https://api.example.com/",
      apiKey: "direct-key",
      model: "gpt"
    });
    expect(deps.loadKeys).not.toHaveBeenCalled();
  });

  it("无直带 Key 时按 providerId 从 loadKeys 代查（Key 随装配结果一起交给探针）", async () => {
    const deps = makeDeps();
    const handlers = createProviderMessageHandlers(deps);
    const { sendResponse, response } = makeChannel();

    handlers.test({ providerId: "p1", baseUrl: "https://api.example.com", model: "m1" }, {}, sendResponse);
    expect(await response).toEqual({ ok: true });
    expect(deps.probe).toHaveBeenCalledWith({
      baseUrl: "https://api.example.com",
      apiKey: "stored-key",
      model: "m1"
    });
  });

  it("无 providerId 也无直带 Key 时空串 Key 交给探针", async () => {
    const deps = makeDeps();
    const handlers = createProviderMessageHandlers(deps);
    const { sendResponse, response } = makeChannel();

    handlers.test({ baseUrl: "https://api.example.com", model: "m1" }, {}, sendResponse);
    expect(await response).toEqual({ ok: true });
    expect(deps.probe).toHaveBeenCalledWith({ baseUrl: "https://api.example.com", apiKey: "", model: "m1" });
    expect(deps.loadKeys).not.toHaveBeenCalled();
  });

  it("缺 baseUrl 同步回包 { ok: false, error: '请填写 baseUrl' } 并返回 false，不调探针", () => {
    const deps = makeDeps();
    const handlers = createProviderMessageHandlers(deps);
    const { sendResponse } = makeChannel();

    expect(handlers.test({ model: "m1" }, {}, sendResponse)).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "请填写 baseUrl" });
    expect(deps.probe).not.toHaveBeenCalled();
  });

  it("Key 读取失败时回包 { ok: false, error }", async () => {
    const deps = makeDeps({
      loadKeys: vi.fn(async () => {
        throw new Error("storage down");
      })
    });
    const handlers = createProviderMessageHandlers(deps);
    const { sendResponse, response } = makeChannel();

    handlers.test({ providerId: "p1", baseUrl: "https://api.example.com", model: "m1" }, {}, sendResponse);
    expect(await response).toEqual({ ok: false, error: "storage down" });
    expect(deps.probe).not.toHaveBeenCalled();
  });
});

describe("test（嵌套 provider 装配，ASR 家族覆写）", () => {
  it("把 message.provider 原样交给探针，不做字段校验、缺省为空对象", async () => {
    const deps = makeDeps();
    const handlers = createProviderMessageHandlers({
      ...deps,
      pickTestProvider: (message) => ({ provider: message.provider || {} })
    });

    const provider = { id: "p1", type: "openai-transcriptions", baseUrl: "https://x", model: "whisper" };
    const withProvider = makeChannel();
    expect(handlers.test({ provider }, {}, withProvider.sendResponse)).toBe(true);
    expect(await withProvider.response).toEqual({ ok: true });
    expect(deps.probe).toHaveBeenCalledWith(provider);
    expect(deps.loadKeys).not.toHaveBeenCalled();

    const withoutProvider = makeChannel();
    expect(handlers.test({}, {}, withoutProvider.sendResponse)).toBe(true);
    expect(await withoutProvider.response).toEqual({ ok: true });
    expect(deps.probe).toHaveBeenLastCalledWith({});
  });
});

// ===== get-asr-runtime-config（内容脚本 ASR 回退的运行时配置 seam）=====

function makeRuntimeDeps(overrides = {}) {
  return {
    getMergedSettings: vi.fn(async () => ({
      asrProviders: [{ id: "p1", type: "openai-transcriptions", name: "本地 Whisper", model: "whisper-large-v3" }],
      activeAsrProviderId: " p1 ",
      asrLanguage: "auto",
      asrAutoFallback: true
    })),
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
    // Key 单查只针对激活平台 id（trim 后），列表不附带任何 Key 材料
    expect(deps.getAsrProviderKey).toHaveBeenCalledTimes(1);
    expect(deps.getAsrProviderKey).toHaveBeenCalledWith("p1");
  });

  it("无激活平台时不读 Key 存储，activeKey 为空串", async () => {
    const deps = makeRuntimeDeps({
      getMergedSettings: vi.fn(async () => ({
        asrProviders: [],
        activeAsrProviderId: "",
        asrLanguage: "zh",
        asrAutoFallback: false
      }))
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
