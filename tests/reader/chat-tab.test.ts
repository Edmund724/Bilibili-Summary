// tests/reader/chat-tab.test.ts
// PR5 AI 对话 tab 组合根（reader/chat-tab.ts）回归测试：真实模板（ensureUiReady）
// + 二级惰性装载（core/lazy-chat-tab）。
//
// 覆盖（验收清单）：
// - 组合根装配：懒加载边界（开壳不装载，首切对话 tab 才装载）、init 一次性
//   （重复激活幂等）、context chip / 模型选择器 / 消息区初始态；
// - explain 意图消费：激活时 peek → 渲染引用卡（时间戳 pill）→ 自动发送解释
//   提示词 → 发送成功即 consume（一次意图只发一次）；取消按钮清意图；
// - subtitle-wait kick 总线接线：转写中发送被挂起（意图/输入保持 pending），
//   进程内相位 asr-done（subtitle-status-bus）驱动 kick 补轮放行，发出的是转写
//   完成后的完整字幕；asr 提示行随相位显隐；
// - 断流收口（工单 08）：closeChatSession 断 port + 退出流式 UI 态；关闭后发送
//   不再放行（不做后台续跑）；重开从会话历史恢复（恢复路径重渲 + 触发源重挂）；
// - 外点关闭单委托：popovers 的 handleDocumentClick 经 chat-tab-bridge 并入
//   ui-renderer 的单一文档级委托（点外关闭、点内不关），不双监听；
// - player-ai 快捷动作 seam（PR4b 概览笔记按钮同款）：runQuickActionPrompt =
//   定位对话 tab + startNewConversation + 填提示词 + 自动发送；不消费待解释
//   意图（互不踩踏）。
//
// 模块纪元注意：sidepanelState 与组合根闭包都是模块级单例，beforeEach
// resetModules 后同纪元导入；chrome.storage / runtime 消息按 type 路由 stub。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

const { gatewayMock } = vi.hoisted(() => ({
  gatewayMock: {
    getCurrentAid: vi.fn(() => 0),
    fetchHotComments: vi.fn(async () => []),
    bgFetchJson: vi.fn()
  }
}));

// 热评缺省实现（defaultFetchHotComments）动态 import gateway：mock 保持确定性。
vi.mock("../../extension/bilibili/gateway.js", () => ({
  getCurrentAid: gatewayMock.getCurrentAid,
  fetchHotComments: gatewayMock.fetchHotComments,
  bgFetchJson: gatewayMock.bgFetchJson
}));

let state: TestState;
let ids: typeof import("../../extension/reader/state.js").ids;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
let lazyChat: typeof import("../../extension/core/lazy-chat-tab.js");
let explainIntent: typeof import("../../extension/reader/explain-intent.js");
let sidepanelState: typeof import("../../extension/chat/chat-state.js").sidepanelState;
let statusBus: typeof import("../../extension/shared/subtitle-status-bus.js");

// 假 offscreen 端口（chat-runtime 经 chrome.runtime.connect 取用）
interface FakePort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
}
const ports: FakePort[] = [];

type Sendstub = ReturnType<typeof vi.fn>;
function stubChromeByType(): void {
  const chromeStub = window.chrome as unknown as {
    runtime: { sendMessage: Sendstub; connect: Sendstub };
    storage: {
      local: { get: Sendstub; set: Sendstub };
      sync: { set: Sendstub };
      onChanged: { addListener: Sendstub; removeListener: Sendstub };
    };
  };
  chromeStub.runtime.sendMessage = vi.fn((message: { type?: string }, callback?: (resp: unknown) => void) => {
    const type = String(message?.type || "");
    if (type === "ai-providers-list") {
      callback?.({ ok: true, providers: [{ id: "p1", name: "平台一", model: "模型一", enabled: true }] });
    } else if (type === "get-settings") {
      callback?.({ ok: true, settings: {} });
    } else {
      callback?.({ ok: true });
    }
    return undefined;
  });
  chromeStub.runtime.connect = vi.fn(() => {
    const messageListeners: Array<(msg: unknown) => void> = [];
    const port: FakePort = {
      name: "offscreen-chat",
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: (msg: unknown) => void) => messageListeners.push(fn) },
      onDisconnect: { addListener: (_fn: () => void) => {} }
    };
    (port as FakePort & { __fire?: (msg: unknown) => void }).__fire = (msg: unknown) =>
      messageListeners.forEach((fn) => fn(msg));
    ports.push(port);
    return port;
  });
  chromeStub.storage.local.get = vi.fn(async () => ({}));
  chromeStub.storage.local.set = vi.fn(async () => {});
  chromeStub.storage.sync.set = vi.fn(async () => {});
}

// 等待异步链落定（轮询直到 predicate 成立或超时）——发送流程跨多层 await，
// 固定 sleep 对时序敏感，统一用条件轮询。
async function waitFor(predicate: () => boolean, { timeoutMs = 1000 } = {}): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function loadShell() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  ids = (await import("../../extension/reader/state.js")).ids;
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
  lazyChat = await import("../../extension/core/lazy-chat-tab.js");
  explainIntent = await import("../../extension/reader/explain-intent.js");
  sidepanelState = (await import("../../extension/chat/chat-state.js")).sidepanelState;
  statusBus = await import("../../extension/shared/subtitle-status-bus.js");
  uiRenderer.ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
}

function seedReadyContext(): void {
  state.clip.title = "测试视频";
  state.clip.bvid = "BV1test000000";
  state.clip.cid = "101";
  state.clip.aid = "7100";
  state.clip.subtitleFetchState = "ready";
  state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-boc-reader-mode");
  document.body.removeAttribute("data-boc-reader-mode");
  ports.length = 0;
  await loadShell();
  stubChromeByType();
  statusBus.publishSubtitleStatusPhase("idle");
});

describe("组合根装配与懒加载边界", () => {
  it("开壳不装载对话组合根；首切对话 tab 才装载并完成 init", async () => {
    // reader 域 + 壳已就绪，对话 tab 未触达：二级惰性未装载
    expect(lazyChat.isReaderChatTabLoaded()).toBe(false);
    seedReadyContext();

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    expect(lazyChat.isReaderChatTabLoaded()).toBe(true);
    // init 时序落定后的装配断言：
    // - 平台列表加载（stub 提供一个启用平台）→ 模型选择器可用且选中
    const modelSelect = document.getElementById(ids.readingChatModelSelect) as HTMLSelectElement;
    expect(modelSelect.disabled).toBe(false);
    expect(modelSelect.value).toBe("p1");
    // - 上下文加载（进程内直读 state.clip）→ context chip 显示视频标题
    const chip = document.getElementById(ids.readingChatContextChip) as HTMLButtonElement;
    expect(chip.textContent).toContain("测试视频");
    expect(chip.disabled).toBe(false);
    // - 初始态：无会话历史 → 空消息区 + 建议区（无居中错误）
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    expect(messages.querySelectorAll(".sp-center-error")).toHaveLength(0);
    expect(messages.querySelector(".sp-suggestions")).not.toBe(null);
  });

  it("重复激活幂等：不重跑 init（storage 读取次数不变）", async () => {
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const chromeStub = window.chrome as unknown as { storage: { local: { get: Sendstub } } };
    const getCalls = chromeStub.storage.local.get.mock.calls.length;

    await chat.ensureChatTabActivated();

    expect(chromeStub.storage.local.get.mock.calls.length).toBe(getCalls);
  });

  it("closeReadingView 在对话 tab 未装载时不触发懒加载（清理 no-op）", async () => {
    document.documentElement.setAttribute("data-boc-reader-mode", "1");
    document.body.setAttribute("data-boc-reader-mode", "1");
    const reader = await import("../../extension/reader/index.js");
    reader.closeReadingView();
    expect(lazyChat.isReaderChatTabLoaded()).toBe(false);
  });
});

describe("explain 意图消费（自动发送 + consume 一次）", () => {
  it("激活时渲染引用卡并自动发送解释提示词，发送成功即 consume", async () => {
    seedReadyContext();
    explainIntent.setPendingExplainIntent({ from: 10, content: "第二句话待解释", createdAt: Date.now() });

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    // 自动发送：解释提示词发出（offscreen 端口一条 chat 消息），提示词自带
    // 引用句与时间戳 pill 文案
    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    const posted = ports[0].postMessage.mock.calls[0][0] as { action?: string; prompt?: string };
    expect(posted.action).toBe("chat");
    expect(posted.prompt).toContain("第二句话待解释");
    expect(posted.prompt).toContain("00:10");
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    expect(input.value).toBe(""); // 发送受理后输入框清空

    // 发送成功即消费：一次意图只发一次，引用卡随之隐藏
    expect(explainIntent.consumePendingExplainIntent()).toBe(null);
    expect((document.getElementById(ids.readingChatIntent) as HTMLElement).hidden).toBe(true);

    await chat.ensureChatTabActivated();
    expect(ports).toHaveLength(1); // 无新意图：不再发送
  });

  it("引用卡取消按钮：清意图 + 隐卡（不自动发送）", async () => {
    // 无字幕收尾（empty 且字幕体为空）：发送被 no-subtitle 闸拦下，意图保持
    // pending、引用卡可见——取消按钮在此状态清意图。
    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "empty";
    state.clip.subtitleBody = [];
    explainIntent.setPendingExplainIntent({ from: 5, content: "待取消句", createdAt: Date.now() });

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    await waitFor(() =>
      Boolean((document.getElementById(ids.readingChatMessages) as HTMLElement).querySelector(".sp-context-notice"))
    );
    expect(ports).toHaveLength(0); // 发送被拦截
    const intentCard = document.getElementById(ids.readingChatIntent) as HTMLElement;
    expect(intentCard.hidden).toBe(false);

    // 容器层委托：对话 tab 根节点上的 [data-chat-intent-action] 点击
    const cancelBtn = intentCard.querySelector("[data-chat-intent-action='cancel']") as HTMLButtonElement;
    cancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(explainIntent.peekPendingExplainIntent()).toBe(null);
    expect(intentCard.hidden).toBe(true);
    expect(ports).toHaveLength(0); // 取消不触发发送
  });
});

describe("subtitle-wait kick 总线接线", () => {
  it("转写中发送被挂起；asr-done 相位驱动 kick 放行并发完整字幕", async () => {
    // 转写中：subtitleFetchState loading + 字幕体为空
    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "loading";
    state.clip.subtitleBody = [];
    explainIntent.setPendingExplainIntent({ from: 30, content: "转写中句", createdAt: Date.now() });

    const chat = await lazyChat.ensureReaderChatTab();
    // 模块求值即启动 init（bootstrap）；显式激活共享同一次 init promise
    const activation = chat.ensureChatTabActivated();

    // 转写相位（进程内总线；content script 收不到自己的广播）→ 提示行显示
    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    const asrNotice = document.getElementById(ids.readingChatAsrNotice) as HTMLElement;
    expect(asrNotice.hidden).toBe(false);
    expect(sidepanelState.asrTranscribingActive).toBe(true);

    // 发送被 subtitle-wait 挂起：未发起 port，意图保持 pending，等待提示在显
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    await waitFor(() => Boolean(messages.querySelector(".sp-context-notice")));
    expect(ports).toHaveLength(0);
    expect(explainIntent.peekPendingExplainIntent()).not.toBe(null);
    expect(messages.querySelector(".sp-context-notice")?.textContent).toContain("等待音频转写完成");

    // 转写完成（字幕落账 + 相位 asr-done）→ kick 补轮放行
    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
    statusBus.publishSubtitleStatusPhase("asr-done");

    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    const posted = ports[0].postMessage.mock.calls[0][0] as { prompt?: string; context?: { subtitleBody?: unknown[] } };
    expect(posted.prompt).toContain("转写中句");
    expect(posted.context?.subtitleBody).toHaveLength(1); // 转写完成后的完整字幕
    expect(explainIntent.consumePendingExplainIntent()).toBe(null);
    expect((document.getElementById(ids.readingChatIntent) as HTMLElement).hidden).toBe(true);
    // 等待提示清理 + asr 提示行收起
    expect(messages.querySelector(".sp-context-notice")).toBeNull();
    expect(asrNotice.hidden).toBe(true);
    await activation;
  });
});

describe("断流收口（工单 08：关闭即断流，重开从会话历史恢复）", () => {
  it("流式中关闭：断 port + 退出流式 UI 态；关闭后发送不再放行", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    input.value = "总结一下";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => ports.length === 1);

    const stopBtn = document.getElementById(ids.readingChatStopBtn) as HTMLButtonElement;
    expect(stopBtn.hidden).toBe(false);
    expect(input.disabled).toBe(true);

    chat.closeChatSession();

    expect(ports[0].disconnect).toHaveBeenCalledTimes(1);
    expect(stopBtn.hidden).toBe(true);
    expect(input.disabled).toBe(false);

    // 关闭后发送不再放行（不做后台续跑）：subtitle-wait 轮询闸住，无新 port
    input.value = "关闭后再发";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ports).toHaveLength(1);
  });

  it("重开（重新激活）：从会话历史恢复视图并重挂触发源", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    chat.closeChatSession();

    await chat.ensureChatTabActivated();

    // 恢复路径重渲消息区（关闭后残留的失败/半截节点清场）
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    expect(messages.querySelector(".sp-center-error")).toBeNull();
    expect(messages.querySelector(".sp-suggestions")).not.toBe(null);
    // 触发源重挂：相位总线又能驱动 asr 提示行
    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    expect((document.getElementById(ids.readingChatAsrNotice) as HTMLElement).hidden).toBe(false);
    statusBus.publishSubtitleStatusPhase("idle");
  });
});

describe("外点关闭单委托（chat-tab-bridge 并入 ui-renderer 文档级委托）", () => {
  it("点外关闭 popover、点内不关；重复激活不双挂监听", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    await chat.ensureChatTabActivated(); // 重复激活不重复注册（注册槽覆盖语义）

    // 文档级 click 委托已由 ensureUiReady 首建时绑定（含对话 tab 外点转发）

    const presetBtn = document.getElementById(ids.readingChatPresetBtn) as HTMLButtonElement;
    const presetPopover = document.getElementById(ids.readingChatPresetPopover) as HTMLElement;
    // dispatchEvent 恰好一次（setup 的 click 补丁会双触发，toggle 会开又关）
    presetBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(presetPopover.hidden).toBe(false);

    // 点击 popover 内部（冒泡到 document）：不关闭
    const presetList = document.getElementById(ids.readingChatPresetList) as HTMLElement;
    presetList.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(presetPopover.hidden).toBe(false);

    // 点击外部（冒泡到 document 的单一委托）：关闭
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    outside.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(presetPopover.hidden).toBe(true);
  });
});

describe("player-ai 快捷动作 seam（PR4b 概览笔记按钮同款）", () => {
  it("runQuickActionPrompt：定位对话 tab + 自动发送快捷提示词", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();

    const accepted = await chat.runQuickActionPrompt("整理这期视频的内容，输出结构化总结。");

    expect(accepted).toBe(true);
    const tabBodyChat = document.getElementById(ids.readingTabBodyChat) as HTMLElement;
    expect(tabBodyChat.classList.contains("is-active")).toBe(true);
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    expect(input.value).toBe(""); // 发送受理后输入框清空
    expect(ports).toHaveLength(1);
    const posted = ports[0].postMessage.mock.calls[0][0] as { prompt?: string };
    expect(posted.prompt).toBe("整理这期视频的内容，输出结构化总结。");
  });

  it("快捷动作不消费待解释意图（与解释自动发送互不踩踏）", async () => {
    seedReadyContext();
    explainIntent.setPendingExplainIntent({ from: 3, content: "挂起句", createdAt: Date.now() });
    const chat = await lazyChat.ensureReaderChatTab();

    await chat.runQuickActionPrompt("总结提示词");

    expect(explainIntent.peekPendingExplainIntent()).not.toBe(null);
    expect(ports).toHaveLength(1);
    const posted = ports[0].postMessage.mock.calls[0][0] as { prompt?: string };
    expect(posted.prompt).toBe("总结提示词");
  });
});
