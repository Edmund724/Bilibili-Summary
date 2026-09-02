// 统一 Digest 面板三标签（PR2）回归测试：真实模板（ensureUiReady/buildUiHtml）
// + 真实事件绑定（bindUiEvents）。
//
// 覆盖：
//   A. 壳结构契约：面板壳/三 tab 按钮/三 tab body 存在，字幕列表挂在字幕
//      tab body 内（分批渲染的目标容器随搬家保持可用）；
//   B. 概览 tab（PR4 状态机宿主）初始为「未生成」诚实态；AI 对话 tab（PR5）
//      为静默真壳（消息区/输入框等节点齐备，未激活前空态无假数据）；
//   C. tab 切换：点击 tab 按钮 → is-active/aria-selected/hidden 三通道一致，
//      字幕 tab 与概览/AI 对话互斥显示；
//   D. 进入阅读模式重置到默认「字幕」tab（概览停留状态不跨会话保留）；
//   E. 视图开着期间 renderReadingView（切轨重渲）不重置 tab——不打断用户
//      所在标签。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let reader: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");

async function loadModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  reader = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
}

function seedSubtitleBody() {
  state.clip.subtitleBody = [
    { from: 0, to: 10, content: "大家好" },
    { from: 10, to: 30, content: "今天讲测试" }
  ];
}

function tabButton(name: "Subtitle" | "Overview" | "Chat") {
  return document.getElementById(ids[`readingTab${name}`]) as HTMLElement;
}

function tabBody(name: "Subtitle" | "Overview" | "Chat") {
  return document.getElementById(ids[`readingTabBody${name}`]) as HTMLElement;
}

function expectTabActive(name: "Subtitle" | "Overview" | "Chat", active: boolean) {
  expect(tabBody(name).classList.contains("is-active"), `${name} body is-active`).toBe(active);
  expect(tabBody(name).hasAttribute("hidden"), `${name} body hidden`).toBe(!active);
  expect(tabButton(name).classList.contains("is-active"), `${name} button is-active`).toBe(active);
  expect(tabButton(name).getAttribute("aria-selected"), `${name} aria-selected`).toBe(
    active ? "true" : "false"
  );
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

describe("统一 Digest 面板三标签", () => {
  it("A. 壳结构：三 tab 与 tab body 存在，字幕列表挂在字幕 tab body 内", () => {
    expect(document.getElementById(ids.readingDigestPanel)).not.toBe(null);
    expect(tabButton("Subtitle")).not.toBe(null);
    expect(tabButton("Overview")).not.toBe(null);
    expect(tabButton("Chat")).not.toBe(null);

    const subtitleList = document.getElementById(ids.readingSubtitleList) as HTMLElement;
    expect(subtitleList.parentElement).toBe(tabBody("Subtitle").querySelector(".boc-reading-main"));
    // 模板初值：字幕 tab 默认激活（与 ui-renderer 模板一致）
    expectTabActive("Subtitle", true);
    expectTabActive("Overview", false);
    expectTabActive("Chat", false);
  });

  it("B. 概览 tab（PR4 状态机宿主）保持诚实空态；AI 对话 tab（PR5）为静默真壳", () => {
    // 概览（PR4 落地）：初始为「未生成」诚实态，无假数据；渲染宿主节点存在。
    const overviewBody = document.getElementById(ids.readingOverviewBody) as HTMLElement;
    expect(overviewBody).not.toBe(null);
    const overviewCopy = tabBody("Overview").textContent || "";
    expect(overviewCopy).toContain("概览还未生成");
    expect(overviewBody.querySelector(".boc-reading-ov-chapter, .boc-reading-ov-quote")).toBe(null);
    expect(tabBody("Overview").querySelector("input, textarea, button, select")).toBe(null);

    // AI 对话（PR5 落地）：真对话 UI 壳（消息区/输入框/模型与思考档/预设历史），
    // 未激活前保持静默空态——空消息区、无假消息节点、无占位文案。
    const chatRoot = document.getElementById(ids.readingChatRoot) as HTMLElement;
    expect(chatRoot).not.toBe(null);
    expect(document.getElementById(ids.readingChatMessages)).not.toBe(null);
    expect(document.getElementById(ids.readingChatInput)).not.toBe(null);
    expect(document.getElementById(ids.readingChatModelSelect)).not.toBe(null);
    expect(document.getElementById(ids.readingChatPresetBtn)).not.toBe(null);
    expect(document.getElementById(ids.readingChatHistoryBtn)).not.toBe(null);
    expect(document.getElementById(ids.readingChatStopBtn)).not.toBe(null);
    const chatMessages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    expect(chatMessages.querySelectorAll(".sp-msg, .sp-center-error").length).toBe(0);
    expect((chatMessages.querySelector(".sp-suggestions") as HTMLElement).innerHTML).toBe("");
    expect(((document.getElementById(ids.readingChatInput) as HTMLTextAreaElement).value) || "").toBe("");
    // 待解释意图引用卡默认隐藏
    expect((document.getElementById(ids.readingChatIntent) as HTMLElement).hidden).toBe(true);
  });

  it("C. 点击 tab 按钮：三通道（is-active/aria-selected/hidden）一致切换", async () => {
    // bindUiEvents 由 ensureUiReady 首建时绑定；forceRecreate 后需重绑
    uiRenderer.bindUiEvents();

    (tabButton("Overview") as HTMLButtonElement).click();
    expectTabActive("Overview", true);
    expectTabActive("Subtitle", false);
    expectTabActive("Chat", false);

    (tabButton("Chat") as HTMLButtonElement).click();
    expectTabActive("Chat", true);
    expectTabActive("Overview", false);

    (tabButton("Subtitle") as HTMLButtonElement).click();
    expectTabActive("Subtitle", true);
    expectTabActive("Chat", false);
  });

  it("D. 进入阅读模式：重置回默认「字幕」tab", async () => {
    seedSubtitleBody();
    document.documentElement.setAttribute("data-boc-reader-mode", "1");
    document.body.setAttribute("data-boc-reader-mode", "1");

    // 先手动切到概览（模拟上一次会话的停留状态）
    uiRenderer.setReaderDigestTab("overview");
    expectTabActive("Overview", true);

    await reader.enterReaderMode();
    expect(state.reader.readingViewOpen).toBe(true);
    expectTabActive("Subtitle", true);
    expectTabActive("Overview", false);
    expectTabActive("Chat", false);

    // 字幕列表在打开后正常渲染进字幕 tab
    const subtitleList = document.getElementById(ids.readingSubtitleList) as HTMLElement;
    expect(subtitleList.querySelectorAll(".boc-reading-item").length).toBe(2);
  });

  it("E. 视图开着期间重渲（切轨/subtitle-ready）不重置所在 tab", async () => {
    seedSubtitleBody();
    document.documentElement.setAttribute("data-boc-reader-mode", "1");
    document.body.setAttribute("data-boc-reader-mode", "1");

    await reader.enterReaderMode();
    uiRenderer.setReaderDigestTab("overview");

    reader.renderReadingView();

    expectTabActive("Overview", true);
    expectTabActive("Subtitle", false);
  });
});
