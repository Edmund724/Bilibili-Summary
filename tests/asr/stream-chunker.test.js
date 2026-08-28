// stream-chunker.js 测试：流式逐段解码 → 按片 WAV 输出的编排正确性。
// 与 chunker.buildWavChunks（生产切片语义）逐片比对：
//   - 片索引 / startSec / durationSec / 边界与基准一致（整秒片长严格一致）；
//   - 逐片 PCM 内容与基准完全一致（同一 encodeWav 输入 → 同一输出）；
//   - 内存有界性由实现保证（每满一片即 onChunk 交出，不持有历史）。
// 解码器注入合成段（固定值采样），不依赖真实 AudioContext。

import { describe, expect, it } from "vitest";
import { streamWavChunks } from "../../extension/asr/stream-chunker.js";
import { buildWavChunks, makeDecodedBuffer } from "../../extension/asr/chunker.js";

const RATE = 16000;
const FILL = 0.25;

// 合成段：把 [0, totalSec) 按 segSec 切段（最后一段截短），值恒 FILL。
function makeSegments(totalSec, segSec) {
  const segs = [];
  for (let s = 0; s < totalSec; s += segSec) {
    const len = Math.min(segSec, totalSec - s) * RATE;
    const a = new Float32Array(len);
    a.fill(FILL);
    segs.push(a);
  }
  return segs;
}

// 基准：全量 mono → 生产切片语义（buildWavChunks）
function baselineChunks(totalSec, chunkSec) {
  const mono = new Float32Array(totalSec * RATE);
  mono.fill(FILL);
  return buildWavChunks(
    makeDecodedBuffer(mono, { sampleRate: RATE, diagnostic: { durationSec: totalSec, peak: FILL } }),
    { chunkSeconds: chunkSec }
  );
}

// WAV Blob → 16bit PCM 样本（与 encodeWav 写回的字节逐位比较）
async function wavPcm16(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const out = new Int16Array((buf.length - 44) / 2);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = view.getInt16(44 + i * 2, true);
  }
  return out;
}

// 大数组紧凑比较：长度 + 校验和 + 抽样点（全量 toEqual 会生成巨型 diff 把
// vitest worker 的 V8 堆打爆）
function expectPcmMatches(got, want) {
  expect(got.length).toBe(want.length);
  if (got.length === 0) return;
  let gotSum = 0;
  let wantSum = 0;
  for (let i = 0; i < got.length; i += 1) {
    gotSum = (gotSum + got[i]) | 0;
    wantSum = (wantSum + want[i]) | 0;
  }
  expect(gotSum).toBe(wantSum);
  const step = Math.max(1, Math.floor(got.length / 64));
  for (let k = 0; k < got.length; k += step) {
    expect(got[k]).toBe(want[k]);
  }
  expect(got[got.length - 1]).toBe(want[want.length - 1]);
}

function collectStream(segments, { chunkSeconds, segmentsIn = segments } = {}) {
  const out = [];
  return {
    out,
    promise: streamWavChunks(segmentsIn, {
      chunkSeconds,
      decodeSegment: (seg) => Promise.resolve(seg), // 段即 16k mono 裸数组
      onChunk: async (chunk) => {
        out.push(chunk);
      }
    })
  };
}

describe("streamWavChunks 与 buildWavChunks 基准一致", () => {
  it("整秒片长（1200s）、段边界不齐片边界：片数/起止/内容与基准一致", async () => {
    // 1500s / 每段 200s：8 段，段边界不与片边界对齐，验证段内跨片拼接
    //（全量级 4h 用例由 .scratch/asr-4h-mem harness 在真实 Chrome 验证）
    const totalSec = 1500;
    const chunkSec = 1200;
    const segSec = 200;
    const { out, promise } = collectStream(makeSegments(totalSec, segSec), { chunkSeconds: chunkSec });
    const meta = await promise;

    const baseline = baselineChunks(totalSec, chunkSec);
    expect(meta.totalChunks).toBe(baseline.length);
    expect(out.length).toBe(baseline.length);
    for (let i = 0; i < baseline.length; i += 1) {
      expect(out[i].index).toBe(baseline[i].index);
      expect(out[i].startSec).toBeCloseTo(baseline[i].startSec, 6);
      expect(out[i].durationSec).toBeCloseTo(baseline[i].durationSec, 6);
      const got = await wavPcm16(out[i].wavBlob);
      const want = await wavPcm16(baseline[i].wavBlob);
      expectPcmMatches(got, want);
    }
    expect(meta.totalDurationSec).toBeCloseTo(totalSec, 6);
  }, 60000);

  it("非整除时长：最后残余一片短片，边界与基准一致", async () => {
    const totalSec = 1250; // 1200 + 50
    const chunkSec = 1200;
    const segSec = 30;
    const { out, promise } = collectStream(makeSegments(totalSec, segSec), { chunkSeconds: chunkSec });
    const meta = await promise;

    const baseline = baselineChunks(totalSec, chunkSec);
    expect(meta.totalChunks).toBe(2);
    expect(out.length).toBe(2);
    expect(out[1].startSec).toBeCloseTo(1200, 6);
    expect(out[1].durationSec).toBeCloseTo(50, 6);
    for (let i = 0; i < 2; i += 1) {
      const got = await wavPcm16(out[i].wavBlob);
      const want = await wavPcm16(baseline[i].wavBlob);
      expectPcmMatches(got, want);
    }
  });

  it("chunkSeconds <= 0：不切，整段一片（与 decideChunks 语义一致）", async () => {
    const totalSec = 500;
    const { out, promise } = collectStream(makeSegments(totalSec, 60), { chunkSeconds: 0 });
    const meta = await promise;
    expect(meta.totalChunks).toBe(1);
    expect(out[0].durationSec).toBeCloseTo(totalSec, 6);
    const want = await wavPcm16(baselineChunks(totalSec, totalSec)[0].wavBlob);
    const got = await wavPcm16(out[0].wavBlob);
    expect(got.length).toBe(want.length);
  });

  it("全静音段：抛「疑似静音」错误（与 chunker.validateDecodedAudio 口径一致）", async () => {
    const segments = makeSegments(240, 60).map((seg) => {
      const z = new Float32Array(seg.length);
      z.fill(0);
      return z;
    });
    await expect(
      streamWavChunks(segments, {
        chunkSeconds: 1200,
        decodeSegment: (seg) => Promise.resolve(seg),
        onChunk: async () => {}
      })
    ).rejects.toThrow(/疑似静音/);
  });

  it("空段输入：totalChunks 为 0，不抛错", async () => {
    const { promise } = collectStream([], { chunkSeconds: 1200 });
    const meta = await promise;
    expect(meta.totalChunks).toBe(0);
  });

  it("片间偶发 onChunk 中异步等待（base64 编码耗时）不改变输出顺序", async () => {
    const totalSec = 2440; // 两片 + 残余 40s
    const segments = makeSegments(totalSec, 45);
    const out = [];
    let call = 0;
    await streamWavChunks(segments, {
      chunkSeconds: 1200,
      decodeSegment: (seg) => Promise.resolve(seg),
      onChunk: async (chunk) => {
        call += 1;
        await new Promise((r) => setTimeout(r, 3));
        out.push(chunk);
      }
    });
    expect(out.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(out[2].durationSec).toBeCloseTo(40, 6);
  });
});
