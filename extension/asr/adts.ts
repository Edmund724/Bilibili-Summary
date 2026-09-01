// extension/asr/adts.ts
// 把 B 站 DASH 音轨的 fragmented MP4（fMP4，moof/mdat 分片）里的 AAC 裸帧
// 提取出来，包上 ADTS 头拼成 ADTS 流。Chrome 的 decodeAudioData 不支持
// fragmented MP4（报 "Unable to decode audio data"），但支持 ADTS（.aac）——
// 这是 B 站 fMP4 音轨（AAC-LC / 48kHz / 双声道）的解码降级路径。
//
// 解析依据（实测 2026-08，B 站 m4s 音轨）：
//   - moov 里 esds.DecoderSpecificInfo 的 AudioSpecificConfig 给出编码参数
//     （本仓库 ACC/48k/2ch 为 0x11 0x90）；
//   - 顶层 box 序列为 ftyp / moov / sidx? / moof / mdat / moof / mdat ...；
//   - 每个 moof 内含 traf → trun：version/flags 低两位为 data-offset，
//     每个 sample 记 sample_duration(4) + sample_size(4)（B 站 trun 不走
//     标准 flags 0x100/0x200，而是干脆每个 sample 8 字节）；
//   - sample 尺寸逐个给出（约 170~171 字节），sum(sizes) === mdat 数据区长度，
//     按此切帧得到 AAC raw frame（无 syncword）。
//
// 本模块是纯函数，不碰 AudioContext / DOM，Node/vitest 下可独立测试。

// esds.AudioSpecificConfig 解析结果（ADTS 头组装所需的编码参数）
export interface AudioSpecificConfig {
  profile: number;
  freqIdx: number;
  chCfg: number;
}

// createAdtsExtractor 的编码参数（缺省 AAC-LC / 48kHz / 双声道，
// 与 B 站常规音轨一致，供 moov 里 ASC 解析失败时兜底）
export interface AdtsExtractorConfig {
  profile?: number;
  freqIdx?: number;
  chCfg?: number;
}

// 增量解析器：push 交付已完成段（Uint8Array 数组），flush 收尾，
// frameCount 为累计提取的音帧数（调用方据此判定 fMP4 零帧失败）
export interface AdtsExtractor {
  push(bytes: Uint8Array | ArrayBuffer): Uint8Array[];
  flush(): Uint8Array[];
  readonly frameCount: number;
}

// 判断一个 MP4 容器是否为 fragmented（顶层存在 moof，且 moov 极小）
export function isFragmentedMp4(bytes: Uint8Array | ArrayBuffer): boolean {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 12) return false;
  // 快速路径：ftyp 后直接找 moov / moof
  let p = 0;
  let hasMoof = false;
  while (p + 8 <= u8.length && p < 1 << 22) {
    const sz = readU32(u8, p);
    if (sz < 8 || p + sz > u8.length) break;
    const typ = readAscii(u8, p + 4, 4);
    if (typ === "moof") hasMoof = true;
    if (typ === "moov" || typ === "sidx") p += sz;
    else p += sz;
    if (hasMoof) return true;
  }
  return hasMoof;
}

// 有状态增量解析器（流式下载侧）：push 接收任意分块的下载字节，内部维护跨
// push 的残包缓冲与顶层 box 解析状态，返回「已完成的段」数组（按
// SEGMENT_MOOFS=10 个 moof 分组、约 1MB 的口径，与 adtsFromFmp4 完全一致）；
// flush 在流结束时调用，收尾清残包并返回最后不足 10 moof 的段。
// 配合下载侧逐 chunk 喂入，峰值内存 O(残包 + 单段)，音轨长度与内存解耦。
// frameCount 只读属性给出累计提取的音帧数（调用方据此判定 fMP4 零帧失败）。
// 解析逻辑（顶层 box 序列、moof 的 trun sample sizes、mdat 切帧、ADTS 7 字节
// 头）与 adtsFromFmp4 原实现逐字节一致——adtsFromFmp4 现在就是用本函数实现
// 的薄包装，两者输出保证相同。
export function createAdtsExtractor(config: AdtsExtractorConfig = {}): AdtsExtractor {
  const profile = Number(config.profile ?? 1); // AAC-LC = 1
  const freqIdx = Number(config.freqIdx ?? 3); // 48kHz
  const chCfg = Number(config.chCfg ?? 2); // 双声道

  // 按 moof 分组切段：Chrome 的 decodeAudioData 对超长 ADTS 流（完整音轨
  // ~46MB / 96min）解码失败，实测每 ~10 个 moof/mdat 对（约 50s / 1MB）
  // 可正常解码——每段限制在约 1MB 内。
  const SEGMENT_MOOFS = 10;

  let buf: Uint8Array | null = null; // 跨 push 的残包：未收完的尾部 box 字节（≤ 单个 box 大小）
  let pendingSizes: number[] | null = null; // 最近一个完整 moof 解析出的 sample sizes（等后续 mdat 配对）
  let lastSeqTyp = ""; // 顶层序列中上一个 moof/mdat box 的类型（mdat 须紧跟 moof 才配对）
  let cur: number[] = []; // 当前段累积字节
  let moofsInSegment = 0;
  let frames = 0;
  let out: Uint8Array[] | null = null; // 本次 push/flush 收集已完成段的数组（调用方取走）

  // 处理一个 (moof, mdat) 配对：为每个 sample 写 7 字节 ADTS 头 + raw AAC 帧，
  // 满 SEGMENT_MOOFS 个 moof 即封段。sizes 为空时不产帧也不计数（与原实现对齐）。
  const emitMdatFrames = (data: Uint8Array, dataStart: number, dataEnd: number, sizes: number[]): void => {
    let off = dataStart;
    for (const sampleSize of sizes) {
      if (off + sampleSize > dataEnd) break;
      const frameTotal = sampleSize + 7;
      // ADTS 头（MPEG-4, AAC LC, 无 CRC）：见 ISO/IEC 13818-7 附录
      cur.push(
        0xff,
        0xf1, // syncword + ID=MPEG-4 + layer=0 + protection_absent=1
        ((profile & 3) << 6) | ((freqIdx & 0xf) << 2) | ((chCfg >> 2) & 1),
        ((chCfg & 3) << 6) | ((frameTotal >> 11) & 3),
        (frameTotal >> 3) & 0xff,
        ((frameTotal & 7) << 5) | 0x1f,
        0xfc
      );
      for (let k = 0; k < sampleSize; k += 1) cur.push(data[off + k]);
      off += sampleSize;
      frames += 1;
    }
    moofsInSegment += 1;
    if (moofsInSegment >= SEGMENT_MOOFS) {
      out!.push(new Uint8Array(cur));
      cur = [];
      moofsInSegment = 0;
    }
  };

  // 走一遍（残包 + 新字节拼成的）顶层 box 序列：moof 记 sample sizes 待配对，
  // mdat 与紧邻的前一个 moof 配对切帧；尾部不完整的 box 留作残包。
  const parse = (data: Uint8Array): void => {
    let p = 0;
    while (p + 8 <= data.length) {
      const sz = readU32(data, p);
      if (sz < 8 || p + sz > data.length) break;
      const typ = readAscii(data, p + 4, 4);
      if (typ === "moof") {
        pendingSizes = parseTrunSampleSizes(data, p, sz);
        lastSeqTyp = "moof";
      } else if (typ === "mdat") {
        if (lastSeqTyp === "moof" && pendingSizes && pendingSizes.length > 0) {
          emitMdatFrames(data, p + 8, p + sz, pendingSizes);
        }
        lastSeqTyp = "mdat";
      }
      p += sz;
    }
    buf = p < data.length ? data.slice(p) : null;
  };

  return {
    push(bytes: Uint8Array | ArrayBuffer): Uint8Array[] {
      const segments: Uint8Array[] = [];
      out = segments;
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      parse(buf ? concatBytes(buf, u8) : u8);
      out = null;
      return segments;
    },
    flush(): Uint8Array[] {
      const segments: Uint8Array[] = [];
      out = segments;
      if (cur.length > 0) segments.push(new Uint8Array(cur));
      cur = [];
      buf = null;
      out = null;
      return segments;
    },
    get frameCount(): number {
      return frames;
    }
  };
}

// 从 fMP4 提取 AAC 裸帧并包装为 ADTS 流（薄包装：整段字节一次性喂
// createAdtsExtractor 收集全部输出，签名与返回值不变）。
// Chrome 的 decodeAudioData 对超长 ADTS 流（完整音轨 ~46MB / 96min）解码失败，
// 但每 ~10 moof（约 50s / 1MB）的片段能正常解码——因此按 moof 分组返回片段数组。
// 返回 Uint8Array[]（每个元素为一个 moof/mdat 对对应的 ADTS 字节流）；
// 不是 fMP4 或无可解析样本时返回 []。
// bytes 为完整音轨字节；config 可选 { profile, freqIdx, chCfg }（默认
// AAC-LC / 48kHz / 双声道，与 B 站常规音轨一致），供 moov 里 ASC 解析失败时兜底。
export function adtsFromFmp4(bytes: Uint8Array | ArrayBuffer, config: AdtsExtractorConfig = {}): Uint8Array[] {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const extractor = createAdtsExtractor(config);
  const segments = [...extractor.push(u8), ...extractor.flush()];
  if (extractor.frameCount === 0) return [];
  return segments;
}

// 从 moov 里解析 esds 的 AudioSpecificConfig 提取 { profile, freqIdx, chCfg }。
// 失败返回 null（调用方用默认配置兜底）。
export function parseAudioSpecificConfig(bytes: Uint8Array | ArrayBuffer): AudioSpecificConfig | null {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // 递归搜 moov → trak → mdia → minf → stbl → stsd → mp4a → esds
  const found = findBoxDeep(u8, 0, u8.length, "esds", 0);
  if (found < 0) return null;
  const boxEnd = found + readU32(u8, found);
  // esds 内容：ES_Descriptor(03) ... DecoderConfig(04) ... DSI(05 len=2) + ASC
  for (let i = found + 8; i + 7 < boxEnd; i += 1) {
    // 直找 DSI：05 80 80 80 02 <2 字节 ASC>
    if (
      u8[i] === 0x05 &&
      u8[i + 1] === 0x80 &&
      u8[i + 2] === 0x80 &&
      u8[i + 3] === 0x80 &&
      u8[i + 4] === 0x02
    ) {
      const b0 = u8[i + 5];
      const b1 = u8[i + 6];
      return {
        profile: ((b0 >> 3) & 0x1f) - 1, // audioObjectType 转 ADTS profile（AAC-LC=2 → 1）
        freqIdx: ((b0 & 7) << 1) | ((b1 >> 7) & 1),
        chCfg: (b1 >> 3) & 0xf
      };
    }
  }
  return null;
}

// ===== 底层工具 =====

function readU32(u8: Uint8Array, p: number): number {
  return (u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3];
}

// 拼接两段字节（增量解析器跨 push 的残包缓冲拼接用，仅小缓冲）
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function readAscii(u8: Uint8Array, p: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i += 1) s += String.fromCharCode(u8[p + i]);
  return s;
}

// 解析单个 moof 内所有 trun 的 sample sizes。
// ISO/IEC 14496-12 标准 flags（实测 B 站音轨）：
//   bit0 (0x1): data_offset 存在
//   bit8 (0x100): 每 sample 有 sample_duration(4)
//   bit9 (0x200): 每 sample 有 sample_size(4) —— B 站音轨必设
// 返回 [] 表示无 sizes（调用方按 mdat 全量处理或跳过）。
function parseTrunSampleSizes(u8: Uint8Array, moofStart: number, moofSize: number): number[] {
  const sizes: number[] = [];
  const moofEnd = moofStart + moofSize;
  let q = moofStart + 8;
  let sawTrun = false;
  while (q + 8 <= moofEnd) {
    const bsz = readU32(u8, q);
    if (bsz < 8 || q + bsz > moofEnd) break;
    const btyp = readAscii(u8, q + 4, 4);
    if (btyp === "traf") {
      const trafEnd = q + bsz;
      let qq = q + 8;
      while (qq + 8 <= trafEnd) {
        const s2 = readU32(u8, qq);
        if (s2 < 8 || qq + s2 > trafEnd) break;
        const t2 = readAscii(u8, qq + 4, 4);
        if (t2 === "trun") {
          sawTrun = true;
          // full box: version(1)+flags(3)
          const flags = (u8[qq + 9] << 16) | (u8[qq + 10] << 8) | u8[qq + 11];
          const n = readU32(u8, qq + 12);
          let pp = qq + 16;
          if (flags & 0x1) pp += 4; // data_offset
          const hasDuration = Boolean(flags & 0x100);
          const hasSize = Boolean(flags & 0x200);
          for (let i = 0; i < n; i += 1) {
            if (hasDuration) pp += 4;
            if (hasSize) {
              if (pp + 4 > qq + s2) break;
              sizes.push(readU32(u8, pp));
              pp += 4;
            } else {
              sizes.push(-1); // 无 size → default_sample_size 兜底
              break;
            }
          }
        }
        qq += s2;
      }
    }
    q += bsz;
  }
  return sawTrun ? sizes : [];
}

// 深度优先找指定 box（可穿越 moov/trak/mdia/minf/stbl/stsd/mp4a/wave）
// mp4a 是 AudioSampleEntry，box 头（8 字节）后紧跟 28 字节固定字段
// （6 reserved + 2 data_ref_index + 8 reserved + 2 channel_count + 2 sample_size
//   + 4 reserved + 4 sample_rate），之后才是子 box（esds/wave 等），
// 直接按 +8 扫会错位读不出 esds。
function findBoxDeep(u8: Uint8Array, start: number, end: number, target: string, depth: number): number {
  if (depth > 8) return -1;
  let q = start;
  while (q + 8 <= end) {
    const sz = readU32(u8, q);
    if (sz < 8 || q + sz > end) break;
    const typ = readAscii(u8, q + 4, 4);
    if (typ === target) return q;
    if (
      typ === "moov" ||
      typ === "trak" ||
      typ === "mdia" ||
      typ === "minf" ||
      typ === "stbl" ||
      typ === "stsd" ||
      typ === "mp4a" ||
      typ === "wave"
    ) {
      // stsd / stbl 等 full box：box 头（8）+ version/flags（4）+ entry_count（4）
      const childStart = typ === "mp4a" ? q + 36 : typ === "stsd" ? q + 16 : q + 8;
      const found = findBoxDeep(u8, childStart, q + sz, target, depth + 1);
      if (found >= 0) return found;
    }
    q += sz;
  }
  return -1;
}
