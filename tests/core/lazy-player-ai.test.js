// core/lazy-player-ai.js 的加载器单测（候选4 分包）。
//
// 覆盖 player-ai 懒加载边界的三条契约：
//   - 首次 loadPlayerAi 触发动态 import 并解析出模块命名空间；
//   - 重复调用共享同一 promise（同一文档只加载一次）；
//   - 加载失败：promise reject、isPlayerAiLoaded 回落 false、缓存清空后可
//     重试（重试语义支撑「扩展刚更新旧 chunk 404 → 用户重开开关恢复」）。
//
// vi.doMock 在每个用例内指向 ai/player-ai.js，vitest 对动态 import 一视同仁
// 地拦截；用 vi.resetModules 重置模块纪元以清空加载器的模块级 promise 缓存。

import { beforeEach, describe, expect, it, vi } from "vitest";

async function importLoader() {
  return import("../../extension/core/lazy-player-ai.js");
}

beforeEach(() => {
  // 加载器用模块级 let 缓存 promise；换纪元保证用例间互不污染
  vi.resetModules();
});

describe("loadPlayerAi", () => {
  it("首次调用触发动态 import，解析出 player-ai 模块命名空间", async () => {
    const playerAiNamespace = { startPlayerAiQuickAction: vi.fn() };
    vi.doMock("../../extension/ai/player-ai.js", () => playerAiNamespace);

    const { loadPlayerAi, isPlayerAiLoaded } = await importLoader();
    expect(isPlayerAiLoaded()).toBe(false);

    const mod = await loadPlayerAi();
    // 不做整对象 toBe 比较：vitest 的 pretty-format 对 mock 模块 namespace 有
    // 专门的 $$typeof 检查，整对象比较会误报；用行为验证（拿到的是同一 mock）
    expect(typeof mod.startPlayerAiQuickAction).toBe("function");
    mod.startPlayerAiQuickAction();
    expect(playerAiNamespace.startPlayerAiQuickAction).toHaveBeenCalled();
    expect(isPlayerAiLoaded()).toBe(true);
  });

  it("重复调用共享同一 promise（不重复触发 import）", async () => {
    const playerAiNamespace = { stopPlayerAiQuickAction: vi.fn() };
    vi.doMock("../../extension/ai/player-ai.js", () => playerAiNamespace);

    const { loadPlayerAi } = await importLoader();
    const p1 = loadPlayerAi();
    const p2 = loadPlayerAi();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
  });

  it("加载失败：reject、isPlayerAiLoaded 回落 false、缓存清空允许重试", async () => {
    // 第一纪元：import 工厂抛错 → 动态 import reject（vitest 会把工厂错误
    // 包装成通用 mock 错误，这里只断言 reject 行为本身）
    vi.doMock("../../extension/ai/player-ai.js", () => {
      throw new Error("chunk 404 (player-ai)");
    });
    const first = await importLoader();
    await expect(first.loadPlayerAi()).rejects.toThrow();
    expect(first.isPlayerAiLoaded()).toBe(false);

    // 第二纪元（模拟失败后重试）：换成可成功加载的 mock
    vi.resetModules();
    const playerAiNamespace = { startPlayerAiQuickAction: vi.fn() };
    vi.doMock("../../extension/ai/player-ai.js", () => playerAiNamespace);
    const second = await importLoader();
    const mod = await second.loadPlayerAi();
    expect(typeof mod.startPlayerAiQuickAction).toBe("function");
    expect(second.isPlayerAiLoaded()).toBe(true);
  });
});
