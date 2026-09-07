// 章节归一化叶子（arch-review-2026-09/04 自 subtitle/selection.ts 搬出，逐字节
// 零逻辑改动）：selection.ts 的 render 依赖树会被 ai/subtitle-prompt 拖进 ladder
// chunk，章节归一化是 prompt 组装的真实需求，独立成叶子断链。

import type { Chapter } from "../bilibili/gateway.js";

// 候选10 批1：归一化结果按「输入数组引用」缓存（WeakMap）。sync tick /
// renderReadingView / notes 渲染每拍都拿同一 state.clip.chapters 引用重复做
// map→filter→sort→Set 归一化，引用相同即零分配复用。已核实全部调用方
// （fetcher / core.findActiveChapterIndex / lifecycle.renderReadingView /
// notes/render / mapChaptersFromPlayerData）都不会原地修改传入数组——写路径
// 一律经 clipState.setChapters(新数组) 整体替换引用；返回结果同样只被只读
// 遍历，不会被调用方修改，缓存不会失真。
const normalizeChaptersCache = new WeakMap<object, Chapter[]>();

export function normalizeChapters(chapters: unknown[] | null | undefined): Chapter[] {
  if (Array.isArray(chapters)) {
    const cached = normalizeChaptersCache.get(chapters);
    if (cached) {
      return cached;
    }
    const normalized = normalizeChaptersUncached(chapters);
    normalizeChaptersCache.set(chapters, normalized);
    return normalized;
  }
  // 与原实现一致：null/undefined 按空数组归一化；其余非数组输入仍走
  // .map 原路径（不缓存）。
  return normalizeChaptersUncached(chapters || []);
}

function normalizeChaptersUncached(chapters: unknown[]): Chapter[] {
  const normalized = chapters
    .map((item) => ({
      title: String((item as { title?: string }).title || "").trim(),
      from: Number((item as { from?: unknown }).from || 0) || 0,
      to: Number((item as { to?: unknown }).to || 0) || 0,
      source: String((item as { source?: string }).source || "")
    }))
    .filter((item) => item.title && item.from >= 0)
    .sort((a, b) => a.from - b.from);

  const unique: Chapter[] = [];
  const seen = new Set<string>();
  normalized.forEach((item) => {
    const key = `${Math.floor(item.from * 10)}|${item.title.toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    unique.push(item);
  });

  return unique;
}
