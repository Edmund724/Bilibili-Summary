// tests/sidepanel/sidepanel-context-sync.test.js
// createLiveContextSync（实时上下文同步调度）行为契约（候选5 拆分直测）。
//
// 覆盖：
// - schedule：防抖（220ms 普通档 / 120ms 强刷快档）、重复 schedule 重置定时器、
//   forceRefresh 挂起合并（false 不覆盖 true）、到期只触发一次 sync 且消耗挂起标志；
// - handlers.onVisibilityChange：document.hidden 时不调度；可见时调度（false）；
// - handlers.onFocus / onTabActivated：调度 false；
// - handlers.onTabUpdated：非 active 标签页忽略；url 与 status 都没有时忽略；
//   url 变化强刷；仅 complete 不强刷。
//
// 依赖全注入（sync 回调 + 定时器 fake），纯 Node 时序验证，同 subtitle-wait 模板。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let createLiveContextSync;

beforeEach(async () => {
  resetModuleState();
  const module = await import("../../extension/pages/sidepanel-context-sync.js");
  createLiveContextSync = module.createLiveContextSync;
});

function makeHarness() {
  const timers = [];
  let timerSeq = 0;
  const deps = {
    sync: vi.fn(async () => {}),
    setTimer: vi.fn((fn, ms) => {
      const handle = { id: ++timerSeq, fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    }),
    clearTimer: vi.fn((handle) => {
      handle.cleared = true;
      const index = timers.indexOf(handle);
      if (index >= 0) {
        timers.splice(index, 1);
      }
    })
  };
  const syncInstance = createLiveContextSync(deps);
  const fireNextTimer = () => {
    const timer = timers.shift();
    if (!timer) {
      throw new Error("no pending timer");
    }
    timer.fn();
  };
  return { deps, syncInstance, timers, fireNextTimer };
}

describe("schedule（防抖 + 强刷合并）", () => {
  it("普通档 220ms 防抖，到期触发一次 sync(false)", () => {
    const { syncInstance, deps, timers, fireNextTimer } = makeHarness();

    syncInstance.schedule();

    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(220);

    fireNextTimer();
    expect(deps.sync).toHaveBeenCalledTimes(1);
    expect(deps.sync).toHaveBeenCalledWith(false);
    expect(timers).toHaveLength(0);
  });

  it("强刷档 120ms 快档，到期 sync(true)", () => {
    const { syncInstance, deps, timers, fireNextTimer } = makeHarness();

    syncInstance.schedule(true);

    expect(timers[0].ms).toBe(120);
    fireNextTimer();
    expect(deps.sync).toHaveBeenCalledWith(true);
  });

  it("重复 schedule 重置定时器（防抖），只触发最后一次", () => {
    const { syncInstance, deps, timers, fireNextTimer } = makeHarness();

    syncInstance.schedule(false);
    syncInstance.schedule(false);

    expect(timers).toHaveLength(1); // 旧定时器已作废移除
    fireNextTimer();
    expect(deps.sync).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(0);
  });

  it("forceRefresh 挂起合并：false 不覆盖 true（弱后到不降级强刷）", () => {
    const { syncInstance, deps, fireNextTimer } = makeHarness();

    syncInstance.schedule(true);
    syncInstance.schedule(false);

    fireNextTimer();
    expect(deps.sync).toHaveBeenCalledWith(true);
  });

  it("连续弱刷不升级：到期 sync(false)", () => {
    const { syncInstance, deps, fireNextTimer } = makeHarness();

    syncInstance.schedule(false);
    syncInstance.schedule(false);
    fireNextTimer();

    expect(deps.sync).toHaveBeenCalledWith(false);
  });
});

describe("handlers（四个触发源）", () => {
  it("onVisibilityChange：可见时调度 false，隐藏时不调度", () => {
    const { syncInstance, timers } = makeHarness();

    syncInstance.handlers.onVisibilityChange();
    // jsdom 默认 document.hidden === false → 调度
    expect(timers).toHaveLength(1);

    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    const count = timers.length;
    syncInstance.handlers.onVisibilityChange();
    expect(timers.length).toBe(count); // 隐藏：不调度
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  it("onFocus / onTabActivated：调度 false", () => {
    const { syncInstance, deps, timers, fireNextTimer } = makeHarness();

    syncInstance.handlers.onFocus();
    expect(timers).toHaveLength(1);
    fireNextTimer();

    syncInstance.handlers.onTabActivated();
    expect(timers).toHaveLength(1);
    fireNextTimer();

    expect(deps.sync).toHaveBeenCalledTimes(2);
    expect(deps.sync).toHaveBeenNthCalledWith(1, false);
    expect(deps.sync).toHaveBeenNthCalledWith(2, false);
  });

  it("onTabUpdated：非 active 标签页忽略", () => {
    const { syncInstance, timers } = makeHarness();

    syncInstance.handlers.onTabUpdated(1, { url: "https://x" }, { active: false });

    expect(timers).toHaveLength(0);
  });

  it("onTabUpdated：url 与 status 都没有时忽略", () => {
    const { syncInstance, timers } = makeHarness();

    syncInstance.handlers.onTabUpdated(1, {}, { active: true });

    expect(timers).toHaveLength(0);
  });

  it("onTabUpdated：url 变化强刷（true）", () => {
    const { syncInstance, deps, timers, fireNextTimer } = makeHarness();

    syncInstance.handlers.onTabUpdated(1, { url: "https://www.bilibili.com/video/BV2" }, { active: true });

    expect(timers[0].ms).toBe(120);
    fireNextTimer();
    expect(deps.sync).toHaveBeenCalledWith(true);
  });

  it("onTabUpdated：仅 complete 不强刷（false，交给签名短路）", () => {
    const { syncInstance, deps, timers, fireNextTimer } = makeHarness();

    syncInstance.handlers.onTabUpdated(1, { status: "complete" }, { active: true });

    expect(timers[0].ms).toBe(220);
    fireNextTimer();
    expect(deps.sync).toHaveBeenCalledWith(false);
  });
});
