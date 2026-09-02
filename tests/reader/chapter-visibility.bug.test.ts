// 反馈回路：阅读模式章节属性链（历史 bug："勾选章节与否，左侧都不再出现章节"）。
//
// 与 lifecycle.test.js 的区别：这里用真实 UI 模板（ensureUiReady/buildUiHtml）
// 与真实事件绑定（bindUiEvents），覆盖属性链路：
//   A. 进入阅读模式时章节已在 state → has-chapters/visibility 三处 data 属性契约
//      （阶段 2 B 形态：rail 章节列表 DOM 退役，属性链保留，阶段 4b 才做语义改写）
//   B. 章节经 presenter seam 迟到（subtitle-ready）→ 属性应更新
//   C. 真实复选框 change 事件 → data-*-chapter-visibility 应跟随勾选态
//   D. hydrateReaderStateFromSettings 读取的设置 key 必须存在于 DEFAULT_SETTINGS
// （原 rail 渲染断言与 gate CSS 隐藏选择器契约随 rail 退役删除）

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let reader: typeof import("../../extension/reader/index.js");
let initEssentials: typeof import("../../extension/reader/init-essentials.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let presenter: typeof import("../../extension/reader/presenter.js");
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
let defaultsModule: typeof import("../../extension/core/defaults.js");

async function loadModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  reader = await import("../../extension/reader/index.js");
  initEssentials = await import("../../extension/reader/init-essentials.js");
  ids = (await import("../../extension/reader/state.js")).ids;
  presenter = await import("../../extension/reader/presenter.js");
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
  defaultsModule = await import("../../extension/core/defaults.js");
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

function railVisibilityAttrs() {
  const readingView = document.getElementById(ids.readingView)!;
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

describe("章节属性链反馈回路（真实模板 + 真实绑定）", () => {
  it("A. 进入阅读模式：三处 has-chapters/visibility 属性落位", async () => {
    seedChapters();
    seedSubtitleBody();
    initEssentials.bindReaderPresenter();

    document.documentElement.setAttribute("data-boc-reader-mode", "1");
    document.body.setAttribute("data-boc-reader-mode", "1");
    await reader.enterReaderMode();

    const attrs = railVisibilityAttrs();
    expect(attrs.readingViewHasChapters).toBe("1");
    expect(attrs.htmlHasChapters).toBe("1");
    expect(attrs.bodyHasChapters).toBe("1");
    expect(attrs.readingViewChapterVisibility).toBe("auto");
    expect(attrs.htmlChapterVisibility).toBe("auto");
    expect(attrs.bodyChapterVisibility).toBe("auto");
  });

  it("B. 章节经 presenter seam 迟到（subtitle-ready）后属性应更新", async () => {
    seedSubtitleBody();
    initEssentials.bindReaderPresenter();

    document.documentElement.setAttribute("data-boc-reader-mode", "1");
    document.body.setAttribute("data-boc-reader-mode", "1");
    await reader.enterReaderMode();

    // 进入时无章节：has-chapters=0
    expect(railVisibilityAttrs().readingViewHasChapters).toBe("0");

    // 模拟 fetcher 抓取完成：章节写入 state 后经 presenter 通知 reader
    seedChapters();
    presenter.notifyReaderPresenter("subtitle-ready");

    // 候选02 分层惰性：presenter 注册接线（bindReaderPresenter）改为常驻微模块
    // 内经 ensureReaderDomain() 装载 reader 域后转发处理体，通知处理由同步变为
    // 装载后异步。断言语义不变（迟到章节触发重渲染），仅补装载等待。
    await vi.waitFor(() => {
      expect(railVisibilityAttrs().readingViewHasChapters).toBe("1");
    });
  });

  it("C. 勾选/取消章节复选框（真实 change 事件）应切换 chapter-visibility 属性", async () => {
    seedChapters();
    seedSubtitleBody();
    initEssentials.bindReaderPresenter();

    document.documentElement.setAttribute("data-boc-reader-mode", "1");
    document.body.setAttribute("data-boc-reader-mode", "1");
    await reader.enterReaderMode();

    const checkbox = document.getElementById(ids.readingChapterVisible)! as HTMLInputElement;
    expect(checkbox).not.toBe(null);
    expect(checkbox.checked).toBe(true);

    // 取消勾选 → hide
    // 候选02 分层惰性：ui-renderer 的 change 回调经 ensureReaderDomain（缓存
    // promise）转发 updateReaderPreferences，属性写入由同步变为装载后异步；
    // 断言语义不变，仅补装载等待。
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(railVisibilityAttrs().readingViewChapterVisibility).toBe("hide");
    });
    expect(railVisibilityAttrs().htmlChapterVisibility).toBe("hide");
    expect(railVisibilityAttrs().bodyChapterVisibility).toBe("hide");

    // 重新勾选 → auto（有章节时）
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(railVisibilityAttrs().readingViewChapterVisibility).toBe("auto");
    });
    expect(railVisibilityAttrs().htmlChapterVisibility).toBe("auto");
    expect(railVisibilityAttrs().bodyChapterVisibility).toBe("auto");
  });

  it("D. 设置 key 契约：reader 读取的 readerChapterVisible 必须存在于 DEFAULT_SETTINGS", () => {
    // hydrateReaderStateFromSettings 读 settings.readerChapterVisible，
    // updateReaderPreferences 持久化的也是 readerChapterVisible。
    // 若 DEFAULT_SETTINGS 缺失该 key，storage 里没有历史值时读到的语义依赖
    // `?? true` 兜底，且 background 归一化只处理旧 key readerChapterVisibility。
    expect(
      Object.prototype.hasOwnProperty.call(defaultsModule.DEFAULT_SETTINGS, "readerChapterVisible"),
      "DEFAULT_SETTINGS 缺少 readerChapterVisible（8c2e4ff 把 readerChapterVisibility 改名后未同步默认值/归一化）"
    ).toBe(true);
  });
});
