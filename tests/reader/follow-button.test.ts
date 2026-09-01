// PR3 Follow playback 悬浮按钮回归测试。
//
// 显隐基座：data-boc-reader-follow 三态（off/auto/manual，sync.updateReaderFollowState
// 维护）+ reader.css 的 CSS 显隐规则——auto 隐藏、manual/off 显示、转写中隐藏。
// 按钮行为：resumeReaderFollowPlayback 把跟随拉回 auto 并跳回当前句（不改播放
// 进度——语义是「回去继续跟随」，不是 seek；对齐 youtube-digest sidepanel.js
// 的 Follow playback 按钮）。
//
// jsdom 无法测 CSS display，显隐规则做两层验证：
//   1. 行为层：三态属性按交互正确翻转（显隐的唯一依据）；
//   2. 契约层：reader.css 必须包含三态显隐选择器（CSS/JS 契约，参照
//      chapter-visibility.bug.test 的 D 用例手法）。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mockPlayerRects, mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let shell: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let readerState: typeof import("../../extension/reader/state.js");
let video: HTMLVideoElement;

async function loadReaderModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  readerState = await import("../../extension/reader/state.js");
  shell = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
}

function readingView(): HTMLElement {
  return document.getElementById(ids.readingView) as HTMLElement;
}

function followValue(): string | null {
  return readingView().getAttribute("data-boc-reader-follow");
}

function seedBody() {
  state.clip.subtitleBody = [
    { from: 0, to: 10, content: "第一句" },
    { from: 10, to: 30, content: "第二句" },
    { from: 30, to: 60, content: "第三句" }
  ];
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadReaderModules();
  mountReaderSkeleton(ids);
  video = mountPlayerChain();
  mockPlayerRects();
  seedBody();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Follow playback 悬浮按钮", () => {
  it("初始（未交互）无 follow 属性：按钮不应处于任何显态依据", () => {
    shell.renderReadingView();
    // 未写入属性 = 非 manual/off，CSS 默认隐藏（显隐只由三态属性驱动）
    expect(followValue()).toBe(null);
  });

  it("manual 态（手动滚离）点击：清暂停、follow 回 auto、跳回当前句但不改播放进度", () => {
    state.reader.readingViewOpen = true;
    shell.renderReadingView();
    shell.bindReadingViewVideo(video);
    video.play = () => Promise.resolve();
    video.currentTime = 12; // 第二句（10~30s）

    shell.syncReadingViewPlayback(true);
    expect(state.reader.readingActiveSubtitleIndex).toBe(1);

    // 用户滚离 → 手动暂停（manual）
    shell.noteManualReaderInteraction(60_000);
    expect(followValue()).toBe("manual");
    expect(readerState.isManualScrollPaused()).toBe(true);

    shell.resumeReaderFollowPlayback();
    expect(readerState.isManualScrollPaused()).toBe(false);
    expect(followValue()).toBe("auto");
    // 「跳回当前句」= 重新同步高亮，不是 seek：播放进度保持 12s
    expect(video.currentTime).toBe(12);
    expect(state.reader.readingActiveSubtitleIndex).toBe(1);
  });

  it("off 态（自动滚动被关闭）点击：重新打开自动滚动并同步设置面板 checkbox", () => {
    state.reader.readingViewOpen = true;
    shell.renderReadingView();
    shell.bindReadingViewVideo(video);
    video.play = () => Promise.resolve();

    state.reader.setAutoScroll(false);
    shell.updateReaderFollowState();
    expect(followValue()).toBe("off");

    const checkbox = document.getElementById(ids.readingAutoScroll) as HTMLInputElement;
    expect(checkbox.checked).toBe(true); // renderReaderPanels 上次写入的旧值

    shell.resumeReaderFollowPlayback();
    expect(state.reader.readingAutoScroll).toBe(true);
    expect(checkbox.checked).toBe(true);
    expect(followValue()).toBe("auto");
  });

  it("CSS/JS 契约：reader.css 的显隐选择器引用三态属性，转写中强制隐藏", () => {
    const css = readFileSync(resolve(process.cwd(), "extension/entry/styles/reader.css"), "utf8");
    expect(css).toContain('#boc-reading-view[data-boc-reader-follow="manual"] .boc-reading-follow-btn');
    expect(css).toContain('#boc-reading-view[data-boc-reader-follow="off"] .boc-reading-follow-btn');
    expect(css).toContain(".boc-reading-tab-body.is-transcribing .boc-reading-follow-btn");
  });
});
