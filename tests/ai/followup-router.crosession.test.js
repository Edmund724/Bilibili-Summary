// ai/followup-router.js 跨会话回退测试（原始字幕缓存跨会话接线）：
// (c) plan.segments 为空（恢复会话/新会话，内存原始段已不在）时，追问上下文回退到
//     段缓存落盘的原始字幕段（loadRawSegments 家族键），分段小结与按需检索都恢复；
//     内存 plan.segments 存在时仍完全优先内存路径（不触达段缓存枚举）；
//     两级皆空 → 维持返回 null 交回完整 Map-Reduce。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let storage;
let segCache;
let router;

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

async function importModules() {
  vi.resetModules();
  resetModuleState();
  storage = createMemoryStorage();
  vi.stubGlobal("chrome", { storage: { local: storage.local } });
  segCache = await import("../../extension/ai/segment-cache.js");
  router = await import("../../extension/ai/followup-router.js");
}

// 预置某视频 3 段的原始字幕段 + 分段小结（键位与 map-reduce 落盘一致）。
async function seedVideoCache({ bvid, cid, subtitleId, segments }) {
  for (const seg of segments) {
    await segCache.saveRawSegments(
      segCache.getRawSegmentKey({ bvid, cid, subtitleId, segmentIndex: seg.index }),
      seg.items
    );
    await segCache.saveSegmentSummary(
      segCache.getSegmentSummaryKey({ bvid, cid, subtitleId, segmentIndex: seg.index }),
      `小结${seg.index}：第${seg.index}段摘要。`
    );
  }
}

const context = {
  title: "跨会话视频",
  bvid: "BV1cross",
  cid: "9",
  selectedSubtitleId: "sub-9",
  subtitleLang: "zh",
  chapters: [],
  subtitleMarkdown: "整篇原始字幕全文的唯一标记 __RAW_FULL__"
};

const storedSegments = [
  { index: 1, items: [{ from: 0, to: 500, content: "开场白内容ABC" }] },
  { index: 2, items: [{ from: 500, to: 1000, content: "后续内容DEF" }] },
  { index: 3, items: [{ from: 1000, to: 1500, content: "结尾内容GHI" }] }
];

const history = [{ role: "assistant", content: "# 视频笔记：《跨会话视频》\n完整笔记正文。" }];

beforeEach(async () => {
  await importModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("跨会话回退：plan.segments 为空时从段缓存恢复", () => {
  it("落盘原始段恢复检索注入：时间戳命中 + 分段小结齐备 → 返回压缩上下文", async () => {
    await seedVideoCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, segments: storedSegments });

    const result = await router.resolveFollowupContext({
      context,
      plan: { mode: "map-reduce", segments: [] },
      history,
      userPrompt: "09:00 那里讲了什么" // 540s → 命中第 2 段
    });

    expect(result).not.toBeNull();
    // 分段小结从段缓存恢复（会话内内存段已不在）
    expect(result.subtitleMarkdown).toContain("小结1：第1段摘要。");
    expect(result.subtitleMarkdown).toContain("小结3：第3段摘要。");
    // 检索注入命中落盘的原始段
    expect(result.subtitleMarkdown).toContain("## 相关原始字幕段");
    expect(result.subtitleMarkdown).toContain("后续内容DEF");
    // 压缩上下文语义不变：不含原始全文、subtitleBody 置空、视频身份保留
    expect(result.subtitleMarkdown).not.toContain("__RAW_FULL__");
    expect(result.subtitleBody).toEqual([]);
    expect(result.bvid).toBe(context.bvid);
    expect(result.cid).toBe(context.cid);
  });

  it("段缓存缺失（同视频不同轨/未落盘）→ 维持 null 交回完整 Map-Reduce", async () => {
    await seedVideoCache({ bvid: "BV1other", cid: "1", subtitleId: "s", segments: storedSegments });

    const result = await router.resolveFollowupContext({
      context,
      plan: { mode: "map-reduce", segments: [] },
      history,
      userPrompt: "随便问"
    });
    expect(result).toBeNull();
  });

  it("缺 bvid/cid 的追问上下文不回退（键位无法定位）→ null", async () => {
    const result = await router.resolveFollowupContext({
      context: { ...context, bvid: "", cid: "" },
      plan: { mode: "map-reduce", segments: [] },
      history,
      userPrompt: "随便问"
    });
    expect(result).toBeNull();
  });

  it("loadStoredRawSegments：按键尾段序升序返回，from/to 由 items 首末项推导", async () => {
    await seedVideoCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, segments: storedSegments });

    const restored = await segCache.loadStoredRawSegments({
      bvid: context.bvid,
      cid: context.cid,
      subtitleId: context.selectedSubtitleId
    });
    expect(restored.map((seg) => seg.index)).toEqual([1, 2, 3]);
    expect(restored[0]).toMatchObject({ index: 1, from: 0, to: 500 });
    expect(restored[2]).toMatchObject({ index: 3, from: 1000, to: 1500 });
    expect(restored[1].items).toEqual([{ from: 500, to: 1000, content: "后续内容DEF" }]);

    // 换轨不串：不同 subtitleId 枚举不到
    expect(
      await segCache.loadStoredRawSegments({ bvid: context.bvid, cid: context.cid, subtitleId: "sub-other" })
    ).toEqual([]);
  });
});

describe("会话内路径不变：plan.segments 存在时完全优先内存段", () => {
  it("检索注入用内存段（内容不同可区分），且不触达段缓存的全量枚举", async () => {
    await seedVideoCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, segments: storedSegments });
    storage.local.get.mockClear();

    const inMemoryPlan = {
      mode: "map-reduce",
      segments: [
        { index: 1, from: 0, to: 500, items: [{ from: 0, to: 500, content: "内存版本内容XYZ" }] },
        { index: 2, from: 500, to: 1000, items: [{ from: 500, to: 1000, content: "内存第二段内容" }] }
      ]
    };
    const result = await router.resolveFollowupContext({
      context,
      plan: inMemoryPlan,
      history,
      userPrompt: "09:00 那里讲了什么"
    });

    expect(result).not.toBeNull();
    // 09:00（540s）命中内存第 2 段（500-1000）
    expect(result.subtitleMarkdown).toContain("内存第二段内容");
    expect(result.subtitleMarkdown).not.toContain("后续内容DEF");
    // 内存段在 → 无跨会话回退（loadStoredRawSegments 的 get(null) 枚举不发生）
    expect(storage.local.get).not.toHaveBeenCalledWith(null);
  });

  it("既有会话内行为回归：成稿后追问的压缩上下文语义不变", async () => {
    const body = Array.from({ length: 110 }, (_, i) => ({
      from: i * 5,
      to: i * 5 + 5,
      content: "x".repeat(1000)
    }));
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({ body, chapters: [] });
    const result = await router.resolveFollowupContext({
      context: { ...context, subtitleBody: body },
      plan,
      history,
      userPrompt: "再讲讲",
      loadSummaries: async () => ["小结一：事实A。"]
    });
    expect(result).not.toBeNull();
    expect(result.subtitleBody).toEqual([]);
    expect(result.subtitleMarkdown).toContain("小结一：事实A。");
    expect(result.subtitleMarkdown).not.toContain("__RAW_FULL__");
  });
});
