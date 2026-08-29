// entry/offscreen-asr.js 的 resolveAsrProvider 结构化 skip 原因测试。
//
// 背景：offscreen 侧配置级问题以 code "asr-skip" 抛出，页面 asr/fallback.js
// catch 后静默 skip。此前原因只存在于 message 字符串里（页面不做字符串匹配，
// 无法归类）；现新增结构化 reason 字段（"asr-disabled" / "no-asr-config"），
// 经 port 错误消息（offscreen-bridge）与管线 reject 透传回页面，最终落
// clipState.noSubtitleReason 供 sidepanel 按原因提示。
//
// resolveAsrProvider 是纯函数（只读传入的 config 快照），直接 import
// offscreen-asr.js 测试（模块顶层不触 chrome）。port 透传契约测试则动态
// import entry/offscreen.js——它顶层注册 chrome.runtime.onConnect 监听，
// beforeEach 的 chrome stub 捕获该监听器，测试内拿它接一个可手动驱动消息的
// 假 asr-decode 端口（接线层把任务转给 offscreen-asr 的执行器）。其余依赖
// （ai/*、asr/*、core/runtime → fetcher 链）在 jsdom 下均可真实加载。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { resolveAsrProvider } from "../../extension/entry/offscreen-asr.js";

const RUNTIME_CONFIG_OK = {
  asrAutoFallback: true,
  activeAsrProviderId: "p1",
  providers: [{ id: "p1", type: "openai-transcriptions", name: "硅基流动" }],
  activeKey: "sk-test",
  asrLanguage: "auto"
};

// onConnect 监听器捕获袋（beforeEach 重建；模块重导入后注册的监听器都进这里）
let onConnectListeners = [];

beforeEach(() => {
  resetModuleState();
  onConnectListeners = [];
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    runtime: {
      ...globalThis.chrome.runtime,
      onConnect: {
        addListener: vi.fn((fn) => onConnectListeners.push(fn))
      }
    }
  });
});

async function loadOffscreen() {
  return import("../../extension/entry/offscreen.js");
}

// 连一个可手动驱动消息的 asr-decode 端口，返回 { port, taskListener }
function connectAsrDecodePort() {
  const listener = onConnectListeners[onConnectListeners.length - 1];
  expect(listener, "offscreen.js 应已在模块加载时注册 onConnect 监听").toBeTruthy();
  const listeners = new Set();
  const port = {
    name: "asr-decode",
    postMessage: vi.fn(),
    onMessage: { addListener: (fn) => listeners.add(fn) },
    onDisconnect: { addListener: vi.fn() }
  };
  listener(port);
  return { port, taskListener: [...listeners][0] };
}

describe("resolveAsrProvider 结构化 skip 原因", () => {
  it("快照关闭（asrAutoFallback === false）：asr-skip 且 reason=asr-disabled", () => {
    expect(() => resolveAsrProvider({ ...RUNTIME_CONFIG_OK, asrAutoFallback: false })).toThrowError(
      expect.objectContaining({
        code: "asr-skip",
        reason: "asr-disabled",
        message: "ASR 自动回退未开启"
      })
    );
  });

  it("无激活平台（activeAsrProviderId 为空 / 不在列表）：asr-skip 且 reason=no-asr-config", () => {
    expect(() => resolveAsrProvider({ ...RUNTIME_CONFIG_OK, activeAsrProviderId: "" })).toThrowError(
      expect.objectContaining({
        code: "asr-skip",
        reason: "no-asr-config",
        message: "没有激活的语音识别平台"
      })
    );

    expect(() => resolveAsrProvider({ ...RUNTIME_CONFIG_OK, activeAsrProviderId: "ghost" })).toThrowError(
      expect.objectContaining({
        code: "asr-skip",
        reason: "no-asr-config"
      })
    );
  });

  it("配置齐全：不抛错，provider 附 Key 与生效语言", () => {
    const provider = resolveAsrProvider(RUNTIME_CONFIG_OK);

    expect(provider).toMatchObject({
      id: "p1",
      type: "openai-transcriptions",
      apiKey: "sk-test",
      language: "auto"
    });
  });
});

describe("handleAsrDecodeTask 错误消息携带 reason（port 透传契约）", () => {
  it("asr-skip 的结构化 reason 随 { type: error } 消息 postMessage 回页面", async () => {
    await loadOffscreen();
    // requestAsrRuntimeConfig 以 Promise 风格 await sendMessage 返回值（MV3
    // 无回调签名），setup 的回调式 stub 不适用——这里改为直接返回响应体。
    // 响应无 provider 字段 → resolveAsrProvider 走「无激活平台」分支。
    vi.stubGlobal("chrome", {
      ...globalThis.chrome,
      runtime: {
        ...globalThis.chrome.runtime,
        onConnect: {
          addListener: vi.fn((fn) => onConnectListeners.push(fn))
        },
        sendMessage: vi.fn(() => ({ ok: true }))
      }
    });
    const { port, taskListener } = connectAsrDecodePort();

    taskListener({ action: "asr-decode", task: { audioUrl: "https://x/a.m4s" } });

    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(1));
    expect(port.postMessage.mock.calls[0][0]).toEqual({
      type: "error",
      error: "没有激活的语音识别平台",
      code: "asr-skip",
      reason: "no-asr-config"
    });
  });

  it("config 消息失败/超时的 asr-skip 不带 reason（未知，页面归 null）", async () => {
    // sendMessage 直接抛错 → requestAsrRuntimeConfig 失败（非 asr-skip）→
    // 按「配置缺失」兜底 makeAsrSkipError(error)，不带 reason。
    // offscreen.js 已在上一用例的 stub 下加载完毕，这里只替换 sendMessage。
    await loadOffscreen();
    vi.stubGlobal("chrome", {
      ...globalThis.chrome,
      runtime: {
        ...globalThis.chrome.runtime,
        onConnect: {
          addListener: vi.fn((fn) => onConnectListeners.push(fn))
        },
        sendMessage: () => {
          throw new Error("Extension context invalidated");
        }
      }
    });
    const { port, taskListener } = connectAsrDecodePort();

    taskListener({ action: "asr-decode", task: { audioUrl: "https://x/a.m4s" } });

    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(1));
    const payload = port.postMessage.mock.calls[0][0];
    expect(payload.type).toBe("error");
    expect(payload.code).toBe("asr-skip");
    expect(payload.reason).toBeUndefined();
  });
});
