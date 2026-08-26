// 播放同步（sync）与章节/字幕高亮切换测试。
// 覆盖 transcript-sync.js 的 start/stop/sync/click 与 shell.js 的 renderReadingView。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mockPlayerRects, mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";

let state;
let shell;
let sync;
let playerHost;
let uiRenderer;
let video;

async function loadReaderModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state;
  shell = await import("../../extension/reader/index.js");
  sync = shell;
  playerHost = shell;
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
}

function mountExtraSkeleton() {
  const doc = document;

  // bindUiEvents 需要的额外节点（阅读视图相关）
  const readingThemeSelect = doc.createElement("button");
  readingThemeSelect.id = shell.ids.readingThemeSelect;
  doc.body.querySelector(`#${shell.ids.readingView}`).appendChild(readingThemeSelect);

  const readingCloseBtn = doc.createElement("button");
  readingCloseBtn.id = shell.ids.readingCloseBtn;
  doc.body.querySelector(`#${shell.ids.readingView}`).appendChild(readingCloseBtn);

  // 经典面板（bindUiEvents 通过 byId 访问）
  const panel = doc.createElement("div");
  panel.id = "boc-panel";
  doc.body.appendChild(panel);
  [
    ["boc-close-btn", "button"],
    ["boc-refresh-btn", "button"],
    ["boc-subtitle-select", "select"],
    ["boc-copy-btn", "button"],
    ["boc-download-btn", "button"],
    ["boc-settings-btn", "button"]
  ].forEach(([id, tag]) => {
    const node = doc.createElement(tag);
    node.id = id;
    panel.appendChild(node);
  });

  return { readingThemeSelect, readingCloseBtn, panel };
}

function setStateClip() {
  state.clip.chapters = [
    { title: "开场", from: 0 },
    { title: "正片", from: 30 },
    { title: "结尾", from: 60 }
  ];
  state.clip.subtitleBody = [
    { from: 0, to: 10, content: "大家好" },
    { from: 10, to: 30, content: "第二句" },
    { from: 30, to: 60, content: "第三句" }
  ];
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadReaderModules();
  mountReaderSkeleton(shell.ids);
  mountExtraSkeleton();
  video = mountPlayerChain();
  mockPlayerRects();
  setStateClip();
  // 大多数用例聚焦高亮切换本身；自动滚动路径单独覆盖
  state.reader.readingAutoScroll = false;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("播放同步与高亮", () => {
  it("渲染后首个字幕项默认高亮（readerState 重置为 -1 后的 get 行为）", () => {
    expect(state.reader.readingActiveSubtitleIndex).toBe(-1);
    const readingView = document.getElementById(shell.ids.readingView);
    expect(readingView.querySelectorAll(".boc-reading-item").length).toBe(0);
    // 列表尚未渲染（未调 renderReadingView），因此无高亮项
    expect(readingView.querySelector(".boc-reading-item.is-active")).toBe(null);
  });

  it("手动渲染列表后无高亮项（activeIndex 为 -1）", () => {
    shell.renderReadingView();
    const readingView = document.getElementById(shell.ids.readingView);
    expect(readingView.querySelectorAll(".boc-reading-item").length).toBe(3);
    expect(readingView.querySelector(".boc-reading-item.is-active")).toBe(null);
    expect(readingView.querySelector(".boc-reading-chapter.is-active")).toBe(null);
  });

  it("syncReadingViewPlayback：按 currentTime 切换字幕与章节高亮", () => {
    state.reader.readingViewOpen = true;
    state.reader.readingNativePageMode = true;
    shell.renderReadingView();

    // 手动绑定 stub 视频（与挂载路径一致）
    const bound = playerHost.bindReadingViewVideo(video);
    expect(bound).toBe(video);
    expect(video.__bocReadingSyncHandler).toBeTypeOf("function");

    video.currentTime = 12;
    sync.syncReadingViewPlayback();

    const readingView = document.getElementById(shell.ids.readingView);
    const activeTranscript = readingView.querySelector(".boc-reading-item.is-active");
    const activeChapter = readingView.querySelector(".boc-reading-chapter.is-active");
    expect(activeTranscript.dataset.index).toBe("1");
    expect(activeTranscript.textContent).toContain("第二句");
    expect(activeChapter.dataset.index).toBe("0");

    // 状态同步到 readerState
    expect(state.reader.readingActiveSubtitleIndex).toBe(1);
    expect(state.reader.readingActiveChapterIndex).toBe(0);
  });

  it("video timeupdate 事件驱动同步并切换高亮", () => {
    state.reader.readingViewOpen = true;
    state.reader.readingNativePageMode = true;
    shell.renderReadingView();
    playerHost.bindReadingViewVideo(video);

    video.currentTime = 35;
    video.dispatchEvent(new Event("timeupdate"));

    const readingView = document.getElementById(shell.ids.readingView);
    const activeTranscript = readingView.querySelector(".boc-reading-item.is-active");
    const activeChapter = readingView.querySelector(".boc-reading-chapter.is-active");
    expect(activeTranscript.dataset.index).toBe("2");
    expect(activeChapter.dataset.index).toBe("1");
    expect(state.reader.readingActiveSubtitleIndex).toBe(2);
    expect(state.reader.readingActiveChapterIndex).toBe(1);
  });

  it("停止同步：移除事件监听与定时器", () => {
    state.reader.readingViewOpen = true;
    playerHost.bindReadingViewVideo(video);
    sync.startReadingViewSync();
    expect(video.__bocReadingSyncHandler).toBeTypeOf("function");

    sync.stopReadingViewSync();

    expect(video.__bocReadingSyncHandler).toBeUndefined();
  });

  it("点击章节跳转：设置 video.currentTime 并高亮对应字幕", () => {
    state.reader.readingViewOpen = true;
    state.reader.readingNativePageMode = true;
    shell.renderReadingView();
    playerHost.bindReadingViewVideo(video);
    video.play = vi.fn(() => Promise.resolve());
    uiRenderer.bindUiEvents();

    const readingView = document.getElementById(shell.ids.readingView);
    const secondChapter = readingView.querySelectorAll(".boc-reading-chapter")[1];
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    secondChapter.dispatchEvent(event);

    expect(video.currentTime).toBe(30);
    const activeChapter = readingView.querySelector(".boc-reading-chapter.is-active");
    expect(activeChapter.dataset.index).toBe("1");
    expect(state.reader.readingActiveChapterIndex).toBe(1);
  });

  it("点击字幕跳转：选择文本时忽略，空白选区时跳转", () => {
    state.reader.readingViewOpen = true;
    state.reader.readingNativePageMode = true;
    shell.renderReadingView();
    playerHost.bindReadingViewVideo(video);
    video.play = vi.fn(() => Promise.resolve());
    uiRenderer.bindUiEvents();

    const readingView = document.getElementById(shell.ids.readingView);
    const target = readingView.querySelectorAll(".boc-reading-item")[2];

    // 选中文本时不跳转
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(video.currentTime).toBe(0);

    // 清空选区后点击跳转
    selection.removeAllRanges();
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(video.currentTime).toBe(30);
    const activeTranscript = readingView.querySelector(".boc-reading-item.is-active");
    expect(activeTranscript.dataset.index).toBe("2");
  });

  it("jumpReadingTarget：暂停时触发播放", () => {
    state.reader.readingViewOpen = true;
    playerHost.bindReadingViewVideo(video);
    video.play = vi.fn(() => Promise.resolve());

    sync.jumpReadingTarget(45);

    expect(video.currentTime).toBe(45);
    expect(video.play).toHaveBeenCalled();
  });

  it("updateReaderFollowState：按自动滚动/手动暂停状态写入 data-boc-reader-follow", () => {
    const readingView = document.getElementById(shell.ids.readingView);
    state.reader.readingViewOpen = true;
    state.reader.readingAutoScroll = true;

    // 手动交互暂停跟随（等价于原状态字段直接赋值：手动暂停 5s）
    sync.noteManualReaderInteraction(5000);
    sync.updateReaderFollowState();
    expect(readingView.getAttribute("data-boc-reader-follow")).toBe("manual");

    // 关闭自动滚动后跟随关闭
    state.reader.readingAutoScroll = false;
    sync.updateReaderFollowState();
    expect(readingView.getAttribute("data-boc-reader-follow")).toBe("off");
  });

  it("noteManualReaderInteraction：自动滚动开启时暂停跟随（data-boc-reader-follow=manual）", () => {
    const readingView = document.getElementById(shell.ids.readingView);
    state.reader.readingViewOpen = true;
    state.reader.readingAutoScroll = true;

    sync.noteManualReaderInteraction(5000);

    expect(readingView.getAttribute("data-boc-reader-follow")).toBe("manual");
  });
});
