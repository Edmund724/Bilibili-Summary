// extension/asr/chunker.ts
// WAV 切片（16bit PCM / 16kHz / 单声道）。
// WAV 字节编码本体已拆到 asr/wav-encode.js（asr-provider-store 探针只需编码
// 不需切片，拆静态边让 chunker 其余部分退 offscreen/SW 图，见 ADR-0003），
// 本模块 import 它并保留 Blob 包装；切片、解码结果校验在本模块。
// Service Worker 没有 AudioContext：解码与重采样由 offscreen 文档宿主完成
// （见 asr/protocol.js，接 entry/offscreen-asr.js 基建），offscreen 文档侧用
// buildWavChunks 把解码结果切成 WAV 块，在本 context 内直接交给转写引擎，
// 不跨 context。核心模块不直接碰 AudioContext，Node/vitest 下可独立测试。

import { encodeWavBytes } from "./wav-encode.js";

// 切片计划：chunkSeconds <= 0（或缺省）表示不切——整段一个片段
export interface ChunkPlan {
  chunkSeconds: number;
}

// 切片时间戳：startSec 连续无缝隙，最后一片短于标准片长属正常
export interface ChunkSpec {
  index: number;
  startSec: number;
  durationSec: number;
}

// buildWavChunks 的产出：切片时间戳 + 本片 WAV Blob
export interface WavChunk extends ChunkSpec {
  wavBlob: Blob;
}

// 解码诊断（offscreen 宿主会附带 {durationSec, peak}）
export interface DecodedAudioDiagnostic {
  durationSec: number;
  peak: number;
}

// chunker 契约的 AudioBuffer 鸭子类型（{ sampleRate, length, getChannelData }，
// 另带可选解码诊断；DOM AudioBuffer 结构兼容）
export interface DecodedAudioBuffer {
  sampleRate: number;
  length: number;
  getChannelData(channel: number): Float32Array;
  diagnostic?: DecodedAudioDiagnostic;
}

// encodeWavBytes 的 Blob 包装（转写上传用 Blob 形态）。
export function encodeWav(monoFloat32: Float32Array, sampleRate = 16000): Blob {
  return new Blob([encodeWavBytes(monoFloat32, sampleRate)], { type: "audio/wav" });
}

// ===== 切片 =====

// 按总时长切分片段。plan = { chunkSeconds }，chunkSeconds <= 0（或缺省）
// 表示不切：整段一个片段。返回 [{ index, startSec, durationSec }]，
// startSec 连续无缝隙，最后一片短于标准片长属正常；总时长为 0 返回 []。
export function decideChunks(totalDurationSec: number, plan: ChunkPlan): ChunkSpec[] {
  const total = Number(totalDurationSec);
  if (!(total > 0)) return [];
  const chunkSec = plan?.chunkSeconds > 0 ? plan.chunkSeconds : total;

  const chunks: ChunkSpec[] = [];
  let start = 0;
  let index = 0;
  while (total - start > 1e-9) {
    const end = Math.min(start + chunkSec, total);
    chunks.push({ index, startSec: start, durationSec: end - start });
    start = end;
    index += 1;
  }
  return chunks;
}

// 按 provider 类型计算切片计划（分钟 → 秒）：
//   openai-transcriptions：统一 20 分钟一片。
// 未知类型保守按不切处理。
export function buildChunkPlan(providerType: string): ChunkPlan {
  if (providerType === "openai-transcriptions") {
    return { chunkSeconds: 20 * 60 };
  }
  return { chunkSeconds: 0 };
}

// ===== 解码校验 =====

// 裸 Float32Array → AudioBuffer 鸭子类型（chunker 契约 { sampleRate, length,
// getChannelData }）。offscreen 侧 decodeTo16kMono 直接产出裸数组，裸数组没有
// sampleRate，validateDecodedAudio 会算不出时长并误报「解码结果时长为零」——
// 曾实际发生（采样数千万级、采样率 undefined）。decodeHost 契约与
// buildWavChunks 共用此适配，口径一致。
export function makeDecodedBuffer(
  channelData: Float32Array,
  { sampleRate = 16000, diagnostic }: { sampleRate?: number; diagnostic?: DecodedAudioDiagnostic } = {}
): DecodedAudioBuffer {
  return {
    sampleRate,
    length: channelData.length,
    getChannelData: () => channelData,
    diagnostic
  };
}

// 校验解码结果可转写，非法时抛显式错误：
//   - 峰值≈0 且时长 > 0 → 解码出来疑似静音（音轨获取或容器解码出了问题），
//     直接报错，避免上游把空音频转写出误导性的"未识别到语音内容"；
//   - 时长 ≤ 0（空采样/采样率异常）→ 报错，绝不静默产出空切片。
// buildWavChunks 与 offscreen 文档侧共用（解码产物一致，校验口径也必须一致）。
export function validateDecodedAudio(audioBuffer: DecodedAudioBuffer): number {
  // 解码诊断：offscreen 宿主会附带 {durationSec, peak}
  const diag = audioBuffer?.diagnostic;
  if (diag && Number.isFinite(diag.peak) && diag.peak < 0.001 && diag.durationSec > 0) {
    throw new Error(
      `音频解码失败：解码结果疑似静音（时长 ${diag.durationSec}s、峰值幅度 ${diag.peak}）`
    );
  }

  const totalDurationSec = audioBuffer.length / audioBuffer.sampleRate;
  // 显式化：解码出零时长（空采样/采样率异常）直接报错，绝不静默产出
  // 空切片——上游会把空切片误报成"未识别到语音内容"。
  if (!(totalDurationSec > 0)) {
    throw new Error(
      `音频解码失败：解码结果时长为零（采样数 ${audioBuffer?.length ?? 0}、采样率 ${audioBuffer?.sampleRate}）`
    );
  }
  return totalDurationSec;
}

// ===== 切片编码：校验 → 切片 → 编码 =====

// 直接按切片计划把已解码音频切成 WAV 块（offscreen 文档侧用，产出在本
// context 内交给转写引擎上平台；解码与重采样由宿主侧完成后把结果传入）。
// 返回 [{ index, startSec, durationSec, wavBlob }]，durationSec 由
// decideChunks 产出（转写结果合并依赖该字段推算片边界）。
export function buildWavChunks(audioBuffer: DecodedAudioBuffer, plan: ChunkPlan): WavChunk[] {
  const totalDurationSec = validateDecodedAudio(audioBuffer);
  const channelData = audioBuffer.getChannelData(0);
  return decideChunks(totalDurationSec, plan).map((chunk): WavChunk => {
    const startSample = Math.round(chunk.startSec * audioBuffer.sampleRate);
    const sampleCount = Math.round(chunk.durationSec * audioBuffer.sampleRate);
    return {
      index: chunk.index,
      startSec: chunk.startSec,
      durationSec: chunk.durationSec,
      wavBlob: encodeWav(
        channelData.subarray(startSample, startSample + sampleCount),
        audioBuffer.sampleRate
      )
    };
  });
}
