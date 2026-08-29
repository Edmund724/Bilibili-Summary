// extension/asr/chunker.js
// WAV 编码（16bit PCM / 16kHz / 单声道）+ 切片。
// Service Worker 没有 AudioContext：解码与重采样由 offscreen 文档宿主完成
// （见 asr/protocol.js，接 entry/offscreen-asr.js 基建），本模块只负责
// 编码、切片计划与解码结果校验；offscreen 文档侧用 buildWavChunks 把
// 解码结果切成 WAV 块，在本 context 内直接交给转写引擎，不跨 context。
// 核心模块不直接碰 AudioContext，Node/vitest 下可独立测试。WAV header 手写，不引依赖。

// ===== WAV 编码 =====

// Float32 单声道采样（[-1,1]）→ 16bit PCM WAV 字节（Uint8Array）。
// 44 字节 RIFF/WAVE header + PCM little-endian。16k 单声道 ≈ 1.9MB/分钟。
export function encodeWavBytes(monoFloat32, sampleRate = 16000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const sampleCount = monoFloat32.length;
  const dataSize = sampleCount * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF chunk（12 字节）
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true); // chunk size
  writeAscii(view, 8, "WAVE");

  // fmt subchunk（16 字节，PCM）
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);            // subchunk size
  view.setUint16(20, 1, true);             // audio format = PCM
  view.setUint16(22, numChannels, true);   // 声道数
  view.setUint32(24, sampleRate, true);    // 采样率
  view.setUint32(28, byteRate, true);      // 每秒字节数
  view.setUint16(32, blockAlign, true);    // 每采样帧字节数
  view.setUint16(34, bitsPerSample, true); // 位深

  // data subchunk 头（8 字节）
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // Float32 → Int16：Math.round 舍入，量化后 clamp 到 [-32768, 32767]（1.0 → 32767）
  const pcmView = new DataView(buffer, 44, dataSize);
  for (let i = 0; i < sampleCount; i++) {
    const q = Math.round(monoFloat32[i] * 32768);
    pcmView.setInt16(i * 2, q > 32767 ? 32767 : q < -32768 ? -32768 : q, true);
  }

  return new Uint8Array(buffer);
}

// encodeWavBytes 的 Blob 包装（转写上传用 Blob 形态）。
export function encodeWav(monoFloat32, sampleRate = 16000) {
  return new Blob([encodeWavBytes(monoFloat32, sampleRate)], { type: "audio/wav" });
}

// 写入 ASCII 字符串（RIFF/WAVE/fmt /data 标识）
function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ===== 切片 =====

// 按总时长切分片段。plan = { chunkSeconds }，chunkSeconds <= 0（或缺省）
// 表示不切：整段一个片段。返回 [{ index, startSec, durationSec }]，
// startSec 连续无缝隙，最后一片短于标准片长属正常；总时长为 0 返回 []。
export function decideChunks(totalDurationSec, plan) {
  const total = Number(totalDurationSec);
  if (!(total > 0)) return [];
  const chunkSec = plan?.chunkSeconds > 0 ? plan.chunkSeconds : total;

  const chunks = [];
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
export function buildChunkPlan(providerType) {
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
export function makeDecodedBuffer(channelData, { sampleRate = 16000, diagnostic } = {}) {
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
export function validateDecodedAudio(audioBuffer) {
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
export function buildWavChunks(audioBuffer, plan) {
  const totalDurationSec = validateDecodedAudio(audioBuffer);
  const channelData = audioBuffer.getChannelData(0);
  return decideChunks(totalDurationSec, plan).map((chunk) => {
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

