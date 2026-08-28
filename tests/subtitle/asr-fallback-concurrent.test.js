// 回归测试：ASR 转写进行中并发 refreshClip 的共享语义。
// 用户症状（修复前）：一键总结无字幕长视频时转写被反复打断 → 成果既不写缓存
// 也不进总结上下文；之后单独"抓取字幕"发现无缓存、从头重转。
// 修复后行为：同视频并发 refreshClip 命中进行中的转写共享同一 promise
// （不重启、runId 前进不误杀），转写成果即刻落缓存；被更新的抓取顶掉时仅
// UI 收尾让位，成果不丢。
// mock 结构镜像 asr-fallback.test.js。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

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
vi.mock("../../extension/bilibili/gateway.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchVideoMeta: vi.fn(),
    fetchSubtitleBundle: vi.fn(),
    fetchSubtitleBody: vi.fn(),
    readRuntimeVideoDuration: vi.fn(() => 300)
  };
});
vi.mock("../../extension/reader/page-context.js", () => ({
  resolvePageContext: vi.fn(() => ({ pageIndex: 1, cid: "101", cidSource: "test", pageTitle: "P1", duration: 300 }))
}));
vi.mock("../../extension/subtitle/core.js", () => ({
  readVideoTitle: vi.fn(() => "测试标题"),
  readVideoAuthor: vi.fn(() => "测试作者"),
  readUploadDate: vi.fn(() => "2026-01-01"),
  refreshDerivedContent: vi.fn(async () => {})
}));
vi.mock("../../extension/subtitle/ui.js", () => ({
  applyNoSubtitleState: vi.fn(),
  readVideoDescription: vi.fn(() => "")
}));
vi.mock("../../extension/subtitle/cache.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    buildSubtitleCandidates: vi.fn((tracks, preferred) => [preferred, ...(tracks || []).filter((t) => t !== preferred)]),
    clearSubtitleCacheByKey: vi.fn(async () => {}),
    saveSubtitleToCache: vi.fn(async () => {}),
    loadSubtitleFromCache: vi.fn(async () => null),
    getSubtitleCacheKey: vi.fn(({ subtitleId }) => `boc_subtitle_cache_${subtitleId || "x"}`)
  };
});
// ASR 依赖 mock：pipeline / audio-source / offscreen-bridge。provider 配置
// 不再经 asr-provider-store 内容侧直读（已收口到 background 的
// get-asr-runtime-config 消息），mock 改走 chrome.runtime.sendMessage 的
// 消息桩回包（见 beforeEach）。
vi.mock("../../extension/asr/pipeline.js", () => ({
  runAsrPipeline: vi.fn()
}));
vi.mock("../../extension/asr/audio-source.js", () => ({
  getSourceAudioUrl: vi.fn(async () => ({ url: "https://audio.example/a.m4s", backupUrls: [] }))
}));
vi.mock("../../extension/asr/offscreen-bridge.js", () => ({
  createOffscreenChunkHost: vi.fn(() => async () => [])
}));

let fetcher;
let gatewayMock;
let cacheMock;
let pipelineMock;
let stateMod;
let uiRenderer;

beforeEach(async () => {
  resetModuleState();
  fetcher = await import("../../extension/subtitle/fetcher.js");
  gatewayMock = await import("../../extension/bilibili/gateway.js");
  cacheMock = await import("../../extension/subtitle/cache.js");
  pipelineMock = await import("../../extension/asr/pipeline.js");
  stateMod = await import("../../extension/core/state.js");
  uiRenderer = await import("../../extension/ui/ui-renderer.js");

  for (const m of [gatewayMock, cacheMock, pipelineMock]) {
    for (const key of Object.keys(m)) {
      if (typeof m[key] === "function" && m[key].mockReset) {
        m[key].mockReset();
      }
    }
  }

  // 无字幕轨 + ASR 已配置，转写由测试手动控制 resolve 时机（模拟小时级转写）
  gatewayMock.fetchVideoMeta.mockResolvedValue({
    aid: "1",
    title: "t",
    author: "a",
    uploadDate: "2026-01-01",
    description: "",
    defaultCid: "101",
    defaultDuration: 300,
    pages: [{ cid: "101", page: 1, part: "P1", duration: 300 }]
  });
  gatewayMock.fetchSubtitleBundle.mockResolvedValue({ tracks: [], chapters: [] });
  // ASR 运行时配置走消息 seam：get-asr-runtime-config 回激活平台的 Key
  globalThis.__asrRuntimeConfig = {
    ok: true,
    providers: [
      { id: "p1", type: "openai-transcriptions", name: "本地 Whisper", model: "whisper-large-v3" }
    ],
    activeAsrProviderId: "p1",
    activeKey: "sk-local",
    asrLanguage: "auto",
    asrAutoFallback: true
  };
  cacheMock.loadSubtitleFromCache.mockResolvedValue(null);

  const syncSettings = { asrAutoFallback: true, activeAsrProviderId: "p1" };
  globalThis.__syncSettings = syncSettings;
  installContentMessageMock();
  stateMod.state.settings = {
    ...stateMod.state.settings,
    asrAutoFallback: true,
    activeAsrProviderId: "p1"
  };

  const preview = document.createElement("textarea");
  preview.id = "boc-preview";
  document.body.appendChild(preview);
});

// 统一消息桩：get-settings 回 __syncSettings，get-asr-runtime-config 回
// __asrRuntimeConfig（fetcher 的 ASR 运行时配置 seam），其余消息默认 ok:true。
function installContentMessageMock() {
  globalThis.chrome.runtime.sendMessage.mockImplementation((message, callback) => {
    if (message?.type === "get-settings") {
      callback?.({ ok: true, settings: globalThis.__syncSettings });
      return undefined;
    }
    if (message?.type === "get-asr-runtime-config") {
      callback?.(globalThis.__asrRuntimeConfig);
      return undefined;
    }
    callback?.({ ok: true });
    return undefined;
  });
}

// runAsrPipeline 挂起（转写中），返回句柄数组用于逐个 resolve/reject
function stubPendingPipeline() {
  const pending = [];
  pipelineMock.runAsrPipeline.mockImplementation(() => {
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  });
  return pending;
}

describe("ASR 转写中并发 refreshClip（修复：共享转写、成果落缓存）", () => {
  it("转写 pending 时第二次 refreshClip 共享同一转写：不重启、成果写缓存、两次都成功收尾", async () => {
    const pending = stubPendingPipeline();

    // 第一次抓取（例如侧边栏 init / popup-refresh #1 触发）→ 开始转写
    const first = fetcher.refreshClip();
    await vi.waitFor(() => expect(pipelineMock.runAsrPipeline).toHaveBeenCalledTimes(1));

    // 转写进行中，第二次抓取（侧边栏 focus/tab 切换 sync 触发的 popup-refresh #2）
    const second = fetcher.refreshClip();
    // 等第二次抓取走到"命中进行中转写"的共享等待点（全 mock 链路，短暂让步即可）
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 关键断言 1：不重启转写——runAsrPipeline 仍只被调用 1 次
    expect(pipelineMock.runAsrPipeline).toHaveBeenCalledTimes(1);

    // 转写"完成"（几小时的成果）
    pending[0].resolve([
      { from: 0, to: 1.2, content: "五小时转写成果" },
      { from: 1.5, to: 2.4, content: "第二条" }
    ]);

    const results = await Promise.allSettled([first, second]);

    // 关键断言 2：成果即刻落缓存（在 runId/UI 收尾检查之前），只写一次
    expect(cacheMock.saveSubtitleToCache).toHaveBeenCalledTimes(1);
    expect(cacheMock.saveSubtitleToCache).toHaveBeenCalledWith(
      expect.stringContaining("boc_subtitle_cache_"),
      [
        { from: 0, to: 1.2, content: "五小时转写成果" },
        { from: 1.5, to: 2.4, content: "第二条" }
      ]
    );

    // 关键断言 3：两次抓取都正常结束（无未捕获异常），字幕进入 content 状态，
    // 完成提示只出现一次（被顶掉的第一抓静默让位，不重复收尾）
    for (const outcome of results) {
      expect(outcome.status).toBe("fulfilled");
    }
    expect(stateMod.state.clip.subtitleFetchState).toBe("ready");
    expect(stateMod.state.clip.subtitleBody.length).toBe(2);
    const { setStatus } = await import("../../extension/ui/ui-renderer.js");
    const doneCount = setStatus.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("语音识别完成")).length;
    expect(doneCount).toBe(1);
  });

  it("转写完成写入缓存后，下一次 refreshClip 缓存命中、不再转写（用户单独抓取不重转）", async () => {
    const pending = stubPendingPipeline();

    const first = fetcher.refreshClip();
    await vi.waitFor(() => expect(pipelineMock.runAsrPipeline).toHaveBeenCalledTimes(1));
    pending[0].resolve([{ from: 0, to: 1.2, content: "完整转写" }]);
    await first;
    expect(cacheMock.saveSubtitleToCache).toHaveBeenCalledTimes(1);

    // 无并发干扰时，下一次抓取应命中缓存（loadSubtitleFromCache 放行后 ready 收尾）
    // 字幕需覆盖视频时长（300s），否则 validateSubtitleByDuration 会清缓存重转
    cacheMock.loadSubtitleFromCache.mockResolvedValue([
      { from: 0, to: 1.2, content: "完整转写" },
      { from: 2, to: 290, content: "收尾句" }
    ]);
    await fetcher.refreshClip();
    expect(pipelineMock.runAsrPipeline).toHaveBeenCalledTimes(1); // 未增加
    const statusCalls = (await import("../../extension/ui/ui-renderer.js")).setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("缓存命中"))).toBe(true);
  });

  it("转写失败：asr-failed 广播发出，落回无字幕状态", async () => {
    const sendSpy = globalThis.chrome.runtime.sendMessage;
    pipelineMock.runAsrPipeline.mockRejectedValue(new Error("音频解码失败"));

    await fetcher.refreshClip();

    const broadcastCalls = sendSpy.mock.calls.map((c) => c[0]).filter((m) => m?.type === "boc-subtitle-status");
    expect(broadcastCalls.some((m) => m.phase === "asr-failed")).toBe(true);
  });

  it("转写进行中辅助抓取失败：不清上下文（fetchState 保持 loading），共享转写完成后正常收尾", async () => {
    const pending = stubPendingPipeline();

    // 第一次抓取开始转写
    const first = fetcher.refreshClip();
    await vi.waitFor(() => expect(pipelineMock.runAsrPipeline).toHaveBeenCalledTimes(1));

    // 第二次抓取（转写中的 popup-refresh）前半段失败——转写期间高频重复
    // 请求 B 站 meta/subtitle API 时常见的限流场景。历史上 resetClipState
    // 会把 fetchState 清成 idle，侧边栏等待轮询误判后提前放行空字幕。
    gatewayMock.fetchVideoMeta.mockRejectedValue(new Error("HTTP 412"));
    const second = fetcher.refreshClip();
    await vi.waitFor(() => {
      const { setStatus } = uiRenderer;
      expect(setStatus.mock.calls.some((c) => String(c[0]).includes("继续等待音频转写"))).toBe(true);
    });

    // 关键断言 1：上下文未被清掉——fetchState 保持 loading、title 保留
    expect(stateMod.state.clip.subtitleFetchState).toBe("loading");
    expect(stateMod.state.clip.title).toBe("t");

    // 转写"完成"：失败的那次抓取跟随共享转写一起收尾
    pending[0].resolve([
      { from: 0, to: 1.2, content: "转写成果" },
      { from: 1.5, to: 290, content: "第二条" }
    ]);
    await second;
    await first.catch(() => {});

    // 关键断言 2：共享转写成果正常进入状态并落缓存
    expect(stateMod.state.clip.subtitleFetchState).toBe("ready");
    expect(stateMod.state.clip.subtitleBody.length).toBe(2);
    expect(cacheMock.saveSubtitleToCache).toHaveBeenCalledTimes(1);
    // 发起者 fetchRunId 已过期，UI 收尾由失败的等待者完成；完成提示只出现一次
    const { setStatus } = uiRenderer;
    const doneCount = setStatus.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("语音识别完成")).length;
    expect(doneCount).toBe(1);
  });
});
