// fetcher.js 的 ASR 回退接入回归测试。
// 镜像 fetcher-logging.test.js 的 mock 结构：chrome stub（setup.js）、模块级
// vi.mock 掉 fetcher 的重依赖（presenter / ui-renderer / gateway / core / ui /
// cache / asr 各模块），保留 state / error-helpers / selection 等轻量真实模块。
// 重点断言：skip 分支返回 "skip" 且文案带引导句；有字幕轨不触发回退（不发
// playurl）；空结果/失败落到 applyNoSubtitleState；缓存命中不发 playurl 不下载。

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
// 注意：fetcher.js 不做 vi.mock，保持真实加载（refreshClip 内部调用的
// fetchVideoMeta/fetchSubtitleBundle 是本地函数，转发到 gateway mock）。
vi.mock("../../extension/bilibili/gateway.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // fetcher.js 的 fetchVideoMeta/fetchSubtitleBundle 本地函数内部转发到
    // gateway 的对应实现；mock 这里即可贯穿 refreshClip 主流程。
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
  // applyNoSubtitleState 为 mock 空实现；其"落回无字幕状态"的副作用（清空
  // subtitleBody / 置 empty）在空结果用例里改为断言 subtitleBody 为空 +
  // setStatus 文案，不依赖真实副作用。
  applyNoSubtitleState: vi.fn(),
  readVideoDescription: vi.fn(() => "")
}));
vi.mock("../../extension/subtitle/cache.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // selection.js 真实加载依赖 normalizeSubtitleUrlForCache（纯函数），保留真实实现
    buildSubtitleCandidates: vi.fn((tracks, preferred) => [preferred, ...(tracks || []).filter((t) => t !== preferred)]),
    clearSubtitleCacheByKey: vi.fn(async () => {}),
    saveSubtitleToCache: vi.fn(async () => {}),
    loadSubtitleFromCache: vi.fn(async () => null),
    getSubtitleCacheKey: vi.fn(({ subtitleId }) => `boc_subtitle_cache_${subtitleId || "x"}`)
  };
});
// ASR 依赖 mock：provider store / pipeline / audio-source / offscreen-bridge
vi.mock("../../extension/asr/asr-provider-store.js", () => ({
  loadAsrProviders: vi.fn(async () => []),
  getAsrProviderKey: vi.fn(async () => "")
}));
vi.mock("../../extension/asr/pipeline.js", () => ({
  runAsrPipeline: vi.fn(async () => [])
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
let asrStoreMock;
let pipelineMock;
let audioSourceMock;
let offscreenBridgeMock;
let uiMock;
let uiRendererMock;
let stateMod;

beforeEach(async () => {
  resetModuleState();
  fetcher = await import("../../extension/subtitle/fetcher.js");
  gatewayMock = await import("../../extension/bilibili/gateway.js");
  cacheMock = await import("../../extension/subtitle/cache.js");
  asrStoreMock = await import("../../extension/asr/asr-provider-store.js");
  pipelineMock = await import("../../extension/asr/pipeline.js");
  audioSourceMock = await import("../../extension/asr/audio-source.js");
  offscreenBridgeMock = await import("../../extension/asr/offscreen-bridge.js");
  uiMock = await import("../../extension/subtitle/ui.js");
  uiRendererMock = await import("../../extension/ui/ui-renderer.js");
  stateMod = await import("../../extension/core/state.js");

  for (const m of [gatewayMock, cacheMock, asrStoreMock, pipelineMock, audioSourceMock, offscreenBridgeMock, uiMock, uiRendererMock]) {
    for (const key of Object.keys(m)) {
      if (typeof m[key] === "function" && m[key].mockReset) {
        m[key].mockReset();
      }
    }
  }
  // 默认：无字幕 + ASR 未配置（skip 分支）
  asrStoreMock.loadAsrProviders.mockResolvedValue([]);
  asrStoreMock.getAsrProviderKey.mockResolvedValue("");
  pipelineMock.runAsrPipeline.mockResolvedValue([]);
  offscreenBridgeMock.createOffscreenChunkHost.mockImplementation(() => async () => []);
  cacheMock.loadSubtitleFromCache.mockResolvedValue(null);

  // 默认 settings：getSettings 走 chrome.runtime.sendMessage("get-settings")，
  // 这里 mock sendMessage 对 get-settings 返回自定义设置（其余消息保持默认 ok:true）
  const syncSettings = {
    asrAutoFallback: true,
    activeAsrProviderId: "p1",
    asrChunkMinutes: 3
  };
  globalThis.__syncSettings = syncSettings;
  globalThis.chrome.runtime.sendMessage.mockImplementation((message, callback) => {
    if (message?.type === "get-settings") {
      callback?.({ ok: true, settings: syncSettings });
      return undefined;
    }
    callback?.({ ok: true });
    return undefined;
  });
  stateMod.state.settings = {
    ...stateMod.state.settings,
    asrAutoFallback: true,
    activeAsrProviderId: "p1"
  };
});

// 走 refreshClip 的无字幕出口：给 DOM 补 preview 节点（applyNoSubtitleState
// 用 byId 写空值），gateway mock 返回空字幕轨。
async function runRefreshClipWithNoSubtitles() {
  const preview = document.createElement("textarea");
  preview.id = "boc-preview";
  document.body.appendChild(preview);
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
  await fetcher.refreshClip();
}

// 更新 get-settings 返回的设置（fetcher 的 getSettings 读 chrome.runtime.sendMessage）
function setSyncSettings(patch) {
  const settings = { ...globalThis.__syncSettings, ...patch };
  globalThis.__syncSettings = settings;
  globalThis.chrome.runtime.sendMessage.mockImplementation((message, callback) => {
    if (message?.type === "get-settings") {
      callback?.({ ok: true, settings });
      return undefined;
    }
    callback?.({ ok: true });
    return undefined;
  });
}

describe("maybeRunAsrFallback skip 分支", () => {
  it("开关关闭：返回 skip，applyNoSubtitleState 仍走到，提示含引导句", async () => {
    setSyncSettings({ asrAutoFallback: false });
    await runRefreshClipWithNoSubtitles();

    expect(pipelineMock.runAsrPipeline).not.toHaveBeenCalled();
    expect(uiMock.applyNoSubtitleState).toHaveBeenCalled();
    // 无字幕出口的 setStatus 文案带引导句
    const statusCalls = uiRendererMock.setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("可在设置页配置语音识别平台自动生成字幕"))).toBe(true);
    // 未发起 playurl（audio-source 未调用）
    expect(audioSourceMock.getSourceAudioUrl).not.toHaveBeenCalled();
  });

  it("无激活平台：返回 skip 且提示含引导句", async () => {
    setSyncSettings({ activeAsrProviderId: "" });
    await runRefreshClipWithNoSubtitles();

    expect(pipelineMock.runAsrPipeline).not.toHaveBeenCalled();
    expect(uiMock.applyNoSubtitleState).toHaveBeenCalled();
    const statusCalls = uiRendererMock.setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("可在设置页配置语音识别平台自动生成字幕"))).toBe(true);
  });

  it("激活平台 id 不在已配置列表中：返回 skip", async () => {
    asrStoreMock.loadAsrProviders.mockResolvedValue([{ id: "other", type: "openai-transcriptions", name: "其他" }]);
    await runRefreshClipWithNoSubtitles();

    expect(pipelineMock.runAsrPipeline).not.toHaveBeenCalled();
    expect(uiMock.applyNoSubtitleState).toHaveBeenCalled();
  });
});

describe("maybeRunAsrFallback 成功与缓存", () => {
  it("配置齐全：管线产出字幕 → 塞伪轨道 + ready + 写缓存 + 完成提示", async () => {
    asrStoreMock.loadAsrProviders.mockResolvedValue([
      { id: "p1", type: "openai-transcriptions", name: "本地 Whisper", model: "whisper-large-v3", supportsTimestamps: true }
    ]);
    asrStoreMock.getAsrProviderKey.mockResolvedValue("sk-local");
    pipelineMock.runAsrPipeline.mockResolvedValue([
      { from: 0, to: 1.2, content: "你好" },
      { from: 1.5, to: 2.4, content: "世界" }
    ]);

    await runRefreshClipWithNoSubtitles();

    expect(pipelineMock.runAsrPipeline).toHaveBeenCalledTimes(1);

    expect(stateMod.state.clip.subtitleFetchState).toBe("ready");
    expect(stateMod.state.clip.subtitleBody).toEqual([
      { from: 0, to: 1.2, content: "你好" },
      { from: 1.5, to: 2.4, content: "世界" }
    ]);
    // 伪轨道
    expect(stateMod.state.clip.subtitles.some((t) => t.id === "asr" && t.lan === "asr-zh")).toBe(true);
    expect(cacheMock.saveSubtitleToCache).toHaveBeenCalled();
    const statusCalls = uiRendererMock.setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("语音识别完成"))).toBe(true);
    expect(audioSourceMock.getSourceAudioUrl).not.toHaveBeenCalled();
  });

  it("缓存命中：不发 playurl、不下载、不转写，直接 ready 收尾", async () => {
    asrStoreMock.loadAsrProviders.mockResolvedValue([
      { id: "p1", type: "openai-transcriptions", name: "本地 Whisper", model: "whisper-large-v3", supportsTimestamps: true }
    ]);
    cacheMock.loadSubtitleFromCache.mockResolvedValue([
      { from: 0, to: 1, content: "缓存句" },
      { from: 2, to: 290, content: "足够长的缓存字幕" }
    ]);

    await runRefreshClipWithNoSubtitles();

    expect(pipelineMock.runAsrPipeline).not.toHaveBeenCalled();
    expect(audioSourceMock.getSourceAudioUrl).not.toHaveBeenCalled();
    expect(offscreenBridgeMock.createOffscreenChunkHost).not.toHaveBeenCalled();
    expect(stateMod.state.clip.subtitleFetchState).toBe("ready");
    expect(stateMod.state.clip.subtitleBody).toEqual([
      { from: 0, to: 1, content: "缓存句" },
      { from: 2, to: 290, content: "足够长的缓存字幕" }
    ]);
    expect(cacheMock.saveSubtitleToCache).not.toHaveBeenCalled();
    const statusCalls = uiRendererMock.setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("缓存命中"))).toBe(true);
  });
});

describe("maybeRunAsrFallback 空结果与失败", () => {
  it("空结果：文案「未识别到语音内容」出现，落回无字幕状态", async () => {
    asrStoreMock.loadAsrProviders.mockResolvedValue([
      { id: "p1", type: "openai-transcriptions", name: "本地 Whisper", model: "whisper-large-v3" }
    ]);
    pipelineMock.runAsrPipeline.mockResolvedValue([]);

    await runRefreshClipWithNoSubtitles();

    const statusCalls = uiRendererMock.setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("未识别到语音内容"))).toBe(true);
    // 空结果落回无字幕状态：调用点执行 applyNoSubtitleState（mock 空实现），
    // 断言其被调用 + subtitleBody 未写入
    expect(uiMock.applyNoSubtitleState).toHaveBeenCalled();
    expect(stateMod.state.clip.subtitleBody).toEqual([]);
  });

  it("管线失败：错误文案进状态，不崩，applyNoSubtitleState 被调用", async () => {
    asrStoreMock.loadAsrProviders.mockResolvedValue([
      { id: "p1", type: "openai-transcriptions", name: "本地 Whisper", model: "whisper-large-v3" }
    ]);
    pipelineMock.runAsrPipeline.mockRejectedValue(new Error("音频解码失败"));

    await runRefreshClipWithNoSubtitles();

    const statusCalls = uiRendererMock.setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("语音识别失败"))).toBe(true);
    expect(uiMock.applyNoSubtitleState).toHaveBeenCalled();
  });
});

describe("有字幕轨不触发回退", () => {
  it("有字幕轨：全程不调 runAsrPipeline、不发 playurl", async () => {
    // 走正常字幕路径：fetchSubtitleBundle 返回带 URL 的轨道
    gatewayMock.fetchSubtitleBundle.mockResolvedValue({
      tracks: [{ id: "1", lan: "zh-CN", lanDoc: "中文", subtitleUrl: "https://sub.example/a.json" }],
      chapters: []
    });
    gatewayMock.fetchSubtitleBody.mockResolvedValue({
      body: [
        { from: 0, to: 5, content: "正常字幕" },
        { from: 6, to: 290, content: "足够长的字幕内容" }
      ]
    });

    const preview = document.createElement("textarea");
    preview.id = "boc-preview";
    document.body.appendChild(preview);
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

    await fetcher.refreshClip();

    expect(pipelineMock.runAsrPipeline).not.toHaveBeenCalled();
    expect(audioSourceMock.getSourceAudioUrl).not.toHaveBeenCalled();
    expect(offscreenBridgeMock.createOffscreenChunkHost).not.toHaveBeenCalled();
    expect(stateMod.state.clip.subtitleFetchState).toBe("ready");
    expect(stateMod.state.clip.subtitleBody).toEqual([
      { from: 0, to: 5, content: "正常字幕" },
      { from: 6, to: 290, content: "足够长的字幕内容" }
    ]);
  });
});
