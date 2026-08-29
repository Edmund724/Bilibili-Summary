// subtitle/cache.js ASR 孤儿清理测试：
// (d) clearStaleAsrSubtitleCache 只删除同 (bvid, cid) 的过期 ASR 变体键
//     （不同 provider/model/language），平台字幕轨（id_/url_/lang_）与其它视频一律不动；
//     keepKey（本轮刚写入的变体）保留。
// 同时覆盖 subtitle/cache.js 与统一 LRU 的接线：写失败先淘汰重试、最终失败返回 { ok:false }。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let cache;
let storage;

// 内存 Map 实现的 chrome.storage.local：get 需支持 null（全量枚举）。
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

const BODY = [{ from: 0, to: 5, content: "字幕" }];

async function importModules() {
  vi.resetModules();
  resetModuleState();
  storage = createMemoryStorage();
  vi.stubGlobal("chrome", { storage: { local: storage.local } });
  cache = await import("../../extension/subtitle/cache.js");
}

beforeEach(async () => {
  await importModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clearStaleAsrSubtitleCache：只清同视频的过期 ASR 变体", () => {
  it("删除同 bvid+cid 的其它 ASR 变体键，保留 keepKey / 平台轨 / 其它视频", async () => {
    const keepKey = cache.getSubtitleCacheKey({ bvid: "BV1o", cid: "7", subtitleId: "asr:new-provider:gpt:auto" });
    const staleAsr1 = cache.getSubtitleCacheKey({ bvid: "BV1o", cid: "7", subtitleId: "asr:old-provider:gpt:auto" });
    const staleAsr2 = cache.getSubtitleCacheKey({ bvid: "BV1o", cid: "7", subtitleId: "asr:new-provider:gpt:zh" });
    const platformId = cache.getSubtitleCacheKey({ bvid: "BV1o", cid: "7", subtitleId: "88" });
    const platformUrl = cache.getSubtitleCacheKey({ bvid: "BV1o", cid: "7", subtitleUrl: "https://a.b/c.json" });
    const platformLang = cache.getSubtitleCacheKey({ bvid: "BV1o", cid: "7", lang: "zh-CN" });
    const otherVideoAsr = cache.getSubtitleCacheKey({ bvid: "BV1p", cid: "9", subtitleId: "asr:old-provider:gpt:auto" });

    for (const key of [keepKey, staleAsr1, staleAsr2, platformId, platformUrl, platformLang, otherVideoAsr]) {
      await storage.local.set({ [key]: { body: BODY, timestamp: 1 } });
    }

    const removed = await cache.clearStaleAsrSubtitleCache({ bvid: "BV1o", cid: "7", keepKey });

    expect(removed.sort()).toEqual([staleAsr1, staleAsr2].sort());
    expect(storage.map.has(keepKey)).toBe(true);
    expect(storage.map.has(staleAsr1)).toBe(false);
    expect(storage.map.has(staleAsr2)).toBe(false);
    // 平台字幕轨不是孤儿：id / url / lang 三种 source key 全保留
    expect(storage.map.has(platformId)).toBe(true);
    expect(storage.map.has(platformUrl)).toBe(true);
    expect(storage.map.has(platformLang)).toBe(true);
    // 其它视频的 ASR 变体不动
    expect(storage.map.has(otherVideoAsr)).toBe(true);
  });

  it("无过期变体 / 缺 bvid+cid / 枚举失败 → 不删任何键并返回 []", async () => {
    const keepKey = cache.getSubtitleCacheKey({ bvid: "BV1o", cid: "7", subtitleId: "asr:a:m:auto" });
    await storage.local.set({ [keepKey]: { body: BODY, timestamp: 1 } });

    expect(await cache.clearStaleAsrSubtitleCache({ bvid: "BV1o", cid: "7", keepKey })).toEqual([]);
    expect(await cache.clearStaleAsrSubtitleCache({ bvid: "", cid: "", keepKey })).toEqual([]);

    storage.local.get.mockRejectedValue(new Error("boom"));
    await expect(cache.clearStaleAsrSubtitleCache({ bvid: "BV1o", cid: "7", keepKey })).resolves.toEqual([]);
    expect(storage.map.has(keepKey)).toBe(true);
  });

  it("索引含该 bvid 的 keys → 定点批量枚举，不做 get(null) 全量枚举", async () => {
    const keepKey = cache.getSubtitleCacheKey({ bvid: "BV1o", cid: "7", subtitleId: "asr:new:p:m:auto" });
    const staleAsr = cache.getSubtitleCacheKey({ bvid: "BV1o", cid: "7", subtitleId: "asr:old:p:m:auto" });
    await storage.local.set({
      [keepKey]: { body: BODY, timestamp: 2 },
      [staleAsr]: { body: BODY, timestamp: 1 }
    });
    const lru = await import("../../extension/core/cache-lru.js");
    await lru.recordCacheWrite("boc_subtitle_cache_", "BV1o", 10, [keepKey, staleAsr]);

    const removed = await cache.clearStaleAsrSubtitleCache({ bvid: "BV1o", cid: "7", keepKey });

    expect(removed).toEqual([staleAsr]);
    expect(storage.map.has(staleAsr)).toBe(false);
    expect(storage.map.has(keepKey)).toBe(true);
    // 全程无全量枚举（索引读 + 定点批量 get 都不是 null）
    expect(storage.local.get.mock.calls.some(([keys]) => keys === null)).toBe(false);
  });
});

describe("saveSubtitleToCache 与统一 LRU 的接线", () => {
  it("写入失败先淘汰重试：重试成功返回 { ok:true } 且旧视频被淘汰", async () => {
    // 造出已满 3 个 + 1 最旧的族（BV1old 最旧，写入目标 BV1n 由 save 内部记录）
    const lru = await import("../../extension/core/cache-lru.js");
    await lru.recordCacheWrite("boc_subtitle_cache_", "BV1old", 1);
    await lru.recordCacheWrite("boc_subtitle_cache_", "BV1m", 2);
    await lru.recordCacheWrite("boc_subtitle_cache_", "BV1w", 3);
    await storage.local.set({
      boc_subtitle_cache_BV1old_1_id_x: { body: BODY, timestamp: 1 },
      boc_subtitle_cache_BV1m_1_id_x: { body: BODY, timestamp: 2 },
      boc_subtitle_cache_BV1w_1_id_x: { body: BODY, timestamp: 3 }
    });
    let dataWriteAttempts = 0;
    storage.local.set.mockImplementation(async (items) => {
      // 仅数据键首次写入失败（模拟容量不足），索引记录正常
      if ("boc_subtitle_cache_BV1n_1_id_y" in items) {
        dataWriteAttempts += 1;
        if (dataWriteAttempts === 1) {
          throw new Error("quota");
        }
      }
      for (const [key, value] of Object.entries(items)) {
        storage.map.set(key, value);
      }
    });

    const result = await cache.saveSubtitleToCache("boc_subtitle_cache_BV1n_1_id_y", BODY);

    expect(result).toMatchObject({ ok: true });
    expect(dataWriteAttempts).toBe(2);
    expect(storage.map.has("boc_subtitle_cache_BV1old_1_id_x")).toBe(false);
    expect(storage.map.get("boc_subtitle_cache_BV1n_1_id_y")).toMatchObject({ body: BODY });
  });

  it("淘汰后重试仍失败 → 返回 { ok:false, error } 不抛异常（logError 由调用方上浮）", async () => {
    storage.local.set.mockRejectedValue(new Error("quota"));
    const result = await cache.saveSubtitleToCache("boc_subtitle_cache_BV1a_1_id_x", BODY);
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });
});
