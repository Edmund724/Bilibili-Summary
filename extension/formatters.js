import { DEFAULT_SETTINGS, formatLocalDate, normalizeDownloadFormat } from "./shared-defaults.js";
import { state } from "./state.js";
import { extractPageIndex, cleanVideoUrl, sendRuntimeMessage, isExtensionContextInvalidated, toReadableText } from "./router.js";

export function buildBilibiliEmbedIframe(meta, page = 1) {
  const safeAid = encodeURIComponent(String(meta?.aid || "").trim());
  const safeBvid = encodeURIComponent(String(meta?.bvid || "").trim());
  const safeCid = encodeURIComponent(String(meta?.cid || "").trim());
  const safePage = Number(page) > 0 ? Number(page) : 1;

  return `<iframe src="https://player.bilibili.com/player.html?aid=${safeAid}&bvid=${safeBvid}&cid=${safeCid}&page=${safePage}&autoplay=0" scrolling="no" border="0" frameborder="no" framespacing="0" allow="fullscreen; picture-in-picture" allowfullscreen="true" style="height:100%;width:100%; aspect-ratio: 16 / 9;"> </iframe>`;
}


export function buildChapterLines(chapters, withHours = false) {
  const chapterItems = normalizeChapters(chapters);
  if (chapterItems.length === 0) {
    return [];
  }

  return chapterItems.map((item) => {
    const fromText = formatCompactTimestamp(item.from, withHours);
    return `- \`${fromText}\` ${item.title}`;
  });
}


export function buildFolderTemplateContext(meta, created = formatLocalDate()) {
  return {
    created: sanitizeFolderTemplateValue(created),
    upload_date: sanitizeFolderTemplateValue(meta?.uploadDate || ""),
    author: sanitizeFolderTemplateValue(meta?.author || ""),
    bvid: sanitizeFolderTemplateValue(meta?.bvid || "")
  };
}


export function buildFrontMatter(meta, settings, created, tagsCsv, tagsYaml) {
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


export function buildFrontmatterTemplateContext(meta, created, tagsCsv, tagsYaml) {
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


export function buildHotCommentLines(comments) {
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


export function buildNoteFilename(meta) {
  const includeDate = state.settings?.includeDateInFilename !== false;
  const baseParts = [];

  if (includeDate) {
    baseParts.push(formatLocalDate());
  }

  baseParts.push(meta.title || meta.bvid || "bilibili-subtitle");

  if (Number(meta.pageCount) > 1) {
    baseParts.push(`P${Number(meta.pageIndex) > 0 ? Number(meta.pageIndex) : 1}`);
    const pageTitle = String(meta.pageTitle || "").trim();
    if (pageTitle) {
      baseParts.push(pageTitle);
    }
  }

  const baseName = sanitizeFileName(baseParts.filter(Boolean).join("-"));
  return `${baseName || "bilibili-subtitle"}.md`;
}


export function buildNotePlaceholderLines(item, templateContext = {}) {
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


export function buildNotePlaceholderTemplateContext(meta, description) {
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


export function buildSubtitleCandidates(subtitles, preferred) {
  const tracks = subtitles || [];
  const seen = new Set();
  const list = [];

  const pushUnique = (item) => {
    if (!item) {
      return;
    }
    const key =
      `${String(item.id || "").trim()}|` +
      `${normalizeSubtitleUrlForCache(item.subtitleUrl)}|` +
      `${String(item.lan || "").trim().toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    list.push(item);
  };

  pushUnique(preferred);
  for (const item of tracks) {
    pushUnique(item);
  }
  return list;
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

    const sectionItems = subtitleItems.filter((item) => {
      const from = Number(item.from || 0) || 0;
      const inStart = from + 0.001 >= start;
      const inEnd = end === Infinity ? true : from < end;
      return inStart && inEnd;
    });

    if (sectionItems.length === 0) {
      return;
    }

    const chapterStamp = settings.includeTimestampInBody
      ? ` \`${formatCompactTimestamp(start, withHours)}\``
      : "";
    lines.push(`### ${chapter.title}${chapterStamp}`, "");
    sectionItems.forEach((item) => {
      usedIndexes.add(item._index);
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


export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}


export function escapeYaml(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}


export function formatCompactTimestamp(seconds, withHours) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const hour = Math.floor(safe / 3600);
  const minute = Math.floor((safe % 3600) / 60);
  const second = safe % 60;

  if (withHours) {
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(
      second
    ).padStart(2, "0")}`;
  }

  const totalMinutes = Math.floor(safe / 60);
  return `${String(totalMinutes).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}


export function formatFixedPropertyYamlLine(key, type, value, templateContext = {}) {
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


export function formatSubtitleLine(item, settings, withHours) {
  const text = String(item?.content || "").trim();
  if (!text) {
    return "";
  }
  if (!settings.includeTimestampInBody) {
    return text;
  }
  return `\`${formatCompactTimestamp(item.from, withHours)}\` ${text}`;
}


export function formatTimestamp(seconds, forSrt = false) {
  const safe = Number(seconds) || 0;
  const msTotal = Math.max(0, Math.floor(safe * 1000));
  const hour = Math.floor(msTotal / 3600000);
  const minute = Math.floor((msTotal % 3600000) / 60000);
  const second = Math.floor((msTotal % 60000) / 1000);
  const ms = msTotal % 1000;

  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const ss = String(second).padStart(2, "0");
  if (!forSrt) {
    return `${hh}:${mm}:${ss}.${String(ms).padStart(3, "0")}`;
  }

  return `${hh}:${mm}:${ss},${String(ms).padStart(3, "0")}`;
}


export function getEnabledFrontmatterFields(settings) {
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


export function getFixedFrontmatterPropertyLines(settings, templateContext = {}) {
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


export function groupNotePlaceholderSections(settings, templateContext = {}) {
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


export function isAiSubtitle(item) {
  const lan = String(item?.lan || "").toLowerCase();
  // B站 AI 自动字幕的 lan 以 "ai-" 开头
  return lan.startsWith("ai-");
}


export function isYamlDateValue(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}


export function normalizeChapters(chapters) {
  const normalized = (chapters || [])
    .map((item) => ({
      title: String(item?.title || "").trim(),
      from: Number(item?.from || 0) || 0,
      to: Number(item?.to || 0) || 0,
      source: String(item?.source || "")
    }))
    .filter((item) => item.title && item.from >= 0)
    .sort((a, b) => a.from - b.from);

  const unique = [];
  const seen = new Set();
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


export function normalizeFolder(input) {
  return String(input || "").trim().replace(/^\/+|\/+$/g, "");
}


export function normalizeHotComments(comments, limit = 20) {
  if (!Array.isArray(comments)) {
    return [];
  }

  return comments
    .map((item) => ({
      uname: String(item?.uname || "匿名").trim() || "匿名",
      like: Number(item?.like || 0) || 0,
      message: String(item?.message || "").trim().slice(0, 500)
    }))
    .filter((item) => item.message)
    .slice(0, limit);
}




export function normalizeSubtitleTracks(subtitles) {
  return [...(subtitles || [])].sort((a, b) => {
    const p = subtitlePriority(a) - subtitlePriority(b);
    if (p !== 0) {
      return p;
    }

    const lanA = String(a.lanDoc || a.lan || "").toLowerCase();
    const lanB = String(b.lanDoc || b.lan || "").toLowerCase();
    if (lanA < lanB) {
      return -1;
    }
    if (lanA > lanB) {
      return 1;
    }

    const idA = Number.parseInt(String(a.id || "0"), 10);
    const idB = Number.parseInt(String(b.id || "0"), 10);
    if (Number.isFinite(idA) && Number.isFinite(idB) && idA !== idB) {
      return idA - idB;
    }

    return String(a.subtitleUrl).localeCompare(String(b.subtitleUrl));
  });
}


export function pickPreferredSubtitle(
  subtitles,
  { previousId = "", previousUrl = "", previousLang = "" } = {}
) {
  const tracks = subtitles || [];
  if (tracks.length === 0) {
    return null;
  }

  // 先按轨道 id 复用，最稳定
  if (previousId) {
    const byId = tracks.find((item) => String(item.id || "") === String(previousId));
    if (byId) {
      return byId;
    }
  }

  // 其次按 URL 路径复用（忽略 auth_key 等动态参数）
  const prevUrlKey = normalizeSubtitleUrlForCache(previousUrl);
  if (prevUrlKey) {
    const byUrl = tracks.find(
      (item) => normalizeSubtitleUrlForCache(item.subtitleUrl) === prevUrlKey
    );
    if (byUrl) {
      return byUrl;
    }
  }

  const normalizedPrevLang = String(previousLang || "").trim().toLowerCase();
  if (normalizedPrevLang) {
    const byLang = tracks.find((item) => {
      const label = String(item.lanDoc || item.lan || "").trim().toLowerCase();
      return label === normalizedPrevLang;
    });
    if (byLang) {
      return byLang;
    }
  }

  // 默认直接拿排序后的第一条：中文优先，其次英文。
  return tracks[0];
}


export function subtitlePriority(item) {
  const lan = String(item?.lan || "").toLowerCase();
  const label = String(item?.lanDoc || "").toLowerCase();

  // 优先级：中文（包含 AI 中文）-> 英文 -> 其他
  if (lan === "zh-cn" || lan === "zh-hans") {
    return 0;
  }
  if (lan === "zh") {
    return 1;
  }
  if (lan.includes("zh")) {
    return 2;
  }
  if (label.includes("中文")) {
    return 3;
  }

  if (lan === "en" || lan === "en-us" || lan === "en-gb") {
    return 10;
  }
  if (lan.includes("en")) {
    return 11;
  }
  if (label.includes("英文") || label.includes("英语") || label.includes("english")) {
    return 12;
  }

  return 50;
}


export function validateSubtitleByDuration(body, videoDuration) {
  const duration = Number(videoDuration || 0);
  if (!Array.isArray(body) || body.length === 0) {
    return { ok: false, reason: "empty", videoDuration: duration, maxTo: 0 };
  }

  let maxTo = 0;
  for (const item of body) {
    const to = Number(item?.to);
    const from = Number(item?.from);
    if (Number.isFinite(to) && to > maxTo) {
      maxTo = to;
    }
    if (Number.isFinite(from) && from > maxTo) {
      maxTo = from;
    }
  }

  if (!(duration > 0)) {
    return { ok: true, reason: "skip-no-video-duration", videoDuration: duration, maxTo };
  }

  const upperTolerance = Math.max(12, duration * 0.15);
  if (maxTo > duration + upperTolerance) {
    return { ok: false, reason: "too-long", videoDuration: duration, maxTo };
  }

  let minCoverageRatio = 0;
  if (duration >= 600) {
    minCoverageRatio = 0.18;
  } else if (duration >= 300) {
    minCoverageRatio = 0.22;
  } else if (duration >= 180) {
    minCoverageRatio = 0.25;
  }

  if (minCoverageRatio > 0 && maxTo < duration * minCoverageRatio) {
    return { ok: false, reason: "too-short", videoDuration: duration, maxTo };
  }

  return { ok: true, reason: "ok", videoDuration: duration, maxTo };
}


export function normalizeSubtitleUrlForCache(url) {
  const text = String(url || "").trim();
  if (!text) {
    return "";
  }

  try {
    const parsed = new URL(text);
    const path = parsed.pathname.replace(/[^\w/.-]+/g, "_");
    return `${parsed.hostname}${path}`;
  } catch {
    return text.replace(/[^\w/.-]+/g, "_");
  }
}

export async function loadSubtitleFromCache(cacheKey) {
  try {
    const result = await chrome.storage.local.get(cacheKey);
    return result[cacheKey]?.body || null;
  } catch {
    return null;
  }
}

export async function saveSubtitleToCache(cacheKey, body) {
  try {
    await chrome.storage.local.set({
      [cacheKey]: {
        body,
        timestamp: Date.now()
      }
    });
  } catch (error) {
    logWarn("[BOC] failed to save subtitle cache", error);
  }
}

export async function clearSubtitleCacheByKey(cacheKey) {
  try {
    await chrome.storage.local.remove(cacheKey);
  } catch (error) {
    logWarn("[BOC] failed to clear subtitle cache by key", { cacheKey, error });
  }
}

async function clearSubtitleCache(bvid, cid, lang) {
  const cacheKey = getSubtitleCacheKey({ bvid, cid, lang });
  try {
    await chrome.storage.local.remove(cacheKey);
    logInfo("[BOC] cleared subtitle cache", { cacheKey });
  } catch (error) {
    logWarn("[BOC] failed to clear subtitle cache", error);
  }
}


export function resolveFolderTemplate(template, meta) {
  const normalized = normalizeFolder(template);
  if (!normalized) {
    return "";
  }

  const allowedKeys = new Set(["created", "upload_date", "author", "bvid"]);
  const context = buildFolderTemplateContext(meta);
  const resolved = String(normalized).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, rawKey) => {
    const key = String(rawKey || "").trim().toLowerCase();
    if (!allowedKeys.has(key)) {
      return "";
    }
    return context[key] || "";
  });

  return resolved
    .split("/")
    .map((segment) => sanitizeFolderTemplateValue(segment))
    .filter(Boolean)
    .join("/");
}


export function pushOptionalLines(targetLines, extraLines) {
  if (!Array.isArray(extraLines) || !extraLines.length) {
    return;
  }
  targetLines.push(...extraLines);
}


export function resolveFrontmatterTemplateValue(value, templateContext = {}) {
  return String(value || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, rawKey) => {
    const key = String(rawKey || "").trim().toLowerCase();
    if (!key) {
      return "";
    }
    const resolved = templateContext[key];
    return resolved == null ? "" : String(resolved);
  });
}


export function parseFrontmatterArrayItems(value) {
  return String(value || "")
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}


export function normalizeNotePlaceholderSections(items) {
  const allowedPositions = new Set(["before_intro", "before_chapters", "before_subtitle"]);
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => {
      const title = String(item?.title || "").trim();
      const position = allowedPositions.has(String(item?.position || "").trim())
        ? String(item?.position || "").trim()
        : "before_intro";
      const content = String(item?.content || "").trim();
      return {
        title,
        position,
        content
      };
    })
    .filter((item) => item.title)
    .slice(0, 5);
}


export function shouldShowHoursInSubtitle(body) {
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


export function sanitizeFileName(value) {
  return value.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
}




export function mapSubtitleTracks(subtitles, source = "unknown") {
  return (subtitles || []).map((item) => ({
    id: item?.id === undefined || item?.id === null ? "" : String(item.id),
    lan: item?.lan || "",
    lanDoc: item?.lan_doc || "",
    subtitleUrl: normalizeSubtitleUrl(item?.subtitle_url || ""),
    source
  }));
}


export function mapChaptersFromPlayerData(data) {
  const raw = Array.isArray(data?.view_points) ? data.view_points : [];
  return normalizeChapters(
    raw.map((item) => ({
      title: String(item?.content || item?.title || item?.label || "").trim(),
      from: normalizeChapterTime(item?.from ?? item?.start ?? item?.start_time),
      to: normalizeChapterTime(item?.to ?? item?.end ?? item?.end_time),
      source: "player-view-points"
    }))
  );
}


export function normalizeChapterTime(value) {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return 0;
  }

  // 某些接口会返回毫秒级时间戳，这里统一转换成秒。
  return num > 60 * 60 * 24 ? num / 1000 : num;
}


export function buildSubtitleInfoRequests({ bvid, cid, aid }) {
  const safeBvid = encodeURIComponent(String(bvid || ""));
  const safeCid = encodeURIComponent(String(cid || ""));
  const safeAid = encodeURIComponent(String(aid || ""));
  const requests = [];

  // 参考 SubBatch：优先用 aid+cid 的 wbi 接口作为主来源。
  if (aid) {
    requests.push({
      source: "player-wbi-v2",
      url:
        "https://api.bilibili.com/x/player/wbi/v2" +
        `?aid=${safeAid}` +
        `&cid=${safeCid}` +
        (bvid ? `&bvid=${safeBvid}` : "")
    });
  }

  // 仅在主来源不可用时再回退到 player-v2。
  requests.push({
    source: "player-v2",
    url:
      "https://api.bilibili.com/x/player/v2" +
      (bvid ? `?bvid=${safeBvid}` : "?") +
      `${bvid ? "&" : ""}cid=${safeCid}` +
      (aid ? `&aid=${safeAid}` : "")
  });

  return requests;
}


export function buildBiliApiError(payload, fallbackMessage) {
  const msg = toReadableText(payload?.message, fallbackMessage);
  const error = new Error(msg);
  error.code = payload?.code;
  error.retryable = isRetryableError(payload?.code);
  return error;
}


export function isRetryableError(code) {
  // -509: 请求过于频繁
  // -3: 参数错误（可能是临时性的）
  // 其他负数错误码也可能是临时性的
  return code === -509 || code === -3 || code < 0;
}


export function readRuntimeVideoDuration() {
  const video = getRuntimeVideoElement();
  const duration = Number(video?.duration);
  if (Number.isFinite(duration) && duration > 0) {
    return duration;
  }
  return 0;
}

export async function fetchSubtitleBody(url) {
  logInfo("[BOC] fetch subtitle body", { url });
  return fetchJsonInBackground(url);
}

export async function fetchJson(url) {
  if (typeof url === "string" && url.startsWith("https://api.bilibili.com/")) {
    return fetchJsonInBackground(url);
  }

  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`请求失败：${response.status}`);
  }

  return response.json();
}

export async function fetchJsonInBackground(url) {
  try {
    const resp = await sendRuntimeMessage({ type: "fetch-json", url });
    if (!resp?.ok) {
      throw new Error(toReadableText(resp?.error, "Background fetch failed"));
    }
    return resp.data;
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      throw new Error("扩展刚刚更新，请刷新当前页面后重试。");
    }
    throw error;
  }
}


export function getCurrentAid() {
  let aid = Number(state.aid) || 0;
  if (!aid && typeof window !== "undefined") {
    try {
      aid = Number(window?.__INITIAL_STATE__?.aid) || 0;
    } catch {}
  }
  return aid;
}

export async function fetchHotComments(count = 20) {
  const safeCount = Math.max(0, Number(count) || 0);
  if (!safeCount) {
    return [];
  }

  const aid = getCurrentAid();
  if (!aid) {
    return [];
  }

  const url = `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=3&ps=${safeCount}&pn=1`;
  const resp = await sendRuntimeMessage({ type: "fetch-json", url });
  if (!resp?.ok) {
    throw new Error(resp?.error || "评论接口失败");
  }

  const replies = Array.isArray(resp?.data?.data?.replies) ? resp.data.data.replies : [];
  return normalizeHotComments(
    replies.map((item) => ({
      uname: item?.member?.uname || "匿名",
      like: item?.like || 0,
      message: item?.content?.message || ""
    })),
    safeCount
  );
}


export function normalizeSubtitleUrl(url) {
  if (!url) {
    return "";
  }

  if (url.startsWith("//")) {
    return `https:${url}`;
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }

  return `https://${url.replace(/^\/+/, "")}`;
}


export function buildSubtitleSourceKey(subtitleId, subtitleUrl, lang) {
  const id = String(subtitleId || "").trim();
  if (id) {
    return `id_${id}`;
  }

  const normalizedUrl = normalizeSubtitleUrlForCache(subtitleUrl);
  if (normalizedUrl) {
    return `url_${normalizedUrl}`;
  }

  return `lang_${String(lang || "").trim().toLowerCase() || "unknown"}`;
}


export function sanitizeFolderTemplateValue(value) {
  return String(value || "")
    .replace(/[\/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

