// 统一 Digest 阅读模式 PR1 验收（消息路径）：Digest 按钮点击发出
// reader-enter 且 readerUrl 带 boc_reader=1。
//
// 生产路径：按钮 click → handleDigestButtonClick 构造 {type, readerUrl} →
// shared/messaging.js 的 dispatchContentScriptMessage 原语 → 处理器
// reader-enter 分支 → ensureUiReady().then(replaceReaderModeUrl(readerUrl))。
//
// 重依赖按 message-handler-seek.test.js 同款 vi.mock；独立文件 = 独立模块
// 纪元，避免 mock 污染 digest-button.test.js 的真实模块用例。真实时钟驱动：
// mock 的 ensureUiReady 同步 resolve，微任务穿透后 replaceReaderModeUrl 收到
// readerUrl；settle 链的 1200ms 余量直接真实等待（仅一次，可用例内接受）。
//
// arch-slim-2/09：分发主体住 entry/message-handler.ts，于 bindRuntimeEvents 时
// 注册进 shared 原语槽——本文件按生产时序先 bindRuntimeEvents()（注册），点击
// 才经 shared 原语进同一条处理器路径。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, setLocationUrl, NORMAL_PAGE_URL } from "../setup.js";

vi.mock("../../extension/ui/lazy-ui.js", () => ({
  ensureUiReady: vi.fn(async () => {})
}));
vi.mock("../../extension/ai/lazy-player-ai.js", () => ({
  loadPlayerAi: vi.fn(),
  isPlayerAiLoaded: vi.fn(() => false)
}));
vi.mock("../../extension/reader/lazy-reader.js", () => ({
  ensureReaderDomain: vi.fn(async () => ({ enterReaderMode: vi.fn(async () => {}) }))
}));
// arch-slim-2/03：reader-url 单源后 digest-button 也消费 buildReaderModeUrl——
// 只 mock 掉带副作用的 replaceState（replaceReaderModeUrl），URL 拼法走真身，
// 本用例因此同时钉住 buildReaderModeUrl 的规范拼法。
vi.mock("../../extension/bilibili/reader-url.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    replaceReaderModeUrl: vi.fn()
  };
});

import { replaceReaderModeUrl } from "../../extension/bilibili/reader-url.js";

function makeToolbarHtml() {
  return `
    <div id="arc_toolbar_report">
      <div class="video-toolbar-left"><div class="video-toolbar-left-main"></div></div>
      <div class="video-toolbar-right">
        <div class="video-complaint"><span>稿件举报</span></div>
        <div class="video-note"></div>
      </div>
    </div>`;
}

async function loadModule() {
  // 生产时序（arch-slim-2/09）：content.ts init() 先 bindRuntimeEvents 把分发
  // 主体注册进 shared 原语槽，digest-button 后装载、点击经原语进同一条处理器
  // 路径。注意注册必须与本用例的动态 import 同一模块纪元——beforeEach 的
  // vi.resetModules 换纪元后，测试文件顶层静态 import 的是旧纪元实例，其注册
  // 槽与按钮模块消费的槽不共享。
  const handler = await import("../../extension/entry/message-handler.js");
  handler.bindRuntimeEvents();
  const lazy = await import("../../extension/ui/lazy-digest-button.js");
  return lazy.loadDigestButton();
}

beforeEach(() => {
  resetModuleState();
  setLocationUrl(NORMAL_PAGE_URL);
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("digest-button 点击行为", () => {
  it("点击发出 reader-enter，readerUrl 为带 boc_reader=1 的规范视频 URL", async () => {
    setLocationUrl("https://www.bilibili.com/video/BV1test000000/?p=2&spm_id_from=x");
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;

    await loadModule();
    // settle 链跑完（video 已挂 → 1200ms 余量 → 首轮注入）
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const button = document.getElementById("boc-digest-button");
    expect(button).not.toBeNull();

    button.click();
    await vi.waitFor(() => {
      expect(replaceReaderModeUrl).toHaveBeenCalled();
    });

    // cleanVideoUrl 清掉非视频参数后加 boc_reader=1，p=2 保留（规范视频 URL）。
    expect(replaceReaderModeUrl).toHaveBeenCalledWith(
      "https://www.bilibili.com/video/BV1test000000/?p=2&boc_reader=1"
    );
  });
});
