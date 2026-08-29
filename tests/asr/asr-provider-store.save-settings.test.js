// settings-store.js saveSettings ASR 默认项部分保存回归测试。
// 背景：本仓最近刚修过"部分保存设置覆盖其他设置项"的 bug（commit
// e102724 / 7de610d）。ASR 标量默认项（activeAsrProviderId / asrAutoFallback）
// 必须同样遵循"部分保存"语义——只传其中一项时，其它项不应出现在写回
// payload 里，也不应被默认值覆盖。
// 双属主收口后 asrProviders 已摘出 settings：saveSettings 按设置键面白名单
// 落盘，payload 里的 asrProviders（如 content.js 整对象写回）被剔除——
// provider 列表写回只能走 asr-providers-save 消息（provider-store 收口）。

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
    expect(payload).not.toHaveProperty("activeAsrProviderId");
  });

  it("只传 activeAsrProviderId 时，不覆盖其它 ASR 项", async () => {
    const { saveSettings } = await loadModule();
    await saveSettings({ activeAsrProviderId: "p1" });
    expect(extractSetPayload()).toEqual({ activeAsrProviderId: "p1" });
  });

  it("payload 里的 asrProviders 被白名单剔除（写回走 asr-providers-save）", async () => {
    const { saveSettings } = await loadModule();
    await saveSettings({
      asrProviders: [
        { id: "p1", name: "P1", type: "openai-transcriptions", baseUrl: "https://x", model: "m", apiKey: "secret" }
      ]
    });
    const payload = extractSetPayload();
    // 非设置键面：整个 key 不落盘（含明文 apiKey 的陈旧快照无法借此复活）
    expect(payload).toEqual({});
    expect(payload).not.toHaveProperty("asrProviders");
  });

  it("ASR 标量与 asrProviders 混合提交时，仅标量落盘", async () => {
    const { saveSettings } = await loadModule();
    await saveSettings({
      asrAutoFallback: false,
      asrProviders: [{ id: "p1", type: "openai-transcriptions", baseUrl: "https://x", model: "m" }]
    });
    expect(extractSetPayload()).toEqual({ asrAutoFallback: false });
  });

  it("ASR 项与 AI 项混合部分保存，互不影响", async () => {
    const { saveSettings } = await loadModule();
    await saveSettings({ aiThinkingLevel: "high", asrAutoFallback: false });
    const payload = extractSetPayload();
    expect(payload).toEqual({ aiThinkingLevel: "high", asrAutoFallback: false });
    expect(payload).not.toHaveProperty("defaultModel");
  });

  it("asrAutoFallback 仅显式 false 关闭，非布尔值归一化为 true", async () => {
    const { saveSettings } = await loadModule();
    await saveSettings({ asrAutoFallback: "no" });
    expect(extractSetPayload().asrAutoFallback).toBe(true);
    await saveSettings({ asrAutoFallback: 0 });
    expect(syncSetMock).toHaveBeenLastCalledWith({ asrAutoFallback: true });
  });

  it("undefined 值的 ASR 项不写入 payload", async () => {
    const { saveSettings } = await loadModule();
    await saveSettings({ asrProviders: undefined, asrAutoFallback: false });
    const payload = extractSetPayload();
    expect(payload).toEqual({ asrAutoFallback: false });
    expect(payload).not.toHaveProperty("asrProviders");
  });
});

describe("getMergedSettings ASR 默认项", () => {
  it("空存储时回落为 ASR 标量默认值，快照不含 asrProviders", async () => {
    vi.stubGlobal("chrome", {
      ...globalThis.chrome,
      storage: {
        ...globalThis.chrome.storage,
        sync: { ...globalThis.chrome.storage.sync, get: vi.fn(async () => ({})) }
      }
    });
    const { getMergedSettings } = await loadModule();
    const s = await getMergedSettings();
    expect(s).not.toHaveProperty("asrProviders");
    expect(s.activeAsrProviderId).toBe("");
    expect(s.asrAutoFallback).toBe(true);
    expect(s.asrLanguage).toBe("auto");
  });

  it("存储遗留的 asrProviders 不进设置快照，ASR 标量照常归一化", async () => {
    // chrome.storage.sync.get(键面) 只回请求的 key：provider 列表（归
    // provider-store）即使留在存储里也不会随 settings 快照回传
    vi.stubGlobal("chrome", {
      ...globalThis.chrome,
      storage: {
        ...globalThis.chrome.storage,
        sync: {
          ...globalThis.chrome.storage.sync,
          get: vi.fn(async (defaults) => {
            const stored = {
              asrProviders: [{ id: "p1", type: "openai-transcriptions", baseUrl: "https://x/", model: "m" }],
              activeAsrProviderId: " p1 ",
              asrAutoFallback: false,
              asrLanguage: "en"
            };
            const out = {};
            for (const key of Object.keys(defaults)) {
              out[key] = key in stored ? stored[key] : defaults[key];
            }
            return out;
          })
        }
      }
    });
    const { getMergedSettings } = await loadModule();
    const s = await getMergedSettings();
    expect(s).not.toHaveProperty("asrProviders");
    expect(s.activeAsrProviderId).toBe("p1"); // trim 归一化
    expect(s.asrAutoFallback).toBe(false);
    expect(s.asrLanguage).toBe("en");
  });
});
