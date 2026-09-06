// offscreen storage 桥单元测试（core/storage-bridge.ts）：
// - SW 端 handler 工厂：get（null 全量 / 单键 / 数组，缺键不出现）/ set / remove
//   （不存在键 no-op）/ 未知 op → ok:false；storage 抛错 → ok:false + 错误消息；
// - offscreen 端垫片安装器：仅 runtime 的桩 → 安装 local 且语义对齐原生；
//   有原生 storage 的宿主不覆盖；无 chrome 环境不抛错；桥端 ok:false → reject。

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createStorageLocalBridgeHandler, installStorageLocalBridge } from "../../extension/core/storage-bridge.js";

function makeMemoryArea() {
  const store = new Map();
  return {
    store,
    async get(keys) {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(store);
      }
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of wanted) if (store.has(k)) out[k] = store.get(k);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items || {})) store.set(k, v);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    }
  };
}

describe("createStorageLocalBridgeHandler（SW 端）", () => {
  it("get：null 全量 / 单键 / 数组，缺键不出现", async () => {
    const area = makeMemoryArea();
    await area.set({ a: 1, b: "x" });
    const handler = createStorageLocalBridgeHandler({ storageLocal: area });
    const call = (msg) => new Promise((resolve) => handler(msg, {}, resolve));

    expect(await call({ type: "storage-local-bridge", op: "get", keys: null })).toEqual({
      ok: true,
      data: { a: 1, b: "x" }
    });
    expect(await call({ type: "storage-local-bridge", op: "get", keys: "a" })).toEqual({ ok: true, data: { a: 1 } });
    expect(await call({ type: "storage-local-bridge", op: "get", keys: ["a", "zzz"] })).toEqual({ ok: true, data: { a: 1 } });
  });

  it("set 覆写、remove 对不存在键 no-op", async () => {
    const area = makeMemoryArea();
    const handler = createStorageLocalBridgeHandler({ storageLocal: area });
    const call = (msg) => new Promise((resolve) => handler(msg, {}, resolve));

    expect(await call({ type: "storage-local-bridge", op: "set", entries: { k: { v: 1 } } })).toEqual({ ok: true });
    expect(area.store.get("k")).toEqual({ v: 1 });
    expect(await call({ type: "storage-local-bridge", op: "remove", keys: ["k", "ghost"] })).toEqual({ ok: true });
    expect(area.store.has("k")).toBe(false);
  });

  it("未知 op 与 storage 抛错 → ok:false + 错误消息", async () => {
    const handler = createStorageLocalBridgeHandler({
      storageLocal: {
        get: vi.fn(async () => {
          throw new Error("boom-get");
        }),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {})
      }
    });
    const call = (msg) => new Promise((resolve) => handler(msg, {}, resolve));

    expect(await call({ type: "storage-local-bridge", op: "get", keys: null })).toMatchObject({ ok: false, error: "boom-get" });
    expect(await call({ type: "storage-local-bridge", op: "explode" })).toMatchObject({ ok: false });
  });
});

describe("installStorageLocalBridge（offscreen 端垫片）", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  function stubRuntimeOnly(routeBridge) {
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn(async (message) => routeBridge(message))
      }
    });
  }

  it("仅 runtime 的宿主 → 安装 local，get/set/remove 经消息桥语义对齐原生", async () => {
    const area = makeMemoryArea();
    const handler = createStorageLocalBridgeHandler({ storageLocal: area });
    stubRuntimeOnly((message) => {
      if (message?.type === "storage-local-bridge") {
        return new Promise((resolve) => handler(message, {}, resolve));
      }
      return { ok: true };
    });

    installStorageLocalBridge();
    const local = chrome.storage.local;
    expect(local).toBeTruthy();

    await local.set({ raw_1: { ts: 1 }, raw_2: { ts: 2 } });
    expect(area.store.get("raw_1")).toEqual({ ts: 1 });
    expect(await local.get("raw_1")).toEqual({ raw_1: { ts: 1 } });
    expect(await local.get(null)).toEqual({ raw_1: { ts: 1 }, raw_2: { ts: 2 } });
    expect(await local.get(["raw_2", "missing"])).toEqual({ raw_2: { ts: 2 } });
    await local.remove(["raw_1", "ghost"]);
    expect(await local.get("raw_1")).toEqual({});
  });

  it("有原生 storage 的宿主不覆盖现有 local", () => {
    const native = { get: vi.fn(), set: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("chrome", {
      runtime: { sendMessage: vi.fn() },
      storage: { local: native }
    });

    installStorageLocalBridge();
    expect(chrome.storage.local).toBe(native);
  });

  it("无 chrome 环境不抛错；桥端 ok:false → 垫片 reject", async () => {
    expect(() => installStorageLocalBridge()).not.toThrow();

    stubRuntimeOnly(async () => ({ ok: false, error: "SW 端炸了" }));
    installStorageLocalBridge();
    await expect(chrome.storage.local.get(null)).rejects.toThrow("SW 端炸了");
  });
});
