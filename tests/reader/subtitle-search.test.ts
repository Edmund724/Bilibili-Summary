// PR3 字幕 tab 句内搜索回归测试。
//
// 覆盖：
// - 大小写不敏感字面量匹配（正则元字符按字面量，不做表达式求值）；
// - 匹配计数与上/下一条控件态（无匹配 → 「无匹配」+ 按钮 disabled）；
// - 分批渲染硬约束：搜索覆盖未渲染条目（计数含未上屏命中）；「下一条」跳到
//   第 2 批之后的条目先同步补渲染（不许跳不过去）；
// - 搜索激活期间后续批次上屏的条目自动带高亮（batched-render 批次回执 hook）；
// - 清除恢复原文本（无 mark 残留、textContent 逐字还原）；
// - renderReadingView 重渲后搜索重放（高亮/计数保持）；
// - 字幕 tab 隐藏（切到概览）时搜索状态维持，切回原样；
// - 真实事件绑定：input/Enter 驱动刷新与导航。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let shell: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
let video: HTMLVideoElement;

// fake rAF：捕获回调 + 尊重 cancelAnimationFrame（与 batched-subtitle.test 同款）
let rafPending: Map<number, (time: number) => void>;
let rafNextId: number;
let originalRaf: typeof window.requestAnimationFrame;
let originalCancelRaf: typeof window.cancelAnimationFrame;

function installFakeRaf() {
  rafPending = new Map();
  rafNextId = 0;
  originalRaf = window.requestAnimationFrame;
  originalCancelRaf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (cb: (time: number) => void) => {
    rafNextId += 1;
    rafPending.set(rafNextId, cb);
    return rafNextId;
  };
  window.cancelAnimationFrame = (id: number) => {
    rafPending.delete(id);
  };
}

function flushAnimationFrames(maxRounds = 30) {
  let rounds = 0;
  while (rafPending.size > 0 && rounds < maxRounds) {
    const entries = [...rafPending.entries()];
    entries.forEach(([id, cb]) => {
      rafPending.delete(id);
      cb(0);
    });
    rounds += 1;
  }
  if (rafPending.size > 0) {
    throw new Error(`rAF queue did not drain after ${maxRounds} rounds`);
  }
}

async function loadReaderModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  shell = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
}

function subtitleList(): HTMLElement {
  return document.getElementById(ids.readingSubtitleList) as HTMLElement;
}

function renderedItemCount(): number {
  return subtitleList().querySelectorAll(".boc-reading-item").length;
}

function searchMarks(): NodeListOf<HTMLElement> {
  return subtitleList().querySelectorAll("mark.boc-reading-search-hit");
}

function currentMark(): HTMLElement | null {
  return subtitleList().querySelector("mark.boc-reading-search-hit.search-current");
}

function searchInput(): HTMLInputElement {
  return document.getElementById(ids.readingSearchInput) as HTMLInputElement;
}

function searchCount(): string {
  return (document.getElementById(ids.readingSearchCount) as HTMLElement).textContent || "";
}

function seedBody() {
  state.clip.subtitleBody = [
    { from: 0, to: 2, content: "开场白普通句" },
    { from: 2, to: 4, content: "这里提到目标词甲" },
    { from: 4, to: 6, content: "目标词乙也在这里" }
  ];
}

// bindUiEvents 还需要经典面板与阅读头部按钮（不在阅读骨架内，与 sync.test 同款补齐）
function mountBindExtras() {
  const readingView = document.getElementById(ids.readingView) as HTMLElement;
  const readingThemeSelect = document.createElement("button");
  readingThemeSelect.id = ids.readingThemeSelect;
  readingView.appendChild(readingThemeSelect);
  const readingCloseBtn = document.createElement("button");
  readingCloseBtn.id = ids.readingCloseBtn;
  readingView.appendChild(readingCloseBtn);

  const panel = document.createElement("div");
  panel.id = "boc-panel";
  document.body.appendChild(panel);
  (
    [
      ["boc-close-btn", "button"],
      ["boc-refresh-btn", "button"],
      ["boc-subtitle-select", "select"],
      ["boc-copy-btn", "button"],
      ["boc-download-btn", "button"],
      ["boc-settings-btn", "button"]
    ] as [string, keyof HTMLElementTagNameMap][]
  ).forEach(([id, tag]) => {
    const node = document.createElement(tag);
    node.id = id;
    panel.appendChild(node);
  });
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadReaderModules();
  mountReaderSkeleton(ids);
  video = mountPlayerChain();
  installFakeRaf();
  Element.prototype.scrollIntoView = () => {};
  seedBody();
});

afterEach(() => {
  window.requestAnimationFrame = originalRaf;
  window.cancelAnimationFrame = originalCancelRaf;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("字幕句内搜索", () => {
  it("大小写不敏感字面量匹配：命中计数 + 当前命中 mark + 控件可用", () => {
    state.clip.subtitleBody = [
      { from: 0, to: 2, content: "Alpha 命中" },
      { from: 2, to: 4, content: "alpha 也命中" },
      { from: 4, to: 6, content: "不含该词" }
    ];
    shell.renderReadingView();
    searchInput().value = "ALPHA";
    shell.refreshReadingSubtitleSearch();

    expect(searchMarks().length).toBe(2);
    expect(currentMark()?.textContent).toBe("Alpha");
    expect(searchCount()).toBe("1 / 2");
    expect((document.getElementById(ids.readingSearchPrevBtn) as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById(ids.readingSearchNextBtn) as HTMLButtonElement).disabled).toBe(false);
  });

  it("正则元字符按字面量匹配：a.b 不命中 axb", () => {
    state.clip.subtitleBody = [
      { from: 0, to: 2, content: "字面 a.b 出现" },
      { from: 2, to: 4, content: "中间 axb 不算" }
    ];
    shell.renderReadingView();
    searchInput().value = "a.b";
    shell.refreshReadingSubtitleSearch();

    expect(searchMarks().length).toBe(1);
    expect(currentMark()?.textContent).toBe("a.b");
    expect(searchCount()).toBe("1 / 1");
  });

  it("无匹配：计数显示「无匹配」，上/下一条禁用", () => {
    shell.renderReadingView();
    searchInput().value = "不存在的词";
    shell.refreshReadingSubtitleSearch();

    expect(searchMarks().length).toBe(0);
    expect(searchCount()).toBe("无匹配");
    expect((document.getElementById(ids.readingSearchPrevBtn) as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById(ids.readingSearchNextBtn) as HTMLButtonElement).disabled).toBe(true);
  });

  it("搜索覆盖未渲染条目：800 条里未上屏的命中也计入，下一条先同步补渲染", () => {
    const body = [];
    for (let i = 0; i < 800; i += 1) {
      const content = i === 5 ? "独特目标词甲" : i === 600 ? "独特目标词乙" : `普通句${i}`;
      body.push({ from: i * 2, to: i * 2 + 1.9, content });
    }
    state.clip.subtitleBody = body;
    shell.renderReadingView();
    expect(renderedItemCount()).toBe(120); // item 600 尚未上屏

    searchInput().value = "目标词";
    shell.refreshReadingSubtitleSearch();
    // 匹配在数据层计算：两条命中（含未渲染的 item 600）都计数
    expect(searchCount()).toBe("1 / 2");

    shell.moveReadingSubtitleSearch(1);
    // 补渲染到目标 index 后才拿得到节点（不许跳不过去）
    expect(renderedItemCount()).toBeGreaterThanOrEqual(601);
    expect(searchCount()).toBe("2 / 2");
    const hit = subtitleList().querySelector('[data-index="600"] mark.boc-reading-search-hit.search-current');
    expect(hit?.textContent).toBe("目标词");
  });

  // 显式 20s 超时（arch-slim-2/06）：800 条 rAF 逐帧追加 + 逐条高亮是全量套件
  // 里最重的 CPU 用例，默认 10s 线在全量并发下被挤过（单文件实测 ~5s，断言与
  // 执行路径无关并发）。超时放宽不放宽断言。
  it("搜索激活期间后续批次渲染的条目自动带高亮", () => {
    const body = [];
    for (let i = 0; i < 800; i += 1) {
      body.push({ from: i * 2, to: i * 2 + 1.9, content: `关键词第${i}条` });
    }
    state.clip.subtitleBody = body;
    shell.renderReadingView();
    searchInput().value = "关键词";
    shell.refreshReadingSubtitleSearch();
    expect(searchMarks().length).toBe(120); // 首屏批已带高亮

    flushAnimationFrames();
    // 后续批次上屏即带高亮：800 条全部有 mark
    expect(renderedItemCount()).toBe(800);
    expect(searchMarks().length).toBe(800);
    expect(subtitleList().querySelector('[data-index="700"] mark.boc-reading-search-hit')).not.toBe(null);
  }, 20000);

  it("清除搜索恢复原文本：无 mark 残留，textContent 逐字还原", () => {
    shell.renderReadingView();
    searchInput().value = "目标词";
    shell.refreshReadingSubtitleSearch();
    expect(searchMarks().length).toBeGreaterThan(0);

    searchInput().value = "";
    shell.refreshReadingSubtitleSearch();
    expect(searchMarks().length).toBe(0);
    expect(searchCount()).toBe("");
    expect(
      (subtitleList().querySelector('[data-index="1"] .boc-reading-text') as HTMLElement).textContent
    ).toBe("这里提到目标词甲");
  });

  it("renderReadingView 重渲后搜索重放：高亮与计数保持", () => {
    shell.renderReadingView();
    searchInput().value = "目标词";
    shell.refreshReadingSubtitleSearch();
    expect(searchCount()).toBe("1 / 2");

    shell.renderReadingView();
    expect(searchMarks().length).toBeGreaterThan(0);
    expect(searchCount()).toBe("1 / 2");
    expect(currentMark()).not.toBe(null);
  });

  it("字幕 tab 隐藏时搜索状态维持，切回原样", () => {
    shell.renderReadingView();
    searchInput().value = "目标词";
    shell.refreshReadingSubtitleSearch();
    const marksBefore = searchMarks().length;

    uiRenderer.setReaderDigestTab("overview");
    // DOM 不销毁：输入、高亮、计数原样保留
    expect(searchInput().value).toBe("目标词");
    expect(searchMarks().length).toBe(marksBefore);
    expect(searchCount()).toBe("1 / 2");

    uiRenderer.setReaderDigestTab("subtitle");
    expect(searchMarks().length).toBe(marksBefore);
    expect(currentMark()).not.toBe(null);
  });

  it("真实事件绑定：input 刷新 + Enter 循环导航", async () => {
    shell.renderReadingView();
    mountBindExtras();
    uiRenderer.bindUiEvents();

    searchInput().value = "目标词";
    searchInput().dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(searchCount()).toBe("1 / 2"));

    searchInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
    await vi.waitFor(() => expect(searchCount()).toBe("2 / 2"));
    expect(
      subtitleList().querySelector('[data-index="2"] mark.boc-reading-search-hit.search-current')
    ).not.toBe(null);
  });

  it("真实事件绑定：Escape 清输入恢复文本", async () => {
    shell.renderReadingView();
    mountBindExtras();
    uiRenderer.bindUiEvents();

    searchInput().value = "目标词";
    searchInput().dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(searchMarks().length).toBeGreaterThan(0));

    searchInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    await vi.waitFor(() => expect(searchMarks().length).toBe(0));
    expect(searchInput().value).toBe("");
  });
});

// 防抖接线（arch-slim-4/03）：input 路径 180ms trailing 防抖 + Enter/Escape/
// prev/next 冲刷，全部经真实事件绑定驱动（模块层零改动，防抖只存在于
// bindSubtitleTabEvents 闭包）。
describe("字幕句内搜索防抖接线", () => {
  function flushDebounceWindow(): void {
    // jsdom 环境：直接快进所有挂起的 setTimeout（fake timers 与既有 rAF 假时钟
    // 不冲突——分批渲染用 rAF，防抖用 timer，两套互不干扰）。
    vi.runAllTimers();
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // withReader 首次触发走 reader 域动态 import 边（其 then 链在 fake timers 下
  // 需十几个微任务 tick 兑现，探针实测 17）；逐轮 await 排空直到落地。
  async function settle(): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      await Promise.resolve();
    }
  }

  async function bindRealEvents() {
    shell.renderReadingView();
    mountBindExtras();
    uiRenderer.bindUiEvents();
  }

  it("input 停顿 180ms 后 refresh 恰一次（非逐键）", async () => {
    await bindRealEvents();
    searchInput().value = "目标词";
    searchInput().dispatchEvent(new Event("input", { bubbles: true }));
    // 防抖窗口内不刷新
    vi.advanceTimersByTime(179);
    expect(searchCount()).toBe("");
    // 停顿过线后恰一次
    vi.advanceTimersByTime(1);
    await settle();
    expect(searchCount()).toBe("1 / 2");
  });

  it("防抖窗口内多键合并为停顿后一次", async () => {
    await bindRealEvents();
    // 逐字打「目标词」：每键重置计时器，只在最后一次停顿后执行
    for (const ch of ["目", "标", "词"]) {
      searchInput().value = searchInput().value + ch;
      searchInput().dispatchEvent(new Event("input", { bubbles: true }));
      vi.advanceTimersByTime(100);
    }
    expect(searchCount()).toBe("");
    vi.advanceTimersByTime(80);
    await settle();
    expect(searchCount()).toBe("1 / 2");
  });

  it("防抖窗口内按 Enter：先冲刷新词再导航（不作用于旧词 matches）", async () => {
    await bindRealEvents();
    // 先建立「目标词」的稳定结果并移动一次（currentIndex=0）
    searchInput().value = "目标词";
    searchInput().dispatchEvent(new Event("input", { bubbles: true }));
    flushDebounceWindow();
    await settle();
    expect(searchCount()).toBe("1 / 2");

    // 防抖窗口内改成「目标词乙」并立即 Enter：冲刷后应在乙的匹配上导航
    searchInput().value = "目标词乙";
    searchInput().dispatchEvent(new Event("input", { bubbles: true }));
    searchInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
    await settle();
    expect(searchCount()).toBe("1 / 1");
    expect(
      subtitleList().querySelector('[data-index="2"] mark.boc-reading-search-hit.search-current')
    ).not.toBe(null);
    // 计时器已被冲刷消费：快进不再二次刷新
    flushDebounceWindow();
    await settle();
    expect(searchCount()).toBe("1 / 1");
  });

  it("防抖窗口内按 prev/next：先冲刷新词再导航", async () => {
    await bindRealEvents();
    // 先建立稳定搜索让 next 按钮脱离初始 disabled（无匹配时 jsdom click 不派发）
    searchInput().value = "目标词";
    searchInput().dispatchEvent(new Event("input", { bubbles: true }));
    flushDebounceWindow();
    await settle();
    expect(searchCount()).toBe("1 / 2");

    // 防抖窗口内改成「目标词乙」（唯一命中）并点 next：冲刷使导航作用于新词
    //（冲刷与 move 是两次独立 withReader，先后各排空一次微任务）
    searchInput().value = "目标词乙";
    searchInput().dispatchEvent(new Event("input", { bubbles: true }));
    (document.getElementById(ids.readingSearchNextBtn) as HTMLButtonElement).click();
    await settle();
    await settle();
    expect(searchCount()).toBe("1 / 1");
  });

  it("防抖窗口内按 Escape：冲刷后清空（高亮与计时器无残留）", async () => {
    await bindRealEvents();
    searchInput().value = "目标词乙";
    searchInput().dispatchEvent(new Event("input", { bubbles: true }));
    searchInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    await settle();
    expect(searchInput().value).toBe("");
    expect(searchMarks().length).toBe(0);
    expect(searchCount()).toBe("");
    // 计时器已消费：快进不再把已清空的词重新刷回来
    flushDebounceWindow();
    await settle();
    expect(searchMarks().length).toBe(0);
  });
});
