// subtitle/core.js 的 findActiveSubtitleIndex 直测（候选10 批1：线性 → 二分）。
//
// 等价性策略：先在测试内保留一份旧线性实现作为参照（快照基准），用边界用例 +
// 随机模糊（有序不重叠 body，含间隙 / to 缺省 / 单条 / 空数组）逐一对比新旧
// 结果，必须完全一致。二分依赖「subtitleBody 按 from 升序」不变量——该不变量
// 由写入端 sortSubtitleBodyByFrom（fetcher / asr fallback 落 state 前）保证，
// 见 tests/subtitle/selection.test.js 的 sortSubtitleBodyByFrom 用例。

import { beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";
import { state } from "../../extension/core/state.js";
import { findActiveSubtitleIndex } from "../../extension/subtitle/core.js";

// 旧线性实现的快照基准（与重构前 core.js 逐字同语义）：
// to 缺省/非法时视为 from + 2；命中返回条目索引，否则 -1。
function legacyLinearFindActiveSubtitleIndex(body, currentTime) {
  const items = Array.isArray(body) ? body : [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const from = Number(item?.from || 0) || 0;
    const rawTo = Number(item?.to || 0) || 0;
    const to = rawTo > from ? rawTo : from + 2;
    if (currentTime >= from && currentTime < to) {
      return index;
    }
  }
  return -1;
}

function expectSameAsLegacy(body, currentTime) {
  state.clip.setSubtitleBody(body);
  expect(findActiveSubtitleIndex(currentTime)).toBe(
    legacyLinearFindActiveSubtitleIndex(body, currentTime)
  );
}

beforeEach(() => {
  resetModuleState();
});

describe("findActiveSubtitleIndex：与旧线性实现等价（边界用例）", () => {
  it("空数组返回 -1", () => {
    expectSameAsLegacy([], 0);
    expectSameAsLegacy([], 123.4);
    expectSameAsLegacy(undefined, 5);
  });

  it("单条字幕：命中与未命中", () => {
    const body = [{ from: 10, to: 20, content: "a" }];
    expectSameAsLegacy(body, 10); // 起点（含）
    expectSameAsLegacy(body, 15); // 中间
    expectSameAsLegacy(body, 19.999); // 终点前
    expectSameAsLegacy(body, 20); // 终点（不含）
    expectSameAsLegacy(body, 9.999); // 起点前
    expectSameAsLegacy(body, 25); // 终点后
  });

  it("命中首条 / 末条 / 中间条", () => {
    const body = [
      { from: 0, to: 10, content: "a" },
      { from: 10, to: 20, content: "b" },
      { from: 30, to: 40, content: "c" }
    ];
    expectSameAsLegacy(body, 0); // 首条
    expectSameAsLegacy(body, 5); // 首条中段
    expectSameAsLegacy(body, 35); // 末条
    expectSameAsLegacy(body, 39.5); // 末条尾
    expectSameAsLegacy(body, 15); // 中间条
  });

  it("间隙（前后条目之间）返回 -1", () => {
    const body = [
      { from: 0, to: 10, content: "a" },
      { from: 30, to: 40, content: "c" }
    ];
    expectSameAsLegacy(body, 15);
    expectSameAsLegacy(body, 29.999);
  });

  it("to 缺省/非法时视为 from + 2", () => {
    expectSameAsLegacy([{ from: 5, content: "no-to" }], 5);
    expectSameAsLegacy([{ from: 5, content: "no-to" }], 6.999);
    expectSameAsLegacy([{ from: 5, content: "no-to" }], 7);
    expectSameAsLegacy([{ from: 5, to: 0, content: "bad-to" }], 6.5);
    // 多条混排：带 to 与缺 to 相邻
    expectSameAsLegacy(
      [
        { from: 0, to: 10, content: "a" },
        { from: 12, content: "b" },
        { from: 20, to: 30, content: "c" }
      ],
      13.5
    );
  });

  it("时间早于全部条目 / 晚于全部条目返回 -1", () => {
    const body = [{ from: 100, to: 110, content: "a" }];
    expectSameAsLegacy(body, 0);
    expectSameAsLegacy(body, 99.9);
    expectSameAsLegacy(body, 110);
    expectSameAsLegacy(body, 500);
  });
});

describe("findActiveSubtitleIndex：与旧线性实现等价（随机模糊）", () => {
  // 随机生成「按 from 升序、区间严格不重叠（可带间隙）」的 body——与写入端
  // sortSubtitleBodyByFrom + B站 CC / ASR pipeline 产物的真实形态一致（条目都
  // 带有效 to）。严格不重叠时任意时刻至多一条命中，新旧实现必然同索引。
  // 注意：to 缺省（from+2）若落在相邻条目区间内会构成重叠，重叠数据上线性
  // 返回最早命中、二分返回最靠近候选点的命中（都是包含 t 的条目）——那属于
  // 防御性脏数据，见下方「重叠区间」用例的显式说明。
  function randomSortedBody(rng) {
    const length = 1 + Math.floor(rng() * 60);
    const body = [];
    let from = 0;
    for (let i = 0; i < length; i += 1) {
      from += rng() * 4; // 随机间隙
      const duration = 0.5 + rng() * 3;
      const item = { from: Math.round(from * 100) / 100, content: `line-${i}` };
      if (i < length - 1 || rng() < 0.5) {
        // 非末条必须带 to（保证与下一条不重叠）；末条随机缺省 to（from+2 语义）
        item.to = Math.round((from + duration) * 100) / 100;
      }
      body.push(item);
      from += duration;
    }
    return body;
  }

  it("有序不重叠 body（含间隙/to 缺省）上新旧结果完全一致", () => {
    // 可复现的伪随机序列（mulberry32）
    let seed = 20260829;
    const rng = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    for (let round = 0; round < 200; round += 1) {
      const body = randomSortedBody(rng);
      const maxFrom = body[body.length - 1].from + 4;
      for (let probe = 0; probe < 8; probe += 1) {
        const t = Math.round(rng() * maxFrom * 100) / 100;
        state.clip.setSubtitleBody(body);
        const actual = findActiveSubtitleIndex(t);
        const expected = legacyLinearFindActiveSubtitleIndex(body, t);
        if (actual !== expected) {
          expect.fail(
            `round=${round} t=${t} actual=${actual} expected=${expected} body=${JSON.stringify(body)}`
          );
        }
      }
      // 常驻探测点：首条起点、最末条之后
      expect(findActiveSubtitleIndex(body[0].from)).toBe(
        legacyLinearFindActiveSubtitleIndex(body, body[0].from)
      );
      expect(findActiveSubtitleIndex(maxFrom)).toBe(
        legacyLinearFindActiveSubtitleIndex(body, maxFrom)
      );
    }
  });

  it("长体（1500+ 条，长视频规模）二分命中正确且仍与线性一致", () => {
    const body = [];
    for (let i = 0; i < 1600; i += 1) {
      body.push({ from: i * 2, to: i * 2 + 1.8, content: `line-${i}` });
    }
    state.clip.setSubtitleBody(body);
    for (const t of [0, 1.79, 2, 999, 1000.5, 3198, 3199.9, 3200, 5000]) {
      expect(findActiveSubtitleIndex(t)).toBe(legacyLinearFindActiveSubtitleIndex(body, t));
    }
    expect(findActiveSubtitleIndex(999)).toBe(499); // 精确命中中段某条
    expect(findActiveSubtitleIndex(3200)).toBe(-1); // 末条终点（不含）
  });
});

describe("findActiveSubtitleIndex：重叠区间的已记录偏差（防御性脏数据）", () => {
  // 重叠只可能来自 to 缺省（from+2）压到相邻条目，或写入端排序前遗留的旧缓存。
  // 此类数据上线性实现返回「最早的命中条目」，二分实现返回「最靠近二分候选点
  // 的命中条目」——两者都是包含 currentTime 的条目，返回值约定（命中索引 / -1）
  // 不变；正常生产数据（条目带有效 to、区间不重叠）任意时刻至多一条命中，
  // 新旧实现完全一致。这里断言「返回的条目确实包含 t」而非与线性同索引。
  it("重叠区间：返回包含 currentTime 的条目", () => {
    const body = [
      { from: 0, to: 10, content: "a" },
      { from: 10, content: "b" }, // to 缺省 → [10, 12)，与下一条重叠
      { from: 11, to: 15, content: "c" }
    ];
    state.clip.setSubtitleBody(body);
    const index = findActiveSubtitleIndex(11.5);
    expect(index).toBe(2); // 候选点（最后 from <= t）即命中
    const item = body[index];
    const to = item.to > item.from ? item.to : item.from + 2;
    expect(11.5).toBeGreaterThanOrEqual(item.from);
    expect(11.5).toBeLessThan(to);
  });

  it("重叠区间但候选点未命中：有限回扫仍能找到包含 t 的条目", () => {
    const body = [
      { from: 0, to: 20, content: "a" }, // 深度覆盖（脏数据形态）
      { from: 5, to: 8, content: "b" },
      { from: 6, to: 9, content: "c" }
    ];
    state.clip.setSubtitleBody(body);
    const index = findActiveSubtitleIndex(7.5);
    expect(index).toBe(2);
    expect(7.5).toBeLessThan(body[2].to);
  });
});
