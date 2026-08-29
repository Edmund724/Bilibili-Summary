// settings-store.js saveSettings ASR 默认项部分保存回归测试。
// 背景：本仓最近刚修过"部分保存设置覆盖其他设置项"的 bug（commit
// e102724 / 7de610d）。新增的 ASR 默认项（asrProviders /
// activeAsrProviderId / asrAutoFallback）必须同样遵循
// "部分保存"语义——只传其中一项时，其它项不应出现在写回 payload 里，
// 也不应被默认值覆盖。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let syncSetMock;

async function loadModule() {
  return import("../../extension/core/settings-store.js");
}

function extractSetPayload() {
  expect(syncSetMock).toHaveBeenCalledTimes(1);
  return syncSetMock.mock.calls[0][0];
}

beforeEach(() => {
  vi.resetModules();
  resetModuleState();
  syncSetMock = vi.fn(async () => {});
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    storage: {
      ...globalThis.chrome.storage,
      sync: {
        ...globalThis.chrome.storage.sync,
        set: syncSetMock
      }
    }
  });
});

describe("saveSettings ASR 默认项部分保存", () => {
  it("只传 asrAutoFallback:false 时，payload 仅含该 key", async () => {
    const { saveSettings } = await loadModule();
    await saveSettings({ asrAutoFallback: false });
    const payload = extractSetPayload();
    expect(payload).toEqual({ asrAutoFallback: false });
    expect(payload).not.toHaveProperty("asrProviders");
    expect(payload).not.toHaveProperty("activeAsrProviderId");
  });

  it("只传 activeAsrProviderId 时，不覆盖其它 ASR 项", async () => {
    const { saveSettings } = await loadModule();
    await saveSettings({ activeAsrProviderId: "p1" });
    expect(extractSetPayload()).toEqual({ activeAsrProviderId: "p1" });
  });

  it("只传 asrProviders 时，不覆盖标量 ASR 项", async () => {
    const { saveSettings } = await loadModule();
    await saveSettings({
      asrProviders: [
        { id: "p1", name: "P1", type: "openai-transcriptions", baseUrl: "https://x", model: "m" }
      ]
    });
    const payload = extractSetPayload();
    expect(payload.asrProviders).toHaveLength(1);
    expect(payload.asrProviders[0].id).toBe("p1");
    expect(payload).not.toHaveProperty("asrAutoFallback");
    // asrProviders 列表里不应携带 apiKey 明文
    expect(payload.asrProviders[0]).not.toHaveProperty("apiKey");
  });

  it("ASR 项与 AI 项混合部分保存，互不影响", async () => {
    const { saveSettings } = await loadModule();
    await saveSettings({ aiThinkingLevel: "high", asrAutoFallback: false });
    const payload = extractSetPayload();
    expect(payload).toEqual({ aiThinkingLevel: "high", asrAutoFallback: false });
    expect(payload).not.toHaveProperty("asrProviders");
    expect(payload).not.toHaveProperty("defaultModel");
  });

  it("asrAutoFallback 仅显式 false 关闭，非布尔值归一化为 true", async () => {
    const { saveSettings } = await loadModule();
    await saveSettings({ asrAutoFallback: "no" });
    expect(extractSetPayload().asrAutoFallback).toBe(true);
    await saveSettings({ asrAutoFallback: 0 });
    expect(syncSetMock).toHaveBeenLastCalledWith({ asrAutoFallback: true });
  });

  it("asrProviders 含非法 type 的项被过滤，合法项保留", async () => {
    const { saveSettings } = await loadModule();
    await saveSettings({
      asrProviders: [
        { id: "good", type: "openai-transcriptions", baseUrl: "https://x", model: "m" },
        { id: "bad", type: "random", baseUrl: "https://y", model: "m2" }
      ]
    });
    const payload = extractSetPayload();
    expect(payload.asrProviders).toHaveLength(1);
    expect(payload.asrProviders[0].id).toBe("good");
  });

  it("undefined 值的 ASR 项不写入 payload", async () => {
    const { saveSettings } = await loadModule();
    await saveSettings({ asrProviders: undefined, asrAutoFallback: false });
    const payload = extractSetPayload();
    expect(payload).toEqual({ asrAutoFallback: false });
    expect(payload).not.toHaveProperty("asrProviders");
  });
});

describe("getMergedSettings ASR 默认项归一化", () => {
  it("空存储时回落为 ASR 默认值", async () => {
    vi.stubGlobal("chrome", {
      ...globalThis.chrome,
      storage: {
        ...globalThis.chrome.storage,
        sync: { ...globalThis.chrome.storage.sync, get: vi.fn(async () => ({})) }
      }
    });
    const { getMergedSettings } = await loadModule();
    const s = await getMergedSettings();
    expect(s.asrProviders).toEqual([]);
    expect(s.activeAsrProviderId).toBe("");
    expect(s.asrAutoFallback).toBe(true);
  });

  it("已存 ASR 设置被归一化回传", async () => {
    vi.stubGlobal("chrome", {
      ...globalThis.chrome,
      storage: {
        ...globalThis.chrome.storage,
        sync: {
          ...globalThis.chrome.storage.sync,
          get: vi.fn(async () => ({
            asrProviders: [{ id: "p1", type: "openai-transcriptions", baseUrl: "https://x/", model: "m" }],
            activeAsrProviderId: "p1",
            asrAutoFallback: false
          }))
        }
      }
    });
    const { getMergedSettings } = await loadModule();
    const s = await getMergedSettings();
    expect(s.asrProviders).toHaveLength(1);
    expect(s.asrProviders[0].baseUrl).toBe("https://x"); // 尾斜杠剥离
    expect(s.activeAsrProviderId).toBe("p1");
    expect(s.asrAutoFallback).toBe(false);
  });
});
