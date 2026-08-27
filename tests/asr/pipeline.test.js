// pipeline.js + openai-transcriptions 适配器测试。
// 关键点：pipeline 的切片宿主可注入（chunkHost 参数），单测直接传合成
// 宿主，不真正路由到 offscreen（避免依赖 chrome.offscreen / AudioContext）；
// 网络层全部用 fake fetch（vi.stubGlobal("fetch")）断言 FormData 与请求体。
// runId 作废（STALE_RUN）与缓存命中通过 mock fetcher / 真实 state 验证。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

// ===== 模块级 mock：pipeline 的外部依赖 =====

// 当前 runId 约定：ensureRunActive(runId) 要求 runId === state.clip.fetchRunId。
// 测试用当前 fetchRunId 作为有效 runId；runId 作废用例显式修改 fetchRunId。
function getValidRunId() {
  return 0;
}

// 切片宿主走 offscreen 直连（jsdom 无 chrome.runtime.connect），mock 掉
// audio-source 返回的 URL 即可（pipeline 不直接接触 offscreen 通道）。
vi.mock("../../extension/asr/audio-source.js", () => ({
  getSourceAudioUrl: vi.fn(async () => ({
    url: "https://example.com/audio.m4s",
    backupUrls: []
  }))
}));
// 依赖 chrome.storage 的 provider store 也用不到（pipeline 直接收 provider）。
vi.mock("../../extension/asr/asr-provider-store.js", () => ({
  loadAsrProviders: vi.fn(async () => []),
  getAsrProviderKey: vi.fn(async () => "")
}));
// fetcher.js 只被 pipeline 引 retryAsync / ensureRunActive；retryAsync 保持真实
// 实现（单测里直接断言重试次数），fetcher 其余副作用（subscribeSubtitleRefresh）
// 需 presenter mock 掉顶层接线。
vi.mock("../../extension/subtitle/fetcher.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    retryAsync: vi.fn((fn) => fn())
  };
});
vi.mock("../../extension/reader/presenter.js", () => ({
  subscribeSubtitleRefresh: vi.fn(),
  notifyReaderPresenter: vi.fn()
}));
vi.mock("../../extension/ui/ui-renderer.js", () => ({
  renderMeta: vi.fn(),
  renderSubtitleSelect: vi.fn(),
  setBusyState: vi.fn(),
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

// 合成切片宿主：模拟 offscreen 文档返回的切片（[{index,startSec,durationSec,
// wavBlob}]），durationSec 按 plan.chunkSeconds 切（chunker 的 decideChunks
// 语义），wavBlob 用 chunker 的 encodeWav 生成真实 WAV（16k 单声道固定样本值）。
// 测试视频时长由调用方传入 durationSec，宿主按时长生成对应长度的采样。
function makeSynthChunkHost({ durationSec = 60 } = {}) {
  return async function synthChunkHost({ plan }) {
    const chunkSeconds = Number(plan?.chunkSeconds) || 0;
    const totalSamples = Math.max(1, Math.round(durationSec * 16000));
    const samples = new Float32Array(totalSamples).fill(0.25);
    const chunks = [];
    let startSec = 0;
    let index = 0;
    while (totalSamples - Math.round(startSec * 16000) > 0) {
      const secs = chunkSeconds > 0 ? chunkSeconds : durationSec;
      const dur = Math.min(secs, durationSec - startSec);
      const startSample = Math.round(startSec * 16000);
      const sampleCount = Math.max(1, Math.round(dur * 16000));
      chunks.push({
        index,
        startSec,
        durationSec: dur,
        wavBlob: encodeWav(samples.subarray(startSample, startSample + sampleCount), 16000)
      });
      startSec += dur;
      index += 1;
      if (chunkSeconds <= 0) break;
    }
    return chunks;
  };
}

// 计数信号量 fake adapter：记录峰值并发并制造可控延迟，用于断言并发上限。
function makeCountingAdapter() {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const adapter = async () => {
    active += 1;
    peak = Math.max(peak, active);
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
    return { text: `片 ${calls}` };
  };
  return { adapter, getPeak: () => peak, getCalls: () => calls };
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

import { encodeWav } from "../../extension/asr/chunker.js";

let pipeline;
let fetcherMock;

beforeEach(async () => {
  resetModuleState();
  pipeline = await import("../../extension/asr/pipeline.js");
  fetcherMock = (await import("../../extension/subtitle/fetcher.js")).retryAsync;
  fetcherMock.mockImplementation((fn) => fn());
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

  it("FormData 字段断言：body 为 FormData、model 正确、绝无 Content-Type 头、apiKey 带 Bearer", async () => {
    let captured = null;
    const fetchMock = vi.fn(async (url, init) => {
      captured = init;
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
    // 不硬编码语言：省略交服务端自动检测
    expect(captured.body.get("language")).toBeNull();
    expect(captured.body.get("file")).toBeInstanceOf(Blob);
    // 绝不手动设 Content-Type
    expect(captured.headers["Content-Type"]).toBeUndefined();
    expect(captured.headers.Authorization).toBe("Bearer sk-test");
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          text: "片一",
          segments: [
            { start: 0, end: 1, text: "第一句" },
            { start: 2, end: 3, text: "第二句" }
          ]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          text: "片二",
          segments: [
            { start: 0, end: 1, text: "第三句" },
            { start: 1.5, end: 2.5, text: "第四句" }
          ]
        })
      });
    vi.stubGlobal("fetch", fetchMock);

    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      durationSec: 25 * 60,
      provider: { ...OPENAI_PROVIDER, supportsTimestamps: true },
      runId: getValidRunId(),
      onProgress: vi.fn(),
      chunkHost: makeSynthChunkHost({ durationSec: 25 * 60 })
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

  it("无 segments（降级路径）：整片一条粗粒度字幕 {from,to,content}", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ text: "整片文本" }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ text: "整片文本" }) });
    vi.stubGlobal("fetch", fetchMock);

    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      durationSec: 10 * 60,
      provider: { ...OPENAI_PROVIDER, supportsTimestamps: false },
      runId: getValidRunId(),
      onProgress: vi.fn(),
      chunkHost: makeSynthChunkHost({ durationSec: 10 * 60 })
    });

    // 10 分钟整段 → 1 片（统一 20 分钟片）
    expect(body).toEqual([{ from: 0, to: 600, content: "整片文本" }]);
  });

  it("to 不超过片末边界（segments 越界被截断）", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        text: "x",
        segments: [{ start: 0, end: 99999, text: "越界句" }]
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      durationSec: 120,
      provider: { ...OPENAI_PROVIDER, supportsTimestamps: true },
      runId: getValidRunId(),
      chunkHost: makeSynthChunkHost({ durationSec: 120 })
    });
    expect(body[0]).toEqual({ from: 0, to: 120, content: "越界句" });
  });
});

describe("pipeline 并发上限与 runId 作废", () => {
  it("openai-transcriptions 最多 2 片并发：计数信号量 fake adapter 峰值 ≤2", async () => {
    // 用适配器级并发窗口验证：直接调用 runWithConcurrency（导出的纯函数）
    const counting = makeCountingAdapter();
    const tasks = Array.from({ length: 6 }, (_, i) => async () => {
      await counting.adapter();
      return i;
    });
    const results = await pipeline.runWithConcurrency(tasks, 2);
    expect(counting.getPeak()).toBeLessThanOrEqual(2);
    expect(counting.getCalls()).toBe(6);
    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("runId 作废：pipeline 各步守卫在 runId 不匹配时立即中止上抛", async () => {
    const { clipState } = await import("../../extension/core/state.js");
    // 模拟切换视频：fetchRunId 已前进，旧 runId 作废
    clipState.setFetchRunId(99);

    await expect(
      pipeline.runAsrPipeline({
        bvid: "BV1test",
        cid: "101",
        durationSec: 11 * 60,
        provider: { ...OPENAI_PROVIDER, supportsTimestamps: true },
        runId: 0,
        onProgress: vi.fn(),
        chunkHost: makeSynthChunkHost({ durationSec: 11 * 60 })
      })
    ).rejects.toThrow("Stale refresh run");
  });
});

describe("pipeline 重试与未知类型", () => {
  it("网络错误/5xx：retryAsync 指数退避重试（transcribe 抛 HTTP 5xx）", async () => {
    // 断言 pipeline 调用 retryAsync 时传了重试次数 2（指数退避由 fetcher 的
    // retryAsync 实现，这里 mock 掉直调，验证传参而非真实退避耗时）。
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ text: "ok" }) })
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ text: "ok" }) });
    vi.stubGlobal("fetch", fetchMock);

    // 第 1 链：verbose 500 → 降级 json 500 → transcribe 抛 HTTP 500
    // retryAsync mock 直调：抛错 → 但被 retryAsync 包装的 task 内部没有重试
    // （mock 的 retryAsync 只调一次 fn）。要验证重试，改用真实 retryAsync 行为。
    // 这里先断言 pipeline 以 retries=2 调用 retryAsync。
    const { clipState } = await import("../../extension/core/state.js");
    clipState.setFetchRunId(0);

    const retrySpy = vi.fn(async (fn) => {
      // 模拟 retryAsync 指数退避：最多 retries 次
      let lastErr;
      for (let attempt = 0; attempt <= 2; attempt += 1) {
        try {
          return await fn();
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    });
    fetcherMock.mockImplementation(retrySpy);

    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      durationSec: 60,
      provider: { ...OPENAI_PROVIDER, supportsTimestamps: true },
      runId: 0,
      chunkHost: makeSynthChunkHost({ durationSec: 60 })
    });

    // retryAsync 被调用（每片一次），重试 1 次后成功：
    // 尝试1：verbose 500 + json 降级 500（2 请求）→ 失败；
    // 尝试2：verbose 500（第 3 个 500）+ json 降级 200（第 4 个）→ 成功。
    // 共 4 个请求。
    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(body).toEqual([{ from: 0, to: 60, content: "ok" }]);
  });

  it("未知平台类型：throw 明确错误", async () => {
    await expect(
      pipeline.runAsrPipeline({
        bvid: "BV1test",
        cid: "101",
        durationSec: 60,
        provider: { type: "mystery", baseUrl: "https://x", model: "m" },
        runId: getValidRunId(),
        chunkHost: makeSynthChunkHost({ durationSec: 60 })
      })
    ).rejects.toThrow("暂不支持的平台类型");
  });
});

describe("pipeline 空结果", () => {
  it("全部 text 为空白 → 返回 []", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: "   " })
    }));
    vi.stubGlobal("fetch", fetchMock);
    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      durationSec: 60,
      provider: { ...OPENAI_PROVIDER, supportsTimestamps: false },
      runId: getValidRunId(),
      chunkHost: makeSynthChunkHost({ durationSec: 60 })
    });
    expect(body).toEqual([]);
  });
});
