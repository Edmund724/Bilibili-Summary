// sidepanel-chat-runtime 字幕体省略传输测试（候选5「追问不重传字幕体」SP 侧）：
// - 首条消息（lastAcked 为空）→ context 携带全量 subtitleBody + contextKey；
// - 收到带 cachedContextKey 的回执（offscreen 单槽确认）→ 后续追问 context
//   不再含 subtitleBody，其余元数据/aiSystemPrompt/history 照常全量；
// - 字幕体缺失错误（code subtitle-body-missing）→ lastAcked 重置，下一条
//   消息重新携带全文（不自动重发本条）；
// - port 断连（offscreen 文档被回收）→ lastAcked 重置。
//
// 注意：chat-runtime 直接读写 chatSessionState。沿 chat-runtime-stream.test.js
// 的单纪元模式：beforeEach 里 resetModules 后把两个模块放进同一模块纪元导入，
// 并手动重置用到的字段。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";

let createChatRuntime;
let chatSessionState;

const CONTEXT_KEY = "video:BV1body|101";
const SUBTITLE_BODY = [{ from: 0, to: 5, content: "x".repeat(1000) }];

function makePort() {
  const listeners = { message: [], disconnect: [] };
  return {
    port: {
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
      postMessage: vi.fn(),
      disconnect: vi.fn()
    },
    listeners
  };
}

function makeRuntime() {
  const ports = [];
  const deps = {
    messages: document.createElement("div"),
    input: document.createElement("textarea"),
    stopBtn: null,
    store: {
      persistCurrent: vi.fn(async () => {}),
      isCurrent: (id) => id === chatSessionState.currentConversationId
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
    connectPort: vi.fn(async () => {
      const session = makePort();
      ports.push(session);
      return session.port;
    })
  };
  return { runtime: createChatRuntime(deps), deps, ports };
}

function seedVideoContext() {
  chatSessionState.contextData = {
    bvid: "BV1body",
    cid: "101",
    title: "长视频",
    url: "https://www.bilibili.com/video/BV1body/",
    subtitleBody: SUBTITLE_BODY
  };
  chatSessionState.currentContextKey = CONTEXT_KEY;
}

// 发送一条消息（sendMessage 会清空 input.value，每条消息需重新赋值）
async function send(runtime, deps, text) {
  deps.input.value = text;
  await runtime.sendMessage();
}

// 断言该会话发过恰好一条 chat 消息并返回消息本体
function getChatMessage(session) {
  expect(session.port.postMessage).toHaveBeenCalledTimes(1);
  const msg = session.port.postMessage.mock.calls[0][0];
  expect(msg.action).toBe("chat");
  return msg;
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  ({ createChatRuntime } = await import("../../extension/chat/chat-runtime.js"));
  ({ chatSessionState } = await import("../../extension/chat/chat-state.js"));
  chatSessionState.contextData = null;
  chatSessionState.currentContextKey = "";
  chatSessionState.chatHistory = [];
  chatSessionState.currentConversationId = "";
  chatSessionState.currentConversationMeta = null;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("追问消息的字幕体省略传输", () => {
  it("首条消息：lastAcked 为空 → context 携带全量 subtitleBody 与 contextKey", async () => {
    seedVideoContext();
    const { runtime, deps, ports } = makeRuntime();

    await send(runtime, deps, "总结一下这个视频");

    const msg = getChatMessage(ports[0]);
    expect(msg.contextKey).toBe(CONTEXT_KEY);
    expect(msg.context.subtitleBody).toBe(SUBTITLE_BODY);
    expect(msg.context.aiSystemPrompt).toBe("");
  });

  it("收到 cachedContextKey 回执后：追问 context 省略 subtitleBody，元数据/history 照常全量", async () => {
    seedVideoContext();
    chatSessionState.aiPrefs.aiSystemPrompt = "你是助手";
    const { runtime, deps, ports } = makeRuntime();

    // 第一条：发送 → offscreen 确认缓存（token 回执带 cachedContextKey）→ 正常收尾
    await send(runtime, deps, "总结一下这个视频");
    const first = getChatMessage(ports[0]);
    expect(first.context.subtitleBody).toBe(SUBTITLE_BODY);
    ports[0].listeners.message[0]({ type: "token", data: "你好", cachedContextKey: CONTEXT_KEY });
    ports[0].listeners.message[0]({ type: "done", cachedContextKey: CONTEXT_KEY });
    expect(ports[0].port.disconnect).toHaveBeenCalled();

    // 第二条（追问）：lastAcked 命中 → subtitleBody 不再携带
    await send(runtime, deps, "第二章讲了什么？");
    const second = getChatMessage(ports[1]);
    expect(second.contextKey).toBe(CONTEXT_KEY);
    expect("subtitleBody" in second.context).toBe(false);
    // 其余负载不受省略影响：元数据、系统提示、历史照常全量
    expect(second.context.title).toBe("长视频");
    expect(second.context.bvid).toBe("BV1body");
    expect(second.context.aiSystemPrompt).toBe("你是助手");
    expect(second.history).toEqual(chatSessionState.chatHistory);
    expect(second.prompt).toBe("第二章讲了什么？");
  });

  it("字幕体缺失错误（code subtitle-body-missing）→ lastAcked 重置，下一条重新携带全文", async () => {
    seedVideoContext();
    const { runtime, deps, ports } = makeRuntime();

    // 第一条建立 ack
    await send(runtime, deps, "总结一下这个视频");
    ports[0].listeners.message[0]({ type: "done", cachedContextKey: CONTEXT_KEY });

    // 第二条省略字幕体；模拟 offscreen 文档重启后槽缺失 → 错误回执
    await send(runtime, deps, "第二章讲了什么？");
    expect("subtitleBody" in getChatMessage(ports[1]).context).toBe(false);
    ports[1].listeners.message[0]({
      type: "error",
      error: "字幕体缺失，请重发一次",
      code: "subtitle-body-missing"
    });
    expect(ports[1].port.disconnect).toHaveBeenCalled(); // 错误收尾断开本条 port

    // 第三条：lastAcked 已重置 → 重新携带全文（第二条本身不自动重发）
    await send(runtime, deps, "再试一次");
    const third = getChatMessage(ports[2]);
    expect(third.context.subtitleBody).toBe(SUBTITLE_BODY);
  });

  it("port 断连（offscreen 文档被回收）→ lastAcked 重置，下一条重新携带全文", async () => {
    seedVideoContext();
    const { runtime, deps, ports } = makeRuntime();

    await send(runtime, deps, "总结一下这个视频");
    ports[0].listeners.message[0]({ type: "token", data: "部分输出", cachedContextKey: CONTEXT_KEY });

    // offscreen 文档死亡 → SP 侧 port onDisconnect 触发
    ports[0].listeners.disconnect[0]();

    await send(runtime, deps, "继续");
    const second = getChatMessage(ports[1]);
    expect(second.contextKey).toBe(CONTEXT_KEY);
    expect(second.context.subtitleBody).toBe(SUBTITLE_BODY);
  });

  it("普通错误（非字幕体缺失）不重置 lastAcked：确认过缓存仍可省略", async () => {
    seedVideoContext();
    const { runtime, deps, ports } = makeRuntime();

    await send(runtime, deps, "总结一下这个视频");
    ports[0].listeners.message[0]({ type: "error", error: "网络错误", cachedContextKey: CONTEXT_KEY });

    await send(runtime, deps, "继续");
    expect("subtitleBody" in getChatMessage(ports[1]).context).toBe(false);
  });
});

describe("无字幕体上下文的兜底行为", () => {
  it("contextData 无 subtitleBody 字段时照常发送（省略条件不满足）", async () => {
    chatSessionState.contextData = { title: "无字幕页面", isVideoContext: false };
    chatSessionState.currentContextKey = "url:https://www.bilibili.com/";
    const { runtime, deps, ports } = makeRuntime();

    await send(runtime, deps, "随便聊聊");

    const msg = getChatMessage(ports[0]);
    expect(msg.contextKey).toBe("url:https://www.bilibili.com/");
    expect(msg.context.subtitleBody).toBeUndefined();
  });
});
