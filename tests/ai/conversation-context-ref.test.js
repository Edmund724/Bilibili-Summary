// ai/conversation.js 的 AI 上下文 ref 统一构造器测试：
// buildAiContextRef 是原三份手写字段挑选清单（context-resolver 入参归一化 /
// buildConversationContextRef / buildContextPlaceholder）的单一事实来源，
// 15 字段 = 14 个视频身份/字幕轨字段 + chapters。覆盖字段表、bvid 从 url 回落、
// chapters 透传与缺省 undefined、非对象输入兜底，以及 buildContextPlaceholder
// 在构造器结果上补 placeholder 专用字段。

import { describe, expect, it } from "vitest";
import {
  buildAiContextRef,
  buildContextPlaceholder
} from "../../extension/ai/conversation.js";

const FULL_INPUT = {
  title: "  测试视频  ",
  url: "https://www.bilibili.com/video/BV1full/?p=2",
  author: " UP主 ",
  uploadDate: "2026-01-01",
  bvid: "BV1full",
  cid: "101",
  aid: "42",
  pageIndex: 2,
  pageCount: 3,
  pageTitle: "第二P",
  subtitleLang: "zh-CN",
  selectedSubtitleId: "sub-1",
  selectedSubtitleUrl: "https://s.example.com/1.json",
  chapters: [{ title: "开场", from: 0, to: 60 }],
  isVideoContext: true,
  // 挑选清单之外的负载应被丢弃
  subtitleBody: [{ from: 0, to: 5, content: "x" }],
  subtitleMarkdown: "# 不应保留"
};

const EXPECTED_FIELDS = [
  "title",
  "url",
  "author",
  "uploadDate",
  "bvid",
  "cid",
  "aid",
  "pageIndex",
  "pageCount",
  "pageTitle",
  "subtitleLang",
  "selectedSubtitleId",
  "selectedSubtitleUrl",
  "chapters",
  "isVideoContext"
];

describe("buildAiContextRef 字段表（15 字段单一事实来源）", () => {
  it("全字段输入：逐字段归一化（trim/数值），挑选清单外负载不保留", () => {
    const ref = buildAiContextRef(FULL_INPUT);
    expect(Object.keys(ref)).toEqual(EXPECTED_FIELDS);
    expect(ref).toEqual({
      title: "测试视频",
      url: "https://www.bilibili.com/video/BV1full/?p=2",
      author: "UP主",
      uploadDate: "2026-01-01",
      bvid: "BV1full",
      cid: "101",
      aid: "42",
      pageIndex: 2,
      pageCount: 3,
      pageTitle: "第二P",
      subtitleLang: "zh-CN",
      selectedSubtitleId: "sub-1",
      selectedSubtitleUrl: "https://s.example.com/1.json",
      chapters: [{ title: "开场", from: 0, to: 60 }],
      isVideoContext: true
    });
  });

  it("chapters 为数组时原样透传（同引用），消费方可直接用于章节对齐/检索", () => {
    const chapters = [{ title: "开场", from: 0, to: 60 }];
    const ref = buildAiContextRef({ title: "t", chapters });
    expect(ref.chapters).toBe(chapters);
  });

  it("chapters 缺省 → undefined（旧持久化会话 ref 无此字段自然容忍）", () => {
    const ref = buildAiContextRef({ title: "t", bvid: "BV1x" });
    expect(Object.keys(ref)).toEqual(EXPECTED_FIELDS);
    expect(ref.chapters).toBeUndefined();
  });

  it("chapters 为非数组脏值 → undefined（不做半吊子归一化）", () => {
    expect(buildAiContextRef({ title: "t", chapters: "x" }).chapters).toBeUndefined();
    expect(buildAiContextRef({ title: "t", chapters: {} }).chapters).toBeUndefined();
    expect(buildAiContextRef({ title: "t", chapters: null }).chapters).toBeUndefined();
  });

  it("pageIndex/pageCount 非法值回落到 1/0", () => {
    const ref = buildAiContextRef({ title: "t", pageIndex: -1, pageCount: "x" });
    expect(ref.pageIndex).toBe(1);
    expect(ref.pageCount).toBe(0);
  });

  it("isVideoContext 缺省视为 true，显式 false 保留", () => {
    expect(buildAiContextRef({ title: "t" }).isVideoContext).toBe(true);
    expect(buildAiContextRef({ title: "t", isVideoContext: false }).isVideoContext).toBe(false);
  });
});

describe("buildAiContextRef bvid 从 url 回落", () => {
  it("bvid 缺失且 url 含 BV → 从 url 提取", () => {
    const ref = buildAiContextRef({ url: "https://www.bilibili.com/video/BV1fallback/?p=1" });
    expect(ref.bvid).toBe("BV1fallback");
  });

  it("显式 bvid 优先于 url 提取", () => {
    const ref = buildAiContextRef({ url: "https://www.bilibili.com/video/BV1fallback/", bvid: "BV1explicit" });
    expect(ref.bvid).toBe("BV1explicit");
  });

  it("bvid 缺失且 url 非视频页 → 空串（不误判）", () => {
    const ref = buildAiContextRef({ url: "https://example.com/watch?v=xyz" });
    expect(ref.bvid).toBe("");
  });
});

describe("buildAiContextRef 输入兜底", () => {
  it("null/undefined/标量输入 → 全空壳 ref（不抛错）", () => {
    for (const input of [null, undefined, "x", 42]) {
      const ref = buildAiContextRef(input);
      expect(Object.keys(ref)).toEqual(EXPECTED_FIELDS);
      expect(ref.title).toBe("");
      expect(ref.bvid).toBe("");
      expect(ref.chapters).toBeUndefined();
      expect(ref.isVideoContext).toBe(true);
    }
  });
});

describe("buildContextPlaceholder 在统一构造器结果上补占位字段", () => {
  it("15 字段齐 + subtitleMarkdown 空串 + hotComments 空数组", () => {
    const placeholder = buildContextPlaceholder(FULL_INPUT);
    expect(Object.keys(placeholder)).toEqual([...EXPECTED_FIELDS, "subtitleMarkdown", "hotComments"]);
    expect(placeholder.title).toBe("测试视频");
    expect(placeholder.bvid).toBe("BV1full");
    expect(placeholder.chapters).toEqual([{ title: "开场", from: 0, to: 60 }]);
    expect(placeholder.subtitleMarkdown).toBe("");
    expect(placeholder.hotComments).toEqual([]);
    expect(placeholder.isVideoContext).toBe(true);
  });

  it("chapters 缺省的旧会话 ref → chapters undefined，其余占位字段照常", () => {
    const placeholder = buildContextPlaceholder({ title: "旧会话", bvid: "BV1old" });
    expect(placeholder.chapters).toBeUndefined();
    expect(placeholder.subtitleMarkdown).toBe("");
    expect(placeholder.hotComments).toEqual([]);
  });

  it("非对象输入 → null（占位语义与旧行为一致）", () => {
    expect(buildContextPlaceholder(null)).toBeNull();
    expect(buildContextPlaceholder(undefined)).toBeNull();
  });
});
