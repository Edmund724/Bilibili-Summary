// 工单 03：offscreen 文档只保留标准 Web API + chrome.runtime 消息能力。
//
// 三段验证：
//   1. 静态扫描：entry/offscreen*.ts 与 offscreen.html 的代码（剥注释后）不再
//      出现 chrome.storage / chrome.offscreen / 其他扩展级 API——storage 读写、
//      closeDocument 等扩展级操作一律由 SW 代执行；
//   2. 调试日志门消息化：初始开关经 "get-debug-log-gate" 向 SW 读，变更靠
//      SW 广播的 "debug-log-gate-changed" 翻转（offscreen 侧零 chrome.storage）；
//   3. ASR 任务终态自关：直调 chrome.offscreen.closeDocument 改为
//      "offscreen-request-close" 消息请求 SW 代执行——SW 明确 ok:false 时记
//      日志，回包丢失（文档已在关闭中）静默不抛。

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const { createAsrDecodeHandlerMock } = vi.hoisted(() => ({ createAsrDecodeHandlerMock: vi.fn() }));

vi.mock("../../extension/entry/offscreen-asr.js", () => ({
  createAsrDecodeHandler: createAsrDecodeHandlerMock
}));

// ===== 1. 静态扫描：offscreen 侧零扩展级 API =====

const OFFSCREEN_SOURCES = [
  "../../extension/entry/offscreen.ts",
  "../../extension/entry/offscreen-asr.ts",
  "../../extension/entry/offscreen-lifecycle.ts",
  "../../extension/entry/offscreen-subtitle-slot.ts",
  "../../extension/entry/offscreen.html"
];

// 扩展级 Chrome API 黑名单：offscreen 只保留标准 Web API + chrome.runtime 消息
const FORBIDDEN_API_RE = /chrome\.(storage|offscreen|declarativeNetRequest|tabs|permissions|scripting|action|alarms|windows|downloads)\b/g;

function readStrippedSource(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  expect(existsSync(fileURLToPath(url)), `扫描目标存在：${relativePath}`).toBe(true);
  const raw = readFileSync(fileURLToPath(url), "utf8");
  // 剥块注释与整行注释：注释里的 API 名举例（如「chrome.offscreen 由 SW 代执行」）
  // 不参与扫描
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("静态扫描：offscreen 文档不触碰扩展级 Chrome API", () => {
  it.each(OFFSCREEN_SOURCES)("代码里零 chrome.storage/offscreen/tabs 等扩展级 API：%s", (source) => {
    const offenders = readStrippedSource(source).match(FORBIDDEN_API_RE) || [];
    expect(offenders, `${source} 出现扩展级 API：${[...new Set(offenders)].join(", ")}`).toEqual([]);
  });

  it("chrome.runtime 消息能力保留（守卫不误伤）", () => {
    expect(readStrippedSource("../../extension/entry/offscreen.ts")).toMatch(/chrome\.runtime\./);
  });
});

// ===== 2/3. 行为测试：消息式调试门 + 自关请求 =====

let sendMessageMock;
let onMessageListeners;
let onConnectListeners;

function stubOffscreenEnv({ sendMessageImpl } = {}) {
  onMessageListeners = [];
  onConnectListeners = [];
  sendMessageMock = vi.fn((_message, callback) => {
    if (sendMessageImpl) {
      sendMessageImpl(_message, callback);
      return undefined;
    }
    callback?.({ ok: true });
    return undefined;
  });
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: null,
      onConnect: { addListener: (fn) => onConnectListeners.push(fn) },
      onMessage: {
        addListener: (fn) => onMessageListeners.push(fn),
        removeListener: vi.fn(),
        hasListener: vi.fn()
      },
      sendMessage: sendMessageMock
    }
  });
}

async function importOffscreen(envOptions) {
  vi.resetModules();
  stubOffscreenEnv(envOptions);
  return import("../../extension/entry/offscreen.js");
}

function makeAsrPort() {
  const listeners = { message: [], disconnect: [] };
  return {
    port: {
      name: "asr-decode",
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
      postMessage: vi.fn(),
      disconnect: vi.fn()
    },
    send: (msg) => listeners.message.forEach((fn) => fn(msg)),
    fireDisconnect: () => listeners.disconnect.forEach((fn) => fn())
  };
}

beforeEach(() => {
  createAsrDecodeHandlerMock.mockReset();
});

describe("offscreen 调试日志门：初始读 + 变更广播都走 runtime 消息", () => {
  it("启动即向 SW 请求初始开关：get-debug-log-gate，enabled=true 时门打开", async () => {
    stubOffscreenEnv({
      sendMessageImpl: (message, callback) => {
        if (message?.type === "get-debug-log-gate") {
          callback?.({ ok: true, enabled: true });
        }
      }
    });
    await import("../../extension/entry/offscreen.js");

    expect(sendMessageMock).toHaveBeenCalledWith(
      { type: "get-debug-log-gate" },
      expect.any(Function)
    );

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const logging = await import("../../extension/shared/logging.js");
    await vi.waitFor(() => {
      logging.logInfo("[BOC] gate on");
      expect(infoSpy).toHaveBeenCalledWith("[BOC] gate on");
    });
    infoSpy.mockRestore();
  });

  it("SW 广播 debug-log-gate-changed 翻转本地门（true/false 双向）", async () => {
    await importOffscreen();
    expect(onMessageListeners.length).toBeGreaterThanOrEqual(1);
    const broadcastListener = onMessageListeners[0];

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const logging = await import("../../extension/shared/logging.js");

    broadcastListener({ type: "debug-log-gate-changed", enabled: true });
    logging.logInfo("[BOC] on");
    expect(infoSpy).toHaveBeenCalledTimes(1);

    broadcastListener({ type: "debug-log-gate-changed", enabled: false });
    logging.logInfo("[BOC] off");
    expect(infoSpy).toHaveBeenCalledTimes(1);

    // 非门广播（其他消息）不翻转
    broadcastListener({ type: "something-else" });
    broadcastListener({ type: "debug-log-gate-changed" });
    logging.logInfo("[BOC] still off");
    expect(infoSpy).toHaveBeenCalledTimes(1);
    infoSpy.mockRestore();
  });

  it("初始请求失败（lastError）：门维持缺省关，不抛未处理拒绝", async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      stubOffscreenEnv({
        sendMessageImpl: (_message, callback) => {
          chrome.runtime.lastError = { message: "Receiving end does not exist" };
          callback?.(undefined);
          chrome.runtime.lastError = null;
        }
      });
      await import("../../extension/entry/offscreen.js");

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const logging = await import("../../extension/shared/logging.js");
      await new Promise((resolve) => setTimeout(resolve, 0));
      logging.logWarn("[BOC] quiet");
      expect(warnSpy).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
      warnSpy.mockRestore();
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});

describe("ASR 任务终态自关：closeDocument 改经 offscreen-request-close 消息", () => {
  function armTerminalEcho() {
    // 任务执行器立即回终态：触发 maybeCloseSelfAfterAsr（端口已入集、
    // 无聊天端口 → 应自关）
    createAsrDecodeHandlerMock.mockImplementation(({ onTaskTerminal }) => {
      return async (_task, port) => {
        onTaskTerminal(port);
      };
    });
  }

  it("终态后向 SW 发 offscreen-request-close；SW 回 ok:true 不告警", async () => {
    armTerminalEcho();
    await importOffscreen({
      sendMessageImpl: (message, callback) => {
        if (message?.type === "offscreen-request-close") {
          callback?.({ ok: true });
        }
      }
    });

    const session = makeAsrPort();
    onConnectListeners[0](session.port);
    session.send({ action: "asr-decode", task: {} });

    await vi.waitFor(() =>
      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: "offscreen-request-close" },
        expect.any(Function)
      )
    );
  });

  it("SW 明确回 ok:false（请求被拒/关闭失败）：记 logWarn，不抛", async () => {
    armTerminalEcho();
    await importOffscreen({
      sendMessageImpl: (message, callback) => {
        if (message?.type === "offscreen-request-close") {
          callback?.({ ok: false, error: "仅接受 offscreen 文档发送" });
        }
      }
    });

    // logWarn 走调试门：先经广播把门打开，告警才可观测
    onMessageListeners[0]({ type: "debug-log-gate-changed", enabled: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = makeAsrPort();
    onConnectListeners[0](session.port);
    session.send({ action: "asr-decode", task: {} });

    await vi.waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(
        "[BOC] offscreen closeDocument after asr task failed",
        { error: "仅接受 offscreen 文档发送" }
      )
    );
    warnSpy.mockRestore();
  });

  it("回包丢失（成功关闭时文档随之销毁）：静默，不告警也不抛 unhandled rejection", async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // sendMessageImpl 不回任何包：sendRuntimeMessage 的 promise 永不 settle
      armTerminalEcho();
      await importOffscreen({ sendMessageImpl: () => {} });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const session = makeAsrPort();
      onConnectListeners[0](session.port);
      session.send({ action: "asr-decode", task: {} });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
      warnSpy.mockRestore();
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});
