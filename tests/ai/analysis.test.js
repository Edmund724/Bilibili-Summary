// ai/analysis.ts 概览数据管线测试（概览票 07 + research/analysis-pipeline.md）：
// 覆盖 validateAnalysis 越界丢弃与秒反推、repairTruncatedJson 截断修复、
// 部分失败降级（failedRanges）、自带章节短路径产物同构、缓存键含签名且换签名
// miss、双路径分派（≤100k 单次 / >100k 分段）、promise 复用去重。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, makeSubtitleBody } from "../setup.js";

let mod;
let storage;

// 内存 Map 实现的 chrome.storage.local（get/set/remove 均 vi.fn，便于断言与注入失败）。
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
  mod = await import("../../extension/ai/analysis.js");
}

beforeEach(async () => {
  await importModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeProvider() {
  return { baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" };
}

function makeContext(overrides = {}) {
  return {
    title: "测试视频",
    author: "UP 主甲",
    bvid: "BV1test",
    cid: "123",
    selectedSubtitleId: "sub-1",
    subtitleLang: "zh-CN",
    videoDuration: 300,
    ...overrides
  };
}

// 依系统提示词区分「整份分章」与「短路径只挑金句」，并按用户提示词里的
// 「第 i / N 段」产出来自对应区间的章节/金句 JSON。
function buildCompletionFake({ failedSegments = new Set(), parts = null } = {}) {
  const calls = [];
  const chatCompletion = vi.fn(async (input) => {
    calls.push(input);
    const system = input.messages[0]?.content || "";
    const user = input.messages.at(-1)?.content || "";
    const isQuotes = system.includes("为它挑选金句");
    const rangeMatch = user.match(/第 (\d+) \/ (\d+) 段/);
    const index = rangeMatch ? Number(rangeMatch[1]) : 1;
    if (failedSegments.has(index)) {
      throw new Error(`HTTP 500: 段 ${index} 生成失败`);
    }
    if (parts) {
      return parts[index] || parts[1];
    }
    // 时间戳落在段区间内：分段按 50k 预算切，每段 50 条（5s/条），段 i 起点 = (i-1)*250。
    // 末段只有 10 条（50s 跨度），章/金句时间戳取段起点 +5/+40 才能三段全部有效。
    const base = rangeMatch ? (Number(rangeMatch[1]) - 1) * 250 : 0;
    const payload = isQuotes
      ? {
          summary: `第 ${index} 段概述。`,
          keyQuotes: [{ quote: `金句${index}`, timestampSeconds: base + 10 }]
        }
      : {
          summary: `第 ${index} 段概述。`,
          chapters: [
            { title: `章${index}a`, timestampSeconds: base + 5, summary: "甲" },
            { title: `章${index}b`, timestampSeconds: base + 40, summary: "乙" }
          ],
          keyQuotes: [{ quote: `金句${index}`, timestampSeconds: base + 30 }]
        };
    return JSON.stringify(payload);
  });
  return { chatCompletion, calls };
}

// ============================================================
// 纯函数：validateAnalysis / parseLooseJson / repairTruncatedJson
// ============================================================

describe("validateAnalysis 越界丢弃与秒反推", () => {
  it("越上界/越下界（分段 minSeconds）的章节与金句直接丢弃，显示时间戳从秒反推不采信模型字符串", () => {
    const parsed = {
      chapters: [
        { title: "早于下界", timestampSeconds: 5, summary: "前情回顾里开出来的章" },
        { title: "合法章", timestampSeconds: 100, timestamp: "完全瞎写的字符串", summary: "内容" },
        { title: "越上界", timestampSeconds: 9999, summary: "编造" },
        { title: "", timestampSeconds: 150, summary: "无标题丢弃" }
      ],
      keyQuotes: [
        { quote: "早于下界金句", timestampSeconds: 8 },
        { quote: "合法金句", timestampSeconds: 150, timestamp: "瞎写" },
        { quote: "越上界金句", timestampSeconds: 3000 }
      ]
    };
    const result = mod.validateAnalysis(parsed, 200, 10);

    expect(result.chapters.map((c) => c.title)).toEqual(["合法章"]);
    expect(result.chapters[0]).toEqual({ from: 100, to: 200, title: "合法章", summary: "内容" });
    expect(result.quotes).toEqual([{ from: 150, content: "合法金句" }]);
    // 产出形状归一化：只有 from/to/title/summary 与 from/content，模型 timestamp 字符串不保留
    expect(Object.keys(result.chapters[0]).sort()).toEqual(["from", "summary", "title", "to"]);
    expect(Object.keys(result.quotes[0]).sort()).toEqual(["content", "from"]);
  });

  it("章界 to = 下一章 from，末章 to = maxTimestampSeconds；输出按 from 升序", () => {
    const result = mod.validateAnalysis(
      {
        chapters: [
          { title: "B", timestampSeconds: 120, summary: "" },
          { title: "A", timestampSeconds: 10, summary: "" }
        ],
        keyQuotes: []
      },
      300
    );
    expect(result.chapters).toEqual([
      { from: 10, to: 120, title: "A", summary: "" },
      { from: 120, to: 300, title: "B", summary: "" }
    ]);
  });

  it("秒数取整、字符串秒数与上限裁剪；空/畸形输入返回空产物", () => {
    const chapters = Array.from({ length: 120 }, (_, i) => ({ title: `章${i}`, timestampSeconds: i + 1 }));
    const quotes = Array.from({ length: 60 }, (_, i) => ({ quote: `句${i}`, timestampSeconds: i + 1 }));
    const result = mod.validateAnalysis({ chapters, keyQuotes: quotes }, 1000);
    expect(result.chapters).toHaveLength(mod.MAX_ANALYSIS_CHAPTERS);
    expect(result.quotes).toHaveLength(mod.MAX_ANALYSIS_QUOTES);

    const chapters2 = [{ title: "小数秒", timestampSeconds: 10.9 }];
    expect(mod.validateAnalysis({ chapters: chapters2 }, 100).chapters[0].from).toBe(10);
    expect(mod.validateAnalysis({ chapters: [{ title: "字符串秒", timestampSeconds: "42" }] }, 100).chapters[0].from).toBe(42);
    expect(mod.validateAnalysis(null, 100)).toEqual({ chapters: [], quotes: [] });
    expect(mod.validateAnalysis({ chapters: "not-array", keyQuotes: 42 }, 100)).toEqual({ chapters: [], quotes: [] });
    expect(mod.validateAnalysis({ chapters: [{ title: "NaN", timestampSeconds: "abc" }] }, 100).chapters).toEqual([]);
  });
});

describe("repairTruncatedJson 截断修复与 parseLooseJson 宽容解析", () => {
  it("截断在字符串中间 / 括号中间 / 逗号后，都能补齐保住已生成内容", () => {
    const expectParsed = (text) => {
      const parsed = JSON.parse(mod.repairTruncatedJson(text));
      expect(parsed.keyQuotes).toHaveLength(2);
      expect(parsed.keyQuotes[1].quote).toBe("第二句");
    };
    // 截断在字符串中间（引号未闭合）
    expectParsed('{"keyQuotes":[{"quote":"第一句","timestampSeconds":1},{"quote":"第二句');
    // 截断在对象/数组括号中间
    expectParsed('{"keyQuotes":[{"quote":"第一句","timestampSeconds":1},{"quote":"第二句","timestampSeconds":2');
    // 截断恰好停在逗号后（悬尾逗号先剥再补括号）
    expectParsed('{"keyQuotes":[{"quote":"第一句","timestampSeconds":1},{"quote":"第二句","timestampSeconds":2},');
  });

  it("悬尾转义符被剥掉再补引号", () => {
    const repaired = mod.repairTruncatedJson('{"chapters":[{"title":"反斜杠结尾\\');
    expect(JSON.parse(repaired)).toEqual({ chapters: [{ title: "反斜杠结尾" }] });
  });

  it("parseLooseJson 容忍围栏 / 前后赘语 / 尾逗号；截断时升级到 repairTruncatedJson", () => {
    const good = '{"chapters":[],"keyQuotes":[]}';
    expect(mod.parseLooseJson("```json\n" + good + "\n```")).toEqual({ chapters: [], keyQuotes: [] });
    expect(mod.parseLooseJson("好的，这是结果：" + good + "希望有帮助")).toEqual({ chapters: [], keyQuotes: [] });
    expect(mod.parseLooseJson('{"chapters":[{"title":"a","timestampSeconds":1,}],}')).toEqual({
      chapters: [{ title: "a", timestampSeconds: 1 }]
    });
    // 输出中途被截断：补齐后拿到 chapters 数组
    const truncated = mod.parseLooseJson('{"chapters":[{"title":"开场","timestampSeconds":0},{"title":"正题"');
    expect(truncated.chapters.map((c) => c.title)).toEqual(["开场", "正题"]);
  });

  it("彻底坏掉的 JSON 照常抛错（由调用方处理）", () => {
    expect(() => mod.parseLooseJson("完全不是 JSON")).toThrow();
  });
});

// ============================================================
// 双路径分派（≤100k 单次 / >100k 分段）
// ============================================================

describe("双路径分派", () => {
  it("≤100k 单次路径：1 次调用、显式 retries:2、无 rangeNote，产物含章节/金句", async () => {
    const { chatCompletion, calls } = buildCompletionFake();
    const body = makeSubtitleBody(50000);
    const result = await mod.runOverviewAnalysis(
      // digest-only-ui：调用方（reader/overview）显式传 thinkingLevel:"off"，
      // 此处断言它逐级透传到 chatCompletion（协议层据此注入关闭字段）。
      { provider: makeProvider(), context: makeContext({ subtitleBody: body }), thinkingLevel: "off" },
      { chatCompletion }
    );

    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(calls[0].retries).toBe(2);
    expect(calls[0].stream).toBeUndefined();
    expect(calls[0].thinkingLevel).toBe("off");
    // 系统提示词 = 整份分章提示词；用户提示词无 rangeNote（分段标记不出现）
    expect(calls[0].messages[0].content).toContain("产出一份结构化概览：章节 + 金句");
    // digest-only-ui：顶层概述字段已移除（章节条目内的 summary 不受影响）
    expect(calls[0].messages[0].content).not.toContain('"summary": "全片概述');
    const user = calls[0].messages.at(-1).content;
    expect(user).toContain("视频标题：测试视频");
    expect(user).toContain("UP 主：UP 主甲");
    expect(user).toContain("后段门槛：最后一个章节的时间戳必须晚于 3:45"); // 300s × 75% = 225s
    expect(user).toContain("第 0 秒");
    expect(user).not.toContain("长视频切分后");
    // maxTokens 按正文 0.5 比例估算（floor 2048）
    expect(calls[0].maxTokens).toBeGreaterThanOrEqual(2048);

    expect(result.chapters.map((c) => c.title)).toEqual(["章1a", "章1b"]);
    expect(result.quotes).toEqual([{ from: 30, content: "金句1" }]);
    expect(result.failedRanges).toBeUndefined();
  });

  it(">100k 分段路径：buildBudgetPlan 切段并发跑每段，段提示词带 rangeNote 与前情回顾，产物合并去重", async () => {
    const { chatCompletion, calls } = buildCompletionFake();
    const body = makeSubtitleBody(110000); // 3 段：50k / 50k / 10k
    const result = await mod.runOverviewAnalysis(
      // digest-only-ui：显式 off 透传（reader/overview 调用方钉死），每段调用都带
      { provider: makeProvider(), context: makeContext({ subtitleBody: body }), thinkingLevel: "off" },
      { chatCompletion }
    );

    expect(chatCompletion).toHaveBeenCalledTimes(3);
    // 每段一次调用：无显式 retries（重试由池层负责）
    expect(calls.every((c) => c.retries === undefined)).toBe(true);
    // 每段请求都携带 off 档位（协议层据此注入 THINKING_DISABLE_FIELDS）
    expect(calls.every((c) => c.thinkingLevel === "off")).toBe(true);

    const firstUser = calls.find((c) => c.messages.at(-1).content.includes("第 1 / 3 段")).messages.at(-1).content;
    expect(firstUser).toContain("注意：这是长视频切分后的第 1 / 3 段，覆盖 0:00 到 4:10");
    expect(firstUser).toContain("只为这一段产出章节与金句，不要涉及其它时间段");
    expect(firstUser).not.toContain("前情回顾");

    const secondUser = calls.find((c) => c.messages.at(-1).content.includes("第 2 / 3 段")).messages.at(-1).content;
    expect(secondUser).toContain("前情回顾（上一段的结尾，只用来理解本段承接什么，不要为它开章节或挑金句）");
    // 前情回顾只进输入不进输出：maxTokens 估算基于本段正文
    expect(secondUser).toContain("字幕：");

    // 合并：各段章节按 from 排序，金句按文本去重
    expect(result.chapters.map((c) => c.title)).toEqual(["章1a", "章1b", "章2a", "章2b", "章3a", "章3b"]);
    expect(result.chapters[0].from).toBe(5);
    expect(result.quotes.map((q) => q.content)).toEqual(["金句1", "金句2", "金句3"]);
    expect(result.failedRanges).toBeUndefined();
  });

  it("分段路径每段先落盘（boc_lvs_analysis_ 族 + 段序号），再次生成只补未落盘段", async () => {
    const { chatCompletion } = buildCompletionFake();
    const context = makeContext({ subtitleBody: makeSubtitleBody(110000) });
    await mod.runOverviewAnalysis({ provider: makeProvider(), context, forceRefresh: true }, { chatCompletion });
    expect(chatCompletion).toHaveBeenCalledTimes(3);

    const segKeys = [...storage.map.keys()].filter((k) => k.startsWith("boc_lvs_analysis_BV1test_123_"));
    expect(segKeys).toHaveLength(3);
    expect(segKeys.map((k) => Number(k.split("_").at(-1))).sort((a, b) => a - b)).toEqual([1, 2, 3]);

    // 清掉段 2 的落盘 → 重跑只重跑段 2（1、3 命中段缓存）
    const seg2Key = segKeys.find((k) => k.endsWith("_2"));
    storage.map.delete(seg2Key);
    chatCompletion.mockClear();
    await mod.runOverviewAnalysis({ provider: makeProvider(), context, forceRefresh: true }, { chatCompletion });
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(chatCompletion.mock.calls[0][0].messages.at(-1).content).toContain("第 2 / 3 段");
  });
});

// ============================================================
// 部分失败降级（failedRanges）与单次路径失败
// ============================================================

describe("部分失败降级", () => {
  it("分段路径单段失败：跳过该段出部分结果，failedRanges 记录段区间", async () => {
    const { chatCompletion } = buildCompletionFake({ failedSegments: new Set([2]) });
    const result = await mod.runOverviewAnalysis(
      { provider: makeProvider(), context: makeContext({ subtitleBody: makeSubtitleBody(110000) }) },
      { chatCompletion }
    );

    expect(result.chapters.map((c) => c.title)).toEqual(["章1a", "章1b", "章3a", "章3b"]);
    expect(result.failedRanges).toEqual([{ from: 250, to: 500 }]);
    // 部分结果照常落整份缓存（含 failedRanges），重试走 forceRefresh
    const finalKeys = [...storage.map.keys()].filter((k) => k.startsWith("boc_lvs_analysis_final_"));
    expect(finalKeys).toHaveLength(1);
    expect(storage.map.get(finalKeys[0]).analysis.failedRanges).toEqual([{ from: 250, to: 500 }]);
    // 失败段不落段缓存：1、3 段落盘，2 段没有
    const segKeys = [...storage.map.keys()].filter((k) => k.startsWith("boc_lvs_analysis_BV1test_123_"));
    expect(segKeys).toHaveLength(2);
  });

  it("分段路径全军覆没：抛第一个真实错误，不落任何缓存", async () => {
    const { chatCompletion } = buildCompletionFake({ failedSegments: new Set([1, 2, 3]) });
    await expect(
      mod.runOverviewAnalysis(
        { provider: makeProvider(), context: makeContext({ subtitleBody: makeSubtitleBody(110000) }) },
        { chatCompletion }
      )
    ).rejects.toThrow("段 1 生成失败");
    expect(storage.map.size).toBe(0);
  });

  it("单次路径失败：抛错由调用方处理，不落缓存", async () => {
    const chatCompletion = vi.fn(async () => {
      throw new Error("HTTP 401: key 无效");
    });
    await expect(
      mod.runOverviewAnalysis(
        { provider: makeProvider(), context: makeContext({ subtitleBody: makeSubtitleBody(50000) }) },
        { chatCompletion }
      )
    ).rejects.toThrow("HTTP 401");
    expect(storage.map.size).toBe(0);
  });

  it("模型产出全被校验丢弃（空产物）：抛空产物错误", async () => {
    const chatCompletion = vi.fn(async () => JSON.stringify({ chapters: [], keyQuotes: [] }));
    await expect(
      mod.runOverviewAnalysis(
        { provider: makeProvider(), context: makeContext({ subtitleBody: makeSubtitleBody(50000) }) },
        { chatCompletion }
      )
    ).rejects.toThrow("模型没有产出有效的章节或金句");
  });

  it("无字幕：直接抛错，不发起调用", async () => {
    const chatCompletion = vi.fn();
    await expect(
      mod.runOverviewAnalysis({ provider: makeProvider(), context: makeContext({ subtitleBody: [] }) }, { chatCompletion })
    ).rejects.toThrow("没有可用的字幕");
    expect(chatCompletion).not.toHaveBeenCalled();
  });
});

// ============================================================
// 自带章节短路径
// ============================================================

describe("自带章节短路径", () => {
  it("chapters 非空：只跑金句挑选调用（短提示词），章节取稿件标题，产物与 AI 分章同构", async () => {
    const { chatCompletion, calls } = buildCompletionFake();
    const body = makeSubtitleBody(50000);
    const chapters = [
      { from: 0, to: 100, title: "开场" },
      { from: 100, to: 300, title: "正题" }
    ];
    const result = await mod.runOverviewAnalysis(
      { provider: makeProvider(), context: makeContext({ subtitleBody: body, chapters }) },
      { chatCompletion }
    );

    expect(chatCompletion).toHaveBeenCalledTimes(1);
    const system = calls[0].messages[0].content;
    // 短提示词：金句规则 + ASR 纠错段，无分章要求、无概述产出
    expect(system).toContain("为它挑选金句");
    expect(system).toContain("自动语音识别（ASR）生成的字幕");
    expect(system).not.toContain("产出一份结构化概览：章节 + 金句");
    expect(system).not.toContain('"chapters"');
    // 用户提示词无「后段门槛」（章节不由模型产出）
    expect(calls[0].messages.at(-1).content).not.toContain("后段门槛");

    // 产物同构：章节取稿件标题 + 金句归位
    expect(result.chapters).toEqual([
      { from: 0, to: 100, title: "开场", summary: "" },
      { from: 100, to: 300, title: "正题", summary: "" }
    ]);
    expect(result.quotes).toEqual([{ from: 10, content: "金句1" }]);
    expect(Object.keys(result).sort()).toEqual(["chapters", "quotes"]);
  });

  it("短路径分段（>100k + 自带章节）：每段只挑金句，章节仍取稿件，合并后同构", async () => {
    const { chatCompletion, calls } = buildCompletionFake();
    const chapters = [
      { from: 0, to: 250, title: "上半" },
      { from: 250, to: 550, title: "下半" }
    ];
    const result = await mod.runOverviewAnalysis(
      { provider: makeProvider(), context: makeContext({ subtitleBody: makeSubtitleBody(110000), chapters }) },
      { chatCompletion }
    );

    expect(chatCompletion).toHaveBeenCalledTimes(3);
    expect(calls.every((c) => c.messages[0].content.includes("为它挑选金句"))).toBe(true);
    const secondUser = calls.find((c) => c.messages.at(-1).content.includes("第 2 / 3 段")).messages.at(-1).content;
    expect(secondUser).toContain("只为这一段挑选金句，不要涉及其它时间段");
    expect(secondUser).toContain("前情回顾（上一段的结尾，只用来理解本段承接什么，不要从中挑金句）");
    expect(result.chapters).toEqual([
      { from: 0, to: 250, title: "上半", summary: "" },
      { from: 250, to: 550, title: "下半", summary: "" }
    ]);
    expect(result.quotes.map((q) => q.content)).toEqual(["金句1", "金句2", "金句3"]);
  });
});

// ============================================================
// 缓存：整份结果键含签名，换签名 miss
// ============================================================

describe("缓存键与签名", () => {
  it("整份结果键 = boc_lvs_analysis_final_ + bvid_cid_轨道_签名；命中后不再调用模型", async () => {
    const { chatCompletion, calls } = buildCompletionFake();
    const context = makeContext({ subtitleBody: makeSubtitleBody(50000) });
    const first = await mod.runOverviewAnalysis({ provider: makeProvider(), context }, { chatCompletion });

    const finalKeys = [...storage.map.keys()].filter((k) => k.startsWith("boc_lvs_analysis_final_"));
    expect(finalKeys).toHaveLength(1);
    // 键形：前缀_bvid_cid_轨道sourceKey_签名（轨道走 id_ 分支）
    expect(finalKeys[0]).toMatch(/^boc_lvs_analysis_final_BV1test_123_id_sub-1_sig[0-9a-z]+$/);
    // 换轨 → source key 变 → 键变
    const otherTrack = mod.buildAnalysisFinalCacheKey(makeContext({ selectedSubtitleId: "sub-2" }), "sigX");
    expect(otherTrack).not.toBe(finalKeys[0]);
    expect(otherTrack).toContain("id_sub-2");

    chatCompletion.mockClear();
    const second = await mod.runOverviewAnalysis({ provider: makeProvider(), context }, { chatCompletion });
    expect(chatCompletion).not.toHaveBeenCalled();
    expect(second).toEqual(first);
  });

  it("换签名（字幕重抓，条数/时间戳变化）→ 键变 → miss 重跑", async () => {
    const { chatCompletion } = buildCompletionFake();
    const context = makeContext({ subtitleBody: makeSubtitleBody(50000) });
    await mod.runOverviewAnalysis({ provider: makeProvider(), context }, { chatCompletion });
    chatCompletion.mockClear();

    // 同轨道不同内容（多一条字幕 → 条数与末尾时间戳变化 → 签名变）
    const refetched = makeContext({
      subtitleBody: [...makeSubtitleBody(50000), { from: 300, to: 305, content: "新补的结尾" }]
    });
    await mod.runOverviewAnalysis({ provider: makeProvider(), context: refetched }, { chatCompletion });
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    // 两份产物各占一个键
    expect([...storage.map.keys()].filter((k) => k.startsWith("boc_lvs_analysis_final_"))).toHaveLength(2);
  });

  it("buildSubtitleSignature：确定性、随来源/条数/首末时间戳/文本量变化", () => {
    const base = { lang: "zh-CN", subtitleId: "sub-1", body: makeSubtitleBody(3000) };
    const sig = mod.buildSubtitleSignature(base);
    expect(sig).toBe(mod.buildSubtitleSignature({ ...base })); // 确定性
    expect(sig).toMatch(/^sig[0-9a-z]+$/);
    expect(mod.buildSubtitleSignature({ ...base, subtitleId: "sub-2" })).not.toBe(sig); // 换轨
    expect(mod.buildSubtitleSignature({ ...base, body: makeSubtitleBody(3000, 500) })).not.toBe(sig); // 条数变
    expect(mod.buildSubtitleSignature({ ...base, body: [...base.body, { from: 20, to: 25, content: "x" }] })).not.toBe(sig);
    expect(mod.buildSubtitleSignature({ ...base, body: makeSubtitleBody(3001) })).not.toBe(sig); // 文本量变
    // 空体也给出确定签名
    expect(mod.buildSubtitleSignature({ body: [] })).toBe(mod.buildSubtitleSignature({ body: [] }));
  });

  it("分段缓存键复用 segment-cache 键位形状：boc_lvs_analysis_ 前缀 + _b50 预算代继承", async () => {
    const segmentCacheMod = await import("../../extension/ai/segment-cache.js");
    const context = makeContext();
    const key = mod.buildAnalysisSegmentCacheKey(context, 3);
    expect(key).toBe("boc_lvs_analysis_BV1test_123_id_sub-1_3");
    // 预算代后缀与 boc_lvs_summary_ 同规则
    expect(mod.buildAnalysisSegmentCacheKey(context, 3, 0.5)).toBe("boc_lvs_analysis_BV1test_123_id_sub-1_3_b50");
    expect(mod.buildAnalysisSegmentCacheKey(context, 3, 1)).toBe(key);
    // 与分段小结键同形不同族（产物不共享、键位机制共享）
    expect(key).toBe("boc_lvs_analysis_BV1test_123_id_sub-1_3");
    expect(segmentCacheMod.getSegmentSummaryKey({ bvid: "BV1test", cid: "123", subtitleId: "sub-1", segmentIndex: 3 })).toBe(
      "boc_lvs_summary_BV1test_123_id_sub-1_3"
    );
  });
});

// ============================================================
// 生成编排：promise 复用去重、成本护栏、进度
// ============================================================

describe("promise 复用去重", () => {
  it("同视频生成中重复触发：共享同一进行中 promise，模型只调用一次", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const chatCompletion = vi.fn(async () => {
      await gate;
      return JSON.stringify({
        summary: "概述。",
        chapters: [{ title: "章1", timestampSeconds: 5, summary: "甲" }],
        keyQuotes: [{ quote: "金句1", timestampSeconds: 30 }]
      });
    });
    const context = makeContext({ subtitleBody: makeSubtitleBody(50000) });
    const args = { provider: makeProvider(), context };

    const p1 = mod.runOverviewAnalysis(args, { chatCompletion });
    const p2 = mod.runOverviewAnalysis(args, { chatCompletion });
    expect(p2).toBe(p1); // 复用进行中的 promise（同一引用）
    // 等 worker 完成缓存读取、发起模型调用（fake 挂起在 gate 上）
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chatCompletion).toHaveBeenCalledTimes(1);

    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
    expect(chatCompletion).toHaveBeenCalledTimes(1);

    // 落定后再触发：读缓存，不走生成
    expect(mod.runOverviewAnalysis(args, { chatCompletion })).resolves.toEqual(r1);
    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });

  it("失败的生成 promise 落定后移除：下次触发可重试（清缓存重跑）", async () => {
    let calls = 0;
    const chatCompletion = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("第一次失败");
      }
      return JSON.stringify({
        summary: "概述。",
        chapters: [{ title: "章1", timestampSeconds: 5 }],
        keyQuotes: []
      });
    });
    const args = { provider: makeProvider(), context: makeContext({ subtitleBody: makeSubtitleBody(50000) }) };
    await expect(mod.runOverviewAnalysis(args, { chatCompletion })).rejects.toThrow("第一次失败");
    const result = await mod.runOverviewAnalysis(args, { chatCompletion });
    expect(result.chapters).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("forceRefresh 不去重也不读整份缓存，但分段缓存仍复用", async () => {
    const { chatCompletion } = buildCompletionFake();
    const context = makeContext({ subtitleBody: makeSubtitleBody(50000) });
    await mod.runOverviewAnalysis({ provider: makeProvider(), context }, { chatCompletion });
    chatCompletion.mockClear();
    // forceRefresh：跳过整份缓存重跑，模型再次调用
    await mod.runOverviewAnalysis({ provider: makeProvider(), context, forceRefresh: true }, { chatCompletion });
    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });
});

describe("成本护栏与进度", () => {
  function guardContext() {
    // 5 段 50k = 250k 字符 → 分段 5 次 ≥ COST_GUARD_MIN_CALLS
    return makeContext({ subtitleBody: makeSubtitleBody(250000) });
  }

  it("分段路径预估 ≥5 次调用且注入 askCostGuard：拒绝时抛 cancelled 标记错误", async () => {
    const { chatCompletion } = buildCompletionFake();
    const askCostGuard = vi.fn(async () => false);
    await expect(
      mod.runOverviewAnalysis({ provider: makeProvider(), context: guardContext() }, { chatCompletion, askCostGuard })
    ).rejects.toMatchObject({ cancelled: true });
    expect(askCostGuard).toHaveBeenCalledTimes(1);
    expect(askCostGuard.mock.calls[0][0]).toContain("可取消");
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it("askCostGuard 未注入：不阻塞直接生成（护栏 UI 接线由集成步骤负责）", async () => {
    const { chatCompletion } = buildCompletionFake();
    const result = await mod.runOverviewAnalysis({ provider: makeProvider(), context: guardContext() }, { chatCompletion });
    expect(result.chapters.length).toBeGreaterThan(0);
  });

  it("分段完成触发 onProgress（序号/百分比对齐 buildProgressNotice）", async () => {
    const { chatCompletion } = buildCompletionFake();
    const onProgress = vi.fn();
    await mod.runOverviewAnalysis(
      { provider: makeProvider(), context: makeContext({ subtitleBody: makeSubtitleBody(110000) }) },
      { chatCompletion, onProgress }
    );
    expect(onProgress.mock.calls.map(([n]) => n).sort()).toEqual([
      "正在整理第 1/3 段（33%）",
      "正在整理第 2/3 段（67%）",
      "正在整理第 3/3 段（100%）"
    ]);
  });
});

// ============================================================
// 纯函数：mergeAnalyses / groupQuotesIntoChapters / buildAnalysisPrompt
// ============================================================

describe("mergeAnalyses 秒级去重与拼接", () => {
  it("相邻段边界同秒章节去重（保留先到段）、金句按文本去重", () => {
    const merged = mod.mergeAnalyses([
      {
        chapters: [
          { from: 10, to: 100, title: "章A", summary: "a" },
          { from: 100, to: 200, title: "章B", summary: "b" }
        ],
        quotes: [{ from: 30, content: "金句X" }]
      },
      {
        chapters: [
          { from: 100, to: 250, title: "章B重复", summary: "b2" },
          { from: 200, to: 300, title: "章C", summary: "c" }
        ],
        quotes: [
          { from: 220, content: "金句X" },
          { from: 240, content: "金句Y" }
        ]
      }
    ]);
    expect(merged.chapters.map((c) => c.title)).toEqual(["章A", "章B", "章C"]);
    expect(merged.quotes.map((q) => q.content)).toEqual(["金句X", "金句Y"]);
    expect(merged.chapters.map((c) => c.from)).toEqual([10, 100, 200]);
  });

  it("空入参 / null part 容错", () => {
    expect(mod.mergeAnalyses([])).toEqual({ chapters: [], quotes: [] });
    expect(mod.mergeAnalyses([null, undefined, {}])).toEqual({ chapters: [], quotes: [] });
  });
});

describe("groupQuotesIntoChapters 归章", () => {
  const chapters = [
    { from: 0, to: 100, title: "章一", summary: "" },
    { from: 100, to: 200, title: "章二", summary: "" }
  ];

  it("金句落到最后一个 from ≤ 自己时间戳的章节；第一章之前的归 orphan", () => {
    const { grouped, orphans } = mod.groupQuotesIntoChapters(chapters, [
      { from: 50, content: "甲" },
      { from: 100, content: "乙" }, // 恰在章二起点 → 归章二
      { from: 150, content: "丙" },
      { from: 0, content: "丁" } // 章一起点 → 归章一
    ]);
    expect(grouped[0].quotes.map((q) => q.content)).toEqual(["甲", "丁"]);
    expect(grouped[1].quotes.map((q) => q.content)).toEqual(["乙", "丙"]);
    expect(orphans).toEqual([]);
  });

  it("无章节 / 金句早于首章：orphan 带回", () => {
    const empty = mod.groupQuotesIntoChapters([], [{ from: 10, content: "甲" }]);
    expect(empty.grouped).toEqual([]);
    expect(empty.orphans.map((q) => q.content)).toEqual(["甲"]);

    const withOrphan = mod.groupQuotesIntoChapters([{ from: 100, to: 200, title: "章二", summary: "" }], [
      { from: 10, content: "早" },
      { from: 150, content: "中" }
    ]);
    expect(withOrphan.orphans.map((q) => q.content)).toEqual(["早"]);
    expect(withOrphan.grouped[0].quotes.map((q) => q.content)).toEqual(["中"]);
  });
});

// ============================================================
// 现成章节目录（简介/评论时间戳目录 → 章节边界照抄）
// ============================================================

describe("parseChapterOutline 简介/评论时间戳目录解析", () => {
  it("标准「00:00 标题」行：秒数正确、按秒排序、重复秒数去重", () => {
    const outline = mod.parseChapterOutline(
      [
        "03:25 安装与配置",
        "00:00 开场",
        "12:00 进阶用法",
        "3:25 安装（重复秒数，丢弃）"
      ].join("\n")
    );
    expect(outline).toEqual([
      { seconds: 0, title: "开场" },
      { seconds: 205, title: "安装与配置" },
      { seconds: 720, title: "进阶用法" }
    ]);
  });

  it("容忍列表符号 / 引用 / 带序号行、H:MM:SS 与全角间隔", () => {
    const text = [
      "- 00:00 开场",
      "> 01:30 背景介绍",
      "1) 02:00 准备工作",
      "1:02:03 长视频章节",
      "04:00・收尾"
    ].join("\n");
    const outline = mod.parseChapterOutline(text);
    expect(outline).toEqual([
      { seconds: 0, title: "开场" },
      { seconds: 90, title: "背景介绍" },
      { seconds: 120, title: "准备工作" },
      { seconds: 240, title: "收尾" },
      { seconds: 3723, title: "长视频章节" }
    ]);
  });

  it("纯时间戳行 / 字幕式 [M:SS] / 单条目录 / 普通文本：不算现成划分", () => {
    expect(mod.parseChapterOutline("00:00\n01:30\n02:00")).toEqual([]); // 无标题
    expect(mod.parseChapterOutline("[00:00] 开场 [01:30] 正文")).toEqual([]); // 行首非时间戳
    expect(mod.parseChapterOutline("00:00 只有单条")).toEqual([]); // 单条不构成划分
    expect(mod.parseChapterOutline("这是一段没有任何时间戳的普通简介。")).toEqual([]);
    expect(mod.parseChapterOutline("")).toEqual([]);
    expect(mod.parseChapterOutline(null)).toEqual([]);
  });

  it("正文里夹带的时间戳词组不误判：只认「时间戳 + 空白 + 文字」的行", () => {
    expect(mod.parseChapterOutline("视频从 00:00 开始讲起")).toEqual([]);
    expect(mod.parseChapterOutline("参考 3:25 处的演示和 10:00 的总结")).toEqual([]);
  });

  it("章节数按 MAX_ANALYSIS_CHAPTERS 裁剪", () => {
    const lines = Array.from({ length: 120 }, (_, i) => `${String(i).padStart(2, "0")}:00 第${i}章`);
    expect(mod.parseChapterOutline(lines.join("\n"))).toHaveLength(mod.MAX_ANALYSIS_CHAPTERS);
  });
});

describe("buildAnalysisPrompt 现成目录注入", () => {
  const outline = [
    { seconds: 0, title: "开场" },
    { seconds: 205, title: "安装与配置" }
  ];

  it("有目录：注入「现成章节目录」块与照抄约束；无目录：不注入", () => {
    const withOutline = mod.buildAnalysisPrompt({
      items: [{ from: 0, to: 10, content: "开场白" }],
      chapterOutline: outline
    });
    expect(withOutline.prompt).toContain("现成章节目录（来自视频简介/评论，共 2 章）：");
    expect(withOutline.prompt).toContain("0:00 开场");
    expect(withOutline.prompt).toContain("3:25 安装与配置");
    expect(withOutline.prompt).toContain("章节边界与标题必须完全照抄这份目录");

    const without = mod.buildAnalysisPrompt({
      items: [{ from: 0, to: 10, content: "开场白" }]
    });
    expect(without.prompt).not.toContain("现成章节目录");
    expect(without.prompt).not.toContain("照抄这份目录");
  });

  it("空目录 / undefined：同样不注入（模板行塌缩为空行）", () => {
    const empty = mod.buildAnalysisPrompt({
      items: [{ from: 0, to: 10, content: "开场白" }],
      chapterOutline: []
    });
    expect(empty.prompt).not.toContain("现成章节目录");
  });
});

describe("buildSubtitleSignature 现成目录模式位", () => {
  const base = { lang: "zh-CN", subtitleId: "sub-1", body: makeSubtitleBody(3000) };
  const outline = [
    { seconds: 0, title: "开场" },
    { seconds: 90, title: "正文" }
  ];

  it("目录出现/消失/换内容 → 签名变化；同目录确定性一致", () => {
    const sig = mod.buildSubtitleSignature(base);
    const withOutline = mod.buildSubtitleSignature({ ...base, chapterOutline: outline });
    expect(withOutline).not.toBe(sig);
    expect(mod.buildSubtitleSignature({ ...base, chapterOutline: outline })).toBe(withOutline); // 确定性
    expect(
      mod.buildSubtitleSignature({ ...base, chapterOutline: [...outline, { seconds: 200, title: "结尾" }] })
    ).not.toBe(withOutline); // 换目录
  });
});

describe("双路径 × 现成章节目录（简介/评论）", () => {
  it("单次路径：简介含时间戳目录 → 注入 prompt；无目录 → 走自由分章（不注入）", async () => {
    const { chatCompletion, calls } = buildCompletionFake();
    const body = makeSubtitleBody(50000);
    const description = "时间轴：\n00:00 开场\n03:25 安装与配置\n12:00 进阶用法";
    await mod.runOverviewAnalysis(
      { provider: makeProvider(), context: makeContext({ subtitleBody: body, videoDescription: description }) },
      { chatCompletion }
    );
    const user = calls[0].messages.at(-1).content;
    expect(user).toContain("现成章节目录（来自视频简介/评论，共 3 章）：");
    expect(user).toContain("0:00 开场");
    expect(user).toContain("3:25 安装与配置");

    // 同一视频、无目录：不注入（现状自由分章行为不变）
    chatCompletion.mockClear();
    await mod.runOverviewAnalysis(
      { provider: makeProvider(), context: makeContext({ subtitleBody: body, videoDescription: "普通简介，无目录" }), forceRefresh: true },
      { chatCompletion }
    );
    expect(chatCompletion.mock.calls[0][0].messages.at(-1).content).not.toContain("现成章节目录");
  });

  it("评论含时间戳目录：热评 message 参与解析注入（与简介合并去重）", async () => {
    const { chatCompletion, calls } = buildCompletionFake();
    const body = makeSubtitleBody(50000);
    await mod.runOverviewAnalysis(
      {
        provider: makeProvider(),
        context: makeContext({
          subtitleBody: body,
          hotComments: [
            { uname: "UP", like: 999, message: "本课时间线：\n00:00 开场\n05:00 数据结构\n10:00 算法实战" },
            { uname: "路人", like: 3, message: "讲得真好" }
          ]
        })
      },
      { chatCompletion }
    );
    const user = calls[0].messages.at(-1).content;
    expect(user).toContain("现成章节目录（来自视频简介/评论，共 3 章）：");
    expect(user).toContain("5:00 数据结构");
  });

  it("分段路径：目录注入每段提示词（各段只对落在本段区间的目录条目出章）", async () => {
    const { chatCompletion, calls } = buildCompletionFake();
    const body = makeSubtitleBody(110000); // 3 段
    const description = "00:00 开场\n00:10 第一节\n04:20 第二节\n08:30 第三节";
    await mod.runOverviewAnalysis(
      { provider: makeProvider(), context: makeContext({ subtitleBody: body, videoDescription: description }) },
      { chatCompletion }
    );
    expect(chatCompletion).toHaveBeenCalledTimes(3);
    for (const call of calls) {
      expect(call.messages.at(-1).content).toContain("现成章节目录（来自视频简介/评论，共 4 章）：");
    }
  });
});

describe("buildAnalysisPrompt 变量装配", () => {
  it("后段门槛 = 75% 处、起止时刻与秒数同源、简介缺省兜底", () => {
    const body = [
      { from: 0, to: 10, content: "开场白" },
      { from: 200, to: 210, content: "收尾" }
    ];
    const { prompt, timing, transcriptChars } = mod.buildAnalysisPrompt({
      title: "标题",
      ownerName: "UP",
      items: body,
      videoDuration: 400,
      startSeconds: 0,
      segmentIndex: 1,
      totalSegments: 1
    });
    expect(timing.maxTimestampSeconds).toBe(400);
    expect(timing.lateThreshold).toBe("5:00"); // floor(400*0.75)
    expect(prompt).toContain("本次字幕从 0:00（第 0 秒）到 6:40（第 400 秒）");
    expect(prompt).toContain("视频简介（用它来校正人名、品牌名与术语的写法）：\n（无简介）");
    expect(prompt).toContain("[0:00] 开场白");
    expect(prompt).toContain("[3:20] 收尾");
    expect(transcriptChars).toBe("[0:00] 开场白\n[3:20] 收尾".length);
  });

  it("时长缺失取字幕末条时间戳兜底；rangeNote 仅多段时出现；contextNote 含上一段结尾", () => {
    const body = [
      { from: 60, to: 70, content: "甲" },
      { from: 100, to: 110, content: "乙" }
    ];
    const single = mod.buildAnalysisPrompt({ items: body, videoDuration: undefined });
    expect(single.timing.maxTimestampSeconds).toBe(110);
    expect(single.prompt).not.toContain("长视频切分后");
    expect(single.prompt).not.toContain("前情回顾");

    const segmented = mod.buildAnalysisPrompt({
      items: body,
      videoDuration: 110,
      startSeconds: 60,
      segmentIndex: 2,
      totalSegments: 3
    });
    expect(segmented.prompt).toContain("注意：这是长视频切分后的第 2 / 3 段，覆盖 1:00 到 1:50。只为这一段产出章节与金句，不要涉及其它时间段。");

    const withContext = mod.buildAnalysisPrompt({
      items: body,
      videoDuration: 110,
      startSeconds: 60,
      segmentIndex: 2,
      totalSegments: 3,
      contextItems: [{ from: 40, to: 50, content: "上一段结尾" }]
    });
    expect(withContext.prompt).toContain("前情回顾（上一段的结尾，只用来理解本段承接什么，不要为它开章节或挑金句）：\n[0:40] 上一段结尾");
  });
});
