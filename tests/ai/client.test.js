// ai/client.js streamChat port 协议测试（候选 03 后：client 退为流式 port 适配器）。
// 验证适配层把 completion 接缝的完成值/类型化错误映射回 offscreen port 协议，
// 事件序列与旧 streamChat 保持一致：token/reasoning → notice → done/stopped/error；
// 仅溢出以带 .overflow 标记的错误上抛（ladder catch 查标记分流）。
// （原「streamChat 溢出兜底哨兵」用例自 tests/ai/map-reduce.test.js 迁入并按新语义改断言。）

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, makeSubtitleBody } from "../setup.js";
import { streamChat, resolveSubtitleForContext, OVER_BUDGET_NOTICE } from "../../extension/ai/client.js";
import { makeOverflowError } from "../../extension/ai/completion.js";

beforeEach(() => {
  resetModuleState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PROVIDER = { baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" };

function makePort() {
  return { messages: [], postMessage(m) { this.messages.push(m); } };
}

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload
  };
}

function textResponse(text, ok = false, status = 400) {
  return { ok, status, text: async () => text, json: async () => ({}) };
}

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (i < chunks.length) {
              return { value: encoder.encode(chunks[i++]), done: false };
            }
            return { done: true };
          }
        };
      }
    }
  };
}

function sseData(delta) {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
}

describe("streamChat port 协议：事件序列与旧实现一致", () => {
  it("流式成功：token/reasoning 逐条回吐 + 收尾 done，返回 { done: true }", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        sseData({ reasoning_content: "思路" }),
        sseData({ content: "正文" }),
        "data: [DONE]\n\n"
      ])
    ));
    const port = makePort();
    const onActivity = vi.fn();

    const result = await streamChat({
      provider: PROVIDER,
      context: { title: "t", subtitleBody: [{ from: 0, to: 5, content: "字幕" }] },
      userPrompt: "总结",
      history: [],
      port,
      onActivity
    });

    expect(result).toEqual({ done: true });
    expect(port.messages).toEqual([
      { type: "reasoning", data: "思路" },
      { type: "token", data: "正文" },
      { type: "done" }
    ]);
    // 每个流式事件重挂空闲超时
    expect(onActivity).toHaveBeenCalledTimes(2);
  });

  it("预检：缺 baseUrl / 缺 model → post error 且不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const port1 = makePort();
    await streamChat({ provider: { model: "m" }, context: {}, userPrompt: "", history: [], port: port1 });
    expect(port1.messages).toEqual([{ type: "error", error: "baseUrl 未配置" }]);

    const port2 = makePort();
    await streamChat({ provider: { baseUrl: "https://x" }, context: {}, userPrompt: "", history: [], port: port2 });
    expect(port2.messages).toEqual([{ type: "error", error: "模型未配置" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("非溢出 HTTP 错误：重试 notice ×2 后 post error，正常返回（不抛）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse("Unauthorized", false, 401)));
    const port = makePort();

    const result = await streamChat({
      provider: PROVIDER,
      context: { title: "t", subtitleBody: [] },
      userPrompt: "总结",
      history: [],
      port
    });

    expect(result).toBeUndefined();
    const errors = port.messages.filter((m) => m.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBe("HTTP 401: Unauthorized");
    // 重试提示（对齐旧文案），错误只发一条
    const notices = port.messages.filter((m) => m.type === "notice");
    expect(notices).toHaveLength(2);
    expect(notices[0].data).toBe("HTTP 401: Unauthorized，正在重试...");
    expect(port.messages.some((m) => m.type === "done")).toBe(false);
  });

  it("网络错误：重试 notice（连接中断文案）后 post error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("Failed to fetch");
    }));
    const port = makePort();

    await streamChat({
      provider: PROVIDER,
      context: { title: "t", subtitleBody: [] },
      userPrompt: "总结",
      history: [],
      port
    });

    const notices = port.messages.filter((m) => m.type === "notice");
    expect(notices.map((n) => n.data)).toEqual([
      "连接中断，正在重新连接（1/2）...",
      "连接中断，正在重新连接（2/2）..."
    ]);
    const errors = port.messages.filter((m) => m.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBe("网络错误：Failed to fetch");
  });

  it("abort：post stopped，无 done / error", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }));
    const port = makePort();

    const result = await streamChat({
      provider: PROVIDER,
      context: { title: "t", subtitleBody: [] },
      userPrompt: "总结",
      history: [],
      port,
      signal: controller.signal
    });

    expect(result).toBeUndefined();
    expect(port.messages).toEqual([{ type: "stopped", reason: "已停止生成" }]);
  });
});

describe("streamChat 溢出语义（catch 查标记）", () => {
  it("HTTP 400 body 含 maximum context length → 抛 { overflow: true }，不再 post overflow/error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      textResponse("This model's maximum context length is 8192 tokens, but you requested 12000 tokens.", false, 400)
    ));
    const port = makePort();

    await expect(
      streamChat({
        provider: PROVIDER,
        context: { title: "t", subtitleBody: [] },
        userPrompt: "总结",
        history: [],
        port
      })
    ).rejects.toMatchObject({ overflow: true });
    expect(port.messages).toHaveLength(0);
  });

  it("超预算（>100k）→ 仍发 notice 提示 + 抛 overflow 标记错误，不发任何请求", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const context = { title: "t", subtitleBody: makeSubtitleBody(110000) };

    await expect(
      streamChat({
        provider: PROVIDER,
        context,
        userPrompt: "总结",
        history: [],
        port
      })
    ).rejects.toMatchObject({ overflow: true });

    const postMessages = port.messages;
    expect(postMessages.some((m) => m.type === "notice" && m.data === OVER_BUDGET_NOTICE)).toBe(true);
    expect(postMessages.some((m) => m.type === "overflow")).toBe(false);
    // 超预算直接上抛，不发任何请求
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("普通错误不误判为溢出（post error、不上抛）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse("Unauthorized", false, 401)));
    const port = makePort();

    const result = await streamChat({
      provider: PROVIDER,
      context: { title: "t", subtitleBody: [] },
      userPrompt: "总结",
      history: [],
      port
    });

    expect(result).toBeUndefined();
    expect(port.messages.some((m) => m.type === "error")).toBe(true);
  });

  it("追问压缩摘要超预算（body 空 + compressedSummaryMarkdown >100k）→ overflow 标记错误", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const port = makePort();

    await expect(
      streamChat({
        provider: PROVIDER,
        context: { title: "t", subtitleBody: [], compressedSummaryMarkdown: "a".repeat(100001) },
        userPrompt: "追问",
        history: [],
        port
      })
    ).rejects.toMatchObject({ overflow: true });
  });
});

describe("resolveSubtitleForContext / OVER_BUDGET_NOTICE（预算策略留在 client）", () => {
  it("预算内与超预算的发送物判定（承接 budget-single-shot 的溢出标记语义）", () => {
    const over = resolveSubtitleForContext({ subtitleBody: makeSubtitleBody(110000) });
    expect(over.mode).toBe("map-reduce");
    expect(over.overflowMarked).toBe(true);
    expect(over.notice).toBe(OVER_BUDGET_NOTICE);

    const within = resolveSubtitleForContext({ subtitleBody: makeSubtitleBody(100000) });
    expect(within.mode).toBe("single");
    expect(within.overflowMarked).toBe(false);
    expect(within.notice).toBe("");
  });

  it("makeOverflowError 产出的标记错误即 ladder 分流依据", () => {
    const error = makeOverflowError(OVER_BUDGET_NOTICE);
    expect(error.overflow).toBe(true);
    expect(error.message).toBe("字幕过长，已切换为分段整理模式");
  });
});

describe("streamChat 读流中断重试：stream-reset 代际重置信号", () => {
  it("读流中断重试 → port 收到 stream-reset（在新流 token 之前）+ 恢复后 done", async () => {
    const brokenReader = () => ({
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            read: async () => {
              throw new Error("stream closed");
            }
          };
        }
      }
    });
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => brokenReader())
      .mockResolvedValueOnce(sseResponse([sseData({ content: "二代正文" }), "data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();

    const result = await streamChat({
      provider: PROVIDER,
      context: { title: "t", subtitleBody: [{ from: 0, to: 5, content: "字幕" }] },
      userPrompt: "总结",
      history: [],
      port
    });

    expect(result).toEqual({ done: true });
    // reset 恰一条且先于重试流 token（渲染层先清缓冲再收新流）
    const resetIdx = port.messages.findIndex((m) => m.type === "stream-reset");
    const tokenIdx = port.messages.findIndex((m) => m.type === "token");
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(port.messages.filter((m) => m.type === "stream-reset")).toHaveLength(1);
    expect(resetIdx).toBeLessThan(tokenIdx);
    expect(port.messages.at(-1)).toEqual({ type: "done" });
  });

  it("fetch/http 阶段重试不发 stream-reset（未吐过事件）", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "Unauthorized" })
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "Unauthorized" })
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "Unauthorized" });
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();

    await streamChat({
      provider: PROVIDER,
      context: { title: "t", subtitleBody: [{ from: 0, to: 5, content: "字幕" }] },
      userPrompt: "总结",
      history: [],
      port
    });

    expect(port.messages.some((m) => m.type === "stream-reset")).toBe(false);
    expect(port.messages.at(-1)?.type).toBe("error");
  });
});
