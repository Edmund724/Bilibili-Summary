// subtitle/selection.js 直测（候选10 批1）：
// - normalizeChapters 按输入数组引用的 WeakMap 缓存（同引用复用同一结果对象，
//   不同引用重新计算，去重/排序结果与原实现一致）；
// - sortSubtitleBodyByFrom 写入端稳定排序（findActiveSubtitleIndex 二分依赖的
//   「subtitleBody 按 from 升序」不变量的来源）。

import { beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  normalizeChapters,
  sortSubtitleBodyByFrom
} from "../../extension/subtitle/selection.js";

beforeEach(() => {
  resetModuleState();
});

describe("normalizeChapters：按引用缓存", () => {
  const input = [
    { title: "开场", from: 30, to: 60 },
    { title: "正片", from: 0, to: 30 },
    { title: "正片", from: 0, to: 30 } // 重复（同 from 同标题），应去重
  ];

  it("同引用返回同一结果对象（零重复归一化）", () => {
    const first = normalizeChapters(input);
    const second = normalizeChapters(input);
    expect(second).toBe(first);
  });

  it("不同引用（内容相同）重新计算：结果等价但不复用对象", () => {
    const first = normalizeChapters(input);
    const second = normalizeChapters([...input]);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  it("缓存下归一化语义不变：按 from 排序 + 去重 + 字段规整", () => {
    const result = normalizeChapters(input);
    expect(result).toEqual([
      { title: "正片", from: 0, to: 30, source: "" },
      { title: "开场", from: 30, to: 60, source: "" }
    ]);
    // 再取一次仍走缓存，结果一致
    expect(normalizeChapters(input)).toEqual(result);
  });

  it("空数组与非数组输入", () => {
    const empty = [];
    expect(normalizeChapters(empty)).toEqual([]);
    expect(normalizeChapters(empty)).toBe(normalizeChapters(empty)); // 同引用命中缓存
    expect(normalizeChapters(null)).toEqual([]);
    expect(normalizeChapters(undefined)).toEqual([]);
  });

  it("过滤无标题条目后缓存仍一致", () => {
    const messy = [{ title: "", from: 5 }, { title: "有效", from: 3 }];
    const first = normalizeChapters(messy);
    expect(first).toEqual([{ title: "有效", from: 3, to: 0, source: "" }]);
    expect(normalizeChapters(messy)).toBe(first);
  });
});

describe("sortSubtitleBodyByFrom：写入端稳定排序", () => {
  it("按 from 升序排列", () => {
    const body = [
      { from: 30, to: 40, content: "c" },
      { from: 0, to: 10, content: "a" },
      { from: 10, to: 20, content: "b" }
    ];
    expect(sortSubtitleBodyByFrom(body).map((item) => item.content)).toEqual(["a", "b", "c"]);
  });

  it("稳定：同 from 保持原有相对顺序", () => {
    const body = [
      { from: 5, to: 8, content: "first" },
      { from: 0, to: 5, content: "early" },
      { from: 5, to: 9, content: "second" }
    ];
    const sorted = sortSubtitleBodyByFrom(body);
    expect(sorted.map((item) => item.content)).toEqual(["early", "first", "second"]);
  });

  it("返回新数组，不原地修改入参", () => {
    const body = [{ from: 20 }, { from: 0 }];
    const sorted = sortSubtitleBodyByFrom(body);
    expect(sorted).not.toBe(body);
    expect(body.map((item) => item.from)).toEqual([20, 0]);
    expect(sorted.map((item) => item.from)).toEqual([0, 20]);
  });

  it("非数组输入原样透传（与读路径的防御语义一致）", () => {
    expect(sortSubtitleBodyByFrom(null)).toBe(null);
    expect(sortSubtitleBodyByFrom(undefined)).toBe(undefined);
    expect(sortSubtitleBodyByFrom([])).toEqual([]);
  });
});
