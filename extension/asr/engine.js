// extension/asr/engine.js
// ASR 转写调度引擎：活队列 + 逐片重试 + 失败计数 + 中止探针。纯调度模块——
// 不触 UI/DOM，不 import entry/pages/subtitle 与 adapters/，transcribe 由接线层
// 注入（adapters/openai-transcriptions.js 的组装归 ②-2 的 offscreen 接线层）。
//
// 为 ②-2 准备：把转写搬进 offscreen document 与解码同 context，解码过程中
// chunk 陆续产出（活队列 push 喂入），每片完成即经 onChunkResult 交付（接线层
// 拿到就往 port 发 chunk-result，不等全部完成），页面只收转写文本。
//
// 调度模式与旧 pipeline.js runWithConcurrency（固定批次：全部解码完 → 一次性
// 建 task 数组，该函数已随转写迁出页面而删除）的差异：push(chunk) 可在运行中
// 持续喂入，解码与转写流水线重叠；并发上限取 shared/offscreen-constants.js 的
// ASR_CONCURRENCY（offscreen 接线层 ASR_ADAPTERS 注入同一常量）；close() 是
// 流结束标记——之后不再接受新 chunk，排队与在途片全部消化后 resolve 汇总。
//
// 单片语义（原 pipeline.js transcribeChunk，随调度引擎保留在此）：
//   - retryAsync(task, 2, 500)：isRetryableNetworkError 或 error.retryable===true
//     才重试，指数退避上限 5000ms（shared/error-helpers 实现）；
//   - 进度：onProgress thunk 交给注入的 transcribe（接线层透传给适配器，适配器
//     每次请求后调用），文案 `语音识别中 ${chunk.index + 1} 片…`，接线层经
//     port 原样中继给页面；
//   - 返回形状：{ ...result, durationSec: chunk.durationSec }——mergeChunkResults
//     的单片输入契约（text / segments[{start,end,text}] / 可选 _asrDiag）；
//   - pipeline 的 ensureActive() 后置守卫在 offscreen 侧由 isAborted() 轮询替代：
//     置真后停止调度新片，已完成的片结果仍交付（成果不丢）。
//
// 失败口径（Q8a）：重试耗尽仍失败的片跳过并计数，不中止整条管线——与
// mergeChunkResults 对 Error 结果静默跳过的口径一致；close() 汇总
// completedChunks / failedChunks / failures。

import { getErrorMessage, retryAsync } from "../shared/error-helpers.js";
import { logWarn } from "../shared/logging.js";
import { ASR_CONCURRENCY } from "../shared/offscreen-constants.js";

// 每片重试参数：与原 pipeline.js transcribeChunk 的 retryAsync(task, 2, 500) 一致
export const DEFAULT_RETRIES = 2;
export const DEFAULT_RETRY_DELAY_MS = 500;

// 逐片转写（含重试）。transcribe 为注入的转写函数：(chunk, { onProgress }) =>
// Promise<result>（result: { text, segments?, _asrDiag? }，multipart/adapter
// 组装在接线层）。重试耗尽仍失败 → 上抛（调度层捕获计数，不中止管线）。
export async function transcribeChunk({
  chunk,
  transcribe,
  onProgress,
  retries = DEFAULT_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS
}) {
  if (typeof transcribe !== "function") {
    throw new Error("transcribeChunk 需要注入 transcribe 函数");
  }
  const task = () =>
    transcribe(chunk, {
      onProgress: () => onProgress?.(`语音识别中 ${chunk.index + 1} 片…`)
    });
  const result = await retryAsync(task, retries, retryDelayMs);
  return { ...result, durationSec: chunk.durationSec };
}

// createTranscriptionEngine({ transcribe, isAborted, onChunkResult, onProgress,
//   concurrency, retries, retryDelayMs }) → { push, close }
//
//   push(chunk) → boolean
//     活队列喂入：并发未满立即启动，否则排队；返回 false 表示拒绝
//     （close() 已调用，或 isAborted() 已置真——断连后无需再喂）。
//   close() → Promise<summary>
//     流结束标记：此后 push 一律拒绝；未中止时排队片与在途片继续消化，全部
//     结束后 resolve 同一个 summary（重复 close 返回同一 promise）：
//     {
//       acceptedChunks,  // push 实际接受的片数
//       completedChunks, // 转写成功片数（含重试后成功）
//       failedChunks,    // 重试耗尽仍失败、跳过计数的片数（Q8a）
//       droppedByAbort,  // 中止后未启动即丢弃的排队片数
//       failures,        // [{ chunk, error }] 失败片明细（诊断用）
//       aborted          // 结算时 isAborted() 的取值
//     }
//   isAborted() 须单调：一旦置真不再回退（offscreen 的 aborted 标志语义，
//   port.onDisconnect 置位后取消）。
export function createTranscriptionEngine({
  transcribe,
  isAborted,
  onChunkResult,
  onProgress,
  concurrency = ASR_CONCURRENCY,
  retries = DEFAULT_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS
} = {}) {
  if (typeof transcribe !== "function") {
    throw new Error("createTranscriptionEngine 需要注入 transcribe 函数");
  }
  const aborted = typeof isAborted === "function" ? isAborted : () => false;
  const limit = Number(concurrency) > 0 ? Math.floor(Number(concurrency)) : ASR_CONCURRENCY;

  const queue = [];
  const failures = [];
  let inFlight = 0;
  let closed = false;
  let closePromise = null;
  let closeResolve = null;
  let acceptedChunks = 0;
  let completedChunks = 0;
  let failedChunks = 0;
  let droppedByAbort = 0;

  function buildSummary() {
    return {
      acceptedChunks,
      completedChunks,
      failedChunks,
      droppedByAbort,
      failures,
      aborted: aborted()
    };
  }

  // 调度循环：并发有空位且队列非空就启动下一片；已中止则剩余排队片全部
  // 丢弃并清点（acceptedChunks 不回退——close 汇总经 droppedByAbort 如实
  // 报告差额：accepted = completed + failed + droppedByAbort）。
  function drain() {
    while (inFlight < limit && queue.length > 0) {
      if (aborted()) {
        droppedByAbort += queue.length;
        queue.length = 0;
        break;
      }
      const chunk = queue.shift();
      inFlight += 1;
      runChunk(chunk);
    }
  }

  // close 已调用且无在途 → 结算（closeResolve 置空防重复 resolve）。
  function settleIfDone() {
    if (!closeResolve || inFlight > 0) {
      return;
    }
    const resolve = closeResolve;
    closeResolve = null;
    resolve(buildSummary());
  }

  async function runChunk(chunk) {
    try {
      const result = await transcribeChunk({ chunk, transcribe, onProgress, retries, retryDelayMs });
      completedChunks += 1;
      deliver(chunk, result);
    } catch (error) {
      // 重试耗尽仍失败：跳过并计数，不中止整条管线（Q8a 口径）
      failedChunks += 1;
      failures.push({ chunk, error });
      logWarn("[BOC] asr chunk transcription failed, skipping", {
        chunkIndex: chunk?.index,
        error: getErrorMessage(error)
      });
    } finally {
      inFlight -= 1;
      drain();
      settleIfDone();
    }
  }

  // 逐片交付：成功即回调。回调异常（如 port 已断开时 postMessage 抛错）
  // 不影响调度与计数——片本身已转写成功。
  function deliver(chunk, result) {
    if (typeof onChunkResult !== "function") {
      return;
    }
    try {
      onChunkResult(chunk, result);
    } catch {
      // 交付失败不影响调度
    }
  }

  function push(chunk) {
    if (closed || aborted()) {
      return false;
    }
    acceptedChunks += 1;
    queue.push(chunk);
    drain();
    return true;
  }

  function close() {
    if (closePromise) {
      return closePromise;
    }
    closed = true;
    closePromise = new Promise((resolve) => {
      closeResolve = resolve;
      drain();
      settleIfDone();
    });
    return closePromise;
  }

  return { push, close };
}
