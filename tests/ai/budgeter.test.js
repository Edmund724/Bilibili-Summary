// ai/budgeter.js 预算器纯函数测试：
// 覆盖估 token、章节对齐、无章节回退、100k / 110k / 500k / 501k 各档、
// 空输入、缺 content、非字符串 estimateTokens。

import { describe, expect, it } from "vitest";
import { makeSubtitleBody } from "../setup.js";
import {
  buildBudgetPlan,
  estimateTokens,
  CHAR_PER_TOKEN,
  MATERIAL_BUDGET_CHARS,
  MODEL_WINDOW_CHARS,
  SEGMENT_INPUT_CHARS,
  SEGMENT_SUMMARY_CHARS,
  MERGE_GROUP_INPUT_CHARS,
  FINAL_OUTPUT_CHARS,
  MERGE_TRIGGER_CHARS
} from "../../extension/ai/budgeter.js";

describe("常量单一事实来源", () => {
  it("素材预算 / 窗口 / 段 / 归并 / 成稿 / 系数与 ADR-0001 对齐", () => {
    expect(CHAR_PER_TOKEN).toBe(1.0);
    expect(MATERIAL_BUDGET_CHARS).toBe(100000);
    expect(MODEL_WINDOW_CHARS).toBe(256000);
    expect(SEGMENT_INPUT_CHARS).toBe(50000);
    expect(SEGMENT_SUMMARY_CHARS).toBe(10000);
    expect(MERGE_GROUP_INPUT_CHARS).toBe(100000);
    expect(FINAL_OUTPUT_CHARS).toBe(16000);
    expect(MERGE_TRIGGER_CHARS).toBe(500000);
  });
});

describe("estimateTokens", () => {
  it("非字符串返回 0", () => {
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(12345)).toBe(0);
    expect(estimateTokens({ length: 5 })).toBe(0);
    expect(estimateTokens(["ab"])).toBe(0);
  });

  it("空串 / 空白串按字符数（不含 trim）处理", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("   ")).toBe(3);
  });

  it("字符数 × 1.0（中文按字符逐个计）", () => {
    expect(estimateTokens("你好")).toBe(2);
    expect(estimateTokens("hello world")).toBe(11);
    expect(estimateTokens("x".repeat(1000))).toBe(1000);
  });
});

describe("buildBudgetPlan 判模式与各档位", () => {
  it("空输入（body 缺省 / chapters 缺省）→ single 空计划", () => {
    const plan = buildBudgetPlan();
    expect(plan.totalChars).toBe(0);
    expect(plan.estimatedTokens).toBe(0);
    expect(plan.mode).toBe("single");
    expect(plan.segments).toEqual([]);
    expect(plan.estimatedCalls).toBe(1);
    expect(plan.needsMerge).toBe(false);
  });

  it("body=[] 显式空数组 → single，1 次调用", () => {
    const plan = buildBudgetPlan({ body: [] });
    expect(plan.mode).toBe("single");
    expect(plan.segments).toEqual([]);
    expect(plan.estimatedCalls).toBe(1);
    expect(plan.needsMerge).toBe(false);
  });

  it("恰好 100k → single，整篇一次成稿", () => {
    const plan = buildBudgetPlan({ body: makeSubtitleBody(100000) });
    expect(plan.totalChars).toBe(100000);
    expect(plan.estimatedTokens).toBe(100000);
    expect(plan.mode).toBe("single");
    expect(plan.segments).toEqual([]);
    expect(plan.estimatedCalls).toBe(1);
    expect(plan.needsMerge).toBe(false);
  });

  it("100k 边界一越（100001）→ map-reduce", () => {
    const plan = buildBudgetPlan({ body: makeSubtitleBody(100001) });
    expect(plan.mode).toBe("map-reduce");
    expect(plan.segments.length).toBe(3);
    expect(plan.estimatedCalls).toBe(4);
    expect(plan.needsMerge).toBe(false);
  });

  it("110k → 3 段小结 + 1 次成稿 ≈ 4 次调用（ADR 示例）", () => {
    const plan = buildBudgetPlan({ body: makeSubtitleBody(110000) });
    expect(plan.totalChars).toBe(110000);
    expect(plan.mode).toBe("map-reduce");
    expect(plan.segments).toHaveLength(3);
    expect(plan.segments.map((s) => s.chars)).toEqual([50000, 50000, 10000]);
    expect(plan.estimatedCalls).toBe(4);
    expect(plan.needsMerge).toBe(false);
  });

  it("500k 恰好触发线下 → 10 段，不归并（needsMerge=false）", () => {
    const plan = buildBudgetPlan({ body: makeSubtitleBody(500000) });
    expect(plan.mode).toBe("map-reduce");
    expect(plan.segments).toHaveLength(10);
    expect(plan.needsMerge).toBe(false);
    expect(plan.estimatedCalls).toBe(11); // 段数 + 成稿，无归并层
  });

  it("501k（>500k）→ 11 段 + 归并调用，调用数超过段数+1", () => {
    const plan = buildBudgetPlan({ body: makeSubtitleBody(501000) });
    expect(plan.mode).toBe("map-reduce");
    expect(plan.segments).toHaveLength(11);
    expect(plan.needsMerge).toBe(true);
    expect(plan.estimatedCalls).toBeGreaterThan(plan.segments.length + 1);
    expect(plan.estimatedCalls).toBe(15); // 11 段 + 1 成稿 + 3 次归并（2 组 + 1 组）
  });

  it("estimatedCalls 随长度增长而增大（501k < 1000k）", () => {
    const small = buildBudgetPlan({ body: makeSubtitleBody(501000) });
    const large = buildBudgetPlan({ body: makeSubtitleBody(1000000) });
    expect(large.estimatedCalls).toBeGreaterThan(small.estimatedCalls);
  });
});

describe("buildBudgetPlan 分段边界", () => {
  it("无章节：按时间戳顺序累积到 50k 预算收段", () => {
    const plan = buildBudgetPlan({ body: makeSubtitleBody(110000) });
    expect(plan.mode).toBe("map-reduce");
    expect(plan.segments[0].from).toBe(0);
    expect(plan.segments[0].to).toBe(250); // 第 50 项（from 245）的 to
    expect(plan.segments[0].chars).toBe(50000);
    expect(plan.segments[0].items).toHaveLength(50);
    expect(plan.segments[2].items).toHaveLength(10);
  });

  it("命中章节 from：在章节起点切断对齐（段尾停在上一章结尾）", () => {
    const body = makeSubtitleBody(120000); // 120 项，逐项 from = i*5
    const chapters = [{ from: 100, to: 200, title: "第二章" }];
    const plan = buildBudgetPlan({ body, chapters });
    expect(plan.mode).toBe("map-reduce");
    // 未命中章节时首段会累积 50 项（from 0..245）；命中 from=100 后，第 20 项（to=100）收段。
    expect(plan.segments).toHaveLength(3);
    expect(plan.segments[0].from).toBe(0);
    expect(plan.segments[0].to).toBe(100);
    expect(plan.segments[0].chars).toBe(20000);
    expect(plan.segments[0].items).toHaveLength(20);
    expect(plan.segments[1].from).toBe(100);
    expect(plan.segments[1].chars).toBe(50000);
  });

  it("章节 from 落在两条字幕之间（非逐秒相等）也按边界对齐", () => {
    const body = makeSubtitleBody(120000); // 120 项，逐项 from = i*5
    const chapters = [{ from: 102, to: 200, title: "第二章" }];
    const plan = buildBudgetPlan({ body, chapters });
    expect(plan.mode).toBe("map-reduce");
    // 第 21 项（from=105）跨入章节，前一条 from=100 处收段（无需字幕与章节时间戳逐秒相等）。
    expect(plan.segments[0].from).toBe(0);
    expect(plan.segments[0].to).toBe(105);
    expect(plan.segments[0].items).toHaveLength(21);
    expect(plan.segments[1].from).toBe(105);
  });

  it("空 content 项跳过计入，且 from/to 映回段内首末非空项", () => {
    const body = makeSubtitleBody(130000);
    body[50].content = ""; // 第 51 项（from 250）为空，被跳过
    const plan = buildBudgetPlan({ body });
    expect(plan.totalChars).toBe(130000 - 1000);
    expect(plan.mode).toBe("map-reduce");
    expect(plan.segments).toHaveLength(3);
    expect(plan.segments[0].items).toHaveLength(50);
    expect(plan.segments[0].from).toBe(0);
    expect(plan.segments[0].to).toBe(250); // 停在空项之前的第 50 项（to=250）
    expect(plan.segments[1].from).toBe(255); // 跳过空项后从第 52 项继续
  });

  it("body 项缺 content / trim 后为空 → 不计入、跳过", () => {
    const body = [
      { from: 0, to: 2, content: "hello" },
      { from: 2, to: 4 }, // 缺 content
      { from: 4, to: 6, content: "   " }, // trim 后为空
      { from: 6, to: 8, content: "world" }
    ];
    const plan = buildBudgetPlan({ body });
    expect(plan.totalChars).toBe(10);
    expect(plan.estimatedTokens).toBe(10);
    expect(plan.mode).toBe("single");
    expect(plan.segments).toEqual([]);
    expect(plan.estimatedCalls).toBe(1);
  });
});
