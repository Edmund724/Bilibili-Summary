// ai/followup-router.js 测试：追问路由——超预算视频总结后追问改走压缩上下文 + 按需检索；
// 首轮 / 尚未成稿 / ≤100k → 返回 null（交给完整 Map-Reduce）。

import { describe, expect, it, vi } from "vitest";
import {
  lastAssistantContent,
  loadSegmentSummaries,
  buildRetrieveRaw,
  resolveFollowupContext
} from "../../extension/ai/followup-router.js";
import { buildBudgetPlan } from "../../extension/ai/budgeter.js";

// 构造 >100k 的 map-reduce plan（3 段）
const body = Array.from({ length: 110 }, (_, i) => ({
  from: i * 5,
  to: i * 5 + 5,
  content: "x".repeat(1000)
}));
const plan = buildBudgetPlan({ body, chapters: [] });

const context = {
  title: "测试视频",
  bvid: "BV1test",
  cid: "123",
  selectedSubtitleId: "sub-1",
  subtitleLang: "zh",
  chapters: [],
  subtitleBody: body
};

const summariesFixture = ["小结一：事实A。", "小结二：事实B。", "小结三：事实C。"];

describe("lastAssistantContent", () => {
  it("取最近一条非空 assistant 正文", () => {
    expect(lastAssistantContent([
      { role: "user", content: "问" },
      { role: "assistant", content: "  第一条回答  " },
      { role: "user", content: "再问" },
      { role: "assistant", content: "最后一条回答" }
    ])).toBe("最后一条回答");
  });

  it("无 assistant / 全空 → 空串", () => {
    expect(lastAssistantContent([])).toBe("");
    expect(lastAssistantContent([{ role: "user", content: "仅提问" }])).toBe("");
    expect(lastAssistantContent([{ role: "assistant", content: "   " }])).toBe("");
  });
});

describe("loadSegmentSummaries", () => {
  it("按段序加载非空小结，注入 loader 生效", async () => {
    const loader = vi.fn(async (key) => (String(key).endsWith("_1") ? "小结一" : null));
    const summaries = await loadSegmentSummaries({ context, plan, loadSummary: loader });
    expect(loader).toHaveBeenCalledTimes(3);
    expect(summaries).toEqual(["小结一"]);
  });

  it("缺省 loader 命中段缓存（无预置数据 → 空）", async () => {
    const summaries = await loadSegmentSummaries({ context, plan });
    expect(summaries).toEqual([]);
  });
});

describe("buildRetrieveRaw", () => {
  it("命中时间戳 → 返回该段渲染文本", () => {
    const segs = [
      { index: 1, from: 0, to: 500, items: [{ from: 0, to: 5, content: "开场内容" }] },
      { index: 2, from: 500, to: 1000, items: [{ from: 500, to: 505, content: "后续内容" }] }
    ];
    const plan2 = { segments: segs };
    const retrieve = buildRetrieveRaw({ context: { chapters: [] }, plan: plan2 });
    // 505s 命中第 2 段
    const hits = retrieve("08:25 那段讲了什么"); // 8*60+25 = 505
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("后续内容");
  });

  it("未命中 → 空数组", () => {
    const retrieve = buildRetrieveRaw({ context: { chapters: [] }, plan: { segments: [] } });
    expect(retrieve("随便问点无关的")).toEqual([]);
  });
});

describe("resolveFollowupContext", () => {
  it("≤100k（mode=single）→ null", async () => {
    const singlePlan = buildBudgetPlan({ body: [{ from: 0, to: 5, content: "短字幕" }], chapters: [] });
    const result = await resolveFollowupContext({
      context,
      plan: singlePlan,
      history: [{ role: "assistant", content: "笔记" }],
      loadSummaries: async () => summariesFixture
    });
    expect(result).toBeNull();
  });

  it("首轮（history 空）→ null", async () => {
    const result = await resolveFollowupContext({
      context,
      plan,
      history: [],
      loadSummaries: async () => summariesFixture
    });
    expect(result).toBeNull();
  });

  it("尚未成稿（无分段小结）→ null", async () => {
    const result = await resolveFollowupContext({
      context,
      plan,
      history: [{ role: "assistant", content: "笔记" }],
      loadSummaries: async () => []
    });
    expect(result).toBeNull();
  });

  it("成稿后追问 → 压缩上下文（含笔记+小结、不含原始全文、subtitleBody 置空）", async () => {
    const result = await resolveFollowupContext({
      context,
      plan,
      history: [{ role: "assistant", content: "# 视频笔记：《测试视频》\n完整笔记正文。" }],
      userPrompt: "再讲讲",
      loadSummaries: async () => summariesFixture
    });
    expect(result).not.toBeNull();
    expect(result.subtitleBody).toEqual([]);
    expect(result.compressedSummaryMarkdown).toContain("完整笔记正文。");
    expect(result.compressedSummaryMarkdown).toContain("小结一：事实A。");
    expect(result.compressedSummaryMarkdown).not.toContain("__RAW_FULL__");
  });

  it("成稿后追问 + 时间戳命中 → 压缩上下文尾部注入相关原始段", async () => {
    const segPlan = {
      ...plan,
      segments: [
        { index: 1, from: 0, to: 500, items: [{ from: 0, to: 5, content: "开场白内容ABC" }] },
        { index: 2, from: 500, to: 1000, items: [{ from: 500, to: 505, content: "后续内容DEF" }] },
        { index: 3, from: 1000, to: 1500, items: [{ from: 1000, to: 1005, content: "结尾内容GHI" }] }
      ]
    };
    const result = await resolveFollowupContext({
      context,
      plan: segPlan,
      history: [{ role: "assistant", content: "完整笔记正文。" }],
      userPrompt: "09:00 那里讲了什么", // 540s → 命中第 2 段
      loadSummaries: async () => summariesFixture
    });
    expect(result.compressedSummaryMarkdown).toContain("## 相关原始字幕段");
    expect(result.compressedSummaryMarkdown).toContain("后续内容DEF");
  });
});
