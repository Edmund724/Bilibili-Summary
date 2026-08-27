// stepfun-sse 适配器测试（mock fetch 返回可构造的 SSE Response）。
// 覆盖：SSE 多 data 事件聚合、结束条件（[DONE]/done/自然读完）、流中
// error 事件透出 message、三类 HTTP 错误文案（not supported / 空 body）、
// base64 编码正确性、句级时间戳 segments 映射与纯文本缺省行为。
//
// 注：jsdom/Node 的 Response.body 流式读取依赖可读流实现，本文件用手造
// 最小桩 {ok, status, body:{getReader}} 避免环境差异，同时用
// new Response(sseText) 校验真实 SSE 文本的逐行解析。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const STEPFUN_PROVIDER = {
  id: "stepfun-stepaudio",
  name: "阶跃 StepAudio 2.5 ASR",
  type: "stepfun-sse",
  baseUrl: "https://api.stepfun.com",
  model: "stepaudio-2.5-asr",
  supportsTimestamps: true,
  apiKey: "sk-test"
};

// 手造 SSE 流式响应桩：按行返回编码后的 chunk，模拟网络分块（一行可能
// 被切成多块），可构造 [DONE]/error/done 结束条件。
function makeSseStub({ status = 200, ok = true, lines = [], chunkSize = 8 }) {
  const bytes = new TextEncoder().encode(lines.join("\n") + "\n");
  let offset = 0;
  const getReader = () => ({
    read: async () => {
      if (offset >= bytes.length) {
        return { done: true, value: undefined };
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      const value = bytes.slice(offset, end);
      offset = end;
      return { done: false, value };
    },
    cancel: vi.fn(async () => {}),
    releaseLock: vi.fn()
  });
  return { ok, status, body: { getReader } };
}

function sseData(obj) {
  return `data: ${JSON.stringify(obj)}`;
}

// 解码期望的 base64，与 bytesToBase64 输出比对（往返校验）
function toBytes(b64) {
  return Buffer.from(b64, "base64");
}

let adapter;

beforeEach(async () => {
  resetModuleState();
  vi.unstubAllGlobals();
  adapter = await import("../../extension/asr/adapters/stepfun-sse.js");
});

describe("stepfun-sse 请求构造", () => {
  it("POST 到 /v1/audio/asr/sse，嵌套 JSON 请求体，Authorization Bearer", async () => {
    const wavBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]);
    const fetchMock = vi.fn(async () => makeSseStub({ lines: [sseData({ type: "transcript.text.done", text: "ok" })] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await adapter.transcribe({
      wavBlob: new Blob([wavBytes]),
      startSec: 0,
      durationSec: 60,
      provider: STEPFUN_PROVIDER
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.stepfun.com/v1/audio/asr/sse");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Accept).toBe("text/event-stream");
    const body = JSON.parse(init.body);
    // 请求体嵌套结构：audio.data 为 base64，input 下 transcription/format
    expect(body.audio.data).toBeTypeOf("string");
    expect(body.audio.input.transcription.model).toBe("stepaudio-2.5-asr");
    // 不硬编码语言：省略交服务端自动检测（语言不匹配会静默空文本）
    expect(body.audio.input.transcription.language).toBeUndefined();
    expect(body.audio.input.transcription.enable_timestamp).toBe(true);
    expect(body.audio.input.format.type).toBe("wav");
    expect(body.audio.input.format.rate).toBe(16000);
    expect(body.audio.input.format.bits).toBe(16);
    expect(body.audio.input.format.channel).toBe(1);
    expect(result.text).toBe("ok");
  });

  it("baseUrl 为完整端点 URL 时原样使用（Step Plan 预设默认形式）", async () => {
    const fetchMock = vi.fn(async () => makeSseStub({ lines: [sseData({ type: "transcript.text.done", text: "ok" })] }));
    vi.stubGlobal("fetch", fetchMock);
    await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(8)]),
      startSec: 0,
      durationSec: 60,
      provider: { ...STEPFUN_PROVIDER, baseUrl: "https://api.stepfun.com/step_plan/v1/audio/asr/sse" }
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.stepfun.com/step_plan/v1/audio/asr/sse");
  });

  it("base64 编码正确性：小样本往返断言（分段编码不破坏数据）", async () => {
    // 用超过单段 32768 字节的样本验证分段编码拼接正确
    const sample = new Uint8Array(70000);
    for (let i = 0; i < sample.length; i += 1) {
      sample[i] = (i * 31 + 7) % 256;
    }
    const fetchMock = vi.fn(async () => makeSseStub({ lines: [sseData({ type: "transcript.text.done", text: "x" })] }));
    vi.stubGlobal("fetch", fetchMock);

    await adapter.transcribe({
      wavBlob: new Blob([sample]),
      startSec: 0,
      durationSec: 60,
      provider: STEPFUN_PROVIDER
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // 往返：base64 解码后逐字节一致
    const decoded = new Uint8Array(toBytes(body.audio.data));
    expect(decoded.length).toBe(sample.length);
    for (let i = 0; i < sample.length; i += 1) {
      expect(decoded[i]).toBe(sample[i]);
    }
  });

  it("apiKey 为空时不带 Authorization 头", async () => {
    const fetchMock = vi.fn(async () => makeSseStub({ lines: [sseData({ type: "transcript.text.done", text: "ok" })] }));
    vi.stubGlobal("fetch", fetchMock);
    await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(4)]),
      startSec: 0,
      durationSec: 60,
      provider: { ...STEPFUN_PROVIDER, apiKey: "" }
    });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});

describe("stepfun-sse SSE 聚合", () => {
  it("多个 delta 聚合出完整 text（done.text 优先）", async () => {
    const fetchMock = vi.fn(async () =>
      makeSseStub({
        lines: [
          sseData({ type: "transcript.text.delta", delta: "你" }),
          sseData({ type: "transcript.text.delta", delta: "好" }),
          sseData({ type: "transcript.text.done", text: "你好世界", usage: { total_tokens: 5 } })
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(4)]),
      startSec: 0,
      durationSec: 60,
      provider: STEPFUN_PROVIDER
    });
    // done.text 是权威全量文本（官方技能注释），优先于 delta 拼接
    expect(result.text).toBe("你好世界");
  });

  it("无 done 事件自然读完：用 delta 拼接结果", async () => {
    const fetchMock = vi.fn(async () =>
      makeSseStub({ lines: [sseData({ type: "transcript.text.delta", delta: "增量" })] })
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(4)]),
      startSec: 0,
      durationSec: 60,
      provider: STEPFUN_PROVIDER
    });
    expect(result.text).toBe("增量");
  });

  it("[DONE] 结尾正常：停止读取并返回已聚合文本", async () => {
    const fetchMock = vi.fn(async () =>
      makeSseStub({
        lines: [
          sseData({ type: "transcript.text.delta", delta: "前面" }),
          "data: [DONE]",
          // [DONE] 后不应再读（构造一个会破坏结果的后续事件，验证停止）
          sseData({ type: "transcript.text.delta", delta: "后面不该出现" })
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(4)]),
      startSec: 0,
      durationSec: 60,
      provider: STEPFUN_PROVIDER
    });
    expect(result.text).toBe("前面");
  });

  it("真实 Response（new Response(sseText)）逐行解析：跨块换行也能聚合", async () => {
    const sseText = [
      sseData({ type: "transcript.text.delta", delta: "A" }),
      sseData({ type: "transcript.text.delta", delta: "B" }),
      sseData({ type: "transcript.text.done", text: "AB" }),
      ""
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sseText, { status: 200 })));
    const result = await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(4)]),
      startSec: 0,
      durationSec: 60,
      provider: STEPFUN_PROVIDER
    });
    expect(result.text).toBe("AB");
  });

  it("onProgress 在收到 data 行时回调（含文本长度）", async () => {
    const fetchMock = vi.fn(async () =>
      makeSseStub({
        lines: [
          sseData({ type: "transcript.text.delta", delta: "你" }),
          sseData({ type: "transcript.text.done", text: "你好" })
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const onProgress = vi.fn();
    await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(4)]),
      startSec: 0,
      durationSec: 60,
      provider: STEPFUN_PROVIDER,
      onProgress
    });
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("stepfun-sse 错误处理", () => {
  it("流中 error 事件（内容审查等）→ 抛出含 message 的错误", async () => {
    const fetchMock = vi.fn(async () =>
      makeSseStub({
        lines: [
          sseData({ type: "transcript.text.delta", delta: "前" }),
          sseData({ type: "error", message: "content blocked" })
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      adapter.transcribe({ wavBlob: new Blob([new Uint8Array(4)]), startSec: 0, durationSec: 60, provider: STEPFUN_PROVIDER })
    ).rejects.toThrow("content blocked");
  });

  it("4xx 带 not supported → 端点或模型名错误文案", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      body: null,
      text: async () => JSON.stringify({ error: { message: "model stepaudio-2.5-asr not supported" } })
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      adapter.transcribe({ wavBlob: new Blob([new Uint8Array(4)]), startSec: 0, durationSec: 60, provider: STEPFUN_PROVIDER })
    ).rejects.toThrow("端点或模型名错误");
  });

  it("4xx 空 body → Normal/Plan 引导文案", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403, body: null, text: async () => "" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      adapter.transcribe({ wavBlob: new Blob([new Uint8Array(4)]), startSec: 0, durationSec: 60, provider: STEPFUN_PROVIDER })
    ).rejects.toThrow("Normal 等级");
  });

  it("402 quota_exceeded → 计费通道引导文案（按量余额 / step_plan 端点）", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 402,
      body: null,
      text: async () => JSON.stringify({ error: { message: "You exceeded your current quota", type: "quota_exceeded" } })
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      adapter.transcribe({ wavBlob: new Blob([new Uint8Array(4)]), startSec: 0, durationSec: 60, provider: STEPFUN_PROVIDER })
    ).rejects.toThrow(/quota_exceeded.*step_plan/s);
  });

  it("其他 4xx 带响应体 → HTTP 码 + 响应体片段", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      body: null,
      text: async () => "unauthorized"
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      adapter.transcribe({ wavBlob: new Blob([new Uint8Array(4)]), startSec: 0, durationSec: 60, provider: STEPFUN_PROVIDER })
    ).rejects.toThrow("HTTP 401");
  });
});

describe("stepfun-sse 时间戳与 Abort", () => {
  it("done 事件带 start_time/end_time（毫秒）→ 映射为片内相对秒 segments", async () => {
    const fetchMock = vi.fn(async () =>
      makeSseStub({
        lines: [
          sseData({
            type: "transcript.text.done",
            text: "第一句",
            start_time: 500,
            end_time: 1200
          })
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(4)]),
      startSec: 0,
      durationSec: 60,
      provider: STEPFUN_PROVIDER
    });
    expect(result.text).toBe("第一句");
    expect(result.segments).toEqual([{ start: 0.5, end: 1.2, text: "第一句" }]);
  });

  it("无时间戳事件 → 纯文本无 segments", async () => {
    const fetchMock = vi.fn(async () =>
      makeSseStub({ lines: [sseData({ type: "transcript.text.done", text: "整片文本" })] })
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(4)]),
      startSec: 0,
      durationSec: 60,
      provider: STEPFUN_PROVIDER
    });
    expect(result.text).toBe("整片文本");
    expect(result.segments).toBeUndefined();
  });

  it("AbortSignal 透传 fetch；reader 循环中 aborted 提前退出", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (url, init) => {
      expect(init.signal).toBe(controller.signal);
      return makeSseStub({ lines: [sseData({ type: "transcript.text.delta", delta: "a" })] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(4)]),
      startSec: 0,
      durationSec: 60,
      provider: STEPFUN_PROVIDER,
      signal: controller.signal
    });
    controller.abort();
    await expect(promise).rejects.toThrow("已停止生成");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("pipeline 注册存在性（stepfun-sse 已接入管线）", () => {
  it("pipeline 导入不因注册缺失抛错（type 存在）", async () => {
    const pipeline = await import("../../extension/asr/pipeline.js");
    expect(pipeline.runAsrPipeline).toBeTypeOf("function");
  });
});
