// offscreen 空闲超时 × Map-Reduce 非流式段调用接线测试（回归：编排期间暂停空闲计时）：
// 原始 bug——7 小时长视频 Map-Reduce 期间弹「错误：请求超时（90 秒未返回任何数据），
// 已自动中断」且成稿失败。机制：map-reduce 全部模型调用走非流式 chatCompletion
// （无流式活动），进度 notice 只在整段完成时重挂空闲超时——任一时刻在途段调用
// 全部超过 90 秒无完成，空闲计时器就中止整个运行。
//
// 修复语义：Map-Reduce 编排期间整体暂停空闲超时（ladder.ts 两处 orchestrate 前
// pauseIdleTimeout），空闲计时只管流式单路；挂死由用户「停止」兜底。
//
// 回路设计：真实 ladder + 真实 map-reduce + 真实 budgeter/pool/cache-lru（内存
// chrome.storage），仅在协议接缝（ai/completion.js 的 chatCompletion）打桩为
// 「挂起直到 abort」的非流式调用；3 段并发全部挂起 → 推进假时钟远超 90 秒 →
// 断言端口不出现超时错误、运行不被中止（修复前此断言为红）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { chatCompletionMock } = vi.hoisted(() => ({ chatCompletionMock: vi.fn() }));

vi.mock("../../extension/ai/completion.js", async (importOriginal) => ({
  ...(await importOriginal()),
  chatCompletion: chatCompletionMock
}));

// 120k 字符（>100k 预算线 → map-reduce；3 段 + 成稿 = 4 次调用 < 5 → 不弹成本护栏）
function makeBody() {
  return Array.from({ length: 1500 }, (_, i) => ({
    from: i * 4,
    to: i * 4 + 4,
    content: "字".repeat(80)
  }));
}

let onConnectListeners = [];
let localStore;

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
        return { ok: true };
      })
    },
    offscreen: { closeDocument: vi.fn(async () => {}) },
    storage: {
      local: {
        get: vi.fn(async (keys) => {
          if (keys === null || keys === undefined) return { ...localStore };
          const wanted = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of wanted) if (k in localStore) out[k] = localStore[k];
          return out;
        }),
        set: vi.fn(async (obj) => {
          Object.assign(localStore, obj);
        }),
        remove: vi.fn(async (keys) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete localStore[k];
        })
      }
    }
  });
}

async function importOffscreen() {
  onConnectListeners = [];
  localStore = {};
  stubChromeRuntime();
  return import("../../extension/entry/offscreen.js");
}

function connectChat() {
  expect(onConnectListeners).toHaveLength(1);
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

async function flushThroughChatCall(session) {
  // 微任务排水：让 chat 处理链走到挂起的 chatCompletion（多轮推进假时钟，其间
  // advanceTimersByTimeAsync 会排空微任务）
  for (let i = 0; i < 50 && chatCompletionMock.mock.calls.length === 0; i++) {
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(chatCompletionMock.mock.calls.length).toBeGreaterThan(0);
}

beforeEach(async () => {
  chatCompletionMock.mockReset();
  // 预热 AI 模块图（真实时钟下）：vitest 在假时钟下解析动态 import() 会挂起，
  // 预热后 offscreen 的 ladderLoader.load() 命中注册表缓存、微任务即返回。
  await import("../../extension/ai/ladder.js");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Map-Reduce 编排期间空闲超时暂停（回归）", () => {
  it("段调用（非流式）挂起远超 90 秒 → 不再出现空闲超时中止，运行保持等待", async () => {
    // 挂起直到 abort：模拟慢供应商的非流式段调用（无任何流式活动）
    chatCompletionMock.mockImplementation(({ signal }) => {
      return new Promise((_, reject) => {
        if (signal?.aborted) {
          reject(Object.assign(new Error("aborted"), { aborted: true }));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { aborted: true }));
        });
      });
    });

    await importOffscreen();
    const session = connectChat();
    session.send({
      action: "chat",
      providerId: "p1",
      contextKey: "video:BV1idle90|101",
      context: { title: "七小时长视频", subtitleBody: makeBody() },
      prompt: "总结"
    });
    await flushThroughChatCall(session);

    // 并发 3：首批段调用全部在途且挂起；推进远超原 90 秒窗口（含多次窗口跨度）
    await vi.advanceTimersByTimeAsync(90_000);
    await vi.advanceTimersByTimeAsync(90_000);

    const posted = session.port.postMessage.mock.calls.map((c) => c[0]);
    expect(posted.some((m) => m?.type === "error" && String(m.error || "").includes("请求超时"))).toBe(false);
    expect(posted.some((m) => m?.type === "stopped")).toBe(false);
  });
});
