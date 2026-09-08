// 后台字幕抓取落定后的「对账收尾」回归测试（M22 digest-eager-subtitle-overview）。
//
// subtitle-ready 通知存在丢失形态（发射门控、init-essentials 分派链 catch 吞错），
// 一旦丢失，列表渲染与概览自动生成只剩切 tab 兜底，而状态栏照写「抓取完成」
// ——出现「完成但显示无字幕」的面板态。修复：lifecycle.
// maybeRefreshReaderSubtitleInBackground 在 requestSubtitleRefresh() 落定后
// reconcile——视图开着则 renderReadingView()（幂等 state 投影），subtitleBody
// 非空再 triggerReaderOverviewGeneration()（inflight + 身份去重，重复触发安全）。
//
// 手法：refresh 落盘口（reader-bus.subscribeSubtitleRefresh）注入 spy 同步写
// state 模拟抓取成功；概览触发以 vi.fn 替身观察（真实生成管线归 overview.test.ts）。
// 注意 refresh 句柄取 subtitleRefreshHandlers[0]，本套件先订阅 spy、
// ensureSummarizeChain 后装载的 refreshClip 排在其后，不会被调用。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mockPlayerRects, mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

vi.mock("../../extension/reader/overview.js", async (importActual) => {
  const actual = await importActual<typeof import("../../extension/reader/overview.js")>();
  return {
    ...actual,
    triggerReaderOverviewGeneration: vi.fn(() => Promise.resolve())
  };
});

let state: TestState;
let shell: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let overview: typeof import("../../extension/reader/overview.js");

async function loadModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  shell = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
  overview = await import("../../extension/reader/overview.js");
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadModules();
  mountReaderSkeleton(ids);
  mountPlayerChain();
  mockPlayerRects();
  // waitForVideoMetadata 不等满超时：给 stub 视频一个有效 duration。
  const video = document.querySelector("video") as HTMLVideoElement;
  Object.defineProperty(video, "duration", { value: 120, configurable: true });
});

afterEach(() => {
  try {
    shell.stopReadingViewSync();
  } catch {
    // ignore
  }
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("后台抓取落定后的对账收尾（通知丢失兜底）", () => {
  it("refresh 落定 → 字幕列表按落定数据渲染、概览生成再次触发", async () => {
    const readerBus = await import("../../extension/reader/reader-bus.js");
    const refreshSpy = vi.fn(() => {
      state.clip.bvid = "BV1test000000";
      state.clip.subtitleFetchState = "ready";
      state.clip.subtitleBody = [
        { from: 0, to: 10, content: "大家好" },
        { from: 10, to: 30, content: "开始今天的话题" }
      ];
      return Promise.resolve();
    });
    readerBus.subscribeSubtitleRefresh(refreshSpy);

    await shell.enterReaderMode();

    // 打开即触发（点 Digest 同时启动抓取与概览生成；此时 body 为空早退），
    // 概览触发电不依赖用户切 tab。
    expect(overview.triggerReaderOverviewGeneration).toHaveBeenCalledTimes(1);

    // 对账：抓取落定后列表按 state 重渲染（无字幕空态 → 有数据列表），
    // 概览生成再次触发。
    await vi.waitFor(() => {
      expect(document.querySelectorAll(".boc-reading-item").length).toBe(2);
    });
    expect(overview.triggerReaderOverviewGeneration).toHaveBeenCalledTimes(2);

    shell.closeReadingView();
  });

  it("refresh 落定时视图已关：跳过对账（重开时 enterReaderMode 自会渲染+触发）", async () => {
    const readerBus = await import("../../extension/reader/reader-bus.js");
    const refreshSpy = vi.fn(() => {
      state.clip.bvid = "BV1test000000";
      state.clip.subtitleFetchState = "ready";
      state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
      return Promise.resolve();
    });
    readerBus.subscribeSubtitleRefresh(refreshSpy);

    await shell.enterReaderMode();
    shell.closeReadingView();
    await refreshSpy(); // 落定发生在视图关闭之后

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(overview.triggerReaderOverviewGeneration).toHaveBeenCalledTimes(1);

    // 重开按当前 state 渲染 + 触发，数据不丢
    await shell.enterReaderMode();
    await vi.waitFor(() => {
      expect(document.querySelectorAll(".boc-reading-item").length).toBe(1);
    });
    shell.closeReadingView();
  });
});
