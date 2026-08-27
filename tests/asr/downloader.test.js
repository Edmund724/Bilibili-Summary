// downloader.js 单测：
// - 会话规则添加/清除生命周期（成功与失败路径都要 removeSessionRuleIds）
// - HEAD Content-Length 超 200MB 拒绝且不发起 GET
// - 主地址失败依次试备用地址（记录 fetch 调用顺序）
// - 分块拼合 assembleChunks / 4MB 上限切块 sliceChunks

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let dnrMock;
let fetchMock;

async function loadModule() {
  return import("../../extension/asr/downloader.js");
}

function makeResponse({ ok = true, status = 200, arrayBuffer, headers = {} }) {
  return {
    ok,
    status,
    arrayBuffer: async () => arrayBuffer,
    headers: { get: (name) => headers[name] ?? null }
  };
}

function makePort({ onDisconnect = false } = {}) {
  const posted = [];
  const port = {
    name: "asr-audio-chunk",
    posted,
    postMessage: vi.fn((msg) => posted.push(msg)),
    onMessage: { addListener: vi.fn() },
    onDisconnect: { addListener: vi.fn() }
  };
  if (onDisconnect) {
    port.disconnect = vi.fn();
  }
  return port;
}

function smallBytes() {
  return new Uint8Array([1, 2, 3, 4]).buffer;
}

beforeEach(() => {
  vi.resetModules();
  resetModuleState();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  dnrMock = {
    updateSessionRules: vi.fn(async () => {})
  };
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    declarativeNetRequest: dnrMock
  });
});

describe("handleAsrDownload 生命周期", () => {
  it("成功路径：先加规则、后收尾清规则", async () => {
    const { handleAsrDownload } = await loadModule();
    fetchMock.mockResolvedValueOnce(makeResponse({ arrayBuffer: smallBytes() }));
    const port = makePort();

    await handleAsrDownload({ audioUrl: "https://xy123.bilivideo.com/a.m4s", backupUrls: [] }, port);

    // 规则添加在 fetch 之前
    expect(dnrMock.updateSessionRules.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0]
    );
    // 规则清除在 fetch 之后（updateSessionRules 的第二次调用）
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(
      dnrMock.updateSessionRules.mock.invocationCallOrder[1]
    );
    // 规则参数正确：匹配 bilivideo，modifyHeaders 设 Referer/Origin
    expect(dnrMock.updateSessionRules).toHaveBeenCalledTimes(2);
    const call = dnrMock.updateSessionRules.mock.calls[0][0];
    expect(call.removeRuleIds).toEqual([32001]);
    const rule = call.addRules[0];
    expect(rule.id).toBe(32001);
    expect(rule.action.type).toBe("modifyHeaders");
    const headers = rule.action.requestHeaders.map((h) => [h.header, h.operation, h.value]);
    expect(headers).toContainEqual(["Referer", "set", "https://www.bilibili.com"]);
    expect(headers).toContainEqual(["Origin", "set", "https://www.bilibili.com"]);
    expect(rule.condition.urlFilter).toBe("||bilivideo.com");
    // 规则清除只删本次会话规则 id
    expect(dnrMock.updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: [32001] });
  });

  it("fetch 抛错路径：仍要清除规则，并向 port 发 error", async () => {
    const { handleAsrDownload } = await loadModule();
    fetchMock.mockRejectedValueOnce(new Error("network error"));
    const port = makePort();

    await handleAsrDownload({ audioUrl: "https://xy123.bilivideo.com/a.m4s", backupUrls: [] }, port);

    expect(dnrMock.updateSessionRules).toHaveBeenCalledTimes(2);
    expect(port.posted).toContainEqual({ type: "error", message: "network error" });
  });

  it("规则添加本身抛错时不再尝试下载（规则未装上）", async () => {
    const { handleAsrDownload } = await loadModule();
    dnrMock.updateSessionRules.mockRejectedValueOnce(new Error("dnr unavailable"));
    const port = makePort();

    await expect(
      handleAsrDownload({ audioUrl: "https://xy123.bilivideo.com/a.m4s", backupUrls: [] }, port)
    ).rejects.toThrow("dnr unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(port.posted).toEqual([]);
  });

  it("port 断连（postMessage 抛错）后规则仍被清除", async () => {
    const { handleAsrDownload } = await loadModule();
    fetchMock.mockResolvedValueOnce(makeResponse({ arrayBuffer: smallBytes() }));
    const port = makePort();
    port.postMessage = vi.fn(() => {
      throw new Error("port closed");
    });

    await handleAsrDownload({ audioUrl: "https://xy123.bilivideo.com/a.m4s", backupUrls: [] }, port);

    expect(dnrMock.updateSessionRules).toHaveBeenCalledTimes(2);
  });
});

describe("handleAsrDownload 大小上限", () => {
  it("HEAD Content-Length 超 200MB 拒绝，报「视频过长」，不发起 GET", async () => {
    const { handleAsrDownload } = await loadModule();
    fetchMock.mockResolvedValueOnce(
      makeResponse({ headers: { "Content-Length": String(200 * 1024 * 1024 + 1) } })
    );
    const port = makePort();

    await handleAsrDownload({ audioUrl: "https://xy123.bilivideo.com/a.m4s", backupUrls: [] }, port);

    // 只有一次 HEAD，没有 GET
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe("HEAD");
    expect(port.posted).toContainEqual({ type: "error", message: "视频过长" });
    expect(dnrMock.updateSessionRules).toHaveBeenCalledTimes(2);
  });

  it("HEAD Content-Length 未超上限时继续 GET 下载", async () => {
    const { handleAsrDownload } = await loadModule();
    fetchMock
      .mockResolvedValueOnce(makeResponse({ headers: { "Content-Length": "1024" } }))
      .mockResolvedValueOnce(makeResponse({ arrayBuffer: smallBytes() }));
    const port = makePort();

    await handleAsrDownload({ audioUrl: "https://xy123.bilivideo.com/a.m4s", backupUrls: [] }, port);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].method).toBe("HEAD");
    expect(fetchMock.mock.calls[1][1].method).toBe("GET");
    expect(port.posted).toContainEqual({ type: "done", byteLength: 4 });
  });
});

describe("handleAsrDownload 备用地址回退", () => {
  it("主地址失败依次试备用地址，最后一次成功", async () => {
    const { handleAsrDownload } = await loadModule();
    // HEAD 成功 → 主地址 GET 失败 → 备用1 GET 失败 → 备用2 GET 成功
    fetchMock
      .mockResolvedValueOnce(makeResponse({ headers: { "Content-Length": "4096" } }))
      .mockResolvedValueOnce(makeResponse({ ok: false, status: 403 }))
      .mockResolvedValueOnce(makeResponse({ ok: false, status: 403 }))
      .mockResolvedValueOnce(makeResponse({ arrayBuffer: smallBytes() }));
    const port = makePort();

    await handleAsrDownload(
      {
        audioUrl: "https://xy123.bilivideo.com/main.m4s",
        backupUrls: [
          "https://xy456.bilivideo.com/backup-1.m4s",
          "https://xy789.bilivideo.com/backup-2.m4s"
        ]
      },
      port
    );

    // 记录 GET 请求顺序：主地址 → backup-1 → backup-2
    const getCalls = fetchMock.mock.calls.filter(([, options]) => options.method === "GET");
    expect(getCalls.map(([url]) => url)).toEqual([
      "https://xy123.bilivideo.com/main.m4s",
      "https://xy456.bilivideo.com/backup-1.m4s",
      "https://xy789.bilivideo.com/backup-2.m4s"
    ]);
    expect(port.posted).toContainEqual({ type: "done", byteLength: 4 });
  });

  it("所有地址都失败时发 error，规则仍清除", async () => {
    const { handleAsrDownload } = await loadModule();
    fetchMock
      .mockResolvedValueOnce(makeResponse({ headers: { "Content-Length": "4096" } }))
      .mockResolvedValueOnce(makeResponse({ ok: false, status: 403 }))
      .mockResolvedValueOnce(makeResponse({ ok: false, status: 403 }));
    const port = makePort();

    await handleAsrDownload(
      {
        audioUrl: "https://xy123.bilivideo.com/main.m4s",
        backupUrls: ["https://xy456.bilivideo.com/backup-1.m4s"]
      },
      port
    );

    expect(port.posted).toContainEqual({ type: "error", message: "音频下载失败" });
    expect(dnrMock.updateSessionRules).toHaveBeenCalledTimes(2);
  });

  it("返回体为空（0 字节）视为失败，继续试备用地址", async () => {
    const { handleAsrDownload } = await loadModule();
    fetchMock
      .mockResolvedValueOnce(makeResponse({ headers: { "Content-Length": "4096" } }))
      .mockResolvedValueOnce(makeResponse({ arrayBuffer: new ArrayBuffer(0) }))
      .mockResolvedValueOnce(makeResponse({ arrayBuffer: smallBytes() }));
    const port = makePort();

    await handleAsrDownload(
      {
        audioUrl: "https://xy123.bilivideo.com/main.m4s",
        backupUrls: ["https://xy456.bilivideo.com/backup.m4s"]
      },
      port
    );

    const getCalls = fetchMock.mock.calls.filter(([, options]) => options.method === "GET");
    expect(getCalls).toHaveLength(2);
    expect(port.posted).toContainEqual({ type: "done", byteLength: 4 });
  });
});

describe("assembleChunks / sliceChunks", () => {
  it("assembleChunks 按传入顺序拼回原始字节", async () => {
    // 构造超过 4MB 的原始数据，验证多块切分后拼回完全一致
    const total = 4 * 1024 * 1024 + 1024;
    const original = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      original[i] = i % 251;
    }
    const { sliceChunks, assembleChunks } = await loadModule();

    const chunks = sliceChunks(original.buffer);
    expect(chunks.length).toBe(2);
    expect(chunks[0].byteLength).toBe(4 * 1024 * 1024);
    expect(chunks[1].byteLength).toBe(1024);

    const restored = new Uint8Array(assembleChunks(chunks));
    expect(restored.byteLength).toBe(total);
    expect([...restored]).toEqual([...original]);
  });

  it("assembleChunks 数据正好等于 4MB 时只有一块", async () => {
    const { sliceChunks } = await loadModule();
    const original = new Uint8Array(4 * 1024 * 1024);
    const chunks = sliceChunks(original.buffer);
    expect(chunks).toHaveLength(1);
  });

  it("assembleChunks 单块返回同一字节内容", async () => {
    const { assembleChunks } = await loadModule();
    const bytes = new Uint8Array([9, 8, 7]);
    const restored = new Uint8Array(assembleChunks([bytes]));
    expect([...restored]).toEqual([9, 8, 7]);
  });
});
