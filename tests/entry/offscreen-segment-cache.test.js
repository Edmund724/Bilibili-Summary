// offscreen 段缓存消息族端到端回归（arch-review-2026-09/05，原 storage 桥测试改造）：
// 平台限制——offscreen 文档只有 chrome.runtime、没有 chrome.storage，段缓存宿主
// 是 SW。本测试构造「runtime 消息路由到 SW 端 segment-cache handler（内存
// storage）」的环境，跑通真实 ladder → map-reduce → segment-cache-proxy →
// 消息 → segment-cache 链路，断言：
// - 原始段 / 分段小结读写全部经 segment-cache 消息族落 SW（内存 store 可见）；
// - LRU 索引登记了两个族；
// - 全程无「本地字幕缓存写入失败」提示。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { chatCompletionMock } = vi.hoisted(() => ({ chatCompletionMock: vi.fn() }));

vi.mock("../../extension/ai/completion.js", async (importOriginal) => ({
  ...(await importOriginal()),
  chatCompletion: chatCompletionMock
}));

import { createSegmentCacheHandler } from "../../extension/ai/segment-cache-handler.js";

// 208k 字符（>200k 预算线 → map-reduce；5 段 + 成稿 = 6 次调用 ≥5 → 弹成本护栏，
// 测试内自动确认）
function makeBody() {
  return Array.from({ length: 2600 }, (_, i) => ({
    from: i * 4,
    to: i * 4 + 4,
    content: "字".repeat(80)
  }));
}

const CONTEXT_KEY = "video:BV1bridge|101";
let onConnectListeners = [];
let memoryArea;
let segmentCacheHandler;
let sendMessageMock;

function makeMemoryArea() {
  const store = new Map();
  return {
    store,
    get: vi.fn(async (keys) => {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(store);
      }
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of wanted) if (store.has(k)) out[k] = store.get(k);
      return out;
    }),
    set: vi.fn(async (items) => {
      for (const [k, v] of Object.entries(items || {})) store.set(k, v);
    }),
    remove: vi.fn(async (keys) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    })
  };
}

function stubChromeRuntime() {
  sendMessageMock = vi.fn(async (message) => {
    if (message?.type === "resolve-ai-provider") {
      return {
        ok: true,
        provider: { id: "p1", name: "测试平台", model: "m1", enabled: true, requiresKey: false, hasSavedKey: true },
        apiKey: "test-key"
      };
    }
    if (message?.type === "segment-cache") {
      // 路由到 SW 端真实 handler（segment-cache 单源 + 内存 storage）
      return new Promise((resolve) => segmentCacheHandler(message, {}, resolve));
    }
    return { ok: true };
  });
  vi.stubGlobal("chrome", {
    runtime: {
      onConnect: { addListener: (fn) => onConnectListeners.push(fn) },
      sendMessage: sendMessageMock
    },
    // SW 侧 handler 直调 segment-cache → chrome.storage.local（内存实现）
    storage: { local: memoryArea },
    offscreen: { closeDocument: vi.fn(async () => {}) }
  });
}

async function importOffscreen() {
  onConnectListeners = [];
  stubChromeRuntime();
  return import("../../extension/entry/offscreen.js");
}

function connectChat() {
  const port = {
    name: "offscreen-chat",
    onMessage: { addListener: (fn) => (port._onMessage = fn) },
    onDisconnect: { addListener: (fn) => {} },
    postMessage: vi.fn(),
    disconnect: vi.fn()
  };
  onConnectListeners[0](port);
  return {
    port,
    send: (msg) => port._onMessage(msg)
  };
}

beforeEach(() => {
  chatCompletionMock.mockReset();
  chatCompletionMock.mockImplementation(async () => "分段小结内容");
  memoryArea = makeMemoryArea();
  segmentCacheHandler = createSegmentCacheHandler();
  vi.unstubAllGlobals();
});

describe("offscreen 段缓存消息族端到端（Map-Reduce 缓存落盘）", () => {
  it("offscreen 里跑 Map-Reduce：段缓存经消息落 SW、无写入失败提示", async () => {
    await importOffscreen();
    const session = connectChat();
    session.send({
      action: "chat",
      providerId: "p1",
      contextKey: CONTEXT_KEY,
      context: { title: "长视频", subtitleBody: makeBody() },
      prompt: "总结"
    });

    // 抬线（200k）后夹具预估 6 次调用 ≥5 → 先弹成本护栏：自动确认后编排才启动
    await vi.waitFor(() => {
      expect(session.port.postMessage.mock.calls.some((c) => c[0]?.type === "cost-guard")).toBe(true);
    });
    session.send({ action: "cost-guard-confirm", ok: true });

    // 成稿回吐 = 编排完整跑完（map 5 段 + 成稿，缓存全部经消息落 SW）
    await vi.waitFor(() => {
      expect(session.port.postMessage.mock.calls.some((c) => c[0]?.type === "done")).toBe(true);
    });

    // raw / summary 两族的读（miss）与写都经 segment-cache 消息族过 SW
    const ops = sendMessageMock.mock.calls
      .map((c) => c[0])
      .filter((m) => m?.type === "segment-cache")
      .map((m) => m.op);
    expect(ops.filter((op) => op === "load-summary").length).toBe(5);
    expect(ops.filter((op) => op === "save-summary").length).toBe(5);
    expect(ops.filter((op) => op === "save-raw").length).toBe(5);

    const storeKeys = [...memoryArea.store.keys()];
    const rawKeys = storeKeys.filter((k) => k.startsWith("boc_lvs_raw_"));
    const summaryKeys = storeKeys.filter((k) => k.startsWith("boc_lvs_summary_"));
    expect(rawKeys.length).toBe(5);
    expect(summaryKeys.length).toBe(5);
    expect(storeKeys).toContain("boc_cache_lru_index");

    const notices = session.port.postMessage.mock.calls.map((c) => c[0]).filter((m) => m?.type === "notice");
    expect(notices.some((m) => String(m.data || "").includes("本地字幕缓存写入失败"))).toBe(false);
  });
});
