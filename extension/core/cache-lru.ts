// 「缓存 LRU 淘汰」模块：为 chrome.storage.local 上的两族缓存键提供统一的
// 「最近写入视频」索引与淘汰机制（一次机制覆盖两族）：
//   - boc_lvs_raw_* / boc_lvs_summary_*：ai/segment-cache.js 的原始字幕段 / 分段小结；
//   - boc_subtitle_cache_*：subtitle/cache.js 的整篇字幕正文（值 { body, timestamp }）。
// 设计决策（与产品确认）：
//   - 每族只保留最近写入的 keep（默认 3）个视频（按 bvid），LRU 以 lastWriteTimestamp
//     排序，无字节上限；
//   - 索引键 boc_cache_lru_index：{ [family]: { [bvid]: { ts, keys: string[] } } }，
//     ts 为该视频最近一次写入时间戳，keys 为该 bvid 在该族下的全部缓存键
//     （每次记录写入时合并去重更新）。旧格式条目（数值 ts，无 keys）在读端归一化
//     兼容，无需迁移；
//   - 淘汰候选键优先取索引键清单（不做 storage 存在性检查）；仅当索引整体缺失
//     （LRU_INDEX_KEY 不存在/损坏 → 全族回退 get(null) 前缀扫描自愈）、或某族
//     有条目但存在无 keys 的条目（旧格式/混合状态，键面不全 → 该族回退）时才
//     扫描兜底；索引健康时「无条目的族」（注册但从未写入，如新注册族）直接跳过。
//     索引指向已删键的幽灵条目随淘汰被垃圾回收出索引
//     （storage.remove 对不存在键是 no-op，索引收缩步骤顺带清掉条目）；
//   - 淘汰本身静默运行、不提示；仅当「淘汰后重试仍失败」时由调用方把 distinct
//     失败（CacheWriteError）上浮到各自的 UI 通道（content 状态栏 / offscreen port notice）。
// chrome.* 访问与既有测试模式一致：直接使用全局 chrome.storage.local，
// 测试以 vi.stubGlobal("chrome", …) 注入内存实现（需支持 get(null) 全量枚举）。

// LRU 索引键。
export const LRU_INDEX_KEY = "boc_cache_lru_index";
// 参与统一淘汰的缓存族前缀（全仓唯一注册处，arch-slim-2/08 起 analysis 两族
// 收进注册、不再由 ai/analysis.ts 自行扩展名单）：
//   - boc_lvs_raw_* / boc_lvs_summary_*：ai/segment-cache.ts 的原始字幕段 / 分段小结；
//   - boc_subtitle_cache_*：subtitle/cache.ts 的整篇字幕正文（值 { body, timestamp }）；
//   - boc_lvs_analysis_* / boc_lvs_analysis_final_*：ai/analysis.ts 的概览分段 / 整份产物。
// 前缀撞车语义：boc_lvs_analysis_final_ 以 boc_lvs_analysis_ 为前缀，段族的
// 前缀扫描（get(null) 兜底 / 前缀过滤）会把 final 键一并纳入候选——两族键的
// bvid 段相同，淘汰按 bvid 粒度 keep/evict，同视频的段键与整份键共存亡（既有
// 行为零变化）；final 族的前缀过滤则精确匹配自身。
export const CACHE_FAMILIES = [
  "boc_lvs_raw_",
  "boc_lvs_summary_",
  "boc_subtitle_cache_",
  "boc_lvs_analysis_",
  "boc_lvs_analysis_final_"
];
// 每族保留的最近视频数。
export const LRU_KEEP_VIDEOS = 3;

interface LruIndexEntry {
  ts: number;
  keys: string[];
}

type LruIndex = Record<string, Record<string, LruIndexEntry | number | unknown>>;

export interface EvictionResult {
  ok: true;
}

export interface EvictionFailure {
  ok: false;
  error: CacheWriteError;
}

// 「淘汰后重试仍失败」的 distinct 错误：调用方据此判断是否向 UI 上浮（且仅上浮一次）。
export class CacheWriteError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CacheWriteError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// 从缓存键解析 bvid：键形如 `${family}${bvid}_${cid}_${sourceKey}[_${index}]`，
// bvid（BV 号）不含下划线，取 family 前缀后的第一段即可。
export function parseBvidFromCacheKey(key: unknown, familyPrefix = ""): string {
  let rest = String(key == null ? "" : key);
  if (familyPrefix && rest.startsWith(familyPrefix)) {
    rest = rest.slice(familyPrefix.length);
  }
  const cut = rest.indexOf("_");
  return cut === -1 ? rest : rest.slice(0, cut);
}

function requireStorageLocal(): chrome.storage.StorageArea {
  if (!globalThis.chrome?.storage?.local) {
    throw new Error("chrome.storage.local 不可用");
  }
  return globalThis.chrome.storage.local;
}

// 读 LRU 索引：缺失 / 损坏 / 读失败 → {}（索引只是淘汰启发式元数据，允许丢）。
export async function readLruIndex(): Promise<LruIndex> {
  try {
    const result = await requireStorageLocal().get(LRU_INDEX_KEY);
    const index = result?.[LRU_INDEX_KEY];
    return index && typeof index === "object" ? (index as LruIndex) : {};
  } catch {
    return {};
  }
}

// 索引条目归一化：旧格式（数值 ts）→ { ts, keys: [] }；畸形值 → null（调用方忽略）。
function normalizeIndexEntry(value: unknown): LruIndexEntry | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { ts: value, keys: [] };
  }
  if (value && typeof value === "object" && Number.isFinite(Number((value as { ts?: unknown }).ts))) {
    const rawKeys = (value as { keys?: unknown }).keys;
    return {
      ts: Number((value as { ts?: unknown }).ts),
      keys: Array.isArray(rawKeys)
        ? rawKeys.filter((k: unknown): k is string => typeof k === "string" && Boolean(k))
        : []
    };
  }
  return null;
}

// 记录一次写入：family → bvid → { ts, keys }。cacheKeys 是本次写入的缓存键清单，
// 合并（去重）进该 bvid 条目的 keys。失败上抛，由 writeWithEviction 统一处理。
export async function recordCacheWrite(
  family: string,
  bvid: string,
  timestamp = Date.now(),
  cacheKeys: string[] = []
): Promise<void> {
  const storage = requireStorageLocal();
  const index = await readLruIndex();
  const previous = normalizeIndexEntry((index[family] || {})[bvid]);
  const mergedKeys = [
    ...new Set([...(previous?.keys || []), ...(Array.isArray(cacheKeys) ? cacheKeys : [])])
  ];
  const familyEntry = { ...(index[family] || {}), [bvid]: { ts: timestamp, keys: mergedKeys } };
  await storage.set({ [LRU_INDEX_KEY]: { ...index, [family]: familyEntry } });
}

// 族内 bvid 按最近写入排序（新→旧）：索引时间戳优先（兼容数值旧格式与 {ts,keys}）；
// 键里存在但索引缺失的 bvid（历史遗留）视为最旧（时间戳 0），优先淘汰。
function rankBvidsInFamily(
  family: string,
  indexEntry: Record<string, LruIndexEntry | number | unknown> | undefined,
  familyKeys: string[]
): Array<[string, number]> {
  const timestamps = new Map<string, number>();
  const entry = indexEntry && typeof indexEntry === "object" ? indexEntry : {};
  for (const [bvid, value] of Object.entries(entry)) {
    timestamps.set(bvid, Number(typeof value === "number" ? value : (value as { ts?: unknown })?.ts) || 0);
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
 * 淘汰到每族最近 keep 个视频：候选键优先取索引里记录的各族键清单（无存在性检查），
 * 索引整体缺失或某族有条目但缺 keys 时回退前缀扫描（见上）；bvid 不在最近 keep
 * 名内的整键删除——索引有、
 * storage 无的幽灵键也在其列（storage.remove 对其为 no-op，其索引条目随收缩清出）。
 * 返回 { [family]: string[] }（清理出的键，可能含已不存在的键）；淘汰本身静默：
 * 任何失败吞掉并返回 {}。
 */
export async function pruneToRecentVideos(
  families: string[] = CACHE_FAMILIES,
  keep: number = LRU_KEEP_VIDEOS
): Promise<Record<string, string[]>> {
  try {
    const storage = requireStorageLocal();
    const safeKeep = Math.max(1, Math.floor(Number(keep)) || LRU_KEEP_VIDEOS);
    const familyList = (Array.isArray(families) ? families : []).filter(
      (f): f is string => typeof f === "string" && Boolean(f)
    );
    if (familyList.length === 0) {
      return {};
    }

    // 索引驱动路径：各族先按索引取候选键。回退 get(null) 前缀扫描仅两种情形：
    // 索引整体缺失（自愈）或某族有条目但缺 keys（旧格式/混合状态）。索引健康时
    // 「无条目的族」（注册但从未写入，如 arch-slim-2/08 收进注册的 analysis 两族）
    // 视为空族跳过——否则每个未使用注册族都会让所有 prune 触发全量扫描。
    const index = await readLruIndex();
    const indexEmpty = Object.keys(index).length === 0;
    const indexDrivenKeys = new Map<string, string[]>(); // family → 索引 keys 并集
    const fallbackFamilies: string[] = [];
    for (const family of familyList) {
      const entry = index[family] && typeof index[family] === "object" ? index[family] : {};
      const bvids = Object.keys(entry);
      const complete =
        bvids.length > 0 &&
        bvids.every((bvid) => (normalizeIndexEntry(entry[bvid])?.keys || []).length > 0);
      if (complete) {
        const keys = new Set<string>();
        for (const bvid of bvids) {
          for (const key of normalizeIndexEntry(entry[bvid])!.keys) {
            keys.add(key);
          }
        }
        indexDrivenKeys.set(family, [...keys]);
      } else if (indexEmpty || bvids.length > 0) {
        fallbackFamilies.push(family);
      }
    }

    const all = fallbackFamilies.length > 0 ? await storage.get(null) : null;
    const keysToRemove: string[] = [];
    const removed: Record<string, string[]> = {};
    for (const family of familyList) {
      // 候选键：索引驱动族直接用索引 keys 并集（不做存在性检查，「索引有、storage
      // 无」的幽灵键照常流入下方淘汰清单，由 storage.remove no-op + 索引收缩自愈）；
      // 回退族按前缀扫描。畸形键（解析不出 bvid）按垃圾回收。
      const familyKeys = indexDrivenKeys.has(family)
        ? indexDrivenKeys.get(family)!
        : Object.keys(all || {}).filter((key) => key.startsWith(family));
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
      const nextIndex: LruIndex = { ...index };
      for (const family of Object.keys(removed)) {
        const familyEntry: Record<string, LruIndexEntry | number | unknown> = { ...(nextIndex[family] || {}) };
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

// prune 短路检查：各族索引条目的 bvid 数（旧格式条目 normalizeIndexEntry 后照计，
// 畸形条目不计）都 ≤ keep → true。各族的淘汰只会在自己的写入路径上越界，别的族
// 不可能因本次写入超限，此时完整 prune 必无事可做，可跳过。
function familiesWithinKeep(index: LruIndex, families: string[], keep: number): boolean {
  const safeKeep = Math.max(1, Math.floor(Number(keep)) || LRU_KEEP_VIDEOS);
  const familyList = (Array.isArray(families) ? families : []).filter(
    (f): f is string => typeof f === "string" && Boolean(f)
  );
  return familyList.every((family) => {
    const entry = index[family] && typeof index[family] === "object" ? index[family] : {};
    let count = 0;
    for (const value of Object.values(entry)) {
      if (normalizeIndexEntry(value)) {
        count += 1;
      }
    }
    return count <= safeKeep;
  });
}

interface WriteWithEvictionOptions {
  family?: string;
  bvid?: string;
  write?: () => Promise<void>;
  keys?: string[];
  keep?: number;
  pruneFamilies?: string[];
}

/**
 * 带 LRU 淘汰的写入：记录索引 → 写入 → 每次成功写入后维持「每族仅保留最近 keep
 * 个视频」的不变量（先读索引短路：各族条目 bvid 数都 ≤ keep 时跳过完整 prune）；
 * 写入失败时先淘汰（静默）再重试一次，仍失败返回
 * { ok:false, error: CacheWriteError }（distinct 失败，由调用方决定是否上浮 UI）。
 * 从不抛出；返回 { ok:true } 或 { ok:false, error }。
 */
export async function writeWithEviction({
  family = "",
  bvid = "",
  write,
  keys = [],
  keep = LRU_KEEP_VIDEOS,
  pruneFamilies = CACHE_FAMILIES
}: WriteWithEvictionOptions = {}): Promise<EvictionResult | EvictionFailure> {
  if (typeof write !== "function") {
    return { ok: false, error: new CacheWriteError("writeWithEviction：write 必须是函数") };
  }

  const attempt = async () => {
    await recordCacheWrite(family, bvid, Date.now(), keys);
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
          `缓存写入失败（已淘汰旧视频后重试仍失败）：${(retryError as Error | undefined)?.message || retryError}`,
          retryError
        )
      };
    }
  }

  // 维持 LRU 不变量：每次成功写入后收缩到每族最近 keep 个视频。先读一次索引
  // （单个小键、便宜）短路：各族条目 bvid 数都 ≤ keep 时本次写入不可能造成越界，
  // 跳过完整 prune。
  if (!familiesWithinKeep(await readLruIndex(), pruneFamilies, keep)) {
    await pruneToRecentVideos(pruneFamilies, keep);
  }
  return { ok: true };
}

// ============================================================
// 缓存族工厂（arch-slim-2/08）：chrome.storage.local 上「族键拼装 + 静默读 +
// { payload, timestamp } 落盘 + writeWithEviction 统一 LRU 淘汰写」的口径单源。
// 消费实例：ai/segment-cache.ts（boc_lvs_summary_ / boc_lvs_raw_ 两族）与
// ai/analysis.ts（boc_lvs_analysis_final_ / boc_lvs_analysis_ 两族）。
// 本叶保持零 import：source key 推导（buildSubtitleSourceKey，属 subtitle 域）
// 与失败日志（logError，拖 core/state）都经 options 注入，不反向依赖。
// ============================================================

export type CacheSaveResult = EvictionResult | EvictionFailure;

export interface CacheFamilyOptions<TValue> {
  /** 族键前缀（必须已进 CACHE_FAMILIES 注册，参与统一 LRU 淘汰）。 */
  prefix: string;
  /** 落盘 payload 字段名；值形状 { [payloadField]: value, timestamp }。 */
  payloadField: string;
  /** 字幕轨 source key 推导（注入 subtitle/cache.ts 的 buildSubtitleSourceKey）。 */
  toSourceKey: (subtitleId: unknown, subtitleUrl: unknown, lang: unknown) => string;
  /** 读端形状校验（损坏返回 null）；缺省只做 nullish 归一（值原样透传）。 */
  validate?: (value: unknown) => boolean;
  /** 淘汰后重试仍失败时的日志钩子（注入 shared/logging 的 logError 与各族固定文案）。 */
  logFailure?: (info: { key: string; error: unknown }) => void;
}

export interface CacheFamilyKeyFields {
  bvid?: unknown;
  cid?: unknown;
  subtitleId?: unknown;
  subtitleUrl?: unknown;
  lang?: unknown;
}

export interface CacheFamily<TValue> {
  readonly prefix: string;
  /**
   * 族键拼装：prefix + bvid + cid + sourceKey + tail。键形与各族历史键逐字节
   * 一致（缓存零迁移）；段序号/预算代/签名等 tail 段的拼装约定由调用方传入。
   */
  key(fields: CacheFamilyKeyFields, tail: unknown): string;
  /** 读：未命中 / 读失败 / 形状损坏 → null（静默，淘汰索引元数据同理可丢）。 */
  load(key: string): Promise<TValue | null>;
  /** 写：经 writeWithEviction（写失败先淘汰再重试一次），最终失败走 logFailure、不抛。 */
  save(key: string, value: TValue): Promise<CacheSaveResult>;
}

export function createCacheFamily<TValue>(options: CacheFamilyOptions<TValue>): CacheFamily<TValue> {
  const { prefix, payloadField, toSourceKey, validate, logFailure } = options;
  return {
    prefix,
    key(fields, tail) {
      const sourceKey = toSourceKey(fields.subtitleId, fields.subtitleUrl, fields.lang);
      return `${prefix}${fields.bvid}_${fields.cid}_${sourceKey}_${String(tail)}`;
    },
    async load(key) {
      try {
        const result = await requireStorageLocal().get(key);
        const value = (result[key] as Record<string, unknown> | undefined)?.[payloadField];
        if (value == null) {
          return null;
        }
        if (validate && !validate(value)) {
          return null;
        }
        return value as TValue;
      } catch {
        return null;
      }
    },
    async save(key, value) {
      const result = await writeWithEviction({
        family: prefix,
        bvid: parseBvidFromCacheKey(key, prefix),
        keys: [key], // 本次写入的缓存键，记录进 LRU 索引供淘汰时免全量扫描
        write: () =>
          requireStorageLocal().set({
            [key]: {
              [payloadField]: value,
              timestamp: Date.now()
            }
          })
      });
      if (!result.ok) {
        logFailure?.({ key, error: result.error?.message || result.error });
      }
      return result;
    }
  };
}
