// 流式中删除/清空当前会话导致会话"复活"bug 的回归测试。
//
// bug：流式进行中 deleteById（当前会话）/ clearAll / restoreLatest 无匹配分支
// 只清 chatHistory/currentConversationId/currentConversationMeta，不碰
// chatRuntime——流结束后 finalizeAssistant 把在途一问一答 push 进刚清空的
// chatHistory 并 persistCurrent，凭空复活出一个会话。
//
// 两层防线各自覆盖：
//   1. store 三个 reset 路径 × 流式中/非流式中：注入 stopActiveChat 回调 dep
//      （由 sidepanel 组装为 chatRuntime.resetStreamState + 清消息区；测试里用
//      假回调模拟"同步断流、清在途一问一答"），验证停流调用与状态清空；
//   2. chat-runtime finalize/stopped 的会话身份校验（竞态兜底）：发送时捕获
//      currentConversationId，流结束时 id 已变/已删 → 只渲染 DOM，不 push 不
//      persist。用真 createChatRuntime + mock deps 验证。
//
// 模块纪元注意：sidepanel-state 是模块级单例，beforeEach 里 resetModules 后与
// 被测模块同纪元导入，并手动重置全部字段。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";

let createConversationStore;
let createChatRuntime;
let sidepanelState;

const URL_A = "https://www.bilibili.com/video/BV1abc";

function makeConversation(id, { contextKey = "", url = URL_A, messages } = {}) {
  return {
    id,
    title: `对话${id}`,
    contextKey,
    contextTitle: "视频A",
    contextUrl: url,
    isVideoContext: true,
    createdAt: 1000,
    updatedAt: 1000,
    contextRef: { bvid: "BV1abc", cid: "1", url },
    messages: messages || [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ]
  };
}

function makeStorage() {
  const data = new Map();
  return {
    get: vi.fn(async (keys) =>
      Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)]))
    ),
    set: vi.fn(async (obj) => {
      for (const [k, v] of Object.entries(obj)) {
        data.set(k, v);
      }
    })
  };
}

function makeUiStubs() {
  return {
    renderHistoryList: vi.fn(),
    renderInitialState: vi.fn(),
    updateContextChip: vi.fn(),
    showConversationContextNotice: vi.fn(),
    showConversationContextError: vi.fn(),
    removeConversationContextNotice: vi.fn(),
    hideHistoryPopover: vi.fn(),
    loadContextState: vi.fn(async () => true),
    resolveAiSidepanelContext: vi.fn(async () => ({})),
    resolveAiSidepanelPageRef: vi.fn(async () => ({}))
  };
}

// 组装 store + 假"在途流"闭包。stopActiveChat 模拟 chatRuntime.resetStreamState
// 的关键语义：同步断流、清在途一问一答。simulateStreamEnd 模拟真实
// finalizeAssistant 的持久化段（身份一致且在途 → push + persistCurrent）。
function makeStreamHarness(storeDepsOverrides = {}) {
  const stream = { active: false, userPrompt: "", raw: "", capturedId: "" };
  const stopCalls = [];
  const persistCalls = [];
  const storage = makeStorage();
  const ui = makeUiStubs();
  const store = createConversationStore({
    ...ui,
    stopActiveChat: vi.fn(() => {
      stopCalls.push(true);
      stream.active = false;
      stream.userPrompt = "";
    }),
    storage,
    ...storeDepsOverrides
  });

  function startStream(userPrompt, raw = "回答中") {
    stream.active = true;
    stream.userPrompt = userPrompt;
    stream.raw = raw;
    stream.capturedId = sidepanelState.currentConversationId;
  }

  async function simulateStreamEnd() {
    if (!stream.active || !stream.userPrompt) {
      return;
    }
    if (sidepanelState.currentConversationId === stream.capturedId) {
      sidepanelState.chatHistory.push({ role: "user", content: stream.userPrompt });
      sidepanelState.chatHistory.push({ role: "assistant", content: stream.raw });
      await store.persistCurrent();
      persistCalls.push(true);
    }
  }

  return { store, ui, storage, stream, stopCalls, persistCalls, startStream, simulateStreamEnd };
}

function resetStateFields() {
  sidepanelState.savedConversations = [];
  sidepanelState.currentConversationId = "";
  sidepanelState.currentConversationMeta = null;
  sidepanelState.chatHistory = [];
  sidepanelState.contextData = null;
  sidepanelState.currentContextKey = "";
  sidepanelState.liveContextData = null;
  sidepanelState.liveContextKey = "";
  sidepanelState.liveTabUrl = "";
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  // 同一模块纪元内新鲜导入（先 resetModules 再 import，被测模块与 state 同图解析）
  ({ createConversationStore } = await import("../../extension/chat/conversation-store.js"));
  ({ createChatRuntime } = await import("../../extension/chat/chat-runtime.js"));
  ({ sidepanelState } = await import("../../extension/chat/chat-state.js"));
  resetStateFields();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// ===========================================================================
// 防线一：store 三个 reset 路径 × 流式中/非流式中
// ===========================================================================
describe("conversation-store reset 路径在流式中的停流", () => {
  it("deleteById 当前会话（流式中）：先同步停流，状态清空，流结束不复活", async () => {
    const h = makeStreamHarness();
    sidepanelState.savedConversations = [makeConversation("c1")];
    h.store.applyById("c1");
    expect(sidepanelState.currentConversationId).toBe("c1");
    h.startStream("在途问题");

    await h.store.deleteById("c1");

    expect(h.stopCalls.length).toBe(1);
    expect(h.stream.active).toBe(false);
    expect(h.stream.userPrompt).toBe("");
    expect(sidepanelState.currentConversationId).toBe("");
    expect(sidepanelState.currentConversationMeta).toBeNull();
    expect(sidepanelState.chatHistory).toEqual([]);
    expect(sidepanelState.savedConversations).toEqual([]);

    // 流结束回调（在途问答已被停流清掉）→ 不 push 不 persist
    await h.simulateStreamEnd();
    expect(h.persistCalls.length).toBe(0);
    expect(sidepanelState.chatHistory).toEqual([]);
    expect(sidepanelState.savedConversations).toEqual([]);
  });

  it("deleteById 当前会话（非流式中）：回调幂等空操作，状态照常清空", async () => {
    const h = makeStreamHarness();
    sidepanelState.savedConversations = [makeConversation("c1")];
    h.store.applyById("c1");

    await h.store.deleteById("c1");

    expect(h.stopCalls.length).toBe(1);
    expect(sidepanelState.currentConversationId).toBe("");
    expect(sidepanelState.chatHistory).toEqual([]);
  });

  it("deleteById 非当前会话（流式中）：不停流，原流式行为保留", async () => {
    const h = makeStreamHarness();
    sidepanelState.savedConversations = [makeConversation("c1"), makeConversation("c2")];
    h.store.applyById("c1");
    h.startStream("在途问题");

    await h.store.deleteById("c2");

    expect(h.stopCalls.length).toBe(0);
    expect(sidepanelState.currentConversationId).toBe("c1");
    await h.simulateStreamEnd();
    expect(h.persistCalls.length).toBe(1);
    // 2 条回放 + 2 条在途写回
    expect(sidepanelState.chatHistory.length).toBe(4);
  });

  it("clearAll（流式中）：先同步停流再清空，流结束不复活", async () => {
    const h = makeStreamHarness();
    sidepanelState.savedConversations = [makeConversation("c1")];
    h.store.applyById("c1");
    h.startStream("在途问题");
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await h.store.clearAll();

    expect(h.stopCalls.length).toBe(1);
    expect(h.stream.active).toBe(false);
    expect(sidepanelState.currentConversationId).toBe("");
    expect(sidepanelState.currentConversationMeta).toBeNull();
    expect(sidepanelState.chatHistory).toEqual([]);

    await h.simulateStreamEnd();
    expect(h.persistCalls.length).toBe(0);
    expect(sidepanelState.savedConversations).toEqual([]);
  });

  it("clearAll（非流式中）：回调幂等空操作，状态照常清空", async () => {
    const h = makeStreamHarness();
    sidepanelState.savedConversations = [makeConversation("c1")];
    h.store.applyById("c1");
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await h.store.clearAll();

    expect(h.stopCalls.length).toBe(1);
    expect(sidepanelState.currentConversationId).toBe("");
    expect(sidepanelState.savedConversations).toEqual([]);
  });

  it("clearAll 无会话时早退：不停流（confirm 也不弹）", async () => {
    const h = makeStreamHarness();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    await h.store.clearAll();

    expect(h.stopCalls.length).toBe(0);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("restoreLatest 无匹配（非流式中）：停流回调幂等，当前会话状态清空", async () => {
    const h = makeStreamHarness();
    // 当前会话绑定另一个视频，上下文状态为空 → 与当前上下文无匹配
    sidepanelState.savedConversations = [makeConversation("c1", { url: "https://www.bilibili.com/video/BVother" })];
    sidepanelState.currentConversationId = "c1";
    sidepanelState.currentConversationMeta = { id: "c1", pinnedContext: true, contextKey: "" };
    sidepanelState.chatHistory = [makeConversation("c1").messages];

    const result = await h.store.restoreLatest();

    expect(result).toBe(false);
    expect(h.stopCalls.length).toBe(1);
    expect(sidepanelState.currentConversationId).toBe("");
    expect(sidepanelState.currentConversationMeta).toBeNull();
    expect(sidepanelState.chatHistory).toEqual([]);
  });

  it("restoreLatest 无匹配（防御性流式中）：同样先停流，流结束不复活", async () => {
    const h = makeStreamHarness();
    sidepanelState.savedConversations = [makeConversation("c1", { url: "https://www.bilibili.com/video/BVother" })];
    sidepanelState.currentConversationId = "c1";
    sidepanelState.currentConversationMeta = { id: "c1", pinnedContext: true, contextKey: "" };
    sidepanelState.chatHistory = [makeConversation("c1").messages];
    h.startStream("在途问题");

    const result = await h.store.restoreLatest();

    expect(result).toBe(false);
    expect(h.stopCalls.length).toBe(1);
    expect(h.stream.active).toBe(false);
    await h.simulateStreamEnd();
    expect(h.persistCalls.length).toBe(0);
    expect(sidepanelState.chatHistory).toEqual([]);
  });

  it("restoreLatest 有匹配：照常 apply，不停流", async () => {
    const h = makeStreamHarness();
    sidepanelState.savedConversations = [makeConversation("c1")];
    sidepanelState.liveContextData = { bvid: "BV1abc", url: URL_A, isVideoContext: true };

    const result = await h.store.restoreLatest();

    expect(result).toBe(true);
    expect(h.stopCalls.length).toBe(0);
    expect(sidepanelState.currentConversationId).toBe("c1");
    expect(sidepanelState.chatHistory.length).toBe(2);
  });
});

// ===========================================================================
// 会话身份守卫的单一判定点：store.isCurrent(id)
// ===========================================================================
describe("store.isCurrent 会话身份守卫", () => {
  it("当前会话命中：id 与 currentConversationId 相等 → true", async () => {
    const { store } = makeStreamHarness();
    sidepanelState.currentConversationId = "c1";

    expect(store.isCurrent("c1")).toBe(true);
  });

  it("非当前：id 不等（切换/恢复了另一会话）或当前已删（空串）→ false", async () => {
    const { store } = makeStreamHarness();
    sidepanelState.currentConversationId = "c1";

    expect(store.isCurrent("c2")).toBe(false);

    // 流式中当前会话被删：currentConversationId 已清空，旧快照不再命中
    sidepanelState.currentConversationId = "";
    expect(store.isCurrent("c1")).toBe(false);
  });

  it("空 id：仅当当前 id 同为空串（新会话首发）→ true，否则 false", async () => {
    const { store } = makeStreamHarness();

    // 新会话首发：快照与当前 id 均为空串 → 照常写回并 persist（与旧内联比对等价）
    sidepanelState.currentConversationId = "";
    expect(store.isCurrent("")).toBe(true);

    // 当前已有会话 → 空快照不命中（流式中恢复/新建了会话）
    sidepanelState.currentConversationId = "c1";
    expect(store.isCurrent("")).toBe(false);
  });
});

// ===========================================================================
// 防线二：chat-runtime finalize/stopped 的会话身份校验（竞态兜底）
// ===========================================================================
describe("chat-runtime 流结束的会话身份校验", () => {
  // 真 createChatRuntime + mock deps；"删除当前会话"直接改 sidepanelState
  // （不经 store 停流回调），模拟"停流回调生效前流已结束"的竞态窗口。
  function makeSendHarness() {
    const messages = document.createElement("div");
    const input = document.createElement("textarea");
    const listeners = [];
    const port = {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onDisconnect: { addListener: () => {} },
      postMessage: vi.fn(),
      disconnect: vi.fn()
    };
    const deps = {
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
      connectPort: vi.fn(async () => port)
    };
    input.value = "在途问题";
    const runtime = createChatRuntime(deps);
    return { deps, runtime, emit: (msg) => listeners[0](msg) };
  }

  it("finalize：发送后当前会话已删（id 已变）→ 只渲染 DOM，不 push 不 persist", async () => {
    sidepanelState.currentConversationId = "c1";
    sidepanelState.currentConversationMeta = { id: "c1", pinnedContext: true, contextKey: "k1" };
    sidepanelState.contextData = { bvid: "BV1abc", url: URL_A, title: "视频A" };
    const { deps, runtime, emit } = makeSendHarness();

    await runtime.sendMessage();
    expect(deps.connectPort).toHaveBeenCalledTimes(1);

    // 流式中当前会话被删（状态被清、流回调尚未生效的竞态窗口）
    sidepanelState.currentConversationId = "";
    sidepanelState.currentConversationMeta = null;

    emit({ type: "token", data: "回答" });
    emit({ type: "done" });

    expect(deps.store.persistCurrent).not.toHaveBeenCalled();
    expect(sidepanelState.chatHistory).toEqual([]);
    // DOM 仍更新为最终回答（只渲染、不落库）
    const node = deps.messages.querySelector(".sp-msg-assistant");
    expect(node?.querySelector(".sp-msg-assistant-body")).toBeTruthy();
  });

  it("stopped：发送后当前会话已删 → 同样不 push 不 persist", async () => {
    sidepanelState.currentConversationId = "c1";
    sidepanelState.currentConversationMeta = { id: "c1", pinnedContext: true, contextKey: "k1" };
    sidepanelState.contextData = { bvid: "BV1abc", url: URL_A, title: "视频A" };
    const { deps, runtime, emit } = makeSendHarness();

    await runtime.sendMessage();
    sidepanelState.currentConversationId = "";
    sidepanelState.currentConversationMeta = null;

    emit({ type: "token", data: "半截回答" });
    emit({ type: "stopped", reason: "已停止生成" });

    expect(deps.store.persistCurrent).not.toHaveBeenCalled();
    expect(sidepanelState.chatHistory).toEqual([]);
  });

  it("身份未变（新会话发送，id 均为空串）→ 照常写回并 persist（回归保护）", async () => {
    sidepanelState.contextData = { bvid: "BV1abc", url: URL_A, title: "视频A" };
    const { deps, runtime, emit } = makeSendHarness();

    await runtime.sendMessage();
    emit({ type: "token", data: "回答" });
    emit({ type: "done" });

    expect(deps.store.persistCurrent).toHaveBeenCalledTimes(1);
    expect(sidepanelState.chatHistory.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(sidepanelState.chatHistory[1].content).toBe("回答");
  });

  it("流式中切换到另一会话（applyById 改 id）→ finalize 不把回答串进新会话", async () => {
    sidepanelState.currentConversationId = "c1";
    sidepanelState.currentConversationMeta = { id: "c1", pinnedContext: true, contextKey: "k1" };
    sidepanelState.contextData = { bvid: "BV1abc", url: URL_A, title: "视频A" };
    const { deps, runtime, emit } = makeSendHarness();

    await runtime.sendMessage();

    // 用户在流式中从历史列表打开了另一会话
    sidepanelState.currentConversationId = "c2";
    sidepanelState.chatHistory = makeConversation("c2").messages;

    emit({ type: "token", data: "回答" });
    emit({ type: "done" });

    expect(deps.store.persistCurrent).not.toHaveBeenCalled();
    // chatHistory 保持 c2 的回放内容，未被串入在途问答
    expect(sidepanelState.chatHistory).toEqual(makeConversation("c2").messages);
  });
});
