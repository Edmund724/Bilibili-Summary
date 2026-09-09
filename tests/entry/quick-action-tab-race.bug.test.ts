// Bug 回归回路（工单：点 AI 键偶发进的是字幕 tab 而不是 AI 对话）。
//
// 复现机制（background.ts handlePlayerAiQuickAction → triggerReaderChatInTab）：
// 视图未开时 background 先发 reader-enter（intent=open），content 侧处理器
// 「即答」后 background 立刻再发 player-ai-quick-action-chat——两条链在
// content 侧并发：
//   链 A（reader-enter → shell open）：ensureUiReady → … → enterReaderMode
//        → requestUiCommand("reset-tabs")（重置回「字幕」tab，无对话步）
//   链 B（quick-action-chat）：ensureUiReady → ensureReaderChatTab
//        → runQuickActionPrompt → requestUiCommand("set-tab:chat")
// 谁后落谁赢。链 B 的对话激活先落、链 A 的 reset-tabs 后落 ⇒ 最终停在
// 「字幕」tab——与生产偶发一致（胜负由两侧动态 chunk 装载快慢决定）。
//
// 本文件用受控 gate 把「输序」钉死成确定性红灯：链 B 先激活对话 tab，
// 再放行链 A 的 enterReaderMode。断言面是真实 ui-renderer 订阅者写出的
// DOM（is-active / aria-selected / hidden 三通道）。
//
// 保真边界（两条链的最终 tab 写手均为单行 reader-bus 命令，其余代码只决定
// 到达次序）：
//   - enterReaderMode 桩复刻 lifecycle.enterReaderMode 的 tab 相关行为
//     （setViewOpen(true) + requestUiCommand("reset-tabs")，lifecycle.ts:272-283）；
//   - runQuickActionPrompt 桩复刻 chat-tab.runQuickActionPrompt 的 tab 相关
//     行为（requestUiCommand("set-tab:chat", {consumeIntent:false})，
//     chat-tab.ts:655）。
// 两个写手之间的派发链（message-handler → shell → reader-bus 订阅者 →
// setReaderDigestTab）全部走真实模块。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";

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

// 每用例 resetModules 后动态重取（setup.js 的全局 beforeEach 会清
// globalThis.__BOC_READER_BUS__ 槽；ui-renderer 的订阅在模块求值时注册，
// 必须每用例重新求值/装载，否则 subscribeUiCommand 落在已被清空的槽上）。
type Modules = {
  dispatch: typeof import("../../extension/entry/message-handler.js").dispatchContentScriptMessage;
  ensureReaderDomain: typeof import("../../extension/reader/lazy-reader.js").ensureReaderDomain;
  ensureReaderChatTab: typeof import("../../extension/reader/lazy-chat-tab.js").ensureReaderChatTab;
  ensureUiReady: typeof import("../../extension/ui/lazy-ui.js").ensureUiReady;
  requestUiCommand: typeof import("../../extension/reader/reader-bus.js").requestUiCommand;
  state: typeof import("../../extension/core/state.js").state;
  ids: typeof import("../../extension/reader/state.js").ids;
  uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
};

let m: Modules;

function tabBody(name: "Subtitle" | "Overview" | "Chat") {
  return document.getElementById(m.ids[`readingTabBody${name}`]) as HTMLElement;
}
function tabButton(name: "Subtitle" | "Overview" | "Chat") {
  return document.getElementById(m.ids[`readingTab${name}`]) as HTMLElement;
}
function expectTabActive(name: "Subtitle" | "Overview" | "Chat", active: boolean) {
  expect(tabBody(name).classList.contains("is-active"), `${name} body is-active`).toBe(active);
  expect(tabBody(name).hasAttribute("hidden"), `${name} body hidden`).toBe(!active);
  expect(tabButton(name).classList.contains("is-active"), `${name} button is-active`).toBe(active);
}

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
    uiRenderer
  };

  m.state.reader.setViewOpen(false);
  m.state.reader.setViewReady(false);

  // 预热壳：装载真实 ui-renderer（注册 set-tab:chat / reset-tabs 订阅者）并
  // 构建 Digest 面板 DOM。消息链的 ensureUiReady 桩走幂等 no-op，把「模块装载
  // 快慢」这一生产随机项从回路里钉掉，只留我们要测的消息交错序。
  uiRenderer.ensureUiReady();
  (m.ensureUiReady as ReturnType<typeof vi.fn>).mockImplementation(async () => {
    uiRenderer.ensureUiReady();
  });

  // 链 B 的对话 seam 桩（tab 相关行为 = chat-tab.ts:655 的 set-tab:chat）
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

describe("AI 键（player-ai-quick-action）进对话 tab 的消息序竞态", () => {
  it("输序（回归）：reader-enter 事务未收敛时 quick-action-chat 到达 ⇒ 事务收敛后最终停在对话 tab", async () => {
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

    // 生产消息序（background.triggerReaderChatInTab）：先 reader-enter，即答后
    // 紧接着 player-ai-quick-action-chat——两条链并发起跑
    m.dispatch({ type: "reader-enter", readerUrl: "" }, vi.fn());
    await vi.waitFor(() => expect(order).toContain("enter-start"));
    m.dispatch({ type: "player-ai-quick-action-chat", prompt: "总结" }, vi.fn());

    // 放行链 A 的 enterReaderMode 尾段：reset-tabs 落地、进入事务收敛
    releaseEnter();
    await vi.waitFor(() => expect(order).toContain("reset-tabs"));

    // 修复语义：quick-action-chat 等进入事务收敛后再激活对话 tab——用户最终
    // 停在 AI 对话 tab（未修复时 reset-tabs 后落把对话 tab 盖回字幕 tab）
    await vi.waitFor(() => expectTabActive("Chat", true));
    expectTabActive("Chat", true);
    expectTabActive("Subtitle", false);
  });

  it("对照（赢序）：enterReaderMode 先收敛、对话激活后落 ⇒ 停在对话 tab（绿灯）", async () => {
    const order: string[] = [];
    (m.ensureReaderDomain as ReturnType<typeof vi.fn>).mockResolvedValue({
      enterReaderMode: async () => {
        m.state.reader.setViewOpen(true);
        m.requestUiCommand("reset-tabs");
        order.push("enter-done");
      }
    });

    m.dispatch({ type: "reader-enter", readerUrl: "" }, vi.fn());
    // 链 A 先收敛：进入事务完成、tab 重置到默认字幕（信号用事务尾，不用 DOM——
    // 模板默认字幕 tab 即 active，DOM 判定分不出「链 A 已跑完」）
    await vi.waitFor(() => expect(order).toContain("enter-done"));

    m.dispatch({ type: "player-ai-quick-action-chat", prompt: "总结" }, vi.fn());
    await vi.waitFor(() => expectTabActive("Chat", true));

    expectTabActive("Chat", true);
    expectTabActive("Subtitle", false);
  });
});
