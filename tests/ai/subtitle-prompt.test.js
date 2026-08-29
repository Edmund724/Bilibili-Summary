// ai/subtitle-prompt.js 单测（候选 3：消息协议删除 subtitleMarkdown 后的
// 唯一渲染收口）。覆盖：
// - buildSubtitlePrompt：章节分节、时间戳开关、withHours（videoDuration 判定）、
//   空 body 返回空串；
// - 与笔记场景 buildAiConversationMarkdown 的输出等价性；
// - 「预算按 body、发送按渲染产物」的一致性锚点：同一份 body 的渲染产物即
//   resolveSubtitleForContext / buildMessages 的实际发送物。

import { describe, expect, it } from "vitest";
import {
  buildSubtitlePrompt,
  buildAiConversationMarkdown
} from "../../extension/ai/subtitle-prompt.js";

const BODY = [
  { from: 0, to: 5, content: "第一句" },
  { from: 5, to: 10, content: "第二句" },
  { from: 100, to: 105, content: "落进第二章节的内容" }
];

const CHAPTERS = [
  { title: "开场", from: 0, to: 60 },
  { title: "正文", from: 60, to: 600 }
];

describe("buildSubtitlePrompt", () => {
  it("无章节：逐行渲染字幕体，默认带时间戳（includeTimestampInBody 缺省 true）", () => {
    expect(buildSubtitlePrompt({ body: BODY })).toBe(
      "## 字幕\n\n`00:00` 第一句\n`00:05` 第二句\n`01:40` 落进第二章节的内容"
    );
  });

  it("includeTimestampInBody=false：只渲染正文，不带时间戳", () => {
    expect(buildSubtitlePrompt({ body: BODY, includeTimestampInBody: false })).toBe(
      "## 字幕\n\n第一句\n第二句\n落进第二章节的内容"
    );
  });

  it("有章节：含「## 章节」分节与章节分桶（### 章节标题 + 时间戳）", () => {
    const out = buildSubtitlePrompt({ body: BODY, chapters: CHAPTERS, videoDuration: 600 });
    expect(out).toContain("## 章节");
    expect(out).toContain("`00:00` 开场");
    expect(out).toContain("### 正文");
    expect(out).toContain("`00:00` 第一句");
    expect(out).toContain("`00:05` 第二句");
    expect(out).toContain("`01:40` 落进第二章节的内容");
  });

  it("videoDuration ≥ 3600 → withHours 判定生效，时间戳带小时位", () => {
    const body = [{ from: 3600, to: 3605, content: "一小时后的内容" }];
    const out = buildSubtitlePrompt({ body, videoDuration: 3700 });
    expect(out).toContain("`01:00:00` 一小时后的内容");
  });

  it("body 空/缺失 → 空串（由调用方决定「暂无字幕」占位，不虚构内容）", () => {
    expect(buildSubtitlePrompt({ body: [] })).toBe("");
    expect(buildSubtitlePrompt({})).toBe("");
    // 全空白正文：落到渲染版兜底（与 buildAiConversationMarkdown 一致的「暂无字幕」分节）
    expect(buildSubtitlePrompt({ body: [{ from: 0, to: 5, content: "  " }] })).toBe(
      "## 字幕\n\n（暂无字幕）"
    );
  });

  it("输出与笔记场景 buildAiConversationMarkdown 等价（同一渲染收口）", () => {
    const body = [...BODY, { from: 3700, to: 3705, content: "一小时后的内容" }];
    const chapters = [...CHAPTERS, { title: "尾声", from: 3700, to: 3800 }];
    const includeTimestampInBody = true;
    expect(
      buildSubtitlePrompt({ body, chapters, videoDuration: 3800, includeTimestampInBody })
    ).toBe(buildAiConversationMarkdown({ chapters, videoDuration: 3800 }, body, { includeTimestampInBody }));
  });
});
