// 「预算器」纯函数模块：把字幕正文字符数保守估成 token，并产出「阶梯」判定与分段计划。
// 决策记录见 ADR-0001（docs/adr/0001-long-video-summarization-map-reduce.md）。
// 不接 UI、不发请求、不依赖 Chrome API，供 Map-Reduce 编排与预算内单次路径共用。
// 常量（素材预算 / 单段输入 / 分段小结 / 归并组输入 / 成稿输出 / 系数）集中在此作为单一事实来源。

// 字符 → token 系数：每字符≈1 token（保守，宁可早进 Map-Reduce，溢出兜底保证正确性）。
export const CHAR_PER_TOKEN = 1.0;
// 素材预算（100k token × 1.0）：预算内一次成稿，超出即进入分段 + 归并。
export const MATERIAL_BUDGET_CHARS = 100000;
// 模型统一按 256k 窗口。
export const MODEL_WINDOW_CHARS = 256000;
// 单段输入：分段写入小结的原始字幕字符上限。
export const SEGMENT_INPUT_CHARS = 50000;
// 分段小结 ≤10k（20% 保留）。
export const SEGMENT_SUMMARY_CHARS = 10000;
// 归并组输入：每层归并把若干小结塞进同一份素材（≤100k）。
export const MERGE_GROUP_INPUT_CHARS = 100000;
// 成稿输出 ≤16k。
export const FINAL_OUTPUT_CHARS = 16000;
// 归并触发线：原始字幕 >500k 时才触发归并层（此时段数 ≥11）。
export const MERGE_TRIGGER_CHARS = 500000;

// 每个归并组最多容纳的段数：归并组输入 100k / 单条小结 ≤10k = 10。
const SEGMENTS_PER_MERGE_GROUP = Math.floor(MERGE_GROUP_INPUT_CHARS / SEGMENT_SUMMARY_CHARS);

// 保守地把时间戳转成数值；非有限值（undefined/NaN 等）回落到 0。
function toSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// 估 token：非字符串 / 空串返回 0；其余 = 字符数 × CHAR_PER_TOKEN。
export function estimateTokens(text) {
  if (typeof text !== "string" || text.length === 0) {
    return 0;
  }
  return text.length * CHAR_PER_TOKEN;
}

// 归并调用数估算：每层把 ≤SEGMENTS_PER_MERGE_GROUP 条小结归并为一条，累加各层的分组数
// （即实际归并调用次数）。例：11 段 → 第 1 层 ceil(11/10)=2 组(2 次) → 第 2 层 ceil(2/10)=1 组(1 次)，共 3 次。
function estimateMergeCalls(segmentCount) {
  let calls = 0;
  let n = segmentCount;
  while (n > 1) {
    n = Math.ceil(n / SEGMENTS_PER_MERGE_GROUP);
    calls += n;
  }
  return calls;
}

// 沿字幕项顺序累积字符到单段输入预算；遇到章节边界（上一条在上一章、本条已进入
// chapter.from 之后）时在前一条处收段，让新段对齐到章节起点——不要求字幕与章节时间戳逐秒相等。
function splitByBudget(items, chapterStarts) {
  const segments = [];
  let current = null;
  let prevFrom = null;

  for (const item of items) {
    // 跨入新章节：prevFrom < chapter.from <= item.from 时，在前一条处切开对齐。
    const crossesIntoChapter =
      current !== null &&
      current.items.length > 0 &&
      prevFrom !== null &&
      chapterStarts.some((start) => prevFrom < start && item.from >= start);

    if (crossesIntoChapter) {
      segments.push(current);
      current = null;
    }

    if (!current) {
      current = { from: item.from, to: item.to, chars: 0, items: [] };
    }
    current.items.push({ from: item.from, to: item.to, content: item.content });
    current.chars += item.chars;
    current.to = item.to;
    prevFrom = item.from;

    // 累积到单段输入预算即收段。
    if (current.chars >= SEGMENT_INPUT_CHARS) {
      segments.push(current);
      current = null;
    }
  }

  if (current && current.items.length > 0) {
    segments.push(current);
  }

  return segments.map((seg, i) => ({
    index: i + 1,
    from: seg.from,
    to: seg.to,
    chars: seg.chars,
    items: seg.items
  }));
}

// 产出预算计划：估 token → 判模式（single / map-reduce）→ 分段计划与调用次数预估。
// body 字幕项 { from, to, content }（秒级时间戳 + 文本）；chapters { from, to, title }。
export function buildBudgetPlan({ body = [], chapters = [] } = {}) {
  const bodyItems = Array.isArray(body) ? body : [];
  const chapterItems = Array.isArray(chapters) ? chapters : [];

  // 规整字幕项：跳过 trim 后为空的 content；只累计 content 文本长度（不含时间戳/标题）。
  const items = [];
  let totalChars = 0;
  for (const item of bodyItems) {
    const content = String(item && item.content != null ? item.content : "");
    const chars = content.trim().length;
    if (chars === 0) {
      continue;
    }
    items.push({
      from: toSeconds(item && item.from),
      to: toSeconds(item && item.to),
      content,
      chars
    });
    totalChars += chars;
  }

  const mode = totalChars > MATERIAL_BUDGET_CHARS ? "map-reduce" : "single";

  let segments = [];
  if (mode === "map-reduce") {
    const chapterStarts = [];
    for (const chapter of chapterItems) {
      const start = Number(chapter && chapter.from);
      if (Number.isFinite(start) && start >= 0) {
        chapterStarts.push(start);
      }
    }
    segments = splitByBudget(items, chapterStarts);
  }

  const needsMerge = totalChars > MERGE_TRIGGER_CHARS;
  const estimatedCalls =
    mode === "single"
      ? 1
      : segments.length + 1 + (needsMerge ? estimateMergeCalls(segments.length) : 0);

  return {
    totalChars,
    estimatedTokens: totalChars * CHAR_PER_TOKEN,
    mode,
    segments,
    estimatedCalls,
    needsMerge
  };
}
