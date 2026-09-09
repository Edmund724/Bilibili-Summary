// Bug 回归回路（工单：点 AI 键偶发进的是字幕 tab 而不是 AI 对话）——单命令形状。
//
// 旧形状（双消息直发，已退役）：background 先发 reader-enter，content 侧处理器
// 「即答」后紧接着再直发 player-ai-quick-action-chat——两条链在 content 侧并发：
//   链 A（reader-enter → shell open）：ensureUiReady → … → enterReaderMode
//        → requestUiCommand("reset-tabs")（重置回「字幕」tab，无对话步）
//   链 B（quick-action-chat）：ensureUiReady → ensureReaderChatTab
//        → runQuickActionPrompt → requestUiCommand("set-tab:chat")
// 谁后落谁赢。链 B 的对话激活先落、链 A 的 reset-tabs 后落 ⇒ 最终停在
// 「字幕」tab——与生产偶发一致（胜负由两侧动态 chunk 装载快慢决定）。
//
// 新形状（单命令）：background 的 handlePlayerAiQuickAction 只发一条带 chat
// 负载的 reader-enter（经 triggerReaderModeInTab 的重试/注入链）；content 侧
// 对话激活收进 shell 进入事务体内（reader/shell.ts chat 档，单飞队列排尾），
// 在进入事务收敛（含 reset-tabs）后才落地——race 防护语义由事务队列保住。
//
// 本文件两段验证：
//   1. background 半边（handlePlayerAiQuickAction → triggerReaderChatInTab →
//      triggerReaderModeInTab）：只发一条 { type: "reader-enter", chat: { prompt } }，
//      无任何二次直发；重试耗尽回固定失败文案。
//   2. content 半边（dispatchContentScriptMessage）：带 chat 负载的 reader-enter
//      在进入事务收敛后激活对话 tab（输序 gate 钉死确定性红灯）；无 chat 负载
//      则零对话激活。断言面是真实 ui-renderer 订阅者写出的 DOM（is-active /
//      aria-selected / hidden 三通道）。
//
// 保真边界（content 半边；两个 tab 写手均为单行 reader-bus 命令，其余代码只
// 决定到达次序）：
//   - enterReaderMode 桩复刻 lifecycle.enterReaderMode 的 tab 相关行为
//     （setViewOpen(true) + requestUiCommand("reset-tabs")，lifecycle.ts:272-283）；
//   - runQuickActionPrompt 桩复刻 chat-tab.runQuickActionPrompt 的 tab 相关
//     行为（requestUiCommand("set-tab:chat", {consumeIntent:false})，
//     chat-tab.ts:655）。
// 两个写手之间的派发链（message-handler → shell → reader-bus 订阅者 →
// setReaderDigestTab）全部走真实模块。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { DEFAULT_PLAYER_AI_QUICK_PROMPT } from "../../extension/core/defaults.js";
import { sendMessageToTab } from "../../extension/shared/tab-utils.js";
import type { MessageSender, SendResponse } from "../../extension/shared/messaging-protocol.js";

vi.mock("../../extension/shared/tab-utils.js", () => ({
  sendMessageToTab: vi.fn(async () => ({ ok: true })),
  waitForTabComplete: vi.fn(async () => true)
}));
vi.mock("../../extension/reader/lazy-reader.js", () => ({
  ensureReaderDomain: vi.fn()
}));
vi.mock("../../extension/reader/lazy-chat-tab.js", () => ({
  ensureReaderChatTab: vi.fn(),
  isReaderChatTabLoaded: vi.fn(() => false)
}));
vi.mock("../../extension/ui/lazy-ui.js", () => ({
  ensureUiReady: vi.fn()
}));
vi.mock("../../extension/ai/lazy-player-ai.js", () => ({
  loadPlayerAi: vi.fn(),
  isPlayerAiLoaded: vi.fn(() => false)
}));
// shell 进入链的 replaceState：jsdom 下无谓改写地址，mock 掉（与 shell.test.ts 同款）
vi.mock("../../extension/bilibili/reader-url.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/bilibili/reader-url.js")>();
  return {
    ...actual,
    replaceReaderModeUrl: vi.fn()
  };
});

// ===== background 半边：单命令形状 =====

describe("background 半边：点 AI 键只发一条带 chat 负载的 reader-enter", () => {
  let onMessageListener: (message: unknown, sender: MessageSender, sendResponse: SendResponse) => boolean | void;

  beforeAll(async () => {
    // setup.js 的 chrome stub 缺 getManifest / tabs.onUpdated / runtime.onMessage
    //（background 顶层要注册监听器），这里装 superset 后动态装载 background。
    vi.stubGlobal("chrome", {
      runtime: {
        lastError: null,
        getURL: (path: string) => `chrome-extension://test/${path}`,
        sendMessage: vi.fn(),
        getManifest: () => ({ version: "9.9.9" }),
        onInstalled: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() }
      },
      tabs: { onUpdated: { addListener: vi.fn() } },
      storage: {
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
      }
    });
    await import("../../extension/entry/background.js");
    onMessageListener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];
  });

  // content 半边的用例依赖 setup.js 的 chrome stub：用例结束后摘掉本 describe
  // 的 superset，让 resetModuleState → setupEnvironment 重新装回通用 stub。
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.mocked(sendMessageToTab).mockClear();
    vi.mocked(sendMessageToTab).mockImplementation(async () => ({ ok: true }));
  });

  it("成功路径：单条 { type: reader-enter, chat: { prompt } }，无二次直发", async () => {
    const sendResponse = vi.fn();
    const keepOpen = onMessageListener({ type: "player-ai-quick-action", tabId: 7 }, { tab: { id: 7 } }, sendResponse);

    expect(keepOpen).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));

    expect(sendMessageToTab).toHaveBeenCalledTimes(1);
    expect(sendMessageToTab).toHaveBeenCalledWith(7, {
      type: "reader-enter",
      readerUrl: "",
      chat: { prompt: DEFAULT_PLAYER_AI_QUICK_PROMPT }
    });
  });

  it("重试耗尽：回固定失败文案，全程没有第二条消息", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(sendMessageToTab).mockImplementation(async () => ({ ok: false }));
      const sendResponse = vi.fn();
      onMessageListener({ type: "player-ai-quick-action", tabId: 7 }, { tab: { id: 7 } }, sendResponse);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(sendResponse).toHaveBeenCalledWith({
        ok: false,
        error: "阅读模式触发失败，请刷新浏览器网页重试"
      });
      expect(sendMessageToTab).toHaveBeenCalledTimes(12);
      expect(sendMessageToTab).toHaveBeenCalledWith(7, {
        type: "reader-enter",
        readerUrl: "",
        chat: { prompt: DEFAULT_PLAYER_AI_QUICK_PROMPT }
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ===== content 半边：对话激活在进入事务收敛后落地 =====

// 每用例 resetModules 后动态重取（setup.js 的全局 beforeEach 会清
// globalThis.__BOC_READER_BUS__ 槽；ui-renderer 的订阅在模块求值时注册，
// 必须每用例重新求值/装载，否则 subscribeUiCommand 落在已被清空的槽上）。
type Modules = {
  dispatch: typeof import("../../extension/entry/message-handler.js").dispatchContentScriptMessage;
  ensureReaderDomain: typeof import("../../extension/reader/lazy-reader.js").ensureReaderDomain;
  ensureReaderChatTab: typeof import("../../extension/reader/lazy-chat-tab.js").ensureReaderChatTab;
  ensureUiReady: typeof import("../../extension/ui/lazy-ui.js").ensureUiReady;
  requestUiCommand: typeof import("../../extension/reader/reader-bus.js").requestUiCommand;
  getReaderActiveDigestTab: typeof import("../../extension/reader/state.js").getReaderActiveDigestTab;
  state: typeof import("../../extension/core/state.js").state;
  ids: typeof import("../../extension/reader/state.js").ids;
  uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
};

function tabBody(ids: Modules["ids"], name: "Subtitle" | "Overview" | "Chat") {
  return document.getElementById(ids[`readingTabBody${name}`]) as HTMLElement;
}
function tabButton(ids: Modules["ids"], name: "Subtitle" | "Overview" | "Chat") {
  return document.getElementById(ids[`readingTab${name}`]) as HTMLElement;
}
function expectTabActive(
  ids: Modules["ids"],
  name: "Subtitle" | "Overview" | "Chat",
  active: boolean
) {
  expect(tabBody(ids, name).classList.contains("is-active"), `${name} body is-active`).toBe(active);
  expect(tabBody(ids, name).hasAttribute("hidden"), `${name} body hidden`).toBe(!active);
  expect(tabButton(ids, name).classList.contains("is-active"), `${name} button is-active`).toBe(active);
}

describe("单命令 reader-enter（带 chat 负载）的进入事务序", () => {
  let m: Modules;

  beforeEach(async () => {
    resetModuleState();
    setLocationUrl(NORMAL_PAGE_URL);
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-boc-reader-mode");
    document.body.removeAttribute("data-boc-reader-mode");

    const messageHandler = await import("../../extension/entry/message-handler.js");
    const lazyReader = await import("../../extension/reader/lazy-reader.js");
    const lazyChatTab = await import("../../extension/reader/lazy-chat-tab.js");
    const lazyUi = await import("../../extension/ui/lazy-ui.js");
    const readerBus = await import("../../extension/reader/reader-bus.js");
    const coreState = await import("../../extension/core/state.js");
    const readerState = await import("../../extension/reader/state.js");
    const uiRenderer = (await import("../../extension/ui/ui-renderer.js")) as Modules["uiRenderer"];

    m = {
      dispatch: messageHandler.dispatchContentScriptMessage,
      ensureReaderDomain: lazyReader.ensureReaderDomain,
      ensureReaderChatTab: lazyChatTab.ensureReaderChatTab,
      ensureUiReady: lazyUi.ensureUiReady,
      requestUiCommand: readerBus.requestUiCommand,
      state: coreState.state,
      ids: readerState.ids,
      getReaderActiveDigestTab: readerState.getReaderActiveDigestTab,
      uiRenderer
    };

    m.state.reader.setViewOpen(false);
    m.state.reader.setViewReady(false);

    // 预热壳：装载真实 ui-renderer（注册 set-tab:chat / reset-tabs 订阅者）并
    // 构建 Digest 面板 DOM。消息链的 ensureUiReady 桩走幂等 no-op，把「模块装载
    // 快慢」这一生产随机项从回路里钉掉，只留我们要测的事务序。
    uiRenderer.ensureUiReady();
    (m.ensureUiReady as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      uiRenderer.ensureUiReady();
    });

    // chat 档的对话 seam 桩（tab 相关行为 = chat-tab.ts:655 的 set-tab:chat）
    (m.ensureReaderChatTab as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      return {
        ensureChatTabActivated: vi.fn(async () => {}),
        runQuickActionPrompt: vi.fn(async (prompt: string) => {
          m.requestUiCommand("set-tab:chat", { consumeIntent: false });
          return Boolean(prompt);
        }),
        closeChatSession: vi.fn()
      };
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("输序（回归）：进入事务未收敛 ⇒ chat 激活排尾，事务收敛后最终停在对话 tab", async () => {
    const order: string[] = [];
    let releaseEnter: () => void = () => {};
    const enterGate = new Promise<void>((resolve) => {
      releaseEnter = resolve;
    });
    (m.ensureReaderDomain as ReturnType<typeof vi.fn>).mockResolvedValue({
      enterReaderMode: async () => {
        m.state.reader.setViewOpen(true);
        order.push("enter-start");
        await enterGate;
        order.push("reset-tabs");
        // lifecycle.enterReaderMode 的 tab 相关行为（lifecycle.ts:272-283）
        m.requestUiCommand("reset-tabs");
      }
    });

    // 生产消息序（新形状）：background 只发一条带 chat 负载的 reader-enter
    const sendResponse = vi.fn();
    m.dispatch({ type: "reader-enter", readerUrl: "", chat: { prompt: "总结" } }, sendResponse);

    // 即答语义：命令已受理入队即回 ok，不代表进入完成
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    await vi.waitFor(() => expect(order).toContain("enter-start"));
    // 进入事务被 gate 卡住 ⇒ 对话激活只能排尾，此时还没触碰对话 tab
    expect(m.ensureReaderChatTab).not.toHaveBeenCalled();

    // 放行 enterReaderMode 尾段：reset-tabs 落地、进入事务收敛
    releaseEnter();
    await vi.waitFor(() => expect(order).toContain("reset-tabs"));

    // 事务收敛后 chat 档才激活对话 tab：用户最终停在 AI 对话 tab
    //（双消息直发时代，无防护时 reset-tabs 后落会把对话 tab 盖回字幕 tab）
    await vi.waitFor(() => expectTabActive(m.ids, "Chat", true));
    expectTabActive(m.ids, "Chat", true);
    expectTabActive(m.ids, "Subtitle", false);
    expect(m.getReaderActiveDigestTab()).toBe("chat");
  });

  it("对照（赢序）：enterReaderMode 先收敛、chat 激活后落 ⇒ 停在对话 tab（绿灯）", async () => {
    const order: string[] = [];
    (m.ensureReaderDomain as ReturnType<typeof vi.fn>).mockResolvedValue({
      enterReaderMode: async () => {
        m.state.reader.setViewOpen(true);
        m.requestUiCommand("reset-tabs");
        order.push("enter-done");
      }
    });

    m.dispatch({ type: "reader-enter", readerUrl: "", chat: { prompt: "总结" } }, vi.fn());
    // 进入事务先收敛：tab 重置到默认字幕（信号用事务尾，不用 DOM——模板默认
    // 字幕 tab 即 active，DOM 判定分不出「进入事务已跑完」）
    await vi.waitFor(() => expect(order).toContain("enter-done"));

    await vi.waitFor(() => expectTabActive(m.ids, "Chat", true));

    expectTabActive(m.ids, "Chat", true);
    expectTabActive(m.ids, "Subtitle", false);
    expect(m.getReaderActiveDigestTab()).toBe("chat");
  });

  it("无 chat 负载：纯 open 意图，零对话激活", async () => {
    (m.ensureReaderDomain as ReturnType<typeof vi.fn>).mockResolvedValue({
      enterReaderMode: async () => {
        m.state.reader.setViewOpen(true);
        m.requestUiCommand("reset-tabs");
      }
    });

    const sendResponse = vi.fn();
    m.dispatch({ type: "reader-enter", readerUrl: "" }, sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(m.ensureReaderChatTab).not.toHaveBeenCalled();
    expectTabActive(m.ids, "Chat", false);
    expectTabActive(m.ids, "Subtitle", true);
  });
});
