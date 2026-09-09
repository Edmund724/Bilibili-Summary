// 工具栏 action 点击（工单 02-toolbar-icon-opens-digest）——toolbar-* 命名
//（entry 测试 scope 限制）。
//
// 两段验证：
//   1. SW 半边：chrome.action.onClicked 只认事件自带的活动标签页；受支持的
//      B 站视频/稍后再看页派发单条 reader-enter（经 triggerReaderModeInTab 的
//      重试/注入链），载荷与页内 Digest 按钮同源 buildReaderModeUrl 且不含
//      tabId 字段（跨标签页消息无从伪造目标）；非受支持页/缺 tab id 零派发；
//      重复点击与活动标签页切换各投递到当次事件标签页，重试不换目标。
//   2. 等价性（content 半边）：工具栏载荷与页内按钮点击走同一条
//      dispatchContentScriptMessage → ensureReaderShell 进入事务——同消息形状、
//      同 readerUrl 拼法、同 open 意图。
//
// harness 与 quick-action-tab-race.bug.test.ts 同款：SW 半边 superset stub
// chrome 后动态装载 background.js，摘 stub 后 content 半边回到 setup.js 通用
// stub + 每用例干净模块纪元。shell 的 enterReaderShell mock 挂 vi.hoisted
// 槽跨纪元共享（resetModules 只换模块实例，不换 hoisted 槽）。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { sendMessageToTab } from "../../extension/shared/tab-utils.js";
import { buildReaderModeUrl } from "../../extension/bilibili/video-id-shared.js";

vi.mock("../../extension/shared/tab-utils.js", () => ({
  sendMessageToTab: vi.fn(async () => ({ ok: true })),
  waitForTabComplete: vi.fn(async () => true)
}));

const VIDEO_URL = "https://www.bilibili.com/video/BV1abc000000/?p=2&spm_id_from=x";
const VIDEO_READER_URL = "https://www.bilibili.com/video/BV1abc000000/?p=2&boc_reader=1";

// ===== SW 半边：action onClicked → 同一条 reader-enter 事务 =====

describe("SW 半边：action onClicked → 同一 reader-enter 事务", () => {
  let onClickedListener: (tab: chrome.tabs.Tab) => void;
  const actionOnClickedAddListener = vi.fn();

  beforeAll(async () => {
    // setup.js 的 chrome stub 缺 action.onClicked / getManifest / tabs.onUpdated
    //（background 顶层要同步注册监听器），装 superset 后动态装载 background。
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
      action: { onClicked: { addListener: actionOnClickedAddListener } },
      storage: {
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
      }
    });
    await import("../../extension/entry/background.js");
    onClickedListener = actionOnClickedAddListener.mock.calls[0][0] as typeof onClickedListener;
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

  it("受支持视频页：单条 reader-enter 直达事件标签页，readerUrl 与页内按钮同源拼法，载荷无 tabId", async () => {
    onClickedListener({ id: 7, url: VIDEO_URL });

    await vi.waitFor(() => expect(sendMessageToTab).toHaveBeenCalledTimes(1));

    // readerUrl = buildReaderModeUrl(tab.url)：cleanVideoUrl 清掉非视频参数
    // （spm_id_from）保留分 P 后加 boc_reader=1，与页内按钮同源单源拼法。
    expect(sendMessageToTab).toHaveBeenCalledWith(7, {
      type: "reader-enter",
      readerUrl: VIDEO_READER_URL
    });
    const payload = vi.mocked(sendMessageToTab).mock.calls[0][1] as Record<string, unknown>;
    // 目标只取事件标签页：载荷不得携带 tabId（伪造目标的结构性不可能）。
    expect(payload).not.toHaveProperty("tabId");
  });

  it("稍后再看页：同样派发，readerUrl 收敛为规范视频 URL", async () => {
    onClickedListener({ id: 8, url: "https://www.bilibili.com/list/watchlater?bvid=BV1wl000001" });

    await vi.waitFor(() => expect(sendMessageToTab).toHaveBeenCalledTimes(1));

    expect(sendMessageToTab).toHaveBeenCalledWith(8, {
      type: "reader-enter",
      readerUrl: "https://www.bilibili.com/video/BV1wl000001/?boc_reader=1"
    });
  });

  it("非 B 站页 / 非视频路径 / 缺 tab.url / 缺 tab.id：零派发", async () => {
    onClickedListener({ id: 7, url: "https://example.com/video/BV1abc000000/" });
    onClickedListener({ id: 7, url: "https://www.bilibili.com/" });
    onClickedListener({ id: 7 });
    onClickedListener({ url: VIDEO_URL });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendMessageToTab).not.toHaveBeenCalled();
  });

  it("重复点击与活动标签页切换：各次点击只投递到当次事件标签页", async () => {
    onClickedListener({ id: 7, url: VIDEO_URL });
    await vi.waitFor(() => expect(sendMessageToTab).toHaveBeenCalledTimes(1));

    onClickedListener({ id: 9, url: "https://www.bilibili.com/video/BV1def000000/" });
    await vi.waitFor(() => expect(sendMessageToTab).toHaveBeenCalledTimes(2));

    const targets = vi.mocked(sendMessageToTab).mock.calls.map((call) => call[0]);
    expect(targets).toEqual([7, 9]);
  });

  it("重试不换目标：触发失败时 12 次重试全部指向事件标签页", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(sendMessageToTab).mockImplementation(async () => ({ ok: false }));
      onClickedListener({ id: 7, url: VIDEO_URL });

      await vi.advanceTimersByTimeAsync(60_000);

      expect(sendMessageToTab).toHaveBeenCalledTimes(12);
      expect(vi.mocked(sendMessageToTab).mock.calls.every((call) => call[0] === 7)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ===== 等价性：工具栏载荷与页内 Digest 按钮走同一进入事务 =====

const shellMocks = vi.hoisted(() => ({
  enterReaderShell: vi.fn(
    async (_options: { readerUrl: string; intent: string; prompt?: string }) => {}
  )
}));

vi.mock("../../extension/reader/lazy-shell.js", () => ({
  ensureReaderShell: vi.fn(async () => ({
    enterReaderShell: shellMocks.enterReaderShell,
    enterReaderShellOnUrlNavigation: vi.fn(async () => {}),
    exitReaderShell: vi.fn(async () => {})
  }))
}));
vi.mock("../../extension/reader/lazy-reader.js", () => ({
  ensureReaderDomain: vi.fn()
}));
vi.mock("../../extension/ui/lazy-ui.js", () => ({
  ensureUiReady: vi.fn(async () => {})
}));
vi.mock("../../extension/ai/lazy-player-ai.js", () => ({
  loadPlayerAi: vi.fn(),
  isPlayerAiLoaded: vi.fn(() => false)
}));

function makeToolbarHtml() {
  return `
    <div id="arc_toolbar_report">
      <div class="video-toolbar-right">
        <div class="video-complaint"><span>稿件举报</span></div>
      </div>
    </div>`;
}

describe("工具栏载荷与页内 Digest 按钮的进入事务等价", () => {
  beforeEach(() => {
    resetModuleState();
    setLocationUrl(NORMAL_PAGE_URL);
    document.body.innerHTML = "";
    shellMocks.enterReaderShell.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("工具栏载荷经 content 分发进入同一 reader-enter 事务（open 意图，无 chat）", async () => {
    const { dispatchContentScriptMessage } = await import("../../extension/entry/message-handler.js");
    const sendResponse = vi.fn();

    // 工具栏在 tab.url === NORMAL_PAGE_URL 时派发的载荷（SW 半边断言的形状）。
    const keepOpen = dispatchContentScriptMessage(
      { type: "reader-enter", readerUrl: buildReaderModeUrl(NORMAL_PAGE_URL) },
      sendResponse
    );

    expect(keepOpen).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    expect(shellMocks.enterReaderShell).toHaveBeenCalledTimes(1);
    expect(shellMocks.enterReaderShell).toHaveBeenCalledWith({
      readerUrl: buildReaderModeUrl(NORMAL_PAGE_URL),
      intent: "open"
    });
  });

  it("页内按钮点击与工具栏路径产生相同的事务参数（同 readerUrl / 同 open 意图）", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;

    // 生产时序：content.ts init() 先 bindRuntimeEvents 注册分发主体，digest
    // 按钮后装载——与本用例动态 import 同一模块纪元。
    const handler = await import("../../extension/entry/message-handler.js");
    handler.bindRuntimeEvents();
    const lazy = await import("../../extension/ui/lazy-digest-button.js");
    await lazy.loadDigestButton();

    const button = document.getElementById("boc-digest-button");
    expect(button).not.toBeNull();
    button!.click();

    await vi.waitFor(() => expect(shellMocks.enterReaderShell).toHaveBeenCalledTimes(1));

    const options = shellMocks.enterReaderShell.mock.calls[0][0];

    // 页内按钮的 readerUrl（buildReaderModeUrl(location.href)）与工具栏在同
    // 一 URL 上派发的 readerUrl 完全一致；意图同为 open、无快捷对话负载
    //（message-handler 对 open 档传 prompt: undefined）。
    expect(options.readerUrl).toBe(buildReaderModeUrl(NORMAL_PAGE_URL));
    expect(options.intent).toBe("open");
    expect(options.prompt).toBeUndefined();
  });
});
