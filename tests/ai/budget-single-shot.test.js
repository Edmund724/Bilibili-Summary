// ai/client.js 预算内单次总结测试（02 票）：
// 覆盖 resolveSubtitleForContext 的预算内全文 / 超预算回落 / body 缺失退化，
// 以及 isContextLengthOverflow 对溢出文案与普通错误的识别。

import { describe, expect, it } from "vitest";
import { makeSubtitleBody } from "../setup.js";
import {
  resolveSubtitleForContext,
  isContextLengthOverflow,
  OVER_BUDGET_NOTICE
} from "../../extension/ai/client.js";
import { clipSubtitleForContext } from "../../extension/ai/context.js";

describe("resolveSubtitleForContext 预算内全文", () => {
  it("body ≤100k：整篇 markdown 原样进入上下文，尾部不丢（即使 markdown 超 50k 字符）", () => {
    // 正文 60k 字符 ≤ 100k 素材预算；markdown 长 60k+6（> 旧的 50k 硬截断阈值）。
    const markdown = "x".repeat(60000) + "【结尾段落】";
    const result = resolveSubtitleForContext({
      subtitleBody: makeSubtitleBody(60000),
      subtitleMarkdown: markdown
    });
    expect(result.mode).toBe("single");
    expect(result.markdown).toBe(markdown);
    expect(result.markdown.length).toBe(60006);
    expect(result.markdown.endsWith("【结尾段落】")).toBe(true);
    expect(result.notice).toBe("");
    expect(result.overflowMarked).toBe(false);
  });

  it("恰好 100k 边界：single，整篇不截断", () => {
    const markdown = "y".repeat(100000);
    const result = resolveSubtitleForContext({
      subtitleBody: makeSubtitleBody(100000),
      subtitleMarkdown: markdown
    });
    expect(result.mode).toBe("single");
    expect(result.markdown).toBe(markdown);
    expect(result.overflowMarked).toBe(false);
    expect(result.notice).toBe("");
  });

  it("body 缺失/空 → 退化为对 markdown 估 token：≤100k 时为 single 且原样", () => {
    const markdown = "z".repeat(100000);
    const result = resolveSubtitleForContext({ subtitleMarkdown: markdown });
    expect(result.mode).toBe("single");
    expect(result.markdown).toBe(markdown);
    expect(result.overflowMarked).toBe(false);
  });
});

describe("resolveSubtitleForContext 超预算回落", () => {
  it("body 110k：map-reduce，回落到 50k 截断 + 提示 + 打标记", () => {
    const markdown = "z".repeat(110000);
    const result = resolveSubtitleForContext({
      subtitleBody: makeSubtitleBody(110000),
      subtitleMarkdown: markdown
    });
    expect(result.mode).toBe("map-reduce");
    expect(result.notice).toBe(OVER_BUDGET_NOTICE);
    expect(result.notice).toBe("字幕过长，已切换为分段整理模式");
    expect(result.overflowMarked).toBe(true);
    expect(result.markdown).toBe(clipSubtitleForContext(markdown));
    expect(result.markdown).not.toBe(markdown);
    expect(result.markdown.startsWith("z".repeat(50000))).toBe(true);
    expect(result.markdown.endsWith("已截断）")).toBe(true);
  });

  it("body 缺失/空但 markdown 超 100k：退化路径同样回落并打标记", () => {
    const markdown = "a".repeat(100001);
    const result = resolveSubtitleForContext({ subtitleMarkdown: markdown });
    expect(result.mode).toBe("map-reduce");
    expect(result.notice).toBe(OVER_BUDGET_NOTICE);
    expect(result.overflowMarked).toBe(true);
    expect(result.markdown).toBe(clipSubtitleForContext(markdown));
  });

  it("无字幕（body 空 + markdown 空）：single，空 markdown，不打标记", () => {
    const result = resolveSubtitleForContext({});
    expect(result.mode).toBe("single");
    expect(result.markdown).toBe("");
    expect(result.notice).toBe("");
    expect(result.overflowMarked).toBe(false);
  });
});

describe("isContextLengthOverflow 溢出识别", () => {
  it("典型 context-length 溢出文案 → true", () => {
    const overflowMessages = [
      "context_length_exceeded",
      "This model's maximum context length is 8192 tokens, but you requested 12000 tokens.",
      "maximum context length exceeded",
      "exceeds the maximum context window",
      "too many tokens in request",
      "max_tokens limit reached",
      "token limit exceeded",
      "max tokens exceeded",
      "prompt is too long",
      "input is too large",
      "请求的上下文长度超出限制",
      "上下文长度超过最大限制",
      "请求 tokens 超出上下文上限"
    ];
    for (const message of overflowMessages) {
      expect(isContextLengthOverflow(message), message).toBe(true);
    }
  });

  it("Error 对象也按文案判定（String 强制转换）", () => {
    expect(isContextLengthOverflow(new Error("maximum context length exceeded"))).toBe(true);
    expect(isContextLengthOverflow(new Error("network down"))).toBe(false);
  });

  it("普通错误（401/404/500/网络/限流/空输入）→ false", () => {
    const plainErrors = [
      "401 Unauthorized",
      "404 Not Found",
      "500 Internal Server Error",
      "invalid api key",
      "model not found",
      "connection reset by peer",
      "rate limit exceeded",
      "请求超时（90 秒未返回任何数据）已自动中断",
      "",
      undefined,
      null,
      123
    ];
    for (const message of plainErrors) {
      expect(isContextLengthOverflow(message), String(message)).toBe(false);
    }
  });
});
