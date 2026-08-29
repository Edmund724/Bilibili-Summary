// createSubtitleBodySlot（entry/offscreen-subtitle-slot.js）纯逻辑测试：
// 候选5「追问不重传字幕体」的 offscreen 单槽缓存——
// - 消息自带 subtitleBody → 覆盖槽（以消息 contextKey 为 key）；
// - 未携带 + 槽 key 匹配 → 从槽补写 msg.context.subtitleBody；
// - 未携带 + 无槽（= 文档重启后的新实例）/ key 不匹配 → 回「字幕体缺失」错误；
// - 无 context 的异常消息同样回缺失，不做猜测式兜底。

import { describe, expect, it } from "vitest";

import {
  SUBTITLE_BODY_MISSING_CODE,
  SUBTITLE_BODY_MISSING_MESSAGE,
  createSubtitleBodySlot
} from "../../extension/entry/offscreen-subtitle-slot.js";

const BODY = [{ from: 0, to: 5, content: "第一句" }, { from: 5, to: 9, content: "第二句" }];

describe("createSubtitleBodySlot", () => {
  it("消息自带字幕体 → 覆盖槽并回 ok（contextKey 取消息 key）", () => {
    const slot = createSubtitleBodySlot();
    const context = { title: "T", subtitleBody: BODY };

    const result = slot.settle({ action: "chat", contextKey: "video:BV1|101", context });

    expect(result).toEqual({ ok: true, contextKey: "video:BV1|101" });
    // 全量路径不改动消息本体
    expect(context.subtitleBody).toBe(BODY);
  });

  it("未携带 + 槽 key 匹配 → 从槽补写（同一引用，ladder 拿到完整 context）", () => {
    const slot = createSubtitleBodySlot();
    slot.settle({ action: "chat", contextKey: "video:BV1|101", context: { title: "T", subtitleBody: BODY } });

    const followup = { action: "chat", contextKey: "video:BV1|101", context: { title: "T" } };
    const result = slot.settle(followup);

    expect(result).toEqual({ ok: true, contextKey: "video:BV1|101" });
    expect(followup.context.subtitleBody).toBe(BODY);
  });

  it("未携带 + 无槽（新实例 = offscreen 文档重启模拟）→ 回字幕体缺失错误", () => {
    const slot = createSubtitleBodySlot();

    const result = slot.settle({ action: "chat", contextKey: "video:BV1|101", context: { title: "T" } });

    expect(result).toEqual({
      ok: false,
      error: SUBTITLE_BODY_MISSING_MESSAGE,
      code: SUBTITLE_BODY_MISSING_CODE
    });
  });

  it("未携带 + 槽 key 不匹配 → 回缺失错误（不跨 key 复用旧字幕体）", () => {
    const slot = createSubtitleBodySlot();
    slot.settle({ action: "chat", contextKey: "video:BV1|101", context: { title: "T", subtitleBody: BODY } });

    const result = slot.settle({ action: "chat", contextKey: "video:BV2|202", context: { title: "T2" } });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(SUBTITLE_BODY_MISSING_CODE);
  });

  it("换视频的全量消息覆盖槽后，新 key 的未携带消息可补齐", () => {
    const slot = createSubtitleBodySlot();
    const bodyA = [{ from: 0, to: 5, content: "A" }];
    const bodyB = [{ from: 0, to: 5, content: "B" }];
    slot.settle({ action: "chat", contextKey: "video:BVA|1", context: { subtitleBody: bodyA } });
    slot.settle({ action: "chat", contextKey: "video:BVB|2", context: { subtitleBody: bodyB } });

    const followup = { action: "chat", contextKey: "video:BVB|2", context: { title: "T" } };
    slot.settle(followup);
    // 单槽只保留最近一份：旧 key 已被覆盖，不能拿到 A
    expect(slot.settle({ action: "chat", contextKey: "video:BVA|1", context: {} }).ok).toBe(false);
    expect(followup.context.subtitleBody).toBe(bodyB);
  });

  it("context 缺失/非对象的异常消息 → 回字幕体缺失错误", () => {
    const slot = createSubtitleBodySlot();
    expect(slot.settle({ action: "chat", contextKey: "k" }).ok).toBe(false);
    expect(slot.settle({ action: "chat", contextKey: "k", context: "not-an-object" }).ok).toBe(false);
  });

  it("空数组字幕体也是有效携带（非视频上下文同样登记进槽）", () => {
    const slot = createSubtitleBodySlot();
    slot.settle({ action: "chat", contextKey: "url:https://x", context: { subtitleBody: [] } });

    const followup = { action: "chat", contextKey: "url:https://x", context: { title: "非视频" } };
    const result = slot.settle(followup);

    expect(result.ok).toBe(true);
    expect(followup.context.subtitleBody).toEqual([]);
  });
});
