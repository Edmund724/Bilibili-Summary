// ai/explain.ts 选区解释的单测：上下文窗口截取、提示词组装、请求口径与空回复判定。
// chatCompletion 以 vi.mock 替身（协议层自身有 completion.test.js 覆盖）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const completionMock = vi.hoisted(() => ({ chatCompletion: vi.fn(async () => "  解释文本  ") }));

vi.mock("../../extension/ai/completion.js", () => ({
  chatCompletion: completionMock.chatCompletion
}));

let explain;

const BODY = [
  { from: 0, content: "我们习惯把语言视为空气" },
  { from: 10, content: "我们习惯将其视为传递信息的工具" },
  { from: 20, content: "但语言同时也是权力的载体" },
  { from: 30, content: "这一点很少被讨论" }
];

beforeEach(async () => {
  resetModuleState();
  completionMock.chatCompletion.mockReset();
  completionMock.chatCompletion.mockResolvedValue("  解释文本  ");
  explain = await import("../../extension/ai/explain.js");
});

describe("buildExplainContext", () => {
  it("以锚点句为中心取前后各 2 句，锚点行带 → 标记", () => {
    const context = explain.buildExplainContext(BODY, 2);
    const lines = context.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^ {2}\[00:00\] 我们习惯把语言视为空气$/);
    expect(lines[2]).toMatch(/^→ \[00:20\] 但语言同时也是权力的载体$/);
    expect(lines[3]).toMatch(/^ {2}\[00:30\] 这一点很少被讨论$/);
  });

  it("锚点在首/尾时窗口收敛不越界", () => {
    expect(explain.buildExplainContext(BODY, 0).split("\n")).toHaveLength(3);
    expect(explain.buildExplainContext(BODY, 3).split("\n")).toHaveLength(3);
  });

  it("body 为空 / index 缺失或越界 → 空串（调用方按无上下文出词）", () => {
    expect(explain.buildExplainContext([], 0)).toBe("");
    expect(explain.buildExplainContext(undefined, 1)).toBe("");
    expect(explain.buildExplainContext(BODY, undefined)).toBe("");
    expect(explain.buildExplainContext(BODY, 99)).toBe("");
    expect(explain.buildExplainContext(BODY, -1)).toBe("");
  });
});

describe("buildExplainMessages", () => {
  it("system 定口径（短句/不臆造/跟随字幕语言），user 带标题·选中·所在句·上下文", () => {
    const messages = explain.buildExplainMessages({
      videoTitle: "语言与权力",
      selection: "传递信息的工具",
      line: "我们习惯将其视为传递信息的工具",
      from: 10,
      body: BODY,
      index: 2
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("最多 3 句话");
    expect(messages[0].content).toContain("不要臆造");

    const user = messages[1].content;
    expect(user).toContain("视频标题：语言与权力");
    expect(user).toContain("选中内容：「传递信息的工具」");
    expect(user).toContain("所在字幕句（00:10）：「我们习惯将其视为传递信息的工具」");
    expect(user).toContain("字幕上下文");
    expect(user).toContain("我们习惯把语言视为空气");
  });

  it("无上下文时如实标注，不放假语境", () => {
    const messages = explain.buildExplainMessages({
      videoTitle: "",
      selection: "词",
      line: "句子",
      from: 5,
      body: [],
      index: undefined
    });
    expect(messages[1].content).toContain("（无可用上下文）");
    expect(messages[1].content).toContain("视频标题：未知");
  });
});

describe("explainSelection", () => {
  it("走非流式单次请求，思考档位钉死 off（协议层据此发显式关思考字段），返回 trim 后的解释", async () => {
    const text = await explain.explainSelection({
      provider: { baseUrl: "https://api.test/v1", apiKey: "sk", model: "m" },
      videoTitle: "T",
      selection: "传递信息的工具",
      line: "我们习惯将其视为传递信息的工具",
      from: 10,
      body: BODY,
      index: 2
    });

    expect(text).toBe("解释文本");
    const args = completionMock.chatCompletion.mock.calls[0][0];
    expect(args.stream).toBe(false);
    expect(args.thinkingLevel).toBe("off");
    expect(args.maxTokens).toBeGreaterThan(0);
    expect(args.messages[1].content).toContain("传递信息的工具");
  });

  it("系统提示词带「不要思考过程，直接给解释」的措辞（兜住服务端默认开思考的平台）", async () => {
    const messages = explain.buildExplainMessages({
      videoTitle: "T",
      selection: "词",
      line: "句",
      from: 0
    });
    expect(messages[0].content).toContain("不要思考过程");
  });

  it("空回复按失败抛错（模型没给东西不算成功）", async () => {
    completionMock.chatCompletion.mockResolvedValue("   ");
    await expect(
      explain.explainSelection({
        provider: { baseUrl: "https://api.test/v1", model: "m" },
        selection: "词",
        line: "句",
        from: 0
      })
    ).rejects.toThrow("模型没有给出解释");
  });

  it("请求失败原样上抛（由调用方落 error 态）", async () => {
    completionMock.chatCompletion.mockRejectedValue(new Error("HTTP 401"));
    await expect(
      explain.explainSelection({ provider: { baseUrl: "https://api.test/v1", model: "m" }, selection: "词", line: "句", from: 0 })
    ).rejects.toThrow("HTTP 401");
  });
});
