// ai/raw-retrieval.js 原始字幕段按需检索测试（06 票）：
// 覆盖时间戳解析（MM:SS / HH:MM:SS / H:MM:SS / 去重升序 / 非法启发式）、
// 时间戳命中、章节名命中、关键词命中、未命中回退（维持压缩上下文）、
// 以及空输入/畸形输入/坏数据永不抛错。

import { describe, expect, it } from "vitest";
import {
  matchByKeyword,
  matchChapterByTitle,
  parseTimestampSeconds,
  retrieveRawSegments
} from "../../extension/ai/raw-retrieval.js";

// 构造一个原始字幕段：秒级 from/to + items（与 03 plan.segments / 04 缓存同构）。
function seg(index, from, to, texts) {
  return {
    index,
    from,
    to,
    items: texts.map((content, i) => ({ from: from + i * 5, to: from + i * 5 + 5, content }))
  };
}

describe("parseTimestampSeconds：时间戳解析", () => {
  it("MM:SS 解析为秒", () => {
    expect(parseTimestampSeconds("09:15 那段讲了什么")).toEqual([555]);
    expect(parseTimestampSeconds("视频的 02:30 处")).toEqual([150]);
  });

  it("HH:MM:SS 与 H:MM:SS 解析为秒", () => {
    expect(parseTimestampSeconds("01:09:15")).toEqual([4155]);
    expect(parseTimestampSeconds("1:09:15 说了啥")).toEqual([4155]);
  });

  it("多个时间戳升序去重", () => {
    expect(parseTimestampSeconds("09:15 和 09:15 和 01:09:15")).toEqual([555, 4155]);
    expect(parseTimestampSeconds("10:00 之后是 00:30")).toEqual([30, 600]);
  });

  it("无时间戳 → []", () => {
    expect(parseTimestampSeconds("这段讲了什么内容")).toEqual([]);
    expect(parseTimestampSeconds("")).toEqual([]);
    expect(parseTimestampSeconds("   ")).toEqual([]);
  });

  it("明显非时间不误判：99:99 / 2:0 / 2023:15 / 12:34:5", () => {
    expect(parseTimestampSeconds("99:99")).toEqual([]); // 分/秒 ≥60 拒绝
    expect(parseTimestampSeconds("2:0")).toEqual([]); // 比分：秒段非两位不匹配
    expect(parseTimestampSeconds("2023:15")).toEqual([]); // \b 边界拒绝年份
    expect(parseTimestampSeconds("12:34:5")).toEqual([754]); // 截断 MM:SS 而非误判三段
  });

  it("小时上限：24:00:00 拒绝", () => {
    expect(parseTimestampSeconds("24:00:00")).toEqual([]);
    expect(parseTimestampSeconds("23:59:59")).toEqual([86399]);
  });

  it("非字符串输入不抛错 → []", () => {
    expect(parseTimestampSeconds(null)).toEqual([]);
    expect(parseTimestampSeconds(undefined)).toEqual([]);
    expect(parseTimestampSeconds(123)).toEqual([]);
  });
});

describe("retrieveRawSegments：时间戳命中", () => {
  const raw = [seg(1, 0, 600, ["开场白内容"]), seg(2, 600, 1200, ["技术细节"])];

  it("prompt 含 09:15（=555s）→ 命中 0-600 段（原样引用）", () => {
    const hits = retrieveRawSegments({ prompt: "09:15 那段讲了什么", rawSegments: raw });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe(raw[0]); // 原样引用输入数组元素
    expect(hits[0].items).toEqual(raw[0].items); // 保留 items 供注入
  });

  it("区间含边界：from <= t < to（t=600 属于后段）", () => {
    const hits = retrieveRawSegments({ prompt: "10:00 那里在讲啥", rawSegments: raw });
    expect(hits.map((s) => s.index)).toEqual([2]);
  });

  it("多个时间戳跨段 → 各命中段按序返回且去重", () => {
    const hits = retrieveRawSegments({ prompt: "09:15 和 10:00 分别讲了什么", rawSegments: raw });
    expect(hits.map((s) => s.index)).toEqual([1, 2]);
  });

  it("时间戳未落在任何段区间 → 回落到关键词/未命中，不返回错误段", () => {
    const hits = retrieveRawSegments({ prompt: "99:99 讲啥", rawSegments: raw });
    expect(hits).toEqual([]);
  });
});

describe("retrieveRawSegments / matchChapterByTitle：章节名命中", () => {
  const chapters = [{ from: 0, to: 600, title: "开场白" }, { from: 600, to: 1200, title: "技术讲解" }];
  const raw = [seg(1, 0, 600, ["欢迎观看"]), seg(2, 600, 1200, ["贝叶斯公式推导"])];

  it("matchChapterByTitle：忽略大小写、去空白、去标点", () => {
    expect(matchChapterByTitle("讲讲开场白", chapters).map((c) => c.title)).toEqual(["开场白"]);
    expect(matchChapterByTitle(" 技术讲解 是什么？", chapters).map((c) => c.title)).toEqual(["技术讲解"]);
    expect(matchChapterByTitle("technology", chapters)).toEqual([]);
    expect(matchChapterByTitle("", chapters)).toEqual([]);
  });

  it("章节名命中 → retrieveRawSegments 取落在该章节 [from,to) 内的段", () => {
    const hits = retrieveRawSegments({ prompt: "开场白讲了什么", chapters, rawSegments: raw });
    expect(hits.map((s) => s.index)).toEqual([1]);
    expect(hits[0]).toBe(raw[0]);
  });

  it("命中多章 → 返回各章内段（去重、按段序）", () => {
    const hits = retrieveRawSegments({ prompt: "开场白和技术讲解都讲讲", chapters, rawSegments: raw });
    expect(hits.map((s) => s.index)).toEqual([1, 2]);
  });

  it("未标 chapterIndex 的段按 from 区间找回", () => {
    const hits = retrieveRawSegments({ prompt: "技术讲解", chapters, rawSegments: raw });
    expect(hits.map((s) => s.index)).toEqual([2]);
  });
});

describe("retrieveRawSegments / matchByKeyword：关键词命中", () => {
  const raw = [seg(1, 0, 600, ["开场白内容"]), seg(2, 600, 1200, ["贝叶斯公式推导", "先验后验"])];

  it("prompt 含某段独有词 → 命中该段", () => {
    expect(matchByKeyword("讲讲贝叶斯", raw).map((s) => s.index)).toEqual([2]);
    const hits = retrieveRawSegments({ prompt: "贝叶斯公式怎么推导", rawSegments: raw });
    expect(hits.map((s) => s.index)).toEqual([2]);
  });

  it("prompt 很短时用整体匹配（不走伪分词）", () => {
    expect(matchByKeyword("后验", raw).map((s) => s.index)).toEqual([2]);
  });

  it("去标点/忽略大小写：混排英文词", () => {
    const rawWithEn = [seg(1, 0, 600, ["介绍 Transformer 架构"]), seg(2, 600, 1200, ["贝叶斯"])];
    expect(matchByKeyword("Transformer？", rawWithEn).map((s) => s.index)).toEqual([1]);
    expect(matchByKeyword("transformer 架构", rawWithEn).map((s) => s.index)).toEqual([1]);
  });

  it("命中多段 → 全返回（按段序）", () => {
    const hits = retrieveRawSegments({ prompt: "先验后验和开场白都讲讲", rawSegments: raw });
    expect(hits.map((s) => s.index)).toEqual([1, 2]);
  });
});

describe("retrieveRawSegments：未命中回退（维持压缩上下文）", () => {
  const raw = [seg(1, 0, 600, ["开场白内容"]), seg(2, 600, 1200, ["贝叶斯公式推导"])];
  const chapters = [{ from: 0, to: 600, title: "开场白" }];

  it("无关内容 → []（不额外取段）", () => {
    expect(retrieveRawSegments({ prompt: "今天天气怎么样", chapters, rawSegments: raw })).toEqual([]);
  });

  it("优先级：时间戳 > 章节名 > 关键词（命中时间戳就不再按章节/关键词取段）", () => {
    // 「开场白」是章节名也是关键词，但 09:15 落在段1 → 段1 命中
    const hits = retrieveRawSegments({ prompt: "09:15 的开场白", chapters, rawSegments: raw });
    expect(hits.map((s) => s.index)).toEqual([1]);
  });

  it("时间戳未命中、章节名未命中、仅关键词命中时走关键词", () => {
    const hits = retrieveRawSegments({ prompt: "讲讲贝叶斯", chapters, rawSegments: raw });
    expect(hits.map((s) => s.index)).toEqual([2]);
  });
});

describe("边界与容错：空输入/坏数据永不抛错", () => {
  const raw = [seg(1, 0, 600, ["内容"])];

  it("空 prompt → []", () => {
    expect(retrieveRawSegments({ prompt: "", rawSegments: raw })).toEqual([]);
    expect(retrieveRawSegments({ prompt: "   ", rawSegments: raw })).toEqual([]);
  });

  it("空段/空章节/缺参 → []", () => {
    expect(retrieveRawSegments({ prompt: "09:15 讲啥", rawSegments: [] })).toEqual([]);
    expect(retrieveRawSegments({ prompt: "开场白", chapters: [], rawSegments: raw })).toEqual([]);
    expect(retrieveRawSegments()).toEqual([]);
    expect(retrieveRawSegments({})).toEqual([]);
  });

  it("畸形段（缺字段/NaN/非对象）跳过不炸", () => {
    const weird = [
      null,
      {},
      { index: 2, from: "bad", to: 600, items: null },
      { index: 3, from: NaN, to: 600, items: [] }
    ];
    expect(retrieveRawSegments({ prompt: "09:15 讲啥", rawSegments: weird })).toEqual([]);
    expect(matchByKeyword("abc", weird)).toEqual([]);
    expect(retrieveRawSegments({ prompt: "abc", rawSegments: weird })).toEqual([]);

    // 畸形段混入合法段：合法段仍正常命中
    const mixed = [null, seg(1, 0, 600, ["真实内容"])];
    expect(retrieveRawSegments({ prompt: "09:15 讲啥", rawSegments: mixed }).map((s) => s.index)).toEqual([1]);
  });

  it("畸形章节（缺 from/to）不炸", () => {
    const badChapters = [null, { title: "开场白" }, { from: "x", to: 600, title: "开场白" }];
    // 标题匹配只看 title（"标题匹配即可"），from/to 合法性在取段阶段才校验
    expect(matchChapterByTitle("开场白", badChapters).map((c) => c.title)).toEqual(["开场白", "开场白"]);
    // 两个命中章节 from 均非法（缺/非数字）→ 无法找回任何段
    expect(retrieveRawSegments({ prompt: "开场白", chapters: badChapters, rawSegments: raw })).toEqual([]);
  });

  it("prompt 非字符串 → 规整为字符串不炸", () => {
    expect(retrieveRawSegments({ prompt: null, rawSegments: raw })).toEqual([]);
    expect(retrieveRawSegments({ prompt: 123, rawSegments: raw })).toEqual([]);
  });
});
