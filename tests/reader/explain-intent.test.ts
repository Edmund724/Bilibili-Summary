// PR3 句上「解释」入口与待解释意图契约回归测试（真实模板 + 真实事件绑定）。
//
// 覆盖：
// - 契约单测：set/peek（只读副本）/consume（取走即清）/clear 单槽语义，
//   后写覆盖先写（连点两句以最后一句为准）；
// - hover 浮层：mouseover 委托显示并记录条目，移入浮层自身保持显示，移出隐藏；
// - 点击「解释」：写入意图 {from, content, createdAt} + 三通道切到 AI 对话 tab
//   + 意图卡展示引用（quote + 时间戳 pill）；
// - 浮层点击不触发点句跳转（浮层不在字幕列表的 .boc-reading-item 委托链内）；
// - closeReadingView 会话收尾：清意图 + 清搜索。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let reader: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
let explainIntent: typeof import("../../extension/reader/explain-intent.js");
// PR5：对话 tab 二级惰性叶子（点击「解释」后经激活路径消费意图，测试显式
// await 激活落定再断言引用卡）。
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

function tabButton(name: "Subtitle" | "Overview" | "Chat") {
  return document.getElementById(ids[`readingTab${name}`]) as HTMLElement;
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

function subtitleItem(index: number): HTMLElement {
  return document.querySelector(`#${ids.readingSubtitleList} [data-index="${index}"]`) as HTMLElement;
}

function seedSubtitleBody() {
  state.clip.subtitleBody = [
    { from: 0, to: 10, content: "第一句话" },
    { from: 10, to: 30, content: "第二句话待解释" }
  ];
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-boc-reader-mode");
  document.body.removeAttribute("data-boc-reader-mode");
  await loadModules();
  uiRenderer.ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
  video = document.querySelector("video") as HTMLVideoElement;
  seedSubtitleBody();
  Element.prototype.scrollIntoView = () => {};
});

afterEach(async () => {
  try {
    reader.stopReadingViewSync();
    reader.closeReadingView();
  } catch {
    // ignore
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("待解释意图契约（reader/explain-intent）", () => {
  it("set/peek/consume/clear：单槽语义，peek 只读、consume 取走即清", () => {
    expect(explainIntent.peekPendingExplainIntent()).toBe(null);

    explainIntent.setPendingExplainIntent({ from: 12, content: "句子甲", createdAt: 1000 });
    const peeked = explainIntent.peekPendingExplainIntent();
    expect(peeked).toEqual({ from: 12, content: "句子甲", createdAt: 1000 });
    // peek 返回副本：外部改写不影响内部状态
    peeked!.content = "被篡改";
    expect(explainIntent.peekPendingExplainIntent()?.content).toBe("句子甲");

    // 后写覆盖先写（连点两句以最后一句为准）
    explainIntent.setPendingExplainIntent({ from: 34, content: "句子乙", createdAt: 2000 });
    expect(explainIntent.peekPendingExplainIntent()?.content).toBe("句子乙");

    const consumed = explainIntent.consumePendingExplainIntent();
    expect(consumed).toEqual({ from: 34, content: "句子乙", createdAt: 2000 });
    expect(explainIntent.consumePendingExplainIntent()).toBe(null);
    expect(explainIntent.peekPendingExplainIntent()).toBe(null);

    explainIntent.setPendingExplainIntent({ from: 1, content: "x", createdAt: 3 });
    explainIntent.clearPendingExplainIntent();
    expect(explainIntent.peekPendingExplainIntent()).toBe(null);
  });
});

describe("句上「解释」浮层（真实绑定）", () => {
  function renderList() {
    reader.renderReadingView();
  }

  it("hover 字幕句显示浮层并记录条目；移入浮层保持；移出隐藏", () => {
    renderList();
    const item = subtitleItem(1);
    item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(explainPop().hidden).toBe(false);
    expect(explainPop().dataset.itemIndex).toBe("1");

    // 移入浮层自身（浮层是 tab body 子节点）：保持显示
    explainBtn().dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(explainPop().hidden).toBe(false);

    // 移到非条目区域（工具条）：隐藏
    const toolbar = document.querySelector("#" + ids.readingTabBodySubtitle + " .boc-reading-sub-toolbar") as HTMLElement;
    toolbar.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(explainPop().hidden).toBe(true);
  });

  it("点击「解释」：写入意图 {from, content, createdAt} + 三通道切到 AI 对话 tab + 引用卡", async () => {
    renderList();
    subtitleItem(1).dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    explainBtn().click();

    const intent = explainIntent.peekPendingExplainIntent();
    expect(intent?.from).toBe(10); // data-seconds
    expect(intent?.content).toBe("第二句话待解释");
    expect(typeof intent?.createdAt).toBe("number");

    // tab 三通道（is-active/aria-selected/hidden）与 digest-tabs.test 同款断言
    expect(tabBody("Chat").classList.contains("is-active")).toBe(true);
    expect(tabBody("Chat").hasAttribute("hidden")).toBe(false);
    expect(tabButton("Chat").getAttribute("aria-selected")).toBe("true");
    expect(tabBody("Subtitle").classList.contains("is-active")).toBe(false);

    // 引用卡：对话 tab 激活（PR5 组合根接管 PR3 占位卡）后按 pending 意图渲染，
    // 时间戳 pill + 引用句（时间戳 pill 母题）
    const chatTab = await ensureReaderChatTab();
    await chatTab.ensureChatTabActivated();
    const intentCard = document.getElementById(ids.readingChatIntent) as HTMLElement;
    expect(intentCard.hidden).toBe(false);
    expect(intentCard.querySelector(".boc-reading-chat-intent-quote")?.textContent).toContain("第二句话待解释");
    expect(intentCard.querySelector(".boc-reading-chat-intent-time")?.textContent).toBe("00:10");
    // 自动发送被 provider 闸拦下（测试环境未配置平台）：意图保持 pending，可重试
    expect(explainIntent.peekPendingExplainIntent()).not.toBe(null);
  });

  it("连点两句「解释」：意图以最后一句为准", () => {
    renderList();
    subtitleItem(0).dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    explainBtn().click();
    expect(explainIntent.peekPendingExplainIntent()?.content).toBe("第一句话");

    subtitleItem(1).dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    explainBtn().click();
    expect(explainIntent.peekPendingExplainIntent()?.content).toBe("第二句话待解释");
  });

  it("浮层点击不触发点句跳转（播放进度不变）", () => {
    state.reader.readingViewOpen = true;
    renderList();
    reader.bindReadingViewVideo(video);
    video.play = () => Promise.resolve();
    video.currentTime = 5;

    subtitleItem(1).dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    explainBtn().click();

    // 点句跳转路径（onReadingSubtitleClick 的 .boc-reading-item 委托）不会被
    // 浮层点击触发；currentTime 保持 5s
    expect(video.currentTime).toBe(5);
  });

  it("closeReadingView 会话收尾：清待解释意图与搜索（输入框归零）", async () => {
    renderList();
    subtitleItem(0).dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    explainBtn().click();
    expect(explainIntent.peekPendingExplainIntent()).not.toBe(null);

    const searchInput = document.getElementById(ids.readingSearchInput) as HTMLInputElement;
    searchInput.value = "一句话";
    reader.refreshReadingSubtitleSearch();

    document.documentElement.setAttribute("data-boc-reader-mode", "1");
    document.body.setAttribute("data-boc-reader-mode", "1");
    reader.closeReadingView();

    expect(explainIntent.peekPendingExplainIntent()).toBe(null);
    expect(searchInput.value).toBe("");
    // 意图已清：对话 tab 会话收尾隐藏引用卡，下次激活按空态渲染（无意图不弹卡）
    const chatTab = await ensureReaderChatTab();
    await chatTab.ensureChatTabActivated();
    expect((document.getElementById(ids.readingChatIntent) as HTMLElement).hidden).toBe(true);
  });
});
