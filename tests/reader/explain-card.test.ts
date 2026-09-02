// 选区「解释」浮层 + 面板内解释卡片回归测试（真实模板 + 真实事件绑定）。
//
// 覆盖：
// - 选区触发：在字幕句内选中词/句 → 浮层显示并记录条目；选区清空 → 隐藏；
//   列表外（工具条）的选区不触发；
// - 点「解释」：面板内弹卡片（loading → ready 文本），不切 tab、不写待解释意图；
// - 卡片「去对话追问」：写意图（含 selection）+ 三通道切到 AI 对话 tab；
// - 卡片关闭（×/遮罩）与 closeReadingView 会话收尾；
// - provider 解析失败 → error 态 + 重试按钮；
// - 浮层/卡片点击不触发点句跳转（都不在 .boc-reading-item 委托链内）。
//
// AI 侧（provider 解析 + 解释请求）以 vi.mock 替身解耦：请求组装与提示词口径在
// tests/ai/explain.test.ts 单测，这里只测接线与状态迁移。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

const aiMock = vi.hoisted(() => ({
  resolveActiveProvider: vi.fn(async () => ({ baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "m" })),
  explainSelection: vi.fn(async (_input: Record<string, unknown>) => "这是模型给出的解释。")
}));

vi.mock("../../extension/ai/active-provider.js", () => ({
  resolveActiveProvider: aiMock.resolveActiveProvider,
  NO_ACTIVE_PROVIDER_MESSAGE: "还没有配置 AI 平台，请先在插件设置中添加并启用。"
}));
vi.mock("../../extension/ai/explain.js", () => ({
  explainSelection: aiMock.explainSelection,
  buildExplainMessages: vi.fn(() => []),
  buildExplainContext: vi.fn(() => "")
}));

let state: TestState;
let reader: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
let explainIntent: typeof import("../../extension/reader/explain-intent.js");
let ensureReaderChatTab: typeof import("../../extension/core/lazy-chat-tab.js").ensureReaderChatTab;
let video: HTMLVideoElement;

async function loadModules() {
  setLocationUrl(READER_MODE_URL);
  explainIntent = await import("../../extension/reader/explain-intent.js");
  state = (await import("../../extension/core/state.js")).state as TestState;
  reader = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
  ensureReaderChatTab = (await import("../../extension/core/lazy-chat-tab.js")).ensureReaderChatTab;
}

function tabBody(name: "Subtitle" | "Overview" | "Chat") {
  return document.getElementById(ids[`readingTabBody${name}`]) as HTMLElement;
}

function explainPop(): HTMLElement {
  return document.getElementById(ids.readingExplainPop) as HTMLElement;
}

function explainBtn(): HTMLButtonElement {
  return explainPop().querySelector("button") as HTMLButtonElement;
}

function explainCard(): HTMLElement {
  return document.getElementById(ids.readingExplainCard) as HTMLElement;
}

function cardAction(action: string): HTMLElement | null {
  return explainCard().querySelector<HTMLElement>(`[data-explain-card-action="${action}"]`);
}

function subtitleItem(index: number): HTMLElement {
  return document.querySelector(`#${ids.readingSubtitleList} [data-index="${index}"]`) as HTMLElement;
}

function seedSubtitleBody() {
  state.clip.subtitleBody = [
    { from: 0, to: 10, content: "第一句话" },
    { from: 10, to: 30, content: "我们习惯将其视为传递信息的工具" }
  ];
}

// 在指定条目文本里选中一段（jsdom 不自动派发 selectionchange，手动补一发）
function selectInItem(index: number, text: string) {
  const item = subtitleItem(index);
  const textNode = item.querySelector(".boc-reading-text")?.firstChild as Text;
  const full = textNode.textContent || "";
  const start = Math.max(0, full.indexOf(text));
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, start + text.length);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

function clearSelection() {
  const selection = document.getSelection();
  selection?.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));
}

function dispatchActionClick(action: string) {
  cardAction(action)?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-boc-reader-mode");
  document.body.removeAttribute("data-boc-reader-mode");
  aiMock.resolveActiveProvider.mockResolvedValue({ baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "m" });
  aiMock.explainSelection.mockReset();
  aiMock.explainSelection.mockResolvedValue("这是模型给出的解释。");
  await loadModules();
  uiRenderer.ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
  video = document.querySelector("video") as HTMLVideoElement;
  seedSubtitleBody();
  reader.renderReadingView();
  Element.prototype.scrollIntoView = () => {};
});

afterEach(async () => {
  try {
    clearSelection();
    reader.stopReadingViewSync();
    reader.closeReadingView();
  } catch {
    // ignore
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("选区「解释」浮层", () => {
  it("句内选中词 → 浮层显示并记录条目；选区清空 → 隐藏", () => {
    expect(explainPop().hidden).toBe(true);

    selectInItem(1, "传递信息的工具");
    expect(explainPop().hidden).toBe(false);
    expect(explainPop().dataset.itemIndex).toBe("1");

    clearSelection();
    expect(explainPop().hidden).toBe(true);
  });

  it("列表外的选区不触发浮层", () => {
    const input = document.getElementById(ids.readingSearchInput) as HTMLInputElement;
    input.select();
    document.dispatchEvent(new Event("selectionchange"));
    expect(explainPop().hidden).toBe(true);
  });

  it("列表滚动即隐藏浮层（定位基准失效）", () => {
    selectInItem(1, "工具");
    expect(explainPop().hidden).toBe(false);
    (document.getElementById(ids.readingSubtitleList) as HTMLElement).dispatchEvent(new Event("scroll"));
    expect(explainPop().hidden).toBe(true);
  });
});

describe("面板内解释卡片", () => {
  it("点「解释」：就地弹卡片并渲染解释，不切 tab、不写待解释意图", async () => {
    selectInItem(1, "传递信息的工具");
    explainBtn().click();

    // 卡片经 reader 动态域装载（loadReaderDomain().then），断言前等一轮落定
    await vi.waitFor(() => expect(explainCard().hidden).toBe(false));
    expect(explainCard().querySelector(".boc-reading-explain-card-quote")?.textContent).toBe("传递信息的工具");

    await vi.waitFor(() =>
      expect(explainCard().querySelector(".boc-reading-explain-card-answer")?.textContent).toContain("这是模型给出的解释。")
    );

    // 请求入参：选中片段 + 所在整句 + 起始秒 + 条目下标（上下文窗口锚点）
    const args = aiMock.explainSelection.mock.calls[0][0];
    expect(args.selection).toBe("传递信息的工具");
    expect(args.line).toBe("我们习惯将其视为传递信息的工具");
    expect(args.from).toBe(10);
    expect(args.index).toBe(1);
    expect(Array.isArray(args.body)).toBe(true);

    // 阅读不被打断：仍在字幕 tab，且没有写对话侧的待解释意图
    expect(tabBody("Subtitle").classList.contains("is-active")).toBe(true);
    expect(tabBody("Chat").classList.contains("is-active")).toBe(false);
    expect(explainIntent.peekPendingExplainIntent()).toBe(null);
  });

  it("卡片「去对话追问」：写意图（含 selection）+ 切到 AI 对话 tab + 引用卡展示选中片段", async () => {
    selectInItem(1, "传递信息的工具");
    explainBtn().click();
    await vi.waitFor(() => expect(explainCard().hidden).toBe(false));

    dispatchActionClick("ask-chat");

    // 卡片内动作经 reader 动态域转发（异步），等落定再断言意图与 tab 态
    let intent = explainIntent.peekPendingExplainIntent();
    await vi.waitFor(() => {
      intent = explainIntent.peekPendingExplainIntent();
      expect(intent).not.toBe(null);
    });
    expect(intent!.content).toBe("我们习惯将其视为传递信息的工具");
    expect(intent!.selection).toBe("传递信息的工具");
    expect(intent!.from).toBe(10);

    // 卡片自身收起（切 tab 后留在字幕 tab 里会残留）
    await vi.waitFor(() => expect(explainCard().hidden).toBe(true));
    expect(tabBody("Chat").classList.contains("is-active")).toBe(true);

    const chatTab = await ensureReaderChatTab();
    await chatTab.ensureChatTabActivated();
    const quote = document.querySelector(`#${ids.readingChatIntent} .boc-reading-chat-intent-quote`);
    expect(quote?.textContent).toContain("传递信息的工具");
    expect(quote?.textContent).toContain("我们习惯将其视为传递信息的工具");
  });

  it("× / 遮罩 / Esc 都关闭卡片", async () => {
    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(true));

    dispatchActionClick("close");
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(false));
    expect(explainCard().hidden).toBe(true);

    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(true));
    const mask = explainCard().querySelector(".boc-reading-explain-card-mask") as HTMLElement;
    mask.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(false));

    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(true));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(false));
  });

  it("provider 解析失败 → error 态如实展示，重试按钮再次发起", async () => {
    aiMock.resolveActiveProvider.mockRejectedValueOnce(new Error("还没有配置 AI 平台，请先在插件设置中添加并启用。"));

    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() =>
      expect(explainCard().querySelector(".boc-reading-explain-card-state.is-error")?.textContent).toContain("还没有配置 AI 平台")
    );
    const firstCallCount = aiMock.explainSelection.mock.calls.length;

    dispatchActionClick("retry");
    await vi.waitFor(() => expect(aiMock.explainSelection.mock.calls.length).toBe(firstCallCount + 1));
    await vi.waitFor(() =>
      expect(explainCard().querySelector(".boc-reading-explain-card-answer")?.textContent).toContain("这是模型给出的解释。")
    );
  });

  it("换选区重复打开：只留最后一张卡，过期回执不覆盖新内容", async () => {
    let resolveFirst: (text: string) => void = () => {};
    aiMock.explainSelection.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveFirst = resolve; })
    );
    aiMock.explainSelection.mockImplementationOnce(async () => "第二次的解释。");

    selectInItem(0, "第一句话");
    explainBtn().click();
    await vi.waitFor(() => expect(explainCard().querySelector(".boc-reading-explain-card-quote")?.textContent).toBe("第一句话"));

    selectInItem(1, "传递信息的工具");
    explainBtn().click();
    await vi.waitFor(() =>
      expect(explainCard().querySelector(".boc-reading-explain-card-answer")?.textContent).toContain("第二次的解释。")
    );

    // 迟到的第一次回执必须被丢弃（代际守卫）
    resolveFirst("第一次的解释。");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const answer = explainCard().querySelector(".boc-reading-explain-card-answer")?.textContent || "";
    expect(answer).toContain("第二次的解释。");
    expect(answer).not.toContain("第一次的解释。");
  });

  it("closeReadingView 会话收尾：卡片关闭并中止在飞请求", async () => {
    aiMock.explainSelection.mockImplementationOnce(
      (input: Record<string, unknown>) =>
        new Promise<string>((_resolve, reject) => {
          const signal = input.signal as AbortSignal | null | undefined;
          signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { aborted: true })));
        })
    );
    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(true));

    document.documentElement.setAttribute("data-boc-reader-mode", "1");
    document.body.setAttribute("data-boc-reader-mode", "1");
    reader.closeReadingView();

    expect(reader.isReaderExplainCardOpen()).toBe(false);
    expect(explainCard().hidden).toBe(true);
  });

  it("浮层与卡片点击都不触发点句跳转（播放进度不变）", async () => {
    state.reader.readingViewOpen = true;
    reader.bindReadingViewVideo(video);
    video.play = () => Promise.resolve();
    video.currentTime = 5;

    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(explainCard().hidden).toBe(false));
    dispatchActionClick("close");

    expect(video.currentTime).toBe(5);
  });
});
