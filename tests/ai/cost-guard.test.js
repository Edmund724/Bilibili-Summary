// ai/cost-guard.js 成本护栏纯函数测试（08 票）：
// 覆盖触发阈值（≥5 弹 / <5 与单次不弹 / 非数负空不弹）、
// notice 文案（含两次估数：N 次调用 / X token，可取消）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let mod;

async function importModules() {
  vi.resetModules();
  resetModuleState();
  mod = await import("../../extension/ai/cost-guard.js");
}

beforeEach(async () => {
  await importModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("触发阈值", () => {
  it("COST_GUARD_MIN_CALLS = 5", () => {
    expect(mod.COST_GUARD_MIN_CALLS).toBe(5);
  });

  it("预估 ≥5 次调用 → true", () => {
    expect(mod.shouldPromptCostGuard(5)).toBe(true);
    expect(mod.shouldPromptCostGuard(6)).toBe(true);
    expect(mod.shouldPromptCostGuard(100)).toBe(true);
  });

  it("预估 <5 → false（含单次路径 1 次调用不弹）", () => {
    expect(mod.shouldPromptCostGuard(1)).toBe(false);
    expect(mod.shouldPromptCostGuard(2)).toBe(false);
    expect(mod.shouldPromptCostGuard(4)).toBe(false);
  });

  it("非数 / 负 / 空 → false", () => {
    expect(mod.shouldPromptCostGuard(undefined)).toBe(false);
    expect(mod.shouldPromptCostGuard(null)).toBe(false);
    expect(mod.shouldPromptCostGuard("x")).toBe(false);
    expect(mod.shouldPromptCostGuard(NaN)).toBe(false);
    expect(mod.shouldPromptCostGuard(-5)).toBe(false);
    expect(mod.shouldPromptCostGuard(-1)).toBe(false);
    expect(mod.shouldPromptCostGuard("")).toBe(false);
  });
});

describe("buildCostGuardNotice", () => {
  it("触发时 shouldPrompt=true，文案含两次估数（N 次调用 / X token，可取消）", () => {
    const notice = mod.buildCostGuardNotice({ estimatedCalls: 5, estimatedTokens: 120000 });
    expect(notice.shouldPrompt).toBe(true);
    expect(notice.message).toBe("预计约 5 次调用 / 约 120,000 token，可取消");
  });

  it("大数值 token 千分位格式化", () => {
    const notice = mod.buildCostGuardNotice({ estimatedCalls: 6, estimatedTokens: 1234567 });
    expect(notice.message).toBe("预计约 6 次调用 / 约 1,234,567 token，可取消");
  });

  it("未触发时 shouldPrompt=false、message 为空", () => {
    const notice = mod.buildCostGuardNotice({ estimatedCalls: 1, estimatedTokens: 80000 });
    expect(notice.shouldPrompt).toBe(false);
    expect(notice.message).toBe("");
  });

  it("缺失 / 非法入参不抛，按不触发处理", () => {
    expect(mod.buildCostGuardNotice()).toEqual({ shouldPrompt: false, message: "" });
    expect(mod.buildCostGuardNotice({ estimatedCalls: undefined, estimatedTokens: 100 })).toEqual({
      shouldPrompt: false,
      message: ""
    });
    expect(mod.buildCostGuardNotice({ estimatedCalls: -3, estimatedTokens: 100 })).toEqual({
      shouldPrompt: false,
      message: ""
    });
  });

  it("可直接复用预算器 plan.estimatedCalls / plan.estimatedTokens", async () => {
    const { buildBudgetPlan } = await import("../../extension/ai/budgeter.js");
    // 110k 字幕 → 3 段小结 + 1 次成稿 = 4 次调用：不弹
    const small = buildBudgetPlan({
      body: Array.from({ length: 22 }, (_, i) => ({ from: i * 5, to: i * 5 + 5, content: "x".repeat(5000) }))
    });
    expect(small.mode).toBe("map-reduce");
    expect(small.estimatedCalls).toBe(4);
    expect(mod.buildCostGuardNotice(small).shouldPrompt).toBe(false);

    // 600k 字幕 → 12 段小结 + 1 次成稿 + 归并层 = ≥5 次调用：弹
    const big = buildBudgetPlan({
      body: Array.from({ length: 120 }, (_, i) => ({ from: i * 5, to: i * 5 + 5, content: "x".repeat(5000) }))
    });
    expect(big.mode).toBe("map-reduce");
    expect(big.estimatedCalls).toBeGreaterThanOrEqual(5);
    const notice = mod.buildCostGuardNotice(big);
    expect(notice.shouldPrompt).toBe(true);
    expect(notice.message).toContain("次调用");
    expect(notice.message).toContain("token");
    expect(notice.message).toContain("可取消");
  });
});
