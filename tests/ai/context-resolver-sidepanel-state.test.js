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

// ===== 候选5：签名短路（ifSignature 透传 + unchanged 提前返回） =====
// 本文件只锁 resolver 层的契约：ifSignature 原样带给 content、unchanged 提前
// 返回（热评/popup-refresh 全部跳过）、全量路径 signature 透传到返回 payload。
// content 侧的短路判定本体在 tests/core/message-handler-signature.test.js。

const CONTENT_SIGNATURE = "sig-content-v1";

// 模拟已实现签名短路的 content：ifSignature 与当前签名一致且未强制刷新 →
// 回 unchanged；否则回全量 payload（附 signature）。签名对 resolver 是不透明串。
function makeSignatureAwareResponder(sent) {
  return vi.fn(async (_tabId, message) => {
    sent.push(message);
    if (message.type === "sidepanel-get-context") {
      if (
        message.forceRefresh !== true &&
        typeof message.ifSignature === "string" &&
        message.ifSignature &&
        message.ifSignature === CONTENT_SIGNATURE
      ) {
        return { ok: true, unchanged: true, signature: CONTENT_SIGNATURE };
      }
      return {
        ok: true,
        payload: {
          url: "https://www.bilibili.com/video/BV1test/",
          title: "五小时访谈",
          bvid: "BV1test",
          aid: "1",
          cid: "101",
          subtitleBody: [{ from: 0, to: 5, content: "第一句" }],
          subtitleFetchState: "ready",
          signature: CONTENT_SIGNATURE
        }
      };
    }
    if (message.type === "sidepanel-get-hot-comments") {
      return { ok: true, comments: [{ uname: "u", like: 1, message: "m" }] };
    }
    if (message.type === "popup-refresh") {
      return { ok: true };
    }
    return { ok: true };
  });
}

describe("getAiSidepanelState：签名短路（候选5）", () => {
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

  function runGetState(options) {
    return getAiSidepanelState(
      1,
      options,
      {
        ensureReaderContentReady: vi.fn(async () => {}),
        sendMessageToTab: makeSignatureAwareResponder(sent)
      }
    );
  }

  it("ifSignature 命中：透传 { unchanged: true }，不发 popup-refresh、不拉热评", async () => {
    const result = await runGetState({ ifSignature: CONTENT_SIGNATURE });

    // SP 收到 unchanged 后跳过 apply/渲染，保持现有快照不动
    expect(result).toEqual({ unchanged: true });

    // 一次往返即结束：短路后没有任何后续消息
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "sidepanel-get-context", ifSignature: CONTENT_SIGNATURE, forceRefresh: false });
    expect(sent.some((m) => m.type === "sidepanel-get-hot-comments")).toBe(false);
    expect(sent.some((m) => m.type === "popup-refresh")).toBe(false);
  });

  it("ifSignature 未命中：走全量路径，signature 透传到 payload 且照拉热评", async () => {
    const payload = await runGetState({ ifSignature: "stale-signature" });

    expect(payload.title).toBe("五小时访谈");
    expect(payload.signature).toBe(CONTENT_SIGNATURE);
    expect(payload.hotComments).toHaveLength(1);
    expect(payload.isVideoContext).toBe(true);
    expect(sent.some((m) => m.type === "sidepanel-get-hot-comments")).toBe(true);
  });

  it("forceRefresh=true 绕过短路：签名命中仍走 popup-refresh 全量路径", async () => {
    const payload = await runGetState({ forceRefresh: true, ifSignature: CONTENT_SIGNATURE });

    expect(payload.title).toBe("五小时访谈");
    expect(payload.signature).toBe(CONTENT_SIGNATURE);
    expect(sent.some((m) => m.type === "popup-refresh")).toBe(true);
  });

  it("旧调用方不带 ifSignature：不短路，全量返回（向后兼容）", async () => {
    const payload = await runGetState({});
    expect(payload.title).toBe("五小时访谈");
    expect(sent[0].ifSignature).toBe("");
  });
});
