// tests/reader/chat-lists.test.ts
// createReaderChatLists（对话 tab 三列表渲染 + 预设提示词插入）行为契约。
// PR5 自 tests/sidepanel/sidepanel-lists.test.js 随重建迁移（tests/sidepanel/
// 对应文件已迁走）：逻辑断言保真，DOM 壳换新——元素为 reader 的 readingChat*
// 节点，class 名沿用 .chat-*（样式段随对话区并入 reader.css）。
//
// 覆盖：
// - renderSuggestions：有平台/无历史/视频上下文时渲染建议 chip，点击填入输入框
//   并触发发送回调；无上下文 / 非视频页 / 流式中（有 chatHistory）/ 无平台时清空；
// - renderPresetPrompts：chip 点击 → insertPresetPrompt + 关预设 popover；
//   remove 点击 → removePresetPrompt 回调；空列表占位文案；
// - renderHistoryList：空列表占位 + 清空按钮隐藏；active / live-match 高亮；
//   open 点击 → applyById + 关历史 popover；remove 点击 → deleteById；
// - insertPresetPrompt：空输入 / 追加换行拼接 / focus。
//
// 模块纪元注意：chatSessionState 是模块级单例，beforeEach resetModules 后与被测
// 模块同纪元导入，并手动重置字段。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let createReaderChatLists;
let chatSessionState;

async function importModule() {
  const module = await import("../../extension/reader/chat-lists.js");
  const state = (await import("../../extension/chat/chat-state.js")).chatSessionState;
  createReaderChatLists = module.createReaderChatLists;
  chatSessionState = state;
}

function makeDeps(overrides = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const presetList = document.createElement("div");
  const historyList = document.createElement("div");
  const historyClearBtn = document.createElement("button");
  const input = document.createElement("textarea");
  container.append(presetList, historyList, historyClearBtn, input);

  let suggestionsNode = document.createElement("div");
  container.appendChild(suggestionsNode);
  const deps = {
    presetList,
    historyList,
    historyClearBtn,
    input,
    applyById: vi.fn(),
    deleteById: vi.fn(async () => {}),
    removePresetPrompt: vi.fn(async () => {}),
    autosizeInput: vi.fn(),
    onSuggestionClick: vi.fn(),
    getSuggestionsNode: () => suggestionsNode,
    insertPresetPrompt: null, // 组装后回填（惰性互引）
    hidePresetPopover: vi.fn(),
    hideHistoryPopover: vi.fn(),
    ...overrides
  };
  const lists = createReaderChatLists(deps);
  deps.insertPresetPrompt = (prompt) => lists.insertPresetPrompt(prompt);
  return { deps, lists, input, presetList, historyList, historyClearBtn, container, setSuggestionsNode: (node) => {
    suggestionsNode.remove();
    suggestionsNode = node;
    container.appendChild(node);
  } };
}

// setup.js 给 HTMLElement.prototype.click 打了「补派发一次 MouseEvent」的补丁，
// 直接 .click() 会双触发；测试里统一用 dispatchEvent 保证恰好一次。
function clickOnce(el) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

const VIDEO_CONTEXT = { isVideoContext: true, title: "测试视频", url: "https://www.bilibili.com/video/BV1" };

beforeEach(async () => {
  resetModuleState();
  await importModule();
  chatSessionState.providers = [{ id: "p1", name: "平台一", enabled: true }];
  chatSessionState.contextData = { ...VIDEO_CONTEXT };
  chatSessionState.chatHistory = [];
  chatSessionState.aiPrefs.aiInitialQuickPrompts = ["总结视频", "整理笔记"];
  chatSessionState.aiPrefs.aiPresetPrompts = [];
  chatSessionState.savedConversations = [];
  chatSessionState.currentConversationId = "";
  chatSessionState.currentConversationMeta = null;
  chatSessionState.liveContextData = null;
  chatSessionState.liveTabUrl = "";
  chatSessionState.liveContextKey = "";
});

describe("renderSuggestions（建议提示词）", () => {
  it("有上下文 + 有平台 + 无历史：渲染建议 chip，点击填入输入框并发送", async () => {
    const { lists, deps, input } = makeDeps();
    lists.renderSuggestions();

    const chips = [...document.querySelectorAll(".chat-chip")];
    expect(chips.map((btn) => btn.textContent)).toEqual(["总结视频", "整理笔记"]);

    clickOnce(chips[1]);
    expect(input.value).toBe("整理笔记");
    expect(deps.autosizeInput).toHaveBeenCalled();
    expect(deps.onSuggestionClick).toHaveBeenCalledWith("整理笔记");
  });

  it("无上下文：清空建议区", () => {
    chatSessionState.contextData = null;
    const { lists, setSuggestionsNode } = makeDeps();
    const node = document.createElement("div");
    setSuggestionsNode(node);
    lists.renderSuggestions();
    expect(node.innerHTML).toBe("");
  });

  it("非视频上下文（isVideoContext === false）：清空建议区", () => {
    chatSessionState.contextData = { ...VIDEO_CONTEXT, isVideoContext: false };
    const { lists, setSuggestionsNode } = makeDeps();
    const node = document.createElement("div");
    setSuggestionsNode(node);
    lists.renderSuggestions();
    expect(node.innerHTML).toBe("");
  });

  it("有会话历史（流式中）：清空建议区", () => {
    chatSessionState.chatHistory = [{ role: "user", content: "hi" }];
    const { lists, setSuggestionsNode } = makeDeps();
    const node = document.createElement("div");
    setSuggestionsNode(node);
    lists.renderSuggestions();
    expect(node.innerHTML).toBe("");
  });

  it("无可用平台：清空建议区", () => {
    chatSessionState.providers = [];
    const { lists, setSuggestionsNode } = makeDeps();
    const node = document.createElement("div");
    setSuggestionsNode(node);
    lists.renderSuggestions();
    expect(node.innerHTML).toBe("");
  });
});

describe("renderPresetPrompts（预设提示词）", () => {
  it("空列表：渲染占位文案", () => {
    const { lists, presetList } = makeDeps();
    lists.renderPresetPrompts();
    expect(presetList.innerHTML).toContain("chat-preset-empty");
  });

  it("chip 点击：插入提示词并关预设 popover", () => {
    chatSessionState.aiPrefs.aiPresetPrompts = ["提示词A", "提示词B"];
    const { lists, deps, input, presetList } = makeDeps();
    lists.renderPresetPrompts();
    const focusSpy = vi.spyOn(input, "focus");

    const chip = presetList.querySelectorAll(".chat-preset-chip")[1];
    clickOnce(chip);
    expect(input.value).toBe("提示词B");
    expect(focusSpy).toHaveBeenCalled();
    expect(deps.hidePresetPopover).toHaveBeenCalledTimes(1);
  });

  it("输入框已有内容：追加（换行拼接）而非覆盖", () => {
    chatSessionState.aiPrefs.aiPresetPrompts = ["提示词A"];
    const { lists, input, presetList } = makeDeps();
    input.value = "已有内容";
    lists.renderPresetPrompts();
    clickOnce(presetList.querySelector(".chat-preset-chip"));
    expect(input.value).toBe("已有内容\n提示词A");
  });

  it("remove 点击：调用 removePresetPrompt 回调", async () => {
    chatSessionState.aiPrefs.aiPresetPrompts = ["提示词A", "提示词B"];
    const { lists, deps, presetList } = makeDeps();
    lists.renderPresetPrompts();

    clickOnce(presetList.querySelectorAll(".chat-preset-remove")[1]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.removePresetPrompt).toHaveBeenCalledWith(1);
  });
});

describe("renderHistoryList（历史会话）", () => {
  it("空列表：占位文案 + 清空按钮隐藏", () => {
    const { lists, historyList, historyClearBtn } = makeDeps();
    lists.renderHistoryList();
    expect(historyList.innerHTML).toContain("chat-history-empty");
    expect(historyClearBtn.hidden).toBe(true);
  });

  it("有会话：清空按钮显示，渲染条目，open 点击触发 applyById + 关历史 popover", () => {
    chatSessionState.savedConversations = [
      { id: "c1", title: "会话一", contextKey: "", contextTitle: "", contextUrl: "", isVideoContext: true, createdAt: 0, updatedAt: 0, contextRef: null, messages: [] },
      { id: "c2", title: "会话二", contextKey: "", contextTitle: "", contextUrl: "", isVideoContext: true, createdAt: 0, updatedAt: 0, contextRef: null, messages: [] }
    ];
    chatSessionState.currentConversationId = "c2";
    const { lists, deps, historyList, historyClearBtn } = makeDeps();
    lists.renderHistoryList();

    expect(historyClearBtn.hidden).toBe(false);
    const items = [...historyList.querySelectorAll(".chat-history-item")];
    expect(items).toHaveLength(2);
    expect(items[0].classList.contains("is-active")).toBe(false);
    expect(items[1].classList.contains("is-active")).toBe(true);

    clickOnce(items[0].querySelector(".chat-history-open"));
    expect(deps.applyById).toHaveBeenCalledWith("c1");
    expect(deps.hideHistoryPopover).toHaveBeenCalledTimes(1);
  });

  it("remove 点击：调用 deleteById 回调", async () => {
    chatSessionState.savedConversations = [
      { id: "c1", title: "会话一", contextKey: "", contextTitle: "", contextUrl: "", isVideoContext: true, createdAt: 0, updatedAt: 0, contextRef: null, messages: [] }
    ];
    const { lists, deps, historyList } = makeDeps();
    lists.renderHistoryList();

    clickOnce(historyList.querySelector(".chat-history-remove"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.deleteById).toHaveBeenCalledWith("c1");
  });
});

describe("insertPresetPrompt", () => {
  it("空白提示词：no-op", () => {
    const { lists, input } = makeDeps();
    lists.insertPresetPrompt("   ");
    expect(input.value).toBe("");
  });

  it("空输入框：直接填入", () => {
    const { lists, input, deps } = makeDeps();
    const focusSpy = vi.spyOn(input, "focus");
    lists.insertPresetPrompt("  新提示词  ");
    expect(input.value).toBe("新提示词");
    expect(focusSpy).toHaveBeenCalled();
    expect(deps.autosizeInput).toHaveBeenCalled();
  });
});
