// 待解释意图契约（reader/explain-intent）单测。
//
// 该意图现在是「解释卡片 → 去对话追问」的交接面：卡片把选中片段 + 所在整句写
// 进单槽 pending，对话 tab 激活时 peek → 渲染引用卡 → 自动发送 → consume。
// 覆盖 set/peek（只读副本）/consume（取走即清）/clear 单槽语义与 selection 归一化。
// 选区浮层与卡片交互的回归在 tests/reader/explain-card.test.ts。

import { beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";

let explainIntent: typeof import("../../extension/reader/explain-intent.js");

beforeEach(async () => {
  resetModuleState();
  explainIntent = await import("../../extension/reader/explain-intent.js");
});

describe("待解释意图契约（reader/explain-intent）", () => {
  it("set/peek/consume/clear：单槽语义，peek 只读、consume 取走即清", () => {
    expect(explainIntent.peekPendingExplainIntent()).toBe(null);

    explainIntent.setPendingExplainIntent({ from: 12, content: "句子甲", createdAt: 1000 });
    const peeked = explainIntent.peekPendingExplainIntent();
    expect(peeked).toEqual({ from: 12, content: "句子甲", createdAt: 1000 });
    // peek 返回副本：外部改写不影响内部状态
    peeked!.content = "被篡改";
    expect(explainIntent.peekPendingExplainIntent()?.content).toBe("句子甲");

    // 后写覆盖先写（连点两句以最后一句为准）
    explainIntent.setPendingExplainIntent({ from: 34, content: "句子乙", createdAt: 2000 });
    expect(explainIntent.peekPendingExplainIntent()?.content).toBe("句子乙");

    const consumed = explainIntent.consumePendingExplainIntent();
    expect(consumed).toEqual({ from: 34, content: "句子乙", createdAt: 2000 });
    expect(explainIntent.consumePendingExplainIntent()).toBe(null);
    expect(explainIntent.peekPendingExplainIntent()).toBe(null);

    explainIntent.setPendingExplainIntent({ from: 1, content: "x", createdAt: 3 });
    explainIntent.clearPendingExplainIntent();
    expect(explainIntent.peekPendingExplainIntent()).toBe(null);
  });

  it("selection：选中词/短语随意图存下并随副本返回", () => {
    explainIntent.setPendingExplainIntent({
      from: 5,
      content: "我们习惯将其视为传递信息的工具",
      selection: "传递信息的工具",
      createdAt: 1000
    });
    const intent = explainIntent.peekPendingExplainIntent();
    expect(intent?.selection).toBe("传递信息的工具");
    // 副本防改写
    intent!.selection = "被篡改";
    expect(explainIntent.peekPendingExplainIntent()?.selection).toBe("传递信息的工具");
  });

  it("selection 归一化：整句选中（与 content 相同）与纯空白都不落字段", () => {
    explainIntent.setPendingExplainIntent({ from: 6, content: "同一句", selection: "同一句", createdAt: 1 });
    expect(explainIntent.peekPendingExplainIntent()).not.toHaveProperty("selection");

    explainIntent.setPendingExplainIntent({ from: 7, content: "句", selection: "   ", createdAt: 1 });
    expect(explainIntent.peekPendingExplainIntent()).not.toHaveProperty("selection");

    // 消费方按「有无 selection」分流出两种提示词口径，不必自己判等
    expect(explainIntent.consumePendingExplainIntent()).toEqual({ from: 7, content: "句", createdAt: 1 });
  });
});
