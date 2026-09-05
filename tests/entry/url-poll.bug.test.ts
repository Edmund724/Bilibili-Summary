// 稍后再看列表内 SPA 换片的 URL 检测回归（8232aa3 事件化后的漏检）。
//
// 内容脚本跑在隔离世界：history.pushState/replaceState 补丁只能截获本世界
// 的调用（扩展自己的 replaceReaderModeUrl），B 站主世界的 SPA 导航（稍后再看
// 列表内换视频）走的是主世界自己的 history，对补丁不可见，且 pushState 导航
// 不触发 popstate。url-watcher 的 href 轮询兜底必须能发现这类「绕过补丁」的
// 导航，并驱动 handleUrlChange 重置 clip（否则再点 Digest 展示上一个视频的
// 字幕/视频信息）。
//
// 测试里用 History.prototype.replaceState.call 绕过实例上的补丁，模拟主世界
// 导航。单独成文件：bindUrlChangeHandler 全局补丁 history 并注册 window
// 监听器，vitest 按文件隔离环境，避免污染其它测试。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, setLocationUrl } from "../setup.js";
import type { TestState } from "../reader/reader-test-env.js";

const WATCHLATER_URL_A =
  "https://www.bilibili.com/list/watchlater?oid=111&bvid=BV1aaaTestA";
const WATCHLATER_URL_B =
  "https://www.bilibili.com/list/watchlater?oid=222&bvid=BV1bbbTestB";

let state: TestState;
let clipState: typeof import("../../extension/core/state.js").clipState;
let messageHandler: typeof import("../../extension/entry/message-handler.js");
let videoIdShared: typeof import("../../extension/bilibili/video-id-shared.js");
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");

async function loadModules() {
  setLocationUrl(WATCHLATER_URL_A);
  const stateModule = await import("../../extension/core/state.js");
  state = stateModule.state as TestState;
  clipState = stateModule.clipState;
  messageHandler = await import("../../extension/entry/message-handler.js");
  videoIdShared = await import("../../extension/bilibili/video-id-shared.js");
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
}

// 模拟视频 A 已完成一次 refreshClip：字幕/章节/签名齐备。
function seedFetchedClip() {
  clipState.setBvid("BV1aaaTestA");
  state.clip.title = "视频 A";
  state.clip.chapters = [{ title: "正片", from: 0 }];
  state.clip.subtitleBody = [{ from: 0, to: 10, content: "视频 A 字幕" }];
  clipState.setCurrentClipSignature(videoIdShared.computeCurrentClipSignature());
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadModules();
  uiRenderer.ensureUiReady({ forceRecreate: true });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("稍后再看列表内 SPA 换片的 URL 检测（轮询兜底）", () => {
  it("主世界导航绕过 history 补丁：轮询发现一个节拍内的 URL 变化并重置 clip", async () => {
    seedFetchedClip();
    vi.useFakeTimers();
    messageHandler.bindUrlChangeHandler();

    // 模拟 B 站主世界 SPA 换片：绕过实例上的补丁（原型方法直调），
    // 不派发 boc:urlchange、不触发 popstate。
    History.prototype.replaceState.call(history, {}, "", WATCHLATER_URL_B);

    // 补丁未截获：同步路径无任何反应，clip 仍是视频 A。
    expect(state.clip.chapters.length).toBe(1);
    expect(state.clip.bvid).toBe("BV1aaaTestA");

    // 轮询兜底在一个节拍内发现变化 → handleUrlChange → resetClipState
    //（经 ensureSummarizeChain 装载后异步执行，见 url-reset.bug.test.ts F2）。
    await vi.advanceTimersByTimeAsync(1100);
    await vi.waitFor(() => {
      expect(state.clip.chapters.length).toBe(0);
      expect(state.clip.subtitleBody.length).toBe(0);
    });
    // 重置后签名对齐当前地址（视频 B），后续进入阅读模式按 B 重抓。
    expect(state.clip.currentClipSignature).toBe(videoIdShared.computeCurrentClipSignature());
  });
});
