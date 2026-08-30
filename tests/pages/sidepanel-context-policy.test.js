// sidepanel-context-policy 纯函数测试：loadContextState 的「输入 → 动作」映射。
// 策略模块只做判定不做 I/O，这里直接对 resolveLoadContextAction /
// resolveNoTabPlan / 两个 isPinned 谓词断言，锁定与 sidepanel.js 旧内联分支
// 一一对应的判定优先级：skip-unchanged > error > apply-pinned >
// blocked-streaming > apply-live；no-tab 在消息往返之前由 resolveNoTabPlan
// 单独给出。forceRefresh 只随消息透传给 content（手动刷新时 content 忽略签名
// 回全量），不在策略签名里、不参与动作判定。

import { describe, expect, it } from "vitest";

import {
  CONTEXT_READ_FAILED_MESSAGE,
  LOAD_CONTEXT_ACTION,
  NO_TAB_MESSAGE,
  isPinnedContextStrict,
  isPinnedContextTruthy,
  resolveLoadContextAction,
  resolveNoTabPlan
} from "../../extension/pages/sidepanel-context-policy.js";

// 常用响应夹具（冻结防误改）
const OK_FULL = Object.freeze({ ok: true, payload: { signature: "sig-1", title: "视频" } });
const OK_UNCHANGED = Object.freeze({ ok: true, payload: { unchanged: true } });
const RESP_ERROR = Object.freeze({ ok: false, error: "boom" });

// 默认输入：非 pinned / 非静默 / 非流式，全量响应（逐字段展开，测试内按需覆盖）
function liveInput(overrides = {}) {
  return {
    response: OK_FULL,
    hasPinnedConversation: false,
    silent: false,
    isStreaming: false,
    hasPendingUserPrompt: false,
    ...overrides
  };
}

describe("LOAD_CONTEXT_ACTION 枚举", () => {
  it("六个动作的字符串值快照", () => {
    expect(LOAD_CONTEXT_ACTION).toEqual({
      NO_TAB: "no-tab",
      SKIP_UNCHANGED: "skip-unchanged",
      ERROR: "error",
      APPLY_PINNED: "apply-pinned",
      BLOCKED_STREAMING: "blocked-streaming",
      APPLY_LIVE: "apply-live"
    });
  });
});

describe("resolveLoadContextAction — skip-unchanged 短路", () => {
  it("ok 且 payload.unchanged === true → SKIP_UNCHANGED，只带 returnValue", () => {
    expect(resolveLoadContextAction(liveInput({ response: OK_UNCHANGED }))).toEqual({
      action: LOAD_CONTEXT_ACTION.SKIP_UNCHANGED,
      returnValue: true
    });
  });

  it("短路优先于 pinned 对话", () => {
    const plan = resolveLoadContextAction(
      liveInput({ response: OK_UNCHANGED, hasPinnedConversation: true })
    );
    expect(plan.action).toBe(LOAD_CONTEXT_ACTION.SKIP_UNCHANGED);
  });

  it("短路优先于流式守卫", () => {
    const plan = resolveLoadContextAction(
      liveInput({ response: OK_UNCHANGED, isStreaming: true, hasPendingUserPrompt: true })
    );
    expect(plan.action).toBe(LOAD_CONTEXT_ACTION.SKIP_UNCHANGED);
  });

  it("unchanged 是严格 === true：真值但非 true 不构成短路", () => {
    expect(
      resolveLoadContextAction(liveInput({ response: { ok: true, payload: { unchanged: 1 } } })).action
    ).toBe(LOAD_CONTEXT_ACTION.APPLY_LIVE);
    expect(
      resolveLoadContextAction(liveInput({ response: { ok: true, payload: { unchanged: "yes" } } })).action
    ).toBe(LOAD_CONTEXT_ACTION.APPLY_LIVE);
  });

  it("ok 全量响应但无 unchanged 字段 → 不短路", () => {
    expect(resolveLoadContextAction(liveInput()).action).toBe(LOAD_CONTEXT_ACTION.APPLY_LIVE);
  });

  it("forceRefresh 不参与判定：动作只由响应与运行时标志决定", () => {
    // 策略签名没有 forceRefresh 入参；手动刷新语义由编排壳随消息透传
    //（content 忽略签名回全量，正常不会出现 unchanged），因此同一响应输入
    // 永远映射到同一动作，与刷新方式无关。
    expect(resolveLoadContextAction(liveInput({ response: OK_UNCHANGED })).action).toBe(
      LOAD_CONTEXT_ACTION.SKIP_UNCHANGED
    );
    expect(resolveLoadContextAction(liveInput()).action).toBe(LOAD_CONTEXT_ACTION.APPLY_LIVE);
  });
});

describe("resolveLoadContextAction — error 分类", () => {
  it("!ok 响应 → ERROR：只清 live 不清 liveTabUrl，透传 error 文案", () => {
    expect(resolveLoadContextAction(liveInput({ response: RESP_ERROR }))).toEqual({
      action: LOAD_CONTEXT_ACTION.ERROR,
      clearTabUrl: false,
      clearContext: true,
      resetView: true,
      message: "boom",
      returnValue: false
    });
  });

  it("ok 但 payload 缺失 → ERROR，message 落到通用文案", () => {
    const plan = resolveLoadContextAction(liveInput({ response: { ok: true } }));
    expect(plan.action).toBe(LOAD_CONTEXT_ACTION.ERROR);
    expect(plan.message).toBe(CONTEXT_READ_FAILED_MESSAGE);
  });

  it("response 为 null（防御输入）→ ERROR + 兜底文案", () => {
    const plan = resolveLoadContextAction(liveInput({ response: null }));
    expect(plan.action).toBe(LOAD_CONTEXT_ACTION.ERROR);
    expect(plan.message).toBe(CONTEXT_READ_FAILED_MESSAGE);
    expect(plan.returnValue).toBe(false);
  });

  it("error 优先于 pinned：pinned 对话读取失败同样是 ERROR", () => {
    const plan = resolveLoadContextAction(
      liveInput({ response: RESP_ERROR, hasPinnedConversation: true })
    );
    expect(plan.action).toBe(LOAD_CONTEXT_ACTION.ERROR);
    // pinned 对话保留主上下文，也不因失败重置视图
    expect(plan.clearContext).toBe(false);
    expect(plan.resetView).toBe(false);
  });

  it("error 且 silent → 不重置视图，其余清理照旧", () => {
    const plan = resolveLoadContextAction(liveInput({ response: RESP_ERROR, silent: true }));
    expect(plan.action).toBe(LOAD_CONTEXT_ACTION.ERROR);
    expect(plan.resetView).toBe(false);
    expect(plan.clearContext).toBe(true);
  });

  it("error 字段为非字符串真值时原样透传（不做 String 化）", () => {
    const weirdError = { code: 7 };
    const plan = resolveLoadContextAction(liveInput({ response: { ok: false, error: weirdError } }));
    expect(plan.message).toBe(weirdError);
  });

  it("ok=false 且无 error 字段 → 兜底通用文案", () => {
    const plan = resolveLoadContextAction(liveInput({ response: { ok: false } }));
    expect(plan.message).toBe(CONTEXT_READ_FAILED_MESSAGE);
  });
});

describe("resolveLoadContextAction — apply-pinned 优先于流式守卫", () => {
  it("pinned 且流式中 → APPLY_PINNED（优先级高于 blocked-streaming）", () => {
    const plan = resolveLoadContextAction(
      liveInput({ hasPinnedConversation: true, isStreaming: true, hasPendingUserPrompt: true })
    );
    expect(plan.action).toBe(LOAD_CONTEXT_ACTION.APPLY_PINNED);
    expect(plan.applyToMainContext).toBe(false);
    expect(plan.returnValue).toBe(true);
  });

  it("pinned 且有待发送 prompt → APPLY_PINNED", () => {
    const plan = resolveLoadContextAction(
      liveInput({ hasPinnedConversation: true, hasPendingUserPrompt: true })
    );
    expect(plan.action).toBe(LOAD_CONTEXT_ACTION.APPLY_PINNED);
  });

  it("pinned 单独成立 → APPLY_PINNED，live 快照不进主上下文", () => {
    const plan = resolveLoadContextAction(liveInput({ hasPinnedConversation: true }));
    expect(plan).toEqual({
      action: LOAD_CONTEXT_ACTION.APPLY_PINNED,
      applyToMainContext: false,
      returnValue: true
    });
  });

  it("silent 对成功动作无影响", () => {
    const plan = resolveLoadContextAction(
      liveInput({ hasPinnedConversation: true, silent: true })
    );
    expect(plan.action).toBe(LOAD_CONTEXT_ACTION.APPLY_PINNED);
  });
});

describe("resolveLoadContextAction — blocked-streaming", () => {
  it("流式渲染中 → 冻结主上下文，只落地 live 快照", () => {
    const plan = resolveLoadContextAction(liveInput({ isStreaming: true }));
    expect(plan).toEqual({
      action: LOAD_CONTEXT_ACTION.BLOCKED_STREAMING,
      applyToMainContext: false,
      returnValue: true
    });
  });

  it("有待发送 prompt → 同样冻结", () => {
    const plan = resolveLoadContextAction(liveInput({ hasPendingUserPrompt: true }));
    expect(plan.action).toBe(LOAD_CONTEXT_ACTION.BLOCKED_STREAMING);
    expect(plan.applyToMainContext).toBe(false);
  });
});

describe("resolveLoadContextAction — apply-live", () => {
  it("非 pinned 非流式的全量响应 → 应用到主上下文", () => {
    expect(resolveLoadContextAction(liveInput())).toEqual({
      action: LOAD_CONTEXT_ACTION.APPLY_LIVE,
      applyToMainContext: true,
      returnValue: true
    });
  });
});

describe("resolveNoTabPlan — 消息往返之前的决策点", () => {
  it("默认（非 pinned 非静默）→ 全量清理 + 重置视图 + 找不到标签页文案", () => {
    expect(resolveNoTabPlan({ hasPinnedConversation: false, silent: false })).toEqual({
      action: LOAD_CONTEXT_ACTION.NO_TAB,
      clearTabUrl: true,
      clearContext: true,
      resetView: true,
      message: NO_TAB_MESSAGE,
      returnValue: false
    });
  });

  it("不传参等价于默认", () => {
    expect(resolveNoTabPlan()).toEqual(resolveNoTabPlan({ hasPinnedConversation: false, silent: false }));
  });

  it("pinned 对话 → 保留主上下文且不重置视图，但 liveTabUrl 照清", () => {
    const plan = resolveNoTabPlan({ hasPinnedConversation: true, silent: false });
    expect(plan.clearTabUrl).toBe(true);
    expect(plan.clearContext).toBe(false);
    expect(plan.resetView).toBe(false);
    expect(plan.message).toBe(NO_TAB_MESSAGE);
    expect(plan.returnValue).toBe(false);
  });

  it("静默轮询 → 不重置视图，主上下文照清", () => {
    const plan = resolveNoTabPlan({ hasPinnedConversation: false, silent: true });
    expect(plan.clearContext).toBe(true);
    expect(plan.resetView).toBe(false);
  });

  it("pinned + silent → 除清 liveTabUrl 外全部保留现状", () => {
    const plan = resolveNoTabPlan({ hasPinnedConversation: true, silent: true });
    expect(plan.clearContext).toBe(false);
    expect(plan.resetView).toBe(false);
    expect(plan.action).toBe(LOAD_CONTEXT_ACTION.NO_TAB);
    expect(plan.returnValue).toBe(false);
  });
});

describe("isPinned 两个谓词的差异", () => {
  it("strict：只有字面量 true 成立（loadContextState 的历史语义）", () => {
    expect(isPinnedContextStrict({ pinnedContext: true })).toBe(true);
    expect(isPinnedContextStrict({ pinnedContext: 1 })).toBe(false);
    expect(isPinnedContextStrict({ pinnedContext: "true" })).toBe(false);
    expect(isPinnedContextStrict({})).toBe(false);
    expect(isPinnedContextStrict(undefined)).toBe(false);
    expect(isPinnedContextStrict(null)).toBe(false);
  });

  it("truthy：任何真值成立（ensureCurrentContextForSend 的历史语义）", () => {
    expect(isPinnedContextTruthy({ pinnedContext: true })).toBe(true);
    expect(isPinnedContextTruthy({ pinnedContext: 1 })).toBe(true);
    expect(isPinnedContextTruthy({ pinnedContext: "true" })).toBe(true);
    expect(isPinnedContextTruthy({})).toBe(false);
    expect(isPinnedContextTruthy(undefined)).toBe(false);
    expect(isPinnedContextTruthy(null)).toBe(false);
  });

  it("分歧点：pinnedContext 为真值非 true 时两谓词结果不同（锁定历史现状）", () => {
    const meta = { pinnedContext: 1 };
    expect(isPinnedContextStrict(meta)).toBe(false);
    expect(isPinnedContextTruthy(meta)).toBe(true);
  });
});

describe("失败文案常量与现网逐字一致", () => {
  it("NO_TAB_MESSAGE 与 loadContextState 旧 no-tab 分支文案一致", () => {
    expect(NO_TAB_MESSAGE).toBe("找不到当前标签页。");
  });

  it("CONTEXT_READ_FAILED_MESSAGE 与旧 error 分支及发送前失败闸文案一致", () => {
    expect(CONTEXT_READ_FAILED_MESSAGE).toBe("当前页面上下文读取失败。");
  });
});
