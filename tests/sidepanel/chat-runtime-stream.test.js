// sidepanel-chat-runtime 流式渲染测试：
// 验证 appendToken 在流式期间就渲染 markdown 结构（换行/缩进/列表），
// 且渲染出的节点始终保留光标 span（sp-msg-cursor）在内容之后。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";

let createChatRuntime;

function makeDeps() {
  const messages = document.createElement("div");
  const input = document.createElement("textarea");
  return {
    messages,
    input,
    stopBtn: null,
    store: { persistCurrent: vi.fn(async () => {}) },
    getChatHistory: () => [],
    getCurrentConversationMeta: () => null,
    setCurrentConversationMeta: vi.fn(),
    getCurrentContextKey: () => "",
    setCurrentConversationId: vi.fn(),
    getContextData: () => ({}),
    getAiPrefs: () => ({ aiSystemPrompt: "" }),
    setStreamingUiState: vi.fn(),
    showConversationContextNotice: vi.fn(),
    removeConversationContextNotice: vi.fn(),
    hidePresetPopover: vi.fn(),
    hideHistoryPopover: vi.fn(),
    removeCenteredState: vi.fn(),
    removeSuggestions: vi.fn(),
    resetConversationView: vi.fn(),
    autosizeInput: vi.fn(),
    shouldAutoScrollMessagesEnabled: () => true,
    setShouldAutoScrollMessages: vi.fn(),
    ensureCurrentContextForSend: vi.fn(async () => true),
    getProviderId: () => "test-provider",
    getTimestampNavDeps: () => ({}),
    normalizeMarkdownForSectionPaste,
    connectPort: vi.fn()
  };
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  createChatRuntime = (await import("../../extension/pages/sidepanel-chat-runtime.js")).createChatRuntime;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("appendToken 流式 markdown 渲染", () => {
  it("流式期间按帧渲染 markdown 结构并保留光标", () => {
    const runtime = createChatRuntime(makeDeps());
    const node = runtime.appendAssistantPlaceholder();

    // 拦截 rAF：注册回调但不自动执行，由用例手动驱动每帧 flush
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);

    // 第一帧：标题 + 列表项
    runtime.appendToken(node, "# 标题\n- 第一项\n");
    expect(raf).toHaveBeenCalledTimes(1);
    raf.mock.calls[0][0]();
    expect(node.querySelector("h3")).toBeTruthy();
    expect(node.querySelector("li")).toBeTruthy();
    expect(node.querySelector(".sp-msg-cursor")).toBeTruthy();

    // 第二帧：追加列表项 + 代码块
    runtime.appendToken(node, "- 第二项\n```js\nconst a = 1;\n```\n");
    expect(raf).toHaveBeenCalledTimes(2);
    raf.mock.calls[1][0]();
    expect(node.querySelectorAll("li")).toHaveLength(2);
    expect(node.querySelector("pre code")).toBeTruthy();
    expect(node.querySelector(".sp-msg-cursor")).toBeTruthy();

    // 第三帧：追加段落
    runtime.appendToken(node, "结尾段落\n");
    expect(raf).toHaveBeenCalledTimes(3);
    raf.mock.calls[2][0]();
    expect(node.querySelectorAll("li")).toHaveLength(2);
    expect(node.querySelector("p")).toBeTruthy();

    // 光标始终在渲染内容之后
    const children = [...node.children];
    expect(children[children.length - 1].className).toBe("sp-msg-cursor");
  });
});
