// wav-slice 单测：最小 WAV 字节生成 helper + 解析/切片/重采样断言。
// helper 用 DataView 手写 RIFF/WAVE 头 + PCM 数据，自包含不导出 lib。

import { describe, expect, it } from "vitest";
import { parseWavHeader, sliceWavToChunks } from "../../eval/lib/wav-slice.js";

// ===== 测试内 WAV 生成 helper =====

// 直流 PCM（恒定振幅 ±amp），便于断言切片后的样本值
function makeDcWav(opts: {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  seconds: number;
  amp?: number; // 0..1（8 位无符号 / 16 位有符号的相对幅度）
}): Uint8Array {
  const { sampleRate, channels, bitsPerSample, seconds, amp = 0.5 } = opts;
  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.round(sampleRate * seconds);
  const dataSize = frames * channels * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      if (bitsPerSample === 16) {
        view.setInt16(offset, Math.round(amp * 32767), true);
        offset += 2;
      } else {
        view.setUint8(offset, Math.round(128 + amp * 127));
        offset += 1;
      }
    }
  }
  return new Uint8Array(buf);
}

// data 块在前、fmt 块在后（非标准顺序）：data 头在 12，data 体 20..20+dataSize，
// fmt 紧随其后
function makeWavDataFirst(sampleRate: number, frames: number): Uint8Array {
  const dataSize = frames * 2;
  const buf = new ArrayBuffer(24 + dataSize + 24);
  const view = new DataView(buf);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "data");
  view.setUint32(16, dataSize, true);
  new Uint8Array(buf, 20, dataSize).fill(0); // 静音
  writeAscii(view, 20 + dataSize, "fmt ");
  view.setUint32(24 + dataSize, 16, true);
  view.setUint16(28 + dataSize, 1, true);
  view.setUint16(30 + dataSize, 1, true);
  view.setUint32(32 + dataSize, sampleRate, true);
  view.setUint32(36 + dataSize, sampleRate * 2, true);
  view.setUint16(40 + dataSize, 2, true);
  view.setUint16(42 + dataSize, 16, true);
  return new Uint8Array(buf);
}

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

async function wavDurationOf(blob: Blob): Promise<number> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  return parseWavHeader(buf).sampleCount / parseWavHeader(buf).sampleRate;
}

// ===== parseWavHeader =====

describe("parseWavHeader", () => {
  it("解析 16k 单声道 16 位 WAV", () => {
    const wav = makeDcWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16, seconds: 2 });
    const info = parseWavHeader(wav);
    expect(info).toEqual({
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      dataByteLength: 16000 * 2 * 2,
      sampleCount: 16000 * 2
    });
  });

  it("解析 44.1k 双声道 8 位 WAV", () => {
    const wav = makeDcWav({ sampleRate: 44100, channels: 2, bitsPerSample: 8, seconds: 1 });
    const info = parseWavHeader(wav);
    expect(info.sampleRate).toBe(44100);
    expect(info.channels).toBe(2);
    expect(info.bitsPerSample).toBe(8);
    expect(info.sampleCount).toBe(44100 * 2);
  });

  it("支持 data 块在 fmt 块之前的非标准顺序", () => {
    const wav = makeWavDataFirst(8000, 100);
    const info = parseWavHeader(wav);
    expect(info.sampleRate).toBe(8000);
    expect(info.channels).toBe(1);
    expect(info.bitsPerSample).toBe(16);
    expect(info.sampleCount).toBe(100);
  });

  it("非 RIFF/WAVE 输入抛错", () => {
    expect(() => parseWavHeader(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => parseWavHeader(new Uint8Array(100))).toThrow();
  });
});

// ===== sliceWavToChunks =====

describe("sliceWavToChunks", () => {
  it("按 chunkSeconds 切片：数量、startSec、durationSec（末段不满保留）", async () => {
    const wav = makeDcWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16, seconds: 25 });
    const chunks = sliceWavToChunks(wav, 10);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].startSec).toBe(0);
    expect(chunks[1].startSec).toBe(10);
    expect(chunks[2].startSec).toBe(20);
    expect(chunks[0].durationSec).toBeCloseTo(10, 5);
    expect(chunks[2].durationSec).toBeCloseTo(5, 5);

    for (const chunk of chunks) {
      expect(await wavDurationOf(chunk.blob)).toBeCloseTo(chunk.durationSec, 5);
    }
  });

  it("每片是合法 WAV：mono / 16-bit / 目标采样率 16k 的标准头", async () => {
    const wav = makeDcWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16, seconds: 3 });
    const [chunk] = sliceWavToChunks(wav, 2);
    const buf = new Uint8Array(await chunk.blob.arrayBuffer());
    const info = parseWavHeader(buf);
    expect(info.sampleRate).toBe(16000);
    expect(info.channels).toBe(1);
    expect(info.bitsPerSample).toBe(16);
    const view = new DataView(buf.buffer);
    expect(new TextDecoder().decode(buf.slice(0, 4))).toBe("RIFF");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint32(40, true)).toBe(buf.byteLength - 44); // data size
  });

  it("重采样到 16k：样本数按比例换算（44.1k → 16k）", async () => {
    const wav = makeDcWav({ sampleRate: 44100, channels: 1, bitsPerSample: 16, seconds: 1 });
    const [chunk] = sliceWavToChunks(wav, 10, { resampleTo: 16000 });
    const info = parseWavHeader(new Uint8Array(await chunk.blob.arrayBuffer()));
    expect(info.sampleRate).toBe(16000);
    expect(info.sampleCount).toBeCloseTo(16000, -2); // 44100/16000 插值误差内
    expect(chunk.durationSec).toBeCloseTo(1, 2);
  });

  it("双声道混成单声道：两声道同值 → 混后值不变", async () => {
    const wav = makeDcWav({ sampleRate: 16000, channels: 2, bitsPerSample: 16, seconds: 1, amp: 0.5 });
    const [chunk] = sliceWavToChunks(wav, 10);
    const buf = new Uint8Array(await chunk.blob.arrayBuffer());
    const view = new DataView(buf.buffer);
    expect(parseWavHeader(buf).channels).toBe(1);
    const expected = Math.round(0.5 * 32767);
    expect(view.getInt16(44, true)).toBeCloseTo(expected, -2);
  });

  it("8 位无符号输入正确转为 16 位有符号输出", async () => {
    const wav = makeDcWav({ sampleRate: 16000, channels: 1, bitsPerSample: 8, seconds: 0.1, amp: 0.5 });
    const [chunk] = sliceWavToChunks(wav, 10);
    const buf = new Uint8Array(await chunk.blob.arrayBuffer());
    expect(parseWavHeader(buf).bitsPerSample).toBe(16);
    const view = new DataView(buf.buffer);
    // 8 位 amp=0.5 → 样本 ~191 → 归一 ~(191-128)/128 ≈ 0.492 → 16 位 ≈ 16122
    expect(view.getInt16(44, true)).toBeGreaterThan(14000);
    expect(view.getInt16(44, true)).toBeLessThan(18000);
  });

  it("样本值保留：16 位直流输入在切片后数值不漂移（同采样率不重采样）", async () => {
    const wav = makeDcWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16, seconds: 1, amp: 0.25 });
    const [chunk] = sliceWavToChunks(wav, 10);
    const buf = new Uint8Array(await chunk.blob.arrayBuffer());
    const view = new DataView(buf.buffer);
    expect(view.getInt16(44, true)).toBe(Math.round(0.25 * 32767));
  });

  it("空音频 / 非法输入抛错", () => {
    const emptyData = new Uint8Array(44); // 只有头，data 长度 0
    const view = new DataView(emptyData.buffer);
    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 8, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, "data");
    view.setUint32(40, 0, true);
    expect(() => sliceWavToChunks(emptyData, 10)).toThrow();
    expect(() => sliceWavToChunks(makeDcWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16, seconds: 1 }), 0)).toThrow();
  });
});
