// 「段缓存」模块：分段小结与原始字幕段按 (bvid, cid, 字幕轨 source key, 段序号) 落盘，
// 二次总结/追问按需命中复用，中止/失败后已落盘的段小结下次复用、不重复付费。
// 键位风格对齐 extension/subtitle/cache.js；存储值同为 { <payload>, timestamp }。
// 容错语义：读取失败静默返回 null；写入经 core/cache-lru.js 的统一 LRU 淘汰
// （每族仅保留最近 3 个视频），淘汰后重试仍失败时 logError 并返回 { ok:false }
// 供调用方按各自通道上浮一次；全程不抛异常。

import { logError } from "../shared/logging.js";
import { buildSubtitleSourceKey } from "../subtitle/cache.js";
import { parseBvidFromCacheKey, readLruIndex, writeWithEviction } from "../core/cache-lru.js";
import type { EvictionFailure, EvictionResult } from "../core/cache-lru.js";

// 分段小结缓存键前缀。
const SEGMENT_SUMMARY_PREFIX = "boc_lvs_summary_";
// 原始字幕段缓存键前缀。
const RAW_SEGMENT_PREFIX = "boc_lvs_raw_";

interface SegmentKeyOptions {
  bvid: unknown;
  cid: unknown;
  subtitleId?: unknown;
  subtitleUrl?: unknown;
  lang?: unknown;
  segmentIndex: number | string | unknown;
  budgetScale?: number | string | unknown;
}

// 段序号之外的预算代后缀：同一 (bvid, cid, 字幕轨) 在不同预算档下的分段边界不同，
// 段序号相同不代表内容相同——不带代标记的 key 会命中错位小结（内容串段）。
// budgetScale=1（常态档）不带后缀，key 形状与历史逐字节一致，已有缓存零迁移。
function budgetScaleSuffix(budgetScale: unknown): string {
  const scale = Number(budgetScale);
  return Number.isFinite(scale) && scale !== 1 ? `_b${Math.round(scale * 100)}` : "";
}

/**
 * 分段小结缓存键：bvid + cid + 字幕轨 source key + 段序号 [+ 预算代]。
 * source key 随字幕轨（subtitleId / subtitleUrl / lang）区分，切换字幕轨不串。
 */
export function getSegmentSummaryKey({ bvid, cid, subtitleId = "", subtitleUrl = "", lang = "", segmentIndex, budgetScale = 1 }: SegmentKeyOptions): string {
  const sourceKey = buildSubtitleSourceKey(subtitleId, subtitleUrl, lang);
  return `${SEGMENT_SUMMARY_PREFIX}${bvid}_${cid}_${sourceKey}_${segmentIndex}${budgetScaleSuffix(budgetScale)}`;
}

/**
 * 原始字幕段缓存键：同样含 bvid + cid + 字幕轨 + 段序号 [+ 预算代]。
 */
export function getRawSegmentKey({ bvid, cid, subtitleId = "", subtitleUrl = "", lang = "", segmentIndex, budgetScale = 1 }: SegmentKeyOptions): string {
  const sourceKey = buildSubtitleSourceKey(subtitleId, subtitleUrl, lang);
  return `${RAW_SEGMENT_PREFIX}${bvid}_${cid}_${sourceKey}_${segmentIndex}${budgetScaleSuffix(budgetScale)}`;
}

interface SegmentCacheKeyFieldsResult {
  bvid: unknown;
  cid: unknown;
  subtitleId: unknown;
  subtitleUrl: unknown;
  lang: unknown;
}

// AI 上下文对象 → 段缓存键位字段的唯一映射（bvid/cid + 字幕轨 source key 三元组，
// 上下文字段名 selectedSubtitleId/selectedSubtitleUrl/subtitleLang 映射为键位入参
// subtitleId/subtitleUrl/lang）。落盘（map-reduce）与复用（followup-router）共用，
// 键位不再各自手拼，预热缓存永不因键位漂移而失效。
export function segmentCacheKeyFields(context: Record<string, unknown> | undefined | null): SegmentCacheKeyFieldsResult {
  if (!context) {
    return {
      bvid: undefined,
      cid: undefined,
      subtitleId: undefined,
      subtitleUrl: undefined,
      lang: undefined
    };
  }
  return {
    bvid: context.bvid,
    cid: context.cid,
    subtitleId: context.selectedSubtitleId,
    subtitleUrl: context.selectedSubtitleUrl,
    lang: context.subtitleLang
  };
}

/**
 * 从 AI 上下文 + 段序号拼分段小结缓存键（与 getSegmentSummaryKey 手拼逐字节一致）。
 * budgetScale：预算档（默认 1 = 常态档，key 不带代后缀）；溢出放宽预算重跑（0.5）等
 * 非常态档带代后缀，与常态档的段序号空间隔离，防止段边界漂移后命中错位小结。
 */
export function buildSegmentSummaryCacheKey(context: Record<string, unknown> | undefined, segmentIndex: number | string | unknown, budgetScale: number | string | unknown = 1): string {
  return getSegmentSummaryKey({ ...segmentCacheKeyFields(context), segmentIndex, budgetScale });
}

/**
 * 从 AI 上下文 + 段序号拼原始字幕段缓存键（与 getRawSegmentKey 手拼逐字节一致）。
 * budgetScale 语义同 buildSegmentSummaryCacheKey；原始段只按常态档落盘
 * （供 followup 检索），非常态档不写原始段。
 */
export function buildRawSegmentCacheKey(context: Record<string, unknown> | undefined, segmentIndex: number | string | unknown, budgetScale: number | string | unknown = 1): string {
  return getRawSegmentKey({ ...segmentCacheKeyFields(context), segmentIndex, budgetScale });
}

/**
 * 读取已落盘的分段小结：命中返回 item.summary（string），未命中/读失败返回 null。
 */
export async function loadSegmentSummary(key: string): Promise<string | null> {
  try {
    const result = await chrome.storage.local.get(key);
    return ((result[key] as { summary?: unknown } | undefined)?.summary as string | undefined) ?? null;
  } catch {
    return null;
  }
}

type SaveResult = EvictionResult | EvictionFailure;

/**
 * 保存分段小结：落盘 { summary, timestamp }。写入走统一 LRU 淘汰
 * （写失败先淘汰旧视频再重试一次）；最终失败 logError、不抛异常，
 * 返回 { ok:false, error } 供调用方上浮，成功返回 { ok:true }。
 */
export async function saveSegmentSummary(key: string, summary: string): Promise<SaveResult> {
  const result = await writeWithEviction({
    family: SEGMENT_SUMMARY_PREFIX,
    bvid: parseBvidFromCacheKey(key, SEGMENT_SUMMARY_PREFIX),
    keys: [key], // 本次写入的缓存键，记录进 LRU 索引供淘汰时免全量扫描
    write: () =>
      chrome.storage.local.set({
        [key]: {
          summary,
          timestamp: Date.now()
        }
      })
  });
  if (!result.ok) {
    logError("[BOC] failed to save segment summary cache after eviction", {
      key,
      error: result.error?.message || result.error
    });
  }
  return result;
}

/**
 * 读取已落盘的原始字幕段：命中返回 item.segments（数组），未命中/读失败返回 null。
 */
export async function loadRawSegments(key: string): Promise<unknown[] | null> {
  try {
    const result = await chrome.storage.local.get(key);
    return ((result[key] as { segments?: unknown } | undefined)?.segments as unknown[] | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * 保存原始字幕段：落盘 { segments, timestamp }。容错语义同 saveSegmentSummary
 * （LRU 淘汰 + 最终失败 logError 并返回 { ok:false }）。
 */
export async function saveRawSegments(key: string, segments: unknown[]): Promise<SaveResult> {
  const result = await writeWithEviction({
    family: RAW_SEGMENT_PREFIX,
    bvid: parseBvidFromCacheKey(key, RAW_SEGMENT_PREFIX),
    keys: [key], // 本次写入的缓存键，记录进 LRU 索引供淘汰时免全量扫描
    write: () =>
      chrome.storage.local.set({
        [key]: {
          segments,
          timestamp: Date.now()
        }
      })
  });
  if (!result.ok) {
    logError("[BOC] failed to save raw segments cache after eviction", {
      key,
      error: result.error?.message || result.error
    });
  }
  return result;
}

// 从原始段缓存键尾段解析段序号（键形如 `${前缀}${bvid}_${cid}_${sourceKey}_${index}`）。
function segmentIndexFromKey(key: string, keyPrefix: string): number {
  const n = Number(String(key).slice(keyPrefix.length));
  return Number.isFinite(n) ? n : 0;
}

interface StoredRawSegment {
  index: number;
  from: number;
  to: number;
  items: unknown[];
}

interface LoadStoredRawSegmentsInput {
  bvid?: string;
  cid?: string;
  subtitleId?: string;
  subtitleUrl?: string;
  lang?: string;
}

/**
 * 跨会话回退读取：按 (bvid, cid, 字幕轨 source key) 枚举已落盘的原始字幕段键，
 * 按段序返回与 plan.segments 同构的数组（{ index, from, to, items }）。
 * 枚举走 LRU 索引定点批量读取（单次往返）；索引缺失 / 该 bvid 无条目 / 条目无
 * keys 时回退 get(null) 前缀扫描（镜像 pruneToRecentVideos 的兜底模式）。
 * from/to 由 items 首末项推导（对齐 budgeter.splitByBudget 的段边界语义）。
 * 缺 bvid/cid / 无命中 / 读失败 → []（回退只补空，绝不抛错）。
 */
export async function loadStoredRawSegments({ bvid, cid, subtitleId = "", subtitleUrl = "", lang = "" }: LoadStoredRawSegmentsInput = {}): Promise<StoredRawSegment[]> {
  try {
    if (!bvid || !cid) {
      return [];
    }
    const sourceKey = buildSubtitleSourceKey(subtitleId, subtitleUrl, lang);
    const keyPrefix = `${RAW_SEGMENT_PREFIX}${bvid}_${cid}_${sourceKey}_`;
    // 索引驱动：取该族该 bvid 条目的 keys 定点批量读取（代替 get(null) 全库扫描
    // 与逐键串行 await）；条目无 keys（旧格式/缺失）时回退前缀扫描兜底。
    const index = await readLruIndex();
    const familyEntry = index[RAW_SEGMENT_PREFIX] && typeof index[RAW_SEGMENT_PREFIX] === "object" ? index[RAW_SEGMENT_PREFIX] : {};
    const bvidEntry = (familyEntry as Record<string, unknown>)[bvid];
    const all = Array.isArray((bvidEntry as { keys?: unknown })?.keys) && ((bvidEntry as { keys: unknown[] }).keys.length > 0)
      ? await chrome.storage.local.get(
          (bvidEntry as { keys: unknown[] }).keys.filter((key): key is string => typeof key === "string" && key.startsWith(keyPrefix))
        )
      : await chrome.storage.local.get(null);
    const keys = Object.keys(all || {})
      .filter((key): key is string => typeof key === "string" && key.startsWith(keyPrefix))
      .sort((a, b) => segmentIndexFromKey(a, keyPrefix) - segmentIndexFromKey(b, keyPrefix));

    const out: StoredRawSegment[] = [];
    for (const key of keys) {
      const items = (all[key] as { segments?: unknown } | undefined)?.segments;
      if (Array.isArray(items) && items.length > 0) {
        const first = (items[0] as { from?: unknown }) || {};
        const last = (items[items.length - 1] as { to?: unknown; from?: unknown }) || {};
        out.push({
          index: segmentIndexFromKey(key, keyPrefix),
          from: Number(first.from) || 0,
          to: Number(last.to) || Number(first.from) || 0,
          items
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}
