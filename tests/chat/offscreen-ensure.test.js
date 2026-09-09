// ensureChatOffscreenDocument（sidepanel 聊天通道 offscreen 文档自愈）测试：
// - getContexts 查到已有 OFFSCREEN_DOCUMENT → 不重复创建
// - 查无文档 → 以 init 的原参数（url/reasons/justification）createDocument
// - getContexts 不可用/抛错（Chrome <116 降级）→ 仍尝试创建
// - createDocument 抛「文档已存在」（降级路径的并发创建竞态）→ 视同成功
// - createDocument 真实失败（工单 03）→ 原始错误上抛，不再吞掉

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
// 被测模块无自身状态（chrome 只在函数体内访问），静态导入即可；
// stubChrome 在 beforeEach 重置后逐用例重建，避免 mock 污染。
import { ensureChatOffscreenDocument } from "../../extension/chat/offscreen-ensure.js";
import { OFFSCREEN_URL, OFFSCREEN_CREATE_REASON } from "../../extension/shared/offscreen-constants.js";

function stubChrome({ contexts, contextsError, createError } = {}) {
  const createDocument = vi.fn(async () => {
    if (createError) throw createError;
    return {};
  });
  const getContexts = vi.fn(async () => {
    if (contextsError) throw contextsError;
    return contexts || [];
  });
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    runtime: {
      ...globalThis.chrome.runtime,
      getURL: (path) => `chrome-extension://test/${path}`,
      getContexts
    },
    offscreen: { createDocument }
  });
  return { createDocument, getContexts };
}

beforeEach(() => {
  resetModuleState();
});

describe("ensureChatOffscreenDocument", () => {
  it("文档已存在（getContexts 命中）→ 不重复创建，返回 true", async () => {
    const { createDocument, getContexts } = stubChrome({ contexts: [{ contextType: "OFFSCREEN_DOCUMENT" }] });
    await expect(ensureChatOffscreenDocument()).resolves.toBe(true);
    expect(getContexts).toHaveBeenCalledTimes(1);
    expect(createDocument).not.toHaveBeenCalled();
  });

  it("查无文档 → 以统一常量创建（url/reason 收拢在 shared/offscreen-constants.js）", async () => {
    const { createDocument } = stubChrome({ contexts: [] });
    await expect(ensureChatOffscreenDocument()).resolves.toBe(true);
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(createDocument.mock.calls[0][0]).toEqual({
      url: `chrome-extension://test/${OFFSCREEN_URL}`,
      reasons: [OFFSCREEN_CREATE_REASON],
      justification: "Run AI stream fetch in background to avoid Side Panel freeze when tab is hidden."
    });
  });

  it("getContexts 抛错（含 API 缺失的 TypeError 降级）→ 仍尝试创建", async () => {
    const { createDocument, getContexts } = stubChrome({ contextsError: new TypeError("getContexts is not a function") });
    await expect(ensureChatOffscreenDocument()).resolves.toBe(true);
    expect(getContexts).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it.each([
    // Chrome 真实文案（r1 审查核实）
    "Only a single offscreen document may be created.",
    // 兼容的旧/变体文案
    "Single offscreen document already exists."
  ])("createDocument 抛「文档已存在」（%s）→ 视同成功", async (message) => {
    stubChrome({ contextsError: new TypeError("getContexts is not a function"), createError: new Error(message) });
    await expect(ensureChatOffscreenDocument()).resolves.toBe(true);
  });

  it("createDocument 真实失败 → 原始错误上抛，不再吞掉（工单 03）", async () => {
    stubChrome({ contexts: [], createError: new Error("offscreen.createDocument: reason not allowed") });
    await expect(ensureChatOffscreenDocument()).rejects.toThrow("offscreen.createDocument: reason not allowed");
  });
});
