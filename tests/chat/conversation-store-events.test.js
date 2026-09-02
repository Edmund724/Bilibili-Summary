// tests/chat/conversation-store-events.test.js
// 工单 05:conversation-store 渲染回调反转为能力事件后的编排时序锁定。
//
// 原 14 键 deps 里 9 个 caller 必学的渲染/行为回调(renderHistoryList /
// renderInitialState / updateContextChip / show·removeConversationContextNotice /
// showConversationContextError / hideHistoryPopover / loadContextState /
// stopActiveChat)收窄为 3 个能力事件——store 自己编排渲染时机,caller 只订阅结果:
//   - onConversationChanged(change)  会话相关状态已落账;历史列表恒随事件重渲,
//     change 标志驱动 chip 刷新(refreshContextChip)/ popover 收起(historyCleared)
//     / 会话视图重建(resetView);
//   - onStreamInterrupted()          当前会话被拆除(删当前会话/清空全部/恢复无
//     匹配),流式必须同步打断(原 stopActiveChat dep);
//   - onContextNotice(notice)        上下文补水提示生命周期(pending/clear/error)。
//
// 本文件逐操作锁定事件序列与 detail 形状,与反转前 caller 编排逐一对齐:
//   - loadAll:            change({})                     —— 不触 chip(无上下文写入)
//   - hydratePages 变更:  change({refreshContextChip}) → change({})
//   - persistCurrent:     change({})                     —— 不触 chip
//   - restoreLatest 匹配: change({refreshContextChip})   —— 无断流
//   - restoreLatest 无匹: onStreamInterrupted 恰一次;change/notice 零次
//     (原编排即不重渲列表/chip/视图,保持现状)
//   - applyById:          change({refreshContextChip, resetView}) → notice pending
//   - deleteById 当前会话:onStreamInterrupted 同步先于一切 change(断流先于落盘,
//     会话复活回归防线);尾次 change = {refreshContextChip, resetView}
//   - deleteById 非当前:  change({})                     —— 无断流
//   - clearAll:           onStreamInterrupted → change({refreshContextChip,
//     historyCleared, resetView})
//   - hydratePinned 成功: change({refreshContextChip}) → notice clear
//   - hydratePinned 失败: notice clear → notice error(非 silent;silent 不展示)
//
// 同时锁定解析单接缝的 purpose 分途:hydratePages 用 "page",hydratePinned 用
// "context"(组合根在该用途接工单 04 的进程内短路复合适配器)。
//
// 模块纪元注意:chatSessionState 是模块级单例,beforeEach resetModules 后与被测
// 模块同纪元导入并手动重置字段。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let createConversationStore;
let chatSessionState;

const URL_A = "https://www.bilibili.com/video/BV1abc";

function makeConversation(id, { contextKey = "", url = URL_A, pageIndex } = {}) {
  return {
    id,
    title: `对话${id}`,
    contextKey,
    contextTitle: "视频A",
    contextUrl: url,
    isVideoContext: true,
    createdAt: 1000,
    updatedAt: 1000,
    contextRef: { bvid: "BV1abc", cid: pageIndex ? String(pageIndex) : "1", url, pageIndex },
    messages: [
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

function makeHarness(storeDepsOverrides = {}) {
  const storage = makeStorage();
  const deps = {
    loadContextState: vi.fn(async () => true),
    resolveAiConversationRef: vi.fn(async () => ({})),
    onConversationChanged: vi.fn(),
    onStreamInterrupted: vi.fn(),
    onContextNotice: vi.fn(),
    storage,
    ...storeDepsOverrides
  };
  const store = createConversationStore(deps);
  return { store, deps, storage };
}

// 事件时序记录器:change / interrupt / notice 按发生顺序入 log,供顺序断言。
function makeOrderLog(deps) {
  const log = [];
  deps.onConversationChanged.mockImplementation((change) => log.push(["change", change]));
  deps.onStreamInterrupted.mockImplementation(() => log.push(["interrupt"]));
  deps.onContextNotice.mockImplementation((notice) => log.push(["notice", notice]));
  return log;
}

function makePinnedMeta(overrides = {}) {
  return {
    id: "conv-1",
    title: "视频A",
    createdAt: 1,
    updatedAt: 1,
    contextKey: "k-1",
    contextTitle: "视频A",
    contextUrl: URL_A,
    isVideoContext: true,
    pinnedContext: true,
    contextRef: { bvid: "BV1abc", cid: "1", url: URL_A },
    resolvedContext: null,
    ...overrides
  };
}

function resetStateFields() {
  chatSessionState.savedConversations = [];
  chatSessionState.currentConversationId = "";
  chatSessionState.currentConversationMeta = null;
  chatSessionState.chatHistory = [];
  chatSessionState.contextData = null;
  chatSessionState.currentContextKey = "";
  chatSessionState.liveContextData = null;
  chatSessionState.liveContextKey = "";
  chatSessionState.liveTabUrl = "";
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  ({ createConversationStore } = await import("../../extension/chat/conversation-store.js"));
  ({ chatSessionState } = await import("../../extension/chat/chat-state.js"));
  resetStateFields();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// ===========================================================================
// loadAll / hydratePages / persistCurrent:历史列表面的 change 时序
// ===========================================================================
describe("loadAll / hydratePages / persistCurrent 的 change 时序", () => {
  it("loadAll:change 恰一次且 detail 为空(不触 chip——无上下文写入)", async () => {
    const { store, deps } = makeHarness();
    const log = makeOrderLog(deps);
    chatSessionState.savedConversations = [makeConversation("c1")];

    await store.loadAll();

    expect(deps.onConversationChanged).toHaveBeenCalledTimes(1);
    expect(deps.onConversationChanged).toHaveBeenCalledWith({});
    expect(log).toEqual([["change", {}]]);
    // 无分页补水候选:hydratePages 不追加事件
  });

  it("hydratePages 分页补水变更:change 序列 = [{refreshContextChip}, {}],pageRef 解析走 purpose=page", async () => {
    const { store, deps, storage } = makeHarness({
      resolveAiConversationRef: vi.fn(async (ref, purpose) => {
        expect(purpose).toBe("page");
        return { pageIndex: 2, url: `${URL_A}?p=2`, cid: "2", pageTitle: "第二P" };
      })
    });
    const log = makeOrderLog(deps);
    // loadAll 以 storage 为真值源覆盖内存镜像:存档经 storage 播种
    await storage.set({ boc_ai_conversations_v1: [makeConversation("c1")] });

    await store.loadAll();
    // loadAll 的 change({}) 先落;hydratePages 异步补水后追加 {chip} 与 save 的 {}
    await vi.waitFor(() => expect(deps.onConversationChanged.mock.calls.length).toBeGreaterThanOrEqual(3));

    expect(deps.onConversationChanged).toHaveBeenNthCalledWith(2, { refreshContextChip: true });
    expect(deps.onConversationChanged).toHaveBeenNthCalledWith(3, {});
    expect(log.map(([kind]) => kind)).toEqual(["change", "change", "change"]);
  });

  it("persistCurrent:change 恰一次且 detail 为空(不触 chip——元信息重写不改上下文绑定呈现)", async () => {
    const { store, deps } = makeHarness();
    makeOrderLog(deps);
    chatSessionState.contextData = { bvid: "BV1abc", url: URL_A, title: "视频A", isVideoContext: true };
    chatSessionState.currentContextKey = "k-1";
    chatSessionState.chatHistory = [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" }
    ];

    await store.persistCurrent();

    expect(deps.onConversationChanged).toHaveBeenCalledTimes(1);
    expect(deps.onConversationChanged).toHaveBeenCalledWith({});
    expect(deps.onStreamInterrupted).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// restoreLatest / applyById:恢复与应用面
// ===========================================================================
describe("restoreLatest / applyById 的 change 时序", () => {
  it("restoreLatest 有匹配:change 恰一次 {refreshContextChip},无断流", async () => {
    const { store, deps } = makeHarness();
    makeOrderLog(deps);
    chatSessionState.savedConversations = [makeConversation("c1")];
    chatSessionState.liveContextData = { bvid: "BV1abc", url: URL_A, isVideoContext: true };
    chatSessionState.liveContextKey = "k-1";

    const result = await store.restoreLatest();

    expect(result).toBe(true);
    expect(deps.onConversationChanged).toHaveBeenCalledTimes(1);
    expect(deps.onConversationChanged).toHaveBeenCalledWith({ refreshContextChip: true });
    expect(deps.onStreamInterrupted).not.toHaveBeenCalled();
  });

  it("restoreLatest 无匹配:恰一次断流,change/notice 零次(原编排不重渲任何面)", async () => {
    const { store, deps } = makeHarness();
    const log = makeOrderLog(deps);
    chatSessionState.savedConversations = [makeConversation("c1", { url: "https://www.bilibili.com/video/BVother" })];
    chatSessionState.currentConversationId = "c1";

    const result = await store.restoreLatest();

    expect(result).toBe(false);
    expect(deps.onStreamInterrupted).toHaveBeenCalledTimes(1);
    expect(deps.onConversationChanged).not.toHaveBeenCalled();
    expect(deps.onContextNotice).not.toHaveBeenCalled();
    expect(log).toEqual([["interrupt"]]);
    expect(chatSessionState.currentConversationId).toBe("");
    expect(chatSessionState.chatHistory).toEqual([]);
  });

  it("applyById(上下文键与 live 不一致):change = {refreshContextChip, resetView} → notice pending,补水解析走 purpose=context", async () => {
    const { store, deps } = makeHarness({
      resolveAiConversationRef: vi.fn(async (ref, purpose) => {
        expect(purpose).toBe("context");
        return { bvid: "BV1abc", cid: "1", url: URL_A, title: "视频A", isVideoContext: true };
      })
    });
    const log = makeOrderLog(deps);
    chatSessionState.savedConversations = [makeConversation("c1", { contextKey: "k-other" })];

    store.applyById("c1");

    expect(deps.onConversationChanged).toHaveBeenCalledTimes(1);
    expect(deps.onConversationChanged).toHaveBeenCalledWith({ refreshContextChip: true, resetView: true });
    expect(deps.onContextNotice).toHaveBeenCalledWith({ kind: "pending", message: "正在加载原视频上下文..." });
    // 事件次序:change(视图重建)先于 pending 提示
    expect(log.map(([kind]) => kind)).toEqual(["change", "notice"]);
    // 静默补水异步落定后:change({refreshContextChip}) → notice clear
    await vi.waitFor(() => expect(deps.onContextNotice.mock.calls.length).toBe(2));
    expect(deps.onConversationChanged).toHaveBeenNthCalledWith(2, { refreshContextChip: true });
    expect(deps.onContextNotice).toHaveBeenLastCalledWith({ kind: "clear" });
    expect(deps.onStreamInterrupted).not.toHaveBeenCalled();
  });

  it("applyById(键与 live 一致):change = {refreshContextChip, resetView},不发 pending 也不补水", () => {
    const { store, deps } = makeHarness();
    chatSessionState.savedConversations = [makeConversation("c1", { contextKey: "k-1" })];
    chatSessionState.liveContextKey = "k-1";

    store.applyById("c1");

    expect(deps.onConversationChanged).toHaveBeenCalledTimes(1);
    expect(deps.onConversationChanged).toHaveBeenCalledWith({ refreshContextChip: true, resetView: true });
    expect(deps.onContextNotice).not.toHaveBeenCalled();
    expect(deps.resolveAiConversationRef).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// deleteById / clearAll:会话拆除面(断流时序是会话复活回归的承重墙)
// ===========================================================================
describe("deleteById / clearAll 的断流与 change 时序", () => {
  it("deleteById 当前会话:onStreamInterrupted 同步先于一切 change;尾次 change = {refreshContextChip, resetView}", async () => {
    const { store, deps } = makeHarness();
    const log = makeOrderLog(deps);
    chatSessionState.savedConversations = [makeConversation("c1")];
    chatSessionState.liveContextData = { bvid: "BV1abc", url: URL_A, isVideoContext: true };
    chatSessionState.liveContextKey = "k-1";
    store.applyById("c1");
    deps.onConversationChanged.mockClear();
    log.length = 0;

    await store.deleteById("c1");

    expect(deps.onStreamInterrupted).toHaveBeenCalledTimes(1);
    // 断流在先(同步),落盘后的 change 在后
    expect(log[0]).toEqual(["interrupt"]);
    expect(log[log.length - 1]).toEqual(["change", { refreshContextChip: true, resetView: true }]);
    expect(chatSessionState.currentConversationId).toBe("");
    expect(chatSessionState.currentConversationMeta).toBeNull();
    expect(chatSessionState.chatHistory).toEqual([]);
  });

  it("deleteById 非当前会话:无断流,change = {}(仅存档列表面)", async () => {
    const { store, deps } = makeHarness();
    makeOrderLog(deps);
    chatSessionState.savedConversations = [makeConversation("c1"), makeConversation("c2")];
    chatSessionState.currentConversationId = "c1";

    await store.deleteById("c2");

    expect(deps.onStreamInterrupted).not.toHaveBeenCalled();
    expect(deps.onConversationChanged).toHaveBeenCalledTimes(1);
    expect(deps.onConversationChanged).toHaveBeenCalledWith({});
    expect(chatSessionState.currentConversationId).toBe("c1");
  });

  it("clearAll:onStreamInterrupted 在先,尾次 change = {refreshContextChip, historyCleared, resetView}", async () => {
    const { store, deps } = makeHarness();
    const log = makeOrderLog(deps);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    chatSessionState.savedConversations = [makeConversation("c1")];
    chatSessionState.liveContextData = { bvid: "BV1abc", url: URL_A, isVideoContext: true };
    chatSessionState.liveContextKey = "k-1";
    store.applyById("c1");
    deps.onConversationChanged.mockClear();
    log.length = 0;

    await store.clearAll();

    expect(deps.onStreamInterrupted).toHaveBeenCalledTimes(1);
    expect(log[0]).toEqual(["interrupt"]);
    expect(log[log.length - 1]).toEqual([
      "change",
      { refreshContextChip: true, historyCleared: true, resetView: true }
    ]);
    expect(chatSessionState.savedConversations).toEqual([]);
  });

  it("clearAll 空档早退 / confirm 取消:零事件", async () => {
    const { store, deps } = makeHarness();
    makeOrderLog(deps);

    await store.clearAll();

    expect(deps.onConversationChanged).not.toHaveBeenCalled();
    expect(deps.onStreamInterrupted).not.toHaveBeenCalled();

    chatSessionState.savedConversations = [makeConversation("c1")];
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await store.clearAll();

    expect(deps.onConversationChanged).not.toHaveBeenCalled();
    expect(deps.onStreamInterrupted).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// hydratePinned:补水提示生命周期 + chip 时序
// ===========================================================================
describe("hydratePinned 的 change / notice 时序", () => {
  it("resolvedContext 缓存命中:change = {refreshContextChip} → notice clear,不走解析", async () => {
    const { store, deps } = makeHarness();
    const log = makeOrderLog(deps);
    chatSessionState.currentConversationMeta = makePinnedMeta({
      resolvedContext: { bvid: "BV1abc", url: URL_A, title: "视频A" }
    });

    const ok = await store.hydratePinned();

    expect(ok).toBe(true);
    expect(deps.resolveAiConversationRef).not.toHaveBeenCalled();
    expect(deps.loadContextState).not.toHaveBeenCalled();
    expect(log).toEqual([
      ["change", { refreshContextChip: true }],
      ["notice", { kind: "clear" }]
    ]);
  });

  it("contextKey 与 live 键一致(分支 2):先经 loadContextState 静默刷新 live,再 change {refreshContextChip} → notice clear", async () => {
    const { store, deps } = makeHarness();
    const log = makeOrderLog(deps);
    chatSessionState.currentConversationMeta = makePinnedMeta();
    chatSessionState.liveContextKey = "k-1";
    chatSessionState.contextData = { bvid: "BV1abc", url: URL_A, title: "视频A" };

    const ok = await store.hydratePinned();

    expect(ok).toBe(true);
    expect(deps.loadContextState).toHaveBeenCalledWith({ forceRefresh: false, silent: true });
    expect(deps.resolveAiConversationRef).not.toHaveBeenCalled();
    expect(log).toEqual([
      ["change", { refreshContextChip: true }],
      ["notice", { kind: "clear" }]
    ]);
  });

  it("网络补水成功:change = {refreshContextChip} → notice clear(次序与反转前 chip→撤提示一致)", async () => {
    const { store, deps } = makeHarness({
      resolveAiConversationRef: vi.fn(async () => ({ bvid: "BV1abc", url: URL_A, title: "视频A" }))
    });
    const log = makeOrderLog(deps);
    chatSessionState.currentConversationMeta = makePinnedMeta();

    const ok = await store.hydratePinned();

    expect(ok).toBe(true);
    expect(deps.resolveAiConversationRef).toHaveBeenCalledTimes(1);
    expect(log).toEqual([
      ["change", { refreshContextChip: true }],
      ["notice", { kind: "clear" }]
    ]);
  });

  it("网络补水失败:notice clear → notice error(非 silent);不触 change", async () => {
    const { store, deps } = makeHarness({
      resolveAiConversationRef: vi.fn(async () => {
        throw new Error("网络挂了");
      })
    });
    const log = makeOrderLog(deps);
    chatSessionState.currentConversationMeta = makePinnedMeta();

    const ok = await store.hydratePinned();

    expect(ok).toBe(false);
    expect(deps.onConversationChanged).not.toHaveBeenCalled();
    expect(log).toEqual([
      ["notice", { kind: "clear" }],
      ["notice", { kind: "error", message: "历史视频上下文获取失败：网络挂了" }]
    ]);
  });

  it("补水失败(silent):仅撤提示,不展示 error", async () => {
    const { store, deps } = makeHarness({
      resolveAiConversationRef: vi.fn(async () => {
        throw new Error("网络挂了");
      })
    });
    makeOrderLog(deps);
    chatSessionState.currentConversationMeta = makePinnedMeta();

    const ok = await store.hydratePinned({ silent: true });

    expect(ok).toBe(false);
    expect(deps.onContextNotice).toHaveBeenCalledTimes(1);
    expect(deps.onContextNotice).toHaveBeenCalledWith({ kind: "clear" });
  });

  it("缺少 contextRef:notice clear → notice error(非 silent),不走解析", async () => {
    const { store, deps } = makeHarness();
    const log = makeOrderLog(deps);
    chatSessionState.currentConversationMeta = makePinnedMeta({ contextRef: null });

    const ok = await store.hydratePinned();

    expect(ok).toBe(false);
    expect(deps.resolveAiConversationRef).not.toHaveBeenCalled();
    expect(log).toEqual([
      ["notice", { kind: "clear" }],
      ["notice", { kind: "error", message: "历史对话缺少原视频信息，无法继续。" }]
    ]);
  });
});
