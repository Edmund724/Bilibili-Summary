// extension/asr/stream-chunker.js
// 流式切片编排：逐段解码出的 16kHz mono Float32Array 追加进「当前片」，
// 每满 chunkSeconds 即编码为 WAV 经 onChunk 交出，随即释放该片——绝不同时
// 持有全部片。与 chunker.buildWavChunks（全量切片语义）输出一致：
//   片 index/startSec/durationSec 连续无缝，每片 WAV 字节逐位相同
//   （整秒片长下采样边界完全重合）。
//
// 背景：offscreen 侧曾用 decodeAudioData 一次性解码整条音轨（4 小时视频在
// 48kHz 双声道下产出 ~6.4GB Float32 AudioBuffer），渲染进程被 OOM 击杀，
// 扩展整包崩溃。本模块配合「fMP4 → ADTS 分段 → 逐段解码」把峰值压到
// O(单段 + 单片)。
//
// 解码器注入：decodeSegment 为 async (segment) => Float32Array（16k mono），
// 本模块不碰 AudioContext，Node/vitest 下可独立测试。

import { encodeWav } from "./chunker.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { logWarn } from "../shared/logging.js";

// streamWavChunks(segments, { chunkSeconds, sampleRate?, decodeSegment, onChunk,
//   decodeRetries?, skipFailedSegments?, isAbortError? })
//   segments     Array<unknown> 或 async iterable：逐段原始音频数据（解码器输入）
//   chunkSeconds 片长（秒）；<=0 表示不切（整段一片，内存随全长——调用方负责）
//   decodeSegment async (segment) => Float32Array（16k mono 采样）
//   onChunk      async ({ index, startSec, durationSec, wavBlob }) => void
//   decodeRetries        单段解码失败的额外重试次数（0 = 失败即抛，默认）
//   skipFailedSegments   true 时重试耗尽仍失败的段跳过并计数，继续后续段
//                        （Q8a 解码降级：个别 ADTS 段损坏不拖垮整条音轨）
//   isAbortError         (error) => boolean，命中即不重试不跳过、直接向上传播
//                        （断连取消哨兵走快速通道，不被降级逻辑吞掉）
// 完成时全静音（peak < 0.001 且时长 > 0）抛与 chunker.validateDecodedAudio
// 同口径的错误；异常中途 onChunk 抛错则向上传播（调用方决定中止）。
// 返回 { totalChunks, totalDurationSec, peak, skippedSegments }。
export async function streamWavChunks(segments, {
  chunkSeconds,
  sampleRate = 16000,
  decodeSegment,
  onChunk,
  decodeRetries = 0,
  skipFailedSegments = false,
  isAbortError
} = {}) {
  const chunkSamples = Number(chunkSeconds) > 0 ? Math.round(Number(chunkSeconds) * sampleRate) : 0;

  // 当前片累积：段视图数组（不复制段数据，满片时一次性拼接成连续数组再编码）
  const parts = [];
  let partsLen = 0;
  let emitted = 0;
  let totalLen = 0;
  let peak = 0;
  let skippedSegments = 0;

  const emitPart = async (part, durationSamples) => {
    const index = emitted;
    emitted += 1;
    await onChunk({
      index,
      startSec: chunkSamples > 0 ? (index * chunkSamples) / sampleRate : 0,
      durationSec: durationSamples / sampleRate,
      wavBlob: encodeWav(part, sampleRate)
    });
  };

  // 从 parts 头部消费 need 个采样，拼成连续数组返回（消费掉的段视图置 null 释放）
  const takeSamples = (need) => {
    const out = new Float32Array(need);
    let off = 0;
    let remaining = need;
    let i = 0;
    for (; i < parts.length && remaining > 0; i += 1) {
      const head = parts[i];
      const take = Math.min(remaining, head.length);
      out.set(head.subarray(0, take), off);
      off += take;
      remaining -= take;
      if (take === head.length) {
        parts[i] = null; // 整个段已消费完
      } else {
        parts[i] = head.subarray(take); // 段尾残留（不会超过片段边界多次）
        i += 1;
        break;
      }
    }
    // 移除已消费头
    let drop = 0;
    while (drop < i && parts[drop] === null) drop += 1;
    if (drop > 0) parts.splice(0, drop);
    return out;
  };

  // 段级解码降级（Q8a）：decodeRetries 次额外重试，重试耗尽仍失败时按
  // skipFailedSegments 决定跳过（返回 mono:null）或抛出；isAbortError 命中的
  // 中止错误不重试不跳过，立即向上传播（断连取消语义优先于降级）。
  const decodeWithDowngrade = async (segment, segmentIndex) => {
    let lastError = null;
    for (let attempt = 0; attempt <= decodeRetries; attempt += 1) {
      try {
        return { mono: await decodeSegment(segment) };
      } catch (error) {
        if (typeof isAbortError === "function" && isAbortError(error)) {
          throw error;
        }
        lastError = error;
      }
    }
    if (!skipFailedSegments) {
      throw lastError;
    }
    skippedSegments += 1;
    logWarn("[BOC] asr segment decode failed, skipping", {
      segmentIndex,
      attempts: decodeRetries + 1,
      error: getErrorMessage(lastError)
    });
    return { mono: null };
  };

  let segmentIndex = 0;
  for await (const segment of segments) {
    const { mono: segMono } = await decodeWithDowngrade(segment, segmentIndex);
    segmentIndex += 1;
    if (!(segMono && segMono.length > 0)) {
      continue; // 单段空输出（如异常帧）不打断整体
    }
    for (let i = 0; i < segMono.length; i += 1) {
      const abs = Math.abs(segMono[i]);
      if (abs > peak) peak = abs;
    }
    parts.push(segMono);
    partsLen += segMono.length;
    totalLen += segMono.length;

    if (!(chunkSamples > 0)) {
      continue; // 不切：整段一片（内存随全长，调用方保证 chunkSeconds > 0 为主路径）
    }
    // 满片即切：一次只处理一片，onChunk 完成后才继续，内存峰值 = 单片
    while (partsLen >= chunkSamples) {
      const part = takeSamples(chunkSamples);
      partsLen -= chunkSamples;
      await emitPart(part, chunkSamples);
    }
  }

  // 残余不足一片：作为最后一整片交出（与 decideChunks 最后一片短于标准片长一致）
  if (partsLen > 0) {
    await emitPart(takeSamples(partsLen), partsLen);
  }

  const totalDurationSec = totalLen / sampleRate;
  if (totalDurationSec > 0 && peak < 0.001) {
    throw new Error(
      `音频解码失败：解码结果疑似静音（时长 ${totalDurationSec}s、峰值幅度 ${peak}）`
    );
  }
  return { totalChunks: emitted, totalDurationSec, peak, skippedSegments };
}
