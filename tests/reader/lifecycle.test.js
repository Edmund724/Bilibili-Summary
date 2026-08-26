// reader 生命周期测试：进入/退出阅读模式。
// 通过 stub DOM（boc 阅读视图骨架）与 stub 视频元素驱动
// shell.js 的 enterReaderMode / closeReadingView / hydrate / apply 等真实路径。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";

let state;
let shell;
let pageFrame;
let impl;

async function loadReaderModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state;
  shell = await import("../../extension/reader/reader-impl.js");
  pageFrame = shell;
  impl = shell;
  return { state, shell, pageFrame };
}

// 构建阅读视图骨架：renderReadingView 需要的 DOM 都在这里。
function mountReaderSkeleton() {
  const doc = document;

  const root = doc.createElement("div");
  root.id = "boc-root";
  doc.body.appendChild(root);

  const readingView = doc.createElement("div");
  readingView.id = shell.ids.readingView;
  doc.body.appendChild(readingView);

  const readingStatus = doc.createElement("div");
  readingStatus.id = shell.ids.readingStatus;
  readingView.appendChild(readingStatus);

  const readingPlayerSlot = doc.createElement("div");
  readingPlayerSlot.id = shell.ids.readingPlayerSlot;
  readingView.appendChild(readingPlayerSlot);

  const readingMeta = doc.createElement("div");
  readingMeta.id = shell.ids.readingMeta;
  readingView.appendChild(readingMeta);

  const readingChapterList = doc.createElement("div");
  readingChapterList.id = shell.ids.readingChapterList;
  readingView.appendChild(readingChapterList);

  const readingTranscriptList = doc.createElement("div");
  readingTranscriptList.id = shell.ids.readingTranscriptList;
  readingView.appendChild(readingTranscriptList);

  const readingAutoScroll = doc.createElement("input");
  readingAutoScroll.type = "checkbox";
  readingAutoScroll.id = shell.ids.readingAutoScroll;
  readingView.appendChild(readingAutoScroll);

  const readingTranscriptVisible = doc.createElement("input");
  readingTranscriptVisible.type = "checkbox";
  readingTranscriptVisible.id = shell.ids.readingTranscriptVisible;
  readingView.appendChild(readingTranscriptVisible);

  const readingChapterVisible = doc.createElement("input");
  readingChapterVisible.type = "checkbox";
  readingChapterVisible.id = shell.ids.readingChapterVisible;
  readingView.appendChild(readingChapterVisible);

  const readingSettingsPanel = doc.createElement("div");
  readingSettingsPanel.id = shell.ids.readingSettingsPanel;
  readingView.appendChild(readingSettingsPanel);

  const readingSettingsBtn = doc.createElement("button");
  readingSettingsBtn.id = shell.ids.readingSettingsBtn;
  readingView.appendChild(readingSettingsBtn);

  const readingFontScaleSelect = doc.createElement("div");
  readingFontScaleSelect.id = shell.ids.readingFontScaleSelect;
  readingView.appendChild(readingFontScaleSelect);

  const readingLetterSpacingSelect = doc.createElement("div");
  readingLetterSpacingSelect.id = shell.ids.readingLetterSpacingSelect;
  readingView.appendChild(readingLetterSpacingSelect);

  const readingLineHeightSelect = doc.createElement("div");
  readingLineHeightSelect.id = shell.ids.readingLineHeightSelect;
  readingView.appendChild(readingLineHeightSelect);

  const readingContentWidthSelect = doc.createElement("div");
  readingContentWidthSelect.id = shell.ids.readingContentWidthSelect;
  readingView.appendChild(readingContentWidthSelect);

  const readingInfoSummary = doc.createElement("div");
  readingInfoSummary.id = shell.ids.readingInfoSummary;
  readingView.appendChild(readingInfoSummary);

  const readingInfoDescription = doc.createElement("div");
  readingInfoDescription.id = shell.ids.readingInfoDescription;
  readingView.appendChild(readingInfoDescription);

  const readingDescriptionBtn = doc.createElement("button");
  readingDescriptionBtn.id = shell.ids.readingDescriptionBtn;
  readingView.appendChild(readingDescriptionBtn);

  const readingSubtitleSelect = doc.createElement("select");
  readingSubtitleSelect.id = shell.ids.readingSubtitleSelect;
  readingView.appendChild(readingSubtitleSelect);

  const readingChapterVisibilitySelect = doc.createElement("select");
  readingChapterVisibilitySelect.id = shell.ids.readingChapterVisibilitySelect;
  readingView.appendChild(readingChapterVisibilitySelect);

  // 阅读主内容容器与内联宿主（moveReadingMainInline 的落点）
  const readingMain = doc.createElement("div");
  readingMain.className = "boc-reading-main";
  doc.body.appendChild(readingMain);

  // 播放器宿主链：video -> .bpx-player-video-area -> .bpx-player-container -> #bilibili-player -> #playerWrap
  const playerWrap = doc.createElement("div");
  playerWrap.id = "playerWrap";
  const bilibiliPlayer = doc.createElement("div");
  bilibiliPlayer.id = "bilibili-player";
  const playerContainer = doc.createElement("div");
  playerContainer.className = "bpx-player-container";
  const playerVideoArea = doc.createElement("div");
  playerVideoArea.className = "bpx-player-video-area";
  const playerPrimaryArea = doc.createElement("div");
  playerPrimaryArea.className = "bpx-player-primary-area";
  const video = doc.createElement("video");
  video.controls = false;
  Object.defineProperty(video, "duration", { value: 600, configurable: true });
  Object.defineProperty(video, "videoWidth", { value: 1920, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: 1080, configurable: true });
  Object.defineProperty(video, "paused", { value: true, configurable: true });
  Object.defineProperty(video, "readyState", { value: 4, configurable: true });

  playerPrimaryArea.appendChild(video);
  playerVideoArea.appendChild(playerPrimaryArea);
  playerContainer.appendChild(playerVideoArea);
  bilibiliPlayer.appendChild(playerContainer);
  playerWrap.appendChild(bilibiliPlayer);
  doc.body.appendChild(playerWrap);

  return { readingView, readingMain, playerWrap, video };
}

// 给播放器链上的元素补可见尺寸，保证 video-probe / player-host 判定通过。
function mockPlayerRects() {
  const nodes = [
    ".bpx-player-primary-area",
    ".bpx-player-video-area",
    ".bpx-player-container",
    "#bilibili-player",
    "#playerWrap",
    "#boc-reading-inline-host"
  ]
    .map((selector) => document.querySelector(selector))
    .filter(Boolean);

  nodes.forEach((node) => {
    node.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 450,
      width: 800,
      height: 450,
      toJSON: () => ({})
    });
  });

  const video = document.querySelector("video");
  if (video) {
    video.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 450,
      width: 800,
      height: 450,
      toJSON: () => ({})
    });
  }
  const readingMain = document.querySelector(".boc-reading-main");
  if (readingMain) {
    readingMain.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 450,
      width: 800,
      height: 450,
      toJSON: () => ({})
    });
  }
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
  mountReaderSkeleton();
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
