// sidepanel-chat-runtime 流式渲染测试：
// 验证 appendToken 在流式期间就渲染 markdown 结构（换行/缩进/列表），
// 且渲染出的节点始终保留光标 span（sp-msg-cursor）在内容之后；
// 以及流式累加器（thinking 头缓冲 / token { base, pending }）的显示语义。
//
// 注意：chat-runtime 直接读写 sidepanelState（./sidepanel-state.js）。测试在
// beforeEach 里 resetModules 后把两个模块放进同一模块纪元导入（跨纪元会拿到
// 两个不同的 state 单例），并在每个用例前手动重置会用到的字段。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";
import { renderMarkdown } from "../../extension/ui/markdown.js";

let createChatRuntime;
let sidepanelState;

function makeDeps() {
  const messages = document.createElement("div");
  const input = document.createElement("textarea");
  return {
    messages,
    input,
    stopBtn: null,
    store: {
      persistCurrent: vi.fn(async () => {}),
      // 会话身份守卫的单一判定点在 store；mock 与真实现同语义（严格相等，
      // 含空 id == 空当前 id → true 的新会话首发场景）
      isCurrent: vi.fn((id) => id === sidepanelState.currentConversationId)
    },
    ui: {
      setStreamingUiState: vi.fn(),
      showConversationContextNotice: vi.fn(),
      removeConversationContextNotice: vi.fn(),
      hidePresetPopover: vi.fn(),
      hideHistoryPopover: vi.fn(),
      removeCenteredState: vi.fn(),
      removeSuggestions: vi.fn(),
      resetConversationView: vi.fn(),
      autosizeInput: vi.fn()
    },
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
  // 同一模块纪元内新鲜导入（先 resetModules 再 import，两个模块同图解析）：
  ({ createChatRuntime } = await import("../../extension/pages/sidepanel-chat-runtime.js"));
  ({ sidepanelState } = await import("../../extension/pages/sidepanel-state.js"));
  // sidepanelState 是模块级单例，手动重置本文件用到的字段
  sidepanelState.contextData = null;
  sidepanelState.currentContextKey = "";
  sidepanelState.chatHistory = [];
  sidepanelState.currentConversationId = "";
  sidepanelState.currentConversationMeta = null;
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

    // 光标始终接在末块容器（sp-stream-tail）尾部、渲染内容之后
    const tailEl = node.querySelector(".sp-stream-tail");
    expect(tailEl.lastElementChild.className).toBe("sp-msg-cursor");
  });
});

describe("appendToken 稳定前缀 + 末块增量渲染", () => {
  it("多帧 flush：前缀未增长时 stable 容器不重渲染（只渲染一次），tail 每帧更新；finalize 后与全量渲染一致", () => {
    const runtime = createChatRuntime(makeDeps());
    const node = runtime.appendAssistantPlaceholder();
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);

    // 帧 1：两个段落 → stable = 第一段（空行边界），tail = 末段 + 光标
    runtime.appendToken(node, "第一段\n\n第二段开头");
    raf.mock.calls[0][0]();
    const stableEl = node.querySelector(".sp-stream-stable");
    const tailEl = node.querySelector(".sp-stream-tail");
    expect(stableEl.innerHTML).toBe(renderMarkdown("第一段"));
    expect(tailEl.querySelector("p").textContent).toBe("第二段开头");
    expect(tailEl.lastElementChild.className).toBe("sp-msg-cursor");

    // 篡改 stable 内容，用于探测后续帧是否重渲染了 stable
    stableEl.innerHTML = "SENTINEL";

    // 帧 2：tail 增长（无新空行边界）→ stable 不重渲染，tail 每帧更新
    runtime.appendToken(node, "，仍在增长");
    raf.mock.calls[1][0]();
    expect(stableEl.innerHTML).toBe("SENTINEL");
    expect(tailEl.querySelector("p").textContent).toBe("第二段开头，仍在增长");
    expect(tailEl.lastElementChild.className).toBe("sp-msg-cursor");

    // 帧 3：新空行边界出现 → stable 增长并重渲染一次
    runtime.appendToken(node, "\n\n第三段");
    raf.mock.calls[2][0]();
    expect(stableEl.innerHTML).toBe(renderMarkdown("第一段\n\n第二段开头，仍在增长"));
    expect(tailEl.querySelector("p").textContent).toBe("第三段");

    // finalize：流式双容器被整体替换，最终 DOM 与 renderMarkdown(全文) 一致
    const fullText = "第一段\n\n第二段开头，仍在增长\n\n第三段";
    runtime.finalizeAssistant(node);
    expect(node.querySelector(".sp-stream-stable")).toBeNull();
    expect(node.querySelector(".sp-stream-tail")).toBeNull();
    expect(node.querySelector(".sp-msg-assistant-body").innerHTML).toBe(renderMarkdown(fullText));
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
    const deps = makeDeps();
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
    expect(sidepanelState.chatHistory[0]).toEqual({ role: "user", content: "帮我写个标题" });
    expect(sidepanelState.chatHistory[1]).toEqual({ role: "assistant", content: fullText });
    expect(node.querySelector(".sp-msg-assistant-body").innerHTML).toBe(renderMarkdown(fullText));
  });
});

describe("sendMessage 无字幕拦截的提前返回", () => {
  // ensureCurrentContextForSend 的类型化信号（NO_SUBTITLE_SEND_BLOCKED）让
  // sendMessage 在用户消息上屏前中止：不追加用户/助手节点、不清输入框、
  // 不落 chatHistory、不发起 offscreen port、不进入流式 UI 状态。
  // notice 文案本身由 sidepanel（ensureCurrentContextForSend 调用方）负责。
  function makeSendDeps(ensureResult) {
    const deps = makeDeps();
    deps.input.value = "总结一下这个视频";
    deps.connectPort = vi.fn(async () => {
      throw new Error("不应发起 port");
    });
    deps.ensureCurrentContextForSend = vi.fn(async () => ensureResult);
    return { deps };
  }

  it("NO_SUBTITLE_SEND_BLOCKED（无字幕拦截）：不追加消息、不清输入、不发起 port", async () => {
    const { deps } = makeSendDeps("no-subtitle-send-blocked");
    const runtime = createChatRuntime(deps);

    await runtime.sendMessage();

    expect(deps.ensureCurrentContextForSend).toHaveBeenCalledTimes(1);
    expect(deps.connectPort).not.toHaveBeenCalled();
    expect(deps.messages.querySelector(".sp-msg-user")).toBeNull();
    expect(deps.messages.querySelector(".sp-msg-assistant")).toBeNull();
    expect(deps.input.value).toBe("总结一下这个视频");
    expect(deps.ui.setStreamingUiState).not.toHaveBeenCalledWith(true, expect.anything());
    expect(sidepanelState.chatHistory).toEqual([]);
  });

  it("false（上下文读取失败）：同样提前返回，行为与拦截一致", async () => {
    const { deps } = makeSendDeps(false);
    const runtime = createChatRuntime(deps);

    await runtime.sendMessage();

    expect(deps.connectPort).not.toHaveBeenCalled();
    expect(deps.messages.querySelector(".sp-msg-user")).toBeNull();
    expect(sidepanelState.chatHistory).toEqual([]);
  });

  it("true（放行）：照常追加用户消息并发起 port（非 empty 不受影响）", async () => {
    const deps = makeDeps();
    deps.input.value = "总结一下这个视频";
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

    expect(deps.connectPort).toHaveBeenCalledTimes(1);
    expect(deps.messages.querySelector(".sp-msg-user")?.textContent).toBe("总结一下这个视频");
    expect(deps.input.value).toBe("");
    expect(port.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe("stream-reset 代际重置（读流中断重试：整体重放）", () => {
  it("收到 stream-reset → 清空已渲染内容与累加器；第二代流从头渲染，finalize 不含第一代残留", async () => {
    const deps = makeDeps();
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
    const onMessage = messageListeners[0];
    const node = deps.messages.querySelector(".sp-msg-assistant");
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);

    // 第一代流：渲染出一部分内容（flush 落进 stable/tail 与累加器 base）
    onMessage({ type: "token", data: "# 第一代开头\n\n第一代正文" });
    raf.mock.calls[0][0]();
    expect(node.querySelector(".sp-stream-stable")).toBeTruthy();
    expect(node.querySelector("h3")?.textContent).toContain("第一代");

    // 读流中断重试：offscreen 发代际重置信号
    onMessage({ type: "stream-reset" });

    // 已渲染容器全部清掉，光标保留在节点末尾（下一帧 flush 重新接上）
    expect(node.querySelector(".sp-stream-stable")).toBeNull();
    expect(node.querySelector(".sp-stream-tail")).toBeNull();
    expect(node.querySelector(".sp-msg-cursor")).toBeTruthy();
    // 累加器清零：第一代 token 不再出现在后续 finalize 里

    // 第二代流（重试从头生成，内容与前缀都不同）
    onMessage({ type: "token", data: "## 第二代重写\n\n全新的正文" });
    raf.mock.calls[1][0]();
    expect(node.textContent).toContain("第二代重写");

    onMessage({ type: "done" });

    // finalize 全量 = 第二代流全文，无第一代拼接残留
    const expected = "## 第二代重写\n\n全新的正文";
    expect(sidepanelState.chatHistory[1]).toEqual({ role: "assistant", content: expected });
    expect(node.querySelector(".sp-msg-assistant-body").innerHTML).toBe(renderMarkdown(expected));
    expect(node.textContent).not.toContain("第一代");
  });

  it("stream-reset 时已渲染的思考节点一并清掉，后续 reasoning 事件重建", async () => {
    const deps = makeDeps();
    deps.input.value = "问题";
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
    const onMessage = messageListeners[0];
    const node = deps.messages.querySelector(".sp-msg-assistant");
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);

    onMessage({ type: "reasoning", data: "第一代思考" });
    expect(node.querySelector(".sp-thinking")?.textContent).toContain("第一代思考");

    onMessage({ type: "stream-reset" });
    expect(node.querySelector(".sp-thinking")).toBeNull();

    // 第二代思考从头累积（不是接在第一代后面）
    onMessage({ type: "reasoning", data: "第二代思考" });
    expect(node.querySelector(".sp-thinking-text")?.textContent).toBe("第二代思考");
  });
});
