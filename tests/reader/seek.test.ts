// 候选06 seek 深入口测试：seekReadingTarget 的规范序与播放策略参数化。
//
// 覆盖：
// - 规范序：清手动滚动暂停先于 currentTime 赋值（旧侧栏手抄序先 currentTime
//   后清暂停，currentTime 触发的 timeupdate 会在暂停标志未清时跑同步）；
// - resumePlayback:true：暂停中自动播放（阅读视图内点击语义）；
// - resumePlayback:false：暂停中不自动播放（侧栏 seek 语义）；
// - 正在播放时不重复 play；jumpReadingTarget 委托 = resumePlayback:true；
// - 非法时间截断；无可用视频时返回 null 并写状态栏。
//
// mock video/时钟手法：jsdom 视频的 currentTime 换成「记录型」存取器，赋值即
// 同步派发 timeupdate（复刻浏览器 seek → timeupdate 行为），并在赋值瞬间记录
// 手动滚动暂停状态（scroll-state.js 共享叶子的真实读取），使调用顺序可断言。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mockPlayerRects, mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let shell: typeof import("../../extension/reader/index.js");
let scrollState: typeof import("../../extension/reader/state.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let video: HTMLVideoElement;

async function loadReaderModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  shell = await import("../../extension/reader/index.js");
  // scroll-state/ids 与动态域同批 import：resetModules 后必须取同一模块实例，
  // 否则测试读到的暂停状态与被测代码读到的不是同一份闭包。
  const stateModule = await import("../../extension/reader/state.js");
  scrollState = stateModule;
  ids = stateModule.ids;
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadReaderModules();
  mountReaderSkeleton(ids);
  video = mountPlayerChain();
  mockPlayerRects();
  state.clip.chapters = [{ title: "开场", from: 0 }];
  state.clip.subtitleBody = [
    { from: 0, to: 10, content: "大家好" },
    { from: 10, to: 30, content: "第二句" },
    { from: 30, to: 60, content: "第三句" }
  ];
  state.reader.readingViewOpen = true;
  state.reader.readingNativePageMode = true;
  state.reader.readingAutoScroll = true;
  shell.renderReadingView();
  shell.bindReadingViewVideo(video);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

interface CurrentTimeLogEntry {
  pausedAtAssign: boolean;
  next: number;
}

// 把视频的 currentTime 换成记录型存取器（见文件头说明），返回记录数组。
function recordCurrentTimeAssignments(targetVideo: HTMLVideoElement) {
  const log: CurrentTimeLogEntry[] = [];
  let value = targetVideo.currentTime;
  Object.defineProperty(targetVideo, "currentTime", {
    configurable: true,
    get: () => value,
    set: (next: number) => {
      log.push({ pausedAtAssign: scrollState.isManualScrollPaused(), next });
      value = next;
      targetVideo.dispatchEvent(new Event("timeupdate"));
    }
  });
  return log;
}

describe("seekReadingTarget 规范序", () => {
  it("清手动滚动暂停先于 currentTime 赋值（timeupdate 落在干净状态上）", () => {
    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    // 先制造一次未过期的手动滚动暂停（自动滚动开启时生效）
    shell.noteManualReaderInteraction(5000);
    expect(scrollState.isManualScrollPaused()).toBe(true);

    const scrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const log = recordCurrentTimeAssignments(video);
    shell.seekReadingTarget(12, { resumePlayback: false });

    // currentTime 被赋值的瞬间，手动暂停必须已经清掉（规范序第 1 步先于第 3 步）
    expect(log).toEqual([{ pausedAtAssign: false, next: 12 }]);
    // 跟随状态按规范序第 2 步落在 auto；timeupdate 驱动的同步以 auto 行为滚动
    expect(readingView.getAttribute("data-boc-reader-follow")).toBe("auto");
    expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
    expect(state.reader.readingActiveSubtitleIndex).toBe(1);
  });

  it("未清暂停时同型同步会吞掉跟随滚动（回归对照：bug 形态可观察）", () => {
    // 对照组：手动暂停处于生效状态时，同步走 manual 分支——follow 保持 manual，
    // 证明上面用例断言的 pausedAtAssign=false 确实是行为分岔点。
    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    shell.noteManualReaderInteraction(5000);
    expect(scrollState.isManualScrollPaused()).toBe(true);

    video.currentTime = 12; // 直接赋值：此刻暂停未清
    video.dispatchEvent(new Event("timeupdate"));

    expect(readingView.getAttribute("data-boc-reader-follow")).toBe("manual");
    expect(state.reader.readingActiveSubtitleIndex).toBe(1); // 高亮照切
  });
});

describe("seekReadingTarget 播放策略（resumePlayback 参数化）", () => {
  it("resumePlayback:true：暂停中自动播放（阅读视图点击语义）", () => {
    video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLVideoElement["play"];
    expect(video.paused).toBe(true);

    const seekedTo = shell.seekReadingTarget(30, { resumePlayback: true });

    expect(seekedTo).toBe(30);
    expect(video.currentTime).toBe(30);
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it("resumePlayback:false：暂停中不自动播放（侧栏 seek 语义）", () => {
    video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLVideoElement["play"];

    shell.seekReadingTarget(30, { resumePlayback: false });

    expect(video.currentTime).toBe(30);
    expect(video.play).not.toHaveBeenCalled();
  });

  it("resumePlayback:true：正在播放时不重复 play", () => {
    video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLVideoElement["play"];
    Object.defineProperty(video, "paused", { configurable: true, value: false });

    shell.seekReadingTarget(30, { resumePlayback: true });

    expect(video.play).not.toHaveBeenCalled();
  });

  it("jumpReadingTarget 委托深入口：等价 resumePlayback:true", () => {
    video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLVideoElement["play"];

    shell.jumpReadingTarget(45);

    expect(video.currentTime).toBe(45);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(state.reader.readingActiveSubtitleIndex).toBe(2);
  });

  it("负数与非有限时间截断为 0，返回截断值", () => {
    expect(shell.seekReadingTarget(-5, { resumePlayback: false })).toBe(0);
    expect(video.currentTime).toBe(0);
    expect(shell.seekReadingTarget(Number.NaN, { resumePlayback: false })).toBe(0);
  });

  it("无可用视频：返回 null 并写状态栏，不抛错", () => {
    document.getElementById("playerWrap")?.remove();

    const seekedTo = shell.seekReadingTarget(12, { resumePlayback: false });

    expect(seekedTo).toBeNull();
    const status = document.getElementById(ids.readingStatus) as HTMLElement;
    expect(status.textContent).toBe("当前页面没有找到可联动的视频播放器。");
  });
});
