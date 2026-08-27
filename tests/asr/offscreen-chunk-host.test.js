// offscreen-bridge.js 页面侧 chunk host 测试（createOffscreenChunkHost）：
// - mock chrome.runtime.connect：连 "asr-decode" 端口，手动派发 chunk/done/
//   error/断连消息，验证页面侧收包还原逻辑
// - chunk 按 index 排序收集 + base64 还原为 Blob + done resolve
// - error 消息 reject 且带文案；port 断连未 done → reject「音频解码中断」
// - bytesToBase64 / base64ToBytes 往返一致
// 参考 probes 测试的 mock 风格：beforeEach 重建 chrome stub，用例内直接
// 捕获 connect 返回的 port 手动触发事件。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

// 构造一个可手动驱动的 chrome.runtime.connect mock：
// 捕获每次 connect 调用，把 port 的 onMessage/onDisconnect 监听器存下来，
// 用例内调用 emitMessage/emitDisconnect 派发事件，postMessage 记录调用。
function installConnectMock() {
  const connections = [];
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
      connect
    }
  });
  return { connect, connections };
}

let bridge;

beforeEach(() => {
  resetModuleState();
});

describe("createOffscreenChunkHost 收包与还原", () => {
  it("chunk 消息按 index 排序收集 + base64 还原为 Blob + done resolve", async () => {
    const { connect, connections } = installConnectMock();
    bridge = await import("../../extension/asr/offscreen-bridge.js");

    const { bytesToBase64, base64ToBytes } = bridge;
    // 片 1 与片 2 的 WAV 字节（内容可辨识：不同样本值序列）
    const wav1 = new Uint8Array([1, 2, 3, 4, 5]);
    const wav2 = new Uint8Array([9, 8, 7, 6, 5]);
    const host = bridge.createOffscreenChunkHost();

    const promise = host({ audioUrl: "https://x/a.m4s", backupUrls: [], plan: { chunkSeconds: 600 } });

    // host 内部先 await prepare 消息（异步），flush 微任务后再取 port
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connect).toHaveBeenCalledTimes(1);
    const port = connections[0];
    // 任务参数透传：audioUrl / chunkSeconds 折算
    expect(port.posted).toHaveLength(1);
    expect(port.posted[0]).toEqual({
      action: "asr-decode",
      task: { audioUrl: "https://x/a.m4s", backupUrls: [], chunkSeconds: 600 }
    });

    // 乱序发送：先发 index=1，再发 index=0，验证 done 前收集、done 后排序
    port._emit({ type: "chunk", index: 1, startSec: 600, durationSec: 60, wavBase64: bytesToBase64(wav2) });
    port._emit({ type: "chunk", index: 0, startSec: 0, durationSec: 600, wavBase64: bytesToBase64(wav1) });
    port._emit({ type: "done", totalChunks: 2 });

    const chunks = await promise;
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.index)).toEqual([0, 1]);
    expect(chunks[0].startSec).toBe(0);
    expect(chunks[0].durationSec).toBe(600);
    expect(chunks[1].startSec).toBe(600);
    for (const c of chunks) {
      expect(c.wavBlob).toBeInstanceOf(Blob);
      expect(c.wavBlob.type).toBe("audio/wav");
    }
    // base64 还原字节与原始一致
    const bytes0 = new Uint8Array(await chunks[0].wavBlob.arrayBuffer());
    const bytes1 = new Uint8Array(await chunks[1].wavBlob.arrayBuffer());
    expect([...bytes0]).toEqual([...wav1]);
    expect([...bytes1]).toEqual([...wav2]);
    // done 后 disconnect + cleanup 消息（sendOffloadMessage 带 type 前缀）
    expect(port.disconnect).toHaveBeenCalledTimes(1);
    expect(globalThis.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: "offload-task", taskType: "asr-decode-cleanup" },
      expect.any(Function)
    );
  });

  it("error 消息 reject 且带文案", async () => {
    const { connect, connections } = installConnectMock();
    bridge = await import("../../extension/asr/offscreen-bridge.js");
    const host = bridge.createOffscreenChunkHost();

    const promise = host({ audioUrl: "https://x/a.m4s", backupUrls: [], plan: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const port = connections[0];
    port._emit({ type: "error", error: "音频解码失败：解码结果疑似静音（时长 1s、峰值幅度 0）" });

    await expect(promise).rejects.toThrow(/疑似静音/);
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });

  it("port 断连且未 done → reject「音频解码中断」", async () => {
    const { connect, connections } = installConnectMock();
    bridge = await import("../../extension/asr/offscreen-bridge.js");
    const host = bridge.createOffscreenChunkHost();

    const promise = host({ audioUrl: "https://x/a.m4s", backupUrls: [], plan: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const port = connections[0];
    port._emitDisconnect();

    await expect(promise).rejects.toThrow("音频解码中断：后台连接已断开");
  });

  it("prepare 返回非 ok → 直接 reject，不建端口", async () => {
    const { connect, connections } = installConnectMock();
    globalThis.chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message?.taskType === "asr-decode-prepare") {
        callback?.({ ok: false, error: "创建 offscreen 文档失败" });
        return undefined;
      }
      callback?.({ ok: true });
      return undefined;
    });
    bridge = await import("../../extension/asr/offscreen-bridge.js");
    const host = bridge.createOffscreenChunkHost();

    await expect(host({ audioUrl: "https://x/a.m4s", backupUrls: [], plan: {} })).rejects.toThrow(
      "创建 offscreen 文档失败"
    );
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("bytesToBase64 / base64ToBytes 往返", () => {
  it("随机字节往返一致（覆盖多分块路径：>0x8000 字节）", async () => {
    bridge = await import("../../extension/asr/offscreen-bridge.js");
    const { bytesToBase64, base64ToBytes } = bridge;

    const total = 0x8000 * 3 + 123;
    const bytes = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      bytes[i] = (i * 31 + 7) % 256;
    }
    const b64 = bytesToBase64(bytes);
    expect(typeof b64).toBe("string");
    const restored = base64ToBytes(b64);
    expect(restored).toBeInstanceOf(Uint8Array);
    expect(restored.byteLength).toBe(total);
    expect([...restored]).toEqual([...bytes]);
  });

  it("空字节数组往返：base64 为空串", async () => {
    bridge = await import("../../extension/asr/offscreen-bridge.js");
    const { bytesToBase64, base64ToBytes } = bridge;
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
    expect(base64ToBytes("").byteLength).toBe(0);
  });
});
