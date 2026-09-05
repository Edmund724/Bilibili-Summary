// AI 连通性探针测试（候选 04：探针移至 ai/provider-test.js，options 页直调）。
// 覆盖 testAiConnection / probeAiChatCompletion 的 { ok, error } 形状契约：
// 输入预检、probe 请求负载（token 上限 1 + ping，参数名随模型类映射：reasoning
// 系 max_completion_tokens、其余 max_tokens）、成功判定 = response.ok、
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
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    permissions: {
      contains: vi.fn(async () => true)
    }
  });
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
    // 探针省略档位 ⇒ 回落 off ⇒ 经 thinking-profiles 查表：未知平台×模型无事实
    // → 不发任何思考字段（旧霰弹枪双发 thinking+enable_thinking 会令 OpenAI 探针必 400）
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

  it("OpenAI + reasoning 模型探针：off 查表落 reasoning_effort:none，token 上限写 max_completion_tokens:1（reasoning 系不认 max_tokens）", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const { probeAiChatCompletion } = await loadModule();

    const resp = await probeAiChatCompletion({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-1",
      model: "gpt-5.1"
    });

    expect(resp).toEqual({ ok: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      model: "gpt-5.1",
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      max_completion_tokens: 1,
      reasoning_effort: "none"
    });
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

  it("直输 Key 优先：已存 Key 不顶替直输值，Authorization 用重输值", async () => {
    storageGet().mockReset();
    storageGet().mockResolvedValue({ aiProviderKeys: { p1: "sk-saved" } });
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const entry = await loadEntry();

    const resp = await entry({
      providerId: "p1",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-direct",
      model: "gpt"
    });

    expect(resp).toEqual({ ok: true });
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

// S2 收紧 host_permissions 后：options 页「测试」按钮在发起探针请求前先确认该
// 平台域名已获 host 权限——未授权时跨域 fetch 只会以 CORS 失败（「无法连接：
// Failed to fetch」），看不出真正原因，因此权限缺失直接短路成可操作提示。
describe("testAiProviderConnection 的 host 权限预检", () => {
  async function loadEntry() {
    const mod = await loadModule();
    return mod.testAiProviderConnection;
  }

  it("域名未授权 → 返回可操作提示，且不发探针请求", async () => {
    vi.mocked(globalThis.chrome.permissions.contains).mockResolvedValue(false);
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const entry = await loadEntry();

    const resp = await entry({
      providerId: "p1",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-1",
      model: "gpt"
    });

    expect(resp).toEqual({ ok: false, error: "该平台域名未授权，请在保存时允许权限" });
    expect(globalThis.chrome.permissions.contains).toHaveBeenCalledWith({
      origins: ["https://api.openai.com/*"]
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("已授权时探针错误原样返回（HTTP 401 不被权限文案覆盖）", async () => {
    vi.mocked(globalThis.chrome.permissions.contains).mockResolvedValue(true);
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { message: "bad key" } }));
    const entry = await loadEntry();

    const resp = await entry({
      providerId: "p1",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-1",
      model: "gpt"
    });

    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("HTTP 401");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("不持有 chrome.permissions 实现时按已授权处理（不阻塞既有探针行为）", async () => {
    vi.stubGlobal("chrome", {
      ...globalThis.chrome,
      permissions: undefined
    });
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const entry = await loadEntry();

    const resp = await entry({
      providerId: "p1",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-1",
      model: "gpt"
    });

    expect(resp).toEqual({ ok: true });
  });
});

// presetId 穿线（02 号票，探针链）：testAiProviderConnection 按 providerId 从
// 已存列表读记录的 presetId（preset 词表键，非记录 id）随探针请求下发，baseUrl
// host 推断退为兜底；旧记录（无 presetId 字段）经 normalize 落 "custom" → 回落
// host/模型名识别，与 01 落地行为一致。
describe("testAiProviderConnection presetId 穿线", () => {
  // 播种 chrome.storage.sync 的已存列表（loadProviders 读取 + normalize 的入口）
  function stubProviderStorage(list) {
    vi.stubGlobal("chrome", {
      ...globalThis.chrome,
      permissions: { contains: vi.fn(async () => true) },
      storage: {
        sync: { get: vi.fn(async () => ({ aiProviders: list })), set: vi.fn(async () => {}) },
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) }
      }
    });
  }

  it("记录的 presetId 随探针下发：host 反代无规则也按 preset 平台规则出思考字段", async () => {
    stubProviderStorage([{
      id: "p1",
      presetId: "ollama",
      name: "本地 Ollama",
      baseUrl: "https://thinking-proxy.example.com/v1",
      model: "llama3.2",
      requiresKey: false,
      enabled: true
    }]);
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const { testAiProviderConnection } = await loadModule();

    const resp = await testAiProviderConnection({
      providerId: "p1",
      baseUrl: "https://thinking-proxy.example.com/v1",
      model: "llama3.2"
    });

    expect(resp).toEqual({ ok: true });
    // 探针省略档位 ⇒ off ⇒ ollama unknownClass（effort 词汇）→ reasoning_effort:"none"；
    // 穿线断裂（host 无规则 + llama3.2 不在模式表）则落 unknown、字段全缺
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ reasoning_effort: "none" });
  });

  it("旧记录无 presetId 字段 → normalize 落 custom → 回落 host 推断（与 01 行为一致）", async () => {
    stubProviderStorage([{
      id: "p1",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.1",
      requiresKey: true,
      enabled: true
    }]);
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const { testAiProviderConnection } = await loadModule();

    const resp = await testAiProviderConnection({
      providerId: "p1",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-1",
      model: "gpt-5.1"
    });

    expect(resp).toEqual({ ok: true });
    // openai host 兜底命中 → gpt-5.1 off = effort none（01 golden 锁定）
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ reasoning_effort: "none" });
  });
});
