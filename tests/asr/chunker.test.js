// chunker.js 测试：WAV 编码器正确性 / buildChunkPlan 各平台规则 /
// decideChunks 边界与连续性 / processAudio 整链与坏字节诊断 /
// buildWavChunks 直测。
// 全部纯 Node/vitest，解码宿主用合成宿主注入，不依赖真实 AudioContext。

import { describe, expect, it } from "vitest";
import {
  encodeWav,
  decideChunks,
  buildChunkPlan,
  processAudio,
  buildWavChunks,
  validateDecodedAudio,
  makeDecodedBuffer
} from "../../extension/asr/chunker.js";

// 合成解码宿主：把传入 buffer 视为 48kHz 双声道音频，重采样为 16kHz 单声道。
// 模拟 decodeHost 契约：返回 { sampleRate:16000, length, getChannelData(0) }。
// 内容默认固定样本值（大时长用例避免生成正弦波拖慢测试）；wave:true 时生成
// 440Hz 正弦波（双声道同相，取任一通道做重采样即可），用于小片段用例。
function makeSynthDecodeHost({ sampleRate = 48000, channels = 2, durationSec, freq = 440, wave = false } = {}) {
  return async function synthDecodeHost(arrayBuffer) {
    const frameCount = Math.round(durationSec * sampleRate);
    const channelData = [];
    for (let c = 0; c < channels; c++) {
      const data = new Float32Array(frameCount);
      for (let i = 0; i < frameCount; i++) {
        data[i] = wave ? Math.sin((2 * Math.PI * freq * i) / sampleRate) : 0.25;
      }
      channelData.push(data);
    }
    // 重采样到 16kHz 单声道：近邻取整平均两声道
    const targetRate = 16000;
    const outLength = Math.max(1, Math.round((frameCount / sampleRate) * targetRate));
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const srcIdx = Math.floor((i * sampleRate) / targetRate);
      out[i] = (channelData[0][srcIdx] + channelData[1][srcIdx]) / 2;
    }
    return {
      sampleRate: targetRate,
      length: outLength,
      getChannelData: (ch) => {
        if (ch !== 0) throw new Error("仅支持单声道通道 0");
        return out;
      }
    };
  };
}

// 读取 WAV 头各字段（对照 44 字节标准布局）
function readWavHeader(blob, bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset, len) =>
    String.fromCharCode(...bytes.subarray(offset, offset + len));
  return {
    riff: ascii(0, 4),
    chunkSize: view.getUint32(4, true),
    wave: ascii(8, 4),
    fmt: ascii(12, 4),
    subchunkSize: view.getUint32(16, true),
    audioFormat: view.getUint16(20, true),
    numChannels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    data: ascii(36, 4),
    dataSize: view.getUint32(40, true)
  };
}

// 读 WAV 的 PCM 采样值（Int16 little-endian）
function readPcmSamples(blob, bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = (bytes.length - 44) / 2;
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = view.getInt16(44 + i * 2, true);
  }
  return samples;
}

describe("encodeWav 编码器正确性", () => {
  it("44 字节 header 各字段逐字节正确（RIFF/WAVE/fmt /PCM/声道/采样率/对齐/位深/尺寸）", async () => {
    const samples = new Float32Array(16000);
    const blob = encodeWav(samples, 16000);
    const bytes = new Uint8Array(await blob.arrayBuffer());

    expect(blob.type).toBe("audio/wav");
    expect(bytes.byteLength).toBe(44 + 16000 * 2); // header + PCM
    const h = readWavHeader(blob, bytes);
    expect(h.riff).toBe("RIFF");
    expect(h.chunkSize).toBe(36 + 16000 * 2);
    expect(h.wave).toBe("WAVE");
    expect(h.fmt).toBe("fmt ");
    expect(h.subchunkSize).toBe(16);
    expect(h.audioFormat).toBe(1); // PCM
    expect(h.numChannels).toBe(1);
    expect(h.sampleRate).toBe(16000);
    expect(h.byteRate).toBe(16000 * 2);
    expect(h.blockAlign).toBe(2);
    expect(h.bitsPerSample).toBe(16);
    expect(h.data).toBe("data");
    expect(h.dataSize).toBe(16000 * 2);
  });

  it("60 秒 16k 单声道体积 = 44 + 16000*2*60 ≈ 1,920,044 字节（≈1.9MB/分钟）", async () => {
    const seconds = 60;
    const blob = encodeWav(new Float32Array(16000 * seconds), 16000);
    const bytes = await blob.arrayBuffer();
    expect(bytes.byteLength).toBe(44 + 16000 * 2 * seconds);
  });

  it("PCM 样本量化与舍入：0.5→16384、1.0→32767、-1.0→-32768、0→0", async () => {
    const blob = encodeWav(new Float32Array([0.5, 1.0, -1.0, 0.0, 0.9999]), 16000);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const samples = readPcmSamples(blob, bytes);
    expect(samples[0]).toBe(16384);
    expect(samples[1]).toBe(32767); // 量化后 clamp
    expect(samples[2]).toBe(-32768); // 量化后 clamp
    expect(samples[3]).toBe(0);
    expect(samples[4]).toBe(32765); // round(0.9999*32768) = round(32764.7) = 32765
  });

  it("负半样本 round 行为：-0.5→-16384（Math.round 半值向 +∞）", async () => {
    const blob = encodeWav(new Float32Array([-0.5]), 16000);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const samples = readPcmSamples(blob, bytes);
    expect(samples[0]).toBe(-16384);
  });

  it("空输入（0 采样）返回仅 44 字节 header", async () => {
    const blob = encodeWav(new Float32Array(0), 16000);
    const bytes = await blob.arrayBuffer();
    expect(bytes.byteLength).toBe(44);
  });
});

describe("buildChunkPlan 各平台规则", () => {
  it("openai-transcriptions 带时间戳 10 分钟一片", () => {
    expect(buildChunkPlan("openai-transcriptions", true)).toEqual({ chunkSeconds: 10 * 60 });
  });

  it("openai-transcriptions 无时间戳按 chunkMinutes（默认 3 分钟）", () => {
    expect(buildChunkPlan("openai-transcriptions", false)).toEqual({ chunkSeconds: 3 * 60 });
    expect(buildChunkPlan("openai-transcriptions", false, 5)).toEqual({ chunkSeconds: 5 * 60 });
    expect(buildChunkPlan("openai-transcriptions", false, 0)).toEqual({ chunkSeconds: 3 * 60 });
  });

  it("未知类型保守按不切处理", () => {
    expect(buildChunkPlan("mystery-type", true)).toEqual({ chunkSeconds: 0 });
  });
});

describe("decideChunks 边界与连续性", () => {
  it("不切（chunkSeconds 0）：整段一个片段", () => {
    const chunks = decideChunks(600, { chunkSeconds: 0 });
    expect(chunks).toEqual([{ index: 0, startSec: 0, durationSec: 600 }]);
  });

  it("总时长不足一片时只有 1 片（durationSec=总时长）", () => {
    expect(decideChunks(120, { chunkSeconds: 600 })).toEqual([
      { index: 0, startSec: 0, durationSec: 120 }
    ]);
  });

  it("总时长为 0（或非法）返回空数组", () => {
    expect(decideChunks(0, { chunkSeconds: 600 })).toEqual([]);
    expect(decideChunks(-5, { chunkSeconds: 600 })).toEqual([]);
    expect(decideChunks(NaN, { chunkSeconds: 600 })).toEqual([]);
  });

  it("61 分钟音频 10 分钟片 → 7 片，最后一片 1 分钟", () => {
    const chunks = decideChunks(61 * 60, { chunkSeconds: 10 * 60 });
    expect(chunks.length).toBe(7);
    expect(chunks[6]).toEqual({ index: 6, startSec: 60 * 60, durationSec: 60 });
  });

  it("26 分钟 25 分钟片 → 2 片（25 + 1）", () => {
    const chunks = decideChunks(26 * 60, { chunkSeconds: 25 * 60 });
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toEqual({ index: 0, startSec: 0, durationSec: 25 * 60 });
    expect(chunks[1]).toEqual({ index: 1, startSec: 25 * 60, durationSec: 60 });
  });

  it("8 分钟 chunkMinutes=3 → 3 片（3 + 3 + 2）", () => {
    const chunks = decideChunks(8 * 60, { chunkSeconds: 3 * 60 });
    expect(chunks.length).toBe(3);
    expect(chunks[0].durationSec).toBe(3 * 60);
    expect(chunks[1].durationSec).toBe(3 * 60);
    expect(chunks[2].durationSec).toBe(2 * 60);
  });

  it("startSec 连续无缝隙，覆盖完整时长", () => {
    const chunks = decideChunks(611, { chunkSeconds: 100 });
    let expectedStart = 0;
    let covered = 0;
    for (const c of chunks) {
      expect(c.startSec).toBeCloseTo(expectedStart, 9);
      expectedStart += c.durationSec;
      covered += c.durationSec;
    }
    expect(chunks[0].index).toBe(0);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(chunks[i - 1].index + 1);
    }
    expect(covered).toBeCloseTo(611, 9);
  });
});

describe("buildWavChunks 直测", () => {
  it("按 plan 切片并编码：8 分钟 3 分钟片 → 3 片，头部 16k 单声道", () => {
    const data = new Float32Array(8 * 60 * 16000).fill(0.25);
    const audioBuffer = {
      sampleRate: 16000,
      length: data.length,
      getChannelData: () => data
    };
    const chunks = buildWavChunks(audioBuffer, { chunkSeconds: 3 * 60 });

    expect(chunks).toHaveLength(3);
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.startSec).toBeCloseTo(i * 3 * 60, 9);
      expect(c.durationSec).toBeCloseTo(i < 2 ? 3 * 60 : 2 * 60, 9);
      expect(c.wavBlob).toBeInstanceOf(Blob);
      expect(c.wavBlob.type).toBe("audio/wav");
    });
  });

  it("每片 WAV 头部校验：16k 采样率 / 单声道 / 16bit，最后一片体积正确", async () => {
    const data = new Float32Array(8 * 60 * 16000).fill(0.25);
    const audioBuffer = {
      sampleRate: 16000,
      length: data.length,
      getChannelData: () => data
    };
    const chunks = buildWavChunks(audioBuffer, { chunkSeconds: 3 * 60 });

    const bytes = new Uint8Array(await chunks[2].wavBlob.arrayBuffer());
    const h = readWavHeader(chunks[2].wavBlob, bytes);
    expect(h.sampleRate).toBe(16000);
    expect(h.numChannels).toBe(1);
    expect(h.bitsPerSample).toBe(16);
    // 最后一片 2 分钟：44 + 16000*2*120
    expect(bytes.byteLength).toBe(44 + 16000 * 2 * 120);
  });

  it("不切（chunkSeconds 0）：整段一片且时长=总时长", () => {
    const data = new Float32Array(60 * 16000).fill(0.25);
    const audioBuffer = {
      sampleRate: 16000,
      length: data.length,
      getChannelData: () => data
    };
    const chunks = buildWavChunks(audioBuffer, { chunkSeconds: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].durationSec).toBeCloseTo(60, 9);
  });
});

describe("makeDecodedBuffer 契约适配", () => {
  it("裸 Float32Array → 鸭子类型：validateDecodedAudio / buildWavChunks 正常", () => {
    const data = new Float32Array(2 * 16000).fill(0.25);
    const buf = makeDecodedBuffer(data, {
      sampleRate: 16000,
      diagnostic: { durationSec: 2, peak: 0.25 }
    });
    expect(buf.sampleRate).toBe(16000);
    expect(buf.length).toBe(data.length);
    expect(buf.getChannelData(0)).toBe(data);
    expect(validateDecodedAudio(buf)).toBe(2);
    const chunks = buildWavChunks(buf, { chunkSeconds: 1 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].wavBlob).toBeInstanceOf(Blob);
  });

  it("未适配的裸数组（重构回归点）→ 校验抛「采样率 undefined」而非静默零切片", () => {
    // 模拟用户报错路径：decodeTo16kMono 返回裸 Float32Array，若绕过适配
    // 直接喂给 validateDecodedAudio，必须抛显式错误而不是产出空切片。
    const bare = new Float32Array(16000);
    expect(() => validateDecodedAudio(bare)).toThrow(/解码结果时长为零/);
  });
});

describe("validateDecodedAudio 直测", () => {
  it("非法解码结果（零时长）→ 抛「时长为零」", () => {
    const bad = { sampleRate: 16000, length: 0, getChannelData: () => new Float32Array(0) };
    expect(() => validateDecodedAudio(bad)).toThrow(/解码结果时长为零/);
  });

  it("静音诊断（peak < 0.001 且时长 > 0）→ 抛「疑似静音」", () => {
    const silent = {
      sampleRate: 16000,
      length: 16000,
      getChannelData: () => new Float32Array(16000),
      diagnostic: { durationSec: 1, peak: 0 }
    };
    expect(() => validateDecodedAudio(silent)).toThrow(/疑似静音/);
  });

  it("正常解码结果 → 返回总时长", () => {
    const ok = { sampleRate: 16000, length: 16000, getChannelData: () => new Float32Array(16000) };
    expect(validateDecodedAudio(ok)).toBe(1);
  });
});

describe("processAudio 整链与坏字节诊断", () => {
  it("按 plan 切片并编码：61 分钟 10 分钟片 → 7 个 WAV，startSec 连续", async () => {
    const host = makeSynthDecodeHost({ durationSec: 61 * 60 });
    const audio = new ArrayBuffer(8);
    const plan = { chunkSeconds: 10 * 60 };
    const chunks = await processAudio(audio, { decodeHost: host, plan });

    expect(chunks.length).toBe(7);
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.startSec).toBeCloseTo(i * 600, 9);
      expect(c.wavBlob).toBeInstanceOf(Blob);
      expect(c.wavBlob.type).toBe("audio/wav");
    });
    // 最后一片 1 分钟：PCM 字节数 = 16000*2*60
    const lastBytes = new Uint8Array(await chunks[6].wavBlob.arrayBuffer());
    expect(lastBytes.byteLength).toBe(44 + 16000 * 2 * 60);
    // 整链总时长 = 61 分钟；前 6 片各 10 分钟、最后 1 分钟
    expect(chunks[6].startSec + 60).toBeCloseTo(61 * 60, 9);
  });

  it("切片时长与宿主采样率一致（16k 单声道 WAV 头部校验）", async () => {
    const host = makeSynthDecodeHost({ durationSec: 8 * 60 });
    const chunks = await processAudio(new ArrayBuffer(8), {
      decodeHost: host,
      plan: { chunkSeconds: 3 * 60 }
    });
    expect(chunks.length).toBe(3);
    for (const c of chunks) {
      const bytes = new Uint8Array(await c.wavBlob.arrayBuffer());
      const h = readWavHeader(c.wavBlob, bytes);
      expect(h.sampleRate).toBe(16000);
      expect(h.numChannels).toBe(1);
      expect(h.bitsPerSample).toBe(16);
    }
    // 第 3 片 startSec = 6 分钟（2 片 × 3 分钟），PCM 字节数 = 16000*2*120
    expect(chunks[2].startSec).toBeCloseTo(6 * 60, 9);
    const lastBytes = new Uint8Array(await chunks[2].wavBlob.arrayBuffer());
    expect(lastBytes.byteLength).toBe(44 + 16000 * 2 * 120);
  });

  it("decodeHost 抛错 → message 含「音频解码失败」且附头 32 字节 hex 诊断", async () => {
    const rawError = new Error("bad container");
    const badHost = async () => {
      throw rawError;
    };
    const audio = new Uint8Array([
      0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0xfc, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80,
      0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0x00
    ]).buffer;

    await expect(
      processAudio(audio, { decodeHost: badHost, plan: { chunkSeconds: 600 } })
    ).rejects.toThrow(/音频解码失败/);

    try {
      await processAudio(audio, { decodeHost: badHost, plan: { chunkSeconds: 600 } });
    } catch (err) {
      expect(err.message).toContain("00010203fffefdfc1020304050607080");
      expect(err.diagnostic).toBe("00010203fffefdfc1020304050607080aabbccddeeff11223344556677889900");
    }
  });

  it("坏字节小于 32 字节时 hex 诊断按实际长度输出", async () => {
    const badHost = async () => {
      throw new Error("boom");
    };
    const audio = new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer;
    try {
      await processAudio(audio, { decodeHost: badHost, plan: {} });
    } catch (err) {
      expect(err.diagnostic).toBe("deadbeef");
      expect(err.message).toContain("deadbeef");
    }
  });

  it("解码结果为零时长 → 显式报错而非静默产出空切片", async () => {
    const zeroHost = async () => ({
      sampleRate: 16000,
      length: 0,
      getChannelData: () => new Float32Array(0)
    });
    await expect(
      processAudio(new ArrayBuffer(8), { decodeHost: zeroHost, plan: { chunkSeconds: 600 } })
    ).rejects.toThrow(/解码结果时长为零/);
  });

  it("解码诊断为静音（峰值 < 0.001 且时长 > 0）→ 显式报错", async () => {
    const silentHost = async () => ({
      sampleRate: 16000,
      length: 16000,
      getChannelData: () => new Float32Array(16000),
      diagnostic: { durationSec: 1, peak: 0 }
    });
    await expect(
      processAudio(new ArrayBuffer(8), { decodeHost: silentHost, plan: {} })
    ).rejects.toThrow(/疑似静音/);
  });
});

