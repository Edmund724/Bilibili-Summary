// tests/asr/provider-models.test.js
// asr/provider-models.js 的 listAsrModels（options 页 ASR 模型名下拉的数据源，
// 直调不经 SW 消息）契约：
// - GET `${baseUrl}/models?sub_type=speech-to-text`（SiliconFlow 语音模型过滤参数）；
// - host 权限预检：未授权回可操作提示且不发请求（与连通性探针同一判定）；
// - Key 代查：优先用户重输 apiKey，否则按 providerId 读已存 Key。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let fetchMock;

async function loadModule() {
  return import("../../extension/asr/provider-models.js");
}

// 最小响应对象（拉取代码只消费 ok / status / text / json）。
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

describe("listAsrModels", () => {
  it("已授权 → 带 sub_type=speech-to-text 拉取 /models 并回模型列表", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "FunAudioLLM/SenseVoiceSmall" }, { id: "m2" }] }));
    const { listAsrModels } = await loadModule();

    const resp = await listAsrModels({
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKey: "sk-1"
    });

    expect(resp).toEqual({ ok: true, models: ["FunAudioLLM/SenseVoiceSmall", "m2"] });
    expect(globalThis.chrome.permissions.contains).toHaveBeenCalledWith({
      origins: ["https://api.siliconflow.cn/*"]
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.siliconflow.cn/v1/models?sub_type=speech-to-text");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-1");
  });

  it("未填 apiKey 时按 providerId 读已存 Key", async () => {
    globalThis.chrome.storage.local.get = vi.fn(async () => ({ asrProviderKeys: { asr1: "sk-saved" } }));
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "m1" }] }));
    const { listAsrModels } = await loadModule();

    const resp = await listAsrModels({
      baseUrl: "https://api.siliconflow.cn/v1",
      providerId: "asr1"
    });

    expect(resp.ok).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-saved");
  });

  it("本地 Whisper 无 Key → 裸 GET 不带 Authorization", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "whisper-large-v3" }] }));
    const { listAsrModels } = await loadModule();

    const resp = await listAsrModels({ baseUrl: "http://localhost:8000/v1" });

    expect(resp).toEqual({ ok: true, models: ["whisper-large-v3"] });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("未授权 → 返回可操作提示且不发请求", async () => {
    vi.mocked(globalThis.chrome.permissions.contains).mockResolvedValue(false);
    const { listAsrModels } = await loadModule();

    const resp = await listAsrModels({
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKey: "sk-1"
    });

    expect(resp).toEqual({ ok: false, error: "该平台域名未授权，请在保存时允许权限" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("baseUrl 为空 → 直接提示，不查权限也不发请求", async () => {
    const { listAsrModels } = await loadModule();

    const resp = await listAsrModels({ baseUrl: "" });

    expect(resp).toEqual({ ok: false, error: "请先填写 baseUrl" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
