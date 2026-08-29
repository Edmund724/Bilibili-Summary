// entry/offscreen-asr.js streamAudioSegments 的下载流测试（Node/vitest）。
// 模块顶层不触 chrome，fetch/probeSize 走全局注入（vi.stubGlobal("fetch")，
// 与 tests/asr/pipeline.test.js 的 fake fetch 惯例一致）。
// 覆盖：fMP4 增量流产出与 adtsFromFmp4 一致、主 URL 失败换备用、abort 中途
// 静默退出（reader.cancel 且不产段）、全部失败抛「音频下载失败」、非 fMP4
// 兜底整段 raw 交出。

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { streamAudioSegments } from "../../extension/entry/offscreen-asr.js";
import { adtsFromFmp4, parseAudioSpecificConfig } from "../../extension/asr/adts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = new Uint8Array(
  readFileSync(join(__dirname, "../asr/fixtures", "fmp4-audio-sample.bin"))
);
const asc = parseAudioSpecificConfig(fixture) || {};

// 假 reader：按队列逐个 yield chunk（模拟网络分块到达）
function readerFromChunks(chunks) {
  let i = 0;
  return {
    read: async () =>
      i < chunks.length
        ? { done: false, value: chunks[i++] }
        : { done: true, value: undefined },
    cancel: vi.fn(async () => {})
  };
}

// 假 fetch：按 method + url 分发。headOk=false 模拟 CDN 不支持 HEAD；
// getResponses 为按 URL 顺序取用的响应工厂队列。
function stubFetch({ headOk = true, contentLength = "1000", getResponses } = {}) {
  const factories = [...getResponses];
  const fetchMock = vi.fn(async (url, init) => {
    if (init?.method === "HEAD") {
      return {
        ok: headOk,
        headers: { get: () => contentLength }
      };
    }
    const factory = factories.shift();
    if (!factory) throw new Error("unexpected GET: " + url);
    return factory();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function okStreamResponse(chunks) {
  const reader = readerFromChunks(chunks);
  return { ok: true, body: { getReader: () => reader }, _reader: reader };
}

async function collect(gen) {
  const items = [];
  for await (const item of gen) items.push(item);
  return items;
}

// 手工构造最小 fMP4：ftyp + moof(mfhd+traf{tfhd+trun}) + mdat（1 个 171 字节样本），
// 结构与 tests/asr/adts.test.js 的 buildMinimalFmp4 一致
function buildMinimalFmp4() {
  const ftyp = new Uint8Array(32);
  writeU32(ftyp, 0, 32);
  ftyp.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp"
  const moofSize = 8 + 16 + (8 + 24 + (8 + 4 + 4 + 4 + 8));
  const moof = new Uint8Array(moofSize);
  writeU32(moof, 0, moofSize);
  moof.set([0x6d, 0x6f, 0x6f, 0x66], 4); // "moof"
  writeU32(moof, 8, 16);
  moof.set([0x6d, 0x66, 0x68, 0x64], 12); // "mfhd"
  moof.set([0, 0, 0, 0], 16);
  writeU32(moof, 20, 1);
  const trafStart = 24;
  writeU32(moof, trafStart, 8 + 24 + (8 + 4 + 4 + 4 + 8));
  moof.set([0x74, 0x72, 0x61, 0x66], trafStart + 4); // "traf"
  const tfhdStart = trafStart + 8;
  writeU32(moof, tfhdStart, 24);
  moof.set([0x74, 0x66, 0x68, 0x64], tfhdStart + 4); // "tfhd"
  moof.set([0, 0, 0, 0], tfhdStart + 8);
  writeU32(moof, tfhdStart + 12, 1);
  writeU32(moof, tfhdStart + 16, 1024);
  writeU32(moof, tfhdStart + 20, 171);
  const trunStart = tfhdStart + 24;
  writeU32(moof, trunStart, 8 + 4 + 4 + 4 + 8);
  moof.set([0x74, 0x72, 0x75, 0x6e], trunStart + 4); // "trun"
  moof[trunStart + 8] = 0; // version=0
  moof[trunStart + 9] = 0x03; // flags=0x301：data_offset + duration + size
  moof[trunStart + 10] = 0x01;
  writeU32(moof, trunStart + 12, 1);
  writeU32(moof, trunStart + 16, 8);
  writeU32(moof, trunStart + 20, 1024);
  writeU32(moof, trunStart + 24, 171);
  const mdat = new Uint8Array(8 + 171);
  writeU32(mdat, 0, 8 + 171);
  mdat.set([0x6d, 0x64, 0x61, 0x74], 4); // "mdat"
  mdat.fill(0x21, 8);
  const out = new Uint8Array(ftyp.length + moof.length + mdat.length);
  out.set(ftyp, 0);
  out.set(moof, ftyp.length);
  out.set(mdat, ftyp.length + moof.length);
  return out;
}

function writeU32(arr, p, value) {
  arr[p] = (value >>> 24) & 0xff;
  arr[p + 1] = (value >>> 16) & 0xff;
  arr[p + 2] = (value >>> 8) & 0xff;
  arr[p + 3] = value & 0xff;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamAudioSegments", () => {
  it("fMP4 流：增量喂入产出的段与 adtsFromFmp4 整段输出一致", async () => {
    // 分成 3 个不齐整的网络块（首块不足 4MB 也照判）
    const cut1 = 31711;
    const cut2 = 70001;
    const chunks = [fixture.subarray(0, cut1), fixture.subarray(cut1, cut2), fixture.subarray(cut2)];
    stubFetch({ getResponses: [() => okStreamResponse(chunks)] });

    const items = await collect(streamAudioSegments(["u1"], () => false));
    expect(items.length).toBeGreaterThan(0);
    const segments = items.map((item) => item.segment);
    expect(segments).toEqual(adtsFromFmp4(fixture, asc));
  });

  it("头部收满 4MB 即判定 fMP4 并喂解析器（不等流结束）", async () => {
    // 手工构造最小 fMP4（1 个 moof/mdat 对，无 esds，走默认 ASC 配置）
    const synth = buildMinimalFmp4();
    // 前垫一个 free box，使首个网络块总长刚过 HEAD_PROBE_LIMIT（4MB），
    // 且首个 moof 落在 isFragmentedMp4 的 4MB 扫描窗口内（free box 之后）
    const padSize = (1 << 22) - 200;
    const padded = new Uint8Array(padSize + synth.length);
    new DataView(padded.buffer).setUint32(0, padSize);
    padded.set([0x66, 0x72, 0x65, 0x65], 4); // "free"
    padded.set(synth, padSize);
    stubFetch({ getResponses: [() => okStreamResponse([padded])] });

    const items = await collect(streamAudioSegments(["u"], () => false));
    expect(items.map((item) => item.segment)).toEqual(adtsFromFmp4(synth, {}));
  });

  it("主 URL GET 非 ok 换备用 URL 成功", async () => {
    stubFetch({
      getResponses: [
        () => ({ ok: false }),
        () => okStreamResponse([fixture])
      ]
    });
    const items = await collect(streamAudioSegments(["bad", "good"], () => false));
    expect(items.map((item) => item.segment)).toEqual(adtsFromFmp4(fixture, asc));
  });

  it("全部 URL 失败抛「音频下载失败」", async () => {
    stubFetch({
      getResponses: [() => ({ ok: false }), () => ({ ok: true, body: { getReader: () => readerFromChunks([]) } })]
    });
    await expect(collect(streamAudioSegments(["a", "b"], () => false))).rejects.toThrow(
      "音频下载失败"
    );
  });

  it("abort 中途静默退出：不产段且 cancel 连接", async () => {
    let aborted = false;
    const response = okStreamResponse([fixture.subarray(0, 1024), fixture.subarray(1024)]);
    stubFetch({ getResponses: [() => response] });

    const gen = streamAudioSegments(["u"], () => aborted);
    const first = await gen.next();
    expect(first.done).toBe(false); // 首段已产出
    aborted = true;
    const rest = await collect(gen);
    expect(rest).toEqual([]);
    expect(response._reader.cancel).toHaveBeenCalled();
  });

  it("非 fMP4 兜底：整段 raw 一次交出", async () => {
    const pcm = new Uint8Array(1000).fill(0x55);
    stubFetch({ getResponses: [() => okStreamResponse([pcm.subarray(0, 400), pcm.subarray(400)])] });
    const items = await collect(streamAudioSegments(["u"], () => false));
    expect(items.length).toBe(1);
    expect(items[0].raw).toEqual(pcm);
  });
});
