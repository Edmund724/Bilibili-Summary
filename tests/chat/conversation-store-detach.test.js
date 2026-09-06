// tests/chat/conversation-store-detach.test.js
// 工单 arch-slim-2/07:「拆除会话」唯一事务(detachCurrent / repopulateLive)的
// 时序锁定与接口收窄断言。
//
// CONTEXT.md「拆除会话」词条:把「当前会话」从对话视图与存储中摘除的唯一事务
// = 断流通知先于任何 await 与落盘 → 清会话 id/meta/历史 → 需要时做 live 上下文
// 回填。四个出口(restoreLatest 无匹配 / deleteById 当前会话 / clearAll /
// detachForRestart 新会话重启)收口为同一组原语组合,本文件沿 conversation-store-
// events.test.js 的事件时序先例,参数化锁定承重不变式:
//   - 断流先于身份清空(流式身份守卫在 id 清空前依赖同步断流,防会话复活)
//   - 断流先于落盘(先于一切 storage.set / await)
//   - 各出口的 live 回填与 change 面逐字保持(行为零变化,与 events 测试互补)
//
// 接口收窄 11→8:apply / resolveContext / hydratePages 三键摘除(实现保留为
// 工厂内私有函数,内部调用点零变化);另含工单 D 授权的公开窄方法 detachForRestart,
// 终面 = 收窄 8 键 + 1。
//
// 模块纪元注意:chatSessionState 是模块级单例,beforeEach resetModules 后与被测
// 模块同纪元导入并手动重置字段(与 events 测试同款)。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let createConversationStore;
let chatSessionState;

const URL_A = "https://www.bilibili.com/video/BV1abc";

function makeConversation(id, { contextKey = "", url = URL_A } = {}) {
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
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ]
  };
}

function makeStorage() {
  const data = new Map();
  return {
    data,
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

// 统一事件时序记录器:change / interrupt / notice / persist 按发生顺序入 log;
// interruptedWith 在断流通知发起「瞬间」捕获会话身份与存档面——用于证明
// 「断流先于身份清空」与各出口 detach 前的内存次序(commitSaved 位置)。
function makeOrderLog(deps, storage) {
  const log = [];
  const interruptedWith = [];
  deps.onConversationChanged.mockImplementation((change) => log.push(["change", change]));
  deps.onStreamInterrupted.mockImplementation(() => {
    interruptedWith.push({
      id: chatSessionState.currentConversationId,
      meta: chatSessionState.currentConversationMeta,
      history: chatSessionState.chatHistory,
      savedCount: chatSessionState.savedConversations.length
    });
    log.push(["interrupt"]);
  });
  deps.onContextNotice.mockImplementation((notice) => log.push(["notice", notice]));
  storage.set.mockImplementation(async (obj) => {
    log.push(["persist", Object.keys(obj)]);
    for (const [k, v] of Object.entries(obj)) {
      storage.data.set(k, v);
    }
  });
  return { log, interruptedWith };
}

function seedCurrentConversation(id = "c1", overrides = {}) {
  chatSessionState.savedConversations = [makeConversation(id, overrides)];
  chatSessionState.currentConversationId = id;
  chatSessionState.currentConversationMeta = {
    id,
    title: `对话${id}`,
    pinnedContext: true,
    contextKey: overrides.contextKey || "",
    contextRef: null,
    resolvedContext: null
  };
  chatSessionState.chatHistory = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" }
  ];
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

// 「拆除会话」四出口参数表:setup 布景,run 发起拆除,persisted 声明该出口是否落盘。
const DETACH_EXITS = [
  {
    label: "restoreLatest 无匹配",
    setup() {
      // 绑定另一视频 → 与当前上下文无匹配
      seedCurrentConversation("c1", { url: "https://www.bilibili.com/video/BVother" });
    },
    run(store) {
      return store.restoreLatest();
    },
    persisted: false
  },
  {
    label: "deleteById 当前会话",
    setup() {
      seedCurrentConversation("c1");
    },
    run(store) {
      return store.deleteById("c1");
    },
    persisted: true
  },
  {
    label: "clearAll",
    storeDeps: { confirmClearAll: () => true },
    setup() {
      seedCurrentConversation("c1");
    },
    run(store) {
      return store.clearAll();
    },
    persisted: true
  },
  {
    label: "detachForRestart(新会话重启)",
    setup() {
      seedCurrentConversation("c1");
    },
    run(store) {
      return store.detachForRestart();
    },
    persisted: false
  }
];

// ===========================================================================
// 承重不变式(参数化):断流先于身份清空、先于落盘;拆除恰为身份三键清空
// ===========================================================================
describe("拆除会话四出口的承重不变式", () => {
  it.each(DETACH_EXITS)("$label:断流恰一次且先于身份清空(发起瞬间 id 仍在);收尾 id/meta/历史清空", async ({ setup, run, storeDeps }) => {
    const { store, deps, storage } = makeHarness(storeDeps);
    const { interruptedWith } = makeOrderLog(deps, storage);
    setup();

    await run(store);

    expect(deps.onStreamInterrupted).toHaveBeenCalledTimes(1);
    // 断流发起瞬间会话身份尚未清空(流式身份守卫在 id 清空前依赖同步断流)
    expect(interruptedWith[0].id).toBe("c1");
    expect(interruptedWith[0].meta).not.toBeNull();
    expect(interruptedWith[0].history.length).toBe(2);
    // 拆除收尾:身份三键清空
    expect(chatSessionState.currentConversationId).toBe("");
    expect(chatSessionState.currentConversationMeta).toBeNull();
    expect(chatSessionState.chatHistory).toEqual([]);
  });

  it.each(DETACH_EXITS)("$label:断流先于落盘(落盘出口)或不落盘(无落盘出口)", async ({ setup, run, persisted, storeDeps }) => {
    const { store, deps, storage } = makeHarness(storeDeps);
    const { log } = makeOrderLog(deps, storage);
    setup();

    await run(store);

    if (persisted) {
      // 落盘出口:storage.set 必须晚于断流通知(「断流先于落盘」不变式)
      const interruptIndex = log.findIndex(([kind]) => kind === "interrupt");
      const persistIndex = log.findIndex(([kind]) => kind === "persist");
      expect(persistIndex).toBeGreaterThan(-1);
      expect(interruptIndex).toBeLessThan(persistIndex);
    } else {
      // 无落盘出口:restoreLatest 无匹配 / detachForRestart 均不写 storage
      expect(log.some(([kind]) => kind === "persist")).toBe(false);
    }
  });
});

// ===========================================================================
// 出口一 restoreLatest 无匹配:detach 不回填、不落盘、不重渲
// ===========================================================================
describe("出口一 restoreLatest 无匹配", () => {
  it("断流+清身份后返回 false;live 快照不回填,change/notice/persist 零次", async () => {
    const { store, deps, storage } = makeHarness();
    const { log } = makeOrderLog(deps, storage);
    seedCurrentConversation("c1", { url: "https://www.bilibili.com/video/BVother" });
    chatSessionState.liveContextData = { bvid: "BV1abc", url: URL_A, isVideoContext: true };
    chatSessionState.liveContextKey = "k-live";

    const result = await store.restoreLatest();

    expect(result).toBe(false);
    // 无 live 回填:主上下文保持拆除前原值(视图重建非本出口职责)
    expect(chatSessionState.contextData).toBeNull();
    expect(chatSessionState.currentContextKey).toBe("");
    expect(log).toEqual([["interrupt"]]);
  });
});

// ===========================================================================
// 出口二 deleteById 当前会话:detach + 回填 + 尾次 change 标志逐字
// ===========================================================================
describe("出口二 deleteById 当前会话", () => {
  it("事件次序 = [interrupt, persist, change {}, change {refreshContextChip, resetView}];live 回填发生", async () => {
    const { store, deps, storage } = makeHarness();
    const { log } = makeOrderLog(deps, storage);
    seedCurrentConversation("c1");
    const liveData = { bvid: "BV1abc", url: URL_A, title: "视频A", isVideoContext: true };
    chatSessionState.liveContextData = liveData;
    chatSessionState.liveContextKey = "k-live";

    await store.deleteById("c1");

    expect(log).toEqual([
      ["interrupt"],
      ["persist", ["boc_ai_conversations_v1"]],
      ["change", {}],
      ["change", { refreshContextChip: true, resetView: true }]
    ]);
    // live 回填:主上下文持有最新页面快照(浅拷贝,非同引用)
    expect(chatSessionState.contextData).toEqual(liveData);
    expect(chatSessionState.contextData).not.toBe(liveData);
    expect(chatSessionState.currentContextKey).toBe("k-live");
    expect(chatSessionState.savedConversations).toEqual([]);
  });

  it("组合次序:detach(断流+清键)先于 commitSaved+save(detach 瞬间存档尚未重写)", async () => {
    const { store, deps, storage } = makeHarness();
    const { interruptedWith } = makeOrderLog(deps, storage);
    seedCurrentConversation("c1");

    await store.deleteById("c1");

    expect(interruptedWith[0].savedCount).toBe(1);
    expect(chatSessionState.savedConversations).toEqual([]);
  });
});

// ===========================================================================
// 出口三 clearAll:commitSaved([]) 先于 detach、回填在 save 后
// ===========================================================================
describe("出口三 clearAll", () => {
  it("事件次序 = [interrupt, persist, change {}, change {refreshContextChip, historyCleared, resetView}];detach 瞬间存档已清(commitSaved([]) 在 detach 前)", async () => {
    const { store, deps, storage } = makeHarness({ confirmClearAll: () => true });
    const { log, interruptedWith } = makeOrderLog(deps, storage);
    seedCurrentConversation("c1");
    const liveData = { bvid: "BV1abc", url: URL_A, title: "视频A", isVideoContext: true };
    chatSessionState.liveContextData = liveData;
    chatSessionState.liveContextKey = "k-live";

    await store.clearAll();

    expect(log).toEqual([
      ["interrupt"],
      ["persist", ["boc_ai_conversations_v1"]],
      ["change", {}],
      ["change", { refreshContextChip: true, historyCleared: true, resetView: true }]
    ]);
    // clearAll 组合次序:commitSaved([])(内存) → detach → save → 回填
    expect(interruptedWith[0].savedCount).toBe(0);
    // live 回填发生
    expect(chatSessionState.contextData).toEqual(liveData);
    expect(chatSessionState.currentContextKey).toBe("k-live");
  });
});

// ===========================================================================
// 出口四 detachForRestart:公开窄 detach,不回填、不落盘、不发 change
// ===========================================================================
describe("出口四 detachForRestart(新会话重启)", () => {
  it("断流一次+身份清空;live 不回填;零 change/notice/persist(视图重建由 restartChat 自排)", () => {
    const { store, deps, storage } = makeHarness();
    const { log } = makeOrderLog(deps, storage);
    seedCurrentConversation("c1");
    chatSessionState.liveContextData = { bvid: "BV1abc", url: URL_A, isVideoContext: true };
    chatSessionState.liveContextKey = "k-live";

    store.detachForRestart();

    expect(chatSessionState.currentConversationId).toBe("");
    expect(chatSessionState.currentConversationMeta).toBeNull();
    expect(chatSessionState.chatHistory).toEqual([]);
    expect(chatSessionState.contextData).toBeNull();
    expect(log).toEqual([["interrupt"]]);
  });
});

// ===========================================================================
// 接口收窄 11→8 + 工单 D 窄方法:返回面键集断言 + 三摘除键的内部调用点零变化
// ===========================================================================
describe("公开接口面", () => {
  it("返回面 = 收窄 8 键 + detachForRestart;apply/resolveContext/hydratePages 三键不再外露", () => {
    const { store } = makeHarness();

    expect(Object.keys(store).sort()).toEqual([
      "applyById",
      "clearAll",
      "deleteById",
      "detachForRestart",
      "hydratePinned",
      "isCurrent",
      "loadAll",
      "persistCurrent",
      "restoreLatest"
    ]);
    expect(store.apply).toBeUndefined();
    expect(store.resolveContext).toBeUndefined();
    expect(store.hydratePages).toBeUndefined();
  });

  it("内部 apply 经 applyById 存活:身份/历史/事件面照常", () => {
    const { store, deps } = makeHarness();
    chatSessionState.savedConversations = [makeConversation("c1")];

    store.applyById("c1");

    expect(chatSessionState.currentConversationId).toBe("c1");
    expect(chatSessionState.currentConversationMeta.pinnedContext).toBe(true);
    expect(chatSessionState.chatHistory.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(deps.onConversationChanged).toHaveBeenCalledWith({ refreshContextChip: true, resetView: true });
  });

  it("内部 resolveContext 经 hydratePinned 网络路径存活:purpose=context 解析成功落回", async () => {
    const { store } = makeHarness({
      resolveAiConversationRef: vi.fn(async (_ref, purpose) => {
        expect(purpose).toBe("context");
        return { bvid: "BV1abc", cid: "1", url: URL_A, title: "视频A", isVideoContext: true };
      })
    });
    chatSessionState.currentConversationMeta = {
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
      resolvedContext: null
    };

    const ok = await store.hydratePinned();

    expect(ok).toBe(true);
    expect(chatSessionState.currentContextKey).toBe("k-1");
  });

  it("内部 hydratePages 经 loadAll 存活:分页补水变更追加 chip change 与 save", async () => {
    const { store, deps, storage } = makeHarness({
      resolveAiConversationRef: vi.fn(async () => ({ pageIndex: 2, url: `${URL_A}?p=2`, cid: "2", pageTitle: "第二P" }))
    });
    await storage.set({ boc_ai_conversations_v1: [makeConversation("c1")] });

    await store.loadAll();
    await vi.waitFor(() => expect(deps.onConversationChanged.mock.calls.length).toBe(3));

    // 次序:loadAll 的 {} → 补水变更的 {chip} → save 的 {}
    expect(deps.onConversationChanged).toHaveBeenNthCalledWith(2, { refreshContextChip: true });
    expect(deps.onConversationChanged).toHaveBeenNthCalledWith(3, {});
    expect(deps.resolveAiConversationRef).toHaveBeenCalledTimes(1);
  });
});
