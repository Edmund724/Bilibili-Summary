import { logWarn, logError } from "../shared/logging.js";
import { parseBvidFromCacheKey, readFamilyKeys, writeWithEviction, type EvictionResult, type EvictionFailure } from "../core/cache-lru.js";
import type { SubtitleTrack } from "../bilibili/gateway.js";
// 类型专用导入（编译期擦除，无运行时 ai 边）：字幕条目形状归 ai/types 声明。
import type { SubtitleBodyItem } from "../ai/types.js";

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
 * 枚举走 core/cache-lru 的 readFamilyKeys 索引定点批量读取；条目缺失 /
 * 无 keys / 旧格式时由原语回退 get(null) 前缀扫描（含一次性告警，见原语）。
 * 返回删除的键数组；失败 logWarn 并返回 []，不抛异常。
 */
export async function clearStaleAsrSubtitleCache({ bvid, cid, keepKey = "" }: AsrCacheCleanupOptions): Promise<string[]> {
  try {
    const keyPrefix = `${CACHE_KEY_PREFIX}${bvid}_${cid}_${ASR_SOURCE_KEY_PREFIX}`;
    const indexKeys = await readFamilyKeys(CACHE_KEY_PREFIX, bvid, keyPrefix);
    const all = indexKeys
      ? await chrome.storage.local.get(indexKeys)
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

// ===== 字幕签名族（自 ai/analysis 迁入，arch-slim-3 #1）：签名是缓存键，
// 与 source key 同居本叶子；ai/analysis 与 reader/overview 双向消费。=====

// 条目归一：只留 content 非空的 {from,to,content}（ai/analysis 与签名共用同语义）。
export function normalizeSubtitleItems(items: unknown): SubtitleBodyItem[] {
  return (Array.isArray(items) ? items : []).filter(
    (item): item is SubtitleBodyItem => Boolean(item) && String((item as { content?: unknown })?.content ?? "").trim().length > 0
  );
}

// FNV-1a 32 位哈希：确定性轻量签名用（跨会话稳定、无依赖）。
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// 现成目录 → 签名用指纹文本：确定性的（时间戳, 标题）序列。
function chapterOutlineText(chapterOutline: unknown): string {
  return Array.isArray(chapterOutline)
    ? chapterOutline.map((item) => `${Number(item?.seconds) || 0}|${String(item?.title ?? "")}`).join("\n")
    : "";
}

// 「自带章节（模式位）」：非空切换只挑金句短路径，产物形态不同，签名须区分；
// 「chapterOutline」：简介/评论现成目录（切进「照抄边界」提示词路径），同样改变产物形态。
interface SubtitleSignatureInput {
  lang?: unknown;
  subtitleId?: unknown;
  subtitleUrl?: unknown;
  body?: unknown;
  /** 自带章节（模式位）：非空切换只挑金句短路径，产物形态不同，签名须区分。 */
  chapters?: unknown;
  /** 简介/评论现成章节目录（OutlineChapter[]）：目录出现/消失改变分章来源，签名须区分。 */
  chapterOutline?: unknown;
}

/**
 * 字幕签名：按概览票决议定义的确定性轻量签名——构成 = 轨道来源 source key +
 * lang + 有效条数 + 首末时间戳 + 总字符数（FNV-1a 32 位 → base36）。重抓字幕 /
 * 换轨 / 切分P 后条数、时间戳或文本量变化即签名变化，概览缓存自然 miss，不做
 * 主动失效（07 票决议）。模式位（有无自带章节）一并纳入：章节出现/消失会切换
 * 短路径，产物形态不同。算法必须逐位稳定——历史概览缓存键依赖它。
 */
export function buildSubtitleSignature({ lang, subtitleId, subtitleUrl, body, chapters, chapterOutline }: SubtitleSignatureInput = {}): string {
  const sourceKey = buildSubtitleSourceKey(subtitleId, subtitleUrl, lang);
  let count = 0;
  let totalChars = 0;
  let firstFrom = 0;
  let lastTo = 0;
  for (const item of normalizeSubtitleItems(body)) {
    const content = String(item?.content ?? "").trim();
    if (!content) continue;
    if (count === 0) {
      firstFrom = Math.max(0, Math.floor(Number(item?.from) || 0));
    }
    lastTo = Math.max(0, Math.floor(Number(item?.to) || Number(item?.from) || 0));
    totalChars += content.length;
    count += 1;
  }
  const basis = [
    "v1",
    sourceKey,
    String(lang ?? ""),
    String(count),
    String(firstFrom),
    String(lastTo),
    String(totalChars),
    // 模式位：自带章节非空（短路径）与空（AI 分章）产物不同构，签名必须区分
    String(Array.isArray(chapters) && chapters.length > 0),
    // 模式位：现成目录的 FNV 指纹（出现/消失/换目录 → 缓存 miss 重生成）
    String(fnv1a32(chapterOutlineText(chapterOutline)))
  ].join("|");
  return `sig${fnv1a32(basis).toString(36)}`;
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
