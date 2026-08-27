// asr-decode-prepare 的 offscreen 文档守卫回归测试。
//
// 事故背景：ensureAsrOffscreenDocument 曾在 service worker 里用不存在的
// `chrome.clients` 命名空间调用 matchAll（SW 标准全局是 `clients` / `self.clients`），
// TypeError 被 catch-all 吞掉 → 无文档时从不创建 offscreen 文档 →
// 页面侧 "asr-decode" 端口找不到接收端（"Receiving end does not exist"），
// ~2ms 内 onDisconnect，用户看到「音频解码中断：后台连接已断开」。
// 修复：改用 SW 标准全局 `self.clients.matchAll`。
//
// 判别性用例：无文档时 handleAsrDecodePrepare 必须真正调用
// chrome.offscreen.createDocument（旧实现吞掉 TypeError 后不会调用）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

function stubSwEnv({ matchAllResult, matchAllError } = {}) {
  const createDocument = vi.fn(async () => ({}));
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: null,
      sendMessage: vi.fn((_message, callback) => {
        callback?.({ ok: true });
        return undefined;
      }),
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn() }
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    },
    offscreen: { createDocument },
    declarativeNetRequest: { updateSessionRules: vi.fn(async () => {}) }
  });
  const matchAll = vi.fn(async () => {
    if (matchAllError) throw matchAllError;
    return matchAllResult || [];
  });
  vi.stubGlobal("clients", { matchAll });
  return { createDocument, matchAll };
}

let bridge;

beforeEach(() => {
  resetModuleState();
});

describe("handleAsrDecodePrepare 的 offscreen 文档守卫", () => {
  it("无文档时真正创建 offscreen 文档（回归：不再静默吞掉 matchAll TypeError）", async () => {
    const { createDocument } = stubSwEnv({ matchAllResult: [] });
    bridge = await import("../../extension/asr/offscreen-bridge.js");

    const sendResponse = vi.fn();
    await bridge.handleAsrDecodePrepare({ taskType: "asr-decode-prepare" }, {}, sendResponse);

    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(createDocument.mock.calls[0][0]).toMatchObject({
      url: "chrome-extension://test/entry/offscreen.html",
      reasons: ["AUDIO_PLAYBACK"]
    });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("文档已存在（如 sidepanel 聊天创建的 offscreen-chat 文档）时不重复创建", async () => {
    const { createDocument } = stubSwEnv({
      matchAllResult: [{ url: "chrome-extension://test/entry/offscreen.html" }]
    });
    bridge = await import("../../extension/asr/offscreen-bridge.js");

    const sendResponse = vi.fn();
    await bridge.handleAsrDecodePrepare({ taskType: "asr-decode-prepare" }, {}, sendResponse);

    expect(createDocument).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("matchAll 异常按既有语义吞掉并返回 ok:true（不阻塞后续端口连接尝试）", async () => {
    const { createDocument } = stubSwEnv({ matchAllError: new Error("boom") });
    bridge = await import("../../extension/asr/offscreen-bridge.js");

    const sendResponse = vi.fn();
    await bridge.handleAsrDecodePrepare({ taskType: "asr-decode-prepare" }, {}, sendResponse);

    expect(createDocument).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });
});