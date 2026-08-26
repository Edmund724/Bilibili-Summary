// 反馈回路（5be8f39 嫌疑路径）：replaceState 补丁派发的 boc:urlchange
// 是否会在进入阅读模式时清空已抓取的章节。
//
// startUrlWatcher 给 history.replaceState 打补丁后会同步派发 boc:urlchange，
// handleUrlChange 在 clip 签名不匹配时 resetClipState()（chapters 清空）。
// 5be8f39 的修复是"先更新签名再调 replaceState"。这里同时验证：
//   F1. 修复后的 replaceReaderModeUrl：已抓取章节在切换阅读模式 URL 后保留
//   F2. 旧调用模式（replaceState 前不更新签名）：同样的 URL 切换会清空章节
//       —— 证明本回路确实 red-capable（能在这个 bug 上变红）
//
// 单独成文件：startUrlWatcher 会全局补丁 history.replaceState 并注册 window
// 监听器，vitest 按文件隔离环境，避免污染其它 reader 测试。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";

// 签名不匹配 + 阅读模式 URL 时 handleUrlChange 会异步启动 enterReaderMode，
// 其挂载重试在测试拆除 DOM 后仍在跑并产生未处理拒绝。本文件只关心
// replaceState→urlchange→resetClipState 链路，因此把 enterReaderMode 换成空实现。
vi.mock("../../extension/reader/index.js", async (importActual) => {
  const actual = await importActual();
  return { ...actual, enterReaderMode: vi.fn(async () => {}) };
});

const OTHER_VIDEO_URL = "https://www.bilibili.com/video/BV1test999999/";
const OTHER_VIDEO_READER_URL = "https://www.bilibili.com/video/BV1test999999/?boc_reader=1";

let state;
let clipState;
let runtime;
let videoIdShared;
let uiRenderer;

async function loadModules() {
  setLocationUrl(NORMAL_PAGE_URL);
  const stateModule = await import("../../extension/core/state.js");
  state = stateModule.state;
  clipState = stateModule.clipState;
  runtime = await import("../../extension/core/runtime.js");
  videoIdShared = await import("../../extension/bilibili/video-id-shared.js");
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
}

function seedFetchedClip() {
  state.clip.title = "测试视频";
  state.clip.chapters = [
    { title: "开场", from: 0 },
    { title: "正片", from: 30 }
  ];
  // 模拟 refreshClip 完成后的签名（fetcher.js:221）
  clipState.setCurrentClipSignature(videoIdShared.computeCurrentClipSignature());
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadModules();
  uiRenderer.ensureUiReady({ forceRecreate: true });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("replaceState 补丁与章节清空（5be8f39 嫌疑路径）", () => {
  it("F1. 修复后：replaceReaderModeUrl 切换到另一视频的阅读模式 URL，已抓取章节保留", () => {
    seedFetchedClip();
    runtime.startUrlWatcher();

    runtime.replaceReaderModeUrl(OTHER_VIDEO_READER_URL);

    expect(state.clip.chapters.length).toBe(2);
    expect(state.clip.title).toBe("测试视频");
  });

  it("F2. 旧调用模式（red-capable 对照）：replaceState 前不更新签名，章节被清空", () => {
    seedFetchedClip();
    runtime.startUrlWatcher();

    // 5be8f39 之前的 replaceReaderModeUrl 等价于直接 replaceState
    history.replaceState(history.state, "", OTHER_VIDEO_READER_URL);

    expect(state.clip.chapters.length).toBe(0);
  });
});
