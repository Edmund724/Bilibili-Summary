// @vitest-environment node
// 回归测试：withTimeout 必须在无 window 的 context（MV3 service worker）可用。
// 用户症状（修复前）：视频页首点播放器 AI 键一键总结，侧边栏报
// "当前页面上下文读取失败。"——background 的 getAiContextState 刷新分支调用
// withTimeout，其实现用了 window.setTimeout；SW 全局无 window，Promise 执行器
// 同步抛 ReferenceError 使限期竞速立即拒绝，错误经静默发送路径坍缩成通用文案。
// jsdom 全局环境恒有 window，此缺陷被全量测试掩盖，故本文件钉 node 环境。

import { describe, expect, it } from "vitest";

import { withTimeout } from "../../extension/shared/error-helpers.js";

describe("withTimeout（无 window 的 SW 环境）", () => {
  it("软超时：到点未完成则兑现 undefined", async () => {
    const pending = new Promise(() => {});
    await expect(withTimeout(pending, 20)).resolves.toBeUndefined();
  });

  it("硬超时：到点未完成则以 timeoutError 拒绝", async () => {
    const pending = new Promise(() => {});
    await expect(withTimeout(pending, 20, new Error("超时"))).rejects.toThrow("超时");
  });

  it("promise 先于超时完成则透传结果", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000)).resolves.toBe("ok");
  });

  it("promise 先于超时拒绝则透传异常", async () => {
    await expect(withTimeout(Promise.reject(new Error("失败")), 1000)).rejects.toThrow("失败");
  });
});
