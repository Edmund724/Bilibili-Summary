// extension/asr/chunker.js
// 音频解码 + 切片 + WAV 编码（16bit PCM / 16kHz / 单声道）。
// Service Worker 没有 AudioContext，解码与重采样抽成「宿主」注入式接口：
//   - 服务层优先 offscreen 文档宿主（createOffscreenDecodeHost，接 entry/offscreen.js 基建）；
//   - Firefox 无 offscreen（Chrome MV3 专属），由 side panel 页面侧充当宿主（spec 备忘 7）；
//   接口参数化，调用方可按环境替换宿主。
// 核心模块不直接碰 AudioContext，Node/vitest 下可独立测试。WAV header 手写，不引依赖。

// ===== WAV 编码 =====

// Float32 单声道采样（[-1,1]）→ 16bit PCM WAV，返回 Blob。
// 44 字节 RIFF/WAVE header + PCM little-endian。16k 单声道 ≈ 1.9MB/分钟。
export function encodeWav(monoFloat32, sampleRate = 16000) {
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

  return new Blob([buffer], { type: "audio/wav" });
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
//   dashscope-filetrans：不切，整段一个 WAV（上限 12h）；
//   stepfun-sse：25 分钟一片（30 分钟限制留 5 分钟安全边距）；
//   openai-transcriptions：带时间戳 10 分钟一片；无时间戳按 chunkMinutes（默认 3）分钟。
// 未知类型保守按不切处理。
export function buildChunkPlan(providerType, supportsTimestamps, chunkMinutes) {
  if (providerType === "dashscope-filetrans") {
    return { chunkSeconds: 0 };
  }
  if (providerType === "stepfun-sse") {
    return { chunkSeconds: 25 * 60 };
  }
  if (providerType === "openai-transcriptions") {
    const minutes = supportsTimestamps ? 10 : chunkMinutes || 3;
    return { chunkSeconds: minutes * 60 };
  }
  return { chunkSeconds: 0 };
}

// ===== 整链：解码 → 切片 → 编码 =====

// 解码宿主契约：decodeHost 为 async (arrayBuffer) => { sampleRate, length,
// getChannelData(ch) }（AudioBuffer 鸭子类型），返回的必须是已重采样为
// 16000Hz 单声道的 buffer——重采样是宿主职责，核心模块只依赖该契约做切片与
// 编码。默认宿主见 createOffscreenDecodeHost（offscreen 文档）；Firefox 无
// offscreen 时由 side panel 页面侧实现同契约宿主传入（spec 备忘 7）。
//
// 返回 [{ index, startSec, wavBlob }]，wavBlob 为 16bit PCM WAV（16kHz 单声道）。
// decodeHost 抛错（坏字节/不支持的容器）→ 包装为 Error：message 含「音频解码失败」，
// 并附原始文件头前 32 字节的 hex 诊断（.diagnostic 字段 + message 内）。
export async function processAudio(arrayBuffer, { decodeHost, plan }) {
  let audioBuffer;
  try {
    audioBuffer = await decodeHost(arrayBuffer);
  } catch {
    const diagnostic = hexDiagnostic(arrayBuffer);
    const err = new Error(`音频解码失败（文件头 32 字节: ${diagnostic}）`);
    err.diagnostic = diagnostic;
    throw err;
  }

  const totalDurationSec = audioBuffer.length / audioBuffer.sampleRate;
  const chunks = decideChunks(totalDurationSec, plan);
  const channelData = audioBuffer.getChannelData(0);

  return chunks.map((chunk) => {
    const startSample = Math.round(chunk.startSec * audioBuffer.sampleRate);
    const sampleCount = Math.round(chunk.durationSec * audioBuffer.sampleRate);
    return {
      index: chunk.index,
      startSec: chunk.startSec,
      wavBlob: encodeWav(
        channelData.subarray(startSample, startSample + sampleCount),
        audioBuffer.sampleRate
      )
    };
  });
}

// 文件头字节 → 小写 hex（默认前 32 字节），解码失败时附在错误信息里定位问题
function hexDiagnostic(arrayBuffer, maxBytes = 32) {
  const bytes = new Uint8Array(arrayBuffer);
  const head = bytes.subarray(0, Math.min(maxBytes, bytes.length));
  let hex = "";
  for (let i = 0; i < head.length; i++) {
    hex += head[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// ===== 默认解码宿主（offscreen 文档） =====

// 基于 OfflineAudioContext 的解码 + 重采样宿主工厂，供 offscreen 文档侧调用。
// AudioContext/OfflineAudioContext 只在函数体内引用，Node/vitest 下不调用
// 工厂（或调用但环境无 AudioContext）都不会因 import 崩。
export function createOffscreenDecodeHost() {
  return async function offscreenDecodeHost(arrayBuffer) {
    const AudioCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioCtor) {
      throw new Error("当前环境没有 AudioContext，无法解码");
    }
    const audioCtx = new AudioCtor();
    try {
      // decodeAudioData 会 detach 传入的 buffer，传副本避免破坏调用方数据
      const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
      const targetRate = 16000;
      const outLength = Math.max(1, Math.round(decoded.duration * targetRate));
      const offline = new OfflineAudioContext(1, outLength, targetRate);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start(0);
      const rendered = await offline.startRendering();
      return {
        sampleRate: rendered.sampleRate,
        length: rendered.length,
        getChannelData: (ch) => rendered.getChannelData(ch)
      };
    } finally {
      audioCtx.close();
    }
  };
}
