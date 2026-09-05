// ai/completion.js 纯协议接缝测试（候选 03）：
// 假 fetch 全覆盖——请求构造对照表（尾斜杠归一 / Bearer 有无 / 思考档位经
// thinking-profiles 查表：平台×模型→字段、无事实不发 / stream 真假 / max_tokens 探针 /
// 额外头合并）、SSE 解析（多事件 / [DONE] /
// 半行 buffer）、溢出判定（子串+正则样本，自 budget-single-shot 迁移）、
// 重试 policy（流式默认 2 次 + onRetry 时序、非流式默认 0 次、溢出/abort 不重试）、
// abort 传播、fetchImpl 注入。不 import port/DOM，走返回/throw 错误模型。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatCompletion,
  buildChatRequestBody,
  normalizeThinkingLevel,
  isContextLengthOverflow,
  makeOverflowError,
  OPENAI_CHAT_PATH
} from "../../extension/ai/completion.js";

const PROVIDER = { baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" };

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// 非流式 JSON 响应。
function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    text: vi.fn(async () => JSON.stringify(payload)),
    json: async () => payload
  };
}

// 非流式纯文本响应（探针 !ok / HTTP 错误路径用）。
function textResponse(text, ok = false, status = 400) {
  return { ok, status, text: vi.fn(async () => text), json: vi.fn() };
}

// SSE 流式响应：chunks 按 read() 顺序返回（编码为 UTF-8 字节）。
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

// 组装一条 OpenAI 兼容 SSE data: 行。
function sseData(delta) {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
}

describe("请求构造对照表（url / body / headers）", () => {
  it("baseUrl 去尾斜杠（单个与多个）+ 拼接 OPENAI_CHAT_PATH；Bearer 仅当 apiKey", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }));

    await chatCompletion({
      provider: { baseUrl: "https://api.example.com/v1/", model: "m", apiKey: "sk-1" },
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchMock
    });
    await chatCompletion({
      provider: { baseUrl: "https://api.example.com/v1///", model: "m", apiKey: "sk-1" },
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchMock
    });
    await chatCompletion({
      provider: { baseUrl: "https://api.example.com/v1", model: "m" },
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchMock
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url] of fetchMock.mock.calls) {
      expect(url).toBe(`https://api.example.com/v1${OPENAI_CHAT_PATH}`);
      expect(url).toContain("/chat/completions");
    }
    const [, withKey] = fetchMock.mock.calls[0];
    expect(withKey.headers.Authorization).toBe("Bearer sk-1");
    expect(withKey.method).toBe("POST");
    // 无 apiKey 时不带 Authorization，Content-Type 固定 JSON
    const [, noKey] = fetchMock.mock.calls[2];
    expect(noKey.headers.Authorization).toBeUndefined();
    expect(noKey.headers["Content-Type"]).toBe("application/json");
  });

  it("思考档位经 thinking-profiles 查表：OpenAI gpt-5.1 off→effort none、low/high→effort；未知平台×模型三档不发", async () => {
    // 按请求体 stream 动态回响应：流式给 SSE 响应（可读体），非流式给 JSON 响应。
    const fetchMock = vi.fn(async (_url, init) =>
      JSON.parse(init.body).stream
        ? sseResponse([])
        : jsonResponse({ choices: [{ message: { content: "" } }] })
    );
    const run = (provider, overrides) =>
      chatCompletion({
        provider,
        messages: [{ role: "user", content: "hi" }],
        fetchImpl: fetchMock,
        ...overrides
      });

    const openai = { baseUrl: "https://api.openai.com/v1", model: "gpt-5.1" };
    await run(openai, { stream: false, thinkingLevel: "off" });
    await run(openai, { stream: true, thinkingLevel: "low" });
    await run(openai, { stream: true, thinkingLevel: "high" });
    // 未知平台 × 未知模型（UNKNOWN 哨兵）：off 与省略档位都无任何思考字段
    await run(PROVIDER, { stream: true, thinkingLevel: "off" });
    await run(PROVIDER, { stream: true });

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
    // OpenAI：off（例外表）映射 effort none——不再发会让严格 400 的未知字段族
    expect(bodies[0]).toMatchObject({ reasoning_effort: "none" });
    expect(bodies[0]).not.toHaveProperty("thinking");
    expect(bodies[0]).not.toHaveProperty("enable_thinking");
    expect(bodies[1]).toMatchObject({ stream: true, reasoning_effort: "low" });
    expect(bodies[1]).not.toHaveProperty("enable_thinking");
    expect(bodies[2]).toMatchObject({ stream: true, reasoning_effort: "high" });
    for (const body of [bodies[3], bodies[4]]) {
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(body).not.toHaveProperty("thinking");
      expect(body).not.toHaveProperty("enable_thinking");
    }
  });

  it("probe 模式：max_tokens:1 + ping 消息 + stream:false；额外头合并且不覆盖 Content-Type", async () => {
    const response = jsonResponse({ choices: [{ message: { content: "" } }] });
    const fetchMock = vi.fn(async () => response);

    await chatCompletion({
      provider: PROVIDER,
      messages: [{ role: "user", content: "ping" }],
      probe: true,
      headers: { Accept: "application/json" },
      fetchImpl: fetchMock
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.example.com/v1${OPENAI_CHAT_PATH}`);
    // 探针省略档位 ⇒ 回落 off ⇒ 经 thinking-profiles 查表：未知平台×模型无事实
    // （UNKNOWN 哨兵）→ 不发任何思考字段。旧实现霰弹枪双发 thinking+enable_thinking
    // 会让 OpenAI 严格校验的探针必 400；查表后字段跟着平台走（见下一条用例）。
    expect(JSON.parse(init.body)).toEqual({
      model: "test-model",
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      max_tokens: 1
    });
    expect(init.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test"
    });
  });

  it("显式 maxTokens 写进 body；传入 headers 已带 Authorization 时不重复注入", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "" } }] }));

    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      maxTokens: 7,
      headers: { Authorization: "Bearer pre-set" },
      fetchImpl: fetchMock
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).max_tokens).toBe(7);
    expect(init.headers.Authorization).toBe("Bearer pre-set");
  });

  it("守卫：缺 baseUrl 抛「baseUrl 未配置」，缺 model 抛「模型未配置」，不发请求", async () => {
    const fetchMock = vi.fn();

    await expect(
      chatCompletion({ provider: { model: "m" }, messages: [], fetchImpl: fetchMock })
    ).rejects.toThrow("baseUrl 未配置");
    await expect(
      chatCompletion({ provider: { baseUrl: "https://x" }, messages: [], fetchImpl: fetchMock })
    ).rejects.toThrow("模型未配置");
    await expect(
      chatCompletion({ provider: { baseUrl: "   ", model: "m" }, messages: [], fetchImpl: fetchMock })
    ).rejects.toThrow("baseUrl 未配置");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// presetId 穿线（02 号票）：provider 记录的 presetId 经 chatCompletion 的
// provider 对象抵达 buildChatRequestBody，识别主路径优先于 baseUrl host 推断；
// 旧记录（无 presetId 字段 / normalize 落 "custom"）回落 host/模型名，与 01
// 落地行为一致（上面的请求构造对照表即 01 golden，继续锁定）。
describe("presetId 穿线（chatCompletion → buildChatRequestBody）", () => {
  it("provider.presetId 与 host 推断冲突时 presetId 赢：host 命中 Mimo 但记录是 ollama → effort 词汇", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "" } }] }));

    await chatCompletion({
      // baseUrl 指向 Mimo 官方域（host 推断 → enable_thinking 族）；presetId
      // 主路径生效则整体改按 ollama 规则——字段族切换是「谁赢」的可观测判据
      provider: { baseUrl: "https://api.mimo.ai/v1", apiKey: "sk-1", model: "llama3.2", presetId: "ollama" },
      messages: [{ role: "user", content: "hi" }],
      thinkingLevel: "off",
      fetchImpl: fetchMock
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ reasoning_effort: "none" });
    expect(body).not.toHaveProperty("enable_thinking");
  });

  it("provider.presetId（如反代场景）→ 按 preset 平台规则出 enable_thinking 族", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "" } }] }));

    await chatCompletion({
      provider: { baseUrl: "https://thinking-proxy.example.com/v1", apiKey: "sk-1", model: "qwen3-max", presetId: "qwen" },
      messages: [{ role: "user", content: "hi" }],
      thinkingLevel: "off",
      fetchImpl: fetchMock
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ enable_thinking: false });
  });

  it("presetId='custom'（旧记录 normalize 落点）→ 回落模型名识别：taxonomy 命中 DeepSeek 规则", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "" } }] }));

    await chatCompletion({
      provider: { baseUrl: "https://thinking-proxy.example.com/v1", apiKey: "sk-1", model: "deepseek-v4-pro", presetId: "custom" },
      messages: [{ role: "user", content: "hi" }],
      thinkingLevel: "off",
      fetchImpl: fetchMock
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ thinking: { type: "disabled" } });
  });

  it("旧记录不带 presetId 字段：host 推断照常（01 golden 不回归）", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "" } }] }));

    await chatCompletion({
      provider: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-1", model: "gpt-5.1" },
      messages: [{ role: "user", content: "hi" }],
      thinkingLevel: "off",
      fetchImpl: fetchMock
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ reasoning_effort: "none" });
  });
});

describe("buildChatRequestBody / normalizeThinkingLevel（自 client.js 迁入）", () => {
  it("off：按平台表发显式关闭字段（OpenAI gpt-5.1 例外 effort none；DeepSeek v4 模式表 thinking disabled）", () => {
    const base = { messages: [], stream: true };
    expect(buildChatRequestBody({
      ...base, model: "gpt-5.1", baseUrl: "https://api.openai.com/v1", thinkingLevel: "off"
    })).toEqual({
      model: "gpt-5.1",
      messages: [],
      stream: true,
      reasoning_effort: "none"
    });
    expect(buildChatRequestBody({
      ...base, model: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com/v1", thinkingLevel: "off"
    })).toEqual({
      model: "deepseek-v4-pro",
      messages: [],
      stream: true,
      thinking: { type: "disabled" }
    });
  });

  it("low / high：按平台表映射（OpenAI effort），不混入其他思考字段；maxTokens 透传", () => {
    const base = { model: "gpt-5.1", messages: [], stream: false, baseUrl: "https://api.openai.com/v1" };
    expect(buildChatRequestBody({ ...base, thinkingLevel: "low" })).toEqual({
      model: "gpt-5.1",
      messages: [],
      stream: false,
      reasoning_effort: "low"
    });
    expect(buildChatRequestBody({ ...base, thinkingLevel: "high" })).toMatchObject({
      reasoning_effort: "high"
    });
    expect(buildChatRequestBody({ ...base, maxTokens: 1 })).toMatchObject({ max_tokens: 1 });
  });

  it("未知平台 × 未知模型：省略/非法/三档均不发思考字段（UNKNOWN 哨兵）；stream 缺省 false", () => {
    const base = { model: "test-model", messages: [], baseUrl: "https://api.example.com/v1" };
    for (const thinkingLevel of [undefined, "off", "low", "high", "medium"]) {
      expect(buildChatRequestBody({ ...base, thinkingLevel })).toEqual({
        model: "test-model",
        messages: [],
        stream: false
      });
    }
  });

  it("normalizeThinkingLevel 只接受 off/low/high，其余回落 off", () => {
    expect(normalizeThinkingLevel("off")).toBe("off");
    expect(normalizeThinkingLevel("low")).toBe("low");
    expect(normalizeThinkingLevel("high")).toBe("high");
    expect(normalizeThinkingLevel("medium")).toBe("off");
    expect(normalizeThinkingLevel(undefined)).toBe("off");
    expect(normalizeThinkingLevel(null)).toBe("off");
  });
});

describe("非流式返回值", () => {
  it("返回 choices[0].message.content；非字符串 content 回落空串", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "成稿" } }] }));
    await expect(
      chatCompletion({ provider: PROVIDER, messages: [], fetchImpl: fetchMock })
    ).resolves.toBe("成稿");

    const fetchMock2 = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 123 } }] }));
    await expect(
      chatCompletion({ provider: PROVIDER, messages: [], fetchImpl: fetchMock2 })
    ).resolves.toBe("");
  });

  it("响应体非法 JSON → 抛「响应解析失败」（不重试，只调一次）", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }));
    await expect(
      chatCompletion({ provider: PROVIDER, messages: [], fetchImpl: fetchMock })
    ).rejects.toThrow("响应解析失败：bad json");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("SSE 流式解析与事件序列", () => {
  it("多事件逐条吐出（reasoning + token），[DONE] 跳过，成功 resolve { done: true }", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        sseData({ reasoning_content: "思路" }),
        sseData({ content: "Hello" }),
        sseData({ content: " 世界" }),
        "data: [DONE]\n\n"
      ])
    );
    const events = [];
    const result = await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      fetchImpl: fetchMock,
      onEvent: (e) => events.push(e)
    });

    expect(result).toEqual({ done: true });
    expect(events).toEqual([
      { type: "reasoning", data: "思路" },
      { type: "token", data: "Hello" },
      { type: "token", data: " 世界" }
    ]);
  });

  it("半行 buffer：跨 chunk 切断的 data: 行在下一块拼齐后仍解析", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel',
        'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":"!"}}]}\n\n'
      ])
    );
    const events = [];
    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      fetchImpl: fetchMock,
      onEvent: (e) => events.push(e)
    });

    expect(events).toEqual([
      { type: "token", data: "Hello" },
      { type: "token", data: "!" }
    ]);
  });

  it("非 data: 行与空 data 跳过；非法 JSON data 行静默忽略", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        ": keep-alive\n\n",
        "data:\n\n",
        "data: not-json\n\n",
        sseData({ content: "ok" })
      ])
    );
    const events = [];
    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      fetchImpl: fetchMock,
      onEvent: (e) => events.push(e)
    });
    expect(events).toEqual([{ type: "token", data: "ok" }]);
  });
});

describe("isContextLengthOverflow 溢出识别（样本自 budget-single-shot 迁移）", () => {
  it("典型 context-length 溢出文案 → true", () => {
    const overflowMessages = [
      "context_length_exceeded",
      "This model's maximum context length is 8192 tokens, but you requested 12000 tokens.",
      "maximum context length exceeded",
      "exceeds the maximum context window",
      "too many tokens in request",
      "max_tokens limit reached",
      "token limit exceeded",
      "max tokens exceeded",
      "prompt is too long",
      "input is too large",
      "请求的上下文长度超出限制",
      "上下文长度超过最大限制",
      "请求 tokens 超出上下文上限"
    ];
    for (const message of overflowMessages) {
      expect(isContextLengthOverflow(message), message).toBe(true);
    }
  });

  it("Error 对象也按文案判定（String 强制转换）", () => {
    expect(isContextLengthOverflow(new Error("maximum context length exceeded"))).toBe(true);
    expect(isContextLengthOverflow(new Error("network down"))).toBe(false);
  });

  it("普通错误（401/404/500/网络/限流/空输入）→ false", () => {
    const plainErrors = [
      "401 Unauthorized",
      "404 Not Found",
      "500 Internal Server Error",
      "invalid api key",
      "model not found",
      "connection reset by peer",
      "rate limit exceeded",
      "请求超时（90 秒未返回任何数据）已自动中断",
      "",
      undefined,
      null,
      123
    ];
    for (const message of plainErrors) {
      expect(isContextLengthOverflow(message), String(message)).toBe(false);
    }
  });
});

describe("溢出端到端：抛 .overflow 标记错误且不重试", () => {
  it("HTTP 400 body 含 maximum context length → rejects { overflow: true }，只调一次 fetch", async () => {
    const fetchMock = vi.fn(async () =>
      textResponse("This model's maximum context length is 8192 tokens, but you requested 12000 tokens.", false, 400)
    );

    await expect(
      chatCompletion({ provider: PROVIDER, messages: [], stream: true, fetchImpl: fetchMock })
    ).rejects.toMatchObject({ overflow: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("非流式路径同样命中溢出标记；message 保留 HTTP 详情", async () => {
    const fetchMock = vi.fn(async () =>
      textResponse("context_length_exceeded", false, 413)
    );

    const error = await chatCompletion({ provider: PROVIDER, messages: [], fetchImpl: fetchMock }).catch((e) => e);
    expect(error.overflow).toBe(true);
    expect(error.message).toBe("HTTP 413: context_length_exceeded");
  });

  it("makeOverflowError 是 err.overflow 的唯一工厂", () => {
    const error = makeOverflowError("字幕过长，已切换为分段整理模式");
    expect(error).toBeInstanceOf(Error);
    expect(error.overflow).toBe(true);
    expect(error.message).toBe("字幕过长，已切换为分段整理模式");
    expect(makeOverflowError().message).toBe("上下文超出模型限制");
  });
});

describe("重试 policy：流式默认 2 次，onRetry 时序", () => {
  it("fetch 抛错 → 重试 2 次（共 3 次调用）后成功；onRetry 依次 attempt 1/2，kind=fetch", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce(sseResponse([sseData({ content: "ok" })]));
    const retries = [];

    const result = await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: fetchMock,
      onRetry: (info) => retries.push(info)
    });

    expect(result).toEqual({ done: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatchObject({ attempt: 1, maxRetries: 2, kind: "fetch" });
    expect(retries[1]).toMatchObject({ attempt: 2, maxRetries: 2, kind: "fetch" });
    expect(retries[0].error.message).toBe("网络错误：Failed to fetch");
  });

  it("fetch 抛错耗尽重试 → 抛「网络错误：…」，retryable 与 isRetryableNetworkError 一致", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });

    const error = await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: fetchMock
    }).catch((e) => e);

    expect(error.message).toBe("网络错误：Failed to fetch");
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.retryable).toBe(true); // 消息启发：failed to fetch
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("非溢出 HTTP 500 → 重试 2 次（kind=http），耗尽后抛带 status 的错误；401 同样重试（对齐旧 client 现状）", async () => {
    const fetchMock = vi.fn(async () => textResponse("boom", false, 500));
    const retries = [];

    const error = await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: fetchMock,
      onRetry: (info) => retries.push(info)
    }).catch((e) => e);

    expect(error.message).toBe("HTTP 500: boom");
    expect(error.status).toBe(500);
    expect(error.retryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(retries.map((r) => r.kind)).toEqual(["http", "http"]);
    expect(retries.map((r) => r.attempt)).toEqual([1, 2]);

    const unauthorized = vi.fn(async () => textResponse("Unauthorized", false, 401));
    const error401 = await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: unauthorized
    }).catch((e) => e);
    expect(error401.status).toBe(401);
    expect(error401.retryable).toBe(false); // 408/429/≥500 才可重试
    expect(unauthorized).toHaveBeenCalledTimes(3);
  });

  it("流式第 2 次 attempt 成功 → 正常完成（前置失败 1 次）", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("network reset"))
      .mockResolvedValueOnce(sseResponse([sseData({ content: "ok" })]));

    await expect(
      chatCompletion({
        provider: PROVIDER,
        messages: [],
        stream: true,
        retryDelayMs: 0,
        fetchImpl: fetchMock
      })
    ).resolves.toEqual({ done: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("读流中断（SSE 中途抛错）→ kind=stream 重试，最终成功；耗尽后抛原始错误", async () => {
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
      .mockResolvedValueOnce(sseResponse([sseData({ content: "recovered" })]));
    const retries = [];

    const result = await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: fetchMock,
      onRetry: (info) => retries.push(info),
      onEvent: () => {}
    });

    expect(result).toEqual({ done: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retries).toEqual([expect.objectContaining({ attempt: 1, maxRetries: 2, kind: "stream" })]);

    const alwaysBroken = vi.fn(async () => brokenReader());
    const error = await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: alwaysBroken,
      onEvent: () => {}
    }).catch((e) => e);
    expect(error.message).toBe("stream closed");
    expect(alwaysBroken).toHaveBeenCalledTimes(3);
  });

  it("非流式默认 0 次：!response.ok 直接抛，只调一次 fetch", async () => {
    const fetchMock = vi.fn(async () => textResponse("Unauthorized", false, 401));

    await expect(
      chatCompletion({ provider: PROVIDER, messages: [], fetchImpl: fetchMock })
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("显式 retries 覆盖默认：非流式 retries=1 时重试一次", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "ok" } }] }));

    await expect(
      chatCompletion({
        provider: PROVIDER,
        messages: [],
        retries: 1,
        retryDelayMs: 0,
        fetchImpl: fetchMock
      })
    ).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("溢出 / abort 不重试", () => {
  it("溢出错误即使还有重试额度也不重试", async () => {
    const fetchMock = vi.fn(async () => textResponse("too many tokens", false, 400));

    await expect(
      chatCompletion({
        provider: PROVIDER,
        messages: [],
        stream: true,
        fetchImpl: fetchMock
      })
    ).rejects.toMatchObject({ overflow: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetch 抛 AbortError → 收束为 { aborted: true }，不重试", async () => {
    const fetchMock = vi.fn(async () => {
      const e = new Error("The user aborted a request");
      e.name = "AbortError";
      throw e;
    });

    await expect(
      chatCompletion({ provider: PROVIDER, messages: [], stream: true, fetchImpl: fetchMock })
    ).rejects.toMatchObject({ aborted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetch 抛带 aborted 标记的假中止 → 收束为 { aborted: true }，不重试", async () => {
    const fetchMock = vi.fn(async () => {
      const e = new Error("已停止生成");
      e.aborted = true;
      throw e;
    });

    await expect(
      chatCompletion({ provider: PROVIDER, messages: [], fetchImpl: fetchMock })
    ).rejects.toMatchObject({ aborted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("流中途 signal abort → rejects { aborted: true }，不重试、不再发请求", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    let reads = 0;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              reads += 1;
              if (reads === 1) {
                return { value: encoder.encode(sseData({ content: "partial" })), done: false };
              }
              controller.abort();
              return { value: encoder.encode(sseData({ content: "more" })), done: false };
            }
          };
        }
      }
    }));
    const events = [];

    await expect(
      chatCompletion({
        provider: PROVIDER,
        messages: [],
        stream: true,
        signal: controller.signal,
        fetchImpl: fetchMock,
        onEvent: (e) => events.push(e)
      })
    ).rejects.toMatchObject({ aborted: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 对齐旧 drainSseStream 行为：abort 发生在 read 内时，已返回块的 token 先处理，
    // 随后循环顶部检查 aborted 才收束。
    expect(events).toEqual([
      { type: "token", data: "partial" },
      { type: "token", data: "more" }
    ]);
  });

  it("已 abort 的 signal：fetch 抛 AbortError 前不额外发请求（透传 signal）", async () => {
    const controller = new AbortController();
    controller.abort();
    let sawSignal = null;
    const fetchMock = vi.fn(async (_url, init) => {
      sawSignal = init.signal;
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });

    await expect(
      chatCompletion({
        provider: PROVIDER,
        messages: [],
        signal: controller.signal,
        fetchImpl: fetchMock
      })
    ).rejects.toMatchObject({ aborted: true });
    expect(sawSignal).toBe(controller.signal);
  });
});

describe("fetchImpl 注入", () => {
  it("注入 fake fetch 时不触碰 globalThis.fetch", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "injected" } }] }));

    await expect(
      chatCompletion({ provider: PROVIDER, messages: [], fetchImpl: fetchMock })
    ).resolves.toBe("injected");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe("onStreamReset：读流中断重试的代际重置信号", () => {
  it("kind=stream 重试 → onStreamReset 在新流任何事件前调用恰一次", async () => {
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
      .mockResolvedValueOnce(sseResponse([sseData({ content: "二代正文" })]));
    const events = [];
    const resets = [];

    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: fetchMock,
      onRetry: () => {},
      onStreamReset: () => resets.push("reset"),
      onEvent: (e) => events.push(e)
    });

    expect(resets).toEqual(["reset"]);
    // reset 先于新流事件（渲染层必须先清缓冲再收新 token）
    expect(events).toEqual([{ type: "token", data: "二代正文" }]);
  });

  it("fetch / http 阶段失败重试不触发 onStreamReset（未吐过任何事件）", async () => {
    // fetch 抛错（kind=fetch）
    const fetchFail = vi.fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(sseResponse([sseData({ content: "ok" })]));
    const resetsFetch = [];
    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: fetchFail,
      onRetry: () => {},
      onStreamReset: () => resetsFetch.push(1),
      onEvent: () => {}
    });
    expect(resetsFetch).toEqual([]);

    // HTTP 500（kind=http）
    const httpFail = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "server error" })
      .mockResolvedValueOnce(sseResponse([sseData({ content: "ok" })]));
    const resetsHttp = [];
    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: httpFail,
      onRetry: () => {},
      onStreamReset: () => resetsHttp.push(1),
      onEvent: () => {}
    });
    expect(resetsHttp).toEqual([]);
  });

  it("连续两次读流中断（重试耗尽前）→ 每代流开始前各一次 reset；非流式不触发", async () => {
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
      .mockImplementationOnce(async () => brokenReader())
      .mockResolvedValueOnce(sseResponse([sseData({ content: "三代正文" })]));
    const resets = [];
    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: fetchMock,
      onRetry: () => {},
      onStreamReset: () => resets.push(1),
      onEvent: () => {}
    });
    expect(resets).toEqual([1, 1]);

    // 非流式：读流中断概念不存在，即便重试也不触发
    const nonStreamFetch = vi.fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    const resetsNonStream = [];
    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: false,
      retries: 1, // 非流式默认 0，显式开重试才能到达「重试不触发 reset」的断言
      retryDelayMs: 0,
      fetchImpl: nonStreamFetch,
      onRetry: () => {},
      onStreamReset: () => resetsNonStream.push(1)
    });
    expect(resetsNonStream).toEqual([]);
  });
});
