// 「JSON 防线」独立模块（arch-slim-2/08 从 ai/analysis.ts 迁出）：模型 JSON
// 输出的两道通用防御——截断修复 + 宽容解析。与「概览」shape 无概念绑定
// （概览 shape 专属的 validateAnalysis / mergeAnalyses / estimateOutputTokens
// 留在 ai/analysis.ts）；单独成模块是防线单源 + 防第三处复制 + interface 收窄
// （本模块 interface = 2 函数，不再随 analysis 的概览面扩张）。
// 整搬自参考仓库 lib/ai.js:45-79 / 86-110，实现零改动。

/**
 * 截断修复：输出撞到 max_tokens 或传输中断时，JSON 会停在字符串或括号中间。
 * 扫描出未闭合的部分原样补齐，保住已生成的内容（整搬 lib/ai.js:45-79）。
 */
export function repairTruncatedJson(text: unknown): string {
  const source = String(text ?? "");
  let inString = false;
  let danglingEscape = false;
  const stack: string[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") {
        if (i + 1 >= source.length) {
          danglingEscape = true;
          break;
        }
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "[" || ch === "{") {
      stack.push(ch);
    } else if (ch === "]" || ch === "}") {
      stack.pop();
    }
  }
  let repaired = source;
  if (danglingEscape) repaired = repaired.slice(0, -1);
  if (inString) repaired += '"';
  // 截断恰好停在逗号后（长数组最常见的截断点）时，悬尾逗号必须先剥掉，
  // 否则补完括号的 ",]}" 依然是非法 JSON，修复等于白修。
  repaired = repaired.replace(/,\s*$/, "");
  while (stack.length) {
    repaired += stack.pop() === "[" ? "]" : "}";
  }
  return repaired;
}

/**
 * 解析模型返回的 JSON，容忍它常犯的小错：包了 markdown 围栏、在 JSON 前后
 * 加了一句话、结尾多一个逗号、输出中途被截断（整搬 lib/ai.js:86-110，一处
 * 顺序适配：原文以 { 开头时先按整段原文升级修复，再退到 firstBrace..lastBrace
 * 切割——截断最常发生在长数组中间，先切到「最后一个 }」会把切点之前嵌套对象
 * 后面的已生成内容整段丢掉，修复反而失效）。
 */
export function parseLooseJson(text: unknown): unknown {
  let cleaned = String(text ?? "").trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  // 候选按修复力度升序尝试：原文（无前缀赘语时）→ 切掉前后赘语的 JSON 体；
  // 每个候选依次 试解析 → 剥尾逗号 → 截断补齐。
  const candidates: string[] = [];
  if (firstBrace === 0) {
    candidates.push(cleaned);
  }
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
    // 依次升级修复力度：尾逗号 → 截断补齐。
    const noTrailingComma = candidate.replace(/,(\s*[}\]])/g, "$1");
    try {
      return JSON.parse(noTrailingComma);
    } catch {}
    try {
      return JSON.parse(repairTruncatedJson(noTrailingComma));
    } catch {}
  }
  // 全部候选失败：抛最后一次的解析错误（由调用方处理）。
  return JSON.parse(candidates[candidates.length - 1] ?? cleaned);
}
