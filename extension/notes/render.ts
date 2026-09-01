// extension/notes/render.ts
// Note/export rendering logic (Markdown, SRT, TXT, frontmatter, chapters, subtitles, comments).

import { DEFAULT_SETTINGS, type Settings } from "../core/defaults.js";
import { formatLocalDate } from "../shared/utils.js";
import {
  normalizeFixedPropertyType,
  isFixedPropertyRowEffectivelyEmpty,
  normalizeNotePlaceholderSections
} from "../core/validators.js";
import { escapeYaml, formatCompactTimestamp, formatTimestamp, resolveFrontmatterTemplateValue, parseFrontmatterArrayItems, pushOptionalLines } from "../shared/string-utils.js";
import { normalizeChapters } from "../subtitle/selection.js";
import { normalizeHotComments } from "../bilibili/bili-api-shared.js";
import { extractPageIndex, cleanVideoUrl } from "../bilibili/video-id-shared.js";
import { state, type State } from "../core/state.js";

// 渲染入参的宽松 meta 形状：字段全部按可选收口，各渲染函数内部沿用原有的
// String()/Number() 归一，行为与迁出前一致。clipState 片段按结构直接兼容；
// State 容器（无同名字段）经 buildMarkdown/shouldShowHoursInNote 的联合参数
// 收口（TS 弱类型检查要求联合显式包含 State）。
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

// 派生渲染（预览/字幕段/TXT）只读 includeTimestampInBody 一个开关；
// buildSubtitleSectionLines 的调用方（ai/subtitle-prompt）只构造该字段。
interface NoteRenderSettings {
  includeTimestampInBody?: boolean;
}

function buildBilibiliEmbedIframe(meta: NoteRenderMeta, page = 1): string {
  const safeAid = encodeURIComponent(String(meta?.aid || "").trim());
  const safeBvid = encodeURIComponent(String(meta?.bvid || "").trim());
  const safeCid = encodeURIComponent(String(meta?.cid || "").trim());
  const safePage = Number(page) > 0 ? Number(page) : 1;

  return `<iframe src="https://player.bilibili.com/player.html?aid=${safeAid}&bvid=${safeBvid}&cid=${safeCid}&page=${safePage}&autoplay=0" scrolling="no" border="0" frameborder="no" framespacing="0" allow="fullscreen; picture-in-picture" allowfullscreen="true" style="height:100%;width:100%; aspect-ratio: 16 / 9;"> </iframe>`;
}

function buildChapterLines(chapters: unknown[] | null | undefined, withHours = false): string[] {
  const chapterItems = normalizeChapters(chapters);
  if (chapterItems.length === 0) {
    return [];
  }

  return chapterItems.map((item) => {
    const fromText = formatCompactTimestamp(item.from, withHours);
    return `- \`${fromText}\` ${item.title}`;
  });
}

function buildFrontMatter(meta: NoteRenderMeta, settings: Settings, created: string, tagsCsv: string, tagsYaml: string): string {
  const enabled = getEnabledFrontmatterFields(settings);
  const fixedPropertyLines = getFixedFrontmatterPropertyLines(
    settings,
    buildFrontmatterTemplateContext(meta, created, tagsCsv, tagsYaml)
  );
  if (enabled.length === 0 && fixedPropertyLines.length === 0) {
    return "";
  }

  const fieldLines: Record<string, string> = {
    title: `title: "${escapeYaml(meta.title)}"`,
    url: `url: "${escapeYaml(cleanVideoUrl())}"`,
    bvid: `bvid: "${escapeYaml(meta.bvid)}"`,
    cid: `cid: "${escapeYaml(meta.cid)}"`,
    author: `author: "${escapeYaml(meta.author || "unknown")}"`,
    upload_date: `upload_date: "${escapeYaml(meta.uploadDate || "unknown")}"`,
    subtitle_lang: `subtitle_lang: "${escapeYaml(meta.selectedSubtitleLang || "unknown")}"`,
    created: `created: "${created}"`,
    tags: `tags: ${tagsYaml}`
  };

  const lines = enabled.map((field) => fieldLines[field]).filter(Boolean);
  lines.push(...fixedPropertyLines);
  if (lines.length === 0) {
    return "";
  }

  return ["---", ...lines, "---"].join("\n");
}

function buildFrontmatterTemplateContext(meta: NoteRenderMeta, created: string, tagsCsv: string, tagsYaml: string) {
  return {
    title: String(meta?.title || "").trim(),
    url: String(cleanVideoUrl() || "").trim(),
    bvid: String(meta?.bvid || "").trim(),
    cid: String(meta?.cid || "").trim(),
    author: String(meta?.author || "unknown").trim(),
    upload_date: String(meta?.uploadDate || "unknown").trim(),
    subtitle_lang: String(meta?.selectedSubtitleLang || "unknown").trim(),
    created: String(created || "").trim(),
    tags: String(tagsCsv || "").trim(),
    tags_csv: String(tagsCsv || "").trim(),
    tags_yaml: String(tagsYaml || "").trim()
  };
}

function buildHotCommentLines(comments: unknown): string[] {
  const items = normalizeHotComments(comments, 20);
  if (items.length === 0) {
    return [];
  }

  return items.flatMap((item, index) => [
    `${index + 1}. ${item.uname}（赞 ${item.like}）`,
    item.message,
    ""
  ]).slice(0, -1);
}

export function buildMarkdown(meta: NoteRenderMeta | State, body: unknown[] | null | undefined, settings: Settings): string {
  const m = meta as NoteRenderMeta;
  const created = formatLocalDate();
  const tags = (settings.tags || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const tagsCsv = tags.join(", ");
  const tagsYaml =
    tags.length === 0 ? "[]" : `[${tags.map((tag) => `"${tag.replace(/"/g, '\\"')}"`).join(", ")}]`;

  const compactWithHours = shouldShowHoursInNote(m, body);
  const chapterLines = buildChapterLines(m.chapters || [], compactWithHours);
  const subtitleSectionLines = buildSubtitleSectionLines(
    body,
    m.chapters || [],
    settings,
    compactWithHours
  );
  const frontMatter = buildFrontMatter(m, settings, created, tagsCsv, tagsYaml);

  const page = extractPageIndex(location.href);
  const embedIframe = buildBilibiliEmbedIframe(m, page);
  const intro = String(m.description || "").trim();
  const noteSectionContext = buildNotePlaceholderTemplateContext(m, intro);
  const noteSections = groupNotePlaceholderSections(settings, noteSectionContext);

  const lines: string[] = [];
  if (frontMatter) {
    lines.push(frontMatter, "");
  }
  lines.push(embedIframe, "");
  pushOptionalLines(lines, noteSections.before_intro);

  if (intro) {
    lines.push("## 简介", "", intro, "");
  }

  pushOptionalLines(lines, noteSections.before_chapters);

  if (chapterLines.length > 0) {
    lines.push("## 章节", "", ...chapterLines, "");
  }

  pushOptionalLines(lines, noteSections.before_subtitle);
  lines.push("## 字幕", "", ...subtitleSectionLines);

  const hotCommentLines = buildHotCommentLines(
    settings?.includeHotCommentsInNote ? m?.hotComments || [] : []
  );
  if (hotCommentLines.length > 0) {
    lines.push("", "## 评论", "", ...hotCommentLines);
  }

  return lines.join("\n");
}

function buildNotePlaceholderLines(item: { title?: string; content?: string } | null | undefined, templateContext: Record<string, unknown> = {}): string[] {
  const title = String(item?.title || "").trim();
  if (!title) {
    return [];
  }
  const content = resolveFrontmatterTemplateValue(item?.content, templateContext).trim();
  const lines = [`## ${title}`, ""];
  if (content) {
    lines.push(content, "");
  }
  return lines;
}

function buildNotePlaceholderTemplateContext(meta: NoteRenderMeta, description: string) {
  return {
    title: String(meta?.title || "").trim(),
    author: String(meta?.author || "").trim(),
    url: String(cleanVideoUrl() || "").trim(),
    upload_date: String(meta?.uploadDate || "").trim(),
    description: String(description || "").trim()
  };
}

export function buildSrt(body: SubtitleBodyItemLike[] | null | undefined): string {
  return (body || [])
    .map((item, index) => {
      const from = formatTimestamp(item.from as number, true);
      const to = formatTimestamp(item.to as number, true);
      const text = String(item.content || "").trim();
      return `${index + 1}\n${from} --> ${to}\n${text}`;
    })
    .join("\n\n");
}

export function buildSubtitlePreview(body: SubtitleBodyItemLike[] | null | undefined, settings: NoteRenderSettings): string {
  const compactWithHours = shouldShowHoursInSubtitle(body);
  return (body || [])
    .map((item) => {
      const text = String(item?.content || "").trim();
      if (!text) {
        return "";
      }
      if (settings.includeTimestampInBody) {
        return `\`${formatCompactTimestamp(item.from as number, compactWithHours)}\` ${text}`;
      }
      return text;
    })
    .filter(Boolean)
    .join("\n");
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
      ? ` \`${formatCompactTimestamp(start, withHours)}\``
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

export function buildTxt(body: SubtitleBodyItemLike[] | null | undefined, settings?: NoteRenderSettings): string {
  const withHours = shouldShowHoursInSubtitle(body);
  return (body || [])
    .map((item) => {
      const text = String(item?.content || "").trim();
      if (!text) {
        return "";
      }
      if (!settings?.includeTimestampInBody) {
        return text;
      }
      return `${formatCompactTimestamp(item.from as number, withHours)} ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

function formatFixedPropertyYamlLine(key: string, type: unknown, value: unknown, templateContext: Record<string, unknown> = {}): string {
  const normalizedType = normalizeFixedPropertyType(type);
  const resolvedValue = resolveFrontmatterTemplateValue(value, templateContext).trim();

  if (!resolvedValue) {
    return "";
  }

  if (normalizedType === "number") {
    const num = Number(resolvedValue);
    if (!Number.isFinite(num)) {
      return "";
    }
    return `${key}: ${resolvedValue}`;
  }

  if (normalizedType === "checkbox") {
    const normalizedValue = resolvedValue.toLowerCase();
    if (normalizedValue !== "true" && normalizedValue !== "false") {
      return "";
    }
    return `${key}: ${normalizedValue}`;
  }

  if (normalizedType === "list") {
    const items = parseFrontmatterArrayItems(resolvedValue);
    return `${key}: [${items.map((item) => `"${escapeYaml(item)}"`).join(", ")}]`;
  }

  if (normalizedType === "date") {
    if (!isYamlDateValue(resolvedValue)) {
      return "";
    }
    return `${key}: ${resolvedValue}`;
  }

  return `${key}: "${escapeYaml(resolvedValue)}"`;
}

function formatSubtitleLine(item: SubtitleBodyItemLike, settings: NoteRenderSettings, withHours: boolean): string {
  const text = String(item?.content || "").trim();
  if (!text) {
    return "";
  }
  if (!settings.includeTimestampInBody) {
    return text;
  }
  return `\`${formatCompactTimestamp(item.from as number, withHours)}\` ${text}`;
}

function getEnabledFrontmatterFields(settings: Settings): string[] {
  const defaultFields = Array.isArray(DEFAULT_SETTINGS.frontmatterFields)
    ? DEFAULT_SETTINGS.frontmatterFields
    : [];
  const raw = Array.isArray(settings?.frontmatterFields) ? settings.frontmatterFields : defaultFields;
  const allowed = new Set(defaultFields);
  const unique: string[] = [];
  raw.forEach((item) => {
    const key = String(item || "").trim();
    if (!key || !allowed.has(key) || unique.includes(key)) {
      return;
    }
    unique.push(key);
  });
  return unique;
}

function getFixedFrontmatterPropertyLines(settings: Settings, templateContext: Record<string, unknown> = {}): string[] {
  const customPropertyKeyPattern = /^[\p{L}\p{N}_\-\s]+$/u;
  const systemFields = new Set(
    (Array.isArray(DEFAULT_SETTINGS.frontmatterFields) ? DEFAULT_SETTINGS.frontmatterFields : []).map((field) =>
      String(field).toLowerCase()
    )
  );
  const rows = Array.isArray(settings?.fixedFrontmatterProperties) ? settings.fixedFrontmatterProperties : [];
  const seenKeys = new Set<string>();
  const lines: string[] = [];

  rows.forEach((item) => {
    const key = String(item?.key || "").trim();
    const type = normalizeFixedPropertyType(item?.type);
    const value = item?.value;
    const lowerKey = key.toLowerCase();
    if (!key || isFixedPropertyRowEffectivelyEmpty(type, value)) {
      return;
    }
    if (!customPropertyKeyPattern.test(key)) {
      return;
    }
    if (systemFields.has(lowerKey) || seenKeys.has(lowerKey)) {
      return;
    }
    seenKeys.add(lowerKey);
    const yamlLine = formatFixedPropertyYamlLine(key, type, value, templateContext);
    if (yamlLine) {
      lines.push(yamlLine);
    }
  });

  return lines;
}

function groupNotePlaceholderSections(settings: Settings, templateContext: Record<string, unknown> = {}) {
  const groups: Record<"before_intro" | "before_chapters" | "before_subtitle", string[]> = {
    before_intro: [],
    before_chapters: [],
    before_subtitle: []
  };
  const rows = normalizeNotePlaceholderSections(settings?.notePlaceholderSections);
  rows.forEach((item) => {
    const renderedLines = buildNotePlaceholderLines(item, templateContext);
    if (!renderedLines.length) {
      return;
    }
    groups[item.position].push(...renderedLines);
  });
  return groups;
}

function isYamlDateValue(value: unknown): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function shouldShowHoursInSubtitle(body: SubtitleBodyItemLike[] | null | undefined): boolean {
  const maxTo = (body || []).reduce((max, item) => {
    const to = Number(item?.to || 0);
    return Number.isFinite(to) && to > max ? to : max;
  }, 0);
  return maxTo >= 3600;
}

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
  return Math.max(subtitleMaxTo, chapterMaxTo, duration) >= 3600;
}
