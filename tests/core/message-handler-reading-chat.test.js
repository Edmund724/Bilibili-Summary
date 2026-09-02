// PR5c：popup AI 入口 / player-ai 悬浮按钮的 content 侧消费端回归测试。
//
// 锁定两条新消息在 dispatchContentScriptMessage 的最终形态：
// - popup-trigger-reading-chat：reader 未开 ⇒ 先 enterReaderMode，再激活对话
//   tab；带 prompt 走 runQuickActionPrompt（快捷动作），不带 prompt 只
//   ensureChatTabActivated（定位/聚焦）。consumeIntent 均为 false。
// - player-ai-quick-action-chat：prompt 空 → 落 DEFAULT_PLAYER_AI_QUICK_PROMPT，
//   经对话 seam 自动发送。
// - 兼容别名：旧 sidepanel-get-context 消息名与新 reader-get-context 走同一
//   处理器（payload 组装 + signature 附加，响应形状一致）。
//
// 写法与 message-handler-seek.test.js 同款：重依赖全部 vi.mock，state 走真实
// 模块，单纪元；对话 seam 经 core/lazy-chat-tab mock（组合根本体由
// tests/reader/chat-tab.test.ts 覆盖）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../extension/core/lazy-reader.js", () => ({
  ensureReaderDomain: vi.fn(),
  isReaderDomainLoaded: vi.fn(() => false)
}));
vi.mock("../../extension/reader/state.js", () => ({
  isReaderViewOpen: vi.fn(() => false),
  enforceNormalPageStateIfNeeded: vi.fn()
}));
vi.mock("../../extension/core/url-watcher.js", () => ({
  startUrlWatcher: vi.fn(),
  BOC_URL_CHANGE_EVENT: "boc:urlchange"
}));
vi.mock("../../extension/bilibili/reader-url.js", () => ({
  replaceReaderModeUrl: vi.fn()
}));
vi.mock("../../extension/subtitle/lazy.js", () => ({
  ensureSummarizeChain: vi.fn()
}));
vi.mock("../../extension/shared/ui-status.js", () => ({
  setStatus: vi.fn()
}));
vi.mock("../../extension/core/lazy-ui.js", () => ({
  ensureUiReady: vi.fn(async () => {})
}));
vi.mock("../../extension/core/lazy-player-ai.js", () => ({
  loadPlayerAi: vi.fn(),
  isPlayerAiLoaded: vi.fn(() => false)
}));
// 对话 seam（core/lazy-chat-tab）：mock 掉组合根，断言消费路径与参数。
const ensureReaderChatTabMock = vi.hoisted(() => vi.fn());
vi.mock("../../extension/core/lazy-chat-tab.js", () => ({
  ensureReaderChatTab: ensureReaderChatTabMock,
  isReaderChatTabLoaded: vi.fn(() => false)
}));
// bilibili/gateway.js（reader-get-hot-comments 处理器动态 import）：别名校验用例
// 只走 get-context 路径，不需要真热评。
vi.mock("../../extension/bilibili/gateway.js", () => ({
  getCurrentAid: vi.fn(() => ""),
  fetchHotComments: vi.fn(async () => [])
}));

import { bindRuntimeEvents, computeContextStateSignature } from "../../extension/core/message-handler.js";
import { ensureReaderDomain } from "../../extension/core/lazy-reader.js";
import { isReaderViewOpen } from "../../extension/reader/state.js";
import { DEFAULT_PLAYER_AI_QUICK_PROMPT } from "../../extension/core/defaults.js";

const onMessageListeners = [];
vi.stubGlobal("chrome", {
  runtime: {
    getURL: (path) => `chrome-extension://test/${path}`,
    onMessage: {
      addListener: (listener) => onMessageListeners.push(listener)
    }
  }
});

bindRuntimeEvents();
const messageListener = onMessageListeners[0];

function makeChatStub() {
  return {
    ensureChatTabActivated: vi.fn(async () => {}),
    runQuickActionPrompt: vi.fn(async () => true),
    closeChatSession: vi.fn()
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isReaderViewOpen.mockReturnValue(false);
  ensureReaderChatTabMock.mockReset();
  ensureReaderChatTabMock.mockResolvedValue(makeChatStub());
});

describe("popup-trigger-reading-chat：打开阅读模式并激活对话 tab", () => {
  it("reader 未开：先 enterReaderMode，再带 prompt 走 runQuickActionPrompt", async () => {
    const chat = makeChatStub();
    ensureReaderChatTabMock.mockResolvedValue(chat);
    ensureReaderDomain.mockResolvedValue({ enterReaderMode: vi.fn(async () => {}) });

    const sendResponse = vi.fn();
    const keepOpen = messageListener(
      { type: "popup-trigger-reading-chat", readerUrl: "https://www.bilibili.com/video/BV1/?boc_reader=1", prompt: "总结" },
      {},
      sendResponse
    );

    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(keepOpen).toBe(true);
    await vi.waitFor(() => expect(chat.runQuickActionPrompt).toHaveBeenCalledTimes(1));
    expect(chat.runQuickActionPrompt).toHaveBeenCalledWith("总结");
    expect(chat.ensureChatTabActivated).not.toHaveBeenCalled();
    expect(ensureReaderDomain).toHaveBeenCalledTimes(1);
  });

  it("reader 已开：不重复 enterReaderMode，无 prompt 只激活对话 tab（consumeIntent:false）", async () => {
    const chat = makeChatStub();
    ensureReaderChatTabMock.mockResolvedValue(chat);
    isReaderViewOpen.mockReturnValue(true);

    const sendResponse = vi.fn();
    messageListener({ type: "popup-trigger-reading-chat" }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    await vi.waitFor(() => expect(chat.ensureChatTabActivated).toHaveBeenCalledTimes(1));
    expect(chat.ensureChatTabActivated).toHaveBeenCalledWith({ consumeIntent: false });
    expect(ensureReaderDomain).not.toHaveBeenCalled();
    expect(chat.runQuickActionPrompt).not.toHaveBeenCalled();
  });
});

describe("空 readerUrl 兜底：视图未开时用当前地址构造阅读 URL", () => {
  // PR5c 回归：background 的 player-ai/reading-chat 链在「未在阅读模式」时也
  // 传空 readerUrl（原语义假设空串 = 已在阅读模式内只聚焦）。若 content 侧
  // 跳过 URL 改写 + 阅读表 + data-boc-reader-mode 门控，enterReaderMode 会
  // 落在无样式的半进入态（布局微变但阅读模式不出现）。
  afterEach(() => {
    document.documentElement.removeAttribute("data-boc-reader-mode");
    document.body.removeAttribute("data-boc-reader-mode");
  });

  it("popup-trigger-reading-view：空 readerUrl 且视图未开 → 兜底改写 + 翻门控属性 + enterReaderMode", async () => {
    const { setLocationUrl, NORMAL_PAGE_URL } = await import("../setup.js");
    setLocationUrl(NORMAL_PAGE_URL);
    const { replaceReaderModeUrl } = await import("../../extension/bilibili/reader-url.js");
    const enterReaderMode = vi.fn(async () => {});
    ensureReaderDomain.mockResolvedValue({ enterReaderMode });

    const sendResponse = vi.fn();
    messageListener({ type: "popup-trigger-reading-view", readerUrl: "" }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    await vi.waitFor(() => expect(enterReaderMode).toHaveBeenCalledTimes(1));
    expect(replaceReaderModeUrl).toHaveBeenCalledWith("https://www.bilibili.com/video/BV1test000000/?boc_reader=1");
    expect(document.documentElement.getAttribute("data-boc-reader-mode")).toBe("1");
    expect(document.body.getAttribute("data-boc-reader-mode")).toBe("1");
  });

  it("popup-trigger-reading-view：空 readerUrl 且视图已开 → 保持纯聚焦语义，不改写 URL", async () => {
    isReaderViewOpen.mockReturnValue(true);
    const { replaceReaderModeUrl } = await import("../../extension/bilibili/reader-url.js");

    messageListener({ type: "popup-trigger-reading-view", readerUrl: "" }, {}, vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(replaceReaderModeUrl).not.toHaveBeenCalled();
    expect(ensureReaderDomain).not.toHaveBeenCalled();
  });

  it("popup-trigger-reading-chat：空 readerUrl 且视图未开 → 兜底改写后 enterReaderMode + runQuickActionPrompt", async () => {
    const { setLocationUrl, NORMAL_PAGE_URL } = await import("../setup.js");
    setLocationUrl(NORMAL_PAGE_URL);
    const { replaceReaderModeUrl } = await import("../../extension/bilibili/reader-url.js");
    const chat = makeChatStub();
    ensureReaderChatTabMock.mockResolvedValue(chat);
    ensureReaderDomain.mockResolvedValue({ enterReaderMode: vi.fn(async () => {}) });

    messageListener({ type: "popup-trigger-reading-chat", readerUrl: "", prompt: "总结" }, {}, vi.fn());

    await vi.waitFor(() => expect(chat.runQuickActionPrompt).toHaveBeenCalledWith("总结"));
    expect(replaceReaderModeUrl).toHaveBeenCalledWith("https://www.bilibili.com/video/BV1test000000/?boc_reader=1");
    expect(document.documentElement.getAttribute("data-boc-reader-mode")).toBe("1");
  });
});

describe("player-ai-quick-action-chat：悬浮按钮快捷动作消费", () => {
  it("带 prompt：直接走 runQuickActionPrompt（自动发送）", async () => {
    const chat = makeChatStub();
    ensureReaderChatTabMock.mockResolvedValue(chat);

    const sendResponse = vi.fn();
    messageListener({ type: "player-ai-quick-action-chat", prompt: "整理内容" }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    await vi.waitFor(() => expect(chat.runQuickActionPrompt).toHaveBeenCalledWith("整理内容"));
  });

  it("prompt 缺省：回落 DEFAULT_PLAYER_AI_QUICK_PROMPT", async () => {
    const chat = makeChatStub();
    ensureReaderChatTabMock.mockResolvedValue(chat);

    messageListener({ type: "player-ai-quick-action-chat" }, {}, vi.fn());

    await vi.waitFor(() => expect(chat.runQuickActionPrompt).toHaveBeenCalledWith(DEFAULT_PLAYER_AI_QUICK_PROMPT));
  });
});

describe("兼容别名：旧 sidepanel-get-context 走同一处理器", () => {
  function seedReadyClip(state) {
    state.clip.setBvid("BV1alias");
    state.clip.setAid("9");
    state.clip.setCid("101");
    state.clip.setPageIndex(1);
    state.clip.setTitle("别名测试");
    state.clip.setSubtitleFetchState("ready");
    state.clip.setNoSubtitleReason(null);
  }

  it("旧名与新名响应同形（payload + signature），签名函数单源", async () => {
    const { state } = await import("../../extension/core/state.js");
    seedReadyClip(state);

    const oldResp = vi.fn();
    messageListener({ type: "sidepanel-get-context" }, {}, oldResp);
    expect(oldResp).toHaveBeenCalledTimes(1);

    const newResp = vi.fn();
    messageListener({ type: "reader-get-context" }, {}, newResp);
    expect(newResp).toHaveBeenCalledTimes(1);

    const oldPayload = oldResp.mock.calls[0][0].payload;
    const newPayload = newResp.mock.calls[0][0].payload;
    expect(oldResp.mock.calls[0][0].ok).toBe(true);
    expect(newResp.mock.calls[0][0].ok).toBe(true);
    expect(oldPayload).toEqual(newPayload);
    expect(oldPayload.signature).toBe(computeContextStateSignature(newPayload));
    expect(oldPayload.bvid).toBe("BV1alias");
  });

  it("旧名 + ifSignature 命中：签名短路 unchanged（与新名同语义）", async () => {
    const { state } = await import("../../extension/core/state.js");
    seedReadyClip(state);
    const { createReaderContextPayload } = await import("../../extension/core/context-payload.js");
    const payload = createReaderContextPayload({ clip: state.clip, settings: {}, url: location.href });
    const signature = computeContextStateSignature(payload);

    const sendResponse = vi.fn();
    messageListener({ type: "sidepanel-get-context", ifSignature: signature }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ ok: true, unchanged: true, signature });
  });
});
