import { logWarn, logError } from "../shared/logging.js";
import { parseBvidFromCacheKey, readLruIndex, writeWithEviction, type EvictionResult, type EvictionFailure } from "../core/cache-lru.js";
import type { SubtitleTrack } from "../bilibili/gateway.js";

interface LruIndexEntry {
  ts: number;
  keys: string[];
}

type LruFamilyEntry = Record<string, LruIndexEntry | number | unknown>;

const CACHE_KEY_PREFIX = "boc_subtitle_cache_";
// ASR 变体 source key 前缀：fetcher 以 subtitleId "asr:<providerId>:<model>:<lang>"
// 组键（经 buildSubtitleSourceKey 的 id_ 分支），用于识别/清理过期 ASR 转写变体。
const ASR_SOURCE_KEY_PREFIX = "id_asr:";

export interface SubtitleCacheKeyOptions {
  bvid: string;
  cid: string;
  subtitleId?: string;
  subtitleUrl?: string;
  lang?: string;
}

export type SaveSubtitleResult = EvictionResult | EvictionFailure;

export function getSubtitleCacheKey({ bvid, cid, subtitleId = "", subtitleUrl = "", lang = "" }: SubtitleCacheKeyOptions): string {
  const sourceKey = buildSubtitleSourceKey(subtitleId, subtitleUrl, lang);
  return `${CACHE_KEY_PREFIX}${bvid}_${cid}_${sourceKey}`;
}

export function normalizeSubtitleUrlForCache(url: unknown): string {
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

export async function loadSubtitleFromCache(cacheKey: string): Promise<unknown[] | null> {
  try {
    const result = await chrome.storage.local.get(cacheKey);
    const cached = result[cacheKey] as { body?: unknown[] } | undefined;
    return cached?.body || null;
  } catch {
    return null;
  }
}

export async function saveSubtitleToCache(cacheKey: string, body: unknown[]): Promise<SaveSubtitleResult> {
  const result = await writeWithEviction({
    family: CACHE_KEY_PREFIX,
    bvid: parseBvidFromCacheKey(cacheKey, CACHE_KEY_PREFIX),
    keys: [cacheKey], // 本次写入的缓存键，记录进 LRU 索引供淘汰时免全量扫描
    write: () =>
      chrome.storage.local.set({
        [cacheKey]: {
          body,
          timestamp: Date.now()
        }
      })
  });
  if (!result.ok) {
    logError("[BOC] failed to save subtitle cache after eviction", {
      cacheKey,
      error: result.error?.message || result.error
    });
  }
  return result;
}

interface AsrCacheCleanupOptions {
  bvid: string;
  cid: string;
  keepKey?: string;
}

/**
 * ASR 孤儿清理：删除同 (bvid, cid) 下除 keepKey 外的 ASR 变体缓存键
 * （不同 provider/model/language 的旧转写，键含 "id_asr:" source key）。
 * 平台字幕轨（id_/url_/lang_ 且非 asr:）不是孤儿，一律保留。
 * 枚举走 LRU 索引定点批量读取；索引缺失 / 该 bvid 无条目 / 条目无 keys 时
 * 回退 get(null) 前缀扫描（镜像 pruneToRecentVideos 的兜底模式）。
 * 返回删除的键数组；失败 logWarn 并返回 []，不抛异常。
 */
export async function clearStaleAsrSubtitleCache({ bvid, cid, keepKey = "" }: AsrCacheCleanupOptions): Promise<string[]> {
  try {
    const keyPrefix = `${CACHE_KEY_PREFIX}${bvid}_${cid}_${ASR_SOURCE_KEY_PREFIX}`;
    const index = await readLruIndex();
    const familyEntry = (index[CACHE_KEY_PREFIX] && typeof index[CACHE_KEY_PREFIX] === "object" ? index[CACHE_KEY_PREFIX] : {}) as LruFamilyEntry;
    const bvidEntry = familyEntry[bvid] as LruIndexEntry | number | unknown;
    const normalizedBvidEntry =
      bvidEntry && typeof bvidEntry === "object" && Array.isArray((bvidEntry as LruIndexEntry).keys)
        ? (bvidEntry as LruIndexEntry)
        : null;
    const all = normalizedBvidEntry && normalizedBvidEntry.keys.length > 0
      ? await chrome.storage.local.get(
          normalizedBvidEntry.keys.filter((key): key is string => typeof key === "string" && key.startsWith(keyPrefix))
        )
      : await chrome.storage.local.get(null);
    const staleKeys = Object.keys(all || {}).filter(
      (key) => typeof key === "string" && key.startsWith(keyPrefix) && key !== keepKey
    );
    if (staleKeys.length > 0) {
      await chrome.storage.local.remove(staleKeys);
    }
    return staleKeys;
  } catch (error) {
    logWarn("[BOC] failed to clear stale asr subtitle cache entries", { bvid, cid, error });
    return [];
  }
}

export async function clearSubtitleCacheByKey(cacheKey: string): Promise<void> {
  try {
    await chrome.storage.local.remove(cacheKey);
  } catch (error) {
    logWarn("[BOC] failed to clear subtitle cache by key", { cacheKey, error });
  }
}

export function buildSubtitleSourceKey(subtitleId: unknown, subtitleUrl: unknown, lang: unknown): string {
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

export function buildSubtitleCandidates(subtitles: SubtitleTrack[] | null | undefined, preferred: SubtitleTrack | null | undefined): SubtitleTrack[] {
  const tracks = subtitles || [];
  const seen = new Set<string>();
  const list: SubtitleTrack[] = [];

  const pushUnique = (item: SubtitleTrack | null | undefined) => {
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
