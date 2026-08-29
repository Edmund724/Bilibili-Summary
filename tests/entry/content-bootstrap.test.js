// entry/content-bootstrap.js 的加载器单测（候选4 分包）。
//
// 覆盖 bootstrap 拉起主包的四条契约：
//   - 成功加载：loadContentMain 解析出主包模块命名空间；
//   - 重复调用共享同一 promise（同一文档只发起一次模块加载）；
//   - 加载失败：promise reject，console.error 现场定位信息带主包路径与扩展
//     版本（生产上 chunk 加载失败的唯一可观测线索），且缓存清空允许重试；
//   - 防重复注入：STARTED 标志置位后再次 start 返回 null，不重复 import、
//     不覆盖哨兵。
//
// 动态 import 无法直接 stub，生产实现的 importModule 默认参数是真实 import()；
// 测试经工厂依赖注入 fake getExtensionUrl / importModule 代替。源模块顶层的
// 自动启动由 chrome?.runtime?.getURL 守卫挡住（setup.js 的 chrome stub 未提供
// getURL），不会在测试导入时真的加载主包。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONTENT_MAIN_MODULE_PATH,
  startContentBootstrap
} from "../../extension/entry/content-bootstrap.js";

const fakeGetExtensionUrl = (modulePath) => `chrome-extension://fake-id/${modulePath}`;

function cleanGlobals() {
  delete globalThis.__BOC_CONTENT_BOOTSTRAP_STARTED__;
  delete globalThis.__BOC_CONTENT_SCRIPT_LOADED__;
}

beforeEach(() => {
  cleanGlobals();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanGlobals();
});

describe("startContentBootstrap", () => {
  it("启动即置防重入标志与版本哨兵", () => {
    const bootstrap = startContentBootstrap({
      getExtensionUrl: fakeGetExtensionUrl,
      importModule: vi.fn()
    });
    expect(bootstrap).not.toBeNull();
    expect(globalThis.__BOC_CONTENT_BOOTSTRAP_STARTED__).toBe(true);
    // 哨兵值必须是版本字符串（background/popup 的运行时探针按版本比对）
    expect(typeof globalThis.__BOC_CONTENT_SCRIPT_LOADED__).toBe("string");
    expect(globalThis.__BOC_CONTENT_SCRIPT_LOADED__.length).toBeGreaterThan(0);
  });

  it("成功加载：loadContentMain 解析出 importModule 返回的模块命名空间", async () => {
    const mainNamespace = { default: "main" };
    const importModule = vi.fn().mockResolvedValue(mainNamespace);
    const { loadContentMain } = startContentBootstrap({
      getExtensionUrl: fakeGetExtensionUrl,
      importModule
    });

    await expect(loadContentMain()).resolves.toBe(mainNamespace);
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(importModule).toHaveBeenCalledWith(
      fakeGetExtensionUrl(CONTENT_MAIN_MODULE_PATH)
    );
  });

  it("重复调用共享同一 promise（不重复触发 import）", async () => {
    const mainNamespace = { default: "main" };
    const importModule = vi.fn().mockResolvedValue(mainNamespace);
    const { loadContentMain } = startContentBootstrap({
      getExtensionUrl: fakeGetExtensionUrl,
      importModule
    });

    const p1 = loadContentMain();
    const p2 = loadContentMain();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it("加载失败：reject 且 console.error 带主包路径与扩展版本；缓存清空允许重试", async () => {
    const failure = new Error("Failed to fetch dynamically imported module");
    const importModule = vi.fn().mockRejectedValue(failure);
    const { loadContentMain } = startContentBootstrap({
      getExtensionUrl: fakeGetExtensionUrl,
      importModule
    });

    await expect(loadContentMain()).rejects.toBe(failure);
    expect(importModule).toHaveBeenCalledTimes(1);

    // 现场定位契约：错误输出必须包含主包路径与扩展版本，否则生产上无法
    // 区分「WAR 配置缺失」与「产物没打进 zip」。
    expect(console.error).toHaveBeenCalledTimes(1);
    const logged = console.error.mock.calls[0].map(String).join(" ");
    expect(logged).toContain(CONTENT_MAIN_MODULE_PATH);
    expect(logged).toContain("extension v");

    // 失败后缓存清空：再次调用重新发起加载（重试语义）
    await expect(loadContentMain()).rejects.toBe(failure);
    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it("防重复注入：STARTED 标志已置位时再次 start 返回 null 且不重复 import", async () => {
    const importModule = vi.fn().mockResolvedValue({});
    const first = startContentBootstrap({
      getExtensionUrl: fakeGetExtensionUrl,
      importModule
    });
    // import 经 Promise.resolve().then 异步发起，先等到它真正跑过一次
    await first.loadContentMain();
    expect(importModule).toHaveBeenCalledTimes(1);

    const sentinelBefore = globalThis.__BOC_CONTENT_SCRIPT_LOADED__;
    const second = startContentBootstrap({
      getExtensionUrl: fakeGetExtensionUrl,
      importModule
    });
    expect(second).toBeNull();
    // 哨兵不被第二次注入覆盖，importModule 也未被新的闭包再次调用
    expect(globalThis.__BOC_CONTENT_SCRIPT_LOADED__).toBe(sentinelBefore);
    expect(importModule).toHaveBeenCalledTimes(1);
  });
});
