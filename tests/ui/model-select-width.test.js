// tests/ui/model-select-width.test.js
// ui/model-select-width.js（候选09 自 sidepanel.js 迁出的纯 UI 度量叶子）的小
// 契约测试。jsdom 不带 canvas npm 包，HTMLCanvasElement.getContext 返回 null
// （已实测：打印 "Not implemented" 通知但不抛错），恰好覆盖模块内既有的
// 降级路径（!ctx → 每字符 8px 估算），据此守住三个关键不变量：
// - 降级测宽下的期望宽度算式（文本 8px/字符 + "000" 24 + 36 装饰余量）；
// - [92, maxWidth] 区间夹取（短文案触底 92、长文案被上限截断）；
// - 选中项缺失时回落「未配置平台」文案参与测量。
// getContext 显式 mock 为 null：不依赖 jsdom 版本的 canvas 行为，也消除
// "Not implemented" 的控制台噪音； maxWidth 分支经 toolbar=null（232 默认上限）
// 驱动（jsdom 无布局，clientWidth 恒 0，真实 toolbar 路径无可观测差异）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { measureTextWidth, updateModelSelectWidth } from "../../extension/ui/model-select-width.js";

beforeEach(() => {
  vi.spyOn(window.HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

function makeSelect(optionText) {
  const select = document.createElement("select");
  if (optionText !== undefined) {
    const option = document.createElement("option");
    option.textContent = optionText;
    select.appendChild(option);
    select.selectedIndex = 0;
  }
  return select;
}

function makeEls(optionText) {
  // toolbar/thinkingToggle/presetBtn 传 null：getModelSelectMaxWidth 走
  // 「toolbar 缺失 → 默认上限 232」分支，jsdom 下该分支外的计算（clientWidth
  // 恒 0）无可观测行为。
  return { modelSelect: makeSelect(optionText), toolbar: null, thinkingToggle: null, presetBtn: null };
}

describe("ui/model-select-width", () => {
  it("measureTextWidth：canvas 不可用时按每字符 8px 降级估算", () => {
    expect(measureTextWidth("000", { fontSize: "11px" })).toBe(24);
    expect(measureTextWidth("", { fontSize: "11px" })).toBe(0);
  });

  it("updateModelSelectWidth：modelSelect 缺失时直接返回，不写样式", () => {
    const els = { modelSelect: null, toolbar: null, thinkingToggle: null, presetBtn: null };
    expect(() => updateModelSelectWidth(els)).not.toThrow();
  });

  it("updateModelSelectWidth：短文案 desired 低于下限时触底 92px", () => {
    const els = makeEls("AI"); // 2×8 + 3×8 + 36 = 76 < 92
    updateModelSelectWidth(els);
    expect(els.modelSelect.style.width).toBe("92px");
  });

  it("updateModelSelectWidth：长文案 desired 超过默认上限 232 时被截断", () => {
    const els = makeEls("x".repeat(30)); // 30×8 + 24 + 36 = 300 > 232
    updateModelSelectWidth(els);
    expect(els.modelSelect.style.width).toBe("232px");
  });

  it("updateModelSelectWidth：无选中项时回落「未配置平台」参与测量", () => {
    const els = makeEls(); // 5×8 + 24 + 36 = 100
    updateModelSelectWidth(els);
    expect(els.modelSelect.style.width).toBe("100px");
  });
});
