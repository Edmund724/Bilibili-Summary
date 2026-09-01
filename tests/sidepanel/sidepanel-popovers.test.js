// tests/sidepanel/sidepanel-popovers.test.js
// createPopovers（预设/历史 popover 开合 + 文档级外点关闭）行为契约（候选5
// 拆分直测）。
//
// 覆盖：
// - togglePresetPopover：开（刷新预设列表 + 清输入 + focus）且关历史 popover、
//   再 toggle 关、stopPropagation；
// - toggleHistoryPopover：开（刷新历史列表）且关预设 popover、再 toggle 关；
// - handleDocumentClick：两者都关时 no-op；点击 popover/按钮内部不关；点击外部
//   关两者；非 Element target 全关。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let createPopovers;

beforeEach(async () => {
  resetModuleState();
  const module = await import("../../extension/pages/sidepanel-popovers.js");
  createPopovers = module.createPopovers;
});

function makeHarness() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const presetPopover = document.createElement("div");
  presetPopover.id = "spPresetPopover";
  const historyPopover = document.createElement("div");
  historyPopover.id = "spHistoryPopover";
  const presetBtn = document.createElement("button");
  presetBtn.id = "spPresetBtn";
  const historyBtn = document.createElement("button");
  historyBtn.id = "spHistoryBtn";
  const presetInput = document.createElement("input");
  container.append(presetPopover, historyPopover, presetBtn, historyBtn, presetInput);
  const deps = {
    presetPopover,
    historyPopover,
    presetBtn,
    historyBtn,
    presetInput,
    renderPresetPrompts: vi.fn(),
    renderHistoryList: vi.fn()
  };
  const popovers = createPopovers(deps);
  // 初始态：两个 popover 可见（hidden=false），toggle 后才隐藏（与迁移前判定一致：
  // willShow = popover.hidden）
  presetPopover.hidden = false;
  historyPopover.hidden = false;
  return { deps, popovers, presetPopover, historyPopover, presetBtn, historyBtn, presetInput };
}

describe("togglePresetPopover", () => {
  it("开预设 popover：刷新预设列表 + 清输入 + focus，并关历史 popover", () => {
    const { popovers, deps, presetPopover, historyPopover, presetInput } = makeHarness();
    historyPopover.hidden = true;
    presetPopover.hidden = true;

    popovers.togglePresetPopover();

    expect(presetPopover.hidden).toBe(false);
    expect(historyPopover.hidden).toBe(true);
    expect(deps.renderPresetPrompts).toHaveBeenCalledTimes(1);
    expect(presetInput.value).toBe("");
    expect(document.activeElement).toBe(presetInput);
  });

  it("可见时再 toggle：关闭（不重复刷新）", () => {
    const { popovers, deps, presetPopover } = makeHarness();

    popovers.togglePresetPopover();

    expect(presetPopover.hidden).toBe(true);
    expect(deps.renderPresetPrompts).not.toHaveBeenCalled();
  });

  it("事件对象被 stopPropagation（不冒泡触发文档级关闭）", () => {
    const { popovers } = makeHarness();
    const event = new MouseEvent("click", { bubbles: true });
    const stopSpy = vi.spyOn(event, "stopPropagation");

    popovers.togglePresetPopover(event);

    expect(stopSpy).toHaveBeenCalled();
  });
});

describe("toggleHistoryPopover", () => {
  it("开历史 popover：刷新历史列表，并关预设 popover", () => {
    const { popovers, deps, presetPopover, historyPopover } = makeHarness();
    historyPopover.hidden = true;
    presetPopover.hidden = true;

    popovers.toggleHistoryPopover();

    expect(historyPopover.hidden).toBe(false);
    expect(presetPopover.hidden).toBe(true);
    expect(deps.renderHistoryList).toHaveBeenCalledTimes(1);
  });

  it("可见时再 toggle：关闭", () => {
    const { popovers, historyPopover } = makeHarness();

    popovers.toggleHistoryPopover();

    expect(historyPopover.hidden).toBe(true);
  });
});

describe("handleDocumentClick（外点关闭）", () => {
  it("两个 popover 都隐藏时 no-op", () => {
    const { popovers, presetPopover, historyPopover } = makeHarness();
    presetPopover.hidden = true;
    historyPopover.hidden = true;
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    popovers.handleDocumentClick({ target: outside });

    expect(presetPopover.hidden).toBe(true);
    expect(historyPopover.hidden).toBe(true);
  });

  it("点击 popover 内部 / 触发按钮：不关闭", () => {
    const { popovers, presetPopover, historyPopover, presetBtn, historyBtn } = makeHarness();
    const insidePreset = document.createElement("span");
    presetPopover.appendChild(insidePreset);
    const insideHistory = document.createElement("span");
    historyPopover.appendChild(insideHistory);

    popovers.handleDocumentClick({ target: insidePreset });
    expect(presetPopover.hidden).toBe(false);
    expect(historyPopover.hidden).toBe(false);

    popovers.handleDocumentClick({ target: presetBtn });
    expect(presetPopover.hidden).toBe(false);

    popovers.handleDocumentClick({ target: insideHistory });
    expect(historyPopover.hidden).toBe(false);

    popovers.handleDocumentClick({ target: historyBtn });
    expect(historyPopover.hidden).toBe(false);
  });

  it("点击外部：两个 popover 都关闭", () => {
    const { popovers, presetPopover, historyPopover } = makeHarness();
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    popovers.handleDocumentClick({ target: outside });

    expect(presetPopover.hidden).toBe(true);
    expect(historyPopover.hidden).toBe(true);
  });

  it("非 Element target（如 document/text node）：全关", () => {
    const { popovers, presetPopover, historyPopover } = makeHarness();

    popovers.handleDocumentClick({ target: document });

    expect(presetPopover.hidden).toBe(true);
    expect(historyPopover.hidden).toBe(true);
  });
});
