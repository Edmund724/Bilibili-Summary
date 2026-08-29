// offscreen.js 聊天通道的字幕体单槽缓存接线测试（候选5）：
// - 自带 subtitleBody 的 chat 消息 → 槽登记，下游 ladder 收到完整 context，
//   所有回执统一附带 cachedContextKey（SP 据此推进 lastAckedContextKey）；
// - 未携带 + 槽 key 匹配 → ladder 收到的 msg.context.subtitleBody 已补齐；
// - 未携带 + key 不匹配 / 文档重启（模块重载 = 新空槽）→ 回
//   { type:"error", code:"subtitle-body-missing" } 且不带 cachedContextKey
//   （SP 侧据此重置 lastAcked）。
//
// offscreen.js 顶层挂 chrome 事件监听，直接静态导入会踩空 chrome —— 沿仓库
// 惯例重依赖 mock（ladder / offscreen-asr），chrome.runtime.onConnect 用
// stub 捕获监听器后驱动假端口；vi.resetModules + 动态导入实现「文档重启」。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { runLadderChatMock } = vi.hoisted(() => ({ runLadderChatMock: vi.fn() }));

vi.mock("../../extension/ai/ladder.js", () => ({
  runLadderChat: runLadderChatMock
}));
vi.mock("../../extension/entry/offscreen-asr.js", () => ({
  createAsrDecodeHandler: vi.fn(() => vi.fn(async () => {}))
}));

const CONTEXT_KEY = "video:BV1body|101";
const BODY = [{ from: 0, to: 5, content: "第一句" }];

let onConnectListeners = [];

// 提供能通过 resolveProviderWithKey 的 provider/key 响应
function stubChromeRuntime() {
  vi.stubGlobal("chrome", {
    runtime: {
      onConnect: {
        addListener: (fn) => onConnectListeners.push(fn)
      },
      sendMessage: vi.fn(async (message) => {
        if (message?.type === "ai-providers-list") {
          return {
            providers: [{ id: "p1", name: "测试平台", model: "m1", enabled: true, requiresKey: false }]
          };
        }
        if (message?.type === "get-ai-provider-key") {
          return { ok: true, apiKey: "test-key" };
        }
        return { ok: true };
      })
    },
    offscreen: {
      closeDocument: vi.fn(async () => {})
    }
  });
}

// 每次导入 = 一个 offscreen 文档纪元（模块级单槽随之重置），重启语义由此模拟
async function importOffscreen() {
  vi.resetModules();
  onConnectListeners = [];
  stubChromeRuntime();
  return import("../../extension/entry/offscreen.js");
}

function makeChatPort() {
  const listeners = { message: [], disconnect: [] };
  return {
    port: {
      name: "offscreen-chat",
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
      postMessage: vi.fn(),
      disconnect: vi.fn()
    },
    listeners
  };
}

// 连上当前纪元的 offscreen 并返回驱动入口
function connectChat() {
  expect(onConnectListeners).toHaveLength(1);
  const session = makeChatPort();
  onConnectListeners[0](session.port);
  return {
    port: session.port,
    send: (msg) => session.listeners.message[0](msg),
    flush: () => vi.waitFor(() => expect(session.port.postMessage).toHaveBeenCalled())
  };
}

beforeEach(() => {
  runLadderChatMock.mockReset();
});

describe("offscreen 聊天字幕体单槽缓存接线", () => {
  it("自带字幕体的消息 → 槽登记，回执统一附带 cachedContextKey", async () => {
    runLadderChatMock.mockImplementation(async ({ port }) => {
      port.postMessage({ type: "token", data: "x" });
      port.postMessage({ type: "done" });
    });
    await importOffscreen();
    const session = connectChat();

    session.send({
      action: "chat",
      providerId: "p1",
      contextKey: CONTEXT_KEY,
      context: { title: "长视频", subtitleBody: BODY },
      prompt: "总结"
    });
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(1));

    // ladder 收到的就是消息原样（全量路径不改写）
    const ladderMsg = runLadderChatMock.mock.calls[0][0].msg;
    expect(ladderMsg.context.subtitleBody).toBe(BODY);
    expect(ladderMsg.contextKey).toBe(CONTEXT_KEY);

    // 每条回执都带 cachedContextKey（wrapper 注入）
    for (const call of session.port.postMessage.mock.calls) {
      expect(call[0].cachedContextKey).toBe(CONTEXT_KEY);
    }
  });

  it("未携带 + 槽 key 匹配 → 从槽补齐给 ladder，追问不再需要重传", async () => {
    runLadderChatMock.mockImplementation(async ({ port }) => {
      port.postMessage({ type: "done" });
    });
    await importOffscreen();
    const session = connectChat();

    session.send({ action: "chat", providerId: "p1", contextKey: CONTEXT_KEY, context: { title: "长视频", subtitleBody: BODY } });
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(1));

    session.send({ action: "chat", providerId: "p1", contextKey: CONTEXT_KEY, context: { title: "长视频" } });
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(2));

    const followupMsg = runLadderChatMock.mock.calls[1][0].msg;
    expect(followupMsg.context.subtitleBody).toBe(BODY);
  });

  it("未携带 + 槽 key 不匹配 → 字幕体缺失错误（不带 cachedContextKey），ladder 不再调", async () => {
    runLadderChatMock.mockImplementation(async ({ port }) => {
      port.postMessage({ type: "done" });
    });
    await importOffscreen();
    const session = connectChat();

    session.send({ action: "chat", providerId: "p1", contextKey: CONTEXT_KEY, context: { title: "长视频", subtitleBody: BODY } });
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(1));

    session.send({ action: "chat", providerId: "p1", contextKey: "video:BV2|202", context: { title: "另一个视频" } });
    await vi.waitFor(() => expect(session.port.postMessage).toHaveBeenCalledTimes(2));

    expect(runLadderChatMock).toHaveBeenCalledTimes(1);
    expect(session.port.postMessage).toHaveBeenLastCalledWith({
      type: "error",
      error: "字幕体缺失，请重发一次",
      code: "subtitle-body-missing"
    });
  });

  it("offscreen 文档重启（模块重载）后槽为空 → 未携带消息回缺失错误", async () => {
    runLadderChatMock.mockImplementation(async ({ port }) => {
      port.postMessage({ type: "done" });
    });
    // 第一个文档纪元：登记槽
    await importOffscreen();
    const first = connectChat();
    first.send({ action: "chat", providerId: "p1", contextKey: CONTEXT_KEY, context: { title: "长视频", subtitleBody: BODY } });
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(1));

    // 文档被回收后重建：新纪元 = 新空槽，SP 侧 lastAcked 仍指向旧 key
    await importOffscreen();
    const second = connectChat();
    second.send({ action: "chat", providerId: "p1", contextKey: CONTEXT_KEY, context: { title: "长视频" } });
    await vi.waitFor(() => expect(second.port.postMessage).toHaveBeenCalledTimes(1));

    expect(runLadderChatMock).toHaveBeenCalledTimes(1);
    expect(second.port.postMessage).toHaveBeenCalledWith({
      type: "error",
      error: "字幕体缺失，请重发一次",
      code: "subtitle-body-missing"
    });
  });
});
