// pipeline.js + openai-transcriptions 适配器测试。
// 关键点：转写调度已迁入 offscreen（engine + ASR_ADAPTERS，见 entry/offscreen-asr.js
// 与 engine.test.js），页面侧 pipeline 只做编排——取音轨 → 任务宿主（生产为
// offscreen 桥，测试传合成宿主）收文本结果 → 合并/诊断。宿主契约：
//   async ({ audioUrl, backupUrls, onProgress? }) =>
//     { results, totalChunks, skippedSegments, failedChunks }
// 网络层用 fake fetch（vi.stubGlobal("fetch")）断言 FormData 与请求体。
// 管线不带 runId/isStale 守卫：转写与视频切换解耦（切走视频任务照跑，
// 中止只剩真断连），见 fallback 的 UI 门控与 offscreen-bridge.page。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

// ===== 模块级 mock：pipeline 的外部依赖 =====

// 切片宿主走 offscreen 直连（jsdom 无 chrome.runtime.connect），mock 掉
// audio-source 返回的 URL 即可（pipeline 不直接接触 offscreen 通道）。
vi.mock("../../extension/asr/audio-source.js", () => ({
  getSourceAudioUrl: vi.fn(async () => ({
    url: "https://example.com/audio.m4s",
    backupUrls: []
  }))
}));
// retryAsync 已移入 shared/error-helpers.js（转写重试现由 offscreen 侧
// engine.js 调用，见 engine.test.js）。这里不用 vi.mock 工厂：
// resetModuleState 的 vi.resetModules 不会重跑 mock 工厂，工厂里
// importOriginal 捕获的真实导出会闭包到过期的 state 实例（ensureRunActive 因此
// 看不到用例内 setFetchRunId 的变更）。保持直 import 真实模块，逐用例新鲜。
vi.mock("../../extension/reader/presenter.js", () => ({
  subscribeSubtitleRefresh: vi.fn(),
  notifyReaderPresenter: vi.fn()
}));
vi.mock("../../extension/ui/ui-renderer.js", () => ({
  renderMeta: vi.fn(),
  renderSubtitleSelect: vi.fn(),
  setStatus: vi.fn(),
  setMessage: vi.fn()
}));
vi.mock("../../extension/subtitle/ui.js", () => ({
  applyNoSubtitleState: vi.fn(),
  readVideoDescription: vi.fn(() => "")
}));
vi.mock("../../extension/subtitle/core.js", () => ({
  readVideoTitle: vi.fn(() => "标题"),
  readVideoAuthor: vi.fn(() => "作者"),
  readUploadDate: vi.fn(() => "2026-01-01"),
  refreshDerivedContent: vi.fn(async () => {})
}));
vi.mock("../../extension/subtitle/cache.js", () => ({
  getSubtitleCacheKey: vi.fn(() => "boc_subtitle_cache_asr_test"),
  loadSubtitleFromCache: vi.fn(async () => null),
  saveSubtitleToCache: vi.fn(async () => {}),
  clearSubtitleCacheByKey: vi.fn(async () => {})
}));
vi.mock("../../extension/bilibili/gateway.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, contentFetchJson: vi.fn() };
});

// 合成任务宿主：模拟 offscreen 桥返回的文本结果（{results, totalChunks,
// skippedSegments, failedChunks}），results 为按片 index 对齐的单片记录
// [{ index, startSec, durationSec, result }]。durationSec 对齐 offscreen
// streamWavChunks 的实际解码片长语义（测试按时长切好传入）。
function makeSynthTaskHost(chunks) {
  return vi.fn(async () => ({
    results: chunks.map((chunk, index) => ({
      index,
      startSec: chunk.startSec,
      durationSec: chunk.durationSec,
      result: chunk.result
    })),
    totalChunks: chunks.length,
    skippedSegments: 0,
    failedChunks: 0
  }));
}

// 默认 provider（openai-transcriptions，带时间戳）
const OPENAI_PROVIDER = {
  id: "siliconflow-sensevoice",
  name: "SiliconFlow 硅基流动",
  type: "openai-transcriptions",
  baseUrl: "https://api.siliconflow.cn/v1",
  model: "FunAudioLLM/SenseVoiceSmall",
  supportsTimestamps: true,
  apiKey: "sk-test"
};

let pipeline;

beforeEach(async () => {
  resetModuleState();
  pipeline = await import("../../extension/asr/pipeline.js");
  // fetch mock：默认直接 200 返回空 text（transcribe 各用例自己覆盖）
  vi.stubGlobal("fetch", vi.fn(async () => {
    return { ok: true, status: 200, json: async () => ({ text: "" }) };
  }));
});

describe("openai-transcriptions 适配器", () => {
  it("verbose_json 有 segments：正常映射片内相对秒", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        text: "你好世界",
        segments: [
          { start: 0.5, end: 1.2, text: "你好" },
          { start: 1.5, end: 2.4, text: "世界" }
        ]
      })
    }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    const wavBlob = new Blob([new Uint8Array(16000 * 2 * 2)]);
    const result = await adapter.transcribe({ wavBlob, startSec: 0, durationSec: 60, provider: OPENAI_PROVIDER });

    expect(result.text).toBe("你好世界");
    expect(result.segments).toEqual([
      { start: 0.5, end: 1.2, text: "你好" },
      { start: 1.5, end: 2.4, text: "世界" }
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("json 降级路径：响应无 segments（SiliconFlow）→ 重试 json 只产 text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ text: "纯文本" }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ text: "纯文本" }) });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    const result = await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(8)]),
      startSec: 0,
      durationSec: 60,
      provider: OPENAI_PROVIDER
    });

    expect(result.text).toBe("纯文本");
    expect(result.segments).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("2xx 但响应体不是合法 JSON（status=-1）：仍走 json 降级（平台兼容问题，共 2 次 fetch）", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        // 响应到了但 json() 解析失败 → postTranscription 返回 status=-1
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        }
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ text: "降级文本" }) });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    const result = await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(8)]),
      startSec: 0,
      durationSec: 60,
      provider: OPENAI_PROVIDER
    });

    expect(result).toEqual({ text: "降级文本" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("verbose_json 500：直接抛 HTTP 错误且只 fetch 1 次（非 2xx 不再降级第二次 POST）", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "internal error"
    }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    // 单片 wav 38MB 级：非 2xx 后断言绝不发生第二次全量重传
    const wavBlob = new Blob([new Uint8Array(16000 * 2 * 2)]);

    await expect(
      adapter.transcribe({ wavBlob, startSec: 0, durationSec: 60, provider: OPENAI_PROVIDER })
    ).rejects.toMatchObject({ message: "HTTP 500: internal error", status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("verbose_json 401：确定性鉴权失败直接抛且只 fetch 1 次（不再降级）", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "invalid api key"
    }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");

    await expect(
      adapter.transcribe({
        wavBlob: new Blob([new Uint8Array(8)]),
        startSec: 0,
        durationSec: 60,
        provider: OPENAI_PROVIDER
      })
    ).rejects.toMatchObject({ message: "HTTP 401: invalid api key", status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetch 网络拒绝：错误原样上抛，消息形态可被 isRetryableNetworkError 命中", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    const { isRetryableNetworkError } = await import("../../extension/shared/error-helpers.js");

    let caught = null;
    try {
      await adapter.transcribe({
        wavBlob: new Blob([new Uint8Array(8)]),
        startSec: 0,
        durationSec: 60,
        provider: OPENAI_PROVIDER
      });
    } catch (error) {
      caught = error;
    }

    // 网络层错误不被适配器包装：原样上抛，交 retryAsync 消息启发式判定可重试
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught.message).toBe("Failed to fetch");
    expect(isRetryableNetworkError(caught)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("FormData 字段断言：body 为 FormData、model 正确、绝无 Content-Type 头、apiKey 带 Bearer", async () => {
    let captured = null;
    let capturedUrl = null;
    const fetchMock = vi.fn(async (url, init) => {
      captured = init;
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => ({ text: "ok", segments: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(8)], { type: "audio/wav" }),
      startSec: 0,
      durationSec: 60,
      provider: OPENAI_PROVIDER
    });

    // json 降级路径只产 text：verbose_json 一次 + json 一次（无 segments → 降级）
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // FormData 捕获最后一次请求（json 降级那次）
    expect(captured.body).toBeInstanceOf(FormData);
    expect(captured.body.get("model")).toBe("FunAudioLLM/SenseVoiceSmall");
    expect(captured.body.get("response_format")).toBe("json");
    // 语言不放在 multipart 字段里（SiliconFlow 只认查询参数）
    expect(captured.body.get("language")).toBeNull();
    expect(captured.body.get("file")).toBeInstanceOf(Blob);
    // 绝不手动设 Content-Type
    expect(captured.headers["Content-Type"]).toBeUndefined();
    expect(captured.headers.Authorization).toBe("Bearer sk-test");
    // provider 未设语言档位 → URL 不带 language 参数
    expect(capturedUrl).toBe("https://api.siliconflow.cn/v1/audio/transcriptions");
  });

  it("language=en 时 URL 附加 ?language=english（英文转写链路）", async () => {
    let capturedUrls = [];
    const fetchMock = vi.fn(async (url, init) => {
      capturedUrls.push(url);
      return { ok: true, status: 200, json: async () => ({ text: "hello" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(8)]),
      startSec: 0,
      durationSec: 60,
      provider: { ...OPENAI_PROVIDER, language: "en" }
    });

    // 两次请求（verbose_json + json 降级）都带 ?language=english
    expect(capturedUrls).toEqual([
      "https://api.siliconflow.cn/v1/audio/transcriptions?language=english",
      "https://api.siliconflow.cn/v1/audio/transcriptions?language=english"
    ]);
  });

  it("language=zh 时 URL 附加 ?language=zh", async () => {
    let capturedUrls = [];
    const fetchMock = vi.fn(async (url) => {
      capturedUrls.push(url);
      return { ok: true, status: 200, json: async () => ({ text: "你好" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(8)]),
      startSec: 0,
      durationSec: 60,
      provider: { ...OPENAI_PROVIDER, language: "zh" }
    });
    expect(capturedUrls[0]).toBe("https://api.siliconflow.cn/v1/audio/transcriptions?language=zh");
  });

  it("apiKey 为空时不带 Authorization 头", async () => {
    let captured = null;
    const fetchMock = vi.fn(async (url, init) => {
      captured = init;
      return { ok: true, status: 200, json: async () => ({ text: "ok" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(8)]),
      startSec: 0,
      durationSec: 60,
      provider: { ...OPENAI_PROVIDER, apiKey: "" }
    });
    expect(captured.headers.Authorization).toBeUndefined();
    expect(captured.headers["Content-Type"]).toBeUndefined();
  });
});

describe("pipeline 时间戳合成与偏移合并", () => {
  it("25 分钟视频 20 分钟片 → 2 片，全局偏移正确且递增", async () => {
    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      onProgress: vi.fn(),
      chunkHost: makeSynthTaskHost([
        {
          startSec: 0,
          durationSec: 1200,
          result: {
            text: "片一",
            segments: [
              { start: 0, end: 1, text: "第一句" },
              { start: 2, end: 3, text: "第二句" }
            ]
          }
        },
        {
          startSec: 1200,
          durationSec: 300,
          result: {
            text: "片二",
            segments: [
              { start: 0, end: 1, text: "第三句" },
              { start: 1.5, end: 2.5, text: "第四句" }
            ]
          }
        }
      ])
    });

    expect(body).toEqual([
      { from: 0, to: 1, content: "第一句" },
      { from: 2, to: 3, content: "第二句" },
      { from: 1200, to: 1201, content: "第三句" },
      { from: 1201.5, to: 1202.5, content: "第四句" }
    ]);
    // from 严格递增
    for (let i = 1; i < body.length; i += 1) {
      expect(body[i].from).toBeGreaterThan(body[i - 1].from);
    }
  });

  it("任务参数：host 收到音轨地址与 onProgress 透传，进度文本原样中继，不再携带 isStale", async () => {
    const onProgress = vi.fn();
    const host = vi.fn(async ({ onProgress: relay }) => {
      relay?.("语音识别中 1 片…");
      return {
        results: [{ index: 0, startSec: 0, durationSec: 60, result: { text: "片文本" } }],
        totalChunks: 1,
        skippedSegments: 0,
        failedChunks: 0
      };
    });

    await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      onProgress,
      chunkHost: host
    });

    expect(host).toHaveBeenCalledTimes(1);
    const hostArgs = host.mock.calls[0][0];
    expect(hostArgs.audioUrl).toBe("https://example.com/audio.m4s");
    expect(hostArgs.backupUrls).toEqual([]);
    // 守卫链已整体移除：宿主参数不再有 isStale（跨 context 中止只剩真断连）
    expect(hostArgs.isStale).toBeUndefined();
    // 页面自身的阶段文案 + offscreen 引擎进度文本原样中继
    expect(onProgress).toHaveBeenCalledWith("无字幕轨，正在获取音频流…");
    expect(onProgress).toHaveBeenCalledWith("音频下载与解码中…");
    expect(onProgress).toHaveBeenCalledWith("语音识别中 1 片…");
  });

  it("无 segments（降级路径）：整片一条粗粒度字幕 {from,to,content}", async () => {
    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      onProgress: vi.fn(),
      chunkHost: makeSynthTaskHost([
        { startSec: 0, durationSec: 600, result: { text: "整片文本" } }
      ])
    });

    expect(body).toEqual([{ from: 0, to: 600, content: "整片文本" }]);
  });

  it("to 不超过片末边界（segments 越界被截断）", async () => {
    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      chunkHost: makeSynthTaskHost([
        {
          startSec: 0,
          durationSec: 120,
          result: { text: "x", segments: [{ start: 0, end: 99999, text: "越界句" }] }
        }
      ])
    });
    expect(body[0]).toEqual({ from: 0, to: 120, content: "越界句" });
  });

  it("转写与视频切换解耦：runId 过期（fetchRunId 前进）不再中止管线", async () => {
    const { clipState } = await import("../../extension/core/state.js");
    // 模拟转写进行中视频被切换/并发刷新：fetchRunId 前进，任务照跑不中止
    clipState.setFetchRunId(99);

    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      onProgress: vi.fn(),
      chunkHost: makeSynthTaskHost([
        { startSec: 0, durationSec: 600, result: { text: "片文本" } }
      ])
    });
    expect(body).toEqual([{ from: 0, to: 600, content: "片文本" }]);
  });
});

describe("pipeline 空结果与诊断", () => {
  it("全部 text 为空白 → 返回 []", async () => {
    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      chunkHost: makeSynthTaskHost([
        { startSec: 0, durationSec: 60, result: { text: "   " } }
      ])
    });
    expect(body).toEqual([]);
  });

  it("空结果诊断：分片数/各片文本长度/事件诊断拼进文案", async () => {
    const onEmptyDiagnostic = vi.fn();
    await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      chunkHost: makeSynthTaskHost([
        { startSec: 0, durationSec: 60, result: { text: "", _asrDiag: { noSpeech: true } } }
      ]),
      onEmptyDiagnostic
    });

    expect(onEmptyDiagnostic).toHaveBeenCalledTimes(1);
    const diagText = onEmptyDiagnostic.mock.calls[0][0];
    expect(diagText).toContain("分片 1 片");
    expect(diagText).toContain("各片文本长度[0]");
    expect(diagText).toContain("事件诊断");
    expect(diagText).not.toContain("转写失败");
  });

  it("空结果诊断追加失败计数：N 片转写失败、M 段解码失败已跳过", async () => {
    const onEmptyDiagnostic = vi.fn();
    // 转写失败片/解码失败段不产生 result 记录，只有 done 计数上来
    const host = vi.fn(async () => ({
      results: [],
      totalChunks: 3,
      skippedSegments: 2,
      failedChunks: 1
    }));

    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      chunkHost: host,
      onEmptyDiagnostic
    });

    expect(body).toEqual([]);
    const diagText = onEmptyDiagnostic.mock.calls[0][0];
    expect(diagText).toContain("分片 3 片");
    expect(diagText).toContain("1 片转写失败");
    expect(diagText).toContain("2 段解码失败已跳过");
  });

  it("非空结果不追加失败计数（不改变成功路径文案）", async () => {
    const onEmptyDiagnostic = vi.fn();
    const host = vi.fn(async () => ({
      results: [{ index: 0, startSec: 0, durationSec: 60, result: { text: "有内容" } }],
      totalChunks: 2,
      skippedSegments: 1,
      failedChunks: 1
    }));

    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      chunkHost: host,
      onEmptyDiagnostic
    });

    expect(body).toEqual([{ from: 0, to: 60, content: "有内容" }]);
    // 有文本产出 → 诊断回调不触发
    expect(onEmptyDiagnostic).not.toHaveBeenCalled();
  });
});
