// AI 连通性探针测试（候选 04：探针移至 ai/provider-test.js，options 页直调）。
// 覆盖 testAiConnection / probeAiChatCompletion 的 { ok, error } 形状契约：
// 输入预检、probe 请求负载（max_tokens:1 + ping）、成功判定 = response.ok、
// HTTP / 连接 / 溢出错误的文案包装（复用共享 helper，AI/ASR 逐字一致）。
// 探针只与 fetch / chrome.storage 交互，用 vi.stubGlobal 替换 fetch。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let fetchMock;

async function loadModule() {
  return import("../../extension/ai/provider-test.js");
}

beforeEach(async () => {
  vi.resetModules();
  resetModuleState();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

// 最小响应对象（探针代码只消费 ok / status / text / json）。
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn(async () => JSON.stringify(body)),
    json: vi.fn(async () => body)
  };
}

describe("testAiConnection 输入预检", () => {
  it("缺 baseUrl / 缺模型名 → { ok:false, error } 且不发请求", async () => {
    const { testAiConnection } = await loadModule();

    const noBaseUrl = await testAiConnection({ baseUrl: "", apiKey: "sk", model: "m" });
    expect(noBaseUrl).toEqual({ ok: false, error: "请填写 baseUrl" });

    const noModel = await testAiConnection({ baseUrl: "https://x", apiKey: "sk", model: "  " });
    expect(noModel).toEqual({ ok: false, error: "请填写模型名" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("baseUrl trim + 去尾斜杠后交给探针", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const { testAiConnection } = await loadModule();

    const resp = await testAiConnection({ baseUrl: " https://api.example.com/v1// ", apiKey: "sk-1", model: "gpt" });

    expect(resp).toEqual({ ok: true });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
  });
});

describe("probeAiChatCompletion { ok, error } 形状", () => {
  it("HTTP 200 即通过；请求发到 /chat/completions，负载 max_tokens:1 + ping，带 Accept 头", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const { probeAiChatCompletion } = await loadModule();

    const resp = await probeAiChatCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-1",
      model: "gpt"
    });

    expect(resp).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      model: "gpt",
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      max_tokens: 1
    });
    expect(init.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: "Bearer sk-1"
    });
    // 成功判定 = response.ok：不读响应体
    expect(init.body).toBeTruthy();
  });

  it("无 apiKey 时不出 Authorization 头", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const { probeAiChatCompletion } = await loadModule();

    await probeAiChatCompletion({ baseUrl: "https://x", apiKey: "", model: "m" });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("非 2xx → { ok:false, error: 'HTTP <status>: <detail>' }（响应体前 200 字符）", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { message: "bad key" } }));
    const { probeAiChatCompletion } = await loadModule();

    const resp = await probeAiChatCompletion({ baseUrl: "https://x", apiKey: "sk", model: "m" });

    expect(resp.ok).toBe(false);
    expect(resp.error).toBe("HTTP 401: " + JSON.stringify({ error: { message: "bad key" } }));
    expect(fetchMock).toHaveBeenCalledTimes(1); // 探针不重试
  });

  it("网络层失败 → { ok:false, error: '无法连接：<原始信息>' }（与 ASR 探针文案逐字一致）", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const { probeAiChatCompletion } = await loadModule();

    const resp = await probeAiChatCompletion({ baseUrl: "https://x", apiKey: "sk", model: "m" });

    expect(resp).toEqual({ ok: false, error: "无法连接：network down" });
  });

  it("HTTP 400 命中 context-length 溢出文案 → 仍按 HTTP 错误包装（不丢状态码语义）", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, "context_length_exceeded"));
    const { probeAiChatCompletion } = await loadModule();

    const resp = await probeAiChatCompletion({ baseUrl: "https://x", apiKey: "sk", model: "m" });

    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("HTTP 400");
    expect(resp.error).toContain("context_length_exceeded");
  });

  it("接缝守卫（缺 model 直调探针）→ { ok:false, error: '模型未配置' }", async () => {
    const { probeAiChatCompletion } = await loadModule();

    const resp = await probeAiChatCompletion({ baseUrl: "https://x", apiKey: "sk", model: "" });

    expect(resp).toEqual({ ok: false, error: "模型未配置" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// testAiProviderConnection = options 页「测试」按钮入口，契约继承原 SW 侧
// ai-providers-test 处理器的输入装配（provider-handlers.js pickFlatTestProvider）：
// 直输 Key 优先，否则按 providerId 从 chrome.storage.local 代查，都没有为空串。
describe("testAiProviderConnection Key 代查", () => {
  const storageGet = () => globalThis.chrome.storage.local.get;

  async function loadEntry() {
    const mod = await loadModule();
    return mod.testAiProviderConnection;
  }

  it("直输 Key 优先：不读已存 Key 存储，Authorization 用重输值", async () => {
    storageGet().mockReset();
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const entry = await loadEntry();

    const resp = await entry({
      providerId: "p1",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-direct",
      model: "gpt"
    });

    expect(resp).toEqual({ ok: true });
    expect(storageGet()).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-direct");
  });

  it("未重输 Key → 按 providerId 代查已存 Key", async () => {
    storageGet().mockReset();
    storageGet().mockResolvedValue({ aiProviderKeys: { p1: "sk-saved" } });
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const entry = await loadEntry();

    const resp = await entry({
      providerId: "p1",
      baseUrl: "https://api.example.com/v1",
      apiKey: "",
      model: "gpt"
    });

    expect(resp).toEqual({ ok: true });
    expect(storageGet()).toHaveBeenCalledWith(["aiProviderKeys"]);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-saved");
  });

  it("未重输 Key 且无 providerId → 空 Key 探针（无 Authorization 头）", async () => {
    storageGet().mockReset();
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const entry = await loadEntry();

    await entry({ providerId: "", baseUrl: "https://x", apiKey: "  ", model: "m" });

    expect(storageGet()).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("已存 Key 读取失败 → 容错按空 Key 继续探针（不吞探针结果）", async () => {
    storageGet().mockReset();
    storageGet().mockRejectedValue(new Error("storage down"));
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const entry = await loadEntry();

    const resp = await entry({
      providerId: "p1",
      baseUrl: "https://x",
      apiKey: "",
      model: "m"
    });

    expect(resp).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});
