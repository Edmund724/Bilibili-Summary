// arch-review-2026-09/01：字幕搜索热路径三修的回归网（1500 条全量命中夹具）。
//
// - 修1：clearSearchHighlights 的 normalize 出循环——清除时对列表整体 normalize
//   一次，不再每个 mark 各扫一次全子树（全量命中下 O(n²)）；
// - 修2：批次回执 handleReadingSubtitleRangeAppended 对有序 matches 数组二分
//   取批次 index 区间子集，不遍历 matchesByItem 全表。
//
// 测试直驱 reader/subtitle-search.js 模块缝（不经完整 reader shell）：手工搭
// 列表 DOM + state.clip.subtitleBody，行为断言与计数断言共享同一夹具。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";

const TOTAL_ITEMS = 1500;
const KEYWORD = "目标词";

let state;
let ids;
let search;

function buildFixture() {
  document.body.innerHTML = "";
  const input = document.createElement("input");
  input.id = ids.readingSearchInput;
  document.body.appendChild(input);
  const list = document.createElement("div");
  list.id = ids.readingSubtitleList;
  document.body.appendChild(list);
  const body = [];
  for (let i = 0; i < TOTAL_ITEMS; i += 1) {
    const content = `第${i}条含${KEYWORD}的句子`;
    body.push({ from: i * 2, to: i * 2 + 1.9, content });
    const item = document.createElement("div");
    item.className = "boc-reading-item";
    item.dataset.index = String(i);
    const text = document.createElement("span");
    text.className = "boc-reading-text";
    text.textContent = content;
    item.appendChild(text);
    list.appendChild(item);
  }
  state.clip.setSubtitleBody(body);
  return { input, list };
}

function markCount() {
  return document.querySelectorAll(`mark.boc-reading-search-hit`).length;
}

function itemText(index) {
  return document.querySelector(`[data-index="${index}"] .boc-reading-text`);
}

beforeEach(async () => {
  resetModuleState();
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state;
  ids = (await import("../../extension/reader/state.js")).ids;
  search = await import("../../extension/reader/subtitle-search.js");
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("字幕搜索热路径（1500 条全量命中夹具）", () => {
  it("修1：清除高亮只 normalize 列表一次，且文本逐字还原", () => {
    const { input } = buildFixture();
    input.value = KEYWORD;
    search.refreshReadingSubtitleSearch({ scroll: false });
    expect(markCount()).toBe(TOTAL_ITEMS);

    const normalizeSpy = vi.spyOn(Node.prototype, "normalize");
    input.value = "";
    search.refreshReadingSubtitleSearch({ scroll: false });

    expect(markCount()).toBe(0);
    expect(normalizeSpy).toHaveBeenCalledTimes(1);
    expect(normalizeSpy.mock.instances[0].id).toBe(ids.readingSubtitleList);
    expect(itemText(0).textContent).toBe(`第0条含${KEYWORD}的句子`);
    expect(itemText(TOTAL_ITEMS - 1).textContent).toBe(`第${TOTAL_ITEMS - 1}条含${KEYWORD}的句子`);
  });

  it("修2：批次回执按区间二分取子集，DOM 访问以区间宽为量级", () => {
    const { input, list } = buildFixture();
    input.value = KEYWORD;
    search.refreshReadingSubtitleSearch({ scroll: false });
    expect(markCount()).toBe(TOTAL_ITEMS);

    // 模拟批次回执场景：区间内条目按「新上屏」形态还原为无 mark 纯文本
    const from = 500;
    const to = 510;
    for (let i = from; i < to; i += 1) {
      itemText(i).replaceChildren(`第${i}条含${KEYWORD}的句子`);
    }
    expect(itemText(from).querySelector("mark")).toBe(null);

    // 统计回执期间对列表的 querySelector 调用：getItemNode 每处理一个区间
    // 内条目定位一次；全表扫描形态的实现会是 TOTAL_ITEMS 次起步
    const querySpy = vi.spyOn(list, "querySelector");
    try {
      search.handleReadingSubtitleRangeAppended(from, to);
    } finally {
      vi.restoreAllMocks();
    }

    // 区间内 10 个条目逐一补高亮，区间外不动
    for (let i = from; i < to; i += 1) {
      expect(itemText(i).querySelectorAll("mark").length).toBe(1);
    }
    expect(itemText(from).querySelector("mark").textContent).toBe(KEYWORD);
    expect(markCount()).toBe(TOTAL_ITEMS);
    // 区间取子集：恰为区间宽次定位，与全表规模无关
    expect(querySpy).toHaveBeenCalledTimes(to - from);
  });
});
