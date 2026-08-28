// provider-store.js createProviderStore 工厂测试。
// AI 平台与 ASR 平台的 provider 存储共用该工厂：列表存 sync、Key 单独存 local
//（apiKey 永不进同步列表）、列表只带 hasSavedKey 占位、删除时清理孤儿 Key。
// 用 chrome.storage mock 直接验证工厂的存储行为。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createProviderStore } from "../../extension/core/provider-store.js";

let syncStorage;
let localStorage;

// 工厂测试专用的最小归一化函数（不依赖 shared-defaults，验证工厂本身契约）
function normalizeProvider(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || "").trim();
  if (!id) return null;
  return {
    id,
    name: String(item.name || "").trim(),
    model: String(item.model || "").trim()
  };
}

function makeStore() {
  return createProviderStore({
    listStorageKey: "testProviders",
    keysStorageKey: "testProviderKeys",
    normalizeProvider
  });
}

beforeEach(() => {
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
          const names = Array.isArray(keys) ? keys : [keys];
          for (const k of names) out[k] = localStorage[k];
          return out;
        }),
        set: vi.fn(async (obj) => { Object.assign(localStorage, obj); })
      }
    }
  });
});

function provider(id, overrides = {}) {
  return { id, name: "P " + id, model: "m-" + id, ...overrides };
}

describe("loadProviders / saveProviders 往返", () => {
  it("空存储返回空列表", async () => {
    const store = makeStore();
    expect(await store.loadProviders()).toEqual([]);
  });

  it("保存后读取往返一致，apiKey 收割进 local 的 Key 存储", async () => {
    const store = makeStore();
    const saved = await store.saveProviders([
      provider("p1", { apiKey: "secret-1" }),
      provider("p2", { apiKey: "secret-2" })
    ]);
    expect(saved).toHaveLength(2);
    expect(saved[0].id).toBe("p1");

    // Key 收割进 local 存储
    expect(localStorage.testProviderKeys).toEqual({ p1: "secret-1", p2: "secret-2" });
    // sync 列表里绝无明文 apiKey
    expect(JSON.stringify(syncStorage.testProviders)).not.toContain("secret-1");
    expect(JSON.stringify(syncStorage.testProviders)).not.toContain("secret-2");
    expect(syncStorage.testProviders[0]).not.toHaveProperty("apiKey");

    const list = await store.loadProviders();
    expect(list).toEqual([
      { id: "p1", name: "P p1", model: "m-p1", hasSavedKey: true },
      { id: "p2", name: "P p2", model: "m-p2", hasSavedKey: true }
    ]);
  });

  it("保存时未带 apiKey 的项不写入 Key 存储；再保存带 Key 的才收割", async () => {
    const store = makeStore();
    await store.saveProviders([provider("p1")]);
    expect(localStorage.testProviderKeys).toEqual({});

    await store.saveProviders([provider("p1", { apiKey: "  k1  " })]);
    // apiKey trim 后写入
    expect(localStorage.testProviderKeys).toEqual({ p1: "k1" });
  });

  it("保存时不带 apiKey 保留已存 Key（不清除）；归一化失败的项被丢弃", async () => {
    const store = makeStore();
    await store.saveProviders([provider("p1", { apiKey: "k1" })]);
    await store.saveProviders([provider("p1"), { id: "   " }]);
    // p1 的 Key 保留，空 id 项不入列表也不影响 Key
    expect(localStorage.testProviderKeys).toEqual({ p1: "k1" });
    const list = await store.loadProviders();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("p1");
    expect(list[0].hasSavedKey).toBe(true);
  });
});

describe("hasSavedKey 装饰", () => {
  it("有 Key 的项 hasSavedKey=true，无 Key 的为 false，且不回传明文", async () => {
    const store = makeStore();
    await store.saveProviders([
      provider("p1", { apiKey: "k1" }),
      provider("p2")
    ]);
    const list = await store.loadProviders();
    expect(list.find((p) => p.id === "p1").hasSavedKey).toBe(true);
    expect(list.find((p) => p.id === "p2").hasSavedKey).toBe(false);
    for (const item of list) {
      expect(item).not.toHaveProperty("apiKey");
    }
  });
});

describe("deleteProvider", () => {
  it("删除平台时其已存 Key 一并清理，其它平台不受影响", async () => {
    const store = makeStore();
    await store.saveProviders([
      provider("p1", { apiKey: "k1" }),
      provider("p2", { apiKey: "k2" })
    ]);
    const after = await store.deleteProvider("p1");
    // 返回列表只剩 p2，且带正确的 hasSavedKey
    expect(after).toEqual([{ id: "p2", name: "P p2", model: "m-p2", hasSavedKey: true }]);
    // p1 的 Key 被清理
    expect(localStorage.testProviderKeys).toEqual({ p2: "k2" });
    // sync 列表只剩 p2，且不带 hasSavedKey / apiKey 字段
    expect(syncStorage.testProviders).toEqual([
      { id: "p2", name: "P p2", model: "m-p2" }
    ]);
  });

  it("删除不存在的平台不抛错、不清理其它 Key", async () => {
    const store = makeStore();
    await store.saveProviders([provider("p1", { apiKey: "k1" })]);
    const after = await store.deleteProvider("nonexistent");
    expect(after).toHaveLength(1);
    expect(localStorage.testProviderKeys).toEqual({ p1: "k1" });
  });
});

describe("Key 侧通道：loadKeys / getKey / saveKey", () => {
  it("getKey 返回 trim 后的 Key，空 id 返回空串", async () => {
    const store = makeStore();
    await store.saveProviders([provider("p1", { apiKey: "  spaced  " })]);
    expect(await store.getKey("p1")).toBe("spaced");
    expect(await store.getKey("missing")).toBe("");
    expect(await store.getKey("")).toBe("");
    expect(await store.getKey(null)).toBe("");
  });

  it("saveKey 非空写入、空值清除", async () => {
    const store = makeStore();
    await store.saveKey("p1", "abc");
    expect(await store.loadKeys()).toEqual({ p1: "abc" });
    await store.saveKey("p1", "   ");
    expect(await store.loadKeys()).toEqual({});
  });
});
