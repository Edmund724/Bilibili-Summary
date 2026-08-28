// 「段缓存」模块：分段小结与原始字幕段按 (bvid, cid, 字幕轨 source key, 段序号) 落盘，
// 二次总结/追问按需命中复用，中止/失败后已落盘的段小结下次复用、不重复付费。
// 键位风格对齐 extension/subtitle/cache.js；存储值同为 { <payload>, timestamp }，
// 容错语义一致：读写失败 logWarn 且不抛异常。

import { logWarn } from "../shared/logging.js";
import { buildSubtitleSourceKey } from "../subtitle/cache.js";

// 分段小结缓存键前缀。
export const SEGMENT_SUMMARY_PREFIX = "boc_lvs_summary_";
// 原始字幕段缓存键前缀。
export const RAW_SEGMENT_PREFIX = "boc_lvs_raw_";

/**
 * 分段小结缓存键：bvid + cid + 字幕轨 source key + 段序号。
 * source key 随字幕轨（subtitleId / subtitleUrl / lang）区分，切换字幕轨不串。
 */
export function getSegmentSummaryKey({ bvid, cid, subtitleId = "", subtitleUrl = "", lang = "", segmentIndex }) {
  const sourceKey = buildSubtitleSourceKey(subtitleId, subtitleUrl, lang);
  return `${SEGMENT_SUMMARY_PREFIX}${bvid}_${cid}_${sourceKey}_${segmentIndex}`;
}

/**
 * 原始字幕段缓存键：同样含 bvid + cid + 字幕轨 + 段序号。
 */
export function getRawSegmentKey({ bvid, cid, subtitleId = "", subtitleUrl = "", lang = "", segmentIndex }) {
  const sourceKey = buildSubtitleSourceKey(subtitleId, subtitleUrl, lang);
  return `${RAW_SEGMENT_PREFIX}${bvid}_${cid}_${sourceKey}_${segmentIndex}`;
}

/**
 * 读取已落盘的分段小结：命中返回 item.summary（string），未命中/读失败返回 null。
 */
export async function loadSegmentSummary(key) {
  try {
    const result = await chrome.storage.local.get(key);
    return result[key]?.summary ?? null;
  } catch {
    return null;
  }
}

/**
 * 保存分段小结：落盘 { summary, timestamp }。写失败 logWarn 且不抛异常。
 */
export async function saveSegmentSummary(key, summary) {
  try {
    await chrome.storage.local.set({
      [key]: {
        summary,
        timestamp: Date.now()
      }
    });
  } catch (error) {
    logWarn("[BOC] failed to save segment summary cache", { key, error });
  }
}

/**
 * 读取已落盘的原始字幕段：命中返回 item.segments（数组），未命中/读失败返回 null。
 */
export async function loadRawSegments(key) {
  try {
    const result = await chrome.storage.local.get(key);
    return result[key]?.segments ?? null;
  } catch {
    return null;
  }
}

/**
 * 保存原始字幕段：落盘 { segments, timestamp }。写失败 logWarn 且不抛异常。
 */
export async function saveRawSegments(key, segments) {
  try {
    await chrome.storage.local.set({
      [key]: {
        segments,
        timestamp: Date.now()
      }
    });
  } catch (error) {
    logWarn("[BOC] failed to save raw segments cache", { key, error });
  }
}
