// tests/reader/chat-tab-urlsync.test.ts
// URL 变化强刷调度（arch-slim 工单 05：chat/context-sync.ts 并回 chat-tab 后的
// 行为锁定）。原 createLiveContextSync 的 schedule 防抖状态机在单宿主现实下
// 只剩 boc:urlchange 一个触发源（恒强刷 → 120ms 快档防抖，重复触发即重置）。
//
// 独立成文件的原因：boc:urlchange 监听挂在 window 上，跨测试纪元（vi.reset-
// Modules 换代）的旧 chat-tab 模块实例无法摘除自己的监听；本文件每例收尾
// closeChatSession（unbindGlobalTriggers 摘监听），保证断言不被旧纪元污染。
//
// 全量路径的可数代理：mock gateway.getCurrentAid 返回真值后，
// defaultFetchHotComments 才会调用 gateway.fetchHotComments（默认恒 0 早退）。

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

vi.mock("../../extension/bilibili/gateway.js", () => ({
  getCurrentAid: gatewayMock.getCurrentAid,
  fetchHotComments: gatewayMock.fetchHotComments,
  bgFetchJson: gatewayMock.bgFetchJson
}));

let state: TestState;
let ids: typeof import("../../extension/reader/state.js").ids;
let lazyChat: typeof import("../../extension/core/lazy-chat-tab.js");

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
  chromeStub.runtime.connect = vi.fn(() => ({
    name: "offscreen-chat",
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: () => {} },
    onDisconnect: { addListener: () => {} }
  }));
  chromeStub.storage.local.get = vi.fn(async () => ({}));
  chromeStub.storage.local.set = vi.fn(async () => {});
  chromeStub.storage.sync.set = vi.fn(async () => {});
}

async function waitFor(predicate: () => boolean, { timeoutMs = 1000 } = {}): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  ids = (await import("../../extension/reader/state.js")).ids;
  lazyChat = await import("../../extension/core/lazy-chat-tab.js");
  (await import("../../extension/ui/ui-renderer.js")).ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
  stubChromeByType();
});

describe("URL 变化强刷调度（并回组合根后的 120ms 防抖）", () => {
  it("快速连发 boc:urlchange 只触发一轮全量同步（防抖重置，热评拉取恰 +1 次）", async () => {
    gatewayMock.getCurrentAid.mockReturnValue(7100);
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    await waitFor(() => gatewayMock.fetchHotComments.mock.calls.length >= 1); // init 首轮全量
    const baseline = gatewayMock.fetchHotComments.mock.calls.length;
    chat.closeChatSession(); // 摘本纪元监听，隔离后续断言

    // 下一纪元（模拟重开后的对话 tab）：单一触发源恒为强刷，重复调度即防抖重置
    const reopened = await lazyChat.ensureReaderChatTab();
    await reopened.ensureChatTabActivated();
    const reopenedBaseline = gatewayMock.fetchHotComments.mock.calls.length;

    window.dispatchEvent(new Event("boc:urlchange"));
    window.dispatchEvent(new Event("boc:urlchange"));
    window.dispatchEvent(new Event("boc:urlchange"));
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(gatewayMock.fetchHotComments.mock.calls.length).toBe(reopenedBaseline + 1);
    expect(reopenedBaseline).toBeGreaterThanOrEqual(baseline);
    reopened.closeChatSession();
  });

  it("防抖到期的强刷反映最新 clip 状态（context chip 更新为新标题）", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    await waitFor(() => gatewayMock.fetchHotComments.mock.calls.length >= 1);

    state.clip.title = "防抖后的新标题";
    window.dispatchEvent(new Event("boc:urlchange"));
    await new Promise((resolve) => setTimeout(resolve, 250));

    const chip = document.getElementById(ids.readingChatContextChip) as HTMLButtonElement;
    expect(chip.textContent).toContain("防抖后的新标题");
    chat.closeChatSession();
  });
});
