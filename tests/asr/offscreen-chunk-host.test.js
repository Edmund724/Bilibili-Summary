// offscreen-bridge.js 页面侧客户端测试（createOffscreenChunkHost）：
// - mock chrome.runtime.connect：连 "asr-decode" 端口，手动派发 progress/
//   chunk-result/done/error/断连消息，验证页面侧收包逻辑
// - 跨 port 只传文本结果：chunk-result 的 result 原样透传（无 Blob/base64），
//   done 后按 index 排序汇总 { results, totalChunks, skippedSegments, failedChunks }
// - progress 文本原样中继 onProgress；error 消息 reject 且带 code（asr-skip）；
//   port 断连未 done → reject「音频解码中断」（真断连是唯一的任务取消路径，
//   旧 isStale 每消息复核/跨 context 中止已随"转写与视频切换解耦"移除）
// 参考 probes 测试的 mock 风格：beforeEach 重建 chrome stub，用例内直接
// 捕获 connect 返回的 port 手动触发事件。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

// 构造一个可手动驱动的 chrome.runtime.connect mock：
// 捕获每次 connect 调用，把 port 的 onMessage/onDisconnect 监听器存下来，
// 用例内调用 emitMessage/emitDisconnect 派发事件，postMessage 记录调用。
// sendMessage 每次重建（默认回 ok:true），避免前一用例的 mockImplementation
// 污染（jsdom 全局 chrome 一经 stub 便不重置）。
function installConnectMock() {
  const connections = [];
  const sendMessage = vi.fn((_message, callback) => {
    callback?.({ ok: true });
    return undefined;
  });
  const connect = vi.fn(() => {
    const listeners = new Set();
    const disconnectListeners = new Set();
    const port = {
      name: "asr-decode",
      posted: [],
      postMessage: vi.fn((msg) => port.posted.push(msg)),
      onMessage: { addListener: (fn) => listeners.add(fn) },
      onDisconnect: { addListener: (fn) => disconnectListeners.add(fn) },
      disconnect: vi.fn(),
      _listeners: listeners,
      _disconnectListeners: disconnectListeners,
      _emit: (msg) => listeners.forEach((fn) => fn(msg)),
      _emitDisconnect: () => disconnectListeners.forEach((fn) => fn())
    };
    connections.push(port);
    return port;
  });
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    runtime: {
      ...globalThis.chrome.runtime,
      sendMessage,
      connect
    }
  });
  return { connect, connections, sendMessage };
}

beforeEach(() => {
  resetModuleState();
});

describe("createOffscreenChunkHost 文本结果收包", () => {
  it("任务参数透传：audioUrl/backupUrls，不再携带 chunkSeconds（切片计划由 offscreen 决定）", async () => {
    const { connect, connections } = installConnectMock();
    const bridge = await import("../../extension/asr/offscreen-bridge.js");
    const host = bridge.createOffscreenChunkHost();

    const promise = host({ audioUrl: "https://x/a.m4s", backupUrls: ["https://y/a.m4s"] });

    // host 内部先 await prepare 消息（异步），flush 微任务后再取 port
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connect).toHaveBeenCalledTimes(1);
    const port = connections[0];
    expect(port.posted).toHaveLength(1);
    expect(port.posted[0]).toEqual({
      action: "asr-decode",
      task: { audioUrl: "https://x/a.m4s", backupUrls: ["https://y/a.m4s"] }
    });

    port._emit({ type: "done", totalChunks: 0, skippedSegments: 0, failedChunks: 0 });
    const out = await promise;
    expect(out.results).toEqual([]);
  });

  it("chunk-result 按 index 排序收集，result 原样透传；done 汇总计数", async () => {
    const { connections } = installConnectMock();
    const bridge = await import("../../extension/asr/offscreen-bridge.js");
    const host = bridge.createOffscreenChunkHost();

    const promise = host({ audioUrl: "https://x/a.m4s", backupUrls: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const port = connections[0];

    // 乱序发送：先发 index=1，再发 index=0，验证 done 前收集、done 后排序
    port._emit({
      type: "chunk-result",
      index: 1,
      startSec: 1200,
      durationSec: 300,
      result: { text: "片二", segments: [{ start: 0, end: 1, text: "第三句" }] }
    });
    port._emit({
      type: "chunk-result",
      index: 0,
      startSec: 0,
      durationSec: 1200,
      result: { text: "片一", _asrDiag: { request: 2 } }
    });
    port._emit({ type: "done", totalChunks: 2, skippedSegments: 1, failedChunks: 0 });

    const out = await promise;
    expect(out.totalChunks).toBe(2);
    expect(out.skippedSegments).toBe(1);
    expect(out.failedChunks).toBe(0);
    expect(out.results.map((r) => r.index)).toEqual([0, 1]);
    // result 原样透传（纯 JSON 文本结果，无 Blob/base64 还原）
    expect(out.results[0]).toEqual({
      index: 0,
      startSec: 0,
      durationSec: 1200,
      result: { text: "片一", _asrDiag: { request: 2 } }
    });
    expect(out.results[1].result).toEqual({
      text: "片二",
      segments: [{ start: 0, end: 1, text: "第三句" }]
    });
    // done 后 disconnect + cleanup 消息（sendOffloadMessage 带 type 前缀）
    expect(port.disconnect).toHaveBeenCalledTimes(1);
    expect(globalThis.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: "offload-task", taskType: "asr-decode-cleanup" },
      expect.any(Function)
    );
  });

  it("progress 文本原样中继 onProgress", async () => {
    const { connections } = installConnectMock();
    const bridge = await import("../../extension/asr/offscreen-bridge.js");
    const host = bridge.createOffscreenChunkHost();
    const onProgress = vi.fn();

    const promise = host({ audioUrl: "https://x/a.m4s", backupUrls: [], onProgress });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const port = connections[0];
    port._emit({ type: "progress", text: "语音识别中 2 片…" });
    port._emit({ type: "done", totalChunks: 2, skippedSegments: 0, failedChunks: 0 });

    await promise;
    expect(onProgress).toHaveBeenCalledWith("语音识别中 2 片…");
  });

  it("error 消息 reject 且带 code（asr-skip 映射为 Error.code）", async () => {
    const { connections } = installConnectMock();
    const bridge = await import("../../extension/asr/offscreen-bridge.js");
    const host = bridge.createOffscreenChunkHost();

    const promise = host({ audioUrl: "https://x/a.m4s", backupUrls: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const port = connections[0];
    port._emit({ type: "error", code: "asr-skip", error: "没有激活的语音识别平台" });

    await expect(promise).rejects.toMatchObject({
      code: "asr-skip",
      message: "没有激活的语音识别平台"
    });
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });

  it("port 断连且未 done → reject「音频解码中断」", async () => {
    const { connections } = installConnectMock();
    const bridge = await import("../../extension/asr/offscreen-bridge.js");
    const host = bridge.createOffscreenChunkHost();

    const promise = host({ audioUrl: "https://x/a.m4s", backupUrls: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const port = connections[0];
    port._emitDisconnect();

    await expect(promise).rejects.toThrow("音频解码中断：后台连接已断开");
  });

  it("prepare 返回非 ok → 直接 reject，不建端口", async () => {
    const { connect, sendMessage } = installConnectMock();
    sendMessage.mockImplementation((message, callback) => {
      if (message?.taskType === "asr-decode-prepare") {
        callback?.({ ok: false, error: "创建 offscreen 文档失败" });
        return undefined;
      }
      callback?.({ ok: true });
      return undefined;
    });
    const bridge = await import("../../extension/asr/offscreen-bridge.js");
    const host = bridge.createOffscreenChunkHost();

    await expect(host({ audioUrl: "https://x/a.m4s", backupUrls: [] })).rejects.toThrow(
      "创建 offscreen 文档失败"
    );
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("任务取消只剩真断连（isStale 跨 context 复核已移除）", () => {
  it("转写中切换视频不再中止任务：即使调用方仍传 isStale 也不被消费，收包照常", async () => {
    const { connections } = installConnectMock();
    const bridge = await import("../../extension/asr/offscreen-bridge.js");
    const host = bridge.createOffscreenChunkHost();

    // 旧契约按注入的 isStale 在每条 port 消息到达时断连 reject；新契约宿主
    // 不再接收该参数——传了也被忽略，转写与视频切换解耦（abort 语义收敛到
    // port.onDisconnect）
    const promise = host({
      audioUrl: "https://x/a.m4s",
      backupUrls: [],
      isStale: () => true
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const port = connections[0];

    port._emit({ type: "chunk-result", index: 0, startSec: 0, durationSec: 60, result: { text: "x" } });
    port._emit({ type: "done", totalChunks: 1, skippedSegments: 0, failedChunks: 0 });

    await expect(promise).resolves.toMatchObject({ totalChunks: 1 });
  });

  it("port 断连仍是唯一取消路径：未 done 断连 → reject「音频解码中断」", async () => {
    const { connections } = installConnectMock();
    const bridge = await import("../../extension/asr/offscreen-bridge.js");
    const host = bridge.createOffscreenChunkHost();

    const promise = host({ audioUrl: "https://x/a.m4s", backupUrls: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const port = connections[0];
    port._emitDisconnect();

    await expect(promise).rejects.toThrow("音频解码中断：后台连接已断开");
  });
});
