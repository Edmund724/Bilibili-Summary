// 字幕段行渲染窄叶子（arch-review-2026-09/04 自 notes/render.ts 提取，逐字节
// 零逻辑改动）：ai/subtitle-prompt 只需要 buildSubtitleSectionLines 与
// shouldShowHoursInNote 两个函数，此前经 notes/render 拖入整个 render 依赖树
//（validators / selection 等）进 ladder chunk。本叶子只依赖 subtitle/chapters
// 与 shared/clock-text。

import { formatClock, shouldUseHours } from "../shared/clock-text.js";
import { normalizeChapters } from "../subtitle/chapters.js";
import type { State } from "../core/state.js";

// 渲染入参的宽松 meta 形状：字段全部按可选收口，各渲染函数内部沿用原有的
// String()/Number() 归一，行为与迁出前一致。clipState 片段按结构直接兼容；
// State 容器（无同名字段）经 shouldShowHoursInNote 的联合参数收口（TS 弱类型
// 检查要求联合显式包含 State）。
interface NoteRenderMeta {
  title?: unknown;
  aid?: unknown;
  bvid?: unknown;
  cid?: unknown;
  author?: unknown;
  uploadDate?: unknown;
  selectedSubtitleLang?: unknown;
  description?: unknown;
  videoDuration?: unknown;
  chapters?: unknown[];
  hotComments?: unknown[];
}

// 字幕条目的宽松形状：ai/subtitle-prompt 的 unknown[] body 与 core/state 的
// SubtitleBodyItem 都按此结构传入；时间戳消费点按 number 断言（与迁出前
// 直传的运行时值一致），文案统一经 String() 归一。
interface SubtitleBodyItemLike {
  from?: unknown;
  to?: unknown;
  content?: unknown;
}

// 派生渲染只读 includeTimestampInBody 一个开关；buildSubtitleSectionLines 的
// 调用方（ai/subtitle-prompt）只构造该字段。
interface NoteRenderSettings {
  includeTimestampInBody?: boolean;
}

export function buildSubtitleSectionLines(body: unknown[] | null | undefined, chapters: unknown[] | null | undefined, settings: NoteRenderSettings, withHours: boolean): string[] {
  const items = (body || []) as SubtitleBodyItemLike[];
  const subtitleItems = items
    .map((item, index) => ({
      ...item,
      _index: index,
      text: String(item?.content || "").trim()
    }))
    .filter((item) => item.text);
  if (subtitleItems.length === 0) {
    return ["（暂无字幕）"];
  }

  const chapterItems = normalizeChapters(chapters);
  if (chapterItems.length === 0) {
    return subtitleItems.map((item) => formatSubtitleLine(item, settings, withHours));
  }

  const lines: string[] = [];
  const usedIndexes = new Set<number>();
  let subtitleCursor = 0;

  chapterItems.forEach((chapter, idx) => {
    const start = Number(chapter.from || 0) || 0;
    const next = chapterItems[idx + 1];
    const chapterTo = Number(chapter.to || 0) || 0;
    let end = Infinity;
    if (next && Number(next.from) > start) {
      end = Number(next.from);
    } else if (chapterTo > start) {
      end = chapterTo;
    }

    // 推进游标跳过 from < start 的字幕（前一章已消费或未归入任何章节）
    while (subtitleCursor < subtitleItems.length) {
      const from = Number(subtitleItems[subtitleCursor].from || 0) || 0;
      if (from + 0.001 >= start) {
        break;
      }
      subtitleCursor++;
    }

    // 收集属于当前 chapter 的字幕
    const sectionItems: Array<SubtitleBodyItemLike & { _index: number; text: string }> = [];
    while (subtitleCursor < subtitleItems.length) {
      const from = Number(subtitleItems[subtitleCursor].from || 0) || 0;
      const inEnd = end === Infinity ? true : from < end;
      if (!inEnd) {
        break;
      }
      sectionItems.push(subtitleItems[subtitleCursor]);
      usedIndexes.add(subtitleItems[subtitleCursor]._index);
      subtitleCursor++;
    }

    if (sectionItems.length === 0) {
      return;
    }

    const chapterStamp = settings.includeTimestampInBody
      ? ` \`${formatClock(start, { hours: withHours })}\``
      : "";
    lines.push(`### ${chapter.title}${chapterStamp}`, "");
    sectionItems.forEach((item) => {
      lines.push(formatSubtitleLine(item, settings, withHours));
    });
    lines.push("");
  });

  const remaining = subtitleItems.filter((item) => !usedIndexes.has(item._index));
  if (remaining.length > 0) {
    lines.push("### 其他片段", "");
    remaining.forEach((item) => {
      lines.push(formatSubtitleLine(item, settings, withHours));
    });
    lines.push("");
  }

  if (lines.length === 0) {
    return subtitleItems.map((item) => formatSubtitleLine(item, settings, withHours));
  }

  while (lines.length > 0 && !lines[lines.length - 1]) {
    lines.pop();
  }
  return lines;
}

function formatSubtitleLine(item: SubtitleBodyItemLike, settings: NoteRenderSettings, withHours: boolean): string {
  const text = String(item?.content || "").trim();
  if (!text) {
    return "";
  }
  if (!settings.includeTimestampInBody) {
    return text;
  }
  return `\`${formatClock(item.from as number, { hours: withHours })}\` ${text}`;
}

// withHours 元数据级判定（arch-slim-2/08）：聚合（字幕末尾 / 章节边界 / 视频时长
// 取 max）留在 notes 域——normalizeChapters 与 meta 形状是 notes 域知识，不拖入
// 共享叶子；「≥3600 才带小时位」的阈值判定单源 shared/clock-text.ts。
export function shouldShowHoursInNote(meta: NoteRenderMeta | State | null | undefined, body: unknown[] | null | undefined): boolean {
  const m = (meta || {}) as NoteRenderMeta;
  const items = (body || []) as SubtitleBodyItemLike[];
  const subtitleMaxTo = items.reduce((max, item) => {
    const to = Number(item?.to || 0);
    return Number.isFinite(to) && to > max ? to : max;
  }, 0);
  const chapterMaxTo = normalizeChapters(m?.chapters || []).reduce((max, item) => {
    const from = Number(item?.from || 0) || 0;
    const to = Number(item?.to || 0) || 0;
    return Math.max(max, from, to);
  }, 0);
  const duration = Number(m?.videoDuration || 0) || 0;
  return shouldUseHours(Math.max(subtitleMaxTo, chapterMaxTo, duration));
}
