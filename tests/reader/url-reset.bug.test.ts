// 反馈回路（5be8f39 嫌疑路径）：replaceState 补丁派发的 boc:urlchange
// 是否会在进入阅读模式时清空已抓取的章节。
//
// startUrlWatcher（history 补丁 + boc:urlchange 广播）派发的事件由组合根
// message-handler 的 handleUrlChange 消费：
// handleUrlChange 在 clip 签名不匹配时 resetClipState()（chapters 清空）。
// 5be8f39 的修复是"先更新签名再调 replaceState"。这里同时验证：
//   F1. 修复后的 replaceReaderModeUrl：已抓取章节在切换阅读模式 URL 后保留
//   F2. 旧调用模式（replaceState 前不更新签名）：同样的 URL 切换会清空章节
//       —— 证明本回路确实 red-capable（能在这个 bug 上变红）
//
// 单独成文件：bindUrlChangeHandler 会全局补丁 history.replaceState 并注册
// window 监听器，vitest 按文件隔离环境，避免污染其它 reader 测试。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import type { TestState } from "./reader-test-env.js";

// 签名不匹配 + 阅读模式 URL 时 handleUrlChange 会异步启动 enterReaderMode，
// 其挂载重试在测试拆除 DOM 后仍在跑并产生未处理拒绝。本文件只关心
// replaceState→urlchange→resetClipState 链路，因此把 enterReaderMode 换成空实现。
vi.mock("../../extension/reader/index.js", async (importActual) => {
  const actual = await importActual() as typeof import("../../extension/reader/index.js");
  return { ...actual, enterReaderMode: vi.fn(async () => {}) };
});

const OTHER_VIDEO_URL = "https://www.bilibili.com/video/BV1test999999/";
const OTHER_VIDEO_READER_URL = "https://www.bilibili.com/video/BV1test999999/?boc_reader=1";

let state: TestState;
let clipState: typeof import("../../extension/core/state.js").clipState;
let readerUrl: typeof import("../../extension/bilibili/reader-url.js");
let messageHandler: typeof import("../../extension/core/message-handler.js");
let videoIdShared: typeof import("../../extension/bilibili/video-id-shared.js");
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");

async function loadModules() {
  setLocationUrl(NORMAL_PAGE_URL);
  const stateModule = await import("../../extension/core/state.js") as typeof import("../../extension/core/state.js");
  state = stateModule.state as TestState;
  clipState = stateModule.clipState;
  readerUrl = await import("../../extension/bilibili/reader-url.js");
  // URL 变化编排（handleUrlChange 监听）在组合根 message-handler；
  // url-watcher.startUrlWatcher 只负责 history 补丁与 boc:urlchange 广播。
  messageHandler = await import("../../extension/core/message-handler.js");
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
    messageHandler.bindUrlChangeHandler();

    readerUrl.replaceReaderModeUrl(OTHER_VIDEO_READER_URL);

    expect(state.clip.chapters.length).toBe(2);
    expect(state.clip.title).toBe("测试视频");
  });

  it("F2. 旧调用模式（red-capable 对照）：replaceState 前不更新签名，章节被清空", async () => {
    seedFetchedClip();
    // S3 分层：进入阅读模式路径挂阅读表（handleUrlChange 内 ensureReaderStyles），
    // 挂载用的 getURL 由 tests/setup.js 的通用 chrome stub 提供
    messageHandler.bindUrlChangeHandler();

    // 5be8f39 之前的 replaceReaderModeUrl 等价于直接 replaceState
    history.replaceState(history.state, "", OTHER_VIDEO_READER_URL);

    // 候选02 分层惰性：handleUrlChange 的 resetClipState 改经 ensureSummarizeChain
    // 装载总结链后执行（原本地动态 import，毫秒级），清空动作由同步变为装载后
    // 微任务。断言语义不变（章节最终被清空），仅补装载等待。
    await vi.waitFor(() => {
      expect(state.clip.chapters.length).toBe(0);
    });
  });
});
