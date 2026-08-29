// ai/ladder.js 阶梯分派策略测试：
// 用 fake deps + 收集 postMessage 的 fake port 覆盖五个分支——
// ① 预算内单次流式；② map-reduce 下追问压缩命中；③ 未命中 + 成本护栏
// （确认走 Map-Reduce / 取消回 stopped）；④ 单次溢出转 Map-Reduce 重试一次；
// ⑤ 追问压缩后仍溢出 → 追问溢出错误。

import { describe, expect, it, vi } from "vitest";
import { runLadderChat } from "../../extension/ai/ladder.js";

// 收集 postMessage 消息的 fake port
function makePort() {
  return { messages: [], postMessage(m) { this.messages.push(m); } };
}

// 依测试需要覆盖的 fake deps 工厂：默认全部可观察的最小实现
function makeDeps(overrides = {}) {
  const calls = { streamChat: [], mapReduce: [], followup: [], guard: [] };
  const deps = {
    streamChat: vi.fn(async (args) => {
      calls.streamChat.push(args);
      return "ok";
    }),
    orchestrateMapReduce: vi.fn(async (args) => {
      calls.mapReduce.push(args);
      return "ok";
    }),
    resolveFollowupContext: vi.fn(async (args) => {
      calls.followup.push(args);
      return null;
    }),
    buildBudgetPlan: vi.fn(() => ({ mode: "single" })),
    buildCostGuardNotice: vi.fn(() => ({ shouldPrompt: false, message: "" })),
    trimRecentTurns: vi.fn((history) => (history || []).slice(-2)),
    askCostGuard: vi.fn(async () => true),
    onActivity: vi.fn(),
    pauseIdleTimeout: vi.fn(),
    ...overrides
  };
  return { deps, calls };
}

function makeMsg() {
  return {
    context: { subtitleBody: ["a", "b"], chapters: [] },
    history: [{ role: "user", content: "h1" }, { role: "assistant", content: "h2" }],
    prompt: "总结一下",
    thinkingLevel: "off"
  };
}

describe("runLadderChat 分派", () => {
  it("① 预算内（非 map-reduce）→ 单次 streamChat，不触发追问与 Map-Reduce", async () => {
    const port = makePort();
    const { deps, calls } = makeDeps();

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal: "sig" }, deps);

    expect(calls.streamChat).toHaveLength(1);
    expect(calls.streamChat[0]).toMatchObject({
      provider: { id: "p" },
      context: { subtitleBody: ["a", "b"], chapters: [] },
      userPrompt: "总结一下",
      signal: "sig"
    });
    expect(calls.mapReduce).toHaveLength(0);
    expect(calls.followup).toHaveLength(0);
    expect(port.messages).toHaveLength(0);
  });

  it("② map-reduce 模式下追问命中 → trimRecentTurns 截历史 + 单次 streamChat", async () => {
    const port = makePort();
    const history = Array.from({ length: 6 }, (_, i) => ({ role: "user", content: `h${i}` }));
    const followupFn = vi.fn(async () => ({ kind: "followup" }));
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => ({ mode: "map-reduce", estimatedCalls: 8 }),
      resolveFollowupContext: followupFn
    });

    await runLadderChat({ msg: { ...makeMsg(), history }, provider: { id: "p" }, port, signal: "sig" }, deps);

    expect(followupFn).toHaveBeenCalledTimes(1);
    expect(deps.trimRecentTurns).toHaveBeenCalledWith(history);
    expect(calls.streamChat).toHaveLength(1);
    // 历史经 trimRecentTurns 封顶（fake: 保留最近 2 轮）
    expect(calls.streamChat[0].history).toEqual(history.slice(-2));
    expect(calls.streamChat[0].context).toEqual({ kind: "followup" });
    expect(calls.mapReduce).toHaveLength(0);
    expect(port.messages).toHaveLength(0);
  });

  it("③a 未命中 + shouldPrompt=true + 确认 → askCostGuard 后走 orchestrateMapReduce", async () => {
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => ({ mode: "map-reduce", estimatedCalls: 8, estimatedTokens: 150000 }),
      buildCostGuardNotice: () => ({ shouldPrompt: true, message: "预计约 8 次调用" })
    });

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal: "sig" }, deps);

    expect(deps.askCostGuard).toHaveBeenCalledWith(port, "预计约 8 次调用");
    expect(deps.pauseIdleTimeout).toHaveBeenCalled();
    expect(calls.mapReduce).toHaveLength(1);
    expect(calls.mapReduce[0]).toMatchObject({ plan: { mode: "map-reduce" }, signal: "sig" });
    expect(port.messages).toHaveLength(0);
  });

  it("③b 未命中 + shouldPrompt=true + 取消 → postMessage stopped，不走 Map-Reduce", async () => {
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => ({ mode: "map-reduce", estimatedCalls: 8 }),
      buildCostGuardNotice: () => ({ shouldPrompt: true, message: "预计约 8 次调用" }),
      askCostGuard: vi.fn(async () => false)
    });

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal: "sig" }, deps);

    expect(deps.askCostGuard).toHaveBeenCalledTimes(1);
    expect(calls.mapReduce).toHaveLength(0);
    expect(port.messages).toEqual([{ type: "stopped", reason: "已取消" }]);
  });

  it("④ 单次 streamChat 返回 overflow → orchestrateMapReduce 被调一次（仅一次）", async () => {
    const port = makePort();
    const { deps, calls } = makeDeps({
      streamChat: vi.fn(async () => "overflow")
    });

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal: "sig" }, deps);

    expect(deps.streamChat).toHaveBeenCalledTimes(1);
    expect(calls.mapReduce).toHaveLength(1);
    expect(calls.mapReduce[0].plan).toEqual({ mode: "single" });
  });

  it("⑤ 追问压缩后 streamChat 返回 overflow → postMessage 追问溢出错误，不转 Map-Reduce", async () => {
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => ({ mode: "map-reduce", estimatedCalls: 8 }),
      resolveFollowupContext: vi.fn(async () => ({ kind: "followup" })),
      streamChat: vi.fn(async () => "overflow")
    });

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal: "sig" }, deps);

    expect(deps.streamChat).toHaveBeenCalledTimes(1);
    expect(calls.mapReduce).toHaveLength(0);
    expect(port.messages).toEqual([
      { type: "error", error: "追问内容仍超出上下文预算，请换个更具体的问题重试" }
    ]);
  });
});
