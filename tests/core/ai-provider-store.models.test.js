// core/ai-provider-store.js 的模型列表探测（handleAiProvidersModels，经
// ai-providers-models 消息从 options 页模型下拉调用）在 S2 收紧
// host_permissions 后的权限预检：平台域名未授权时那条 GET 只会以 CORS 失败，
// 回包是「Failed to fetch」这类看不出原因的文案，必须换成可操作提示。
// 判定与 AI/ASR 连通性探针共用 core/host-permissions.js 的一份实现。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let fetchMock;

async function loadModule() {
  return import("../../extension/core/ai-provider-store.js");
}

// 最小响应对象（探测代码只消费 ok / status / text / json）。
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn(async () => JSON.stringify(body)),
    json: vi.fn(async () => body)
  };
}

beforeEach(() => {
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

describe("handleAiProvidersModels 的 host 权限预检", () => {
  it("已授权 → 正常拉取 /v1/models 并回模型列表", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }));
    const { handleAiProvidersModels } = await loadModule();

    const resp = await handleAiProvidersModels({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-1"
    });

    expect(resp).toEqual({ ok: true, models: ["gpt-4o", "gpt-4o-mini"] });
    expect(globalThis.chrome.permissions.contains).toHaveBeenCalledWith({
      origins: ["https://api.openai.com/*"]
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/models");
  });

  it("未授权 → 返回可操作提示且不发请求", async () => {
    vi.mocked(globalThis.chrome.permissions.contains).mockResolvedValue(false);
    const { handleAiProvidersModels } = await loadModule();

    const resp = await handleAiProvidersModels({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-1"
    });

    expect(resp).toEqual({ ok: false, error: "该平台域名未授权，请在保存时允许权限" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("不持有 chrome.permissions 实现时按已授权处理（不阻塞既有拉取）", async () => {
    vi.stubGlobal("chrome", {
      ...globalThis.chrome,
      permissions: undefined
    });
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "m1" }] }));
    const { handleAiProvidersModels } = await loadModule();

    const resp = await handleAiProvidersModels({ baseUrl: "https://api.openai.com/v1", apiKey: "sk-1" });

    expect(resp).toEqual({ ok: true, models: ["m1"] });
  });
});
