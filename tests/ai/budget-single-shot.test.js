// ai/client.js 预算内单次总结测试（02 票 + 候选 3 协议改造）：
// resolveSubtitleForContext 的预算输入与实际发送物同源——预算按 subtitleBody
// 判定（buildBudgetPlan），发送物由 ai/subtitle-prompt.js 的 buildSubtitlePrompt
// 从同一份 body 现场渲染；body 缺失时退化为对实际发送物（空渲染 / 追问压缩摘要
// compressedSummaryMarkdown）的 estimateTokens 判定。
// isContextLengthOverflow 溢出识别已随协议接缝迁移至 tests/ai/completion.test.js。

import { describe, expect, it } from "vitest";
import { makeSubtitleBody } from "../setup.js";
import {
  resolveSubtitleForContext,
  OVER_BUDGET_NOTICE
} from "../../extension/ai/client.js";
import { buildSubtitlePrompt } from "../../extension/ai/subtitle-prompt.js";
import { clipSubtitleForContext } from "../../extension/ai/context.js";

describe("resolveSubtitleForContext 预算内全文", () => {
  it("body ≤100k：发送物 = buildSubtitlePrompt 从同一份 body 的渲染产物，结尾不丢", () => {
    const body = [
      ...makeSubtitleBody(59000),
      // 结尾标记项：验证渲染产物完整包含 body 尾部（整篇原样，不按渲染字符截断）
      { from: 300, to: 305, content: "【结尾段落】" }
    ];
    const result = resolveSubtitleForContext({ subtitleBody: body });

    const rendered = buildSubtitlePrompt({ body });
    expect(result.mode).toBe("single");
    // 发送物与渲染函数逐字一致：预算（按 body）与实际消耗（渲染产物）同源
    expect(result.markdown).toBe(rendered);
    expect(result.markdown).toContain("【结尾段落】");
    expect(result.markdown.endsWith("【结尾段落】")).toBe(true);
    expect(result.notice).toBe("");
    expect(result.overflowMarked).toBe(false);
  });

  it("恰好 100k 边界：single，整篇不截断", () => {
    const body = makeSubtitleBody(100000);
    const result = resolveSubtitleForContext({ subtitleBody: body });
    expect(result.mode).toBe("single");
    expect(result.markdown).toBe(buildSubtitlePrompt({ body }));
    expect(result.overflowMarked).toBe(false);
    expect(result.notice).toBe("");
  });
});

describe("resolveSubtitleForContext 超预算回落", () => {
  it("body 110k：map-reduce，回落到 50k 截断 + 提示 + 打标记", () => {
    const body = makeSubtitleBody(110000);
    const result = resolveSubtitleForContext({ subtitleBody: body });
    const rendered = buildSubtitlePrompt({ body });

    expect(result.mode).toBe("map-reduce");
    expect(result.notice).toBe(OVER_BUDGET_NOTICE);
    expect(result.notice).toBe("字幕过长，已切换为分段整理模式");
    expect(result.overflowMarked).toBe(true);
    expect(result.markdown).toBe(clipSubtitleForContext(rendered));
    expect(result.markdown).not.toBe(rendered);
    expect(result.markdown.endsWith("已截断）")).toBe(true);
  });

  it("body 缺失但追问压缩摘要超 100k：按摘要实际长度退化判定并回落打标记", () => {
    const compacted = "a".repeat(100001);
    const result = resolveSubtitleForContext({ compressedSummaryMarkdown: compacted });
    expect(result.mode).toBe("map-reduce");
    expect(result.notice).toBe(OVER_BUDGET_NOTICE);
    expect(result.overflowMarked).toBe(true);
    expect(result.markdown).toBe(clipSubtitleForContext(compacted));
  });

  it("无字幕（body 空 + 无压缩摘要）：single，空 markdown，不打标记", () => {
    const result = resolveSubtitleForContext({});
    expect(result.mode).toBe("single");
    expect(result.markdown).toBe("");
    expect(result.notice).toBe("");
    expect(result.overflowMarked).toBe(false);
  });
});

describe("resolveSubtitleForContext 追问压缩路径", () => {
  it("subtitleBody 置空 + compressedSummaryMarkdown：预算按摘要估 token，发送物即摘要原文", () => {
    const compacted = "## 分段小结\n\n### 片段 1\n小结内容。\n\n## 成稿笔记\n\n笔记正文。";
    const result = resolveSubtitleForContext({
      subtitleBody: [],
      compressedSummaryMarkdown: compacted
    });
    expect(result.mode).toBe("single");
    expect(result.markdown).toBe(compacted);
    expect(result.overflowMarked).toBe(false);
  });
});
