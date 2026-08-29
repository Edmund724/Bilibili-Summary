// 「归并层」模块（07 票）：原始字幕 >500k 时，成稿前先按归并组输入 100k
// 把多条分段小结多层归并到合计 ≤100k，再交给成稿调用；≤500k 不触发，沿用 03 直接成稿路径。
// 归并去重但保留观点、依据、例子、时间点与前后关系；prompt 措辞对齐蓝本 _merge_prompt。
// 纯函数 + 可注入 runPrompts/onProgress/signal，不接 UI、不发请求，供 map-reduce 编排调用。

import { MERGE_GROUP_INPUT_CHARS, MERGE_TRIGGER_CHARS } from "./budgeter.js";
import { makeAbortedError } from "../shared/error-helpers.js";

// 合计字符数：非数组按 0 处理，null/undefined 条目按空串计。
function sumChars(list) {
  return (Array.isArray(list) ? list : []).reduce(
    (acc, s) => acc + String(s == null ? "" : s).length,
    0
  );
}

/**
 * 是否需要对分段小结做归并：只看原始字幕量是否超 500k（needsMerge 同理）。
 * 段数 ≥11 是「>500k / 单段 50k」的推论，不是独立触发条件——章节对齐可能切出
 * 多个短段（总字符 ≤500k 却 ≥11 段），此时不应误触归并、多花调用。
 */
export function shouldMerge(plan) {
  if (!plan) {
    return false;
  }
  return Number(plan.totalChars) > MERGE_TRIGGER_CHARS || plan.needsMerge === true;
}

/**
 * 把若干条小结贪心分组为归并组：按输入顺序累积，每组合计字符数 ≤ groupInputChars；
 * 单条超过预算也自成一组（不拆条）；空数组 / 非数组返回 []。
 */
export function buildMergeGroups(summaries, { groupInputChars = MERGE_GROUP_INPUT_CHARS } = {}) {
  const list = Array.isArray(summaries) ? summaries : [];
  const maxChars = Number(groupInputChars) > 0 ? Number(groupInputChars) : MERGE_GROUP_INPUT_CHARS;
  const groups = [];
  let current = [];
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

/**
 * 构造归并 prompt：对齐蓝本 _merge_prompt 措辞——视频标题 + 第 level 层第 groupIndex/groupCount 组
 * + 去重但保留观点、依据、例子、时间点与前后关系，不做评价、不补外部知识，只输出连续材料。
 * group 内各条目以 `\n\n` 拼接。
 */
export function buildMergePrompt({ title, level, groupIndex, groupCount, group }) {
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

/**
 * 多层归并：while 所有小结合计 >100k 时，按归并组输入贪心分组、逐组调模型归并，
 * 直到合计 ≤100k（或组数不减少，防止单条超预算等不收敛死循环）。
 * 每组调用前检查 signal.aborted，中止即抛带 aborted 标记的错误。
 * 返回 { merged, levels }；merged 按组的原始顺序排列。
 */
export async function mergeSummaries({ summaries, title, runPrompts, signal, onProgress }) {
  let merged = Array.isArray(summaries) ? summaries : [];
  let levels = 0;

  while (sumChars(merged) > MERGE_GROUP_INPUT_CHARS) {
    if (signal?.aborted) {
      throw makeAbortedError();
    }
    const groups = buildMergeGroups(merged);
    // 组数不减少 = 每组至多一条、归并无收益 → 停止，避免死循环。
    if (groups.length >= merged.length) {
      break;
    }
    levels += 1;
    const next = [];
    for (let g = 0; g < groups.length; g += 1) {
      if (signal?.aborted) {
        throw makeAbortedError();
      }
      if (typeof onProgress === "function") {
        onProgress(`正在归并第 ${levels} 层 ${g + 1}/${groups.length} 组`);
      }
      const text = await runPrompts({
        prompt: buildMergePrompt({
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
        trimmed.length > MERGE_GROUP_INPUT_CHARS
          ? trimmed.slice(0, MERGE_GROUP_INPUT_CHARS)
          : trimmed
      );
    }
    merged = next;
  }

  return { merged, levels };
}
