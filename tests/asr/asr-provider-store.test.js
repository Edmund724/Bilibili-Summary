// asr-provider-store.js provider 列表持久化、Key 单独存放、增删查改测试。
// 镜像 ai-provider-store 的模式：Key 不随列表明文回传，列表只带 hasSavedKey 占位；
// 删除平台时其已存 Key 一并清理。转发函数已收敛为 asrProviderStore 实例导出，
// 用例直接调实例方法（与 background 消息路由的接线形态一致）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let syncStorage;
let localStorage;

async function loadModule() {
  return import("../../extension/asr/asr-provider-store.js");
}

beforeEach(() => {
  vi.resetModules();
  resetModuleState();
  syncStorage = {};
  localStorage = {};
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    storage: {
      ...globalThis.chrome.storage,
      sync: {
        ...globalThis.chrome.storage.sync,
        get: vi.fn(async (keys) => {
          const out = {};
          // chrome.storage.get 签名支持 string | string[] | object，这里覆盖数组形式
          const names = Array.isArray(keys) ? keys : [keys];
          for (const k of names) out[k] = syncStorage[k];
          return out;
        }),
        set: vi.fn(async (obj) => { Object.assign(syncStorage, obj); })
      },
      local: {
        ...globalThis.chrome.storage.local,
        get: vi.fn(async (keys) => {
          const out = {};
          // chrome.storage.get 签名支持 string | string[] | object，这里覆盖数组形式
          const names = Array.isArray(keys) ? keys : [keys];
          for (const k of names) out[k] = localStorage[k];
          return out;
        }),
        set: vi.fn(async (obj) => { Object.assign(localStorage, obj); })
      }
    }
  });
});

function baseProvider(id, overrides = {}) {
  return {
    id,
    presetId: "custom",
    name: "P " + id,
    type: "openai-transcriptions",
    baseUrl: "https://example.com/v1",
    model: "m",
    ...overrides
  };
}

describe("asrProviderStore.loadProviders / saveProviders", () => {
  it("空存储返回空列表", async () => {
    const { asrProviderStore } = await loadModule();
    expect(await asrProviderStore.loadProviders()).toEqual([]);
  });

  it("保存后读取返回列表，apiKey 不明文出现在 sync 存储", async () => {
    const { asrProviderStore } = await loadModule();
    await asrProviderStore.saveProviders([
      { ...baseProvider("p1"), apiKey: "secret-key-1" }
    ]);
    // sync 存储里只有 provider 列表，不含 apiKey 字段
    expect(syncStorage.asrProviders).toHaveLength(1);
    expect(syncStorage.asrProviders[0].id).toBe("p1");
    expect(syncStorage.asrProviders[0]).not.toHaveProperty("apiKey");
    // Key 单独存放在 local
    expect(localStorage.asrProviderKeys).toEqual({ p1: "secret-key-1" });

    const list = await asrProviderStore.loadProviders();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("p1");
    expect(list[0].hasSavedKey).toBe(true);
    expect(list[0]).not.toHaveProperty("apiKey");
  });

  it("保存多个 provider，各自的 Key 独立存放", async () => {
    const { asrProviderStore } = await loadModule();
    await asrProviderStore.saveProviders([
      { ...baseProvider("p1"), apiKey: "k1" },
      { ...baseProvider("p2"), apiKey: "k2" }
    ]);
    expect(localStorage.asrProviderKeys).toEqual({ p1: "k1", p2: "k2" });
  });

  it("保存时未带 apiKey 的 provider 不写入 Key 存储，hasSavedKey=false", async () => {
    const { asrProviderStore } = await loadModule();
    await asrProviderStore.saveProviders([baseProvider("p1")]);
    expect(localStorage.asrProviderKeys).toEqual({});
    const list = await asrProviderStore.loadProviders();
    expect(list[0].hasSavedKey).toBe(false);
  });

  it("保存时归一化字段：非法 type 的项被丢弃", async () => {
    const { asrProviderStore } = await loadModule();
    await asrProviderStore.saveProviders([
      { ...baseProvider("p1"), type: "bad-type" },
      { ...baseProvider("p2"), type: "openai-transcriptions" }
    ]);
    const list = await asrProviderStore.loadProviders();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("p2");
  });
});

describe("asrProviderStore.getKey", () => {
  it("空 id 返回空串", async () => {
    const { asrProviderStore } = await loadModule();
    expect(await asrProviderStore.getKey("")).toBe("");
    expect(await asrProviderStore.getKey(null)).toBe("");
  });
});

describe("asrProviderStore.deleteProvider", () => {
  it("删除平台时其已存 Key 一并清理", async () => {
    const { asrProviderStore } = await loadModule();
    await asrProviderStore.saveProviders([
      { ...baseProvider("p1"), apiKey: "k1" },
      { ...baseProvider("p2"), apiKey: "k2" }
    ]);
    const after = await asrProviderStore.deleteProvider("p1");
    // 返回的列表只剩 p2
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe("p2");
    // p1 的 Key 被清理，p2 的保留
    const keys = await asrProviderStore.loadKeys();
    expect(keys).toEqual({ p2: "k2" });
    // sync 存储里也只剩 p2
    expect(syncStorage.asrProviders).toHaveLength(1);
    expect(syncStorage.asrProviders[0].id).toBe("p2");
    // loadProviders 返回的 hasSavedKey 仍正确
    const list = await asrProviderStore.loadProviders();
    expect(list[0].hasSavedKey).toBe(true);
  });

  it("删除不存在的平台不抛错、不清理其它 Key", async () => {
    const { asrProviderStore } = await loadModule();
    await asrProviderStore.saveProviders([{ ...baseProvider("p1"), apiKey: "k1" }]);
    const after = await asrProviderStore.deleteProvider("nonexistent");
    expect(after).toHaveLength(1);
    expect((await asrProviderStore.loadKeys())).toEqual({ p1: "k1" });
  });

  it("删除后不残留 hasSavedKey 字段在 sync 存储的列表里", async () => {
    const { asrProviderStore } = await loadModule();
    await asrProviderStore.saveProviders([{ ...baseProvider("p1"), apiKey: "k1" }]);
    await asrProviderStore.deleteProvider("p1");
    expect(syncStorage.asrProviders).toEqual([]);
    // 确认存进去的项不带 hasSavedKey 占位字段
  });
});
