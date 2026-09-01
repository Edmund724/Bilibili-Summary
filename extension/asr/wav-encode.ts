// extension/asr/wav-encode.ts
// 最小 WAV 字节编码微模块（16bit PCM / 单声道）。
// 从 asr/chunker.js 拆出：asr-provider-store 的连通性探针只需要「把静音采样
// 编码成 WAV 字节」，此前却要静态 import 整个 chunker.js（切片计划 / 解码
// 校验 / Blob 包装一起进 SW 图）。ADR-0003：SW 不做运行时惰性（平台禁止动态
// import()），小用途只能靠拆静态边——本模块只持有 WAV header 手写编码这一
// 份实现，chunker.js 与探针共同引用，不复制第二份。纯函数、无依赖，
// Node/vitest 下可独立测试。

// ===== WAV 编码 =====

// Float32 单声道采样（[-1,1]）→ 16bit PCM WAV 字节（Uint8Array）。
// 44 字节 RIFF/WAVE header + PCM little-endian。16k 单声道 ≈ 1.9MB/分钟。
// 返回类型取 Uint8Array<ArrayBuffer>：字节总是落在函数新建的 ArrayBuffer 上
// （可直接作 BlobPart 上传，无需二次断言）。
export function encodeWavBytes(monoFloat32: Float32Array, sampleRate = 16000): Uint8Array<ArrayBuffer> {
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

// 写入 ASCII 字符串（RIFF/WAVE/fmt /data 标识）
function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
