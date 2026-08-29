// 回归测试：background getAiSidepanelState 在「ASR 转写未完成」窗口期的行为。
// 用户症状（修复前）：一键总结拿到空 subtitleBody 直接发给模型（模型凭标题+
// 热评编造"无公开字幕"）；popup-refresh 长事务（等小时级转写）挂起/失败后侧边
// 栏把上下文清空、误报"当前页面不是 B 站视频页"。
// 修复后行为：popup-refresh 限时等待，超时回退读取当前快照（带
// subtitleFetchState:"loading"），sidepanel 据此等待转写完成再发送。
// getAiSidepanelState 通过 tabOps 注入 ensureReaderContentReady / sendMessageToTab，
// 无需真实 chrome.tabs。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAiSidepanelState } from "../../extension/ai/context-resolver.js";

// 模拟 content script 在「转写进行中」窗口期的状态：refreshClip 已跑完
// 元信息（title/bvid/aid 已设置），但字幕 body 为空（ASR 转写尚未完成）。
function makeTranscribingContentResponder(sent, { refreshResponse } = {}) {
  return vi.fn(async (_tabId, message) => {
    sent.push(message);
    if (message.type === "sidepanel-get-context") {
      return {
        ok: true,
        payload: {
          url: "https://www.bilibili.com/video/BV1test/",
          title: "五小时访谈",
          bvid: "BV1test",
          aid: "1",
          cid: "101",
          subtitleBody: [],
          subtitleFetchState: "loading"
        }
      };
    }
    if (message.type === "sidepanel-get-hot-comments") {
      return { ok: true, comments: [{ uname: "u", like: 1, message: "m" }] };
    }
    if (message.type === "popup-refresh") {
      return refreshResponse !== undefined ? refreshResponse : new Promise(() => {});
    }
    return { ok: true };
  });
}

describe("getAiSidepanelState：转写未完成窗口期", () => {
  let sent;

  beforeEach(() => {
    sent = [];
    vi.stubGlobal("chrome", {
      ...globalThis.chrome,
      tabs: {
        ...(globalThis.chrome?.tabs || {}),
        get: vi.fn(async () => ({ id: 1, url: "https://www.bilibili.com/video/BV1test/" }))
      }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function runGetState(forceRefresh, responderOptions) {
    return getAiSidepanelState(
      1,
      { forceRefresh },
      {
        ensureReaderContentReady: vi.fn(async () => {}),
        sendMessageToTab: makeTranscribingContentResponder(sent, responderOptions)
      }
    );
  }

  it("一键总结路径（forceRefresh=false）：放行 loading 快照且带 subtitleFetchState，不发 popup-refresh", async () => {
    const payload = await runGetState(false);

    // 侧边栏拿到 subtitleFetchState:"loading" 后会等待转写完成再发送；
    // 空字幕不再被无声地当成"没有字幕"发给模型
    expect(payload.subtitleBody).toEqual([]);
    expect(payload.subtitleFetchState).toBe("loading");
    expect(payload.title).toBe("五小时访谈");
    expect(sent.some((m) => m.type === "popup-refresh")).toBe(false);
  });

  it("sync 路径（forceRefresh=true）：popup-refresh 超时不失败，回退读取 loading 快照", async () => {
    vi.useFakeTimers();
    // popup-refresh 永不响应（content 正在小时级转写）
    const promise = runGetState(true);
    const assertion = expect(promise).resolves.toMatchObject({
      title: "五小时访谈",
      subtitleFetchState: "loading",
      isVideoContext: true
    });
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;

    // 超时后回退读了一次快照
    const getContextCalls = sent.filter((m) => m.type === "sidepanel-get-context").length;
    expect(getContextCalls).toBeGreaterThanOrEqual(2);
  });

  it("sync 路径（forceRefresh=true）：popup-refresh 正常响应时照常取新快照", async () => {
    vi.useFakeTimers();
    const promise = runGetState(true, { refreshResponse: { ok: true } });
    const assertion = expect(promise).resolves.toMatchObject({ title: "五小时访谈" });
    await vi.advanceTimersByTimeAsync(0);
    await assertion;

    // 未超时：不触发第二次快照读取
    const getContextCalls = sent.filter((m) => m.type === "sidepanel-get-context").length;
    expect(getContextCalls).toBe(2); // 首查 + refresh 后复查
  });
});
