// reader 生命周期测试：进入/退出阅读模式。
// 通过 stub DOM（boc 阅读视图骨架）与 stub 视频元素驱动
// shell.js 的 enterReaderMode / closeReadingView / hydrate / apply 等真实路径。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mockPlayerRects, mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";

let state;
let shell;
let pageFrame;
let impl;

async function loadReaderModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state;
  shell = await import("../../extension/reader/index.js");
  pageFrame = shell;
  impl = shell;
  return { state, shell, pageFrame };
}

// 通过视频元素上挂载的同步 handler 判断播放同步是否在运行
// （内部同步定时器/绑定标志已收成 reader-impl 模块级闭包，不再暴露在 state.reader）
function syncRunning() {
  const video = document.querySelector("video");
  return Boolean(video?.__bocReadingSyncHandler);
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadReaderModules();
  mountReaderSkeleton(shell.ids);
  mountPlayerChain();
  mockPlayerRects();
});

afterEach(() => {
  // 清理 enterReaderMode 注册的播放器观察者/定时器，避免 jsdom MutationObserver 在清理后回调
  try {
    impl.stopReadingViewSync();
    impl.stopReaderPlayerObserver();
  } catch {
    // ignore
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("reader 生命周期", () => {
  it("进入阅读模式：打开视图、写 data 属性、渲染章节/字幕列表", async () => {
    state.clip.title = "测试视频";
    state.clip.author = "up主";
    state.clip.chapters = [
      { title: "开场", from: 0 },
      { title: "正片", from: 30 }
    ];
    state.clip.subtitleBody = [
      { from: 0, to: 10, content: "大家好" },
      { from: 10, to: 30, content: "今天讲测试" }
    ];

    await shell.enterReaderMode();

    const readingView = document.getElementById(shell.ids.readingView);
    expect(state.reader.readingViewOpen).toBe(true);
    expect(readingView.classList.contains("open")).toBe(true);
    expect(readingView.classList.contains("reader-page")).toBe(true);
    expect(readingView.getAttribute("aria-hidden")).toBe("false");
    expect(document.body.getAttribute("data-boc-reading-active")).toBe("1");

    // data-boc-reader-mode 由 content.js 的 init 在进入前设置，enterReaderMode 不负责
    document.documentElement.setAttribute("data-boc-reader-mode", "1");
    document.body.setAttribute("data-boc-reader-mode", "1");
    expect(document.documentElement.getAttribute("data-boc-reader-mode")).toBe("1");
    expect(document.body.getAttribute("data-boc-reader-mode")).toBe("1");

    // 章节与字幕列表渲染
    const chapterButtons = readingView.querySelectorAll(".boc-reading-chapter");
    expect(chapterButtons.length).toBe(2);
    expect(chapterButtons[0].dataset.seconds).toBe("0");
    expect(chapterButtons[1].dataset.seconds).toBe("30");
    expect(chapterButtons[0].textContent).toContain("开场");

    const transcriptItems = readingView.querySelectorAll(".boc-reading-item");
    expect(transcriptItems.length).toBe(2);
    expect(transcriptItems[1].dataset.seconds).toBe("10");
    expect(transcriptItems[1].textContent).toContain("今天讲测试");

    // 视图进入 ready 状态（stub 播放器有可见尺寸）
    expect(state.reader.readingViewReady).toBe(true);
    expect(readingView.getAttribute("data-boc-reader-ready")).toBe("1");
    expect(readingView.getAttribute("aria-busy")).toBe("false");

    // 播放器挂载绑定 stub 视频
    const video = document.querySelector("video");
    expect(video.__bocReadingSyncHandler).toBeTypeOf("function");
    expect(syncRunning()).toBe(true);

    // 关闭视图以清掉 interval/重试/controls-recovery 等定时器，避免污染后续测试
    shell.closeReadingView();
    // 让 alignReaderViewportToPlayer 的 120ms 定时器在 DOM 尚存时跑完
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it("退出阅读模式：清空 data 属性、关闭视图、停止同步", async () => {
    state.clip.chapters = [
      { title: "开场", from: 0 },
      { title: "正片", from: 30 }
    ];
    state.clip.subtitleBody = [
      { from: 0, to: 10, content: "大家好" },
      { from: 10, to: 30, content: "今天讲测试" }
    ];

    await shell.enterReaderMode();

    // 播放器挂载成功后会绑定视频同步 handler 与同步定时器
    const video = document.querySelector("video");
    expect(video.__bocReadingSyncHandler).toBeTypeOf("function");
    expect(syncRunning()).toBe(true);

    shell.closeReadingView();

    const readingView = document.getElementById(shell.ids.readingView);
    expect(state.reader.readingViewOpen).toBe(false);
    expect(readingView.classList.contains("open")).toBe(false);
    expect(readingView.getAttribute("aria-hidden")).toBe("true");
    expect(readingView.getAttribute("data-boc-reader-ready")).toBe("0");
    expect(document.body.getAttribute("data-boc-reading-active")).toBe(null);
    expect(document.documentElement.getAttribute("data-boc-reader-mode")).toBe(null);
    expect(document.documentElement.getAttribute("data-boc-reader-theme")).toBe(null);
    expect(document.body.getAttribute("data-boc-reader-theme")).toBe(null);

    // 同步已停止：interval 清除、视频事件监听移除
    expect(syncRunning()).toBe(false);
    expect(video.__bocReadingSyncHandler).toBeUndefined();

    // 让 alignReaderViewportToPlayer 的 120ms 定时器等在 DOM 尚存时跑完
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it("等待视频元数据：duration 就绪立即 resolve", async () => {
    await expect(shell.waitForVideoMetadata(50)).resolves.toBeUndefined();
  });
});
