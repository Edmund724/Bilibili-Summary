// timestamp-detect 单测：响应结构判定、文本内嵌判定、命中模式顺序与去重。

import { describe, expect, it } from "vitest";
import { detectTimestamps } from "../../eval/lib/timestamp-detect.js";

const HMS = /\[\d{1,2}:\d{2}:\d{2}\]/;
const MMSS = /\[\d{1,2}:\d{2}\]/;
const BRACE = /\{\d+\}/;

describe("detectTimestamps", () => {
  it("segments 非空数组 → hasResponseStructure=true", () => {
    const result = detectTimestamps(
      { text: "你好", segments: [{ from: 0, to: 5, content: "你好" }] },
      [HMS]
    );
    expect(result.hasResponseStructure).toBe(true);
    expect(result.hasInline).toBe(false);
    expect(result.matchedPatterns).toEqual([]);
  });

  it("segments 为空数组 / 缺失 / 非数组 → hasResponseStructure=false", () => {
    expect(detectTimestamps({ text: "", segments: [] }, []).hasResponseStructure).toBe(false);
    expect(detectTimestamps({ text: "" }, []).hasResponseStructure).toBe(false);
    expect(
      detectTimestamps({ text: "", segments: "not-array" }, []).hasResponseStructure
    ).toBe(false);
  });

  it("任一 pattern 命中 → hasInline=true，收集命中 pattern 的 source", () => {
    const result = detectTimestamps({ text: "[00:01] 开场 [00:01:30] 结束" }, [HMS, MMSS, BRACE]);
    expect(result.hasInline).toBe(true);
    expect(result.matchedPatterns).toEqual([HMS.source, MMSS.source]);
  });

  it("所有 pattern 不命中 → hasInline=false", () => {
    const result = detectTimestamps({ text: "没有任何时间标记" }, [HMS, BRACE]);
    expect(result.hasInline).toBe(false);
    expect(result.matchedPatterns).toEqual([]);
  });

  it("matchedPatterns 保序且去重（同 source 不同 flags 只记一次）", () => {
    const a = /\[\d{1,2}:\d{2}\]/g;
    const b = /\[\d{1,2}:\d{2}\]/i;
    const result = detectTimestamps({ text: "[12:34] 内容" }, [a, b, BRACE]);
    expect(result.matchedPatterns).toEqual([a.source]);
  });
});
