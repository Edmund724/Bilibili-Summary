// tests/chat/context-inprocess.test.js
// 工单 08「消息链短路验收」的进程内直读重演（三事各一条 + 缺省热评实现的对账）：
//
//   ① 字幕签名未变 → 不重发字幕体到 offscreen：createInProcessContextFetch 的
//      签名短路命中（对应 message-handler reader-get-context 处理器现有签名
//      短路语义的进程内重演）→ loadContextState 走 SKIP_UNCHANGED（不落新
//      payload、contextKey 不变）→ chat-runtime 依 lastAckedContextKey 省略
//      字幕体。签名短路与 offscreen 省传的接力在进程内路径完整成立。
//
//   ② 首次上下文组装时拉热评（时机与消息链现状一致）：仅全量路径拉取（对应
//      getAiContextState「unchanged 已提前返回，热评只在全量路径」的时机），
//      热评合并进快照（对应 background 转发层的整体覆盖），并随快照附带
//      signature / isVideoContext 补写（分别对应 content 回执附签与背景层补写
//      职责）。forceRefresh 语义与消息链一致：忽略签名强制全量。
//
//   ③ ASR 转写中发送 → 走 subtitle-wait 等待而非发空上下文（事故史见
//      chat/subtitle-wait.ts 头注）：转写中（subtitleFetchState "loading" 且
//      字幕体为空 + asrTranscribingActive 兜底信号）时，组合根同款发送前编排
//      （loadContextState → subtitleWaiter.wait → 重取快照 → no-subtitle 拦截）
//      挂起发送、不发起 offscreen port；转写完成后（字幕体落账、签名变化）
//      kick 补轮放行，发出去的是转写完成后的完整字幕上下文。
//
//   ④ 缺省热评实现（defaultFetchHotComments）：重演 message-handler
//      reader-get-hot-comments 处理器语义——gateway 动态装载、getCurrentAid
//      判定、clipState.setHotComments 落账、失败降级空列表。
//
// 写法参照 tests/sidepanel 现有手法：resetModules 后同纪元导入被测模块与
// chat-state 单例并手动重置字段；deps 全注入（clip 受控快照/热评/定时器/port）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";

const { gatewayMock, clipStateMock } = vi.hoisted(() => ({
  gatewayMock: {
    getCurrentAid: vi.fn(),
    fetchHotComments: vi.fn()
  },
  clipStateMock: {
    setHotComments: vi.fn()
  }
}));

// 仅供缺省热评实现（④）命中的 mock；①②③ 注入自己的 fetchHotComments，
// 不触达这两个模块。context-load / chat-runtime 的静态 import 图不含
// core/state.js（sidepanel-payload 与 chat-state 对它是 type-only / 无依赖）。
vi.mock("../../extension/bilibili/gateway.js", () => ({
  getCurrentAid: gatewayMock.getCurrentAid,
  fetchHotComments: gatewayMock.fetchHotComments
}));
vi.mock("../../extension/core/state.js", () => ({
  clipState: clipStateMock
}));

let createInProcessContextFetch;
let createContextLoad;
let createChatRuntime;
let createSubtitleWaiter;
let isContextPending;
let sidepanelState;
let noSubtitle;

const VIDEO_URL = "https://www.bilibili.com/video/BV1test000000/";
const CONTEXT_KEY = "video:BV1test000000|101";
const HOT_COMMENTS = [{ uname: "热评君", message: "前方高能" }];

async function importModules() {
  const contextLoadModule = await import("../../extension/chat/context-load.js");
  createInProcessContextFetch = contextLoadModule.createInProcessContextFetch;
  createContextLoad = contextLoadModule.createContextLoad;
  const runtimeModule = await import("../../extension/chat/chat-runtime.js");
  createChatRuntime = runtimeModule.createChatRuntime;
  const waitModule = await import("../../extension/chat/subtitle-wait.js");
  createSubtitleWaiter = waitModule.createSubtitleWaiter;
  isContextPending = waitModule.isContextPending;
  noSubtitle = await import("../../extension/chat/no-subtitle.js");
  sidepanelState = (await import("../../extension/chat/chat-state.js")).sidepanelState;
}

// content 侧 state.clip 的受控替身（字段与 core/state.ts 的 ClipBusinessState
// 同形；payload 组装只读 createSidepanelContextPayload 的投影字段）。
function makeClip(overrides = {}) {
  return {
    currentUrl: VIDEO_URL,
    bvid: "BV1test000000",
    cid: "101",
    aid: "100",
    title: "测试视频",
    author: "UP 主",
    uploadDate: "2026-01-01",
    pageIndex: 1,
    pageCount: 1,
    pageTitle: "",
    videoDuration: 60,
    description: "",
    subtitles: [{ id: "s1", subtitleUrl: "https://example.com/s1", lan: "zh-CN" }],
    selectedSubtitleId: "s1",
    selectedSubtitleUrl: "https://example.com/s1",
    selectedSubtitleLang: "zh-CN",
    subtitleBody: [{ from: 0, to: 5, content: "第一句" }],
    subtitleFetchState: "ready",
    noSubtitleReason: null,
    chapters: [],
    hotComments: [],
    ...overrides
  };
}

// 进程内策略 + loadContextState 编排壳的组装（测试注入受控 clip 快照与热评）。
function makeContextHarness(clipRef, { hotComments = HOT_COMMENTS } = {}) {
  const fetchHotComments = vi.fn(async () => hotComments);
  const fetchContext = createInProcessContextFetch({
    clip: () => clipRef.current,
    settings: () => ({ includeTimestampInBody: true }),
    url: () => VIDEO_URL,
    fetchHotComments
  });
  const contextChip = document.createElement("button");
  document.body.appendChild(contextChip);
  const deps = {
    fetchContext,
    getActiveTab: vi.fn(async () => null),
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
  const contextLoad = createContextLoad(deps);
  return { fetchHotComments, contextLoad, deps, contextChip };
}

// chat-runtime 假 port / deps（沿 chat-runtime-stream.test.js 的手法）
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

function makeChatDeps(overrides = {}) {
  const messages = document.createElement("div");
  const input = document.createElement("textarea");
  const ports = [];
  const deps = {
    messages,
    input,
    ports,
    stopBtn: null,
    store: {
      persistCurrent: vi.fn(async () => {}),
      isCurrent: (id) => id === sidepanelState.currentConversationId
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
    }),
    ...overrides
  };
  return { deps };
}

async function send(runtime, deps, text) {
  deps.input.value = text;
  await runtime.sendMessage();
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  gatewayMock.getCurrentAid.mockReset();
  gatewayMock.fetchHotComments.mockReset();
  clipStateMock.setHotComments.mockReset();
  await importModules();
  sidepanelState.contextData = null;
  sidepanelState.currentContextKey = "";
  sidepanelState.chatHistory = [];
  sidepanelState.currentConversationId = "";
  sidepanelState.currentConversationMeta = null;
  sidepanelState.liveContextData = null;
  sidepanelState.liveContextKey = "";
  sidepanelState.liveTabUrl = "";
  sidepanelState.asrTranscribingActive = false;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// ===========================================================================
// 短路三事（工单 08 验收）
// ===========================================================================
describe("工单 08 短路三事（进程内直读路径）", () => {
  it("① 字幕签名未变 → 不重发字幕体到 offscreen：unchanged 短路 + lastAcked 省传接力", async () => {
    // 固定一份 clip 快照（状态未变 = 对象不换、内容不改）
    const clipRef = { current: makeClip() };
    const { fetchHotComments, contextLoad } = makeContextHarness(clipRef);

    // 首次全量组装：热评拉取 + 快照附 signature
    await contextLoad.loadContextState({ silent: true });
    expect(fetchHotComments).toHaveBeenCalledTimes(1);
    expect(sidepanelState.contextData.subtitleBody).toEqual([{ from: 0, to: 5, content: "第一句" }]);
    const signature = sidepanelState.liveContextData.signature;
    expect(signature).not.toBe("");
    expect(sidepanelState.currentContextKey).toBe(CONTEXT_KEY);

    // 首条消息：字幕体全量携带；offscreen 回执 cachedContextKey 确认单槽缓存
    const { deps } = makeChatDeps();
    const runtime = createChatRuntime(deps);
    await send(runtime, deps, "总结一下这个视频");
    expect(deps.ports).toHaveLength(1);
    const firstMsg = deps.ports[0].port.postMessage.mock.calls[0][0];
    expect(firstMsg.action).toBe("chat");
    expect(firstMsg.contextKey).toBe(CONTEXT_KEY);
    expect(firstMsg.context.subtitleBody).toEqual([{ from: 0, to: 5, content: "第一句" }]);
    deps.ports[0].listeners.message[0]({ type: "done", cachedContextKey: CONTEXT_KEY });
    expect(deps.ports[0].port.disconnect).toHaveBeenCalled();

    // 签名未变的一轮同步：进程内短路命中——不拉热评、不落新 payload
    //（对应 message-handler 现有签名短路语义的进程内重演）
    const contextDataBefore = sidepanelState.contextData;
    await contextLoad.loadContextState({ silent: true });
    expect(fetchHotComments).toHaveBeenCalledTimes(1);
    expect(sidepanelState.contextData).toBe(contextDataBefore);
    expect(sidepanelState.currentContextKey).toBe(CONTEXT_KEY);

    // 接力断言：追问消息因 contextKey 未变（lastAckedContextKey 命中）省略字幕体
    await send(runtime, deps, "第二章讲了什么？");
    expect(deps.ports).toHaveLength(2);
    const secondMsg = deps.ports[1].port.postMessage.mock.calls[0][0];
    expect(secondMsg.contextKey).toBe(CONTEXT_KEY);
    expect("subtitleBody" in secondMsg.context).toBe(false);
    expect(secondMsg.prompt).toBe("第二章讲了什么？");
  });

  it("② 首次上下文组装时拉热评：仅全量路径拉取并合并进快照（时机与消息链现状一致）", async () => {
    const clipRef = { current: makeClip() };
    const { fetchHotComments, contextLoad } = makeContextHarness(clipRef, {
      hotComments: HOT_COMMENTS
    });

    // 首次组装（全量路径）：热评拉取一次，合并进 contextData（背景层覆盖语义
    // 的进程内重演），并随快照补写 signature / isVideoContext
    await contextLoad.loadContextState({ silent: true });
    expect(fetchHotComments).toHaveBeenCalledTimes(1);
    expect(sidepanelState.contextData.hotComments).toEqual(HOT_COMMENTS);
    expect(sidepanelState.contextData.isVideoContext).toBe(true);
    expect(sidepanelState.contextData.signature).not.toBe("");

    // 签名未变：短路路径提前返回，不拉热评
    await contextLoad.loadContextState({ silent: true });
    expect(fetchHotComments).toHaveBeenCalledTimes(1);

    // forceRefresh：忽略签名强制全量 → 再次拉取（与消息链手动刷新语义一致）
    await contextLoad.loadContextState({ forceRefresh: true, silent: true });
    expect(fetchHotComments).toHaveBeenCalledTimes(2);
    expect(sidepanelState.contextData.hotComments).toEqual(HOT_COMMENTS);
  });

  it("③ ASR 转写中发送 → subtitle-wait 等待而非发空上下文；转写完成后放行完整字幕", async () => {
    // 转写进行中：字幕体为空 + fetchState "loading"；广播兜底信号活跃
    const clipRef = {
      current: makeClip({ subtitleBody: [], subtitleFetchState: "loading" })
    };
    const { fetchHotComments, contextLoad } = makeContextHarness(clipRef);
    await contextLoad.loadContextState({ silent: true });
    sidepanelState.asrTranscribingActive = true;

    // 组合根同款等待状态机组装（sidepanel.ts 的 pollContext 装配，数据源换成
    // 进程内 loadContextState 的 live 快照）
    const waitingNotice = vi.fn();
    const removeNotice = vi.fn();
    const timers = [];
    let timerSeq = 0;
    const subtitleWaiter = createSubtitleWaiter({
      pollIntervalMs: 4000,
      pollContext: async () => {
        const ok = await contextLoad.loadContextState({ forceRefresh: false, silent: true }).catch(() => false);
        // 等待期间读 liveContextData 保证数据不断供（组合根同款口径）
        const snapshot = ok ? (sidepanelState.liveContextData || sidepanelState.contextData) : null;
        return {
          ok: Boolean(snapshot),
          pending: isContextPending(snapshot, { asrTranscribingActive: sidepanelState.asrTranscribingActive })
        };
      },
      showWaitingNotice: waitingNotice,
      removeNotice,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return ++timerSeq;
      },
      clearTimer: (handle) => {
        const index = timers.findIndex((t) => t.id === handle || timers.indexOf(t) === handle - 1);
        if (index >= 0) {
          timers.splice(index, 1);
        }
      }
    });

    // 组合根同款发送前编排（ensureCurrentContextForSend 的非 pinned 分支）：
    // 静默加载 → subtitle-wait → 放行前重取 → 无字幕拦截判定
    const { deps } = makeChatDeps();
    deps.ensureCurrentContextForSend = vi.fn(async () => {
      const ok = await contextLoad.loadContextState({ forceRefresh: false, silent: true });
      if (!ok || !sidepanelState.contextData) {
        return false;
      }
      const ready = await subtitleWaiter.wait();
      if (!ready) {
        return false;
      }
      // 等待期间快照可能停在旧状态：放行前重取一次（组合根同款）
      await contextLoad.loadContextState({ forceRefresh: false, silent: true });
      if (!sidepanelState.contextData) {
        return false;
      }
      if (noSubtitle.isNoSubtitleEmptyContext(sidepanelState.contextData)) {
        return noSubtitle.NO_SUBTITLE_SEND_BLOCKED;
      }
      return true;
    });
    const runtime = createChatRuntime(deps);

    // 转写中发送：ensure 挂起在 wait()——不追加用户消息、不进流式 UI、
    // 不发起 port（空字幕上下文没有发出去）
    const sendPromise = send(runtime, deps, "总结一下这个视频");
    await flush();
    await flush();

    expect(deps.ensureCurrentContextForSend).toHaveBeenCalledTimes(1);
    expect(waitingNotice).toHaveBeenCalled();
    expect(deps.ports).toHaveLength(0);
    expect(deps.messages.querySelector(".sp-msg-user")).toBeNull();
    expect(deps.ui.setStreamingUiState).not.toHaveBeenCalledWith(true, expect.anything());
    // 等待轮询按 4s 间隔挂起（kick 前不推进）
    expect(timers).toHaveLength(1);

    // 转写完成：字幕体落账 + fetchState ready + 广播兜底信号熄灭（签名随之
    // 变化：subtitleBody 长度与 fetchState 参与签名投影）→ kick 立即补轮
    clipRef.current = makeClip();
    sidepanelState.asrTranscribingActive = false;
    subtitleWaiter.kick();
    await sendPromise;

    // 放行后发出的是转写完成后的完整字幕上下文（非空上下文）
    expect(deps.ports).toHaveLength(1);
    const chatMsg = deps.ports[0].port.postMessage.mock.calls[0][0];
    expect(chatMsg.action).toBe("chat");
    expect(chatMsg.prompt).toBe("总结一下这个视频");
    expect(Array.isArray(chatMsg.context.subtitleBody)).toBe(true);
    expect(chatMsg.context.subtitleBody.length).toBeGreaterThan(0);
    expect(chatMsg.context.subtitleFetchState).toBe("ready");
    // 等待结束 notice 清理；等待期间热评只在放行后的全量路径拉取
    expect(removeNotice).toHaveBeenCalled();
    expect(fetchHotComments.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// 缺省热评实现（defaultFetchHotComments）：message-handler 处理器语义对账
// ===========================================================================
describe("缺省热评实现（reader-get-hot-comments 处理器语义重演）", () => {
  function makeBareFetch(clipRef) {
    return createInProcessContextFetch({
      clip: () => clipRef.current,
      settings: () => ({ includeTimestampInBody: true }),
      url: () => VIDEO_URL
    });
  }

  it("有 aid：fetchHotComments(20) 拉取 + clipState.setHotComments 落账 + 合并进快照", async () => {
    gatewayMock.getCurrentAid.mockReturnValue("100");
    const comments = [{ uname: "u", message: "m" }];
    gatewayMock.fetchHotComments.mockResolvedValue(comments);
    const clipRef = { current: makeClip() };
    const fetchContext = makeBareFetch(clipRef);

    const outcome = await fetchContext({ forceRefresh: true, ifSignature: "" });

    expect(gatewayMock.fetchHotComments).toHaveBeenCalledWith(20);
    expect(clipStateMock.setHotComments).toHaveBeenCalledWith(comments);
    expect(outcome.kind).toBe("payload");
    expect(outcome.payload.hotComments).toEqual(comments);
  });

  it("无 aid：降级空列表 + clipState.setHotComments([])（不阻断全量路径）", async () => {
    gatewayMock.getCurrentAid.mockReturnValue(null);
    const clipRef = { current: makeClip() };
    const fetchContext = makeBareFetch(clipRef);

    const outcome = await fetchContext({ forceRefresh: true, ifSignature: "" });

    expect(gatewayMock.fetchHotComments).not.toHaveBeenCalled();
    expect(clipStateMock.setHotComments).toHaveBeenCalledWith([]);
    expect(outcome.kind).toBe("payload");
    expect(outcome.payload.hotComments).toEqual([]);
  });

  it("热评拉取失败：静默降级空列表 + 落账清空（不抛错、不阻断）", async () => {
    gatewayMock.getCurrentAid.mockReturnValue("100");
    gatewayMock.fetchHotComments.mockRejectedValue(new Error("网络错误"));
    const clipRef = { current: makeClip() };
    const fetchContext = makeBareFetch(clipRef);

    const outcome = await fetchContext({ forceRefresh: true, ifSignature: "" });

    expect(clipStateMock.setHotComments).toHaveBeenCalledWith([]);
    expect(outcome.kind).toBe("payload");
    expect(outcome.payload.hotComments).toEqual([]);
  });
});
