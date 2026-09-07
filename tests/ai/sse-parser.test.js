// ai/sse-parser.js 直测（arch-review-2026-09/03）——此前零直测，只经
// completion 下游间接覆盖。两组：
// 1. parseSsePayload 纯函数：reasoning/content 事件归一、[DONE] 终止、
//    非 JSON 行容错（注释行/心跳空行/畸形行不炸解析器）；
// 2. 字节级分包：经 chatCompletion 流式缝喂原始字节块——多字节 UTF-8 字符
//    被 TCP 分包从中间切开时 TextDecoder 流模式拼齐后仍解析（completion.test
//    的「半行 buffer」只覆盖 ASCII 边界的字符串级切断）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSsePayload } from "../../extension/ai/sse-parser.js";
import { chatCompletion } from "../../extension/ai/completion.js";

const PROVIDER = { baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseSsePayload 纯函数", () => {
  it("reasoning_content 与 content 归一为事件序列（同帧双字段先 reasoning 后 content）", () => {
    expect(parseSsePayload(JSON.stringify({ choices: [{ delta: { content: "你好" } }] }))).toEqual([
      { type: "content", data: "你好" }
    ]);
    expect(parseSsePayload(JSON.stringify({ choices: [{ delta: { reasoning_content: "想一下" } }] }))).toEqual([
      { type: "reasoning", data: "想一下" }
    ]);
    expect(
      parseSsePayload(JSON.stringify({ choices: [{ delta: { reasoning_content: "r", content: "c" } }] }))
    ).toEqual([
      { type: "reasoning", data: "r" },
      { type: "content", data: "c" }
    ]);
  });

  it("[DONE] 与空输入终止：返回空事件列表", () => {
    expect(parseSsePayload("[DONE]")).toEqual([]);
    expect(parseSsePayload("")).toEqual([]);
    expect(parseSsePayload("   ")).toEqual([]);
    expect(parseSsePayload(undefined)).toEqual([]);
    expect(parseSsePayload(null)).toEqual([]);
  });

  it("非 JSON 行容错：注释行 / 心跳 / 畸形 JSON 不抛错、静默丢弃", () => {
    expect(parseSsePayload(": keep-alive")).toEqual([]);
    expect(parseSsePayload("not-json")).toEqual([]);
    expect(parseSsePayload('{"choices":[{"delta":{"content":"半截')).toEqual([]);
    // 合法 JSON 但无 delta 字段：同样无事件
    expect(parseSsePayload('{"choices":[{}]}')).toEqual([]);
    expect(parseSsePayload('{"unexpected":true}')).toEqual([]);
  });

  it("delta 字段非字符串时按 String 归一，空串/假值不产事件", () => {
    expect(parseSsePayload(JSON.stringify({ choices: [{ delta: { content: "" } }] }))).toEqual([]);
    expect(parseSsePayload(JSON.stringify({ choices: [{ delta: { content: 0 } }] }))).toEqual([]);
    expect(parseSsePayload(JSON.stringify({ choices: [{ delta: { content: 42 } }] }))).toEqual([
      { type: "content", data: "42" }
    ]);
  });
});

describe("SSE 字节级分包（经 chatCompletion 流式缝）", () => {
  // 原始字节块响应：chunks 为 Uint8Array 数组，按 read() 顺序返回
  function sseBytesResponse(byteChunks) {
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              if (i < byteChunks.length) {
                return { value: byteChunks[i++], done: false };
              }
              return { done: true };
            }
          };
        }
      }
    };
  }

  it("多字节 UTF-8 字符跨 chunk 从字节中间切开：拼齐后逐字还原", async () => {
    const line = `data: ${JSON.stringify({ choices: [{ delta: { content: "字幕" } }] })}\n\n`;
    const bytes = new TextEncoder().encode(line);
    // 「字」是 3 字节字符：在第 1 个字节后切开，跨块边界落在字符内部
    const charStart = bytes.findIndex((b, i) => i > 6 && b === 0xe5);
    expect(charStart).toBeGreaterThan(6);
    const cut = charStart + 1;
    const fetchMock = vi.fn(async () => sseBytesResponse([bytes.slice(0, cut), bytes.slice(cut)]));

    const events = [];
    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      fetchImpl: fetchMock,
      onEvent: (e) => events.push(e)
    });
    expect(events).toEqual([{ type: "token", data: "字幕" }]);
  });

  it("一个 chunk 内多行 data: 前缀变体（无空格 / 多余空格）+ [DONE] 终止后不再产出", async () => {
    const payload = (delta) => JSON.stringify({ choices: [{ delta }] });
    const text =
      `data:${payload({ content: "甲" })}\n\n` + // data: 后无空格
      `data:  ${payload({ content: "乙" })}\n\n` + // 多余空格
      "data: [DONE]\n\n" +
      `data: ${payload({ content: "不该出现" })}\n\n`; // [DONE] 之后的行（容错：解析器不炸）
    const fetchMock = vi.fn(async () => sseBytesResponse([new TextEncoder().encode(text)]));

    const events = [];
    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      fetchImpl: fetchMock,
      onEvent: (e) => events.push(e)
    });
    // [DONE] 行被跳过，其后残留 data 行仍按普通行解析（实现不提前断流——
    // 本用例锁的是「前缀变体 + [DONE] 不产出事件」，不锁断流时机）
    expect(events).toEqual([
      { type: "token", data: "甲" },
      { type: "token", data: "乙" },
      { type: "token", data: "不该出现" }
    ]);
  });
});
