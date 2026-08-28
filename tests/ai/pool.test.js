// ai/pool.js 有上界并发池测试（08 票）：
// 覆盖并发上限（峰值 ≤ DEFAULT_MAP_CONCURRENCY / concurrency=1 串行）、
// 完成顺序可乱但原始下标正确、signal 中止后不再启动新项、重试语义
// （先败后成 / 连败超限 rethrow / aborted 标记不重试直接 rethrow）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let mod;

async function importModules() {
  vi.resetModules();
  resetModuleState();
  mod = await import("../../extension/ai/pool.js");
}

beforeEach(async () => {
  await importModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("并发上限", () => {
  it("峰值 ≤ DEFAULT_MAP_CONCURRENCY（=3），全部项完成且结果齐全", async () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7];
    let inFlight = 0;
    let peak = 0;
    const done = [];
    const worker = vi.fn(async (item, index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      done.push(index);
      return item * 10;
    });

    const results = await mod.runMapBounded({ items, worker });

    expect(peak).toBeLessThanOrEqual(mod.DEFAULT_MAP_CONCURRENCY);
    expect(mod.DEFAULT_MAP_CONCURRENCY).toBe(3);
    expect(peak).toBe(3); // 8 项 × 5ms 延时下应吃满并发
    expect(results).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
    expect(worker).toHaveBeenCalledTimes(8);
    expect(done).toHaveLength(8);
  });

  it("concurrency=1 时峰值 ≤1（串行）", async () => {
    const items = [0, 1, 2, 3];
    let inFlight = 0;
    let peak = 0;
    const worker = vi.fn(async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return item;
    });

    const results = await mod.runMapBounded({ items, worker, concurrency: 1 });

    expect(peak).toBeLessThanOrEqual(1);
    expect(results).toEqual([0, 1, 2, 3]);
  });
});

describe("原始下标与完成顺序", () => {
  it("完成顺序可乱（手动 resolution），results 仍按原始下标排布、onItemDone 收到原始 index", async () => {
    const items = ["a", "b", "c"];
    const release = [];
    const gates = items.map(
      () =>
        new Promise((resolve) => {
          release.push(resolve);
        })
    );
    // 用每个 item 独有的 gate：3 个 worker 全部启动后，按逆序放行（完成顺序乱掉）
    const worker = vi.fn(async (item, index) => {
      await gates[index];
      return item.toUpperCase();
    });
    const doneIndexes = [];
    const onItemDone = vi.fn((result, index) => {
      doneIndexes.push(index);
    });

    const promise = mod.runMapBounded({ items, worker, onItemDone });

    // 等 3 个 worker 全部进入等待（并发默认 3，全部启动）
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 逆序放行：index 2 先完成，最后 index 0
    for (let i = 2; i >= 0; i--) {
      release[i]();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const results = await promise;
    expect(results).toEqual(["A", "B", "C"]);
    expect(doneIndexes).toEqual([2, 1, 0]);
    // onItemDone 收到的 index 与结果内容一一对应
    const byIndex = new Map(onItemDone.mock.calls.map(([result, index]) => [index, result]));
    expect(byIndex.get(0)).toBe("A");
    expect(byIndex.get(2)).toBe("C");
  });

  it("并发完成顺序错乱时 onItemDone 的 index 仍对应该项原始下标", async () => {
    const items = [10, 20, 30];
    // 完成延迟与 item 值成反比：值越大完成越早，顺序完全乱掉
    const worker = vi.fn(async (item) => {
      await new Promise((resolve) => setTimeout(resolve, 40 - item));
      return item + 1;
    });
    const seen = [];
    const results = await mod.runMapBounded({
      items,
      worker,
      onItemDone: (result, index) => seen.push({ index, result })
    });

    expect(results).toEqual([11, 21, 31]);
    const indexOf = (index) => seen.find((s) => s.index === index).result;
    expect(indexOf(0)).toBe(11);
    expect(indexOf(1)).toBe(21);
    expect(indexOf(2)).toBe(31);
  });
});

describe("signal 中止", () => {
  it("abort 后不再启动新项；已启动的照常收尾，返回已完成的 results", async () => {
    const items = [0, 1, 2, 3, 4, 5];
    const controller = new AbortController();
    const started = [];
    let startedCount = 0;
    const worker = vi.fn(async (item, index) => {
      startedCount += 1;
      started.push(index);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return item;
    });
    // 3 个并发启动后中止
    const promise = mod.runMapBounded({ items, worker, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    const results = await promise;
    expect(startedCount).toBeLessThan(items.length);
    // 已启动的项全部完成（它们的 index 都在 results 中）
    const finished = results.filter((r) => r != null);
    expect(finished).toHaveLength(started.length);
    for (const index of started) {
      expect(results[index]).toBe(index);
    }
  });

  it("abort 时若已启动的 worker 抛 aborted 标记错误，整体 rethrow 该错误", async () => {
    const items = [0, 1, 2, 3];
    const controller = new AbortController();
    const abortError = new Error("已停止生成");
    abortError.aborted = true;
    const worker = vi.fn(async (item) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw abortError;
    });
    const promise = mod.runMapBounded({ items, worker, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    await expect(promise).rejects.toBe(abortError);
    // aborted 标记错误不重试：每项至多尝试 1 次
    expect(worker).toHaveBeenCalledTimes(3);
  });
});

describe("重试语义", () => {
  it("先失败 1 次再成功 → 最终拿到成功结果且调用次数正确", async () => {
    const items = ["x", "y"];
    const calls = new Map();
    const worker = vi.fn(async (item, index) => {
      const count = (calls.get(index) || 0) + 1;
      calls.set(index, count);
      if (count === 1) {
        throw new Error("网络错误：boom");
      }
      return item + "!";
    });

    const results = await mod.runMapBounded({ items, worker });

    expect(results).toEqual(["x!", "y!"]);
    // 每项初始 1 次 + 1 次重试
    expect(calls.get(0)).toBe(2);
    expect(calls.get(1)).toBe(2);
  });

  it("连续失败超过 MAX_MAP_RETRIES → rethrow 最后错误", async () => {
    const items = ["x"];
    const failError = new Error("HTTP 500");
    const worker = vi.fn(async () => {
      throw failError;
    });

    await expect(mod.runMapBounded({ items, worker })).rejects.toBe(failError);
    // 初始 1 次 + MAX_MAP_RETRIES(2) 次重试 = 3 次尝试
    expect(worker).toHaveBeenCalledTimes(mod.MAX_MAP_RETRIES + 1);
    expect(mod.MAX_MAP_RETRIES).toBe(2);
  });

  it("带 aborted 标记的错误不重试、直接 rethrow", async () => {
    const items = ["x"];
    const abortError = new Error("已停止生成");
    abortError.aborted = true;
    const worker = vi.fn(async () => {
      throw abortError;
    });

    await expect(mod.runMapBounded({ items, worker })).rejects.toBe(abortError);
    expect(worker).toHaveBeenCalledTimes(1);
  });

  it("单段重试耗尽（rethrow）前，先完成的其它段已通过 onItemDone 回吐", async () => {
    const items = ["ok1", "bad", "ok2"];
    const badError = new Error("boom");
    const release = [];
    const gates = items.map(() => new Promise((resolve) => release.push(resolve)));
    const doneResults = [];
    const worker = vi.fn(async (item) => {
      await gates[items.indexOf(item)];
      if (item === "bad") throw badError;
      return item;
    });

    const promise = mod.runMapBounded({
      items,
      worker,
      onItemDone: (result) => doneResults.push(result)
    });

    // 等 3 项全部进入等待
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 先放行两个 ok 段：它们完成并通过 onItemDone 回吐
    release[0]();
    release[2]();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 再放行 bad 段：反复失败耗尽重试 → rethrow（ok 段结果已回吐，不丢失）
    release[1]();

    await expect(promise).rejects.toBe(badError);
    expect(doneResults).toEqual(["ok1", "ok2"]);
  });
});
