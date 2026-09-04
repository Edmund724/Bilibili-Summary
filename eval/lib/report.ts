// eval/lib/report.ts
// 评测报告结构 + Markdown 渲染。buildReport 以 runs 为准重算每个模型的
// aggregate（保证与 run 数据一致）后原样返回；renderMarkdown 输出人类友好的
// 中文 Markdown（meta 摘要 + 每模型一节：时间戳判定 / 样例文本 / runs 表格
// / 末尾 aggregate 行）。

import type { RequestTiming } from "./timing-fetch.js";
import type { TimestampDetection } from "./timestamp-detect.js";

export interface RunReport {
  runIndex: number;
  wallMs: number;
  segmentCount: number;
  failedChunks: number;
  requestTimings: RequestTiming[];
  segmentMeanMs: number | null; // 请求计时均值
  rtf: number | null; // wallMs / audioDurationMs
  success: boolean; // 有无成功请求判定（segments 完成）
}

export interface PerModelReport {
  model: string;
  runs: RunReport[];
  aggregate: {
    segmentMeanMean: number | null; // 各 run segmentMeanMs 的均值（忽略 null）
    wallMean: number | null;
    rtfMean: number | null;
    successCount: number;
  };
  timestamps: TimestampDetection;
  sampleText: string; // 转写文本样例
  skipped: boolean; // 端点不支持被跳过
  skipReason?: string;
}

export interface EvalReport {
  meta: {
    generatedAt: string; // ISO
    audioName: string;
    audioDurationSec: number;
    config: Record<string, unknown>;
  };
  models: PerModelReport[];
}

export function buildReport(input: {
  models: PerModelReport[];
  meta: EvalReport["meta"];
}): EvalReport {
  return {
    meta: input.meta,
    models: input.models.map((model) => ({ ...model, aggregate: aggregateRuns(model.runs) }))
  };
}

function aggregateRuns(runs: RunReport[]): PerModelReport["aggregate"] {
  // 失败 run（success=false）不计入平均，只统计成功 run（Q8 口径）
  const successful = runs.filter((run) => run.success);
  const nonNull = <T>(values: Array<T | null>): T[] => values.filter((v): v is T => v !== null);
  const mean = (values: number[]): number | null =>
    values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : null;

  return {
    segmentMeanMean: mean(nonNull(successful.map((run) => run.segmentMeanMs))),
    wallMean: mean(nonNull(successful.map((run) => run.wallMs))),
    rtfMean: mean(nonNull(successful.map((run) => run.rtf))),
    successCount: successful.length
  };
}

export function renderMarkdown(report: EvalReport): string {
  const { meta } = report;
  const configSummary = Object.entries(meta.config)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");

  const lines: string[] = [];
  lines.push("# ASR 模型速度评测报告");
  lines.push("");
  lines.push(`- 生成时间：${meta.generatedAt}`);
  lines.push(`- 音频：${meta.audioName}`);
  lines.push(`- 音频时长：${meta.audioDurationSec.toFixed(1)} 秒`);
  if (configSummary) lines.push(`- 配置：${configSummary}`);
  lines.push("");

  for (const model of report.models) {
    lines.push(`## ${model.model}`);
    lines.push("");
    if (model.skipped) {
      lines.push(`**已跳过**：${model.skipReason ?? "端点不支持"}`);
      lines.push("");
      continue;
    }

    lines.push(`- 时间戳判定：响应结构 segments = ${model.timestamps.hasResponseStructure ? "是" : "否"}`);
    lines.push(`- 时间戳判定：文本内嵌 = ${model.timestamps.hasInline ? "是" : "否"}`);
    lines.push(
      `- 时间戳判定：命中模式 = ${model.timestamps.matchedPatterns.length > 0 ? model.timestamps.matchedPatterns.join("、") : "无"}`
    );
    lines.push(`- 样例文本：${truncateText(model.sampleText, 300)}`);
    lines.push("");
    lines.push("| runIndex | wallMs (ms) | segmentMeanMs (ms) | rtf | 成功 |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const run of model.runs) {
      lines.push(
        `| ${run.runIndex} | ${Math.round(run.wallMs)} | ${run.segmentMeanMs ?? "FAIL"} | ${run.rtf ?? "FAIL"} | ${run.success ? "✓" : "✗"} |`
      );
    }
    lines.push(
      `| **均值** | ${model.aggregate.wallMean ?? "FAIL"} | ${model.aggregate.segmentMeanMean ?? "FAIL"} | ${model.aggregate.rtfMean ?? "FAIL"} | 成功 ${model.aggregate.successCount}/${model.runs.length} |`
    );
    lines.push("");
  }

  return lines.join("\n");
}

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
