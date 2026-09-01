import { state, clipState } from "../core/state.js";
import { formatLocalDate } from "../shared/utils.js";
import { logWarn } from "../shared/logging.js";
import { fetchHotComments } from "../bilibili/gateway.js";
import { normalizeChapters } from "./selection.js";
import {
  buildSubtitlePreview,
  buildMarkdown,
  buildSrt,
  buildTxt
} from "../notes/render.js";
import type { State } from "../core/state.js";

export interface ReadingSubtitleItem {
  index: number;
  from: number;
  to: number;
  content: string;
}

interface SubtitleBodyItemLike {
  from?: unknown;
  to?: unknown;
  content?: unknown;
}

interface ChapterItemLike {
  from?: unknown;
  to?: unknown;
  title?: string;
}

export function readVideoTitle(): string {
  const h1 = document.querySelector("h1.video-title");
  if (h1?.textContent?.trim()) {
    return h1.textContent.trim();
  }

  const metaTitle = document.querySelector('meta[property="og:title"]');
  if (metaTitle?.getAttribute("content")) {
    return metaTitle.getAttribute("content")!.trim();
  }

  return document.title.replace(/_哔哩哔哩_bilibili/i, "").trim();
}

export function readVideoAuthor(): string {
  const owner = document.querySelector(".up-name");
  if (owner?.textContent?.trim()) {
    return owner.textContent.trim();
  }

  const author = document.querySelector('meta[name="author"]');
  return author?.getAttribute("content")?.trim() || "";
}

export function readUploadDate(): string {
  const publishNode = document.querySelector('meta[itemprop="uploadDate"]');
  if (publishNode?.getAttribute("content")) {
    return publishNode.getAttribute("content")!.trim();
  }

  const dateText = document.querySelector(".pubdate-ip-text")?.textContent?.trim();
  if (dateText) {
    return dateText;
  }

  return formatLocalDate();
}

export function getReadingSubtitleItems(body: SubtitleBodyItemLike[] = state.clip.subtitleBody): ReadingSubtitleItem[] {
  return (Array.isArray(body) ? body : [])
    .map((item, index) => ({
      index,
      from: Number(item?.from || 0) || 0,
      to: Number(item?.to || 0) || 0,
      content: String(item?.content || "").trim()
    }))
    .filter((item) => item.content);
}

export function getReadingSubtitlePlaceholderText(): string {
  if (state.clip.subtitleFetchState === "loading") {
    return "正在加载字幕...";
  }
  if (state.clip.subtitleFetchState === "error") {
    return "字幕加载失败，请刷新重试。";
  }
  return "当前视频无字幕。";
}

// 候选10 批1：二分命中回扫上限。写入端已保证 subtitleBody 按 from 升序
// （字幕接受事务 subtitle/commit.js 落 state 前统一经 sortSubtitleBodyByFrom
// 稳定排序），
// 正常顺序字幕区间互不重叠，二分候选点（最后一个 from <= currentTime 的条目）
// 就是唯一可能命中者，第一步即返回或即无命中。回扫只为兼容写入端排序前遗留
// 的重叠区间脏缓存，上限之外的深层重叠本就不会出现在正常数据里。
const ACTIVE_SUBTITLE_BACKWARD_SCAN_LIMIT = 8;

// to 缺省/非法时视为 from + 2（与旧线性扫描逐字一致）。
function subtitleActiveRange(item: SubtitleBodyItemLike): { from: number; to: number } {
  const from = Number(item?.from || 0) || 0;
  const rawTo = Number(item?.to || 0) || 0;
  return { from, to: rawTo > from ? rawTo : from + 2 };
}

export function findActiveSubtitleIndex(currentTime: number): number {
  const items = Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
  // 二分定位最后一个 from <= currentTime 的条目（subtitleBody 按 from 升序，
  // 由写入端 sortSubtitleBodyByFrom 保证）。旧实现为线性扫描，长视频 1500+
  // 条时每拍 250ms 全量扫一遍，是阅读视图常驻开销的大头之一。
  let lo = 0;
  let hi = items.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((Number(items[mid]?.from || 0) || 0) <= currentTime) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate < 0) {
    return -1;
  }
  for (let i = candidate, scanned = 0; i >= 0 && scanned <= ACTIVE_SUBTITLE_BACKWARD_SCAN_LIMIT; i -= 1, scanned += 1) {
    const { from, to } = subtitleActiveRange(items[i]);
    if (currentTime >= from && currentTime < to) {
      return i;
    }
  }
  return -1;
}

export function findActiveChapterIndex(currentTime: number): number {
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

export function rebuildDerivedContent(): void {
  const body = Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
  clipState.setMarkdown(body.length ? buildMarkdown(state as State, body, state.settings) : "");
  clipState.setSrt(body.length ? buildSrt(body) : "");
  clipState.setTxt(body.length ? buildTxt(body, state.settings) : "");
  const previewNode = document.getElementById("boc-preview") as HTMLTextAreaElement | null;
  if (!previewNode) {
    throw new Error(`Missing node: boc-preview`);
  }
  previewNode.value = body.length ? buildSubtitlePreview(body, state.settings) : "";
}

// 原 extension/notes/build.js 的 refreshDerivedContent，浅模块合并后内联于此。
export async function refreshDerivedContent({ refreshComments = false } = {}): Promise<void> {
  if (state.settings?.includeHotCommentsInNote) {
    const shouldFetchComments =
      refreshComments || !Array.isArray(state.clip.hotComments) || state.clip.hotComments.length === 0;
    if (shouldFetchComments) {
      try {
        clipState.setHotComments(await fetchHotComments(20));
      } catch (error) {
        clipState.setHotComments([]);
        logWarn("[BOC] failed to fetch hot comments for note export", error);
      }
    }
  }

  rebuildDerivedContent();
}
