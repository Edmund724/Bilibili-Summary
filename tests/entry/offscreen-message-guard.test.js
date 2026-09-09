// 工单 03：后台（SW）消息入口守卫——发送者来源、内部消息 schema、标签页归属。
//
// 守卫在路由之后、处理器执行之前：非法来源/载荷在产生任何副作用前被拒绝并
// 明确回 { ok:false }。覆盖场景：
//   - offscreen 专属消息族（segment-cache）被非 offscreen 来源调用 → 拒绝且
//     处理器零副作用；
//   - 内部 schema：save-settings / providers-save / player-ai-quick-action 的
//     形状明显非法载荷被拒；
//   - 标签页归属：player-ai-quick-action 的 message.tabId 与 sender.tab.id
//     不一致（跨标签页伪造）→ 拒绝且不向任何标签页发消息；
//   - 未知消息类型 / 非对象消息：不回包、零副作用（与既有行为一致）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { sendMessageToTab } from "../../extension/shared/tab-utils.js";

vi.mock("../../extension/shared/tab-utils.js", () => ({
  sendMessageToTab: vi.fn(async () => ({ ok: true })),
  waitForTabComplete: vi.fn(async () => true)
}));

const OFFSCREEN_SENDER = { url: "chrome-extension://test/entry/offscreen.html" };
const TAB_SENDER = (id) => ({ tab: { id }, url: "https://www.bilibili.com/video/BV1/" });

async function importBackground() {
  resetModuleState();
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: null,
      getURL: (path) => `chrome-extension://test/${path}`,
      sendMessage: vi.fn((_message, callback) => {
        callback?.({ ok: true });
        return undefined;
      }),
      getManifest: () => ({ version: "9.9.9" }),
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn() }
    },
    tabs: { onUpdated: { addListener: vi.fn() } },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  });
  await import("../../extension/entry/background.js");
  return vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];
}

beforeEach(() => {
  vi.mocked(sendMessageToTab).mockClear();
});

describe("消息入口守卫：发送者来源", () => {
  it("segment-cache 被 tab 来源调用：拒绝（ok:false）且处理器零副作用", async () => {
    const listener = await importBackground();
    const storageLocalSet = vi.mocked(chrome.storage.local.set);
    storageLocalSet.mockClear();

    const sendResponse = vi.fn();
    const keepOpen = listener(
      { type: "segment-cache", op: "save-raw", context: { bvid: "BV1" }, segments: [1] },
      TAB_SENDER(7),
      sendResponse
    );

    expect(keepOpen).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "仅接受 offscreen 文档发送" });
    expect(storageLocalSet).not.toHaveBeenCalled();
  });

  it("segment-cache 由 offscreen 文档发送：通过守卫进入处理器", async () => {
    const listener = await importBackground();

    const sendResponse = vi.fn();
    const keepOpen = listener(
      { type: "segment-cache", op: "load-summary", context: { bvid: "BV1" } },
      OFFSCREEN_SENDER,
      sendResponse
    );

    expect(keepOpen).toBe(true);
    await vi.waitFor(() => {
      const resp = sendResponse.mock.calls[0]?.[0];
      expect(resp?.ok).toBe(true);
    });
  });
});

describe("消息入口守卫：内部消息 schema", () => {
  it.each([
    ["save-settings", { type: "save-settings", settings: "junk" }],
    ["save-settings 数组", { type: "save-settings", settings: [1, 2] }],
    ["ai-providers-save", { type: "ai-providers-save", providers: "x" }],
    ["asr-providers-save", { type: "asr-providers-save", providers: 42 }],
    ["player-ai-quick-action", { type: "player-ai-quick-action", tabId: "7" }]
  ])("%s 的非法载荷被拒：ok:false、零副作用", async (_label, message) => {
    const listener = await importBackground();

    const sendResponse = vi.fn();
    const keepOpen = listener(message, TAB_SENDER(7), sendResponse);

    expect(keepOpen).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: expect.stringContaining("载荷不合法") });
    expect(sendMessageToTab).not.toHaveBeenCalled();
  });

  it("合法载荷照常进入处理器：save-settings 对象 → ok:true", async () => {
    const listener = await importBackground();

    const sendResponse = vi.fn();
    listener({ type: "save-settings", settings: { enableDebugLogs: true } }, TAB_SENDER(7), sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
  });
});

describe("消息入口守卫：标签页归属", () => {
  it("player-ai-quick-action 的 tabId 与 sender.tab 不一致：拒绝且不向任何标签页发消息", async () => {
    const listener = await importBackground();

    const sendResponse = vi.fn();
    const keepOpen = listener({ type: "player-ai-quick-action", tabId: 7 }, TAB_SENDER(8), sendResponse);

    expect(keepOpen).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      error: "请求目标与发送者标签页不一致，已拒绝。"
    });
    expect(sendMessageToTab).not.toHaveBeenCalled();
  });

  it("tabId 与 sender.tab 一致（同标签页）：照常触发 reader-enter 编排", async () => {
    const listener = await importBackground();

    const sendResponse = vi.fn();
    listener({ type: "player-ai-quick-action", tabId: 7 }, TAB_SENDER(7), sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    expect(sendMessageToTab).toHaveBeenCalledWith(7, expect.objectContaining({ type: "reader-enter" }));
  });
});

describe("未知/畸形消息：零副作用", () => {
  it("未知消息类型：不回包、返回 false", async () => {
    const listener = await importBackground();

    const sendResponse = vi.fn();
    const keepOpen = listener({ type: "no-such-message" }, TAB_SENDER(7), sendResponse);

    expect(keepOpen).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("非对象消息：不回包、返回 false", async () => {
    const listener = await importBackground();

    const sendResponse = vi.fn();
    expect(listener(null, TAB_SENDER(7), sendResponse)).toBe(false);
    expect(listener("str", TAB_SENDER(7), sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
