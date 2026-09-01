import { normalizeSubtitleUrlForCache } from "./cache.js";
import type { Chapter, SubtitleTrack } from "../bilibili/gateway.js";

export interface PreferredSubtitleContext {
  previousId?: string;
  previousUrl?: string;
  previousLang?: string;
}

export interface DurationValidationResult {
  ok: boolean;
  reason: string;
  videoDuration: number;
  maxTo: number;
}

interface RawSubtitleTrack {
  id?: string | number | null;
  lan?: string;
  lan_doc?: string;
  subtitle_url?: string;
  subtitleUrl?: string;
  lanDoc?: string;
}

interface RawChapterPoint {
  content?: string;
  title?: string;
  label?: string;
  from?: number | string;
  start?: number | string;
  start_time?: number | string;
  to?: number | string;
  end?: number | string;
  end_time?: number | string;
}

interface RawPlayerData {
  view_points?: RawChapterPoint[];
}

function subtitlePriority(item: SubtitleTrack | RawSubtitleTrack): number {
  const lan = String(item?.lan || "").toLowerCase();
  const label = String((item as { lanDoc?: string }).lanDoc || "").toLowerCase();

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

export function normalizeSubtitleTracks(subtitles?: SubtitleTrack[] | RawSubtitleTrack[] | null): SubtitleTrack[] {
  return [...(subtitles || [])].sort((a, b) => {
    const p = subtitlePriority(a) - subtitlePriority(b);
    if (p !== 0) {
      return p;
    }

    const lanA = String((a as { lanDoc?: string }).lanDoc || a.lan || "").toLowerCase();
    const lanB = String((b as { lanDoc?: string }).lanDoc || b.lan || "").toLowerCase();
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

    return String((a as { subtitleUrl?: string }).subtitleUrl).localeCompare(String((b as { subtitleUrl?: string }).subtitleUrl));
  }) as SubtitleTrack[];
}

export function pickPreferredSubtitle(
  subtitles: SubtitleTrack[] | RawSubtitleTrack[] | null | undefined,
  { previousId = "", previousUrl = "", previousLang = "" }: PreferredSubtitleContext = {}
): SubtitleTrack | null {
  const tracks = subtitles || [];
  if (tracks.length === 0) {
    return null;
  }

  // 先按轨道 id 复用，最稳定
  if (previousId) {
    const byId = tracks.find((item) => String(item.id || "") === String(previousId));
    if (byId) {
      return byId as SubtitleTrack;
    }
  }

  // 其次按 URL 路径复用（忽略 auth_key 等动态参数）
  const prevUrlKey = normalizeSubtitleUrlForCache(previousUrl);
  if (prevUrlKey) {
    const byUrl = tracks.find(
      (item) => normalizeSubtitleUrlForCache((item as { subtitleUrl?: string }).subtitleUrl) === prevUrlKey
    );
    if (byUrl) {
      return byUrl as SubtitleTrack;
    }
  }

  const normalizedPrevLang = String(previousLang || "").trim().toLowerCase();
  if (normalizedPrevLang) {
    const byLang = tracks.find((item) => {
      const label = String((item as { lanDoc?: string }).lanDoc || item.lan || "").trim().toLowerCase();
      return label === normalizedPrevLang;
    });
    if (byLang) {
      return byLang as SubtitleTrack;
    }
  }

  // 默认直接拿排序后的第一条：中文优先，其次英文。
  return tracks[0] as SubtitleTrack;
}

export function validateSubtitleByDuration(body: unknown[], videoDuration: unknown): DurationValidationResult {
  const duration = Number(videoDuration || 0);
  if (!Array.isArray(body) || body.length === 0) {
    return { ok: false, reason: "empty", videoDuration: duration, maxTo: 0 };
  }

  let maxTo = 0;
  for (const item of body) {
    const to = Number((item as { to?: unknown }).to);
    const from = Number((item as { from?: unknown }).from);
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

export function isAiSubtitle(item: { lan?: string } | null | undefined): boolean {
  const lan = String(item?.lan || "").toLowerCase();
  // B站 AI 自动字幕的 lan 以 "ai-" 开头
  return lan.startsWith("ai-");
}

// 候选10 批1：写入端统一保证 subtitleBody 按 from 升序（稳定排序，同 from
// 保持原有相对顺序，与读路径旧线性扫描的命中顺序一致）。core.js 的
// findActiveSubtitleIndex 二分查找依赖该不变量；读路径一律不排序。
// 唯一写入点为字幕接受事务（subtitle/commit.js acceptSubtitle）；缓存写入前
// 的调用方预备排序（fetcher 网络路径落缓存）是仅有的例外。
// 返回新数组，不原地修改入参（调用方持有的原引用保持不变）。
export function sortSubtitleBodyByFrom<T>(body: T[] | null | undefined): T[] | null | undefined {
  if (!Array.isArray(body)) {
    return body;
  }
  return [...body].sort(
    (a, b) => (Number((a as { from?: unknown }).from || 0) || 0) - (Number((b as { from?: unknown }).from || 0) || 0)
  );
}

function normalizeSubtitleUrl(url: unknown): string {
  if (!url) {
    return "";
  }

  const text = String(url);
  if (text.startsWith("//")) {
    return `https:${text}`;
  }

  if (text.startsWith("http://") || text.startsWith("https://")) {
    return text;
  }

  return `https://${text.replace(/^\/+/, "")}`;
}

export function mapSubtitleTracks(subtitles: unknown[], source = "unknown"): SubtitleTrack[] {
  return (subtitles || []).map((item) => ({
    id: (item as RawSubtitleTrack).id === undefined || (item as RawSubtitleTrack).id === null ? "" : String((item as RawSubtitleTrack).id),
    lan: (item as RawSubtitleTrack).lan || "",
    lanDoc: (item as RawSubtitleTrack).lan_doc || "",
    subtitleUrl: normalizeSubtitleUrl((item as RawSubtitleTrack).subtitle_url || ""),
    source
  }));
}

export function mapChaptersFromPlayerData(data: RawPlayerData | unknown): Chapter[] {
  const viewPoints = (data as RawPlayerData)?.view_points;
  const raw = Array.isArray(viewPoints) ? viewPoints : [];
  return normalizeChapters(
    raw.map((item) => ({
      title: String(item?.content || item?.title || item?.label || "").trim(),
      from: normalizeChapterTime(item?.from ?? item?.start ?? item?.start_time),
      to: normalizeChapterTime(item?.to ?? item?.end ?? item?.end_time),
      source: "player-view-points"
    }))
  );
}

function normalizeChapterTime(value: unknown): number {
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
