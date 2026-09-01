// asr/provider-test.js 按 provider.type 的测试连接分发测试。
// 覆盖 openai-transcriptions 探针的成功与失败分支、apiKey 缺失时回退
// 读取已存 Key、非法 provider 的兜底。
// 探针只与 fetch / chrome.storage 交互，用 vi.stubGlobal 替换 fetch 与 chrome。
// 本仓库 jsdom 环境里 FormData/Blob 均存在，openai-transcriptions 探针始终构造
// 真实 FormData；需要脱离全局 fetch 时可注入 options.transport（见文末用例）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let fetchMock;
let localStorage;

async function loadModule() {
  return import("../../extension/asr/provider-test.js");
}

beforeEach(() => {
  vi.resetModules();
  resetModuleState();
  localStorage = {};
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    permissions: {
      contains: vi.fn(async () => true)
    },
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

  it("全局 asrLanguage=en 时探针 URL 附加 ?language=english（验证英文链路）", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { text: "ok" }));
    // 语言档位来自全局设置（popup 顶部切换），预置 sync 存储
    vi.mocked(globalThis.chrome.storage.sync.get).mockResolvedValue({ asrLanguage: "en" });
    const { testAsrConnection } = await loadModule();
    const resp = await testAsrConnection(baseProvider({ apiKey: "sk-1" }));
    expect(resp.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.com/v1/audio/transcriptions?language=english");
    // 语言不在 multipart 字段里（SiliconFlow 只认查询参数）
    expect(init.body.get("language")).toBeNull();
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

describe("注入 transport", () => {
  it("注入 fake transport 时代其发请求，全局 fetch 不被调用", async () => {
    const transport = vi.fn(async (url, init) => jsonResponse(200, { text: "ok" }));
    const { testAsrConnection } = await loadModule();
    const resp = await testAsrConnection(baseProvider({ apiKey: "sk-1" }), { transport });
    expect(resp.ok).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("https://example.com/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-1");
    expect(init.body).toBeInstanceOf(FormData);
    // 全局 fetch（本文件的 fetchMock）未被触碰
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("host 权限预检（S2：optional_host_permissions 未授权时的可操作提示）", () => {
  // 门禁在 testAsrConnection 分发前执行（取全局 chrome.permissions.contains），
  // 未授权直接短路返回提示，不发起注定被 CORS 拦下的请求。
  it("未授权 → 不发请求，返回可操作提示", async () => {
    vi.mocked(globalThis.chrome.permissions.contains).mockResolvedValue(false);
    const { testAsrConnection } = await loadModule();
    const resp = await testAsrConnection(baseProvider({ apiKey: "sk-1" }));
    expect(resp).toEqual({ ok: false, error: "该平台域名未授权，请在保存时允许权限" });
    expect(globalThis.chrome.permissions.contains).toHaveBeenCalledWith({
      origins: ["https://example.com"]
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("已授权 → 正常发请求并返回成功", async () => {
    vi.mocked(globalThis.chrome.permissions.contains).mockResolvedValue(true);
    fetchMock.mockResolvedValue(jsonResponse(200, { text: "ok" }));
    const { testAsrConnection } = await loadModule();
    const resp = await testAsrConnection(baseProvider({ apiKey: "sk-1" }));
    expect(resp.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("注入 transport（不经真实网络）→ 不受权限门禁", async () => {
    vi.mocked(globalThis.chrome.permissions.contains).mockResolvedValue(false);
    const transport = vi.fn(async () => jsonResponse(200, { text: "ok" }));
    const { testAsrConnection } = await loadModule();
    const resp = await testAsrConnection(baseProvider({ apiKey: "sk-1" }), { transport });
    expect(resp.ok).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(globalThis.chrome.permissions.contains).not.toHaveBeenCalled();
  });

  it("不持有 chrome.permissions 实现时按已授权处理（不阻塞既有探针行为）", async () => {
    vi.stubGlobal("chrome", {
      ...globalThis.chrome,
      permissions: undefined
    });
    fetchMock.mockResolvedValue(jsonResponse(200, { text: "ok" }));
    const { testAsrConnection } = await loadModule();
    const resp = await testAsrConnection(baseProvider({ apiKey: "sk-1" }));
    expect(resp.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
