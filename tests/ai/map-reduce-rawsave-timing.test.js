// ai/map-reduce 原始字幕段盘 fire-and-forget 时序测试（#10）：
// 原始段落盘是追问用的按需缓存，写盘不阻塞段小结的模型调用（fire-and-forget，
// 缺段时追问路径回落完整 Map-Reduce，竞态代价只是多一次模型调用）；小结盘仍是
// await（复用语义依赖）；段盘写盘最终失败（{ok:false} / reject）汇入
// notifyCacheWriteError 且不向上抛。
// 段缓存经 orchestrateMapReduce 的 segmentCache 注入缝换成可控桩
//（arch-review-2026-09/05：宿主迁 SW 后段缓存不再静态入 chunk，模块 mock 换
// deps 桩），模型调用经既有 chatCompletion 注入缝；段盘 promise 在编排结束后
// 才手动 settle，若实现缺 .catch，vitest 会以 unhandled error 判本文件失败
//（用例 A/C 隐式覆盖）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, makeSubtitleBody } from "../setup.js";

const segmentCache = vi.hoisted(() => ({
  loadSummary: vi.fn(),
  saveSummary: vi.fn(),
  saveRaw: vi.fn()
}));

let mod;

async function importModules() {
  vi.resetModules();
  resetModuleState();
  mod = await import("../../extension/ai/map-reduce.js");
}

beforeEach(async () => {
  // clearMocks 只清调用记录不清实现，这里统一重设默认行为：
  // 小结缓存未命中、两类写盘成功
  segmentCache.loadSummary.mockResolvedValue(null);
  segmentCache.saveSummary.mockResolvedValue({ ok: true });
  segmentCache.saveRaw.mockResolvedValue({ ok: true });
  await importModules();
});

function makeProvider() {
  return { baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" };
}

function makeContext() {
  return {
    title: "测试视频",
    bvid: "BV1test",
    cid: "123",
    selectedSubtitleId: "sub-1",
    subtitleBody: [],
    chapters: []
  };
}

function makePort() {
  return { postMessage: vi.fn() };
}

async function makePlan() {
  const { buildBudgetPlan } = await import("../../extension/ai/budgeter.js");
  return buildBudgetPlan({ body: makeSubtitleBody(210000), chapters: [] });
}

// 可控 promise：外部手动 resolve/reject（时序锁的载体）
function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// 排空微任务队列（真实计时器：一个宏任务边界足以冲刷全部挂起的微任务链）
function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// 依 messages[user].content 识别分段小结/成稿调用
function isSegmentCall(input) {
  return String(input.messages?.at(-1)?.content || "").includes("连续片段");
}

function cacheWriteNotices(port) {
  return port.postMessage.mock.calls
    .map((c) => c[0])
    .filter((m) => m.type === "notice" && String(m.data || "").includes("缓存写入失败"));
}

describe("原始段盘 fire-and-forget（#10）", () => {
  it("用例A：分段模型调用先于段盘写盘 resolve（写盘不阻塞模型调用）", async () => {
    const plan = await makePlan();
    expect(plan.segments).toHaveLength(5);

    const events = [];
    const deferreds = [];
    segmentCache.saveRaw.mockImplementation(({ segments: items }) => {
      const d = makeDeferred();
      deferreds.push(d);
      events.push(`rawsave:start:${items.length}`);
      return d.promise;
    });
    let segmentCalls = 0;
    const chatImpl = vi.fn(async (input) => {
      if (!isSegmentCall(input)) {
        events.push("model:note");
        return "# 视频笔记：《测试视频》\n完整笔记正文。";
      }
      segmentCalls += 1;
      events.push("model:segment");
      return `小结${segmentCalls}。`;
    });

    const port = makePort();
    const orchestration = mod.orchestrateMapReduce({ provider: makeProvider(), context: makeContext(), plan, port, chatCompletion: chatImpl, segmentCache });

    // 段盘全部挂起期间：五个分段小结的模型调用应已全部发出（fire-and-forget 生效）
    await flushMicrotasks();
    expect(events.filter((e) => e === "model:segment")).toHaveLength(5);
    expect(deferreds).toHaveLength(5);

    // 段盘 resolve 全部发生在模型调用之后（时序锁）
    deferreds.forEach((d, i) => {
      events.push(`rawsave:resolved:${i}`);
      d.resolve({ ok: true });
    });
    await flushMicrotasks();
    const lastModelSegment = events.lastIndexOf("model:segment");
    const firstResolved = events.findIndex((e) => e.startsWith("rawsave:resolved:"));
    expect(lastModelSegment).toBeLessThan(firstResolved);

    // 段盘 promise resolve 后无未处理 rejection（vitest 全局监听，出现即判失败）
    const result = await orchestration;
    expect(result.aborted).toBe(false);
    expect(result.draft).toBe("# 视频笔记：《测试视频》\n完整笔记正文。");
    expect(cacheWriteNotices(port)).toHaveLength(0);
  });

  it("用例B：小结盘仍 await——saveSegmentSummary resolve 前编排不结算", async () => {
    const plan = await makePlan();
    const deferreds = [];
    segmentCache.saveSummary.mockImplementation(() => {
      const d = makeDeferred();
      deferreds.push(d);
      return d.promise;
    });
    const chatImpl = vi.fn(async (input) => (isSegmentCall(input) ? "小结。" : "# 视频笔记：《测试视频》\n完整笔记正文。"));

    const port = makePort();
    const orchestration = mod.orchestrateMapReduce({ provider: makeProvider(), context: makeContext(), plan, port, chatCompletion: chatImpl, segmentCache });

    // 首波三段（并发 3）模型调用完成、小结盘全部挂起：成稿未开始、无 done/token 回吐
    await flushMicrotasks();
    expect(chatImpl).toHaveBeenCalledTimes(3);
    expect(deferreds).toHaveLength(3);
    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    expect(postMessages.some((m) => m.type === "done")).toBe(false);
    expect(postMessages.some((m) => m.type === "token")).toBe(false);

    // 放行小结盘 → 编排才结算（复用语义依赖不变）。并发 3 共两波：已 resolve 的
    // 重复 resolve 无害，第二波新挂起的小结盘靠第二次放行收尾。
    deferreds.forEach((d) => d.resolve({ ok: true }));
    await flushMicrotasks();
    deferreds.forEach((d) => d.resolve({ ok: true }));
    const result = await orchestration;
    expect(result.aborted).toBe(false);
    expect(chatImpl).toHaveBeenCalledTimes(6);
    expect(port.postMessage.mock.calls.map((c) => c[0]).some((m) => m.type === "done")).toBe(true);
  });

  it("用例C：段盘写盘 {ok:false} / reject → 均汇入 notifyCacheWriteError（去重提示一次）且不向上抛", async () => {
    const plan = await makePlan();
    const chatImpl = vi.fn(async (input) => (isSegmentCall(input) ? "小结。" : "# 视频笔记：《测试视频》\n完整笔记正文。"));

    // 变体一：写盘最终失败返回 {ok:false}（现状契约路径）
    segmentCache.saveRaw.mockResolvedValue({ ok: false });
    const port1 = makePort();
    const result1 = await mod.orchestrateMapReduce({ provider: makeProvider(), context: makeContext(), plan, port: port1, chatCompletion: chatImpl, segmentCache });
    expect(result1.aborted).toBe(false);
    expect(result1.draft).toBe("# 视频笔记：《测试视频》\n完整笔记正文。");
    expect(cacheWriteNotices(port1)).toHaveLength(1);

    // 变体二：写盘 reject（防御路径）——同样汇入、不向上抛、无 unhandled rejection
    segmentCache.saveRaw.mockRejectedValue(new Error("quota"));
    const port2 = makePort();
    const result2 = await mod.orchestrateMapReduce({ provider: makeProvider(), context: makeContext(), plan, port: port2, chatCompletion: chatImpl, segmentCache });
    expect(result2.aborted).toBe(false);
    expect(result2.draft).toBe("# 视频笔记：《测试视频》\n完整笔记正文。");
    expect(cacheWriteNotices(port2)).toHaveLength(1);
    // 模型调用不受段盘失败影响
    expect(chatImpl).toHaveBeenCalledTimes(12);
  });
});
