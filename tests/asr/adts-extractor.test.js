// extension/asr/adts.js createAdtsExtractor 单测：有状态增量解析器。
// 覆盖：与 adtsFromFmp4 整段输出逐字节一致；1 字节/次的极端切分 push 序列与
// 整块 push 输出一致（残包边界）；flush 收尾（尾部不足 10 moof 的段）。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createAdtsExtractor,
  adtsFromFmp4,
  parseAudioSpecificConfig
} from "../../extension/asr/adts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = new Uint8Array(
  readFileSync(join(__dirname, "fixtures", "fmp4-audio-sample.bin"))
);
const big = new Uint8Array(readFileSync(join(__dirname, "fixtures", "fmp4-1mb.bin")));

// 用整块 push 复现 adtsFromFmp4 的输出（包装即此语义），作为逐字节一致的基准
function collectViaExtractor(bytes, config) {
  const extractor = createAdtsExtractor(config);
  const segments = [...extractor.push(bytes), ...extractor.flush()];
  if (extractor.frameCount === 0) return [];
  return segments;
}

// 按给定块长序列循环切分字节并喂给 extractor，返回全部段
function collectViaChunkedPush(bytes, chunkSizes, config) {
  const extractor = createAdtsExtractor(config);
  const segments = [];
  let off = 0;
  let i = 0;
  while (off < bytes.length) {
    const len = Math.min(chunkSizes[i % chunkSizes.length], bytes.length - off);
    segments.push(...extractor.push(bytes.subarray(off, off + len)));
    off += len;
    i += 1;
  }
  segments.push(...extractor.flush());
  return segments;
}

const asc = parseAudioSpecificConfig(fixture) || {};

describe("createAdtsExtractor 与 adtsFromFmp4 输出逐字节一致", () => {
  it("真实 B 站音轨片段（98KB，2 对 moof/mdat）", () => {
    const expected = adtsFromFmp4(fixture, asc);
    expect(expected.length).toBeGreaterThan(0);
    const actual = collectViaExtractor(fixture, asc);
    expect(actual).toEqual(expected);
  });

  it("真实 1MB 样本（26 对 moof/mdat，含 10 moof 分段边界）", () => {
    const expected = adtsFromFmp4(big, asc);
    expect(expected.length).toBeGreaterThan(1); // 确认跨过分段边界
    const actual = collectViaExtractor(big, asc);
    expect(actual).toEqual(expected);
  });

  it("非 fMP4 输入：无段产出且 frameCount 为 0", () => {
    const extractor = createAdtsExtractor(asc);
    expect(extractor.push(new Uint8Array(100))).toEqual([]);
    expect(extractor.flush()).toEqual([]);
    expect(extractor.frameCount).toBe(0);
  });

  it("默认配置（AAC-LC/48k/双声道）与显式 ASC 配置输出一致", () => {
    const extractor = createAdtsExtractor({});
    const segments = [...extractor.push(fixture), ...extractor.flush()];
    expect(segments).toEqual(adtsFromFmp4(fixture, {}));
  });
});

describe("createAdtsExtractor 极端切分（残包边界）", () => {
  it("1 字节/次 push 与整块 push 输出一致（98KB fixture 全量逐字节）", () => {
    const expected = collectViaExtractor(fixture, asc);
    const actual = collectViaChunkedPush(fixture, [1], asc);
    expect(actual).toEqual(expected);
  });

  it("混合奇数块长（7/13/1/4096）与整块 push 输出一致（1MB 样本）", () => {
    const expected = adtsFromFmp4(big, asc);
    const actual = collectViaChunkedPush(big, [7, 13, 1, 4096], asc);
    expect(actual).toEqual(expected);
  });
});

describe("createAdtsExtractor flush 收尾", () => {
  it("满 10 moof 的段在 push 中产出，尾部不足 10 moof 由 flush 交出", () => {
    // 1MB 样本 26 对 moof/mdat：push 阶段产出前 20 个 moof（2 段），flush 交 6 个
    const extractor = createAdtsExtractor(asc);
    const pushed = extractor.push(big);
    const flushed = extractor.flush();
    expect(pushed.length).toBe(2);
    expect(flushed.length).toBe(1);
    // push + flush 拼起来与整段包装结果一致
    expect([...pushed, ...flushed]).toEqual(adtsFromFmp4(big, asc));
  });

  it("总数不足 10 moof 时 push 不产段、flush 交出唯一段", () => {
    const extractor = createAdtsExtractor(asc);
    const pushed = extractor.push(fixture); // 2 对 moof/mdat
    expect(pushed).toEqual([]);
    const flushed = extractor.flush();
    expect(flushed.length).toBe(1);
    expect(flushed).toEqual(adtsFromFmp4(fixture, asc));
  });

  it("整流后零音帧：frameCount 为 0、无段产出", () => {
    // 只有 ftyp/moov 没有 moof/mdat 对的容器：判 fMP4 与否交给调用方，
    // extractor 层面表现为无帧无段
    const bare = new Uint8Array(64);
    new DataView(bare.buffer).setUint32(0, 32);
    bare.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp"
    const extractor = createAdtsExtractor(asc);
    expect([...extractor.push(bare), ...extractor.flush()]).toEqual([]);
    expect(extractor.frameCount).toBe(0);
  });
});
