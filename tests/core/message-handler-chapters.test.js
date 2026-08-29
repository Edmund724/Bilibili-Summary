// core/message-handler.js 的 sidepanel-get-context chapters 断供修复回归测试：
// content 快照 payload 此前不含 chapters——state.clip.chapters 明明有值（fetcher
// 从字幕 bundle 写入），侧边栏 contextData 却永远拿不到，offscreen 的章节对齐
// 切段（budgeter）与追问章节名检索（raw-retrieval）双双失明。修复后 payload
// 携带 chapters，此测试锁定透传行为。
// message-handler 的重依赖（reader/ui/fetcher 等内容脚本模块）全部 mock，
// state 走真实模块；单纪元：不使用 vi.resetModules，vi.mock 工厂闭包全程有效。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../extension/core/runtime.js", () => ({
  replaceReaderModeUrl: vi.fn(),
  startUrlWatcher: vi.fn(),
  BOC_URL_CHANGE_EVENT: "boc:urlchange"
}));
vi.mock("../../extension/bilibili/video-probe.js", () => ({
  getRuntimeVideoElement: vi.fn(() => null)
}));
vi.mock("../../extension/subtitle/ui.js", () => ({
  getPopupPayload: vi.fn(() => ({}))
}));
vi.mock("../../extension/subtitle/fetcher.js", () => ({
  refreshClip: vi.fn(async () => {}),
  loadSubtitle: vi.fn(async () => {}),
  resetClipState: vi.fn()
}));
vi.mock("../../extension/ui/ui-renderer.js", () => ({
  setStatus: vi.fn(),
  renderSubtitleSelect: vi.fn(),
  ensureUiReady: vi.fn()
}));
vi.mock("../../extension/ai/player-ai.js", () => ({
  removePlayerAiQuickActionButton: vi.fn(),
  schedulePlayerAiQuickActionSync: vi.fn()
}));
vi.mock("../../extension/reader/index.js", () => ({
  updateReaderFollowState: vi.fn(),
  syncReadingViewPlayback: vi.fn(),
  enterReaderMode: vi.fn(async () => {}),
  closeReadingView: vi.fn(),
  logWarn: vi.fn(),
  isReaderViewOpen: vi.fn(() => false),
  resetManualScrollPause: vi.fn(),
  renderReadingStatus: vi.fn(),
  waitForVideoMetadata: vi.fn(async () => {}),
  enforceNormalPageStateIfNeeded: vi.fn()
}));
vi.mock("../../extension/bilibili/gateway.js", () => ({
  getCurrentAid: vi.fn(() => ""),
  fetchHotComments: vi.fn(async () => [])
}));

import { bindRuntimeEvents } from "../../extension/core/message-handler.js";
import { state } from "../../extension/core/state.js";

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

function requestContext() {
  const sendResponse = vi.fn();
  const keepOpen = messageListener({ type: "sidepanel-get-context" }, {}, sendResponse);
  expect(sendResponse).toHaveBeenCalledTimes(1);
  const response = sendResponse.mock.calls[0][0];
  expect(response.ok).toBe(true);
  return { payload: response.payload, keepOpen };
}

describe("sidepanel-get-context payload 的 chapters 透传", () => {
  beforeEach(() => {
    state.clip.setSubtitleBody([{ from: 0, to: 5, content: "第一句" }]);
    state.clip.setSubtitles([]);
    state.clip.setBvid("BV1chapters");
    state.clip.setTitle("测试视频");
  });

  it("payload 携带 state.clip.chapters（fetcher 写入的章节不再断供）", () => {
    const chapters = [
      { title: "开场", from: 0, to: 60, source: "player-view-points" },
      { title: "正文", from: 60, to: 600, source: "player-view-points" }
    ];
    state.clip.setChapters(chapters);

    const { payload } = requestContext();
    expect(payload.chapters).toEqual(chapters);
    // 快照其余字段不回归
    expect(payload.bvid).toBe("BV1chapters");
    expect(payload.title).toBe("测试视频");
    expect(payload.subtitleBody).toEqual([{ from: 0, to: 5, content: "第一句" }]);
  });

  it("无章节视频 → chapters 为空数组（shape 稳定，下游 Array.isArray 直接过）", () => {
    state.clip.setChapters([]);

    const { payload } = requestContext();
    expect(payload.chapters).toEqual([]);
  });
});
