// 时刻文本单源模块测试（arch-slim-2/08）：
// formatClock（不补零展示，拍板 Q1）/ parseClock（严口径解析 + 过渡期补零容错）/
// withHours 两档谓词（条目级 / 元数据级聚合前的单点判定）。三个历史解析器
// （parseOutlineClock / parseTimestampSeconds / parseTimestampToSeconds）的哨兵
// 语义差异在各自消费方断言：outline -1 丢条目见 tests/ai/analysis.test.js、
// nav 0 哨兵见 tests/ui/timestamp-nav.test.ts。

import { describe, expect, it } from "vitest";
import {
  formatClock,
  parseClock,
  shouldUseHours,
  shouldUseHoursForRange
} from "../../extension/shared/clock-text.js";

describe("formatClock：秒 → 时刻文本（不补零）", () => {
  it("never 档（默认）：M:SS，分钟不封顶", () => {
    expect(formatClock(5)).toBe("0:05");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(600)).toBe("10:00");
    // 拍板口径：分钟不封顶（沿原 formatAnalysisClock），3725 → 62:05
    expect(formatClock(3725)).toBe("62:05");
  });

  it("always 档：恒带小时位且不补零", () => {
    expect(formatClock(5, { hours: "always" })).toBe("0:00:05");
    expect(formatClock(3725, { hours: "always" })).toBe("1:02:05");
    expect(formatClock(3600, { hours: true })).toBe("1:00:00");
  });

  it("auto 档：≥3600 带 小时位，否则 never", () => {
    expect(formatClock(3599, { hours: "auto" })).toBe("59:59");
    expect(formatClock(3600, { hours: "auto" })).toBe("1:00:00");
    expect(formatClock(3661, { hours: "auto" })).toBe("1:01:01");
  });

  it("非有限 / 负值 / 小数秒归一", () => {
    expect(formatClock(-5)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
    expect(formatClock("abc")).toBe("0:00");
    expect(formatClock(65.9)).toBe("1:05");
    expect(formatClock(null, { hours: "always" })).toBe("0:00:00");
  });
});

describe("parseClock：时刻文本 → 秒（严口径 + 过渡期补零容错）", () => {
  it("2 段与 3 段均可解析，段序不补零", () => {
    expect(parseClock("0:05")).toBe(5);
    expect(parseClock("2:30")).toBe(150);
    expect(parseClock("62:05")).toBe(3725); // 分钟不封顶
    expect(parseClock("1:02:05")).toBe(3725);
  });

  it("补零形态与不补零同值（历史缓存/旧笔记过渡期容错）", () => {
    expect(parseClock("00:05")).toBe(5);
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("01:02:05")).toBe(3725);
  });

  it("拒绝非法时刻：ss ≥60（2/3 段一律）、3 段 mm ≥60、hh ≥24、负段、段数不对", () => {
    expect(parseClock("99:99")).toBeNull();
    expect(parseClock("0:60")).toBeNull();
    expect(parseClock("1:60:00")).toBeNull();
    expect(parseClock("24:00:00")).toBeNull();
    expect(parseClock("12:34:56:78")).toBeNull();
    expect(parseClock("90")).toBeNull();
    expect(parseClock("-1:00")).toBeNull();
    expect(parseClock("")).toBeNull();
  });

  it("2 段分钟位不封顶：formatClock never 档的产出必须可回读", () => {
    expect(parseClock("60:00")).toBe(3600); // 60:00 = formatClock(3600)
    expect(parseClock("99:59")).toBe(5999);
    expect(parseClock("62:05")).toBe(3725);
  });

  it("非字符串输入返回 null（不抛）", () => {
    expect(parseClock(null)).toBeNull();
    expect(parseClock(undefined)).toBeNull();
    expect(parseClock(123)).toBeNull();
  });
});

describe("withHours 两档谓词", () => {
  it("shouldUseHours：单点判定，3600 为界，非有限为 false", () => {
    expect(shouldUseHours(3599)).toBe(false);
    expect(shouldUseHours(3600)).toBe(true);
    expect(shouldUseHours("7200")).toBe(true);
    expect(shouldUseHours(Number.NaN)).toBe(false);
    expect(shouldUseHours(-1)).toBe(false);
  });

  it("shouldUseHoursForRange：区间两端任一达小时级即 true（沿 map-reduce 口径）", () => {
    expect(shouldUseHoursForRange(3599, 3601)).toBe(true);
    expect(shouldUseHoursForRange(3600, 3600)).toBe(true);
    expect(shouldUseHoursForRange(0, 3599)).toBe(false);
  });
});
