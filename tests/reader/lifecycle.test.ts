// reader 生命周期测试：进入/退出阅读模式。
// 通过 stub DOM（boc 阅读视图骨架）与 stub 视频元素驱动
// shell.js 的 enterReaderMode / closeReadingView / hydrate / apply 等真实路径。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mockPlayerRects, mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let shell: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let impl: typeof shell;
let digestHost: typeof import("../../extension/reader/digest-host.js");

// B 形态（阶段 2）：digest-host 以 spy 包装（实现保留），验证进入即开始贴右栏
// 定位、关闭即拆除。vi.mock 会被提升到模块求值前，须放在顶层。
vi.mock("../../extension/reader/digest-host.js", async (importActual) => {
  const actual = await importActual() as typeof import("../../extension/reader/digest-host.js");
  return {
    openDigestHost: vi.fn(actual.openDigestHost),
    closeDigestHost: vi.fn(actual.closeDigestHost),
    refreshDigestHostRect: vi.fn(actual.refreshDigestHostRect)
  };
});

async function loadReaderModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  shell = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
  digestHost = await import("../../extension/reader/digest-host.js");
  impl = shell;
  return { state, shell, ids };
}

// 通过视频元素上挂载的同步 AbortController 判断播放同步是否在运行
// （内部同步定时器/绑定标志已收成 reader-impl 模块级闭包，不再暴露在 state.reader）
function syncRunning() {
  const video = document.querySelector("video");
  return Boolean((video as HTMLVideoElement | null)?.__bocReadingSyncController);
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadReaderModules();
  mountReaderSkeleton(ids);
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
  it("进入阅读模式：打开视图、写 data 属性、渲染字幕列表并打开 digest-host", async () => {
    // B 形态（阶段 2）：播放器挂载/整页接管链退役，进入不再绑定视频同步——
    // 绑定由 sync tick 的 bindReadingViewVideo 兜底。digest-host 以 spy 验证
    // 进入即开始贴右栏定位、关闭即拆除。
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

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
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

    // B 形态不再渲染 rail 章节列表（章节由概览 tab 提供）；字幕列表照常渲染
    const chapterButtons = readingView.querySelectorAll(".boc-reading-chapter") as NodeListOf<HTMLElement>;
    expect(chapterButtons.length).toBe(0);

    const subtitleItems = readingView.querySelectorAll(".boc-reading-item") as NodeListOf<HTMLElement>;
    expect(subtitleItems.length).toBe(2);
    expect(subtitleItems[1].dataset.seconds).toBe("10");
    expect(subtitleItems[1].textContent).toContain("今天讲测试");

    // B 形态不驱动播放器挂载：视图打开即 ready，无挂载等待文案
    expect(state.reader.readingViewReady).toBe(true);
    expect(readingView.getAttribute("data-boc-reader-ready")).toBe("1");
    expect(readingView.getAttribute("aria-busy")).toBe("false");

    // 进入即开始右栏定位（digest-host open），且不等播放器
    expect(digestHost.openDigestHost).toHaveBeenCalledTimes(1);

    // 关闭视图以清掉同步定时器等，避免污染后续测试
    shell.closeReadingView();
    expect(digestHost.closeDigestHost).toHaveBeenCalledTimes(1);
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

    // B 形态：进入不再绑定视频同步（视图打开即就绪，不等播放器）
    const video = document.querySelector("video") as HTMLVideoElement;
    expect(syncRunning()).toBe(false);

    shell.closeReadingView();

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    expect(state.reader.readingViewOpen).toBe(false);
    expect(readingView.classList.contains("open")).toBe(false);
    expect(readingView.getAttribute("aria-hidden")).toBe("true");
    expect(readingView.getAttribute("data-boc-reader-ready")).toBe("0");
    expect(document.body.getAttribute("data-boc-reading-active")).toBe(null);
    expect(document.documentElement.getAttribute("data-boc-reader-mode")).toBe(null);
    expect(document.documentElement.getAttribute("data-boc-reader-theme")).toBe(null);
    expect(document.body.getAttribute("data-boc-reader-theme")).toBe(null);

    // 同步保持未运行、视频事件监听不存在
    expect(syncRunning()).toBe(false);
    expect(video.__bocReadingSyncController).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it("等待视频元数据：duration 就绪立即 resolve", async () => {
    await expect(shell.waitForVideoMetadata(50)).resolves.toBeUndefined();
  });
});
