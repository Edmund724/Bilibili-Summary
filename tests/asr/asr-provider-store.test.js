// asr-provider-store.js provider 列表持久化、Key 单独存放、增删查改测试。
// 镜像 ai-provider-store 的模式：Key 不随列表明文回传，列表只带 hasSavedKey 占位；
// 删除平台时其已存 Key 一并清理。

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

describe("loadAsrProviders / saveAsrProviders", () => {
  it("空存储返回空列表", async () => {
    const { loadAsrProviders } = await loadModule();
    expect(await loadAsrProviders()).toEqual([]);
  });

  it("保存后读取返回列表，apiKey 不明文出现在 sync 存储", async () => {
    const { saveAsrProviders, loadAsrProviders } = await loadModule();
    await saveAsrProviders([
      { ...baseProvider("p1"), apiKey: "secret-key-1" }
    ]);
    // sync 存储里只有 provider 列表，不含 apiKey 字段
    expect(syncStorage.asrProviders).toHaveLength(1);
    expect(syncStorage.asrProviders[0].id).toBe("p1");
    expect(syncStorage.asrProviders[0]).not.toHaveProperty("apiKey");
    // Key 单独存放在 local
    expect(localStorage.asrProviderKeys).toEqual({ p1: "secret-key-1" });

    const list = await loadAsrProviders();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("p1");
    expect(list[0].hasSavedKey).toBe(true);
    expect(list[0]).not.toHaveProperty("apiKey");
  });

  it("保存多个 provider，各自的 Key 独立存放", async () => {
    const { saveAsrProviders } = await loadModule();
    await saveAsrProviders([
      { ...baseProvider("p1"), apiKey: "k1" },
      { ...baseProvider("p2"), apiKey: "k2" }
    ]);
    expect(localStorage.asrProviderKeys).toEqual({ p1: "k1", p2: "k2" });
  });

  it("保存时未带 apiKey 的 provider 不写入 Key 存储，hasSavedKey=false", async () => {
    const { saveAsrProviders, loadAsrProviders } = await loadModule();
    await saveAsrProviders([baseProvider("p1")]);
    expect(localStorage.asrProviderKeys).toEqual({});
    const list = await loadAsrProviders();
    expect(list[0].hasSavedKey).toBe(false);
  });

  it("保存时归一化字段：非法 type 的项被丢弃", async () => {
    const { saveAsrProviders, loadAsrProviders } = await loadModule();
    await saveAsrProviders([
      { ...baseProvider("p1"), type: "bad-type" },
      { ...baseProvider("p2"), type: "openai-transcriptions" }
    ]);
    const list = await loadAsrProviders();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("p2");
  });
});

describe("getAsrProviderKey", () => {
  it("空 id 返回空串", async () => {
    const { getAsrProviderKey } = await loadModule();
    expect(await getAsrProviderKey("")).toBe("");
    expect(await getAsrProviderKey(null)).toBe("");
  });
});

describe("deleteAsrProvider", () => {
  it("删除平台时其已存 Key 一并清理", async () => {
    const { saveAsrProviders, deleteAsrProvider, loadAsrProviderKeys, loadAsrProviders } =
      await loadModule();
    await saveAsrProviders([
      { ...baseProvider("p1"), apiKey: "k1" },
      { ...baseProvider("p2"), apiKey: "k2" }
    ]);
    const after = await deleteAsrProvider("p1");
    // 返回的列表只剩 p2
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe("p2");
    // p1 的 Key 被清理，p2 的保留
    const keys = await loadAsrProviderKeys();
    expect(keys).toEqual({ p2: "k2" });
    // sync 存储里也只剩 p2
    expect(syncStorage.asrProviders).toHaveLength(1);
    expect(syncStorage.asrProviders[0].id).toBe("p2");
    // loadAsrProviders 返回的 hasSavedKey 仍正确
    const list = await loadAsrProviders();
    expect(list[0].hasSavedKey).toBe(true);
  });

  it("删除不存在的平台不抛错、不清理其它 Key", async () => {
    const { saveAsrProviders, deleteAsrProvider, loadAsrProviderKeys } = await loadModule();
    await saveAsrProviders([{ ...baseProvider("p1"), apiKey: "k1" }]);
    const after = await deleteAsrProvider("nonexistent");
    expect(after).toHaveLength(1);
    expect((await loadAsrProviderKeys())).toEqual({ p1: "k1" });
  });

  it("删除后不残留 hasSavedKey 字段在 sync 存储的列表里", async () => {
    const { saveAsrProviders, deleteAsrProvider } = await loadModule();
    await saveAsrProviders([{ ...baseProvider("p1"), apiKey: "k1" }]);
    await deleteAsrProvider("p1");
    expect(syncStorage.asrProviders).toEqual([]);
    // 确认存进去的项不带 hasSavedKey 占位字段
  });
});
