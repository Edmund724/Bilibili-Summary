// createSubtitleWaiter 工厂测试：一键总结「等待抓取/音频转写完成」的轮询状态机。
// 依赖全注入（pollContext / 通知 / 定时器），无 DOM、无 chrome，纯 Node 时序验证。
// 锁定的时序约定见 sidepanel-subtitle-wait.js 头部注释：
// 就绪放行、pending 轮询+提示、读取失败放行 false、kick 提前补轮、tick 去重、
// 新等待使旧等待失效、finish 后定时器作废。

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSubtitleWaiter } from "../../extension/pages/sidepanel-subtitle-wait.js";

const POLL_MS = 4000;

// 受控 fake：手动 timer 队列 + notice 记录 + 可编程轮询结果序列。
// pollResults 为数组，超出长度时重复最后一项；元素可为函数（动态返回）。
function makeHarness(pollResults, { pollIntervalMs = POLL_MS } = {}) {
  const timers = [];
  let timerSeq = 0;
  let pollIndex = 0;
  const deps = {
    pollIntervalMs,
    pollContext: vi.fn(async () => {
      const item = pollResults[Math.min(pollIndex, pollResults.length - 1)];
      pollIndex += 1;
      return typeof item === "function" ? await item() : item;
    }),
    showWaitingNotice: vi.fn(),
    removeNotice: vi.fn(),
    setTimer: vi.fn((fn, ms) => {
      const handle = { id: ++timerSeq, fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    }),
    clearTimer: vi.fn((handle) => {
      handle.cleared = true;
      const index = timers.indexOf(handle);
      if (index >= 0) {
        timers.splice(index, 1);
      }
    })
  };
  const waiter = createSubtitleWaiter(deps);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  // 触发最早挂起的定时器（模拟轮询间隔到达）
  const fireNextTimer = async () => {
    const timer = timers.shift();
    if (!timer) {
      throw new Error("no pending timer");
    }
    timer.fn();
    await flush();
  };
  return { deps, waiter, timers, flush, fireNextTimer };
}

const READY = { ok: true, pending: false };
const PENDING = { ok: true, pending: true };
const FAILED = { ok: false, pending: false };

describe("createSubtitleWaiter", () => {
  let harness;

  beforeEach(() => {
    harness = makeHarness([READY]);
  });

  it("首次轮询即就绪：resolve true，不显示等待提示，不留定时器", async () => {
    const result = await harness.waiter.wait();

    expect(result).toBe(true);
    expect(harness.deps.pollContext).toHaveBeenCalledTimes(1);
    expect(harness.deps.showWaitingNotice).not.toHaveBeenCalled();
    expect(harness.deps.removeNotice).toHaveBeenCalledTimes(1);
    expect(harness.timers).toHaveLength(0);
  });

  it("pending 期间显示提示并按间隔轮询，就绪后 resolve true 并清理提示", async () => {
    harness = makeHarness([PENDING, PENDING, READY]);
    const promise = harness.waiter.wait();
    await harness.flush();

    expect(harness.deps.showWaitingNotice).toHaveBeenCalledTimes(1);
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0].ms).toBe(POLL_MS);

    await harness.fireNextTimer();
    expect(harness.deps.pollContext).toHaveBeenCalledTimes(2);
    expect(harness.deps.showWaitingNotice).toHaveBeenCalledTimes(2); // 每轮 pending 重复提示（幂等显示）

    await harness.fireNextTimer();
    expect(await promise).toBe(true);
    expect(harness.deps.removeNotice).toHaveBeenCalledTimes(1);
    expect(harness.timers).toHaveLength(0);
  });

  it("轮询读取失败：resolve false", async () => {
    harness = makeHarness([FAILED]);

    expect(await harness.waiter.wait()).toBe(false);
    expect(harness.deps.removeNotice).toHaveBeenCalledTimes(1);
    expect(harness.timers).toHaveLength(0);
  });

  it("pending 期间 kick()：立即补一轮轮询，不等定时器", async () => {
    harness = makeHarness([PENDING, READY]);
    const promise = harness.waiter.wait();
    await harness.flush();

    expect(harness.deps.pollContext).toHaveBeenCalledTimes(1);
    harness.waiter.kick();
    await harness.flush();
    expect(harness.deps.pollContext).toHaveBeenCalledTimes(2);

    expect(await promise).toBe(true);
  });

  it("tick 进行中重复 kick()：去重，不并发多轮轮询", async () => {
    let releasePoll;
    harness = makeHarness([
      () => new Promise((resolve) => {
        releasePoll = resolve;
      }),
      READY
    ]);
    const promise = harness.waiter.wait();
    await harness.flush();
    expect(harness.deps.pollContext).toHaveBeenCalledTimes(1);

    harness.waiter.kick();
    harness.waiter.kick();
    harness.waiter.kick();
    await harness.flush();
    // 第一轮 poll 挂起期间，kick 全部被 ticking 去重
    expect(harness.deps.pollContext).toHaveBeenCalledTimes(1);

    releasePoll(PENDING);
    await harness.flush();
    // 第一轮结束后 pending 挂了下一轮 timer；kick 在 ticking 中已被去重，
    // 这里手动推进定时器走第二轮（READY）收尾
    await harness.fireNextTimer();
    expect(await promise).toBe(true);
  });

  it("新 wait() 使旧等待立即失效（resolve false），旧定时器作废", async () => {
    harness = makeHarness([PENDING, READY]);
    const first = harness.waiter.wait();
    await harness.flush();
    expect(harness.timers).toHaveLength(1);

    const second = harness.waiter.wait();
    expect(await first).toBe(false);
    expect(harness.timers).toHaveLength(0); // 旧等待的轮询定时器已作废

    expect(await second).toBe(true);
  });

  it("finish 后挂着的定时器不触发（不再轮询）", async () => {
    harness = makeHarness([READY]);
    await harness.waiter.wait();
    expect(harness.timers).toHaveLength(0);

    // 即便外部伪造定时器触发，也不应再产生轮询
    const pollsBefore = harness.deps.pollContext.mock.calls.length;
    harness.waiter.kick(); // 无等待在跑时 kick 是 no-op
    expect(harness.deps.pollContext.mock.calls.length).toBe(pollsBefore);
  });
});
