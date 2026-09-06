// offscreen storage 桥端到端回归（根因修复验证）：
// 平台限制——offscreen 文档只有 chrome.runtime、没有 chrome.storage，Map-Reduce
// 的段缓存读写此前在真实浏览器里全部失败（写入弹「本地字幕缓存写入失败」提示，
// 读取静默 miss，缓存从未生效）。本测试构造「无 chrome.storage + runtime 消息
// 路由到 SW 端桥 handler（内存 storage）」的环境，跑通真实 ladder → map-reduce
// → segment-cache 链路，断言：
// - 原始段 / 分段小结键真实落盘（内存 store 可见）；
// - LRU 索引登记了两个族；
// - 全程无「本地字幕缓存写入失败」提示。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { chatCompletionMock } = vi.hoisted(() => ({ chatCompletionMock: vi.fn() }));

vi.mock("../../extension/ai/completion.js", async (importOriginal) => ({
  ...(await importOriginal()),
  chatCompletion: chatCompletionMock
}));

import { createStorageLocalBridgeHandler } from "../../extension/core/storage-bridge.js";

// 120k 字符（>100k 预算线 → map-reduce；3 段 + 成稿 = 4 次调用 < 5 → 不弹成本护栏）
function makeBody() {
  return Array.from({ length: 1500 }, (_, i) => ({
    from: i * 4,
    to: i * 4 + 4,
    content: "字".repeat(80)
  }));
}

const CONTEXT_KEY = "video:BV1bridge|101";
let onConnectListeners = [];
let memoryArea;
let bridgeHandler;

function makeMemoryArea() {
  const store = new Map();
  return {
    store,
    async get(keys) {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(store);
      }
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of wanted) if (store.has(k)) out[k] = store.get(k);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items || {})) store.set(k, v);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    }
  };
}

function stubChromeRuntime() {
  vi.stubGlobal("chrome", {
    runtime: {
      onConnect: { addListener: (fn) => onConnectListeners.push(fn) },
      sendMessage: vi.fn(async (message) => {
        if (message?.type === "resolve-ai-provider") {
          return {
            ok: true,
            provider: { id: "p1", name: "测试平台", model: "m1", enabled: true, requiresKey: false, hasSavedKey: true },
            apiKey: "test-key"
          };
        }
        if (message?.type === "storage-local-bridge") {
          return new Promise((resolve) => bridgeHandler(message, {}, resolve));
        }
        return { ok: true };
      })
    },
    offscreen: { closeDocument: vi.fn(async () => {}) }
    // 刻意不提供 chrome.storage：模拟 offscreen 平台限制，逼出垫片安装
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
  bridgeHandler = createStorageLocalBridgeHandler({ storageLocal: memoryArea });
  vi.unstubAllGlobals();
});

describe("offscreen storage 桥端到端（Map-Reduce 缓存落盘）", () => {
  it("无 chrome.storage 的 offscreen 里跑 Map-Reduce：段缓存落盘、无写入失败提示", async () => {
    await importOffscreen();
    const session = connectChat();
    session.send({
      action: "chat",
      providerId: "p1",
      contextKey: CONTEXT_KEY,
      context: { title: "长视频", subtitleBody: makeBody() },
      prompt: "总结"
    });

    // 成稿回吐 = 编排完整跑完（map 3 段 + 成稿，全部走桥落盘）
    await vi.waitFor(() => {
      expect(session.port.postMessage.mock.calls.some((c) => c[0]?.type === "done")).toBe(true);
    });

    const storeKeys = [...memoryArea.store.keys()];
    const rawKeys = storeKeys.filter((k) => k.startsWith("boc_lvs_raw_"));
    const summaryKeys = storeKeys.filter((k) => k.startsWith("boc_lvs_summary_"));
    expect(rawKeys.length).toBe(3);
    expect(summaryKeys.length).toBe(3);
    expect(storeKeys).toContain("boc_cache_lru_index");

    const notices = session.port.postMessage.mock.calls.map((c) => c[0]).filter((m) => m?.type === "notice");
    expect(notices.some((m) => String(m.data || "").includes("本地字幕缓存写入失败"))).toBe(false);
  });
});
