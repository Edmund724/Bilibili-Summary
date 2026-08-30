// 候选06：sidepanel-seek-video-time 两形态回归测试。
//
// 锁定 seek 深入口改造后两个调用点的最终形态：
// - reader 开着 ⇒ 经 ensureReaderDomain 单入口 seekReadingTarget(seconds,
//   { resumePlayback: false })，处理器不再手抄「currentTime → 清暂停 → 跟随」
//   序列（旧序是真 bug 源：currentTime 触发的 timeupdate 跑在暂停未清状态上）；
// - reader 未开 ⇒ 保持旧行为：只 seek 视频、正在播放才续播，不触碰 reader 域；
// - 无视频 ⇒ ok:false 错误口径；reader 域内绑定失败（返回 null）⇒ 同型降级。
//
// 写法与 message-handler-chapters.test.js 同款：重依赖全部 vi.mock，state 走
// 真实模块，单纪元（不用 vi.resetModules），mock 句柄经被 mock 模块的 import 取用。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../extension/core/lazy-reader.js", () => ({
  ensureReaderDomain: vi.fn(),
  isReaderDomainLoaded: vi.fn(() => false)
}));
vi.mock("../../extension/bilibili/video-probe.js", () => ({
  getRuntimeVideoElement: vi.fn(),
  findReaderPlayerHost: vi.fn(() => null)
}));
vi.mock("../../extension/reader/view-state.js", () => ({
  isReaderViewOpen: vi.fn(() => false)
}));
// message-handler 的其余静态依赖按 chapters/signature 测试同款 mock（本文件不触达其行为）。
vi.mock("../../extension/core/url-watcher.js", () => ({
  startUrlWatcher: vi.fn(),
  BOC_URL_CHANGE_EVENT: "boc:urlchange"
}));
vi.mock("../../extension/bilibili/reader-url.js", () => ({
  replaceReaderModeUrl: vi.fn()
}));
vi.mock("../../extension/subtitle/lazy.js", () => ({
  ensureSummarizeChain: vi.fn()
}));
vi.mock("../../extension/ui/ui-renderer.js", () => ({
  setStatus: vi.fn(),
  ensureUiReady: vi.fn()
}));
vi.mock("../../extension/core/lazy-player-ai.js", () => ({
  loadPlayerAi: vi.fn(),
  isPlayerAiLoaded: vi.fn(() => false)
}));

import { bindRuntimeEvents } from "../../extension/core/message-handler.js";
import { ensureReaderDomain } from "../../extension/core/lazy-reader.js";
import { getRuntimeVideoElement } from "../../extension/bilibili/video-probe.js";
import { isReaderViewOpen } from "../../extension/reader/view-state.js";

const onMessageListeners = [];
vi.stubGlobal("chrome", {
  runtime: {
    onMessage: {
      addListener: (listener) => onMessageListeners.push(listener)
    }
  }
});

bindRuntimeEvents();
const messageListener = onMessageListeners[0];

function makeVideoStub({ paused = true } = {}) {
  return {
    currentTime: 0,
    paused,
    play: vi.fn(() => Promise.resolve())
  };
}

async function requestSeek(seconds) {
  const sendResponse = vi.fn();
  const keepOpen = messageListener({ type: "sidepanel-seek-video-time", seconds }, {}, sendResponse);
  await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
  return { response: sendResponse.mock.calls[0][0], keepOpen };
}

beforeEach(() => {
  vi.clearAllMocks();
  isReaderViewOpen.mockReturnValue(false);
});

describe("sidepanel-seek-video-time：seek 深入口两形态", () => {
  it("reader 开着：经 ensureReaderDomain 单入口 seekReadingTarget（resumePlayback:false），处理器不直接碰视频", async () => {
    const video = makeVideoStub();
    const seekReadingTarget = vi.fn(() => 42);
    ensureReaderDomain.mockResolvedValue({ seekReadingTarget });
    getRuntimeVideoElement.mockReturnValue(video);
    isReaderViewOpen.mockReturnValue(true);

    const { response, keepOpen } = await requestSeek("42");

    expect(seekReadingTarget).toHaveBeenCalledTimes(1);
    expect(seekReadingTarget).toHaveBeenCalledWith("42", { resumePlayback: false });
    // 手抄序列已删：currentTime/播放策略全部归 reader 域规范序
    expect(video.currentTime).toBe(0);
    expect(video.play).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: true, currentTime: 42 });
    expect(keepOpen).toBe(true);
  });

  it("reader 开着但域内未绑定到视频（seekReadingTarget 返回 null）：同型降级 ok:false", async () => {
    const video = makeVideoStub();
    ensureReaderDomain.mockResolvedValue({ seekReadingTarget: vi.fn(() => null) });
    getRuntimeVideoElement.mockReturnValue(video);
    isReaderViewOpen.mockReturnValue(true);

    const { response } = await requestSeek(30);

    expect(response.ok).toBe(false);
    expect(response.error).toContain("没有找到可联动的视频播放器");
  });

  it("reader 未开且正在播放：只 seek 视频并续播（旧行为保持），不装载 reader 域", async () => {
    const video = makeVideoStub({ paused: false });
    getRuntimeVideoElement.mockReturnValue(video);
    isReaderViewOpen.mockReturnValue(false);

    const { response } = await requestSeek(35.5);

    expect(video.currentTime).toBe(35.5);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(ensureReaderDomain).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: true, currentTime: 35.5 });
  });

  it("reader 未开且暂停中：只 seek 不续播（旧行为保持）", async () => {
    const video = makeVideoStub({ paused: true });
    getRuntimeVideoElement.mockReturnValue(video);
    isReaderViewOpen.mockReturnValue(false);

    const { response } = await requestSeek(10);

    expect(video.currentTime).toBe(10);
    expect(video.play).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: true, currentTime: 10 });
  });

  it("reader 未开且时间非法（NaN/Infinity）：截断为 0（旧行为保持）", async () => {
    const video = makeVideoStub({ paused: true });
    getRuntimeVideoElement.mockReturnValue(video);
    isReaderViewOpen.mockReturnValue(false);

    const { response } = await requestSeek(Number.POSITIVE_INFINITY);

    expect(video.currentTime).toBe(0);
    expect(response).toEqual({ ok: true, currentTime: 0 });
  });

  it("无视频：ok:false 错误口径", async () => {
    getRuntimeVideoElement.mockReturnValue(null);
    isReaderViewOpen.mockReturnValue(false);

    const { response } = await requestSeek(12);

    expect(response.ok).toBe(false);
    expect(response.error).toContain("没有找到可联动的视频播放器");
  });
});
