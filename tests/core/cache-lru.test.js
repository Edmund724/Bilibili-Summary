// core/cache-lru.js 统一 LRU 淘汰测试：
// (a) 索引记录 + pruneToRecentVideos 每族保留最近 3 个视频、删除更旧视频的全部键；
// (b) writeWithEviction 失败后先淘汰再重试一次，重试成功返回 { ok:true }，
//     重试仍失败返回 distinct 的 CacheWriteError（{ ok:false }，不抛异常）；
// (c) 一次机制覆盖两族（boc_lvs_* 与 boc_subtitle_cache_*）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let mod;
let storage;

// 内存 Map 实现的 chrome.storage.local：get 需支持 null（全量枚举，供前缀扫描）。
function createMemoryStorage() {
  const map = new Map();
  const local = {
    get: vi.fn(async (keys) => {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(map.entries());
      }
      const want = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of want) {
        if (map.has(k)) {
          out[k] = map.get(k);
        }
      }
      return out;
    }),
    set: vi.fn(async (items) => {
      for (const [key, value] of Object.entries(items)) {
        map.set(key, value);
      }
    }),
    remove: vi.fn(async (keys) => {
      const want = Array.isArray(keys) ? keys : [keys];
      for (const k of want) {
        map.delete(k);
      }
    })
  };
  return { map, local };
}

async function importModules() {
  vi.resetModules();
  resetModuleState();
  storage = createMemoryStorage();
  vi.stubGlobal("chrome", { storage: { local: storage.local } });
  mod = await import("../../extension/core/cache-lru.js");
}

beforeEach(async () => {
  await importModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("索引记录（family → bvid → { ts, keys }）", () => {
  it("recordCacheWrite 更新索引（合并去重 keys）；readLruIndex 读回；空/读失败返回 {}", async () => {
    expect(await mod.readLruIndex()).toEqual({});

    await mod.recordCacheWrite("boc_lvs_raw_", "BV1a", 100, ["boc_lvs_raw_BV1a_1_a_1"]);
    await mod.recordCacheWrite("boc_lvs_raw_", "BV1b", 200);
    // 同 bvid 再次写入：ts 覆盖、keys 合并去重
    await mod.recordCacheWrite("boc_lvs_raw_", "BV1a", 150, [
      "boc_lvs_raw_BV1a_1_a_1",
      "boc_lvs_raw_BV1a_1_b_2"
    ]);
    await mod.recordCacheWrite("boc_subtitle_cache_", "BV1a", 300);
    expect(await mod.readLruIndex()).toEqual({
      boc_lvs_raw_: {
        BV1a: { ts: 150, keys: ["boc_lvs_raw_BV1a_1_a_1", "boc_lvs_raw_BV1a_1_b_2"] },
        BV1b: { ts: 200, keys: [] }
      },
      boc_subtitle_cache_: { BV1a: { ts: 300, keys: [] } }
    });

    // 读失败静默返回空索引（索引是启发式元数据，允许丢）
    storage.local.get.mockRejectedValueOnce(new Error("boom"));
    await expect(mod.readLruIndex()).resolves.toEqual({});
  });

  it("parseBvidFromCacheKey：取 family 前缀后第一段（BV 号不含下划线）", () => {
    expect(mod.parseBvidFromCacheKey("boc_lvs_raw_BV1xx2_9_id_sub-1_3", "boc_lvs_raw_")).toBe("BV1xx2");
    expect(mod.parseBvidFromCacheKey("boc_subtitle_cache_BV1a_7_url_a.b.com_p_1", "boc_subtitle_cache_")).toBe("BV1a");
    expect(mod.parseBvidFromCacheKey("no_prefix_BV1c_1_x")).toBe("no");
  });
});

describe("pruneToRecentVideos：每族保留最近 3 个视频", () => {
  async function seedFamily(family, bvids) {
    for (const [bvid, ts] of bvids) {
      await mod.recordCacheWrite(family, bvid, ts);
      // 每个视频写两条键（模拟 raw/summary 的多段、字幕缓存的平台+ASR 轨）
      await storage.local.set({
        [`${family}${bvid}_1_a_1`]: { v: `${bvid}-1` },
        [`${family}${bvid}_1_b_2`]: { v: `${bvid}-2` }
      });
    }
  }

  it("删除每族时间戳最旧视频的全部键，保留最近 3 个；索引同步收缩", async () => {
    await seedFamily("boc_lvs_raw_", [
      ["BV1old", 10],
      ["BV1a", 100],
      ["BV1b", 200],
      ["BV1c", 300]
    ]);

    const removed = await mod.pruneToRecentVideos(["boc_lvs_raw_"]);
    expect(removed.boc_lvs_raw_).toEqual(
      expect.arrayContaining(["boc_lvs_raw_BV1old_1_a_1", "boc_lvs_raw_BV1old_1_b_2"])
    );
    expect(storage.map.has("boc_lvs_raw_BV1old_1_a_1")).toBe(false);
    expect(storage.map.has("boc_lvs_raw_BV1old_1_b_2")).toBe(false);
    expect(storage.map.has("boc_lvs_raw_BV1a_1_a_1")).toBe(true);
    expect(storage.map.has("boc_lvs_raw_BV1c_1_b_2")).toBe(true);

    // 索引收缩：BV1old 条目移除，其余保留
    expect(await mod.readLruIndex()).toEqual({
      boc_lvs_raw_: {
        BV1a: { ts: 100, keys: [] },
        BV1b: { ts: 200, keys: [] },
        BV1c: { ts: 300, keys: [] }
      }
    });
  });

  it("多族一次淘汰：raw 族索引内 3 新 + 1 遗留键（无索引按最旧）→ 仅遗留被删；不足 keep 的族不动", async () => {
    await seedFamily("boc_lvs_raw_", [
      ["BV1a", 100],
      ["BV1b", 200],
      ["BV1c", 300]
    ]);
    // raw 族的遗留键（从不写索引 → 时间戳 0 → 最旧）；summary 族仅 1 个视频（不足 keep）
    await storage.local.set({
      boc_lvs_raw_BV1legacy_1_a_1: { v: "legacy" },
      boc_lvs_summary_BV1a_1_a_1: { v: "summary" }
    });

    const removed = await mod.pruneToRecentVideos(mod.CACHE_FAMILIES, 3);
    expect(removed.boc_lvs_raw_).toContain("boc_lvs_raw_BV1legacy_1_a_1");
    expect(storage.map.has("boc_lvs_raw_BV1legacy_1_a_1")).toBe(false);
    expect(storage.map.has("boc_lvs_raw_BV1a_1_a_1")).toBe(true);
    // summary 族不足 keep 个 → 无删除
    expect(removed.boc_lvs_summary_).toBeUndefined();
    expect(storage.map.has("boc_lvs_summary_BV1a_1_a_1")).toBe(true);
  });

  it("不足 keep 个时不动任何键；淘汰失败静默返回 {}", async () => {
    await seedFamily("boc_lvs_raw_", [["BV1a", 1]]);
    const removed = await mod.pruneToRecentVideos(["boc_lvs_raw_"], 3);
    expect(removed).toEqual({});
    expect(storage.map.has("boc_lvs_raw_BV1a_1_a_1")).toBe(true);

    // 枚举失败 → 静默返回 {}
    storage.local.get.mockRejectedValue(new Error("boom"));
    await expect(mod.pruneToRecentVideos(["boc_lvs_raw_"])).resolves.toEqual({});
  });
});

describe("索引驱动淘汰：索引含 keys 时不做 get(null) 全量扫描", () => {
  // 直接以新格式写索引与数据键（绕过 recordCacheWrite 便于精确控制 keys）。
  async function seedNewFormatIndex(family, entries) {
    const familyEntry = {};
    const dataKeys = [];
    for (const [bvid, ts, keys] of entries) {
      familyEntry[bvid] = { ts, keys };
      dataKeys.push(...keys);
    }
    const items = { [mod.LRU_INDEX_KEY]: { ...(await mod.readLruIndex()), [family]: familyEntry } };
    for (const key of dataKeys) {
      items[key] = { v: key };
    }
    await storage.local.set(items);
  }

  it("索引健康时淘汰全程不调 get(null)，结果与扫描路径等价", async () => {
    await seedNewFormatIndex("boc_lvs_raw_", [
      ["BV1old", 10, ["boc_lvs_raw_BV1old_1_a_1", "boc_lvs_raw_BV1old_1_b_2"]],
      ["BV1a", 100, ["boc_lvs_raw_BV1a_1_a_1"]],
      ["BV1b", 200, ["boc_lvs_raw_BV1b_1_a_1"]],
      ["BV1c", 300, ["boc_lvs_raw_BV1c_1_a_1"]]
    ]);

    const removed = await mod.pruneToRecentVideos(["boc_lvs_raw_"]);
    // 全程未触发全量枚举（索引键的定点 get 不算）
    const nullScans = storage.local.get.mock.calls.filter(([keys]) => keys === null);
    expect(nullScans).toHaveLength(0);
    expect(removed.boc_lvs_raw_).toEqual(
      expect.arrayContaining(["boc_lvs_raw_BV1old_1_a_1", "boc_lvs_raw_BV1old_1_b_2"])
    );
    expect(storage.map.has("boc_lvs_raw_BV1old_1_a_1")).toBe(false);
    expect(storage.map.has("boc_lvs_raw_BV1c_1_a_1")).toBe(true);
    // 索引同步收缩：被淘汰 bvid 整条移除
    expect(await mod.readLruIndex()).toEqual({
      boc_lvs_raw_: {
        BV1a: { ts: 100, keys: ["boc_lvs_raw_BV1a_1_a_1"] },
        BV1b: { ts: 200, keys: ["boc_lvs_raw_BV1b_1_a_1"] },
        BV1c: { ts: 300, keys: ["boc_lvs_raw_BV1c_1_a_1"] }
      }
    });
  });

  it("writeWithEviction 传 keys：正常写入路径不再触发 get(null)", async () => {
    // 三族索引均健康（有条目且有 keys），写路径全程走索引驱动淘汰
    await seedNewFormatIndex("boc_lvs_raw_", [
      ["BV1old", 10, ["boc_lvs_raw_BV1old_1_a_1"]],
      ["BV1a", 100, ["boc_lvs_raw_BV1a_1_a_1"]],
      ["BV1b", 200, ["boc_lvs_raw_BV1b_1_a_1"]],
      ["BV1c", 300, ["boc_lvs_raw_BV1c_1_a_1"]]
    ]);
    await seedNewFormatIndex("boc_lvs_summary_", [["BV1s", 5, ["boc_lvs_summary_BV1s_1_a_1"]]]);
    await seedNewFormatIndex("boc_subtitle_cache_", [["BV1s", 5, ["boc_subtitle_cache_BV1s_1_id_x"]]]);

    const result = await mod.writeWithEviction({
      family: "boc_lvs_raw_",
      bvid: "BV1new",
      keys: ["boc_lvs_raw_BV1new_1_a_1"],
      write: async () => storage.local.set({ boc_lvs_raw_BV1new_1_a_1: { v: "new" } })
    });

    expect(result).toEqual({ ok: true });
    // 索引健康：写入与两次 prune 均未全量扫描
    expect(storage.local.get.mock.calls.filter(([keys]) => keys === null)).toHaveLength(0);
    expect(storage.map.has("boc_lvs_raw_BV1old_1_a_1")).toBe(false); // 最旧被淘汰
    expect(storage.map.has("boc_lvs_raw_BV1a_1_a_1")).toBe(false); // 次旧同样超出 keep=3
    expect(storage.map.has("boc_lvs_raw_BV1new_1_a_1")).toBe(true);
    expect(storage.map.has("boc_lvs_raw_BV1c_1_a_1")).toBe(true);
    expect(Object.keys((await mod.readLruIndex()).boc_lvs_raw_)).toEqual(
      expect.arrayContaining(["BV1b", "BV1c", "BV1new"])
    );
  });

  it("索引条目缺 keys（旧格式/混合状态）→ 该族回退 get(null) 前缀扫描", async () => {
    await storage.local.set({
      // 旧格式索引（数值 ts，无 keys）
      [mod.LRU_INDEX_KEY]: {
        boc_lvs_raw_: { BV1old: 10, BV1a: 100, BV1b: 200, BV1c: 300 }
      },
      boc_lvs_raw_BV1old_1_a_1: { v: "old" },
      boc_lvs_raw_BV1a_1_a_1: { v: "a" },
      boc_lvs_raw_BV1b_1_a_1: { v: "b" },
      boc_lvs_raw_BV1c_1_a_1: { v: "c" }
    });

    const removed = await mod.pruneToRecentVideos(["boc_lvs_raw_"]);
    expect(storage.local.get.mock.calls.some(([keys]) => keys === null)).toBe(true);
    expect(storage.map.has("boc_lvs_raw_BV1old_1_a_1")).toBe(false);
    expect(storage.map.has("boc_lvs_raw_BV1c_1_a_1")).toBe(true);
  });

  it("索引 keys 指向已被外部删除的键：视同已删，不报错、不记入 removed", async () => {
    await seedNewFormatIndex("boc_lvs_raw_", [
      ["BV1a", 100, ["boc_lvs_raw_BV1a_1_a_1"]],
      // BV1ghost 的键已不存在于 storage
      ["BV1ghost", 200, ["boc_lvs_raw_BV1ghost_1_a_1"]]
    ]);
    // 手动移除 ghost 的数据键，模拟其他路径删除
    storage.map.delete("boc_lvs_raw_BV1ghost_1_a_1");

    const removed = await mod.pruneToRecentVideos(["boc_lvs_raw_"]);
    expect(removed).toEqual({});
    expect(storage.map.has("boc_lvs_raw_BV1a_1_a_1")).toBe(true);
  });
});

describe("writeWithEviction：失败淘汰重试 + distinct 失败", () => {
  it("首次成功：写一次、更新索引、并维持每族最近 3 个视频", async () => {
    for (const [bvid, ts] of [["BV1old", 1], ["BV1a", 10], ["BV1b", 20], ["BV1c", 30]]) {
      await mod.recordCacheWrite("boc_lvs_raw_", bvid, ts);
      await storage.local.set({ [`boc_lvs_raw_${bvid}_1_a_1`]: { v: bvid } });
    }
    const write = vi.fn(async () => {
      await storage.local.set({ "boc_lvs_raw_BV1new_1_a_1": { v: "new" } });
    });
    const result = await mod.writeWithEviction({ family: "boc_lvs_raw_", bvid: "BV1new", write });

    expect(result).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(storage.map.has("boc_lvs_raw_BV1new_1_a_1")).toBe(true);
    // 刚写入的 bvid 是最近写入 → 保留；最旧的 BV1old 被淘汰
    expect(storage.map.has("boc_lvs_raw_BV1old_1_a_1")).toBe(false);
    expect((await mod.readLruIndex()).boc_lvs_raw_.BV1new.ts).toEqual(expect.any(Number));
  });

  it("写入失败 → 先淘汰再重试一次，重试成功返回 { ok:true }", async () => {
    // 注入 4 个视频的索引：BV1old 最旧，写入目标 BV1a
    await mod.recordCacheWrite("boc_subtitle_cache_", "BV1old", 1);
    await mod.recordCacheWrite("boc_subtitle_cache_", "BV1m", 2);
    await mod.recordCacheWrite("boc_subtitle_cache_", "BV1n", 3);
    await mod.recordCacheWrite("boc_subtitle_cache_", "BV1a", 4);
    await storage.local.set({
      boc_subtitle_cache_BV1old_1_id_x: { body: [], timestamp: 1 },
      boc_subtitle_cache_BV1m_1_id_x: { body: [], timestamp: 2 },
      boc_subtitle_cache_BV1n_1_id_x: { body: [], timestamp: 3 }
    });
    let dataWriteAttempts = 0;

    storage.local.set.mockImplementation(async (items) => {
      // 仅数据键首次写入失败（模拟容量不足），索引记录正常
      if ("boc_subtitle_cache_BV1a_2_id_y" in items) {
        dataWriteAttempts += 1;
        if (dataWriteAttempts === 1) {
          throw new Error("quota");
        }
      }
      for (const [key, value] of Object.entries(items)) {
        storage.map.set(key, value);
      }
    });
    const write = vi.fn(async () => {
      await storage.local.set({ "boc_subtitle_cache_BV1a_2_id_y": { body: [], timestamp: 5 } });
    });
    const result = await mod.writeWithEviction({ family: "boc_subtitle_cache_", bvid: "BV1a", write });

    expect(result).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(2);
    // 淘汰发生了：最旧的 BV1old 键被清理，重试写入成功
    expect(storage.map.has("boc_subtitle_cache_BV1old_1_id_x")).toBe(false);
    expect(storage.map.has("boc_subtitle_cache_BV1m_1_id_x")).toBe(true);
    expect(storage.map.has("boc_subtitle_cache_BV1a_2_id_y")).toBe(true);
  });

  it("重试仍失败 → 返回 { ok:false, error: CacheWriteError }，不抛异常", async () => {
    // 仅数据键写入失败（模拟容量不足），索引记录正常 → 写入共尝试两次
    storage.local.set.mockImplementation(async (items) => {
      if ("boc_lvs_raw_BV1a_1_a_1" in items) {
        throw new Error("quota");
      }
      for (const [key, value] of Object.entries(items)) {
        storage.map.set(key, value);
      }
    });
    const write = vi.fn(async () => {
      await storage.local.set({ "boc_lvs_raw_BV1a_1_a_1": { v: "x" } });
    });
    const result = await mod.writeWithEviction({ family: "boc_lvs_raw_", bvid: "BV1a", write });

    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(mod.CacheWriteError);
    expect(result.error.name).toBe("CacheWriteError");
    expect(write).toHaveBeenCalledTimes(2); // 首次 + 淘汰后重试一次
  });

  it("write 非函数 → { ok:false }；keep 可自定义", async () => {
    const bad = await mod.writeWithEviction({ family: "boc_lvs_raw_", bvid: "BV1a" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeInstanceOf(mod.CacheWriteError);

    await mod.recordCacheWrite("boc_lvs_raw_", "BV1a", 1);
    await mod.recordCacheWrite("boc_lvs_raw_", "BV1b", 2);
    await storage.local.set({
      boc_lvs_raw_BV1a_1_a_1: { v: "a" },
      boc_lvs_raw_BV1b_1_a_1: { v: "b" }
    });
    await mod.writeWithEviction({
      family: "boc_lvs_raw_",
      bvid: "BV1b",
      keep: 1,
      write: async () => storage.local.set({ "boc_lvs_raw_BV1b_1_b_2": { v: "b2" } })
    });
    expect(storage.map.has("boc_lvs_raw_BV1a_1_a_1")).toBe(false);
    expect(storage.map.has("boc_lvs_raw_BV1b_1_a_1")).toBe(true);
  });
});

describe("一次机制覆盖两族：真实写路径（segment-cache / subtitle cache）", () => {
  it("subtitle/cache.js saveSubtitleToCache 更新索引并淘汰第 4 个旧视频", async () => {
    const cache = await import("../../extension/subtitle/cache.js");
    const bvids = ["BV1v1", "BV1v2", "BV1v3"];
    let ts = 100;
    for (const bvid of bvids) {
      await cache.saveSubtitleToCache(`boc_subtitle_cache_${bvid}_1_id_x`, [{ from: 0, to: 1, content: "x" }]);
      await mod.recordCacheWrite("boc_subtitle_cache_", bvid, ts);
      ts += 100;
    }
    await cache.saveSubtitleToCache("boc_subtitle_cache_BV1v4_1_id_x", [{ from: 0, to: 1, content: "new" }]);

    expect(storage.map.has("boc_subtitle_cache_BV1v1_1_id_x")).toBe(false);
    expect(storage.map.has("boc_subtitle_cache_BV1v4_1_id_x")).toBe(true);
    const index = await mod.readLruIndex();
    expect(Object.keys(index.boc_subtitle_cache_)).toEqual(
      expect.arrayContaining(["BV1v2", "BV1v3", "BV1v4"])
    );
    expect(index.boc_subtitle_cache_.BV1v1).toBeUndefined();
  });

  it("segment-cache.js saveRawSegments/saveSegmentSummary 同样记录索引并淘汰旧视频", async () => {
    const seg = await import("../../extension/ai/segment-cache.js");
    let ts = 100;
    for (const bvid of ["BV1s1", "BV1s2", "BV1s3"]) {
      await seg.saveRawSegments(seg.getRawSegmentKey({ bvid, cid: "1", subtitleId: "s", segmentIndex: 1 }), []);
      await seg.saveSegmentSummary(seg.getSegmentSummaryKey({ bvid, cid: "1", subtitleId: "s", segmentIndex: 1 }), "小");
      await mod.recordCacheWrite("boc_lvs_raw_", bvid, ts);
      await mod.recordCacheWrite("boc_lvs_summary_", bvid, ts);
      ts += 100;
    }
    await seg.saveRawSegments(seg.getRawSegmentKey({ bvid: "BV1s4", cid: "1", subtitleId: "s", segmentIndex: 1 }), [
      { from: 0, to: 5, content: "x" }
    ]);

    expect(storage.map.has("boc_lvs_raw_BV1s1_1_id_s_1")).toBe(false);
    expect(storage.map.has("boc_lvs_raw_BV1s4_1_id_s_1")).toBe(true);
  });
});
