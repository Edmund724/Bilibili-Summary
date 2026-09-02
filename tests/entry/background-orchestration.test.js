// background-content-orchestration.js 的编排单测（background 半边注入恢复抽离）。
//
// 覆盖 SW 侧「content 注入恢复 + 触发重试」的全部时序/错误分类契约：
//   - ensureReaderContentReady：probe 首发即命中（零等待）、探针瞬时失败重试、
//     注入后第 N 轮轮询成功、轮询耗尽 → 整页 reload → 二次成功、二次耗尽 →
//     最终失败、探针全程无版本跳过 reload、reload 后页面未恢复、
//     DEFAULT_SETTINGS 哨兵吞掉 / 非哨兵错误上抛、canInject 守卫零副作用；
//   - triggerReaderModeInTab：12×300ms 重试成功/耗尽、「Receiving end does not
//     exist」分类（命中才走 ensureReaderContentReady 兜底，兜底失败不中止）、
//     ok:false 与非哨兵错误不触发兜底；
//   - triggerReaderModeCloseInTab：ok 短路、URL 二次确认、瞬时错误忽略、耗尽。
//
// 断言面向编排决策（调了 probe/inject/reload/兜底几次、间隔多少毫秒），不面向
// chrome API 细节：副作用全部依赖注入（与 pages/sidepanel-subtitle-wait 同一
// 手法）。除显式注入 delay spy 的用例外，均走生产默认 sleep（shared/utils.js），
// 由 vi.useFakeTimers 拦截——同时验证默认延时路径可被假时钟驱动。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBackgroundContentOrchestrator } from "../../extension/entry/background-content-orchestration.js";
import { sleep } from "../../extension/shared/utils.js";
import {
  DUPLICATE_CLASSIC_INJECTION_SENTINEL,
  RECEIVING_END_MISSING_SENTINEL
} from "../../extension/shared/content-error-sentinels.js";

const TAB_ID = 7;
const EXPECTED_VERSION = "2.0.0";
const STALE_VERSION = "0.9.0";
const READER_URL = "https://www.bilibili.com/video/BV1test000000/?boc_reader=1";

// deps 全注入的编排器 harness：默认 probe 命中期望版本、各副作用即时成功。
// delay 用生产默认 sleep（假时钟拦截）；需要断言间隔值的用例用 makeSpyDelayHarness。
function makeHarness(overrides = {}) {
  const deps = {
    probeOnce: vi.fn(async () => EXPECTED_VERSION),
    injectAssets: vi.fn(async () => {}),
    reloadTab: vi.fn(async () => {}),
    waitForTabComplete: vi.fn(async () => true),
    sendMessageToTab: vi.fn(async () => ({ ok: true })),
    isTabReaderModeOff: vi.fn(async () => true),
    canInject: vi.fn(() => true),
    expectedVersion: EXPECTED_VERSION,
    ...overrides
  };
  return { deps, orch: createBackgroundContentOrchestrator(deps) };
}

function makeSpyDelayHarness(overrides = {}) {
  return makeHarness({ delay: vi.fn((ms) => sleep(ms)), ...overrides });
}

// delay spy 记录到的毫秒序列（锁定轮询次数与间隔）
const msSeq = (harness) => harness.deps.delay.mock.calls.map((call) => call[0]);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ensureReaderContentReady", () => {
  it("probe 首发即命中期望版本：零等待、零注入、零 reload", async () => {
    const { orch, deps } = makeHarness();

    await expect(orch.ensureReaderContentReady(TAB_ID)).resolves.toBeUndefined();

    expect(deps.probeOnce).toHaveBeenCalledTimes(1);
    expect(deps.probeOnce).toHaveBeenCalledWith(TAB_ID);
    expect(deps.injectAssets).not.toHaveBeenCalled();
    expect(deps.reloadTab).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("canInject 为假（无 scripting / 无 tabId）：直接返回，零副作用", async () => {
    const { orch, deps } = makeHarness({ canInject: vi.fn(() => false) });

    await expect(orch.ensureReaderContentReady(0)).resolves.toBeUndefined();

    expect(deps.canInject).toHaveBeenCalledWith(0);
    expect(deps.probeOnce).not.toHaveBeenCalled();
    expect(deps.injectAssets).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("探针瞬时失败：3 发内重试成功，间隔 100ms，不触发注入", async () => {
    const { orch, deps } = makeSpyDelayHarness();
    deps.probeOnce
      .mockRejectedValueOnce(new Error("executeScript failed"))
      .mockRejectedValueOnce(new Error("executeScript failed"))
      .mockResolvedValueOnce(EXPECTED_VERSION);

    const promise = orch.ensureReaderContentReady(TAB_ID);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toBeUndefined();

    expect(deps.probeOnce).toHaveBeenCalledTimes(3);
    expect(msSeq({ deps })).toEqual([100, 100]);
    expect(deps.injectAssets).not.toHaveBeenCalled();
  });

  it("版本偏斜：注入后第 2 轮轮询成功（探针空版本按 3×100ms 内部重试）", async () => {
    const { orch, deps } = makeSpyDelayHarness();
    // 序列：初次探针读到旧版本 → 注入 → 轮询第 1 轮三发全空 → 第 2 轮首发命中
    deps.probeOnce
      .mockResolvedValueOnce(STALE_VERSION)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(EXPECTED_VERSION);

    const promise = orch.ensureReaderContentReady(TAB_ID);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBeUndefined();

    expect(deps.injectAssets).toHaveBeenCalledTimes(1);
    expect(deps.reloadTab).not.toHaveBeenCalled();
    expect(deps.probeOnce).toHaveBeenCalledTimes(5);
    // 第 1 轮探针内部重试 100ms×2 + 轮询间隔 150ms×1
    expect(msSeq({ deps })).toEqual([100, 100, 150]);
  });

  it("轮询耗尽 → 整页 reload → 等加载完 + 停顿 120ms → 二次注入轮询成功", async () => {
    let reloaded = false;
    const { orch, deps } = makeSpyDelayHarness({
      probeOnce: vi.fn(async () => (reloaded ? EXPECTED_VERSION : STALE_VERSION)),
      reloadTab: vi.fn(async () => {
        reloaded = true;
      })
    });

    const promise = orch.ensureReaderContentReady(TAB_ID);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(promise).resolves.toBeUndefined();

    expect(deps.injectAssets).toHaveBeenCalledTimes(2);
    expect(deps.reloadTab).toHaveBeenCalledTimes(1);
    expect(deps.waitForTabComplete).toHaveBeenCalledWith(TAB_ID, { polls: 40 });
    // 5 轮轮询：首轮不等 + 4×150ms；reload 完成后停顿 120ms
    expect(msSeq({ deps })).toEqual([150, 150, 150, 150, 120]);
    // 初次探针 + 5 轮轮询 + 二次轮询首发命中
    expect(deps.probeOnce).toHaveBeenCalledTimes(7);
  });

  it("二次轮询仍耗尽 → 最终失败（同步文案），reload 恰好一次", async () => {
    const { orch, deps } = makeSpyDelayHarness({
      probeOnce: vi.fn(async () => STALE_VERSION)
    });

    const promise = orch.ensureReaderContentReady(TAB_ID);
    const assertion = expect(promise).rejects.toThrow(
      "扩展脚本未能和当前页面同步，请刷新浏览器网页重试"
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    expect(deps.reloadTab).toHaveBeenCalledTimes(1);
    expect(deps.injectAssets).toHaveBeenCalledTimes(2);
    // 两段 5 轮轮询（4×150）+ 停顿 120ms
    expect(msSeq({ deps })).toEqual([150, 150, 150, 150, 120, 150, 150, 150, 150]);
    expect(deps.probeOnce).toHaveBeenCalledTimes(11);
  });

  it("探针全程无版本：跳过 reload 直接最终失败", async () => {
    const { orch, deps } = makeHarness({
      probeOnce: vi.fn(async () => "")
    });

    const promise = orch.ensureReaderContentReady(TAB_ID);
    const assertion = expect(promise).rejects.toThrow(
      "扩展脚本未能和当前页面同步，请刷新浏览器网页重试"
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    expect(deps.injectAssets).toHaveBeenCalledTimes(1);
    expect(deps.reloadTab).not.toHaveBeenCalled();
    expect(deps.waitForTabComplete).not.toHaveBeenCalled();
    // 初次探针 + 5 轮轮询各 3 发（空版本内部重试）
    expect(deps.probeOnce).toHaveBeenCalledTimes(18);
  });

  it("reload 后页面未恢复：抛「页面未及时恢复」，无停顿、无二次注入", async () => {
    const { orch, deps } = makeSpyDelayHarness({
      probeOnce: vi.fn(async () => STALE_VERSION),
      waitForTabComplete: vi.fn(async () => false)
    });

    const promise = orch.ensureReaderContentReady(TAB_ID);
    const assertion = expect(promise).rejects.toThrow(
      "扩展更新后页面未及时恢复，请刷新浏览器网页重试"
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    expect(deps.reloadTab).toHaveBeenCalledTimes(1);
    expect(deps.waitForTabComplete).toHaveBeenCalledWith(TAB_ID, { polls: 40 });
    expect(deps.injectAssets).toHaveBeenCalledTimes(1);
    expect(msSeq({ deps })).toEqual([150, 150, 150, 150]);
  });

  it("注入报错命中 DEFAULT_SETTINGS 哨兵：视为已注入吞掉，继续轮询", async () => {
    const { orch, deps } = makeHarness();
    deps.probeOnce
      .mockResolvedValueOnce(STALE_VERSION)
      .mockResolvedValueOnce(EXPECTED_VERSION);
    deps.injectAssets.mockRejectedValueOnce(
      new Error(`Uncaught SyntaxError: ${DUPLICATE_CLASSIC_INJECTION_SENTINEL}`)
    );

    await expect(orch.ensureReaderContentReady(TAB_ID)).resolves.toBeUndefined();

    expect(deps.injectAssets).toHaveBeenCalledTimes(1);
  });

  it("注入报错非哨兵：原样上抛（错误对象同一性）", async () => {
    const { orch, deps } = makeHarness();
    const failure = new Error("Cannot access 'foo' before initialization");
    deps.probeOnce.mockResolvedValue(STALE_VERSION);
    deps.injectAssets.mockRejectedValue(failure);

    await expect(orch.ensureReaderContentReady(TAB_ID)).rejects.toBe(failure);
    expect(deps.reloadTab).not.toHaveBeenCalled();
  });

  it("probeContentScriptVersion：全程落空返回空串（3 发、间隔 100ms）", async () => {
    const { orch, deps } = makeSpyDelayHarness({
      probeOnce: vi.fn(async () => "")
    });

    const promise = orch.probeContentScriptVersion(TAB_ID);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toBe("");

    expect(deps.probeOnce).toHaveBeenCalledTimes(3);
    expect(msSeq({ deps })).toEqual([100, 100]);
  });
});

describe("triggerReaderModeInTab", () => {
  it("首发即 ok：返回 true，消息契约正确，零兜底零延时", async () => {
    const { orch, deps } = makeHarness();

    await expect(orch.triggerReaderModeInTab(TAB_ID, READER_URL)).resolves.toBe(true);

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(1);
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(TAB_ID, {
      type: "popup-trigger-reading-view",
      readerUrl: READER_URL
    });
    expect(deps.probeOnce).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Receiving end 错误 → 兜底 ensureReaderContentReady → 下一轮成功", async () => {
    const { orch, deps } = makeSpyDelayHarness();
    deps.sendMessageToTab
      .mockRejectedValueOnce(new Error(RECEIVING_END_MISSING_SENTINEL))
      .mockResolvedValueOnce({ ok: true });

    const promise = orch.triggerReaderModeInTab(TAB_ID, READER_URL);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBe(true);

    // 兜底真的跑过（canInject/探针被调），随后重试成功
    expect(deps.canInject).toHaveBeenCalledWith(TAB_ID);
    expect(deps.probeOnce).toHaveBeenCalledTimes(1);
    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(2);
    expect(msSeq({ deps })).toEqual([300]);
  });

  it("ok:false（无异常）：不触发兜底，重试后成功", async () => {
    const { orch, deps } = makeSpyDelayHarness();
    deps.sendMessageToTab
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    const promise = orch.triggerReaderModeInTab(TAB_ID, READER_URL);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBe(true);

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(2);
    expect(deps.probeOnce).not.toHaveBeenCalled();
    expect(msSeq({ deps })).toEqual([300]);
  });

  it("非 Receiving end 错误：不触发兜底，静默重试 12 次耗尽 → false", async () => {
    const { orch, deps } = makeSpyDelayHarness();
    deps.sendMessageToTab.mockRejectedValue(
      new Error("The message port closed before a response was received.")
    );

    const promise = orch.triggerReaderModeInTab(TAB_ID, READER_URL);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(promise).resolves.toBe(false);

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(12);
    expect(deps.canInject).not.toHaveBeenCalled();
    expect(deps.probeOnce).not.toHaveBeenCalled();
    // 首轮不等 + 11×300ms
    expect(msSeq({ deps })).toEqual(Array.from({ length: 11 }, () => 300));
  });

  it("Receiving end 持续且兜底持续失败：仍 12 次重试后 false（兜底失败不中止）", async () => {
    const { orch, deps } = makeHarness();
    deps.sendMessageToTab.mockRejectedValue(new Error(RECEIVING_END_MISSING_SENTINEL));
    deps.probeOnce.mockRejectedValue(new Error("executeScript failed"));

    const promise = orch.triggerReaderModeInTab(TAB_ID, READER_URL);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(promise).resolves.toBe(false);

    // 每轮重试都试过兜底，兜底抛错被吞、重试循环继续
    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(12);
    expect(deps.canInject).toHaveBeenCalledTimes(12);
  });
});

describe("triggerReaderModeCloseInTab", () => {
  it("首发即 ok：返回 true，不做 URL 二次确认", async () => {
    const { orch, deps } = makeHarness();

    await expect(orch.triggerReaderModeCloseInTab(TAB_ID)).resolves.toBe(true);

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(1);
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(TAB_ID, {
      type: "popup-close-reading-view"
    });
    expect(deps.isTabReaderModeOff).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ok:false → URL 二次确认已退出：返回 true，零延时", async () => {
    const { orch, deps } = makeHarness();
    deps.sendMessageToTab.mockResolvedValue({ ok: false });
    deps.isTabReaderModeOff.mockResolvedValue(true);

    await expect(orch.triggerReaderModeCloseInTab(TAB_ID)).resolves.toBe(true);

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(1);
    expect(deps.isTabReaderModeOff).toHaveBeenCalledTimes(1);
    expect(deps.isTabReaderModeOff).toHaveBeenCalledWith(TAB_ID);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("发送异常（瞬时失败）被忽略 → URL 二次确认退出：返回 true", async () => {
    const { orch, deps } = makeHarness();
    deps.sendMessageToTab.mockRejectedValue(new Error("The message port closed"));
    deps.isTabReaderModeOff.mockResolvedValue(true);

    await expect(orch.triggerReaderModeCloseInTab(TAB_ID)).resolves.toBe(true);

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(1);
    expect(deps.isTabReaderModeOff).toHaveBeenCalledTimes(1);
  });

  it("12 次重试耗尽（URL 始终未退出）→ false，间隔 300ms", async () => {
    const { orch, deps } = makeSpyDelayHarness();
    deps.sendMessageToTab.mockResolvedValue({ ok: false });
    deps.isTabReaderModeOff.mockResolvedValue(false);

    const promise = orch.triggerReaderModeCloseInTab(TAB_ID);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(promise).resolves.toBe(false);

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(12);
    expect(deps.isTabReaderModeOff).toHaveBeenCalledTimes(12);
    expect(msSeq({ deps })).toEqual(Array.from({ length: 11 }, () => 300));
  });
});
