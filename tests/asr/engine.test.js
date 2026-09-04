// engine.js（ASR 转写调度引擎）测试：活队列调度 / 并发上限 / 逐片重试 /
// 失败计数（Q8a）/ 中止探针 / 逐片交付回调。纯模块单测——transcribe 注入
// fake（deferred 门控），不依赖 chrome / AudioContext / 真实网络。
// retryAsync 用真实实现（经 spyOn 记录参数的透传 mock），同时验证
// ① 重试参数与 pipeline.js transcribeChunk 完全一致 (2, 500)；
// ② error.retryable=true / 网络错误才重试的真实语义。

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTranscriptionEngine,
  transcribeChunk,
  DEFAULT_RETRIES,
  DEFAULT_RETRY_DELAY_MS
} from "../../extension/asr/engine.js";
import { ASR_CONCURRENCY } from "../../extension/shared/offscreen-constants.js";
import * as errorHelpers from "../../extension/shared/error-helpers.js";

// 真实 retryAsync：必须在首次 spyOn 之前捕获原函数引用（clearMocks 不恢复
// 实现，beforeEach 里重复 spyOn 时若再从命名空间取会拿到 spy 自身导致递归）。
const realRetryAsync = errorHelpers.retryAsync;

// makeChunk：合成切片，形状对齐 chunkHost 回传的 { index, startSec,
// durationSec, wavBlob }（统一 20 分钟片 → startSec 间隔 600）。
function makeChunk(index, extra = {}) {
  return {
    index,
    startSec: index * 600,
    durationSec: 600,
    wavBlob: { tag: `wav-${index}` },
    ...extra
  };
}

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// 计数信号量 fake transcribe：记录峰值并发，制造可控延迟。
function makeCountingTranscribe(delayMs = 5) {
  let active = 0;
  let peak = 0;
  const transcribe = async (chunk) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, delayMs));
    active -= 1;
    return { text: `片 ${chunk.index}` };
  };
  return { transcribe, getPeak: () => peak };
}

// 可重试错误工厂：error.retryable === true（shared/error-helpers 的重试判据之一）
function makeRetryableError(message = "转写请求失败") {
  const err = new Error(message);
  err.retryable = true;
  return err;
}

let retryCalls;

beforeEach(() => {
  retryCalls = [];
  // 透传 spy：记录 engine 每次调用 retryAsync 的 (retries, delayMs) 参数，
  // 重试语义仍走真实实现（含指数退避：首重 250ms / 次重 500ms）。
  vi.spyOn(errorHelpers, "retryAsync").mockImplementation((task, retries, delayMs) => {
    retryCalls.push({ retries, delayMs });
    return realRetryAsync(task, retries, delayMs);
  });
});

describe("transcribeChunk 单片语义（镜像 pipeline transcribeChunk）", () => {
  it("返回 { ...result, durationSec }；进度经注入 transcribe 的 ctx.onProgress 透传", async () => {
    const onProgress = vi.fn();
    const transcribe = vi.fn(async (chunk, ctx) => {
      ctx.onProgress();
      ctx.onProgress();
      return { text: "你好", segments: [{ start: 0, end: 1, text: "你" }] };
    });
    const chunk = makeChunk(2, { durationSec: 1200 });

    const result = await transcribeChunk({ chunk, transcribe, onProgress });

    expect(result).toEqual({
      text: "你好",
      segments: [{ start: 0, end: 1, text: "你" }],
      durationSec: 1200
    });
    // 文案与 pipeline 一致：片号 = chunk.index + 1
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, "语音识别中 3 片…");
    expect(onProgress).toHaveBeenNthCalledWith(2, "语音识别中 3 片…");
  });

  it("可重试错误（error.retryable=true）：经 retryAsync(2, 500) 重试后成功", async () => {
    let attempts = 0;
    const transcribe = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw makeRetryableError();
      }
      return { text: "重试成功" };
    });

    const result = await transcribeChunk({ chunk: makeChunk(0), transcribe });

    expect(result).toEqual({ text: "重试成功", durationSec: 600 });
    expect(transcribe).toHaveBeenCalledTimes(2);
    // 与 pipeline.js transcribeChunk 完全一致的重试参数
    expect(retryCalls).toEqual([{ retries: DEFAULT_RETRIES, delayMs: DEFAULT_RETRY_DELAY_MS }]);
    // 并发上限经 eval/ 并发扫描实测标定为 10（硅基流动最优解，见 offscreen-constants.ts 注释）
    expect(ASR_CONCURRENCY).toBe(10);
  });

  it("不可重试错误直接上抛（一次尝试，不重试）", async () => {
    const transcribe = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(transcribeChunk({ chunk: makeChunk(0), transcribe })).rejects.toThrow("boom");
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
});

describe("createTranscriptionEngine 活队列调度", () => {
  it("并发上限 ≤5：12 片连续 push，峰值并发恰为 5，全部完成", async () => {
    const counting = makeCountingTranscribe(5);
    const engine = createTranscriptionEngine({ transcribe: counting.transcribe, concurrency: 5 });

    for (let i = 0; i < 12; i += 1) {
      expect(engine.push(makeChunk(i))).toBe(true);
    }
    const summary = await engine.close();

    expect(counting.getPeak()).toBeLessThanOrEqual(5);
    expect(counting.getPeak()).toBe(5);
    expect(summary).toMatchObject({ acceptedChunks: 12, completedChunks: 12, failedChunks: 0 });
  });

  it("活喂入：push 发生在部分片仍在途时——新片占满空位、超出部分排队，全部被处理", async () => {
    const gates = new Map(); // 慢片 index → deferred
    const transcribe = vi.fn(async (chunk) => {
      if (chunk.fast) {
        return { text: `fast-${chunk.index}` };
      }
      const gate = makeDeferred();
      gates.set(chunk.index, gate);
      return gate.promise;
    });
    const delivered = [];
    const engine = createTranscriptionEngine({
      transcribe,
      concurrency: 5,
      onChunkResult: (chunk, result) => delivered.push({ index: chunk.index, text: result.text })
    });

    // 3 个慢片占 3 个空位（在途）
    engine.push(makeChunk(0));
    engine.push(makeChunk(1));
    engine.push(makeChunk(2));
    expect(transcribe).toHaveBeenCalledTimes(3);

    // 在途期间继续喂 3 个快片：2 个立即启动（并发 5 封顶），1 个排队
    engine.push(makeChunk(3, { fast: true }));
    engine.push(makeChunk(4, { fast: true }));
    engine.push(makeChunk(5, { fast: true }));
    expect(transcribe).toHaveBeenCalledTimes(5);

    // 释放慢片 → 排队片启动，全部消化
    for (const gate of gates.values()) {
      gate.resolve({ text: "slow" });
    }
    const summary = await engine.close();

    expect(transcribe).toHaveBeenCalledTimes(6);
    expect(summary).toMatchObject({ acceptedChunks: 6, completedChunks: 6, failedChunks: 0 });
    expect(delivered).toHaveLength(6);
  });

  it("close 是流结束标记：在途 + 排队片全部消化后才 resolve", async () => {
    let gatedCount = 0;
    const gates = [];
    const transcribe = vi.fn(async () => {
      if (gatedCount < 5) {
        gatedCount += 1;
        const gate = makeDeferred();
        gates.push(gate);
        return gate.promise;
      }
      // close 后从排队位启动的片：立即完成
      return { text: "late" };
    });
    const engine = createTranscriptionEngine({ transcribe });

    for (let i = 0; i < 7; i += 1) {
      engine.push(makeChunk(i));
    }
    const closing = engine.close(); // 5 在途 + 2 排队
    gates.forEach((gate) => gate.resolve({ text: "t" }));

    const summary = await closing;
    expect(transcribe).toHaveBeenCalledTimes(7);
    expect(summary).toMatchObject({ acceptedChunks: 7, completedChunks: 7, droppedByAbort: 0 });
  });

  it("close 后 push 拒绝；close 幂等；空引擎 close 立即返回零汇总", async () => {
    const transcribe = vi.fn(async () => ({ text: "x" }));
    const engine = createTranscriptionEngine({ transcribe });

    const empty = await engine.close();
    expect(empty).toEqual({
      acceptedChunks: 0,
      completedChunks: 0,
      failedChunks: 0,
      droppedByAbort: 0,
      failures: [],
      aborted: false
    });
    expect(engine.push(makeChunk(0))).toBe(false);
    expect(transcribe).not.toHaveBeenCalled();

    const again = await engine.close();
    expect(again).toBe(empty); // 重复 close 返回同一 promise 的同一汇总
  });
});

describe("失败计数（Q8a）与逐片交付", () => {
  it("可重试错误重试成功不计失败；重试耗尽仍失败 → 跳过并计 failedChunks", async () => {
    // 耗尽路径：retries=2 → 首次 + 2 次重试共 3 次尝试，随后按失败片跳过
    const transcribe = vi.fn(async () => {
      throw makeRetryableError("HTTP 503");
    });
    const engine = createTranscriptionEngine({ transcribe });

    engine.push(makeChunk(0));
    const summary = await engine.close();

    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(summary.completedChunks).toBe(0);
    expect(summary.failedChunks).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].chunk.index).toBe(0);
    expect(summary.failures[0].error).toMatchObject({ message: "HTTP 503", retryable: true });
  });

  it("不可重试错误：该片一次尝试即跳过计 failed，失败片的 chunk 数据不影响其余片", async () => {
    const transcribe = vi.fn(async (chunk) => {
      if (chunk.index === 1) {
        throw new Error("平台 baseUrl 未配置");
      }
      return { text: `文本 ${chunk.index}` };
    });
    const delivered = [];
    const engine = createTranscriptionEngine({
      transcribe,
      onChunkResult: (chunk, result) => delivered.push({ index: chunk.index, text: result.text })
    });

    [0, 1, 2, 3].forEach((i) => engine.push(makeChunk(i)));
    const summary = await engine.close();

    // 失败片非网络错误不重试：4 片各尝试 1 次
    expect(transcribe).toHaveBeenCalledTimes(4);
    expect(summary).toMatchObject({ acceptedChunks: 4, completedChunks: 3, failedChunks: 1 });
    expect(summary.failures[0].chunk.index).toBe(1);
    const byIndex = [...delivered].sort((a, b) => a.index - b.index);
    expect(byIndex.map((d) => d.index)).toEqual([0, 2, 3]);
    expect(byIndex.map((d) => d.text)).toEqual(["文本 0", "文本 2", "文本 3"]);
  });

  it("逐片交付按完成顺序回调（非 push 顺序），次数 = 成功片数；交付回调抛错不影响调度", async () => {
    const gates = [];
    const transcribe = vi.fn(async () => {
      const gate = makeDeferred();
      gates.push(gate);
      return gate.promise;
    });
    const deliveryAttempts = []; // 每次交付回调的尝试记录（含抛错那次）
    const delivered = []; // 成功交付（回调未抛错）的片
    const engine = createTranscriptionEngine({
      transcribe,
      onChunkResult: (chunk, result) => {
        deliveryAttempts.push(chunk.index);
        if (deliveryAttempts.length === 1) {
          throw new Error("port 已断开"); // 模拟 postMessage 抛错
        }
        delivered.push({ index: chunk.index, text: result.text });
      }
    });

    [0, 1, 2].forEach((i) => engine.push(makeChunk(i)));
    // 宏任务屏障：让各片的 await 链（async fn 返回值 adoption）先挂载到各自
    // 的 gate promise 上——否则 push 与 resolve 同处一个同步块，级联顺序由
    // 订阅顺序而非 resolve 顺序决定，交付顺序断言失去意义。
    await new Promise((r) => setTimeout(r, 0));
    // 完成顺序 2 → 0 → 1（与 push 顺序不同）
    gates[2].resolve({ text: "C" });
    gates[0].resolve({ text: "A" });
    gates[1].resolve({ text: "B" });
    const summary = await engine.close();

    // 交付回调次数 = 成功片数，且按完成顺序调用
    expect(deliveryAttempts).toEqual([2, 0, 1]);
    expect(delivered).toEqual([
      { index: 0, text: "A" },
      { index: 1, text: "B" }
    ]);
    // 交付回调抛错的那片仍计完成（转写本身成功）
    expect(summary.completedChunks).toBe(3);
    expect(summary.failedChunks).toBe(0);
  });
});

describe("中止探针", () => {
  it("isAborted 置真后不再发起新转写，排队片丢弃清点，close 如实返回", async () => {
    let aborted = false;
    const gates = [];
    const transcribe = vi.fn(async () => {
      const gate = makeDeferred();
      gates.push(gate);
      return gate.promise;
    });
    const delivered = [];
    const engine = createTranscriptionEngine({
      transcribe,
      concurrency: 5,
      isAborted: () => aborted,
      onChunkResult: (chunk) => delivered.push(chunk.index)
    });

    for (let i = 0; i < 8; i += 1) {
      engine.push(makeChunk(i));
    }
    expect(transcribe).toHaveBeenCalledTimes(5); // 并发封顶，3 片排队

    aborted = true; // 模拟 offscreen port 断连
    expect(engine.push(makeChunk(8))).toBe(false); // 中止后 push 拒绝

    gates.forEach((gate) => gate.resolve({ text: "在途完成" }));
    const summary = await engine.close();

    expect(transcribe).toHaveBeenCalledTimes(5); // 未发起新转写
    expect(summary).toEqual({
      acceptedChunks: 8,
      completedChunks: 5,
      failedChunks: 0,
      droppedByAbort: 3,
      failures: [],
      aborted: true
    });
    expect(delivered).toHaveLength(5); // 在途片成果仍交付
  });

  it("在途片失败 + 中止并存：计数如实（completed + failed + dropped = accepted）", async () => {
    let aborted = false;
    const gates = [];
    const transcribe = vi.fn(async (chunk) => {
      const gate = makeDeferred();
      gates.push({ index: chunk.index, gate });
      return gate.promise;
    });
    const engine = createTranscriptionEngine({
      transcribe,
      concurrency: 5,
      isAborted: () => aborted
    });

    for (let i = 0; i < 7; i += 1) {
      engine.push(makeChunk(i));
    }
    aborted = true;
    gates.forEach(({ index, gate }) => {
      if (index === 2) {
        gate.reject(new Error("boom")); // 在途片失败：计 failed 不计 dropped
      } else {
        gate.resolve({ text: "t" });
      }
    });
    const summary = await engine.close();

    expect(transcribe).toHaveBeenCalledTimes(5);
    expect(summary.acceptedChunks).toBe(7);
    expect(summary.completedChunks).toBe(4);
    expect(summary.failedChunks).toBe(1);
    expect(summary.droppedByAbort).toBe(2);
    expect(summary.aborted).toBe(true);
  });
});

describe("HTTP 状态码重试判定（isRetryableNetworkError 按状态收紧）", () => {
  // 对齐适配器（openai-transcriptions）抛出的 HTTP 错误形状：message + err.status
  function makeHttpError(status, detail = "") {
    const err = new Error(`HTTP ${status}${detail ? `: ${detail}` : ""}`);
    err.status = status;
    return err;
  }

  it("401：确定性鉴权失败，经 retryAsync 一次尝试即跳过计 failed（不重试）", async () => {
    const transcribe = vi.fn(async () => {
      throw makeHttpError(401, "invalid api key");
    });
    const engine = createTranscriptionEngine({ transcribe });

    engine.push(makeChunk(0));
    const summary = await engine.close();

    // 旧消息启发式（"http " 即重试）会重试 3 次；收紧后按 status 判定只试 1 次
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(summary.completedChunks).toBe(0);
    expect(summary.failedChunks).toBe(1);
    expect(summary.failures[0].error).toMatchObject({
      message: "HTTP 401: invalid api key",
      status: 401
    });
  });

  it("429：限流可重试，重试一次后成功", async () => {
    let attempts = 0;
    const transcribe = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw makeHttpError(429);
      }
      return { text: "限流重试成功" };
    });

    const result = await transcribeChunk({ chunk: makeChunk(0), transcribe });

    expect(result).toEqual({ text: "限流重试成功", durationSec: 600 });
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("500：服务端错误可重试，耗尽 retries=2（共 3 次尝试）计 failed", async () => {
    const transcribe = vi.fn(async () => {
      throw makeHttpError(500, "internal error");
    });
    const engine = createTranscriptionEngine({ transcribe });

    engine.push(makeChunk(0));
    const summary = await engine.close();

    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(summary.completedChunks).toBe(0);
    expect(summary.failedChunks).toBe(1);
    expect(summary.failures[0].error).toMatchObject({ message: "HTTP 500: internal error", status: 500 });
  });

  it("400：参数类确定性失败，不重试一次尝试即失败", async () => {
    const transcribe = vi.fn(async () => {
      throw makeHttpError(400, "bad request");
    });
    const engine = createTranscriptionEngine({ transcribe });

    engine.push(makeChunk(0));
    const summary = await engine.close();

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(summary.failedChunks).toBe(1);
  });

  it("无 status 的错误维持消息启发式：网关 'HTTP 404' 消息仍判可重试（其他域行为不回退）", () => {
    // bilibili 网关只把状态码写进消息文本（无 err.status），收紧不得误伤
    expect(errorHelpers.isRetryableNetworkError(new Error("HTTP 404"))).toBe(true);
    expect(errorHelpers.isRetryableNetworkError(new Error("请求失败：502"))).toBe(true);
    // 非正数的 status 不是有效 HTTP 状态码（适配器 -1 哨兵）→ 落回消息启发式
    expect(errorHelpers.isRetryableNetworkError({ message: "响应体不是合法 JSON", status: -1 })).toBe(false);
  });
});
