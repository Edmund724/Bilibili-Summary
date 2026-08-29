// ensureChatOffscreenDocument（sidepanel 聊天通道 offscreen 文档自愈）测试：
// - getContexts 查到已有 OFFSCREEN_DOCUMENT → 不重复创建
// - 查无文档 → 以 init 的原参数（url/reasons/justification）createDocument
// - getContexts 不可用/抛错（Chrome <116 降级）→ 仍尝试创建
// - createDocument 失败（含“文档已存在”）→ 不上抛、返回 false，由 connect 兜底

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
// 被测模块无自身状态（chrome 只在函数体内访问），静态导入即可；
// stubChrome 在 beforeEach 重置后逐用例重建，避免 mock 污染。
import { CHAT_OFFSCREEN_PATH, ensureChatOffscreenDocument } from "../../extension/pages/sidepanel-offscreen-ensure.js";

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

  it("查无文档 → 以原参数创建（url/reasons/justification 与 init 历史行为一致）", async () => {
    const { createDocument } = stubChrome({ contexts: [] });
    await expect(ensureChatOffscreenDocument()).resolves.toBe(true);
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(createDocument.mock.calls[0][0]).toEqual({
      url: `chrome-extension://test/${CHAT_OFFSCREEN_PATH}`,
      reasons: ["DOM_SCRAPING"],
      justification: "Run AI stream fetch in background to avoid Side Panel freeze when tab is hidden."
    });
  });

  it("getContexts 抛错（含 API 缺失的 TypeError 降级）→ 仍尝试创建", async () => {
    const { createDocument, getContexts } = stubChrome({ contextsError: new TypeError("getContexts is not a function") });
    await expect(ensureChatOffscreenDocument()).resolves.toBe(true);
    expect(getContexts).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it("createDocument 失败 → 不上抛、返回 false（connect 兜底，不阻断发送）", async () => {
    stubChrome({ contexts: [], createError: new Error("Duplicate offscreen document") });
    await expect(ensureChatOffscreenDocument()).resolves.toBe(false);
  });
});
