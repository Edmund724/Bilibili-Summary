// timing-fetch 单测：记录字段、响应体读完才稳定 status、网络错误记 -1、
// 还原函数恢复全局、请求语义原样转发。

import { afterEach, describe, expect, it, vi } from "vitest";
import { installTimingFetch, type RequestTiming } from "../../eval/lib/timing-fetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("installTimingFetch", () => {
  it("记录每次请求的字段，requestIndex 从 0 递增，method 大写", async () => {
    const records: RequestTiming[] = [];
    const restore = installTimingFetch(
      vi.fn(async () => new Response('{"ok":true}', { status: 200 })),
      (t) => records.push(t)
    );

    const r1 = await fetch("https://api.example.com/v1/audio/transcriptions", {
      method: "post",
      body: "x=1"
    });
    await r1.text(); // 体读完 → 计时记录落盘
    const r2 = await fetch("https://api.example.com/v1/models");
    await r2.arrayBuffer();

    await vi.waitFor(() => expect(records).toHaveLength(2));
    expect(records[0].requestIndex).toBe(0);
    expect(records[1].requestIndex).toBe(1);
    expect(records[0].url).toBe("https://api.example.com/v1/audio/transcriptions");
    expect(records[0].method).toBe("POST");
    expect(records[1].method).toBe("GET");
    expect(records[0].status).toBe(200);
    expect(records[0].durationMs).toBeGreaterThanOrEqual(0);
    restore();
  });

  it("status 在响应体读完才记录（耗时覆盖到体读完）", async () => {
    const records: RequestTiming[] = [];
    const body = "x".repeat(1000);
    const realFetch = vi.fn(async () => new Response(body, { status: 201 }));
    const restore = installTimingFetch(realFetch, (t) => records.push(t));

    const response = await fetch("https://api.example.com/audio");
    const text = await response.text(); // 体读完 → 克隆副本读到空 → 记录落盘
    expect(text).toBe(body);
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0].status).toBe(201);
    expect(response.status).toBe(201); // 原 response 仍可用
    restore();
  });

  it("调用方拿到的响应体未被消耗（clone 副本用于计时）", async () => {
    const restore = installTimingFetch(
      vi.fn(async () => new Response("hello")),
      () => {}
    );

    const response = await fetch("https://api.example.com/x");
    expect(await response.text()).toBe("hello");
    restore();
  });

  it("网络错误记 status=-1 并向上抛出原错误", async () => {
    const records: RequestTiming[] = [];
    const boom = new Error("network down");
    const restore = installTimingFetch(
      vi.fn(() => Promise.reject(boom)),
      (t) => records.push(t)
    );

    await expect(fetch("https://api.example.com/x")).rejects.toBe(boom);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe(-1);
    expect(records[0].url).toBe("https://api.example.com/x");
    expect(records[0].method).toBe("GET");
    restore();
  });

  it("请求语义原样转发（URL、init、header、body）", async () => {
    const realFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const restore = installTimingFetch(realFetch, () => {});

    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer k" },
      body: JSON.stringify({ model: "m" })
    };
    await fetch("https://api.example.com/v1/chat", init);

    expect(realFetch).toHaveBeenCalledWith("https://api.example.com/v1/chat", init);
    restore();
  });

  it("还原函数恢复 globalThis.fetch", () => {
    const original = globalThis.fetch;
    const restore = installTimingFetch(vi.fn(async () => new Response("{}")), () => {});
    expect(globalThis.fetch).not.toBe(original);

    restore();
    expect(globalThis.fetch).toBe(original);
  });
});
