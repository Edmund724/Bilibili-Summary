// chrome.storage.onChanged 区/键过滤 seam（shared/watch-storage-keys）：
// - 单条真实监听：首个订阅者经 chrome.storage.onChanged.addListener 懒注册，
//   后续订阅者不再重复注册，末个退订 removeListener 摘除；
// - 键过滤：订阅者声明的区内键命中（自有属性）才分发，未命中不分发；
// - 区过滤：只声明 sync 的订阅不收 local（或其他区）事件；
// - 未声明键清单 = 不过滤：任意区任意键都分发；
// - unsubscribe 后不再收到，且退订同步摘除真实监听。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

function freshStorageStubs() {
  chrome.storage.onChanged.addListener = vi.fn();
  chrome.storage.onChanged.removeListener = vi.fn();
}

function storageChangeListener() {
  return chrome.storage.onChanged.addListener.mock.calls.at(-1)?.[0];
}

describe("shared/watch-storage-keys seam", () => {
  beforeEach(() => {
    resetModuleState();
    freshStorageStubs();
  });

  it("首个订阅者懒注册单条真实监听；键命中分发、他键与他区不分发", async () => {
    const { watchStorageKeys } = await import("../../extension/shared/watch-storage-keys.js");
    const handler = vi.fn();
    watchStorageKeys(handler, { sync: ["enableFoo"] });
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
    const listener = storageChangeListener();
    expect(listener).toBeTypeOf("function");

    listener({ enableFoo: { newValue: 1 } }, "sync");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ enableFoo: { newValue: 1 } }, "sync");

    // 同区他键：不分发
    listener({ enableBar: { newValue: 1 } }, "sync");
    // 命中键但区不对：不分发
    listener({ enableFoo: { newValue: 2 } }, "local");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("后续订阅者不重复注册；各订阅者按自己的区/键清单独立过滤", async () => {
    const { watchStorageKeys } = await import("../../extension/shared/watch-storage-keys.js");
    const syncWatcher = vi.fn();
    const localWatcher = vi.fn();
    watchStorageKeys(syncWatcher, { sync: ["a"] });
    watchStorageKeys(localWatcher, { local: ["b"] });
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
    const listener = storageChangeListener();

    listener({ a: { newValue: 1 } }, "sync");
    listener({ b: { newValue: 1 } }, "local");
    expect(syncWatcher).toHaveBeenCalledTimes(1);
    expect(localWatcher).toHaveBeenCalledTimes(1);

    listener({ b: { newValue: 2 } }, "sync");
    expect(syncWatcher).toHaveBeenCalledTimes(1);
    expect(localWatcher).toHaveBeenCalledTimes(1);
  });

  it("未声明键清单 = 不过滤：任意区任意键都分发", async () => {
    const { watchStorageKeys } = await import("../../extension/shared/watch-storage-keys.js");
    const handler = vi.fn();
    watchStorageKeys(handler);
    const listener = storageChangeListener();

    listener({ anything: { newValue: 1 } }, "sync");
    listener({ other: { newValue: 2 } }, "local");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe 后不再收到；末个退订摘除真实监听，再订阅重新注册", async () => {
    const { watchStorageKeys } = await import("../../extension/shared/watch-storage-keys.js");
    const handler = vi.fn();
    const unsubscribe = watchStorageKeys(handler, { sync: ["a"], local: ["b"] });
    const listener = storageChangeListener();

    unsubscribe();
    listener({ a: { newValue: 1 } }, "sync");
    listener({ b: { newValue: 1 } }, "local");
    expect(handler).not.toHaveBeenCalled();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledWith(listener);

    watchStorageKeys(handler, { sync: ["a"] });
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalledTimes(2);
    storageChangeListener()({ a: { newValue: 1 } }, "sync");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
