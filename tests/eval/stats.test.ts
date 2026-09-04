// stats 单测：null 计失败、样本剔除、mean/median 精度、偶数 median、全空边界。

import { describe, expect, it } from "vitest";
import { summarizeRun } from "../../eval/lib/stats.js";

describe("summarizeRun", () => {
  it("全有效样本：mean/median 正确，成功数=样本数", () => {
    const stats = summarizeRun([100, 200, 300]);
    expect(stats.samples).toEqual([100, 200, 300]);
    expect(stats.mean).toBe(200);
    expect(stats.median).toBe(200);
    expect(stats.successCount).toBe(3);
    expect(stats.failCount).toBe(0);
  });

  it("null 计为失败，不入 samples", () => {
    const stats = summarizeRun([100, null, 300]);
    expect(stats.samples).toEqual([100, 300]);
    expect(stats.successCount).toBe(2);
    expect(stats.failCount).toBe(1);
    expect(stats.mean).toBe(200);
  });

  it("偶数样本 median 取中间两数平均", () => {
    const stats = summarizeRun([10, 20, 30, 40]);
    expect(stats.median).toBe(25);
    expect(stats.mean).toBe(25);
  });

  it("median 排序后取中位（不依赖传入顺序）", () => {
    expect(summarizeRun([300, 100, 200]).median).toBe(200);
    expect(summarizeRun([5, 1, 4, 2]).median).toBe(3);
  });

  it("mean/median 保留小数精度", () => {
    const stats = summarizeRun([1, 2]);
    expect(stats.mean).toBe(1.5);
    expect(stats.median).toBe(1.5);
  });

  it("全 null：samples 空、mean/median 为 null", () => {
    const stats = summarizeRun([null, null]);
    expect(stats.samples).toEqual([]);
    expect(stats.mean).toBeNull();
    expect(stats.median).toBeNull();
    expect(stats.successCount).toBe(0);
    expect(stats.failCount).toBe(2);
  });

  it("空输入：samples 空、mean/median 为 null", () => {
    const stats = summarizeRun([]);
    expect(stats.samples).toEqual([]);
    expect(stats.mean).toBeNull();
    expect(stats.median).toBeNull();
    expect(stats.successCount).toBe(0);
    expect(stats.failCount).toBe(0);
  });
});
