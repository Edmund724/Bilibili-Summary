// tests/chat/context-load.test.js
// createContextLoad（上下文状态加载 + context chip + 跳转）行为契约（候选5 拆分
// 直测；PR5 自 tests/sidepanel 随迁并适配 ContextFetch 策略注入——组装面更新，
// 行为断言与迁移前一致）。
//
// 覆盖 loadContextState 的策略动作分支（表驱动）：
//   no-tab（清 live/主上下文，非静默重置视图）
//   skip-unchanged（短路返回 true，不动任何状态）
//   error（清 live，非 pinned 连主上下文一起清；静默不重置视图）
//   apply-pinned（只落地 live 快照，不进主上下文）
//   blocked-streaming（同 pinned 执行体）
//   apply-live（正常落地 + 上下文变化时 restoreLatest + renderInitialState）
// 以及 updateContextChip（空上下文/标题截断/mismatch 标记）与 openCurrentContextUrl
//（同视频不跳转、跨视频更新 URL + 等待加载 + 强刷）。
//
// 依赖全注入：getActiveTab / 流式判定 / 渲染回调均为 vi.fn；getAiContextState
// 的消息往返经 vi.mock ../ai/context-resolver（hoisted mock，模板同
// presets.test.js）。PR5：拉数据段注入消息链策略 createMessageChainContextFetch
//（getActiveTab + ensureReaderContentReady + sendMessageToTab 三 transport 也在
// 注入面），进程内直读策略的行为契约见 context-inprocess.test.js。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const { getAiContextStateMock } = vi.hoisted(() => ({
  getAiContextStateMock: vi.fn()
}));

vi.mock("../../extension/ai/context-resolver.js", () => ({
  getAiContextState: getAiContextStateMock
}));

let createContextLoad;
let createMessageChainContextFetch;
let sidepanelState;

async function importModule() {
  const module = await import("../../extension/chat/context-load.js");
  const state = (await import("../../extension/chat/chat-state.js")).sidepanelState;
  createContextLoad = module.createContextLoad;
  createMessageChainContextFetch = module.createMessageChainContextFetch;
  sidepanelState = state;
}

const ACTIVE_TAB = { id: 42, url: "https://www.bilibili.com/video/BV1" };

function makePayload(overrides = {}) {
  return { signature: "sig-1", title: "测试视频", url: "https://www.bilibili.com/video/BV1", isVideoContext: true, ...overrides };
}

function makeHarness({ tab = ACTIVE_TAB } = {}) {
  const contextChip = document.createElement("button");
  document.body.appendChild(contextChip);
  const deps = {
    getActiveTab: vi.fn(async () => tab),
    ensureReaderContentReady: vi.fn(async () => {}),
    sendMessageToTab: vi.fn(async () => ({ ok: true })),
    contextChip,
    renderHistoryList: vi.fn(),
    renderInitialState: vi.fn(),
    renderSuggestions: vi.fn(),
    resetConversationView: vi.fn(),
    restartChat: vi.fn(),
    restoreLatest: vi.fn(async () => true),
    isStreaming: vi.fn(() => false),
    hasPendingUserPrompt: vi.fn(() => false)
  };
  const contextLoad = createContextLoad({
    // 消息链策略：getAiContextState 走 vi.mock，往返参数断言保留原样
    fetchContext: createMessageChainContextFetch({
      getActiveTab: deps.getActiveTab,
      ensureReaderContentReady: deps.ensureReaderContentReady,
      sendMessageToTab: deps.sendMessageToTab
    }),
    getActiveTab: deps.getActiveTab,
    contextChip: deps.contextChip,
    renderHistoryList: deps.renderHistoryList,
    renderInitialState: deps.renderInitialState,
    renderSuggestions: deps.renderSuggestions,
    resetConversationView: deps.resetConversationView,
    restartChat: deps.restartChat,
    restoreLatest: deps.restoreLatest,
    isStreaming: deps.isStreaming,
    hasPendingUserPrompt: deps.hasPendingUserPrompt
  });
  return { deps, contextLoad, contextChip };
}

beforeEach(async () => {
  resetModuleState();
  getAiContextStateMock.mockReset();
  await importModule();
  sidepanelState.contextData = null;
  sidepanelState.currentContextKey = "";
  sidepanelState.liveContextData = null;
  sidepanelState.liveContextKey = "";
  sidepanelState.liveTabUrl = "";
  sidepanelState.currentConversationMeta = null;
});

describe("loadContextState 动作分支", () => {
  it("no-tab：清 live 快照，非 pinned 连主上下文一起清并重置视图", async () => {
    sidepanelState.contextData = makePayload();
    sidepanelState.currentContextKey = "k1";
    sidepanelState.liveContextData = makePayload();
    const { deps, contextLoad } = makeHarness({ tab: null });

    const ok = await contextLoad.loadContextState({ silent: false });

    expect(ok).toBe(false);
    expect(sidepanelState.liveContextData).toBeNull();
    expect(sidepanelState.liveTabUrl).toBe("");
    expect(sidepanelState.contextData).toBeNull();
    expect(sidepanelState.currentContextKey).toBe("");
    expect(deps.renderHistoryList).not.toHaveBeenCalled();
    expect(deps.resetConversationView).toHaveBeenCalledTimes(1);
    expect(getAiContextStateMock).not.toHaveBeenCalled();
  });

  it("no-tab + pinned 对话：保留主上下文，不重置视图", async () => {
    sidepanelState.contextData = makePayload();
    sidepanelState.currentConversationMeta = { pinnedContext: true };
    const { deps, contextLoad } = makeHarness({ tab: null });

    await contextLoad.loadContextState({ silent: false });

    expect(sidepanelState.contextData).not.toBeNull();
    expect(deps.resetConversationView).not.toHaveBeenCalled();
  });

  it("skip-unchanged：短路返回 true，不动任何状态不重渲染", async () => {
    sidepanelState.liveContextData = makePayload();
    const prevContextData = sidepanelState.contextData;
    getAiContextStateMock.mockResolvedValue({ unchanged: true });
    const { deps, contextLoad } = makeHarness();

    const ok = await contextLoad.loadContextState({ forceRefresh: false, silent: true });

    expect(ok).toBe(true);
    expect(getAiContextStateMock).toHaveBeenCalledWith(
      42,
      { forceRefresh: false, ifSignature: "sig-1" },
      expect.anything()
    );
    expect(sidepanelState.contextData).toBe(prevContextData);
    expect(deps.renderHistoryList).not.toHaveBeenCalled();
    expect(deps.renderInitialState).not.toHaveBeenCalled();
    expect(deps.restoreLatest).not.toHaveBeenCalled();
  });

  it("error：清 live 快照，非静默重置视图并透传错误信息", async () => {
    getAiContextStateMock.mockRejectedValue(new Error("内容脚本未响应"));
    const { deps, contextLoad } = makeHarness();

    const ok = await contextLoad.loadContextState({ silent: false });

    expect(ok).toBe(false);
    expect(sidepanelState.liveContextData).toBeNull();
    expect(sidepanelState.contextData).toBeNull();
    expect(deps.resetConversationView).toHaveBeenCalledWith("内容脚本未响应");
  });

  it("error + 静默：不重置视图（返回值仍 false）", async () => {
    getAiContextStateMock.mockRejectedValue(new Error("超时"));
    const { deps, contextLoad } = makeHarness();

    const ok = await contextLoad.loadContextState({ silent: true });

    expect(ok).toBe(false);
    expect(deps.resetConversationView).not.toHaveBeenCalled();
  });

  it("apply-pinned：只落地 live 快照（不进主上下文、不触发对话恢复）", async () => {
    sidepanelState.currentConversationMeta = { pinnedContext: true };
    const payload = makePayload({ signature: "sig-2" });
    getAiContextStateMock.mockResolvedValue(payload);
    const { deps, contextLoad } = makeHarness();

    const ok = await contextLoad.loadContextState({ silent: true });

    expect(ok).toBe(true);
    expect(sidepanelState.liveContextData).toEqual(payload);
    expect(sidepanelState.liveContextKey).not.toBe("");
    expect(sidepanelState.contextData).toBeNull(); // 主上下文未被改写
    expect(deps.renderHistoryList).toHaveBeenCalledTimes(1);
    expect(deps.restoreLatest).not.toHaveBeenCalled();
    expect(deps.renderInitialState).not.toHaveBeenCalled();
  });

  it("blocked-streaming：同 pinned 执行体（只落地 live 快照）", async () => {
    const payload = makePayload({ signature: "sig-3" });
    getAiContextStateMock.mockResolvedValue(payload);
    const { deps, contextLoad } = makeHarness();
    deps.isStreaming.mockReturnValue(true);

    const ok = await contextLoad.loadContextState({ silent: true });

    expect(ok).toBe(true);
    expect(sidepanelState.liveContextData).toEqual(payload);
    expect(sidepanelState.contextData).toBeNull();
    expect(deps.restoreLatest).not.toHaveBeenCalled();
  });

  it("apply-live：主上下文落地；上下文变化时 restartChat + restoreLatest + renderInitialState", async () => {
    sidepanelState.currentContextKey = "old-key";
    sidepanelState.contextData = makePayload();
    const payload = makePayload({ signature: "sig-4", title: "新视频" });
    getAiContextStateMock.mockResolvedValue(payload);
    const { deps, contextLoad } = makeHarness();

    const ok = await contextLoad.loadContextState({ silent: true });

    expect(ok).toBe(true);
    expect(sidepanelState.contextData).toEqual(payload);
    // 与迁移前一致：变化 + 非流式 → restartChat({keepContext:true}) 冻结上下文，
    // 再 restoreLatest + renderInitialState
    expect(deps.restartChat).toHaveBeenCalledWith({ keepContext: true });
    expect(deps.renderHistoryList).toHaveBeenCalledTimes(1);
    expect(deps.restoreLatest).toHaveBeenCalledTimes(1);
    expect(deps.renderInitialState).toHaveBeenCalledTimes(1);
  });

  it("apply-live：上下文未变化（首次落地）不触发对话恢复，走 renderSuggestions", async () => {
    const payload = makePayload();
    getAiContextStateMock.mockResolvedValue(payload);
    const { deps, contextLoad } = makeHarness();

    const ok = await contextLoad.loadContextState({ silent: true });

    expect(ok).toBe(true);
    expect(sidepanelState.contextData).toEqual(payload);
    expect(deps.restoreLatest).not.toHaveBeenCalled();
    expect(deps.renderInitialState).not.toHaveBeenCalled();
    expect(deps.renderSuggestions).toHaveBeenCalledTimes(1);
  });

  it("apply-live：上下文变化但流式中 → 动作被 policy 判为 blocked-streaming（只落地 live 快照）", async () => {
    sidepanelState.currentContextKey = "old-key";
    sidepanelState.contextData = makePayload();
    getAiContextStateMock.mockResolvedValue(makePayload({ signature: "sig-5", title: "新视频" }));
    const { deps, contextLoad } = makeHarness();
    deps.isStreaming.mockReturnValue(true);

    const ok = await contextLoad.loadContextState({ silent: true });

    // 流式守卫优先于 apply-live（policy 判定），主上下文冻结、不进恢复流程；
    // applyContextPayload 内部的 isStreaming 检查是双保险（此路径不可达）。
    expect(ok).toBe(true);
    expect(sidepanelState.liveContextData).not.toBeNull();
    expect(sidepanelState.contextData).toEqual(makePayload());
    expect(deps.restartChat).not.toHaveBeenCalled();
    expect(deps.restoreLatest).not.toHaveBeenCalled();
  });
});

describe("updateContextChip", () => {
  it("无上下文：文案「无上下文」+ disabled + 去 mismatch", () => {
    const { contextLoad, contextChip } = makeHarness();
    contextChip.disabled = false;
    contextChip.classList.add("is-mismatch");

    contextLoad.updateContextChip();

    expect(contextChip.textContent).toBe("无上下文");
    expect(contextChip.disabled).toBe(true);
    expect(contextChip.classList.contains("is-mismatch")).toBe(false);
  });

  it("有上下文：标题整串写入 chip（溢出交 CSS ellipsis）+ disabled 随 url 有无", () => {
    sidepanelState.contextData = { title: "一".repeat(30), url: "https://x" };
    const { contextLoad, contextChip } = makeHarness();

    contextLoad.updateContextChip();

    expect(contextChip.textContent).toBe("一".repeat(30));
    expect(contextChip.disabled).toBe(false);
  });

  it("pinned 对话绑定视频与当前页不符：is-mismatch 标记", () => {
    sidepanelState.contextData = { title: "视频", url: "https://www.bilibili.com/video/BV1" };
    sidepanelState.currentConversationMeta = { pinnedContext: true, contextUrl: "https://www.bilibili.com/video/BVother" };
    sidepanelState.liveTabUrl = "https://www.bilibili.com/video/BVxyz999";
    const { contextLoad, contextChip } = makeHarness();

    contextLoad.updateContextChip();

    expect(contextChip.classList.contains("is-mismatch")).toBe(true);
    expect(contextChip.title).toContain("当前页不是这个对话绑定的视频");
  });
});

describe("openCurrentContextUrl", () => {
  it("无目标 URL：no-op", async () => {
    const { deps, contextLoad } = makeHarness();
    deps.getActiveTab.mockClear();

    await contextLoad.openCurrentContextUrl();

    expect(deps.getActiveTab).not.toHaveBeenCalled();
  });

  it("同视频：不更新 URL，但强刷一轮上下文", async () => {
    sidepanelState.contextData = { title: "视频", url: "https://www.bilibili.com/video/BV1" };
    getAiContextStateMock.mockResolvedValue(makePayload());
    const { contextLoad } = makeHarness();
    const updateSpy = vi.fn(async () => {});
    window.chrome = window.chrome || {};
    window.chrome.tabs = { ...window.chrome.tabs, update: updateSpy };

    await contextLoad.openCurrentContextUrl();

    expect(updateSpy).not.toHaveBeenCalled();
    expect(getAiContextStateMock).toHaveBeenCalledWith(
      42,
      { forceRefresh: true, ifSignature: "" },
      expect.anything()
    );
  });

  it("跨视频：更新 URL 后强刷（waitForTabComplete 需 chrome.tabs.get stub）", async () => {
    sidepanelState.contextData = { title: "视频", url: "https://www.bilibili.com/video/BV1" };
    getAiContextStateMock.mockResolvedValue(makePayload());
    const { contextLoad } = makeHarness({ tab: { id: 42, url: "https://www.bilibili.com/video/BVother" } });
    const updateSpy = vi.fn(async () => {});
    window.chrome = window.chrome || {};
    window.chrome.tabs = {
      ...window.chrome.tabs,
      update: updateSpy,
      get: vi.fn(async () => ({ status: "complete" }))
    };

    await contextLoad.openCurrentContextUrl();

    expect(updateSpy).toHaveBeenCalledWith(42, { url: "https://www.bilibili.com/video/BV1" });
    expect(getAiContextStateMock).toHaveBeenCalled();
  });
});
