// 自愈调度收口（arch-slim-2/09）：ui/digest-button.ts 的自查 interval
// 暂停/恢复时序测试。
//
// 收口语义：
// - 壳打开且完好（视图接管态）：按钮恒被守卫摘除，自查只剩空跑
//   isReaderShellIntact 的 DOM 查询 → interval 降频至暂停档（2s 兜底，而非
//   全停——恢复事件丢失时按钮最迟一个兜底 tick 补回）；
// - 壳关闭（exitReaderShell 派发 READER_CLOSED_EVENT 窗口事件）：恢复常速
//   （800ms 单源 shared/self-heal.js）并首拍立即补回按钮；
// - 暂停期壳失整：自查恢复常速，brokenTicks 三连拍确认后派发 reader-restore
//   自愈（失同步链路行为与收口前一致，只是首拍发现最多延迟一个兜底 tick）。
//
// mock 面：isReaderViewOpen / isReaderShellIntact / 页内分发原语
// dispatchContentScriptMessage（shared/messaging.js）——本文件只验证调度时序，
// 处理器路由与注入锚点由 digest-button.test.js / digest-button-click.test.js
// 的真实模块用例覆盖。定时器全文件 fake（与 digest-button.test.js 同款）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, setLocationUrl, NORMAL_PAGE_URL } from "../setup.js";
import { READER_CLOSED_EVENT } from "../../extension/shared/self-heal.js";

const mocks = vi.hoisted(() => ({
  isReaderViewOpen: vi.fn(() => false),
  isReaderShellIntact: vi.fn(() => true),
  dispatchContentScriptMessage: vi.fn(() => false)
}));

vi.mock("../../extension/reader/state.js", () => ({
  isReaderViewOpen: mocks.isReaderViewOpen
}));
vi.mock("../../extension/reader/shell.js", () => ({
  isReaderShellIntact: mocks.isReaderShellIntact
}));
vi.mock("../../extension/shared/messaging.js", () => ({
  dispatchContentScriptMessage: mocks.dispatchContentScriptMessage
}));

async function loadModule() {
  const lazy = await import("../../extension/ui/lazy-digest-button.js");
  return lazy.loadDigestButton();
}

// 模块求值即启动生命周期：settle 链（readyState complete → video 已挂 →
// 1200ms 余量）跑完后执行首轮注入，再挂常速自查 interval。
async function runSettleChain() {
  await vi.advanceTimersByTimeAsync(1300);
}

function makeToolbarHtml() {
  return `
    <div id="arc_toolbar_report">
      <div class="video-toolbar-left"><div class="video-toolbar-left-main"></div></div>
      <div class="video-toolbar-right">
        <div class="video-complaint"><span>稿件举报</span></div>
        <div class="video-note"></div>
      </div>
    </div>`;
}

beforeEach(() => {
  resetModuleState();
  vi.useFakeTimers();
  setLocationUrl(NORMAL_PAGE_URL);
  document.body.innerHTML = "";
  mocks.isReaderViewOpen.mockReturnValue(false);
  mocks.isReaderShellIntact.mockReturnValue(true);
  mocks.dispatchContentScriptMessage.mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// 健康态起手：settle 链跑完 → 按钮注入 + 常速 interval。
async function startHealthy() {
  document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;
  const setIntervalSpy = vi.spyOn(window, "setInterval");
  await loadModule();
  await runSettleChain();
  expect(document.getElementById("boc-digest-button")).not.toBeNull();
  setIntervalSpy.mockClear();
  return setIntervalSpy;
}

// 进入接管态：视图开 + 壳完好 → 下一常速拍摘按钮并降频。
async function enterPausedState(setIntervalSpy) {
  mocks.isReaderViewOpen.mockReturnValue(true);
  mocks.isReaderShellIntact.mockReturnValue(true);
  await vi.advanceTimersByTimeAsync(801);
  expect(document.getElementById("boc-digest-button")).toBeNull();
  expect(setIntervalSpy.mock.calls.some(([, ms]) => ms === 2000)).toBe(true);
}

describe("digest-button 自查 interval 暂停/恢复（arch-slim-2/09）", () => {
  it("壳打开且完好：按钮摘除，自查降频至暂停档 2s 兜底", async () => {
    const setIntervalSpy = await startHealthy();

    await enterPausedState(setIntervalSpy);

    // 暂停档兜底 tick 仍在跑且保持摘除（壳完好 ⇒ 不派发恢复）。
    await vi.advanceTimersByTimeAsync(2000);
    expect(document.getElementById("boc-digest-button")).toBeNull();
    expect(mocks.dispatchContentScriptMessage).not.toHaveBeenCalled();
  });

  it("壳关闭（READER_CLOSED_EVENT）：恢复常速并首拍立即补回按钮", async () => {
    const setIntervalSpy = await startHealthy();
    await enterPausedState(setIntervalSpy);

    // exitReaderShell 完成退出事务后派发（本测试以事件直发模拟）。
    mocks.isReaderViewOpen.mockReturnValue(false);
    window.dispatchEvent(new CustomEvent(READER_CLOSED_EVENT));

    // 首拍：不推进任何定时器即补回按钮，interval 恢复 800ms 常速。
    expect(document.getElementById("boc-digest-button")).not.toBeNull();
    expect(setIntervalSpy.mock.calls.some(([, ms]) => ms === 800)).toBe(true);

    // 常速自查维持健康态（不重复注入、不再摘除）。
    await vi.advanceTimersByTimeAsync(801);
    expect(document.getElementById("boc-digest-button")).not.toBeNull();
  });

  it("暂停期壳失整：恢复常速，三连拍确认后派发 reader-restore 自愈", async () => {
    const setIntervalSpy = await startHealthy();
    await enterPausedState(setIntervalSpy);

    // 壳失整：暂停档兜底 tick（≤2s 窗口）发现后恢复常速。
    mocks.isReaderShellIntact.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(setIntervalSpy.mock.calls.some(([, ms]) => ms === 800)).toBe(true);

    // brokenTicks 连击确认（RESTORE_CONFIRM_TICKS=3，常速 800ms/拍）后派发。
    await vi.advanceTimersByTimeAsync(2 * 801);
    expect(mocks.dispatchContentScriptMessage).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchContentScriptMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "reader-restore" }),
      expect.anything()
    );
  });
});
