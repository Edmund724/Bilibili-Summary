// report 单测：buildReport 聚合重算一致性、renderMarkdown 结构与截断。

import { describe, expect, it } from "vitest";
import {
  buildReport,
  renderMarkdown,
  type PerModelReport,
  type RunReport
} from "../../eval/lib/report.js";

function makeRun(overrides: Partial<RunReport>): RunReport {
  return {
    runIndex: 0,
    wallMs: 1000,
    segmentCount: 3,
    failedChunks: 0,
    requestTimings: [],
    segmentMeanMs: 100,
    rtf: 0.1,
    success: true,
    ...overrides
  };
}

const detection = { hasResponseStructure: false, hasInline: true, matchedPatterns: ["\\[\\d+:\\d+\\]"] };

function makeModelReport(overrides: Partial<PerModelReport>): PerModelReport {
  return {
    model: "test/model",
    runs: [makeRun({})],
    aggregate: {
      segmentMeanMean: null,
      wallMean: null,
      rtfMean: null,
      successCount: 0
    },
    timestamps: detection,
    sampleText: "样例",
    skipped: false,
    ...overrides
  };
}

describe("buildReport", () => {
  const meta = {
    generatedAt: "2026-09-04T00:00:00.000Z",
    audioName: "sample.wav",
    audioDurationSec: 300,
    config: { chunkSeconds: 120, runs: 3 }
  };

  it("返回 meta + models 原样结构", () => {
    const report = buildReport({ models: [makeModelReport({})], meta });
    expect(report.meta).toBe(meta);
    expect(report.models).toHaveLength(1);
    expect(report.models[0].model).toBe("test/model");
    expect(report.models[0].timestamps).toEqual(detection);
  });

  it("aggregate 以 runs 为准重算：均值忽略 null，成功数按 success", () => {
    const model = makeModelReport({
      runs: [
        makeRun({ runIndex: 0, wallMs: 1000, segmentMeanMs: 100, rtf: 0.1, success: true }),
        makeRun({ runIndex: 1, wallMs: 2000, segmentMeanMs: null, rtf: null, success: false }),
        makeRun({ runIndex: 2, wallMs: 3000, segmentMeanMs: 200, rtf: 0.3, success: true })
      ],
      // 传入的 aggregate 与 runs 不一致（应被重算覆盖）
      aggregate: {
        segmentMeanMean: 999,
        wallMean: 999,
        rtfMean: 999,
        successCount: 999
      }
    });

    const [built] = buildReport({ models: [model], meta }).models;
    expect(built.aggregate.segmentMeanMean).toBeCloseTo(150, 10);
    expect(built.aggregate.wallMean).toBe(2000);
    expect(built.aggregate.rtfMean).toBeCloseTo(0.2, 10);
    expect(built.aggregate.successCount).toBe(2);
  });

  it("全部失败 run → 聚合均值均为 null", () => {
    const model = makeModelReport({
      runs: [makeRun({ wallMs: 1000, segmentMeanMs: null, rtf: null, success: false })]
    });
    const [built] = buildReport({ models: [model], meta }).models;
    expect(built.aggregate.segmentMeanMean).toBeNull();
    expect(built.aggregate.wallMean).toBeNull();
    expect(built.aggregate.rtfMean).toBeNull();
    expect(built.aggregate.successCount).toBe(0);
  });
});

describe("renderMarkdown", () => {
  const meta = {
    generatedAt: "2026-09-04T00:00:00.000Z",
    audioName: "sample.wav",
    audioDurationSec: 300,
    config: { chunkSeconds: 120, runs: 3 }
  };

  it("顶部 meta（时间/音频/时长/配置）", () => {
    const md = renderMarkdown(buildReport({ models: [], meta }));
    expect(md).toContain("2026-09-04T00:00:00.000Z");
    expect(md).toContain("sample.wav");
    expect(md).toContain("300");
    expect(md).toContain("chunkSeconds=120");
  });

  it("每模型一节：模型 ID、时间戳三行、样例文本、runs 表格、aggregate 行", () => {
    const model = makeModelReport({
      model: "vendor/m-a",
      sampleText: "这是转写样例",
      runs: [
        makeRun({ runIndex: 0, wallMs: 1200, segmentMeanMs: 340, rtf: 0.4, success: true }),
        makeRun({ runIndex: 1, wallMs: 1500, segmentMeanMs: null, rtf: null, success: false })
      ]
    });
    const md = renderMarkdown(buildReport({ models: [model], meta }));

    expect(md).toContain("## vendor/m-a");
    expect(md).toContain("响应结构 segments = 否");
    expect(md).toContain("文本内嵌 = 是");
    expect(md).toContain("\\[\\d+:\\d+\\]");
    expect(md).toContain("这是转写样例");
    expect(md).toContain("| runIndex | wallMs (ms) | segmentMeanMs (ms) | rtf | 成功 |");
    expect(md).toContain("| 0 | 1200 | 340 | 0.4 | ✓ |");
    expect(md).toContain("| 1 | 1500 | FAIL | FAIL | ✗ |");
    expect(md).toContain("成功 1/2");
  });

  it("跳过的模型标注原因且不出表格", () => {
    const model = makeModelReport({ model: "vendor/m-b", skipped: true, skipReason: "端点不支持（4xx）" });
    const md = renderMarkdown(buildReport({ models: [model], meta }));
    expect(md).toContain("## vendor/m-b");
    expect(md).toContain("已跳过");
    expect(md).toContain("端点不支持（4xx）");
    expect(md).not.toContain("| runIndex");
  });

  it("样例文本截断到约 300 字符", () => {
    const model = makeModelReport({ sampleText: "字".repeat(500) });
    const md = renderMarkdown(buildReport({ models: [model], meta }));
    expect(md).toContain("字".repeat(300) + "…");
    expect(md).not.toContain("字".repeat(301));
  });
});
