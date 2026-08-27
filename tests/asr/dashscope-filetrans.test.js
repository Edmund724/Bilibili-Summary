// extension/asr/adapters/dashscope-filetrans.js 测试。
// 纯 vitest + mock fetch 全链路：getPolicy 授权 → OSS 上传 → 提交任务 →
// 轮询 → 拉结果 JSON，断言 URL/头/表单/字段与毫秒→秒映射。
// 轮询间隔 POLL_INTERVAL_MS 是模块常量，beforeEach 里用
// __setPollIntervalForTest(0) 让轮询循环立即重试（免 fake timers）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

// 五个步骤的请求按顺序出现；用 generator 顺序吐 mock 响应
function makeSequencedResponses(...responses) {
  const calls = [];
  let index = 0;
  const fetchMock = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    if (index >= responses.length) {
      throw new Error("fetch 被调用次数超过 mock 数量");
    }
    const response = responses[index];
    index += 1;
    return response;
  });
  return { fetchMock, calls };
}

const POLICY = {
  policy: "eyJwb2xpY3kiOiJ4eXoifQ==",
  signature: "SIGN123",
  upload_dir: "dashscope-instant/test/2026-08-27/asr",
  upload_host: "https://dashscope-file-test.oss-cn-beijing.aliyuncs.com",
  oss_access_key_id: "LTAI5t",
  x_oss_object_acl: "private",
  x_oss_forbid_overwrite: "true"
};

const PROVIDER = {
  id: "aliyun-dashscope",
  type: "dashscope-filetrans",
  baseUrl: "https://dashscope.aliyuncs.com",
  model: "paraformer-v2",
  apiKey: "sk-dashscope-test"
};

const TASK_ID = "task-123456";

// 轮询间隔 POLL_INTERVAL_MS 是模块常量；测试用 __setPollIntervalForTest(0)
// 让轮询循环立即重试（优先于 fake timers，简洁且不依赖时钟）。

let adapter;

beforeEach(async () => {
  resetModuleState();
  adapter = await import("../../extension/asr/adapters/dashscope-filetrans.js");
  // 轮询间隔置 0：轮询循环立即重试，无需 fake timers
  adapter.__setPollIntervalForTest(0);
  // 默认 fetch mock：200 空响应（各用例覆盖）
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
});

function makeWavBlob() {
  return new Blob([new Uint8Array(16000 * 2 * 2)], { type: "audio/wav" });
}

// 结果 JSON 结构（transcripts[].sentences[]，毫秒时间戳）
function makeResultJson() {
  return {
    transcripts: [
      {
        channel_id: 0,
        text: "你好世界",
        sentences: [
          { begin_time: 0, end_time: 1250, text: "你好", sentence_id: 1 },
          { begin_time: 1500, end_time: 2500, text: "世界", sentence_id: 2 }
        ]
      }
    ]
  };
}

// 序列响应：getPolicy 200 → OSS 上传 200 → 提交 200 → 轮询 PENDING →
// 轮询 RUNNING → 轮询 SUCCEEDED（带 results transcription_url）→ 结果 JSON
function happyPathResponses() {
  return [
    { ok: true, status: 200, json: async () => ({ data: POLICY }) },
    { ok: true, status: 200, json: async () => ({}) },
    {
      ok: true,
      status: 200,
      json: async () => ({ output: { task_status: "PENDING", task_id: TASK_ID } })
    },
    { ok: true, status: 200, json: async () => ({ output: { task_status: "PENDING", task_id: TASK_ID } }) },
    { ok: true, status: 200, json: async () => ({ output: { task_status: "RUNNING", task_id: TASK_ID } }) },
    {
      ok: true,
      status: 200,
      json: async () => ({
        output: {
          task_status: "SUCCEEDED",
          task_id: TASK_ID,
          results: [{ file_url: "oss://x.wav", transcription_url: "https://result.example.com/out.json" }]
        }
      })
    },
    { ok: true, status: 200, json: async () => makeResultJson() }
  ];
}

describe("dashscope-filetrans 适配器", () => {
  it("五步 happy path：授权/上传/提交/轮询/拉结果全链路，请求形状正确", async () => {
    const { fetchMock, calls } = makeSequencedResponses(...happyPathResponses());
    vi.stubGlobal("fetch", fetchMock);

    const onProgress = vi.fn();
    const result = await adapter.transcribe({
      wavBlob: makeWavBlob(),
      startSec: 0,
      durationSec: 60,
      provider: PROVIDER,
      onProgress
    });

    // 7 次请求：getPolicy、OSS 上传、提交任务、3 次轮询、1 次拉结果
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(result.text).toBe("你好世界");
    // 毫秒 → 秒映射精确（1250ms → 1.25s，浮点）
    expect(result.segments).toEqual([
      { start: 0, end: 1.25, text: "你好" },
      { start: 1.5, end: 2.5, text: "世界" }
    ]);

    // ① getPolicy：GET + action=getPolicy&model=paraformer-v2 + Bearer
    expect(calls[0].url).toBe(
      "https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=paraformer-v2"
    );
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.headers.Authorization).toBe("Bearer sk-dashscope-test");

    // ② OSS 上传：POST upload_host + multipart（FormData）关键字段
    expect(calls[1].url).toBe(POLICY.upload_host);
    expect(calls[1].init.method).toBe("POST");
    // FormData 请求不设任何 headers（浏览器自动带 multipart boundary）
    expect(calls[1].init.headers).toBeUndefined();
    const form = calls[1].init.body;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("policy")).toBe(POLICY.policy);
    expect(form.get("Signature")).toBe(POLICY.signature);
    expect(form.get("OSSAccessKeyId")).toBe(POLICY.oss_access_key_id);
    expect(form.get("key")).toBe(`${POLICY.upload_dir}/audio.wav`);
    expect(form.get("x-oss-object-acl")).toBe("private");
    expect(form.get("x-oss-forbid-overwrite")).toBe("true");
    expect(form.get("success_action_status")).toBe("200");
    expect(form.get("file")).toBeInstanceOf(Blob);

    // ③ 提交任务：X-DashScope-Async: enable + X-DashScope-OssResourceResolve: enable
    //    + body { model, input: { file_urls: [oss://...] } }
    expect(calls[2].url).toBe("https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription");
    expect(calls[2].init.method).toBe("POST");
    expect(calls[2].init.headers["X-DashScope-Async"]).toBe("enable");
    expect(calls[2].init.headers["X-DashScope-OssResourceResolve"]).toBe("enable");
    expect(calls[2].init.headers.Authorization).toBe("Bearer sk-dashscope-test");
    const submitBody = JSON.parse(calls[2].init.body);
    expect(submitBody.model).toBe("paraformer-v2");
    expect(submitBody.input.file_urls).toEqual(["oss://dashscope-instant/test/2026-08-27/asr/audio.wav"]);

    // ④ 轮询：GET tasks/{task_id}，PENDING→RUNNING→SUCCEEDED 至少两次
    expect(calls[3].url).toBe(`https://dashscope.aliyuncs.com/api/v1/tasks/${TASK_ID}`);
    expect(calls[4].url).toBe(`https://dashscope.aliyuncs.com/api/v1/tasks/${TASK_ID}`);
    expect(calls[5].url).toBe(`https://dashscope.aliyuncs.com/api/v1/tasks/${TASK_ID}`);
    for (let i = 3; i <= 5; i += 1) {
      expect(calls[i].init.method).toBe("GET");
      expect(calls[i].init.headers.Authorization).toBe("Bearer sk-dashscope-test");
    }

    // ⑤ 拉结果：GET transcription_url
    expect(calls[6].url).toBe("https://result.example.com/out.json");

    // 轮询进度：等待秒数递增（PENDING 后一次，RUNNING 后一次；间隔 0 时
    // 秒数显示随 currentPollInterval 累加，断言"每次轮询都推一次进度"）
    const waitMessages = onProgress.mock.calls
      .map(([msg]) => msg)
      .filter((msg) => msg.startsWith("百炼任务处理中"));
    expect(waitMessages).toHaveLength(2);
    expect(waitMessages[0]).toMatch(/^百炼任务处理中，已等待 \d+s…$/);
    expect(waitMessages[1]).toMatch(/^百炼任务处理中，已等待 \d+s…$/);
  });

  it("FAILED 任务：报错文案带上后台返回的 message", async () => {
    const { fetchMock, calls } = makeSequencedResponses(
      { ok: true, status: 200, json: async () => ({ data: POLICY }) },
      { ok: true, status: 200, json: async () => ({}) },
      {
        ok: true,
        status: 200,
        json: async () => ({ output: { task_status: "PENDING", task_id: TASK_ID } })
      },
      {
        ok: true,
        status: 200,
        json: async () => ({
          output: {
            task_status: "FAILED",
            task_id: TASK_ID,
            code: "InvalidFile.DownloadFailed",
            message: "The audio file cannot be downloaded.",
            results: [
              {
                file_url: "oss://x.wav",
                code: "InvalidFile.DownloadFailed",
                message: "The audio file cannot be downloaded.",
                subtask_status: "FAILED"
              }
            ]
          }
        })
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      adapter.transcribe({
        wavBlob: makeWavBlob(),
        startSec: 0,
        durationSec: 60,
        provider: PROVIDER
      })
    ).rejects.toThrow("The audio file cannot be downloaded.");

    // FAILED 后不再发起新轮询
    expect(calls.length).toBe(4);
  });

  it("abort 在 PENDING 轮询期间触发：抛中止错误且不再发起新轮询请求", async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      // getPolicy 200
      .mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ data: POLICY }) }))
      // OSS 上传 200
      .mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({}) }))
      // 提交任务 200
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ output: { task_status: "PENDING", task_id: TASK_ID } })
      }))
      // 第 1 次轮询返回 PENDING，返回后触发 abort
      .mockImplementationOnce(async () => {
        controller.abort();
        return { ok: true, status: 200, json: async () => ({ output: { task_status: "PENDING", task_id: TASK_ID } }) };
      })
      // 兜底：若实现错误地继续轮询，这里会抛（不会命中 abort 检查的 mock）
      .mockImplementation(async () => {
        throw new Error("abort 后不应再发起轮询请求");
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      adapter.transcribe({
        wavBlob: makeWavBlob(),
        startSec: 0,
        durationSec: 60,
        provider: PROVIDER,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    // 请求止步在第 1 次轮询返回后（该跳检查 abort）：共 4 次，
    // getPolicy / 上传 / 提交 / 轮询；abort 后不再发起新轮询请求
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("授权 401：报错带「API Key 无效」文案且不进入后续步骤", async () => {
    const { fetchMock, calls } = makeSequencedResponses({
      ok: false,
      status: 401,
      text: async () => '{"code":"Unauthorized","message":"InvalidApiKey"}'
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      adapter.transcribe({
        wavBlob: makeWavBlob(),
        startSec: 0,
        durationSec: 60,
        provider: PROVIDER
      })
    ).rejects.toThrow("API Key 无效");
    expect(calls.length).toBe(1);
  });

  it("授权 403：报错带「API Key 无效」文案且不进入后续步骤", async () => {
    const { fetchMock, calls } = makeSequencedResponses({
      ok: false,
      status: 403,
      text: async () => "AccessDenied"
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      adapter.transcribe({
        wavBlob: makeWavBlob(),
        startSec: 0,
        durationSec: 60,
        provider: PROVIDER
      })
    ).rejects.toThrow("API Key 无效");
    expect(calls.length).toBe(1);
  });
});
