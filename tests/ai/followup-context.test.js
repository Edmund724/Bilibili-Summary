// ai/followup-context.js 追问上下文压缩测试（05 票）：
// 覆盖首轮回退（尚未成稿仍用原始字幕全文、不误切压缩上下文）、压缩摘要组装
// （分段小结 + 成稿笔记、不含原始字幕全文）、token 随追问近乎常数、
// verbatim 保留（压缩摘要保留小结与笔记原文）、检索注入（命中拼「相关原始字幕段」尾部 /
// 未命中与缺省不含），以及 hasFinalNote / buildCompactedSummary 的边界（空入参、maxChars 截断尾部）。

import { describe, expect, it } from "vitest";
import {
  RECENT_TURNS_DEFAULT,
  RAW_INJECTION_MAX_CHARS,
  SEGMENT_SUMMARIES_MAX_CHARS,
  hasFinalNote,
  trimRecentTurns,
  buildCompactedSummary,
  buildFollowupSubtitleMarkdown
} from "../../extension/ai/followup-context.js";

// 构造 contextData：原始字幕体（subtitleBody）只含一条正文为整篇 markdown 的
// 条目（关闭时间戳渲染），用于断言压缩后绝不含整篇原始字幕、未成稿回退输出与
// body 内容逐字一致。
function makeContext(markdown) {
  return {
    title: "测试视频",
    subtitleBody: markdown ? [{ from: 0, to: 1, content: markdown }] : [],
    includeTimestampInBody: false
  };
}

// 全文独有的段落：只存在于原始字幕全文，任何压缩结果都不应包含它。
const UNIQUE_RAW_MARKER = "这个段落只属于原始字幕全文，压缩摘要绝不该出现";

function makeUniqueMarkdown(length) {
  return "a".repeat(length) + "\n\n" + UNIQUE_RAW_MARKER + "\n\n" + "b".repeat(length);
}

describe("hasFinalNote：首轮 / 尚未成稿判定", () => {
  it("空入参 → false", () => {
    expect(hasFinalNote()).toBe(false);
    expect(hasFinalNote({})).toBe(false);
  });

  it("只有 note 或只有 segmentSummaries → false（缺一即未成稿）", () => {
    expect(hasFinalNote({ note: "成稿笔记" })).toBe(false);
    expect(hasFinalNote({ segmentSummaries: ["小结一"] })).toBe(false);
  });

  it("note 为空白串 / summaries 空数组 / 非数组 → false", () => {
    expect(hasFinalNote({ note: "   ", segmentSummaries: ["小结一"] })).toBe(false);
    expect(hasFinalNote({ note: "笔记", segmentSummaries: [] })).toBe(false);
    expect(hasFinalNote({ note: "笔记", segmentSummaries: "小结一" })).toBe(false);
  });

  it("note 非空 + 非空 summaries → true（已「成稿」）", () => {
    expect(hasFinalNote({ note: "笔记", segmentSummaries: ["小结一"] })).toBe(true);
  });
});

describe("buildCompactedSummary：组装与边界", () => {
  it("空入参 / 空小结与空笔记 → 空串", () => {
    expect(buildCompactedSummary()).toBe("");
    expect(buildCompactedSummary({ segmentSummaries: [], note: "" })).toBe("");
  });

  it("只有小结 → 含「## 分段小结」与各小结小标题+正文；不含成稿笔记节", () => {
    const out = buildCompactedSummary({ segmentSummaries: ["小结A内容", "小结B内容"] });
    expect(out).toContain("## 分段小结");
    expect(out).toContain("### 片段 1\n小结A内容");
    expect(out).toContain("### 片段 2\n小结B内容");
    expect(out).not.toContain("## 成稿笔记");
  });

  it("只有笔记 → 只含成稿笔记节，保留笔记原文", () => {
    const out = buildCompactedSummary({ note: "笔记原文XYZ" });
    expect(out).toContain("## 成稿笔记\n\n笔记原文XYZ");
    expect(out).not.toContain("## 分段小结");
  });

  it("小结 + 笔记齐备 → 分段小结在前、成稿笔记在后，均保留原文（verbatim）", () => {
    const note = "成稿笔记：第一段要点。\n第二行要点。";
    const summaries = ["小结一：事实A（时间点 09:15）。", "小结二：事实B。"];
    const out = buildCompactedSummary({ segmentSummaries: summaries, note });
    expect(out.indexOf("## 分段小结")).toBeLessThan(out.indexOf("## 成稿笔记"));
    expect(out).toContain(note);
    expect(out).toContain(summaries[0]);
    expect(out).toContain(summaries[1]);
  });

  it("maxChars 截断尾部：结果 ≤ maxChars、含截断标记、保留头部", () => {
    const note = "N".repeat(1000);
    const out = buildCompactedSummary({ note, maxChars: 100 });
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).toContain("已截断尾部");
    expect(out.startsWith("## 成稿笔记\n\n")).toBe(true);
    expect(out).not.toContain(note); // 尾部被截断，笔记全文不再完整
  });

  it("maxChars 极小（≤ 截断标记长度）时仍不超限", () => {
    const out = buildCompactedSummary({ note: "x".repeat(500), maxChars: 5 });
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it("分段小结独立上限：小结部分 ≤ SEGMENT_SUMMARIES_MAX_CHARS，笔记不随其截断", () => {
    const note = "N".repeat(200);
    const summaries = Array.from({ length: 10 }, () => "S".repeat(8000)); // 合计 80000 > 40000
    const out = buildCompactedSummary({ segmentSummaries: summaries, note });
    const summariesEnd = out.indexOf("## 成稿笔记");
    // 「## 分段小结」到「## 成稿笔记」之间的小结节（含小标题与换行）受独立上限约束
    const summariesSpan = summariesEnd - out.indexOf("## 分段小结");
    expect(summariesSpan).toBeLessThanOrEqual(SEGMENT_SUMMARIES_MAX_CHARS + 100);
    // 笔记部分完整保留，不受小结截断影响
    expect(out).toContain(note);
  });

  it("非数组 segmentSummaries 容错为空", () => {
    expect(buildCompactedSummary({ segmentSummaries: "小结一" })).toBe("");
    expect(buildCompactedSummary({ segmentSummaries: null, note: "笔记" })).toContain("## 成稿笔记");
  });
});

describe("buildFollowupSubtitleMarkdown：首轮回退", () => {
  const markdown = makeUniqueMarkdown(200);

  it("note 空 / segmentSummaries 空 → 返回由 subtitleBody 渲染的原始字幕全文", () => {
    // 渲染收口：单条字幕体的全文按「## 字幕」分节输出，正文与原文逐字一致。
    const rendered = "## 字幕\n\n" + markdown;
    expect(buildFollowupSubtitleMarkdown({ contextData: makeContext(markdown) })).toBe(rendered);
    expect(buildFollowupSubtitleMarkdown({ contextData: makeContext(markdown), note: "笔记" })).toBe(rendered);
    expect(
      buildFollowupSubtitleMarkdown({ contextData: makeContext(markdown), segmentSummaries: ["小结一"] })
    ).toBe(rendered);
  });

  it("首轮无字幕 → 返回空串", () => {
    expect(buildFollowupSubtitleMarkdown({ contextData: {} })).toBe("");
  });

  it("尚未成稿即使检索命中也不误切压缩上下文（仍用原始字幕全文）", () => {
    const out = buildFollowupSubtitleMarkdown({
      contextData: makeContext(markdown),
      note: null,
      segmentSummaries: null,
      userPrompt: "09:15 讲了什么",
      retrieveRaw: () => ["检索原始段"]
    });
    expect(out).toBe("## 字幕\n\n" + markdown);
    expect(out).not.toContain("## 相关原始字幕段");
  });
});

describe("buildFollowupSubtitleMarkdown：压缩组装", () => {
  it("已成稿 → 结果含笔记全文、各分段小结，绝不含原始字幕全文独有的段落", () => {
    const markdown = makeUniqueMarkdown(20000);
    const note = "成稿笔记全文：观点1、观点2。";
    const summaries = ["小结一：事实A。", "小结二：事实B。"];
    const out = buildFollowupSubtitleMarkdown({
      contextData: makeContext(markdown),
      note,
      segmentSummaries: summaries
    });
    expect(out).toContain(note);
    expect(out).toContain(summaries[0]);
    expect(out).toContain(summaries[1]);
    expect(out).toContain("## 分段小结");
    expect(out).toContain("## 成稿笔记");
    expect(out).not.toContain(UNIQUE_RAW_MARKER);
    expect(out).not.toContain("以下是视频的字幕全文");
  });
});

describe("buildFollowupSubtitleMarkdown：token 随追问近乎常数", () => {
  it("1 万与 100 万字符原始字幕，已成稿时返回长度相同且远小于原始字幕", () => {
    const note = "成稿笔记";
    const summaries = ["小结一：事实A。", "小结二：事实B。"];
    const short = buildFollowupSubtitleMarkdown({
      contextData: makeContext(makeUniqueMarkdown(10000)),
      note,
      segmentSummaries: summaries
    });
    const long = buildFollowupSubtitleMarkdown({
      contextData: makeContext(makeUniqueMarkdown(1000000)),
      note,
      segmentSummaries: summaries
    });
    // 压缩摘要只由小结 + 笔记组成，与原始字幕长度无关 → 长度完全一致
    expect(short.length).toBe(long.length);
    // 都 ≤ 有界上限（默认 maxChars 60k + 松弛），且远小于 100 万
    expect(short.length).toBeLessThanOrEqual(70000);
    expect(short.length).toBeLessThan(1000000);
    expect(long.length).toBeLessThan(1000000);
  });
});

describe("buildFollowupSubtitleMarkdown：verbatim 保留", () => {
  it("压缩摘要保留笔记与小结原文（近 N 轮 verbatim 由 buildMessages 负责，此处只验「摘要保留原文」）", () => {
    const note = "笔记原文：**加粗要点**、`代码`、特殊符号 ①②③。";
    const summaries = ["小结一：原文带时间点 01:09:15。", "小结二：\n多行内容行二。"];
    const out = buildFollowupSubtitleMarkdown({
      contextData: makeContext("x".repeat(5000)),
      note,
      segmentSummaries: summaries
    });
    expect(out).toContain("笔记原文：**加粗要点**、`代码`、特殊符号 ①②③。");
    expect(out).toContain("小结一：原文带时间点 01:09:15。");
    expect(out).toContain("小结二：\n多行内容行二。");
    expect(RECENT_TURNS_DEFAULT).toBe(6);
  });
});

describe("buildFollowupSubtitleMarkdown：检索注入", () => {
  const note = "成稿笔记";
  const summaries = ["小结一：事实A。"];
  const markdown = makeUniqueMarkdown(5000);

  it("命中 → 尾部含「## 相关原始字幕段」与注入的原始段文本，压缩摘要在前", () => {
    const out = buildFollowupSubtitleMarkdown({
      contextData: makeContext(markdown),
      note,
      segmentSummaries: summaries,
      userPrompt: "09:15 讲了什么",
      retrieveRaw: () => ["检索原始段A", "检索原始段B"]
    });
    expect(out.indexOf("## 相关原始字幕段")).toBeGreaterThan(out.indexOf("## 成稿笔记"));
    expect(out).toContain("## 相关原始字幕段");
    expect(out).toContain("检索原始段A");
    expect(out).toContain("检索原始段B");
    // 仍是压缩上下文：不含原始字幕全文独有的段落
    expect(out).not.toContain(UNIQUE_RAW_MARKER);
  });

  it("未命中（返回 []）→ 不含「相关原始字幕段」小节", () => {
    const out = buildFollowupSubtitleMarkdown({
      contextData: makeContext(markdown),
      note,
      segmentSummaries: summaries,
      userPrompt: "随便问问",
      retrieveRaw: () => []
    });
    expect(out).not.toContain("## 相关原始字幕段");
    expect(out).toContain(note);
  });

  it("缺省不注入（retrieveRaw 为 null/非函数）→ 不含该小节", () => {
    const out = buildFollowupSubtitleMarkdown({
      contextData: makeContext(markdown),
      note,
      segmentSummaries: summaries,
      userPrompt: "问"
    });
    expect(out).not.toContain("## 相关原始字幕段");
  });

  it("注入返回含非字符串/空串条目时被过滤，空命中视为未命中", () => {
    const out = buildFollowupSubtitleMarkdown({
      contextData: makeContext(markdown),
      note,
      segmentSummaries: summaries,
      userPrompt: "问",
      retrieveRaw: () => ["有效段", "", 123, null]
    });
    expect(out).toContain("有效段");
    expect(out).not.toContain("123");

    const emptyOut = buildFollowupSubtitleMarkdown({
      contextData: makeContext(markdown),
      note,
      segmentSummaries: summaries,
      userPrompt: "问",
      retrieveRaw: () => ["", null]
    });
    expect(emptyOut).not.toContain("## 相关原始字幕段");
  });
});

describe("trimRecentTurns：近 N 轮 verbatim 封顶", () => {
  it("只保留最近 turns 轮（每轮 user+assistant 两条），超长历史被裁剪", () => {
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `第${i}条`
    }));
    const trimmed = trimRecentTurns(history, 3);
    expect(trimmed).toHaveLength(6);
    expect(trimmed[0]).toEqual({ role: "user", content: "第14条" });
    expect(trimmed[trimmed.length - 1]).toEqual({ role: "assistant", content: "第19条" });
  });

  it("缺省 turns 用 RECENT_TURNS_DEFAULT；历史不足 N 轮时原样返回", () => {
    const short = [
      { role: "user", content: "问" },
      { role: "assistant", content: "答" }
    ];
    expect(trimRecentTurns(short)).toEqual(short);
    expect(trimRecentTurns(short, RECENT_TURNS_DEFAULT)).toEqual(short);
    expect(RECENT_TURNS_DEFAULT).toBe(6);
  });

  it("非法 turns / 非数组历史 → 安全回落", () => {
    const history = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" }
    ];
    expect(trimRecentTurns(history, 0)).toEqual(history);
    expect(trimRecentTurns(history, "x")).toEqual(history);
    expect(trimRecentTurns(null)).toEqual([]);
  });
});

describe("buildFollowupSubtitleMarkdown 检索注入上限", () => {
  const note = "成稿笔记正文。";
  const summaries = ["小结一", "小结二"];

  it("注入总量超过 RAW_INJECTION_MAX_CHARS 时被截断（仍 ≤ 上限，且保留压缩摘要）", () => {
    const bigHit = "d".repeat(RAW_INJECTION_MAX_CHARS + 5000);
    const out = buildFollowupSubtitleMarkdown({
      contextData: makeContext("原始全文标记 __MARK__"),
      note,
      segmentSummaries: summaries,
      userPrompt: "问",
      retrieveRaw: () => [bigHit]
    });
    expect(out).toContain(note);
    expect(out).toContain("## 相关原始字幕段");
    const injectionStart = out.indexOf("## 相关原始字幕段");
    const injection = out.slice(injectionStart + "## 相关原始字幕段".length);
    expect(injection.length).toBeLessThanOrEqual(RAW_INJECTION_MAX_CHARS + 3);
  });

  it("注入在上限内时不截断（原文保留）", () => {
    const hit = "相关原文段内容".repeat(10);
    const out = buildFollowupSubtitleMarkdown({
      contextData: makeContext("原始全文标记 __MARK__"),
      note,
      segmentSummaries: summaries,
      userPrompt: "问",
      retrieveRaw: () => [hit]
    });
    expect(out).toContain(hit);
  });
});
