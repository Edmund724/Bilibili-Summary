// extension/notes/render.js
// Note/export rendering logic (Markdown, SRT, TXT, frontmatter, chapters, subtitles, comments).

import { DEFAULT_SETTINGS } from "../core/defaults.js";
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
import { state } from "../core/state.js";

function buildBilibiliEmbedIframe(meta, page = 1) {
  const safeAid = encodeURIComponent(String(meta?.aid || "").trim());
  const safeBvid = encodeURIComponent(String(meta?.bvid || "").trim());
  const safeCid = encodeURIComponent(String(meta?.cid || "").trim());
  const safePage = Number(page) > 0 ? Number(page) : 1;

  return `<iframe src="https://player.bilibili.com/player.html?aid=${safeAid}&bvid=${safeBvid}&cid=${safeCid}&page=${safePage}&autoplay=0" scrolling="no" border="0" frameborder="no" framespacing="0" allow="fullscreen; picture-in-picture" allowfullscreen="true" style="height:100%;width:100%; aspect-ratio: 16 / 9;"> </iframe>`;
}

function buildChapterLines(chapters, withHours = false) {
  const chapterItems = normalizeChapters(chapters);
  if (chapterItems.length === 0) {
    return [];
  }

  return chapterItems.map((item) => {
    const fromText = formatCompactTimestamp(item.from, withHours);
    return `- \`${fromText}\` ${item.title}`;
  });
}

function buildFrontMatter(meta, settings, created, tagsCsv, tagsYaml) {
  const enabled = getEnabledFrontmatterFields(settings);
  const fixedPropertyLines = getFixedFrontmatterPropertyLines(
    settings,
    buildFrontmatterTemplateContext(meta, created, tagsCsv, tagsYaml)
  );
  if (enabled.length === 0 && fixedPropertyLines.length === 0) {
    return "";
  }

  const fieldLines = {
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

function buildFrontmatterTemplateContext(meta, created, tagsCsv, tagsYaml) {
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

function buildHotCommentLines(comments) {
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

export function buildMarkdown(meta, body, settings) {
  const created = formatLocalDate();
  const tags = (settings.tags || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const tagsCsv = tags.join(", ");
  const tagsYaml =
    tags.length === 0 ? "[]" : `[${tags.map((tag) => `"${tag.replace(/"/g, '\\"')}"`).join(", ")}]`;

  const compactWithHours = shouldShowHoursInNote(meta, body);
  const chapterLines = buildChapterLines(meta.chapters || [], compactWithHours);
  const subtitleSectionLines = buildSubtitleSectionLines(
    body,
    meta.chapters || [],
    settings,
    compactWithHours
  );
  const frontMatter = buildFrontMatter(meta, settings, created, tagsCsv, tagsYaml);

  const page = extractPageIndex(location.href);
  const embedIframe = buildBilibiliEmbedIframe(meta, page);
  const intro = String(meta.description || "").trim();
  const noteSectionContext = buildNotePlaceholderTemplateContext(meta, intro);
  const noteSections = groupNotePlaceholderSections(settings, noteSectionContext);

  const lines = [];
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
    settings?.includeHotCommentsInNote ? meta?.hotComments || [] : []
  );
  if (hotCommentLines.length > 0) {
    lines.push("", "## 评论", "", ...hotCommentLines);
  }

  return lines.join("\n");
}

function buildNotePlaceholderLines(item, templateContext = {}) {
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

function buildNotePlaceholderTemplateContext(meta, description) {
  return {
    title: String(meta?.title || "").trim(),
    author: String(meta?.author || "").trim(),
    url: String(cleanVideoUrl() || "").trim(),
    upload_date: String(meta?.uploadDate || "").trim(),
    description: String(description || "").trim()
  };
}

export function buildSrt(body) {
  return body
    .map((item, index) => {
      const from = formatTimestamp(item.from, true);
      const to = formatTimestamp(item.to, true);
      const text = (item.content || "").trim();
      return `${index + 1}\n${from} --> ${to}\n${text}`;
    })
    .join("\n\n");
}

export function buildSubtitlePreview(body, settings) {
  const compactWithHours = shouldShowHoursInSubtitle(body);
  return (body || [])
    .map((item) => {
      const text = String(item?.content || "").trim();
      if (!text) {
        return "";
      }
      if (settings.includeTimestampInBody) {
        return `\`${formatCompactTimestamp(item.from, compactWithHours)}\` ${text}`;
      }
      return text;
    })
    .filter(Boolean)
    .join("\n");
}

export function buildSubtitleSectionLines(body, chapters, settings, withHours) {
  const subtitleItems = (body || [])
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

  const lines = [];
  const usedIndexes = new Set();
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
    const sectionItems = [];
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

export function buildTxt(body, settings) {
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
      return `${formatCompactTimestamp(item.from, withHours)} ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

function formatFixedPropertyYamlLine(key, type, value, templateContext = {}) {
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

function formatSubtitleLine(item, settings, withHours) {
  const text = String(item?.content || "").trim();
  if (!text) {
    return "";
  }
  if (!settings.includeTimestampInBody) {
    return text;
  }
  return `\`${formatCompactTimestamp(item.from, withHours)}\` ${text}`;
}

function getEnabledFrontmatterFields(settings) {
  const defaultFields = Array.isArray(DEFAULT_SETTINGS.frontmatterFields)
    ? DEFAULT_SETTINGS.frontmatterFields
    : [];
  const raw = Array.isArray(settings?.frontmatterFields) ? settings.frontmatterFields : defaultFields;
  const allowed = new Set(defaultFields);
  const unique = [];
  raw.forEach((item) => {
    const key = String(item || "").trim();
    if (!key || !allowed.has(key) || unique.includes(key)) {
      return;
    }
    unique.push(key);
  });
  return unique;
}

function getFixedFrontmatterPropertyLines(settings, templateContext = {}) {
  const customPropertyKeyPattern = /^[\p{L}\p{N}_\-\s]+$/u;
  const systemFields = new Set(
    (Array.isArray(DEFAULT_SETTINGS.frontmatterFields) ? DEFAULT_SETTINGS.frontmatterFields : []).map((field) =>
      String(field).toLowerCase()
    )
  );
  const rows = Array.isArray(settings?.fixedFrontmatterProperties) ? settings.fixedFrontmatterProperties : [];
  const seenKeys = new Set();
  const lines = [];

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

function groupNotePlaceholderSections(settings, templateContext = {}) {
  const groups = {
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

function isYamlDateValue(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function shouldShowHoursInSubtitle(body) {
  const maxTo = (body || []).reduce((max, item) => {
    const to = Number(item?.to || 0);
    return Number.isFinite(to) && to > max ? to : max;
  }, 0);
  return maxTo >= 3600;
}

export function shouldShowHoursInNote(meta, body) {
  const subtitleMaxTo = (body || []).reduce((max, item) => {
    const to = Number(item?.to || 0);
    return Number.isFinite(to) && to > max ? to : max;
  }, 0);
  const chapterMaxTo = normalizeChapters(meta?.chapters || []).reduce((max, item) => {
    const from = Number(item?.from || 0) || 0;
    const to = Number(item?.to || 0) || 0;
    return Math.max(max, from, to);
  }, 0);
  const duration = Number(meta?.videoDuration || 0) || 0;
  return Math.max(subtitleMaxTo, chapterMaxTo, duration) >= 3600;
}
