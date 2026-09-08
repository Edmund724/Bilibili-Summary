// tests/reader/chat-tab.test.ts
// PR5 AI 对话 tab 组合根（reader/chat-tab.ts）回归测试：真实模板（ensureUiReady）
// + 二级惰性装载（reader/lazy-chat-tab）。
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
// 模块纪元注意：chatSessionState 与组合根闭包都是模块级单例，beforeEach
// resetModules 后同纪元导入；chrome.storage / runtime 消息按 type 路由 stub。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

const { gatewayMock, gatewayCoreMock } = vi.hoisted(() => ({
  gatewayMock: {
    getCurrentAid: vi.fn(() => 0),
    fetchHotComments: vi.fn(async (_count?: number) => [])
  },
  gatewayCoreMock: {
    bgFetchJson: vi.fn(),
    isBiliUrl: vi.fn(() => true)
  }
}));

// 热评编排已收口为 gateway.fetchHotCommentsWithLedger（arch-review-2026-09/07），
// context-assembly 静态 import——mock 保持确定性：接缝替身经 gatewayMock 的
// getCurrentAid/fetchHotComments 重演单源形状（落账不在本文件断言面），
// fetchHotComments 调用计数语义不变。
// gateway 拆叶（arch-slim-2/04）：bgFetchJson 已迁 gateway-core（经
// ai/context-resolver 被对话链消费）。
vi.mock("../../extension/bilibili/gateway.js", () => ({
  getCurrentAid: gatewayMock.getCurrentAid,
  fetchHotComments: gatewayMock.fetchHotComments,
  fetchHotCommentsWithLedger: async () => {
    if (!gatewayMock.getCurrentAid()) {
      return { comments: [], note: "无法获取视频 aid" };
    }
    try {
      return { comments: await gatewayMock.fetchHotComments(20) };
    } catch (error) {
      return { comments: [], note: String((error as Error)?.message || error) };
    }
  }
}));
vi.mock("../../extension/bilibili/gateway-core.js", () => ({
  bgFetchJson: gatewayCoreMock.bgFetchJson,
  isBiliUrl: gatewayCoreMock.isBiliUrl
}));

let state: TestState;
let ids: typeof import("../../extension/reader/state.js").ids;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
let lazyChat: typeof import("../../extension/reader/lazy-chat-tab.js");
let explainIntent: typeof import("../../extension/reader/explain-intent.js");
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;
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
  lazyChat = await import("../../extension/reader/lazy-chat-tab.js");
  explainIntent = await import("../../extension/reader/explain-intent.js");
  chatSessionState = (await import("../../extension/chat/chat-state.js")).chatSessionState;
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
    expect(messages.querySelectorAll(".chat-center-error")).toHaveLength(0);
    expect(messages.querySelector(".chat-suggestions")).not.toBe(null);
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
    expect(posted.prompt).toContain("0:10"); // arch-slim-2/08 拍板 Q1：不补零
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
      Boolean((document.getElementById(ids.readingChatMessages) as HTMLElement).querySelector(".chat-context-notice"))
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
    expect(chatSessionState.asrTranscribingActive).toBe(true);

    // 发送被 subtitle-wait 挂起：未发起 port，意图保持 pending；
    // 等待提示并入转写状态行（合成一句，消息区不再另起 .chat-context-notice）
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    await waitFor(() => Boolean(asrNotice.textContent?.includes("完成后自动开始总结")));
    expect(ports).toHaveLength(0);
    expect(explainIntent.peekPendingExplainIntent()).not.toBe(null);
    expect(messages.querySelector(".chat-context-notice")).toBeNull();

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
    expect(messages.querySelector(".chat-context-notice")).toBeNull();
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
    expect(messages.querySelector(".chat-center-error")).toBeNull();
    expect(messages.querySelector(".chat-suggestions")).not.toBe(null);
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

describe("历史回放分片让出（P2-1：50ms 预算 + scheduler.yield/setTimeout 兜底）", () => {
  const REPLAY_MESSAGES = [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "第二问" },
    { role: "assistant", content: "第二答" },
    { role: "user", content: "第三问" },
    { role: "assistant", content: "第三答" }
  ];

  let nowSpy: ReturnType<typeof vi.spyOn> | null = null;

  afterEach(() => {
    nowSpy?.mockRestore();
    nowSpy = null;
  });

  // 每条消息后都越过 50ms 预算：让出路径（jsdom 无 scheduler → setTimeout 0
  // 兜底）逐条走一遍，把「一次同步 append」与「分片 append」的差异放大到可观测。
  function forceYieldEveryMessage(): void {
    let clock = 0;
    nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
      clock += 60;
      return clock;
    });
  }

  // 存档一条匹配当前上下文的会话（bvid/cid 与 seedReadyContext 一致），
  // init 的 restoreLatest 命中后走历史回放路径。
  function seedSavedConversation(messages = REPLAY_MESSAGES): void {
    const chromeStub = window.chrome as unknown as {
      storage: { local: { get: ReturnType<typeof vi.fn> } };
    };
    chromeStub.storage.local.get = vi.fn(async () => ({
      boc_ai_conversations_v1: [
        {
          id: "conv-replay",
          title: "测试视频",
          contextKey: "video:BV1test000000|101",
          contextTitle: "测试视频",
          contextUrl: "https://www.bilibili.com/video/BV1test000000/",
          isVideoContext: true,
          createdAt: 1000,
          updatedAt: 2000,
          contextRef: {
            bvid: "BV1test000000",
            cid: "101",
            url: "https://www.bilibili.com/video/BV1test000000/"
          },
          messages
        }
      ]
    }));
  }

  it("按序分片渲染、内容不变，滚底只在全部上屏后发生一次", async () => {
    seedReadyContext();
    seedSavedConversation();
    forceYieldEveryMessage();
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    // 记录 scrollTop 写入次数：分片期间不应滚动，末尾统一收尾恰一次。
    const scrollWrites: number[] = [];
    let scrollTopValue = 0;
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollWrites.push(value);
        scrollTopValue = value;
      }
    });

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    // 分片证据：激活返回时回放尚未跑完（旧同步实现此处已全部上屏）。
    const earlyCount = messages.querySelectorAll(".chat-msg").length;
    expect(earlyCount).toBeGreaterThan(0);
    expect(earlyCount).toBeLessThan(REPLAY_MESSAGES.length);

    await waitFor(() => messages.querySelectorAll(".chat-msg").length === REPLAY_MESSAGES.length);
    const rendered = [...messages.querySelectorAll(".chat-msg")];
    expect(rendered.map((node) => node.className)).toEqual([
      "chat-msg chat-msg-user",
      "chat-msg chat-msg-assistant",
      "chat-msg chat-msg-user",
      "chat-msg chat-msg-assistant",
      "chat-msg chat-msg-user",
      "chat-msg chat-msg-assistant"
    ]);
    expect(rendered.map((node) => node.textContent?.trim())).toEqual([
      "第一问",
      "第一答",
      "第二问",
      "第二答",
      "第三问",
      "第三答"
    ]);
    // 全部上屏后才滚底（且恰一次）：末条 append 与收尾滚动之间还有一次让出，
    // 故按 scrollWrites 计数等收尾落定，而不是按消息条数。
    await waitFor(() => scrollWrites.length > 0);
    expect(scrollWrites).toHaveLength(1);
  });

  it("回放让出期间发送：新消息等回放落定后追加在末尾（不插进中间）", async () => {
    seedReadyContext();
    seedSavedConversation();
    forceYieldEveryMessage();

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;

    // 回放尚未完成（首片之后即让出）就回车发送
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    input.value = "回放中的新问题";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    await waitFor(() => messages.querySelectorAll(".chat-msg").length === REPLAY_MESSAGES.length + 2);
    const texts = [...messages.querySelectorAll(".chat-msg")].map((node) => node.textContent?.trim());
    expect(texts.slice(0, REPLAY_MESSAGES.length)).toEqual([
      "第一问",
      "第一答",
      "第二问",
      "第二答",
      "第三问",
      "第三答"
    ]);
    // 新用户消息在回放内容之后，助手占位紧随其后
    expect(texts[REPLAY_MESSAGES.length]).toBe("回放中的新问题");
    expect(texts[REPLAY_MESSAGES.length + 1]).toBe("");
    const posted = ports[0].postMessage.mock.calls[0][0] as { prompt?: string; history?: unknown[] };
    expect(posted.prompt).toBe("回放中的新问题");
  });
});

describe("resize 合帧（P2-3：model-select 宽度重算走 rAF 而非同步）", () => {
  it("resize 不同步写宽度，帧落定后按计算结果写入", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    const modelSelect = document.getElementById(ids.readingChatModelSelect) as HTMLSelectElement;
    modelSelect.style.width = "";

    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));

    // 合帧：帧回调执行前不写宽度（旧同步实现此处已是 92px）。
    expect(modelSelect.style.width).toBe("");

    await waitFor(() => modelSelect.style.width !== "");
    // jsdom 无布局：toolbar 存在但 clientWidth 恒 0 → 上限触底 92，与直接
    // 调用 updateModelSelectWidth 同结果（tests/ui/model-select-width.test.js
    // 另锁「一帧至多一帧」的合帧计数）。
    expect(modelSelect.style.width).toBe("92px");
  });
});

describe("无平台空态「前往设置」（arch-slim-2/06 死绑定回归）", () => {
  it("后建链接经 #readingChatRoot 容器委托打开设置抽屉", async () => {
    // 无平台：ai-providers-list 返回空列表 → renderInitialState 走「还没有配置
    // AI 平台」分支，「前往设置」链接由 resetConversationView 用 innerHTML 后建。
    // 历史缺陷：ui-renderer 曾在壳构建时 getElementById 直绑——绑定时点早于
    // 元素诞生，监听器永远挂不上，无平台空态点「前往设置」无任何效果。
    const chromeStub = window.chrome as unknown as { runtime: { sendMessage: Sendstub } };
    chromeStub.runtime.sendMessage = vi.fn((message: { type?: string }, callback?: (resp: unknown) => void) => {
      if (String(message?.type || "") === "ai-providers-list") {
        callback?.({ ok: true, providers: [] });
      } else {
        callback?.({ ok: true });
      }
      return undefined;
    });

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    // 无平台空态已渲染：链接存在（后建于消息区），设置抽屉此前关闭
    const link = document.getElementById(ids.readingChatOpenSettings) as HTMLAnchorElement | null;
    expect(link).not.toBe(null);
    const settingsPanel = document.getElementById(ids.readingSettingsPanel) as HTMLElement;
    expect(settingsPanel.hidden).toBe(true);
    expect(state.reader.readingSettingsExpanded).toBe(false);

    // 容器委托命中（冒泡到 #readingChatRoot）：展开设置并渲染面板
    link!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(state.reader.readingSettingsExpanded).toBe(true);
    // renderReaderPanels 经 ui/reader-gate 异步装载 reader 域后写 hidden
    await waitFor(() => !settingsPanel.hidden);
  });
});
