// 「缓存 LRU 淘汰」模块：为 chrome.storage.local 上的两族缓存键提供统一的
// 「最近写入视频」索引与淘汰机制（一次机制覆盖两族）：
//   - boc_lvs_raw_* / boc_lvs_summary_*：ai/segment-cache.js 的原始字幕段 / 分段小结；
//   - boc_subtitle_cache_*：subtitle/cache.js 的整篇字幕正文（值 { body, timestamp }）。
// 设计决策（与产品确认）：
//   - 每族只保留最近写入的 keep（默认 3）个视频（按 bvid），LRU 以 lastWriteTimestamp
//     排序，无字节上限；
//   - 索引键 boc_cache_lru_index：{ [family]: { [bvid]: lastWriteTimestamp } }，
//     每次记录写入时更新；
//   - 淘汰本身静默运行、不提示；仅当「淘汰后重试仍失败」时由调用方把 distinct
//     失败（CacheWriteError）上浮到各自的 UI 通道（content 状态栏 / offscreen port notice）。
// chrome.* 访问与既有测试模式一致：直接使用全局 chrome.storage.local，
// 测试以 vi.stubGlobal("chrome", …) 注入内存实现（需支持 get(null) 全量枚举）。

// LRU 索引键。
export const LRU_INDEX_KEY = "boc_cache_lru_index";
// 参与统一淘汰的缓存族前缀（镜像 ai/segment-cache.js 与 subtitle/cache.js 的键前缀）。
export const CACHE_FAMILIES = ["boc_lvs_raw_", "boc_lvs_summary_", "boc_subtitle_cache_"];
// 每族保留的最近视频数。
export const LRU_KEEP_VIDEOS = 3;

// 「淘汰后重试仍失败」的 distinct 错误：调用方据此判断是否向 UI 上浮（且仅上浮一次）。
export class CacheWriteError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "CacheWriteError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// 从缓存键解析 bvid：键形如 `${family}${bvid}_${cid}_${sourceKey}[_${index}]`，
// bvid（BV 号）不含下划线，取 family 前缀后的第一段即可。
export function parseBvidFromCacheKey(key, familyPrefix = "") {
  let rest = String(key == null ? "" : key);
  if (familyPrefix && rest.startsWith(familyPrefix)) {
    rest = rest.slice(familyPrefix.length);
  }
  const cut = rest.indexOf("_");
  return cut === -1 ? rest : rest.slice(0, cut);
}

function requireStorageLocal() {
  if (!globalThis.chrome?.storage?.local) {
    throw new Error("chrome.storage.local 不可用");
  }
  return globalThis.chrome.storage.local;
}

// 读 LRU 索引：缺失 / 损坏 / 读失败 → {}（索引只是淘汰启发式元数据，允许丢）。
export async function readLruIndex() {
  try {
    const result = await requireStorageLocal().get(LRU_INDEX_KEY);
    const index = result?.[LRU_INDEX_KEY];
    return index && typeof index === "object" ? index : {};
  } catch {
    return {};
  }
}

// 记录一次写入：family → bvid → lastWriteTimestamp。失败上抛，由 writeWithEviction 统一处理。
export async function recordCacheWrite(family, bvid, timestamp = Date.now()) {
  const storage = requireStorageLocal();
  const index = await readLruIndex();
  const familyEntry = { ...(index[family] || {}), [bvid]: timestamp };
  await storage.set({ [LRU_INDEX_KEY]: { ...index, [family]: familyEntry } });
}

// 族内 bvid 按最近写入排序（新→旧）：索引时间戳优先；
// 键里存在但索引缺失的 bvid（历史遗留）视为最旧（时间戳 0），优先淘汰。
function rankBvidsInFamily(family, indexEntry, familyKeys) {
  const timestamps = new Map();
  const entry = indexEntry && typeof indexEntry === "object" ? indexEntry : {};
  for (const [bvid, ts] of Object.entries(entry)) {
    timestamps.set(bvid, Number(ts) || 0);
  }
  for (const key of familyKeys) {
    const bvid = parseBvidFromCacheKey(key, family);
    if (bvid && !timestamps.has(bvid)) {
      timestamps.set(bvid, 0);
    }
  }
  return [...timestamps.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * 淘汰到每族最近 keep 个视频：按各族前缀列出键，bvid 不在最近 keep 名内的整键删除。
 * 返回 { [family]: string[] }（实际删除的键）；淘汰本身静默：任何失败吞掉并返回 {}。
 */
export async function pruneToRecentVideos(families = CACHE_FAMILIES, keep = LRU_KEEP_VIDEOS) {
  try {
    const storage = requireStorageLocal();
    const safeKeep = Math.max(1, Math.floor(Number(keep)) || LRU_KEEP_VIDEOS);
    const familyList = (Array.isArray(families) ? families : []).filter((f) => typeof f === "string" && f);
    if (familyList.length === 0) {
      return {};
    }

    const all = await storage.get(null);
    const index = await readLruIndex();
    const keysToRemove = [];
    const removed = {};
    for (const family of familyList) {
      const familyKeys = Object.keys(all || {}).filter((key) => key.startsWith(family));
      const ranked = rankBvidsInFamily(family, index[family], familyKeys);
      const keepSet = new Set(ranked.slice(0, safeKeep).map(([bvid]) => bvid));
      const familyRemoved = familyKeys.filter((key) => {
        const bvid = parseBvidFromCacheKey(key, family);
        // 解析不出 bvid 的畸形键按垃圾一并回收。
        return !bvid || !keepSet.has(bvid);
      });
      if (familyRemoved.length > 0) {
        keysToRemove.push(...familyRemoved);
        removed[family] = familyRemoved;
      }
    }

    if (keysToRemove.length > 0) {
      await storage.remove(keysToRemove);
      // 索引同步收缩：被淘汰 bvid 的条目一并移除（未参与淘汰的族原样保留）。
      const nextIndex = { ...index };
      for (const family of Object.keys(removed)) {
        const familyEntry = { ...(nextIndex[family] || {}) };
        for (const key of removed[family]) {
          delete familyEntry[parseBvidFromCacheKey(key, family)];
        }
        nextIndex[family] = familyEntry;
      }
      try {
        await storage.set({ [LRU_INDEX_KEY]: nextIndex });
      } catch {
        // 索引收缩失败不影响已删除的数据键（下次 prune 会再收）。
      }
    }
    return removed;
  } catch {
    return {};
  }
}

/**
 * 带 LRU 淘汰的写入：记录索引 → 写入 → 每次成功写入后维持「每族仅保留最近 keep
 * 个视频」的不变量；写入失败时先淘汰（静默）再重试一次，仍失败返回
 * { ok:false, error: CacheWriteError }（distinct 失败，由调用方决定是否上浮 UI）。
 * 从不抛出；返回 { ok:true } 或 { ok:false, error }。
 */
export async function writeWithEviction({
  family,
  bvid,
  write,
  keep = LRU_KEEP_VIDEOS,
  pruneFamilies = CACHE_FAMILIES
} = {}) {
  if (typeof write !== "function") {
    return { ok: false, error: new CacheWriteError("writeWithEviction：write 必须是函数") };
  }

  const attempt = async () => {
    await recordCacheWrite(family, bvid);
    await write();
  };

  try {
    await attempt();
  } catch (firstError) {
    // 写入失败：先淘汰（失败静默）再重试一次；当前 bvid 刚记录过时间戳，
    // 在族内排名最新，不会被本次淘汰误删。
    await pruneToRecentVideos(pruneFamilies, keep);
    try {
      await attempt();
    } catch (retryError) {
      return {
        ok: false,
        error: new CacheWriteError(
          `缓存写入失败（已淘汰旧视频后重试仍失败）：${retryError?.message || retryError}`,
          retryError
        )
      };
    }
  }

  // 维持 LRU 不变量：每次成功写入后收缩到每族最近 keep 个视频。
  await pruneToRecentVideos(pruneFamilies, keep);
  return { ok: true };
}
