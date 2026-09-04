// eval/lib/stats.ts
// 单次重复轮的统计：有效样本均值 / 中位数 + 成功失败计数。
// null 计为失败（不计入样本）；样本全空时 mean/median 为 null；
// 偶数个样本取中间两数平均，保留足够精度不取整。

export interface RunStats {
  samples: number[]; // 有效样本（null 已剔除）
  mean: number | null;
  median: number | null;
  successCount: number;
  failCount: number;
}

export function summarizeRun(values: Array<number | null>): RunStats {
  const samples = values.filter((v): v is number => v !== null);

  return {
    samples,
    mean: samples.length > 0 ? samples.reduce((sum, v) => sum + v, 0) / samples.length : null,
    median: samples.length > 0 ? medianOf(samples) : null,
    successCount: samples.length,
    failCount: values.length - samples.length
  };
}

function medianOf(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}
