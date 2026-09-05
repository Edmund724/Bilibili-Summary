// 字幕轨切换「只装载、不直调渲染」防回焊锁（#3 subtitle-ready 单点收口）。
//
// 切轨 select 的 change 处理器只装载字幕（ensureSummarizeChain → loadSubtitle）；
// 重渲/同步完全由 loadSubtitle 内字幕接受事务的 subtitle-ready 通知驱动。历史上
// 处理器在 loadSubtitle 之后还经 whenReaderReady 直调 renderReadingView +
// syncReadingViewPlayback，与通知通道构成双渲染。本锁断言处理器不再触碰
// whenReaderReady 直调渲染通道；端到端「恰渲染一次」由
// subtitle-ready-once.test.js（链级）+ presenter-forward.test.ts（转发形状）
// 共同锁定。
//
// 壳构建走 digest-tabs.test.ts 同款 harness（真实 ui-renderer 建壳即绑定字幕
// tab 事件），reader-gate 与总结链加载器 mock 掉：前者正是被锁的直调通道，
// 后者隔离网络边界。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";

const { loadSubtitleMock } = vi.hoisted(() => ({
  loadSubtitleMock: vi.fn(async () => {})
}));

vi.mock("../../extension/subtitle/lazy.js", () => ({
  ensureSummarizeChain: vi.fn(async () => ({ loadSubtitle: loadSubtitleMock }))
}));

vi.mock("../../extension/ui/reader-gate.js", () => ({
  whenReaderReady: vi.fn(),
  withReader: vi.fn()
}));

const whenReaderReady = vi.mocked(await import("../../extension/ui/reader-gate.js")).whenReaderReady;
const ids = (await import("../../extension/reader/state.js")).ids;

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("字幕轨切换：只装载，不直调渲染", () => {
  beforeEach(async () => {
    resetModuleState();
    setLocationUrl(READER_MODE_URL);
    document.body.innerHTML = "";
    loadSubtitleMock.mockClear();
    (whenReaderReady as unknown as ReturnType<typeof vi.fn>).mockClear();
    const uiRenderer = await import("../../extension/ui/ui-renderer.js");
    uiRenderer.ensureUiReady({ forceRecreate: true });
    mountPlayerChain();
  });

  it("change 处理器装载所选字幕轨，不经 whenReaderReady 直调渲染", async () => {
    const select = document.getElementById(ids.readingSubtitleSelect) as HTMLSelectElement;
    expect(select).not.toBeNull();
    select.innerHTML =
      '<option value="https://fake.subtitle/url.json" data-lang="zh-CN" data-id="s1">中文（自动）</option>';
    select.selectedIndex = 0;

    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks();

    expect(loadSubtitleMock).toHaveBeenCalledTimes(1);
    expect(loadSubtitleMock).toHaveBeenCalledWith(
      "https://fake.subtitle/url.json",
      "zh-CN",
      expect.any(Number),
      "s1"
    );
    expect(whenReaderReady).not.toHaveBeenCalled();
  });

  it("loadSubtitle 失败走 catch 记日志，不触碰渲染通道", async () => {
    loadSubtitleMock.mockRejectedValueOnce(new Error("网络失败"));
    const select = document.getElementById(ids.readingSubtitleSelect) as HTMLSelectElement;
    select.innerHTML =
      '<option value="https://fake.subtitle/bad.json" data-lang="zh-CN" data-id="s2">中文</option>';
    select.selectedIndex = 0;

    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks();

    expect(loadSubtitleMock).toHaveBeenCalledTimes(1);
    expect(whenReaderReady).not.toHaveBeenCalled();
  });
});
