// 回归测试（M23 / finding resetClipState×refreshClip runId 协调）：
// handleUrlChange 在 clip 签名变化时必须同步递增 fetchRunId——让旧视频的在飞
// refreshClip 在下一个守卫点（ensureRunActive / 字幕接受事务的 runId 自检）让位。
// 递增必须同步先行于本编排派生的 resetClipState 与新视频 refreshClip（二者都在
// 动态装载链之后才执行）：若把递增放进 resetClipState，装载次序竞态可能让新视频
// 的 refreshClip 先起跑、再被迟到的递增误杀（自动刷新静默失效）。
//
// 单独成文件：bindUrlChangeHandler 会全局补丁 history 并注册 window 监听器，
// vitest 按文件隔离环境，避免污染其它 reader 测试（同 url-reset.bug.test.ts）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import type { TestState } from "./reader-test-env.js";

const OTHER_VIDEO_URL = "https://www.bilibili.com/video/BV1test999999/";
// 同视频同分 P、仅多余参数变化：签名不变，不应递增代次
const SAME_VIDEO_NOISY_URL = "https://www.bilibili.com/video/BV1test000000/?t=42";

let state: TestState;
let clipState: typeof import("../../extension/core/state.js").clipState;
let messageHandler: typeof import("../../extension/entry/message-handler.js");
let videoIdShared: typeof import("../../extension/bilibili/video-id-shared.js");
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");

async function loadModules() {
  setLocationUrl(NORMAL_PAGE_URL);
  const stateModule = await import("../../extension/core/state.js") as typeof import("../../extension/core/state.js");
  state = stateModule.state as TestState;
  clipState = stateModule.clipState;
  messageHandler = await import("../../extension/entry/message-handler.js");
  videoIdShared = await import("../../extension/bilibili/video-id-shared.js");
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
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

describe("URL 变化的 fetchRunId 同步递增（M23 runId 协调）", () => {
  it("签名变化（换视频）→ handleUrlChange 同步段立即递增，早于异步 reset/刷新链", () => {
    clipState.setFetchRunId(5);
    messageHandler.bindUrlChangeHandler();

    // 同步断言：递增发生在监听器的同步段，先于 resetClipState / 新视频
    // refreshClip 各自的动态装载链（二者都是异步 IIFE）
    history.replaceState(history.state, "", OTHER_VIDEO_URL);
    expect(clipState.fetchRunId).toBe(6);
  });

  it("签名未变（同视频同分 P 的 URL 噪声）不递增", () => {
    clipState.setFetchRunId(5);
    clipState.setCurrentClipSignature(videoIdShared.computeCurrentClipSignature());
    messageHandler.bindUrlChangeHandler();

    history.replaceState(history.state, "", SAME_VIDEO_NOISY_URL);
    expect(clipState.fetchRunId).toBe(5);
  });

  it("递增后 reset 编排照常收尾：seeded 的旧视频数据仍被清空（递增不跳过 reset）", async () => {
    state.clip.title = "旧视频标题";
    clipState.setFetchRunId(5);
    messageHandler.bindUrlChangeHandler();

    history.replaceState(history.state, "", OTHER_VIDEO_URL);
    expect(clipState.fetchRunId).toBe(6);

    // 候选02 分层惰性：resetClipState 经 ensureSummarizeChain 装载后执行（异步），
    // 断言递增没有影响 reset 链路本身
    await vi.waitFor(() => {
      expect(state.clip.title).toBe("");
    });
  });
});
