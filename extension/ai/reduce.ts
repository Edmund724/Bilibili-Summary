// 「归并层」模块（07 票）：原始字幕 >500k 时，成稿前先按归并组输入 100k
// 把多条分段小结多层归并到合计 ≤100k，再交给成稿调用；≤500k 不触发，沿用 03 直接成稿路径。
// 归并去重但保留观点、依据、例子、时间点与前后关系；prompt 措辞对齐蓝本 _merge_prompt。
// 归并 = Map-Reduce 的 Reduce 阶段（ADR-0001），代码名一律用 reduce 词根。
// 纯函数 + 可注入 runPrompts/onProgress/signal，不接 UI、不发请求，供 map-reduce 编排调用。

import { REDUCE_GROUP_INPUT_CHARS, REDUCE_TRIGGER_CHARS } from "./budgeter.js";
import { makeAbortedError } from "../shared/error-helpers.js";
import type { BudgetPlan } from "./types.js";

// 合计字符数：非数组按 0 处理，null/undefined 条目按空串计。
function sumChars(list: unknown[]): number {
  return (Array.isArray(list) ? list : []).reduce<number>(
    (acc, s) => acc + String(s == null ? "" : s).length,
    0
  );
}

/**
 * 是否需要对分段小结做归并：只看原始字幕量是否超 500k（needsReduce 同理）。
 * 段数 ≥11 是「>500k / 单段 50k」的推论，不是独立触发条件——章节对齐可能切出
 * 多个短段（总字符 ≤500k 却 ≥11 段），此时不应误触归并、多花调用。
 */
export function shouldReduce(plan: BudgetPlan | null | undefined): boolean {
  if (!plan) {
    return false;
  }
  return Number(plan.totalChars) > REDUCE_TRIGGER_CHARS || plan.needsReduce === true;
}

interface BuildReduceGroupsOptions {
  groupInputChars?: number | string;
}

/**
 * 把若干条小结贪心分组为归并组：按输入顺序累积，每组合计字符数 ≤ groupInputChars；
 * 单条超过预算也自成一组（不拆条）；空数组 / 非数组返回 []。
 */
export function buildReduceGroups(summaries: unknown[], { groupInputChars = REDUCE_GROUP_INPUT_CHARS }: BuildReduceGroupsOptions = {}): unknown[][] {
  const list = Array.isArray(summaries) ? summaries : [];
  const maxChars = Number(groupInputChars) > 0 ? Number(groupInputChars) : REDUCE_GROUP_INPUT_CHARS;
  const groups: unknown[][] = [];
  let current: unknown[] = [];
  let size = 0;
  for (const summary of list) {
    const chars = String(summary == null ? "" : summary).length;
    // 已有组再加一条会超预算 → 先收组，让这条开新组（单条超预算时天然自成一组）。
    if (current.length > 0 && size + chars > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(summary);
    size += chars;
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

interface BuildReducePromptInput {
  title: string;
  level: number;
  groupIndex: number;
  groupCount: number;
  group: unknown[];
}

/**
 * 构造归并 prompt：对齐蓝本 _merge_prompt 措辞——视频标题 + 第 level 层第 groupIndex/groupCount 组
 * + 去重但保留观点、依据、例子、时间点与前后关系，不做评价、不补外部知识，只输出连续材料。
 * group 内各条目以 `\n\n` 拼接。
 */
export function buildReducePrompt({ title, level, groupIndex, groupCount, group }: BuildReducePromptInput): string {
  const material = (Array.isArray(group) ? group : [])
    .map((s) => String(s == null ? "" : s))
    .join("\n\n");
  return `视频标题：${title}
这是长视频内容的第 ${level} 层归并，第 ${groupIndex}/${groupCount} 组。

请合并以下连续片段笔记，去除重复但保留观点、依据、例子、时间点和前后关系。
不要评价，不补充外部知识，只输出供最终成稿使用的连续材料。

片段笔记：
${material}`;
}

interface RunPromptsInput {
  prompt?: string;
  messages?: unknown[];
}

interface ReduceSummariesInput {
  summaries: unknown[];
  title: string;
  runPrompts: (input: RunPromptsInput) => Promise<unknown>;
  signal?: AbortSignal | null;
  onProgress?: (notice: string) => void;
  groupInputChars?: number | string;
}

interface ReduceSummariesResult {
  merged: string[];
  levels: number;
}

/**
 * 多层归并：while 所有小结合计 > 归并组输入时，按归并组输入贪心分组、逐组调模型归并，
 * 直到合计 ≤ 归并组输入（或组数不减少，防止单条超预算等不收敛死循环）。
 * groupInputChars：归并组输入上限（默认 REDUCE_GROUP_INPUT_CHARS；溢出放宽预算
 * 重跑时由编排层传入收紧后的值）。每组调用前检查 signal.aborted，中止即抛带
 * aborted 标记的错误。返回 { merged, levels }；merged 按组的原始顺序排列。
 */
export async function reduceSummaries({
  summaries,
  title,
  runPrompts,
  signal,
  onProgress,
  groupInputChars = REDUCE_GROUP_INPUT_CHARS
}: ReduceSummariesInput): Promise<ReduceSummariesResult> {
  const maxChars = Number(groupInputChars) > 0 ? Number(groupInputChars) : REDUCE_GROUP_INPUT_CHARS;
  let merged: string[] = Array.isArray(summaries) ? summaries.map((s) => String(s == null ? "" : s)) : [];
  let levels = 0;

  while (sumChars(merged) > maxChars) {
    if (signal?.aborted) {
      throw makeAbortedError();
    }
    const groups = buildReduceGroups(merged, { groupInputChars: maxChars });
    // 组数不减少 = 每组至多一条、归并无收益 → 停止，避免死循环。
    if (groups.length >= merged.length) {
      break;
    }
    levels += 1;
    const next: string[] = [];
    for (let g = 0; g < groups.length; g += 1) {
      if (signal?.aborted) {
        throw makeAbortedError();
      }
      if (typeof onProgress === "function") {
        onProgress(`正在归并第 ${levels} 层 ${g + 1}/${groups.length} 组`);
      }
      const text = await runPrompts({
        prompt: buildReducePrompt({
          title,
          level: levels,
          groupIndex: g + 1,
          groupCount: groups.length,
          group: groups[g]
        })
      });
      const trimmed = String(text || "").trim();
      // 防御性 clamp：单条归并产出截断到归并组输入，避免个别超长输出撑爆下一层组预算。
      next.push(
        trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed
      );
    }
    merged = next;
  }

  return { merged, levels };
}
