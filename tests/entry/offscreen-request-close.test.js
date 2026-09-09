// 工单 03：offscreen 文档自关闭的 SW 代执行回归测试。
//
// 旧形状：offscreen.ts 任务终态后直调 chrome.offscreen.closeDocument——但
// offscreen 文档根本没有 chrome.offscreen 命名空间（平台只开放 chrome.runtime），
// 自关闭在线上恒走不到。新形状：offscreen 经 "offscreen-request-close" 消息
// 委托 SW 执行，SW 校验发送者确为 offscreen 文档（sender.url 精确等于文档 URL
// 且无 sender.tab）后调 closeDocument，并明确回 { ok:true } / { ok:false, error }。
//
// 本文件三段验证：
//   1. 执行器半边（handleOffscreenRequestClose）：来源校验、成功/失败回包；
//   2. 入口半边（background onMessage → 路由 → 守卫）：offscreen 来源放行、
//      其他来源拒绝且 closeDocument 不被触碰；
//   3. SW 重启（模块重载 = 新 SW 实例）：执行器在新实例上照常工作，文档跨
//      SW 存活时终态自关不失效。
//
// 附带：ensure-offscreen-chat 的创建失败不再吞掉（工单 03）——ok:false 带
// ensureChatOffscreenDocument 的原始错误。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const OFFSCREEN_URL = "chrome-extension://test/entry/offscreen.html";

function stubSwEnv({ closeError } = {}) {
  const closeDocument = vi.fn(async () => {
    if (closeError) throw closeError;
  });
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: null,
      getURL: (path) => `chrome-extension://test/${path}`,
      sendMessage: vi.fn((_message, callback) => {
        callback?.({ ok: true });
        return undefined;
      }),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      getManifest: () => ({ version: "9.9.9" })
    },
    tabs: { onUpdated: { addListener: vi.fn() } },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    },
    offscreen: { closeDocument }
  });
  return { closeDocument };
}

// offscreen 文档自身的 sender 形状（无 sender.tab、url 为文档 URL）
const offscreenSender = { url: OFFSCREEN_URL };
// 非法来源：content script（有 tab）与 URL 不符的扩展上下文
const tabSender = { tab: { id: 7 }, url: "https://www.bilibili.com/video/BV1/" };
const extensionPageSender = { url: "chrome-extension://test/entry/background.html" };

beforeEach(() => {
  resetModuleState();
});

describe("handleOffscreenRequestClose 执行器", () => {
  it("offscreen 文档来源：执行 closeDocument 并回 { ok:true }", async () => {
    const { closeDocument } = stubSwEnv();
    const bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const sendResponse = vi.fn();
    await bridge.handleOffscreenRequestClose({}, offscreenSender, sendResponse);

    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("closeDocument 抛错：明确回 { ok:false, error }（原始错误文案）", async () => {
    stubSwEnv({ closeError: new Error("No current offscreen document") });
    const bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const sendResponse = vi.fn();
    await bridge.handleOffscreenRequestClose({}, offscreenSender, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "No current offscreen document" });
  });

  it.each([
    ["content script（有 sender.tab）", tabSender],
    ["URL 不符的扩展上下文", extensionPageSender],
    ["空 sender", {}]
  ])("非 offscreen 来源（%s）被拒绝：回 ok:false 且 closeDocument 不被触碰", async (_label, sender) => {
    const { closeDocument } = stubSwEnv();
    const bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const sendResponse = vi.fn();
    await bridge.handleOffscreenRequestClose({}, sender, sendResponse);

    expect(closeDocument).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "仅接受 offscreen 文档发送" });
  });

  it("SW 重启（模块重载 = 新实例）：执行器照常工作，自关不失效", async () => {
    const { closeDocument } = stubSwEnv();
    await import("../../extension/asr/offscreen-bridge.bg.js");
    resetModuleState();
    const fresh = await import("../../extension/asr/offscreen-bridge.bg.js");

    const sendResponse = vi.fn();
    await fresh.handleOffscreenRequestClose({}, offscreenSender, sendResponse);

    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });
});

// ===== 入口半边：background onMessage 路由 + 守卫 =====

describe("background 消息入口：offscreen-request-close 的来源守卫", () => {
  async function freshEntry() {
    const { closeDocument } = stubSwEnv();
    resetModuleState();
    await import("../../extension/entry/background.js");
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];
    return { closeDocument, listener };
  }

  it("offscreen 来源放行：closeDocument 执行、回 { ok:true }、保持通道", async () => {
    const { closeDocument, listener } = await freshEntry();

    const sendResponse = vi.fn();
    const keepOpen = listener({ type: "offscreen-request-close" }, offscreenSender, sendResponse);

    expect(keepOpen).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    expect(closeDocument).toHaveBeenCalledTimes(1);
  });

  it("tab 来源被入口守卫拦截：回 { ok:false } 且不触发 closeDocument", async () => {
    const { closeDocument, listener } = await freshEntry();

    const sendResponse = vi.fn();
    const keepOpen = listener({ type: "offscreen-request-close" }, tabSender, sendResponse);

    expect(keepOpen).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "仅接受 offscreen 文档发送" });
    expect(closeDocument).not.toHaveBeenCalled();
  });

  it("扩展页来源同样被拦截（offscreen 专属消息族不含扩展页）", async () => {
    const { closeDocument, listener } = await freshEntry();

    const sendResponse = vi.fn();
    listener({ type: "offscreen-request-close" }, extensionPageSender, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "仅接受 offscreen 文档发送" });
    expect(closeDocument).not.toHaveBeenCalled();
  });
});

// ===== 附带：ensure-offscreen-chat 创建失败不再吞掉（工单 03） =====

describe("ensure-offscreen-chat：创建失败沿消息通道上抛为 ok:false", () => {
  it("createDocument 真实失败 → { ok:false, error } 带原始错误", async () => {
    stubSwEnv();
    chrome.runtime.getContexts = vi.fn(async () => []);
    chrome.offscreen = { createDocument: vi.fn(async () => { throw new Error("offscreen reasons invalid"); }) };
    resetModuleState();
    await import("../../extension/entry/background.js");
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];

    const sendResponse = vi.fn();
    listener({ type: "ensure-offscreen-chat" }, extensionPageSender, sendResponse);

    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "offscreen reasons invalid" })
    );
  });
});
