// 阅读壳唯一事务（工单 arch-slim/02）：reader/shell.ts 的壳级接口测试。
//
// 接口即测试面：restore 档的失同步自愈原先只能在 message-handler 层测（handler
// 内联壳自查 + 进入链），现在按壳接口直接测——isReaderShellIntact 判定、
// restore 的先收敛再重进、三种 intent 的时序（抑制 → 摘按钮 → 改写 → 挂表 →
// 翻门控属性 → enterReaderMode）与退出逆事务（URL 收敛 → closeReadingView →
// 摘阅读表）都锁在本文件。
//
// 写法与 message-handler-reading-chat.test.js 同款：重依赖全部 vi.mock，state /
// style-injector / player-ai-state 走真实模块（断言真实挂表、真实抑制窗口）；
// reader 域本体经 core/lazy-reader mock（由 tests/reader/lifecycle.test.ts 覆盖）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NORMAL_PAGE_URL,
  READER_MODE_URL,
  setLocationUrl
} from "../setup.js";

// mock 句柄用 vi.hoisted 提出模块纪元外：.ts 测试里静态 import 的是真实模块
// 类型（运行时才被 mock 掉），mock 配置/断言一律走这组句柄，避免 TS2339。
const mocks = vi.hoisted(() => ({
  ensureUiReady: vi.fn(),
  loadPlayerAi: vi.fn(),
  isPlayerAiLoaded: vi.fn(),
  ensureReaderDomain: vi.fn(),
  ensureReaderChatTab: vi.fn(),
  replaceReaderModeUrl: vi.fn()
}));

vi.mock("../../extension/core/lazy-ui.js", () => ({
  ensureUiReady: mocks.ensureUiReady
}));
vi.mock("../../extension/core/lazy-player-ai.js", () => ({
  loadPlayerAi: mocks.loadPlayerAi,
  isPlayerAiLoaded: mocks.isPlayerAiLoaded
}));
vi.mock("../../extension/core/lazy-reader.js", () => ({
  ensureReaderDomain: mocks.ensureReaderDomain,
  isReaderDomainLoaded: vi.fn(() => false)
}));
vi.mock("../../extension/core/lazy-chat-tab.js", () => ({
  ensureReaderChatTab: mocks.ensureReaderChatTab,
  isReaderChatTabLoaded: vi.fn(() => false)
}));
vi.mock("../../extension/bilibili/reader-url.js", () => ({
  replaceReaderModeUrl: mocks.replaceReaderModeUrl
}));

import {
  enterReaderShell,
  enterReaderShellOnUrlNavigation,
  exitReaderShell,
  isReaderShellIntact
} from "../../extension/reader/shell.js";
import { state } from "../../extension/core/state.js";
import { playerAiState } from "../../extension/ai/player-ai-state.js";
import {
  isReaderStylesMounted,
  ensureReaderStyles,
  removeReaderStyles
} from "../../extension/shared/style-injector.js";

const {
  ensureUiReady,
  loadPlayerAi,
  isPlayerAiLoaded,
  ensureReaderDomain,
  ensureReaderChatTab,
  replaceReaderModeUrl
} = mocks;

// closeReadingView 桩按真实契约把 readingViewOpen 翻回 false（restore 自愈后的
// 重进判定读的是这个状态位），否则壳级测试测不出「先收敛再重进」的接续。
function makeReaderStub() {
  return {
    enterReaderMode: vi.fn(async () => {}),
    closeReadingView: vi.fn(() => {
      state.reader.setViewOpen(false);
      state.reader.setViewReady(false);
    })
  };
}

function makeChatStub() {
  return {
    ensureChatTabActivated: vi.fn(async () => {}),
    runQuickActionPrompt: vi.fn(async () => true)
  };
}

// 构造 #boc-reading-view 壳 DOM 与页面门控属性（isReaderShellIntact 的判定面）。
// 缺省全部就位 = 完好壳；各用例按需破坏单一条件。
interface ShellMountOptions {
  present?: boolean;
  open?: boolean;
  ready?: string;
  bodyAttr?: boolean;
  htmlAttr?: boolean;
}

function mountShell({
  present = true,
  open = true,
  ready = "1",
  bodyAttr = true,
  htmlAttr = true
}: ShellMountOptions = {}): void {
  if (present) {
    const shell = document.createElement("section");
    shell.id = "boc-reading-view";
    if (open) {
      shell.classList.add("open");
    }
    shell.setAttribute("data-boc-reader-ready", ready);
    document.body.appendChild(shell);
  }
  if (bodyAttr) {
    document.body.setAttribute("data-boc-reader-mode", "1");
  }
  if (htmlAttr) {
    document.documentElement.setAttribute("data-boc-reader-mode", "1");
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  setLocationUrl(NORMAL_PAGE_URL);
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-boc-reader-mode");
  document.body.removeAttribute("data-boc-reader-mode");
  // style-injector 的挂载记录是模块级 Map，跨用例残留会污染挂表断言
  removeReaderStyles();
  playerAiState.setSuppressedUntil(0);
  state.reader.setViewOpen(false);
  state.reader.setViewReady(false);
  isPlayerAiLoaded.mockReturnValue(false);
  ensureReaderDomain.mockResolvedValue(makeReaderStub());
  ensureReaderChatTab.mockResolvedValue(makeChatStub());
});

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-boc-reader-mode");
  document.body.removeAttribute("data-boc-reader-mode");
  removeReaderStyles();
});

describe("enterReaderShell：open 档（按钮/编排触发的进入事务）", () => {
  it("完整时序：抑制 → 摘快捷按钮 → 改写 URL → 挂阅读表 → 翻门控属性 → enterReaderMode", async () => {
    isPlayerAiLoaded.mockReturnValue(true);
    const removeButton = vi.fn();
    loadPlayerAi.mockResolvedValue({ removePlayerAiQuickActionButton: removeButton });
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);

    await enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });

    // 前奏：抑制窗口 2.5s（点击过渡期内快捷按钮不再触发）
    expect(playerAiState.playerAiQuickActionSuppressedUntil).toBeGreaterThan(Date.now());
    expect(removeButton).toHaveBeenCalledTimes(1);
    // 进入链：改写 + 挂表 + 翻属性 + 进入，且 ensureUiReady 先于改写
    expect(ensureUiReady).toHaveBeenCalledTimes(1);
    expect(replaceReaderModeUrl).toHaveBeenCalledWith(READER_MODE_URL);
    expect(isReaderStylesMounted()).toBe(true);
    expect(document.documentElement.getAttribute("data-boc-reader-mode")).toBe("1");
    expect(document.body.getAttribute("data-boc-reader-mode")).toBe("1");
    expect(reader.enterReaderMode).toHaveBeenCalledTimes(1);
    // 无闪变时序：壳就绪 → 改写 → 挂表 → 翻属性 → 进入
    const uiOrder = ensureUiReady.mock.invocationCallOrder[0];
    const replaceOrder = replaceReaderModeUrl.mock.invocationCallOrder[0];
    const enterOrder = reader.enterReaderMode.mock.invocationCallOrder[0];
    expect(uiOrder).toBeLessThan(replaceOrder);
    expect(replaceOrder).toBeLessThan(enterOrder);
  });

  it("空 readerUrl 且视图未开 → 兜底构造阅读 URL（与 digest-button 拼法一致）", async () => {
    setLocationUrl("https://www.bilibili.com/video/BV1test000000/?p=2&spm_id_from=x");

    await enterReaderShell({ readerUrl: "", intent: "open" });

    expect(replaceReaderModeUrl).toHaveBeenCalledWith(
      "https://www.bilibili.com/video/BV1test000000/?p=2&boc_reader=1"
    );
  });

  it("空 readerUrl 且视图已开 → 纯聚焦语义：不改写、不翻属性、不重进", async () => {
    state.reader.setViewOpen(true);
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);

    await enterReaderShell({ readerUrl: "", intent: "open" });

    expect(replaceReaderModeUrl).not.toHaveBeenCalled();
    expect(isReaderStylesMounted()).toBe(false);
    expect(reader.enterReaderMode).not.toHaveBeenCalled();
  });

  it("enterReaderMode 失败 → 不向上抛（调用方已即答，只记日志口径）", async () => {
    const reader = makeReaderStub();
    reader.enterReaderMode.mockRejectedValue(new Error("boom"));
    ensureReaderDomain.mockResolvedValue(reader);

    await expect(enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" })).resolves.toBeUndefined();
  });
});

describe("enterReaderShell：restore 档（失同步自愈，壳级接口测试）", () => {
  it.each([
    ["壳节点被整树摘走", { present: false }],
    [".open 掉了", { open: false }],
    ["ready 门控卡 0", { ready: "0" }],
    ["body 门控属性被清", { bodyAttr: false }],
    ["html 门控属性被清", { htmlAttr: false }]
  ])("状态开着而壳失整（%s）→ 先 closeReadingView 收敛再重进", async (_name, broken) => {
    state.reader.setViewOpen(true);
    mountShell(broken as ShellMountOptions);
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);

    await enterReaderShell({ readerUrl: READER_MODE_URL, intent: "restore" });

    expect(reader.closeReadingView).toHaveBeenCalledTimes(1);
    expect(reader.enterReaderMode).toHaveBeenCalledTimes(1);
    // 收敛先于重进（先退出事务把失同步状态清干净，再走进入链）
    expect(reader.closeReadingView.mock.invocationCallOrder[0]).toBeLessThan(
      reader.enterReaderMode.mock.invocationCallOrder[0]
    );
    expect(replaceReaderModeUrl).toHaveBeenCalledWith(READER_MODE_URL);
  });

  it("状态开着而壳完好 → 不收敛，只按 URL 翻属性，不重进", async () => {
    state.reader.setViewOpen(true);
    mountShell();
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);

    await enterReaderShell({ readerUrl: READER_MODE_URL, intent: "restore" });

    expect(reader.closeReadingView).not.toHaveBeenCalled();
    expect(reader.enterReaderMode).not.toHaveBeenCalled();
    expect(replaceReaderModeUrl).toHaveBeenCalledWith(READER_MODE_URL);
    expect(document.body.getAttribute("data-boc-reader-mode")).toBe("1");
  });

  it("视图没开（URL 带阅读标记而进入链半途失败）→ 直接走进入链，无收敛步", async () => {
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);

    await enterReaderShell({ readerUrl: READER_MODE_URL, intent: "restore" });

    expect(reader.closeReadingView).not.toHaveBeenCalled();
    expect(reader.enterReaderMode).toHaveBeenCalledTimes(1);
  });

  it("收敛失败（reader 域装载被拒）→ 不阻断进入链（翻属性照走）；视图状态位未收敛故不重进", async () => {
    state.reader.setViewOpen(true);
    mountShell({ open: false });
    const reader = makeReaderStub();
    ensureReaderDomain
      .mockRejectedValueOnce(new Error("load fail"))
      .mockResolvedValueOnce(reader);

    await expect(enterReaderShell({ readerUrl: READER_MODE_URL, intent: "restore" })).resolves.toBeUndefined();
    // closeReadingView 未执行 ⇒ readingViewOpen 仍为 true ⇒ 序列不重进（与收口
    // 前处理器行为一致：`if (!isReaderViewOpen())` 不满足），但进入链继续走完。
    expect(replaceReaderModeUrl).toHaveBeenCalledWith(READER_MODE_URL);
    expect(reader.enterReaderMode).not.toHaveBeenCalled();
  });

  it("restore 档不摘播放器快捷按钮（失同步自愈与用户点击无关），但抑制窗口照设", async () => {
    isPlayerAiLoaded.mockReturnValue(true);
    loadPlayerAi.mockResolvedValue({ removePlayerAiQuickActionButton: vi.fn() });

    await enterReaderShell({ readerUrl: READER_MODE_URL, intent: "restore" });

    expect(loadPlayerAi).not.toHaveBeenCalled();
    expect(playerAiState.playerAiQuickActionSuppressedUntil).toBeGreaterThan(Date.now());
  });
});

describe("enterReaderShell：focus-chat 档（进对话）", () => {
  it("视图未开 → 先 enterReaderMode，再激活对话 tab 并自动发送 prompt", async () => {
    const reader = makeReaderStub();
    const chat = makeChatStub();
    ensureReaderDomain.mockResolvedValue(reader);
    ensureReaderChatTab.mockResolvedValue(chat);

    await enterReaderShell({ readerUrl: READER_MODE_URL, intent: "focus-chat", prompt: "总结" });

    expect(reader.enterReaderMode).toHaveBeenCalledTimes(1);
    expect(chat.runQuickActionPrompt).toHaveBeenCalledWith("总结");
    expect(chat.ensureChatTabActivated).not.toHaveBeenCalled();
  });

  it("视图已开且无 prompt → 只定位对话 tab（consumeIntent:false），不重进", async () => {
    state.reader.setViewOpen(true);
    mountShell();
    const reader = makeReaderStub();
    const chat = makeChatStub();
    ensureReaderDomain.mockResolvedValue(reader);
    ensureReaderChatTab.mockResolvedValue(chat);

    await enterReaderShell({ readerUrl: "", intent: "focus-chat" });

    expect(reader.enterReaderMode).not.toHaveBeenCalled();
    expect(replaceReaderModeUrl).not.toHaveBeenCalled();
    expect(chat.ensureChatTabActivated).toHaveBeenCalledWith({ consumeIntent: false });
    expect(chat.runQuickActionPrompt).not.toHaveBeenCalled();
  });
});

describe("enterReaderShellOnUrlNavigation：URL 跳转编排入口", () => {
  it("同一进入链：挂表 + 翻属性 + enterReaderMode；announce 先于 enterReaderMode 落地", async () => {
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);
    const announce = vi.fn(async () => {});

    await enterReaderShellOnUrlNavigation({ readerUrl: READER_MODE_URL, announce });

    expect(announce).toHaveBeenCalledTimes(1);
    expect(replaceReaderModeUrl).toHaveBeenCalledWith(READER_MODE_URL);
    expect(isReaderStylesMounted()).toBe(true);
    expect(document.documentElement.getAttribute("data-boc-reader-mode")).toBe("1");
    expect(reader.enterReaderMode).toHaveBeenCalledTimes(1);
    // 播报必须先落地：否则会反向覆盖 enterReaderMode 的「已就绪」文案
    expect(announce.mock.invocationCallOrder[0]).toBeLessThan(reader.enterReaderMode.mock.invocationCallOrder[0]);
  });

  it("无 player-ai 前奏：URL 跳转没有用户点击在先，不抑制、不摘按钮", async () => {
    isPlayerAiLoaded.mockReturnValue(true);
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);

    await enterReaderShellOnUrlNavigation({ readerUrl: READER_MODE_URL });

    expect(loadPlayerAi).not.toHaveBeenCalled();
    expect(playerAiState.playerAiQuickActionSuppressedUntil).toBe(0);
    expect(reader.enterReaderMode).toHaveBeenCalledTimes(1);
  });

  it("enterReaderMode 失败 → onEnterFailed 收到错误（编排侧写状态栏口径）", async () => {
    const failure = new Error("start failed");
    const reader = makeReaderStub();
    reader.enterReaderMode.mockRejectedValue(failure);
    ensureReaderDomain.mockResolvedValue(reader);
    const onEnterFailed = vi.fn();

    await enterReaderShellOnUrlNavigation({ readerUrl: READER_MODE_URL, onEnterFailed });

    expect(onEnterFailed).toHaveBeenCalledWith(failure);
  });

  it("announce 失败不阻断进入（与原 Promise.all 的吞错口径一致）", async () => {
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);
    const announce = vi.fn(async () => {
      throw new Error("announce failed");
    });

    await enterReaderShellOnUrlNavigation({ readerUrl: READER_MODE_URL, announce });

    expect(reader.enterReaderMode).toHaveBeenCalledTimes(1);
  });
});

describe("exitReaderShell：退出逆事务（吸收 reader-close 处理器与关闭按钮链）", () => {
  it("阅读模式 URL：先收敛地址栏，再 closeReadingView + 摘阅读表", async () => {
    setLocationUrl(READER_MODE_URL);
    mountShell();
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);
    // 预挂阅读表：验证退出后摘除
    ensureReaderStyles();
    expect(isReaderStylesMounted()).toBe(true);

    await exitReaderShell();

    expect(replaceReaderModeUrl).toHaveBeenCalledWith("https://www.bilibili.com/video/BV1test000000/");
    expect(reader.closeReadingView).toHaveBeenCalledTimes(1);
    expect(isReaderStylesMounted()).toBe(false);
    // URL 收敛先于关闭（与原处理器「先收敛地址栏」的时序一致）
    const replaceOrder = replaceReaderModeUrl.mock.invocationCallOrder[0];
    expect(replaceOrder).toBeLessThan(reader.closeReadingView.mock.invocationCallOrder[0]);
  });

  it("非阅读模式 URL（页内跳转后点关闭）→ 不改写地址栏，仍关闭并摘表", async () => {
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);

    await exitReaderShell();

    expect(replaceReaderModeUrl).not.toHaveBeenCalled();
    expect(reader.closeReadingView).toHaveBeenCalledTimes(1);
  });

  it("reader 域装载失败 → 向上拒绝（消息路径据此按错误回包）", async () => {
    ensureReaderDomain.mockRejectedValue(new Error("load fail"));

    await expect(exitReaderShell()).rejects.toThrow("load fail");
  });
});

describe("isReaderShellIntact：壳完好性判定（restore 自愈与 digest 按钮守卫的唯一判定）", () => {
  it("五条件全真才完好", () => {
    mountShell();
    expect(isReaderShellIntact()).toBe(true);
  });

  it.each([
    ["壳节点缺失", { present: false }],
    [".open 缺失", { open: false }],
    ["ready=0", { ready: "0" }],
    ["body 属性缺失", { bodyAttr: false }],
    ["html 属性缺失", { htmlAttr: false }]
  ])("任一必要呈现条件缺失即失整（%s）", (_name, broken) => {
    mountShell(broken as ShellMountOptions);
    expect(isReaderShellIntact()).toBe(false);
  });
});
