// sidepanel-chat-runtime 流式渲染测试：
// 验证 appendToken 在流式期间就渲染 markdown 结构（换行/缩进/列表），
// 且渲染出的节点始终保留光标 span（sp-msg-cursor）在内容之后；
// 以及流式累加器（thinking 头缓冲 / token { base, pending }）的显示语义。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";
import { renderMarkdown } from "../../extension/ui/markdown.js";

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
    getThinkingLevel: () => "off",
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

describe("appendThinkingText 流式思考文本", () => {
  it("reasoning 超 4000 字符后 textContent 与旧逻辑逐字节一致（前 4000 + 截断提示），且跨消息重置", () => {
    const runtime = createChatRuntime(makeDeps());
    const assistantNode = runtime.appendAssistantPlaceholder();
    const thinkingNode = runtime.createThinkingNode(assistantNode);
    const textNode = thinkingNode.querySelector(".sp-thinking-text");
    const SUFFIX = "\n…（思考内容过长，已截断显示）";

    // 逐块喂入：覆盖 4000 边界落在块中间、恰好 4000（不截断）、超 1 字符（截断）、持续溢出
    const chunks = [
      "a".repeat(1500), // 累计 1500
      "b".repeat(2499), // 累计 3999
      "c",              // 累计 4000：恰好到上限，仍不截断
      "d",              // 累计 4001：截断，多出的 1 字符不进显示
      "e".repeat(2500)  // 累计 6501：头缓冲冻结，只累加溢出
    ];
    let total = "";
    for (const chunk of chunks) {
      runtime.appendThinkingText(thinkingNode, chunk);
      total += chunk;
      // 旧逻辑的期望输出：全量累计 > 4000 → 前 4000 字符 + 截断提示；否则全量
      const expected = total.length > 4000 ? total.slice(0, 4000) + SUFFIX : total;
      expect(textNode.textContent).toBe(expected);
    }

    // 头缓冲冻结在前 4000 字符，溢出部分（d/e…）不进显示
    expect(textNode.textContent).toBe("a".repeat(1500) + "b".repeat(2499) + "c" + SUFFIX);
    // 累加器已不在 DOM 上（dataset.acc 撤下）
    expect(textNode.dataset.acc).toBeUndefined();

    // 跨消息重置：新消息的 thinking 节点不串上一条内容
    const secondAssistant = runtime.appendAssistantPlaceholder();
    const secondThinking = runtime.createThinkingNode(secondAssistant);
    runtime.appendThinkingText(secondThinking, "第二条思考");
    expect(secondThinking.querySelector(".sp-thinking-text").textContent).toBe("第二条思考");
  });
});

describe("appendToken 累加器与 finalize 全量文本", () => {
  it("多次 flush 后 finalize 拿到的全量文本与逐 token 拼接一致（含未 flush 的 pending）", async () => {
    const history = [];
    const deps = makeDeps();
    deps.getChatHistory = () => history;
    deps.input.value = "帮我写个标题";
    const messageListeners = [];
    const port = {
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      onDisconnect: { addListener: () => {} },
      postMessage: vi.fn(),
      disconnect: vi.fn()
    };
    deps.connectPort = vi.fn(async () => port);
    const runtime = createChatRuntime(deps);

    await runtime.sendMessage();
    expect(port.postMessage).toHaveBeenCalledTimes(1);

    const onMessage = messageListeners[0];
    const node = deps.messages.querySelector(".sp-msg-assistant");
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);

    const tokens = ["# 标题\n\n", "第一段**加粗**", "\n\n- 项目一\n", "- 项目二\n", "结尾文本"];
    const fullText = tokens.join("");

    // 第一批 token → flush #1
    onMessage({ type: "token", data: tokens[0] });
    onMessage({ type: "token", data: tokens[1] });
    expect(raf).toHaveBeenCalledTimes(1);
    raf.mock.calls[0][0]();
    expect(node.querySelector("h3")).toBeTruthy();

    // 第二批 token → flush #2
    onMessage({ type: "token", data: tokens[2] });
    expect(raf).toHaveBeenCalledTimes(2);
    raf.mock.calls[1][0]();
    expect(node.querySelectorAll("li")).toHaveLength(1);

    // 第三批 token：只 append 未 flush，留在 pending 缓冲里
    onMessage({ type: "token", data: tokens[3] });
    onMessage({ type: "token", data: tokens[4] });
    expect(raf).toHaveBeenCalledTimes(3); // 已调度但未执行
    expect(node.querySelectorAll("li")).toHaveLength(1); // 尚未渲染

    // finalize：取消待执行 flush，全量文本 = base + pending，与逐 token 拼接一致
    onMessage({ type: "done" });

    // 累加器已不在 DOM 上（dataset.raw 撤下）
    expect(node.dataset.raw).toBeUndefined();
    expect(history[0]).toEqual({ role: "user", content: "帮我写个标题" });
    expect(history[1]).toEqual({ role: "assistant", content: fullText });
    expect(node.querySelector(".sp-msg-assistant-body").innerHTML).toBe(renderMarkdown(fullText));
  });
});
