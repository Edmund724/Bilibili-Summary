// asr-provider-store.js 按 provider.type 的测试连接分发测试。
// 覆盖 openai-transcriptions 探针的成功与失败分支、apiKey 缺失时回退
// 读取已存 Key、非法 provider 的兜底。
// 探针只与 fetch / chrome.storage 交互，用 vi.stubGlobal 替换 fetch 与 chrome。
// 注意：本仓库 jsdom 环境里 FormData/Blob 均存在，openai-transcriptions
// 探针走 FormData 分支；multipart 手拼降级分支（无 FormData 环境）不在本文件覆盖。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let fetchMock;
let localStorage;

async function loadModule() {
  return import("../../extension/asr/asr-provider-store.js");
}

beforeEach(() => {
  vi.resetModules();
  resetModuleState();
  localStorage = {};
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    storage: {
      ...globalThis.chrome.storage,
      sync: {
        ...globalThis.chrome.storage.sync,
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {})
      },
      local: {
        ...globalThis.chrome.storage.local,
        get: vi.fn(async (keys) => {
          const names = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of names) out[k] = localStorage[k];
          return out;
        }),
        set: vi.fn(async (obj) => { Object.assign(localStorage, obj); })
      }
    }
  });
});

// 构造一个带真实 Response 语义的最小响应对象（含 ok/status/text），
// 探针代码只消费这三个字段。
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn(async () => JSON.stringify(body))
  };
}

function baseProvider(overrides = {}) {
  return {
    id: "p1",
    presetId: "custom",
    name: "P1",
    type: "openai-transcriptions",
    baseUrl: "https://example.com/v1",
    model: "m",
    ...overrides
  };
}

describe("testAsrConnection 分发与兜底", () => {
  it("非法 type 的 provider 返回 { ok:false } 且不发请求", async () => {
    const { testAsrConnection } = await loadModule();
    const resp = await testAsrConnection({ id: "p1", type: "random-type", baseUrl: "x", model: "y" });
    expect(resp.ok).toBe(false);
    expect(resp.error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("缺失 id / 缺失 type 的 provider 返回 { ok:false }", async () => {
    const { testAsrConnection } = await loadModule();
    expect((await testAsrConnection({ type: "openai-transcriptions", baseUrl: "x", model: "y" })).ok).toBe(false);
    expect((await testAsrConnection(null)).ok).toBe(false);
  });
});

describe("openai-transcriptions 探针", () => {
  it("HTTP 200 即通过，请求发到 /audio/transcriptions", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { text: "ok" }));
    const { testAsrConnection } = await loadModule();
    const resp = await testAsrConnection(baseProvider({ apiKey: "sk-1" }));
    expect(resp.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.com/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    // apiKey 走 Authorization 头；FormData 分支不应手动设 Content-Type
    expect(init.headers.Authorization).toBe("Bearer sk-1");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers["Content-Type"]).toBeUndefined();
  });

  it("非 200 报 HTTP 状态码与响应体片段", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { message: "bad request" }));
    const { testAsrConnection } = await loadModule();
    const resp = await testAsrConnection(baseProvider({ apiKey: "sk-1" }));
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("HTTP 400");
    expect(resp.error).toContain("bad request");
  });

  it("网络错误返回 无法连接", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const { testAsrConnection } = await loadModule();
    const resp = await testAsrConnection(baseProvider({ apiKey: "sk-1" }));
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("无法连接");
  });
});

describe("apiKey 缺失时回退读取已存 Key", () => {
  it("provider 不带 apiKey 时，按 id 从 local 读已存 Key", async () => {
    // 预置已存 Key 到 local 存储
    localStorage.asrProviderKeys = { p1: "stored-key-1" };
    fetchMock.mockResolvedValue(jsonResponse(200, { text: "ok" }));
    const { testAsrConnection } = await loadModule();
    const resp = await testAsrConnection(baseProvider());
    expect(resp.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    // 请求用的 Authorization 来自已存 Key
    expect(init.headers.Authorization).toBe("Bearer stored-key-1");
  });
});
