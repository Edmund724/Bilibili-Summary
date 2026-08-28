// ai/merge.js 归并层测试（07 票）：
// 覆盖阈值判定（>500k / needsMerge 触发，≤500k 沿用 03 直接成稿）、贪心分组
// （每组 ≤100k、单条超预算自成一组、空数组返回 []）、多层归并收敛
// （levels>0、终态合计 ≤100k、每组恰好调用一次）、进度文案（「正在归并第 L 层 a/b 组」）、
// prompt 措辞对齐蓝本 _merge_prompt，以及归并期间中止抛 aborted 标记错误。

import { describe, expect, it, vi } from "vitest";
import {
  shouldMerge,
  buildMergeGroups,
  buildMergePrompt,
  mergeSummaries
} from "../../extension/ai/merge.js";
import { MERGE_GROUP_INPUT_CHARS } from "../../extension/ai/budgeter.js";

// 生成 n 条各 chars 字符的小结（首字符序号区分，便于断言顺序保持）。
function makeSummaries(count, chars) {
  return Array.from({ length: count }, (_, i) => `s${i}`.padEnd(chars, "x"));
}

// 一组字符合计。
function groupChars(group) {
  return group.reduce((acc, s) => acc + s.length, 0);
}

describe("shouldMerge 阈值判定", () => {
  it("totalChars > 500000 触发归并；恰好 500000 不触发（沿用 03 直接成稿）", () => {
    expect(shouldMerge({ totalChars: 500001, segments: [] })).toBe(true);
    expect(shouldMerge({ totalChars: 500000, segments: [] })).toBe(false);
  });

  it("段数 ≥11 但 totalChars ≤500k（章节对齐切出短段）→ 不触发归并", () => {
    expect(shouldMerge({ segments: new Array(11).fill({}) })).toBe(false);
    expect(shouldMerge({ segments: new Array(11).fill({}), totalChars: 450000 })).toBe(false);
    expect(shouldMerge({ segments: new Array(11).fill({}), totalChars: 500001 })).toBe(true);
  });

  it("needsMerge 显式置真触发", () => {
    expect(shouldMerge({ needsMerge: true })).toBe(true);
  });

  it("空对象 / null / undefined 不触发", () => {
    expect(shouldMerge({})).toBe(false);
    expect(shouldMerge(null)).toBe(false);
    expect(shouldMerge(undefined)).toBe(false);
  });
});

describe("buildMergeGroups 贪心分组", () => {
  it("按输入顺序贪心累积，每组合计 ≤100k，顺序保持", () => {
    // 12 条 × 20k = 240k → 5+5+2 三组（每组恰 100k）
    const input = makeSummaries(12, 20000);
    const groups = buildMergeGroups(input);
    expect(groups).toHaveLength(3);
    for (const group of groups) {
      expect(groupChars(group)).toBeLessThanOrEqual(MERGE_GROUP_INPUT_CHARS);
    }
    expect(groups.flat()).toEqual(input);
  });

  it("单条超预算也自成一组（不拆条）", () => {
    const big = "x".repeat(150000);
    const groups = buildMergeGroups([big, "短小结"]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual([big]);
    expect(groups[1]).toEqual(["短小结"]);
  });

  it("单条恰好 100k 与后一条分属两组", () => {
    const groups = buildMergeGroups(["x".repeat(100000), "y"]);
    expect(groups).toHaveLength(2);
    expect(groups[0][0]).toHaveLength(100000);
    expect(groups[1]).toEqual(["y"]);
  });

  it("空数组 / 非数组返回 []", () => {
    expect(buildMergeGroups([])).toEqual([]);
    expect(buildMergeGroups(null)).toEqual([]);
    expect(buildMergeGroups("x")).toEqual([]);
  });
});

describe("buildMergePrompt 措辞对齐蓝本 _merge_prompt", () => {
  it("含标题、层/组序号、去重保时间点/前后关系与连续材料输出要求，条目以空行拼接", () => {
    const prompt = buildMergePrompt({
      title: "测试视频",
      level: 2,
      groupIndex: 1,
      groupCount: 3,
      group: ["片段A", "片段B"]
    });
    expect(prompt).toContain("视频标题：测试视频");
    expect(prompt).toContain("这是长视频内容的第 2 层归并，第 1/3 组。");
    expect(prompt).toContain(
      "请合并以下连续片段笔记，去除重复但保留观点、依据、例子、时间点和前后关系。"
    );
    expect(prompt).toContain("不要评价，不补充外部知识，只输出供最终成稿使用的连续材料。");
    expect(prompt).toContain("片段A\n\n片段B");
  });

  it("非数组 group 按空串处理不抛错", () => {
    const prompt = buildMergePrompt({
      title: "t",
      level: 1,
      groupIndex: 1,
      groupCount: 1,
      group: null
    });
    expect(prompt).toContain("这是长视频内容的第 1 层归并，第 1/1 组。");
  });
});

describe("mergeSummaries 多层归并收敛", () => {
  it("短串产出一次收敛：调用次数 = 组数，终态合计 ≤100k", async () => {
    // 11 条 × 10k = 110k → 10+1 两组，一层归并后骤降到 10 字符
    const summaries = makeSummaries(11, 10000);
    const runPrompts = vi.fn(async () => "组合并结果");
    const onProgress = vi.fn();

    const result = await mergeSummaries({
      summaries,
      title: "测试视频",
      runPrompts,
      onProgress
    });

    expect(result.levels).toBe(1);
    expect(runPrompts).toHaveBeenCalledTimes(2);
    expect(result.merged).toEqual(["组合并结果", "组合并结果"]);
    expect(groupChars(result.merged)).toBeLessThanOrEqual(MERGE_GROUP_INPUT_CHARS);
    // 进度文案：每组一条「正在归并第 L 层 a/b 组」
    expect(onProgress).toHaveBeenCalledTimes(2);
    for (const notice of onProgress.mock.calls.map((c) => c[0])) {
      expect(notice).toMatch(/^正在归并第 \d+ 层 \d+\/\d+ 组$/);
    }
  });

  it("多层归并直到合计 ≤100k：levels=2、每层每组恰好调用一次", async () => {
    // 30 条 × 10k = 300k：第 1 层 10/组 → 3 组；每条产出 40k → 3×40k=120k 仍超
    // → 第 2 层 40k+40k=80k 一组、40k 一组 → 2 组 → 2×40k=80k 收敛。
    const summaries = makeSummaries(30, 10000);
    const onProgress = vi.fn();
    const runPrompts = vi.fn(async () => "x".repeat(40000));

    const result = await mergeSummaries({
      summaries,
      title: "测试视频",
      runPrompts,
      onProgress
    });

    expect(result.levels).toBe(2);
    expect(result.merged).toHaveLength(2);
    expect(groupChars(result.merged)).toBeLessThanOrEqual(MERGE_GROUP_INPUT_CHARS);
    // 3 + 2 次调用，每个归并 prompt 带对应层/组序号
    expect(runPrompts).toHaveBeenCalledTimes(5);
    const prompts = runPrompts.mock.calls.map((c) => c[0].prompt);
    expect(prompts[0]).toContain("这是长视频内容的第 1 层归并，第 1/3 组。");
    expect(prompts[2]).toContain("这是长视频内容的第 1 层归并，第 3/3 组。");
    expect(prompts[3]).toContain("这是长视频内容的第 2 层归并，第 1/2 组。");
    expect(prompts[4]).toContain("这是长视频内容的第 2 层归并，第 2/2 组。");
    for (const prompt of prompts) {
      expect(prompt).toContain("视频标题：测试视频");
    }
    // 进度文案 5 条，格式统一
    expect(onProgress).toHaveBeenCalledTimes(5);
    for (const notice of onProgress.mock.calls.map((c) => c[0])) {
      expect(notice).toMatch(/^正在归并第 \d+ 层 \d+\/\d+ 组$/);
    }
  });

  it("组数不减少（单条超预算归并无收益）时保护性 break，不调 runPrompts", async () => {
    const big = "x".repeat(120000);
    const runPrompts = vi.fn(async () => "");
    const result = await mergeSummaries({ summaries: [big], title: "t", runPrompts });
    expect(result).toEqual({ merged: [big], levels: 0 });
    expect(runPrompts).not.toHaveBeenCalled();
  });

  it("空数组：levels=0、merged=[]、不调 runPrompts", async () => {
    const runPrompts = vi.fn();
    const result = await mergeSummaries({ summaries: [], title: "t", runPrompts });
    expect(result).toEqual({ merged: [], levels: 0 });
    expect(runPrompts).not.toHaveBeenCalled();
  });
});

describe("mergeSummaries 中止", () => {
  it("归并期间 signal 置 aborted → 抛带 aborted 标记的错误", async () => {
    const controller = new AbortController();
    const runPrompts = vi.fn(async () => {
      controller.abort();
      return "x";
    });

    await expect(
      mergeSummaries({
        summaries: makeSummaries(30, 10000),
        title: "t",
        runPrompts,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ aborted: true, message: "已停止生成" });
    // 第 2 组调用前被中止，只发出 1 次归并调用
    expect(runPrompts).toHaveBeenCalledTimes(1);
  });

  it("进入归并前已中止：一次模型调用都不发", async () => {
    const controller = new AbortController();
    controller.abort();
    const runPrompts = vi.fn();

    await expect(
      mergeSummaries({
        summaries: makeSummaries(30, 10000),
        title: "t",
        runPrompts,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ aborted: true });
    expect(runPrompts).not.toHaveBeenCalled();
  });
});
