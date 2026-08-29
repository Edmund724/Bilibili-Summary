// ai/segment-cache.js 段缓存测试（04 票）：
// 覆盖分段小结 / 原始字幕段的落盘读写（命中/未命中）、中止后已落盘段跨会话复用、
// 换轨不串（字幕轨 source key 区分）、键含 bvid+cid+段、键风格对齐 getSubtitleCacheKey，
// 以及读写失败的容错（logWarn 且不抛异常）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let mod;
let storage;

// 内存 Map 实现的 chrome.storage.local：get/set/remove 均为 vi.fn，便于断言调用与注入失败。
function createMemoryStorage() {
  const map = new Map();
  const local = {
    get: vi.fn(async (keys) => {
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
  mod = await import("../../extension/ai/segment-cache.js");
}

beforeEach(async () => {
  await importModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("分段小结落盘读写（命中/未命中）", () => {
  it("未 save 的 key load 返回 null；save 后 load 返回原字符串", async () => {
    const key = mod.getSegmentSummaryKey({ bvid: "BV1a", cid: "1", subtitleId: "sub-1", segmentIndex: 0 });

    expect(await mod.loadSegmentSummary(key)).toBeNull();

    await mod.saveSegmentSummary(key, "小结一：事实A。");
    expect(await mod.loadSegmentSummary(key)).toBe("小结一：事实A。");
    // 存储值形状 { summary, timestamp }，风格对齐 subtitle/cache.js 的 { body, timestamp }
    expect(storage.map.get(key)).toMatchObject({ summary: "小结一：事实A。" });
    expect(storage.map.get(key).timestamp).toEqual(expect.any(Number));
  });

  it("存储的是传入的 summary 原值（含空串，空串命中 ≠ 未命中）", async () => {
    const key = mod.getSegmentSummaryKey({ bvid: "BV1a", cid: "1", subtitleId: "sub-1", segmentIndex: 0 });
    await mod.saveSegmentSummary(key, "");
    expect(await mod.loadSegmentSummary(key)).toBe("");
  });
});

describe("原始字幕段落盘读写（命中/未命中）", () => {
  it("未 save 的 key load 返回 null；save segments 后 load 返回原数组", async () => {
    const key = mod.getRawSegmentKey({ bvid: "BV1a", cid: "1", subtitleId: "sub-1", segmentIndex: 0 });

    expect(await mod.loadRawSegments(key)).toBeNull();

    const segments = [
      { from: 0, to: 5, content: "第一句" },
      { from: 5, to: 10, content: "第二句" }
    ];
    await mod.saveRawSegments(key, segments);
    expect(await mod.loadRawSegments(key)).toEqual(segments);
    // 存储值形状 { segments, timestamp }
    expect(storage.map.get(key)).toMatchObject({ segments });
    expect(storage.map.get(key).timestamp).toEqual(expect.any(Number));
  });
});

describe("中止复用：已落盘的段小结跨会话/编排可读", () => {
  it("先 save 段1、未 save 段2 → 新会话只命中段1、段2 仍未命中", async () => {
    const key1 = mod.getSegmentSummaryKey({ bvid: "BV1a", cid: "1", subtitleId: "sub-1", segmentIndex: 0 });
    const key2 = mod.getSegmentSummaryKey({ bvid: "BV1a", cid: "1", subtitleId: "sub-1", segmentIndex: 1 });
    await mod.saveSegmentSummary(key1, "段1小结");

    // 模拟新会话/新编排：同一 chrome.storage.local（持久化介质）下重新导入模块
    vi.resetModules();
    const freshMod = await import("../../extension/ai/segment-cache.js");
    expect(await freshMod.loadSegmentSummary(key1)).toBe("段1小结");
    expect(await freshMod.loadSegmentSummary(key2)).toBeNull();
  });
});

describe("换轨不串：缓存键随字幕轨区分", () => {
  it("同一 bvid+cid+段、不同 subtitleId → 不同 key，load 互不可见", async () => {
    const base = { bvid: "BV1a", cid: "1", segmentIndex: 0 };
    const trackA = mod.getSegmentSummaryKey({ ...base, subtitleId: "sub-A" });
    const trackB = mod.getSegmentSummaryKey({ ...base, subtitleId: "sub-B" });
    expect(trackA).not.toBe(trackB);

    await mod.saveSegmentSummary(trackA, "A轨小结");
    expect(await mod.loadSegmentSummary(trackA)).toBe("A轨小结");
    expect(await mod.loadSegmentSummary(trackB)).toBeNull();

    // 原始字幕段同样按轨隔离
    const rawA = mod.getRawSegmentKey({ ...base, subtitleId: "sub-A" });
    const rawB = mod.getRawSegmentKey({ ...base, subtitleId: "sub-B" });
    expect(rawA).not.toBe(rawB);
    await mod.saveRawSegments(rawA, [{ from: 0, to: 5, content: "a" }]);
    expect(await mod.loadRawSegments(rawB)).toBeNull();
  });

  it("source key 区分 id / url / lang 三种来源，id 优先", () => {
    const base = { bvid: "BV1a", cid: "1", segmentIndex: 0 };
    const idKey = mod.getSegmentSummaryKey({ ...base, subtitleId: "sub-1" });
    const urlKey = mod.getSegmentSummaryKey({ ...base, subtitleUrl: "https://s.example.com/sub/1.json" });
    const langKey = mod.getSegmentSummaryKey({ ...base, lang: "zh-CN" });
    expect(new Set([idKey, urlKey, langKey]).size).toBe(3);

    // 同时给 id + url 时以 id 为准
    const bothKey = mod.getSegmentSummaryKey({
      ...base,
      subtitleId: "sub-1",
      subtitleUrl: "https://s.example.com/sub/1.json"
    });
    expect(bothKey).toBe(idKey);
  });
});

describe("键含 bvid+cid+段，键风格对齐 getSubtitleCacheKey", () => {
  it("不同 bvid / cid / segmentIndex → 不同 key", () => {
    const k = (bvid, cid, segmentIndex) =>
      mod.getSegmentSummaryKey({ bvid, cid, segmentIndex, subtitleId: "sub-1" });
    const keys = [k("BV1a", "1", 0), k("BV1b", "1", 0), k("BV1a", "2", 0), k("BV1a", "1", 1)];
    expect(new Set(keys).size).toBe(4);
  });

  it("key 中间段即 buildSubtitleSourceKey 产物；换 URL 中 id（路径变化）source key 变，仅换 query 不变", async () => {
    const { buildSubtitleSourceKey } = await import("../../extension/subtitle/cache.js");
    const base = { bvid: "BV1a", cid: "1", segmentIndex: 3 };
    const url = "https://s.example.com/sub/abc.json?auth=1";
    const key = mod.getSegmentSummaryKey({ ...base, subtitleUrl: url });
    expect(key).toBe(`boc_lvs_summary_BV1a_1_${buildSubtitleSourceKey("", url, "")}_3`);

    // 换 URL 中的 id（路径变化）→ source key 变
    const url2 = "https://s.example.com/sub/def.json?auth=2";
    expect(mod.getSegmentSummaryKey({ ...base, subtitleUrl: url2 })).not.toBe(key);
    // 仅换 query 参数 → normalizeSubtitleUrlForCache 剥离 query，source key 不变
    expect(mod.getSegmentSummaryKey({ ...base, subtitleUrl: "https://s.example.com/sub/abc.json?auth=999" })).toBe(key);
  });
});

describe("上下文键位构造器：与原手拼键逐字节一致（预热缓存不失效）", () => {
  const context = {
    bvid: "BV1ctx",
    cid: "7",
    selectedSubtitleId: "sub-9",
    selectedSubtitleUrl: "https://s.example.com/sub/9.json?auth=1",
    subtitleLang: "zh-CN",
    // 上下文里的其余字段不得混入键位
    title: "测试视频",
    subtitleBody: [{ from: 0, to: 5, content: "x" }]
  };

  it("buildSegmentSummaryCacheKey(context, i) === getSegmentSummaryKey(手拼 6 字段)", () => {
    for (const segmentIndex of [0, 1, 3]) {
      const unified = mod.buildSegmentSummaryCacheKey(context, segmentIndex);
      const manual = mod.getSegmentSummaryKey({
        bvid: context.bvid,
        cid: context.cid,
        subtitleId: context.selectedSubtitleId,
        subtitleUrl: context.selectedSubtitleUrl,
        lang: context.subtitleLang,
        segmentIndex
      });
      expect(unified).toBe(manual);
      expect(unified).toBe(`boc_lvs_summary_${context.bvid}_${context.cid}_id_sub-9_${segmentIndex}`);
    }
  });

  it("buildRawSegmentCacheKey(context, i) === getRawSegmentKey(手拼 6 字段)", () => {
    for (const segmentIndex of [0, 1, 3]) {
      const unified = mod.buildRawSegmentCacheKey(context, segmentIndex);
      const manual = mod.getRawSegmentKey({
        bvid: context.bvid,
        cid: context.cid,
        subtitleId: context.selectedSubtitleId,
        subtitleUrl: context.selectedSubtitleUrl,
        lang: context.subtitleLang,
        segmentIndex
      });
      expect(unified).toBe(manual);
      expect(unified).toBe(`boc_lvs_raw_${context.bvid}_${context.cid}_id_sub-9_${segmentIndex}`);
    }
  });

  it("segmentCacheKeyFields：selectedSubtitleId/Url/Lang 映射为键位入参且只挑键位字段", () => {
    expect(mod.segmentCacheKeyFields(context)).toEqual({
      bvid: "BV1ctx",
      cid: "7",
      subtitleId: "sub-9",
      subtitleUrl: "https://s.example.com/sub/9.json?auth=1",
      lang: "zh-CN"
    });
    expect(mod.segmentCacheKeyFields(null)).toEqual({
      bvid: undefined,
      cid: undefined,
      subtitleId: undefined,
      subtitleUrl: undefined,
      lang: undefined
    });
  });

  it("统一构造器落盘 → 旧手拼键可读回（跨写读方一致）", async () => {
    const summaryKey = mod.buildSegmentSummaryCacheKey(context, 2);
    const rawKey = mod.buildRawSegmentCacheKey(context, 2);
    await mod.saveSegmentSummary(summaryKey, "统一键位小结");
    await mod.saveRawSegments(rawKey, [{ from: 0, to: 5, content: "x" }]);

    const legacySummaryKey = mod.getSegmentSummaryKey({
      bvid: context.bvid,
      cid: context.cid,
      subtitleId: context.selectedSubtitleId,
      subtitleUrl: context.selectedSubtitleUrl,
      lang: context.subtitleLang,
      segmentIndex: 2
    });
    expect(await mod.loadSegmentSummary(legacySummaryKey)).toBe("统一键位小结");
    expect(await mod.loadRawSegments(legacySummaryKey.replace("boc_lvs_summary_", "boc_lvs_raw_"))).toEqual([
      { from: 0, to: 5, content: "x" }
    ]);
  });
});

describe("容错：读写失败 logWarn 且不抛异常", () => {
  it("load 读失败返回 null（小结与原始段）", async () => {
    storage.local.get.mockRejectedValueOnce(new Error("read boom"));
    await expect(mod.loadSegmentSummary("boc_lvs_summary_x")).resolves.toBeNull();

    storage.local.get.mockRejectedValueOnce(new Error("read boom"));
    await expect(mod.loadRawSegments("boc_lvs_raw_x")).resolves.toBeNull();
  });

  it("save 写失败先淘汰重试：重试成功返回 { ok:true } 且不抛", async () => {
    storage.local.set.mockRejectedValueOnce(new Error("write boom"));
    await expect(mod.saveSegmentSummary("boc_lvs_summary_x", "小结")).resolves.toMatchObject({ ok: true });

    storage.local.set.mockRejectedValueOnce(new Error("write boom"));
    await expect(mod.saveRawSegments("boc_lvs_raw_x", [])).resolves.toMatchObject({ ok: true });
  });

  it("save 持续失败（淘汰后重试仍失败）返回 { ok:false, error } 且不抛异常", async () => {
    storage.local.set.mockRejectedValue(new Error("quota"));
    const summaryResult = await mod.saveSegmentSummary("boc_lvs_summary_x", "小结");
    expect(summaryResult.ok).toBe(false);
    expect(summaryResult.error).toBeInstanceOf(Error);

    const rawResult = await mod.saveRawSegments("boc_lvs_raw_x", []);
    expect(rawResult.ok).toBe(false);
    expect(rawResult.error).toBeInstanceOf(Error);
  });
});
