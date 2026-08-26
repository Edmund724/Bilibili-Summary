// 反馈回路：阅读模式章节栏显隐 bug（"勾选章节与否，左侧都不再出现章节"）。
//
// 与 lifecycle.test.js 的区别：这里用真实 UI 模板（ensureUiReady/buildUiHtml）
// 与真实事件绑定（bindUiEvents），并覆盖现有测试没走到的链路：
//   A. 进入阅读模式时章节已在 state → 渲染 + 三处 data 属性契约
//   B. 章节经 presenter seam 迟到（subtitle-ready）→ 应触发重渲染
//   C. 真实复选框 change 事件 → data-*-chapter-visibility 应跟随勾选态
//   D. JS 写入的属性名必须与 content.css 隐藏选择器匹配（CSS/JS 契约）
//   E. hydrateReaderStateFromSettings 读取的设置 key 必须存在于 DEFAULT_SETTINGS

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";

let state;
let reader; // reader/index.js facade
let presenter;
let uiRenderer;
let sharedDefaults;

async function loadModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state;
  reader = await import("../../extension/reader/index.js");
  presenter = await import("../../extension/reader/presenter.js");
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
  sharedDefaults = await import("../../extension/core/shared-defaults.js");
}

// B 站页面侧的播放器宿主链（不在扩展模板里，需手动补）
// （复用共享 helper：mountPlayerChain）

function seedChapters() {
  state.clip.chapters = [
    { title: "开场", from: 0 },
    { title: "正片", from: 30 }
  ];
}

function seedSubtitleBody() {
  state.clip.subtitleBody = [
    { from: 0, to: 10, content: "大家好" },
    { from: 10, to: 30, content: "今天讲测试" }
  ];
}

function chapterButtons() {
  return document.querySelectorAll(`#${reader.ids.readingChapterList} .boc-reading-chapter`);
}

function railVisibilityAttrs() {
  const readingView = document.getElementById(reader.ids.readingView);
  return {
    readingViewChapterVisibility: readingView.getAttribute("data-chapter-visibility"),
    readingViewHasChapters: readingView.getAttribute("data-has-chapters"),
    htmlChapterVisibility: document.documentElement.getAttribute("data-boc-reader-chapter-visibility"),
    htmlHasChapters: document.documentElement.getAttribute("data-boc-reader-has-chapters"),
    bodyChapterVisibility: document.body.getAttribute("data-boc-reader-chapter-visibility"),
    bodyHasChapters: document.body.getAttribute("data-boc-reader-has-chapters")
  };
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-boc-reader-mode");
  document.body.removeAttribute("data-boc-reader-mode");
  await loadModules();
  uiRenderer.ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
});

afterEach(async () => {
  try {
    reader.stopReadingViewSync();
    reader.stopReaderPlayerObserver();
    reader.closeReadingView();
  } catch {
    // ignore
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("章节栏显隐反馈回路（真实模板 + 真实绑定）", () => {
  it("A. 进入阅读模式：章节渲染到列表，且三处 has-chapters/visibility 属性落位", async () => {
    seedChapters();
    seedSubtitleBody();
    reader.bindReaderPresenter();

    document.documentElement.setAttribute("data-boc-reader-mode", "1");
    document.body.setAttribute("data-boc-reader-mode", "1");
    await reader.enterReaderMode();

    expect(chapterButtons().length).toBe(2);
    expect(chapterButtons()[0].textContent).toContain("开场");

    const attrs = railVisibilityAttrs();
    expect(attrs.readingViewHasChapters).toBe("1");
    expect(attrs.htmlHasChapters).toBe("1");
    expect(attrs.bodyHasChapters).toBe("1");
    expect(attrs.readingViewChapterVisibility).toBe("auto");
    expect(attrs.htmlChapterVisibility).toBe("auto");
    expect(attrs.bodyChapterVisibility).toBe("auto");
  });

  it("B. 章节经 presenter seam 迟到（subtitle-ready）后应重渲染出章节", async () => {
    seedSubtitleBody();
    reader.bindReaderPresenter();

    document.documentElement.setAttribute("data-boc-reader-mode", "1");
    document.body.setAttribute("data-boc-reader-mode", "1");
    await reader.enterReaderMode();

    // 进入时无章节：空态 + has-chapters=0（此时 CSS 会隐藏整个 rail）
    expect(chapterButtons().length).toBe(0);
    expect(railVisibilityAttrs().readingViewHasChapters).toBe("0");

    // 模拟 fetcher 抓取完成：章节写入 state 后经 presenter 通知 reader
    seedChapters();
    presenter.notifyReaderPresenter("subtitle-ready");

    expect(chapterButtons().length).toBe(2);
    expect(railVisibilityAttrs().readingViewHasChapters).toBe("1");
  });

  it("C. 勾选/取消章节复选框（真实 change 事件）应切换 chapter-visibility 属性", async () => {
    seedChapters();
    seedSubtitleBody();
    reader.bindReaderPresenter();

    document.documentElement.setAttribute("data-boc-reader-mode", "1");
    document.body.setAttribute("data-boc-reader-mode", "1");
    await reader.enterReaderMode();

    const checkbox = document.getElementById(reader.ids.readingChapterVisible);
    expect(checkbox).not.toBe(null);
    expect(checkbox.checked).toBe(true);

    // 取消勾选 → hide（CSS 隐藏 rail）
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(railVisibilityAttrs().readingViewChapterVisibility).toBe("hide");
    expect(railVisibilityAttrs().htmlChapterVisibility).toBe("hide");
    expect(railVisibilityAttrs().bodyChapterVisibility).toBe("hide");

    // 重新勾选 → auto（有章节时 CSS 显示 rail）
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(railVisibilityAttrs().readingViewChapterVisibility).toBe("auto");
    expect(railVisibilityAttrs().htmlChapterVisibility).toBe("auto");
    expect(railVisibilityAttrs().bodyChapterVisibility).toBe("auto");

    // 章节按钮应始终在 DOM 中（显隐由 CSS 属性驱动，不销毁列表）
    expect(chapterButtons().length).toBe(2);
  });

  it("D. CSS 契约：content.css 隐藏 rail 的选择器必须引用 JS 实际写入的属性名", () => {
    const cssPath = resolve(process.cwd(), "extension/entry/content.css");
    const css = readFileSync(cssPath, "utf8");

    // 找到控制 .boc-reading-rail display:none 的规则块
    const hideRule = css.match(/[^{}]*\.boc-reading-rail[^{}]*\{[^}]*display:\s*none[^}]*\}/s);
    expect(hideRule, "content.css 中应存在隐藏 .boc-reading-rail 的规则").not.toBe(null);
    const selectors = hideRule[0];

    // JS 侧实际写入的属性（lifecycle.js applyReadingViewPresentation /
    // updateReaderChapterPresence）必须全部被选择器引用，否则属性写了也白写。
    expect(selectors).toContain('[data-chapter-visibility="hide"]'); // readingView 短名
    expect(selectors).toContain('[data-has-chapters="0"]'); // readingView 短名
    expect(selectors).toContain('[data-boc-reader-chapter-visibility="hide"]'); // html/body
    expect(selectors).toContain('[data-boc-reader-has-chapters="0"]'); // html/body

    // 反向：选择器里出现的 chapter 相关属性名，JS 必须真的会写。
    // 从 renderReadingView + applyReadingViewPresentation 路径取真实写入值比对。
    const readingView = document.getElementById(reader.ids.readingView);
    state.clip.chapters = [{ title: "x", from: 0 }];
    reader.renderReadingView();
    reader.updateReaderPreferences({ readerChapterVisible: false }, { persist: false });
    expect(readingView.getAttribute("data-chapter-visibility")).toBe("hide");
    expect(document.body.getAttribute("data-boc-reader-chapter-visibility")).toBe("hide");
  });

  it("E. 设置 key 契约：reader 读取的 readerChapterVisible 必须存在于 DEFAULT_SETTINGS", () => {
    // hydrateReaderStateFromSettings 读 settings.readerChapterVisible，
    // updateReaderPreferences 持久化的也是 readerChapterVisible。
    // 若 DEFAULT_SETTINGS 缺失该 key，storage 里没有历史值时读到的语义依赖
    // `?? true` 兜底，且 background 归一化只处理旧 key readerChapterVisibility。
    expect(
      Object.prototype.hasOwnProperty.call(sharedDefaults.DEFAULT_SETTINGS, "readerChapterVisible"),
      "DEFAULT_SETTINGS 缺少 readerChapterVisible（8c2e4ff 把 readerChapterVisibility 改名后未同步默认值/归一化）"
    ).toBe(true);
  });
});
