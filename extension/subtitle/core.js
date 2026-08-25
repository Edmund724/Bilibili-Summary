import { state, clipState } from "../core/state.js";
import { formatLocalDate } from "../core/shared-defaults.js";
import { byId } from "../core/runtime.js";
import { normalizeChapters } from "./selection.js";
import {
  buildSubtitlePreview,
  buildMarkdown,
  buildSrt,
  buildTxt
} from "../notes/render.js";

export function readVideoTitle() {
  const h1 = document.querySelector("h1.video-title");
  if (h1?.textContent?.trim()) {
    return h1.textContent.trim();
  }

  const metaTitle = document.querySelector('meta[property="og:title"]');
  if (metaTitle?.getAttribute("content")) {
    return metaTitle.getAttribute("content").trim();
  }

  return document.title.replace(/_哔哩哔哩_bilibili/i, "").trim();
}

export function readVideoAuthor() {
  const owner = document.querySelector(".up-name");
  if (owner?.textContent?.trim()) {
    return owner.textContent.trim();
  }

  const author = document.querySelector('meta[name="author"]');
  return author?.getAttribute("content")?.trim() || "";
}

export function readUploadDate() {
  const publishNode = document.querySelector('meta[itemprop="uploadDate"]');
  if (publishNode?.getAttribute("content")) {
    return publishNode.getAttribute("content").trim();
  }

  const dateText = document.querySelector(".pubdate-ip-text")?.textContent?.trim();
  if (dateText) {
    return dateText;
  }

  return formatLocalDate();
}

export function getReadingTranscriptItems(body = state.clip.subtitleBody) {
  return (Array.isArray(body) ? body : [])
    .map((item, index) => ({
      index,
      from: Number(item?.from || 0) || 0,
      to: Number(item?.to || 0) || 0,
      content: String(item?.content || "").trim()
    }))
    .filter((item) => item.content);
}

export function getReadingTranscriptPlaceholderText() {
  if (state.clip.subtitleFetchState === "loading") {
    return "正在加载字幕...";
  }
  if (state.clip.subtitleFetchState === "error") {
    return "字幕加载失败，请刷新重试。";
  }
  return "当前视频无字幕。";
}

export function findActiveSubtitleIndex(currentTime) {
  const items = Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const from = Number(item?.from || 0) || 0;
    const rawTo = Number(item?.to || 0) || 0;
    const to = rawTo > from ? rawTo : from + 2;
    if (currentTime >= from && currentTime < to) {
      return index;
    }
  }
  return -1;
}

export function findActiveChapterIndex(currentTime) {
  const chapters = normalizeChapters(state.clip.chapters || []);
  for (let index = 0; index < chapters.length; index += 1) {
    const item = chapters[index];
    const from = Number(item?.from || 0) || 0;
    const next = chapters[index + 1];
    const explicitTo = Number(item?.to || 0) || 0;
    const fallbackTo = next && Number(next.from) > from ? Number(next.from) : explicitTo;
    const to = fallbackTo > from ? fallbackTo : Number.POSITIVE_INFINITY;
    if (currentTime >= from && currentTime < to) {
      return index;
    }
  }
  return -1;
}

export function rebuildDerivedContent() {
  const body = Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
  clipState.setMarkdown(body.length ? buildMarkdown(state, body, state.settings) : "");
  clipState.setSrt(body.length ? buildSrt(body) : "");
  clipState.setTxt(body.length ? buildTxt(body, state.settings) : "");
  byId("boc-preview").value = body.length ? buildSubtitlePreview(body, state.settings) : "";
}
