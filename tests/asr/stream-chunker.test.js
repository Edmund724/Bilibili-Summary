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

// ===== 段级解码降级（Q8a）：单个 ADTS 段解码失败 → 重试 1 次 → 仍失败跳过
// 计数继续；全部段失败（零片产出）才算整体失败。decodeSegment 全部 fake。 =====

// 解码器 fake：failures 集合内的段下标抛错（可编程每次调用的行为）。
function makeFailingDecoder({ failAt, failTimes = Infinity, abortAt = -1, abortSentinel }) {
  const calls = new Map(); // segmentIndex → 调用次数
  const decodeSegment = async (seg) => {
    const index = seg.__index;
    const count = (calls.get(index) || 0) + 1;
    calls.set(index, count);
    if (index === abortAt) {
      throw abortSentinel;
    }
    if (failAt.includes(index) && count <= failTimes) {
      throw new Error(`音频解码失败：段 ${index} 损坏`);
    }
    return seg;
  };
  return { decodeSegment, calls };
}

// 给段打上下标（fake 解码器据此决定失败/中止）
function tagSegments(segments) {
  return segments.map((seg, __index) => Object.assign(seg, { __index }));
}

describe("段级解码降级（Q8a）", () => {
  it("默认（无 decodeRetries/skip）：段解码失败直接上抛（现状语义不变）", async () => {
    const segments = tagSegments(makeSegments(600, 200)); // 3 段
    const decoder = makeFailingDecoder({ failAt: [1] });
    await expect(
      streamWavChunks(segments, {
        chunkSeconds: 1200,
        decodeSegment: decoder.decodeSegment,
        onChunk: async () => {}
      })
    ).rejects.toThrow(/段 1 损坏/);
  });

  it("decodeRetries=1：首次失败重试成功 → 不跳过、片产出正常", async () => {
    const segments = tagSegments(makeSegments(600, 200));
    // 段 1 第一次失败、第二次成功
    const decoder = makeFailingDecoder({ failAt: [1], failTimes: 1 });
    const out = [];
    const meta = await streamWavChunks(segments, {
      chunkSeconds: 1200,
      decodeSegment: decoder.decodeSegment,
      onChunk: async (chunk) => out.push(chunk),
      decodeRetries: 1
    });
    expect(decoder.calls.get(1)).toBe(2); // 重试 1 次
    expect(meta.totalChunks).toBe(1);
    expect(meta.skippedSegments).toBe(0);
    expect(out).toHaveLength(1);
  });

  it("decodeRetries=1 + skipFailedSegments：重试仍失败 → 跳过该段计数，后续段继续", async () => {
    const segments = tagSegments(makeSegments(600, 200));
    const decoder = makeFailingDecoder({ failAt: [1] }); // 段 1 恒失败
    const out = [];
    const meta = await streamWavChunks(segments, {
      chunkSeconds: 1200,
      decodeSegment: decoder.decodeSegment,
      onChunk: async (chunk) => out.push(chunk),
      decodeRetries: 1,
      skipFailedSegments: true
    });
    // 段 1 重试 1 次后跳过；段 0/2 的采样拼成一片
    expect(decoder.calls.get(1)).toBe(2);
    expect(meta.skippedSegments).toBe(1);
    expect(meta.totalChunks).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0].durationSec).toBeCloseTo(400, 6); // 200s × 2 段
  });

  it("全部段失败（零片产出）→ totalChunks 0，不抛错（整体失败由调用方判定）", async () => {
    const segments = tagSegments(makeSegments(600, 200));
    const decoder = makeFailingDecoder({ failAt: [0, 1, 2] });
    const meta = await streamWavChunks(segments, {
      chunkSeconds: 1200,
      decodeSegment: decoder.decodeSegment,
      onChunk: async () => {},
      decodeRetries: 1,
      skipFailedSegments: true
    });
    expect(meta.totalChunks).toBe(0);
    expect(meta.skippedSegments).toBe(3);
  });

  it("isAbortError 命中：不重试不跳过，直接向上传播（断连取消优先于降级）", async () => {
    const segments = tagSegments(makeSegments(600, 200));
    const abortSentinel = Object.freeze({ asrAborted: true });
    const decoder = makeFailingDecoder({ failAt: [], abortAt: 1, abortSentinel });
    await expect(
      streamWavChunks(segments, {
        chunkSeconds: 1200,
        decodeSegment: decoder.decodeSegment,
        onChunk: async () => {},
        decodeRetries: 1,
        skipFailedSegments: true,
        isAbortError: (error) => error === abortSentinel
      })
    ).rejects.toBe(abortSentinel);
    // 段 1 首次抛哨兵即中止：未重试
    expect(decoder.calls.get(1)).toBe(1);
  });
});
