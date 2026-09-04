// eval/lib/timestamp-detect.ts
// 转写结果时间戳判定（双通道）：
// ① 响应结构：适配器返回的 segments 是否为非空数组；
// ② 文本内嵌：对 text 应用可配置正则（如 [hh:mm:ss] / [mm:ss] / {数字}），
//    报告命中的 pattern source（保持传入顺序、去重）。

export interface TimestampDetection {
  hasResponseStructure: boolean; // 响应带 segments 时间戳结构
  hasInline: boolean; // 文本内嵌时间戳
  matchedPatterns: string[]; // 命中的文本内嵌模式描述（即传入正则的 source）
}

export function detectTimestamps(
  response: { text: string; segments?: unknown },
  inlinePatterns: RegExp[]
): TimestampDetection {
  const hasResponseStructure = Array.isArray(response.segments) && response.segments.length > 0;

  const matchedPatterns: string[] = [];
  for (const pattern of inlinePatterns) {
    if (!pattern.test(response.text)) continue;
    if (!matchedPatterns.includes(pattern.source)) {
      matchedPatterns.push(pattern.source);
    }
  }

  return {
    hasResponseStructure,
    hasInline: matchedPatterns.length > 0,
    matchedPatterns
  };
}
