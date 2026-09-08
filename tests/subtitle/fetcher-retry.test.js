// subtitle/fetcher.ts retryWithFreshBundle 重试链测试（arch-slim-2/05 测试网，
// 此前全仓零覆盖）。
//
// retryWithFreshBundle 未导出，生产路径只有 refreshClip 的 catch 一个入口：
// 候选加载失败且「message 含 HTTP 或 code=SUBTITLE_DURATION_MISMATCH」（签名
// URL 快速过期 / 限流特征）时触发——重抓 bundle → 重建轨道/章节 → 按原偏好
// （previousId/URL/lang）重选轨 → 重试一次；重试仍败或新 bundle 无合适轨时把
// 触发重试的原始错误上抛，交 refreshClip 错误路径收尾。
//
// 依赖处理走 digest-button-click.test.js 同款 vi.mock（重依赖 mock 掉，轻依赖
// state/selection/error-helpers 保持真实）：gateway 四个抓取口、page-context、
// cache、commit 事务、ASR 域（错误路径 loadAsrFallback 会动态 import）全部
// mock；ASR 实例固定「无活动转写」，让错误路径干净落到 reset+error 收尾。
// 每个用例在 beforeEach 内重取 fetcher 与 state（同纪元实例），共享的 mock
// 实例手工 mockReset（resetModules 后 mock 工厂不重跑，见 fetcher-logging.test.js）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

vi.mock("../../extension/reader/reader-bus.js", () => ({
  subscribeSubtitleRefresh: vi.fn(),
  notifyReaderPresenter: vi.fn()
}));
vi.mock("../../extension/shared/ui-status.js", () => ({
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
  readVideoDescription: vi.fn(() => ""),
  refreshDerivedContent: vi.fn(async () => {})
}));
vi.mock("../../extension/subtitle/cache.js", async (importOriginal) => {
  // importOriginal 保留 normalizeSubtitleUrlForCache（selection.pickPreferredSubtitle
  // 按路径比对上一轨 URL 时消费），其余落盘/读缓存口按用例需要 mock。
  const actual = await importOriginal();
  return {
    ...actual,
    buildSubtitleCandidates: vi.fn((tracks, preferred) => {
      const list = [preferred];
      for (const item of tracks || []) {
        if (item !== preferred) {
          list.push(item);
        }
      }
      return list;
    }),
    clearSubtitleCacheByKey: vi.fn(async () => {}),
    clearStaleAsrSubtitleCache: vi.fn(async () => {}),
    saveSubtitleToCache: vi.fn(async () => ({ ok: true })),
    loadSubtitleFromCache: vi.fn(async () => null),
    getSubtitleCacheKey: vi.fn(() => "boc_subtitle_cache_test")
  };
});
vi.mock("../../extension/subtitle/commit.js", () => ({
  configureCommitUi: vi.fn(),
  acceptSubtitle: vi.fn(async () => {}),
  commitNoSubtitle: vi.fn(async () => {})
}));
// 错误路径 loadAsrFallback 的动态 import 域：固定「无活动转写」，避免拖入真实
// ASR 域（pipeline/fallback 及其 offscreen 闭包）——重试链用例不关心 ASR 回退。
vi.mock("../../extension/asr/pipeline.js", () => ({
  runAsrPipeline: vi.fn()
}));
vi.mock("../../extension/asr/fallback.js", () => ({
  createAsrFallback: vi.fn(() => ({
    hasActiveAsrTranscribe: vi.fn(() => false),
    maybeRunAsrFallback: vi.fn(async () => "skip"),
    awaitActiveAsrTranscribe: vi.fn(async () => {})
  }))
}));

const oldTrack = { id: "sub-1", lan: "zh-CN", lanDoc: "中文", subtitleUrl: "https://i0.hdslb.com/sub-old.json" };
const freshTrack = { id: "sub-1", lan: "zh-CN", lanDoc: "中文", subtitleUrl: "https://i0.hdslb.com/sub-fresh.json?auth_key=new" };
const goodBody = [{ from: 0, to: 200, content: "hello" }];

let fetcher;
let state;
let gateway;
let uiStatus;
let commit;
let readerBus;

async function importEpoch() {
  fetcher = await import("../../extension/subtitle/fetcher.js");
  state = (await import("../../extension/core/state.js")).state;
  gateway = await import("../../extension/bilibili/gateway.js");
  uiStatus = await import("../../extension/shared/ui-status.js");
  commit = await import("../../extension/subtitle/commit.js");
  readerBus = await import("../../extension/reader/reader-bus.js");

  gateway.fetchVideoMeta.mockReset();
  gateway.fetchSubtitleBundle.mockReset();
  gateway.fetchSubtitleBody.mockReset();
  gateway.readRuntimeVideoDuration.mockReset().mockReturnValue(300);
  commit.acceptSubtitle.mockReset().mockResolvedValue(undefined);
  commit.commitNoSubtitle.mockReset().mockResolvedValue(undefined);
  uiStatus.setStatus.mockReset();
  uiStatus.setMessage.mockReset();
  readerBus.notifyReaderPresenter.mockReset();

  // meta 抓取成功（refreshClip 前置段），时长由 page-context 落 300
  gateway.fetchVideoMeta.mockResolvedValue({
    aid: "123",
    title: "测试标题",
    author: "测试作者",
    description: "测试简介",
    defaultCid: "101",
    defaultDuration: 300,
    pages: [{ cid: "101", page: 1, part: "P1", duration: 300 }]
  });
}

beforeEach(async () => {
  resetModuleState();
  await importEpoch();
});

describe("retryWithFreshBundle：签名 URL 失效重试链（经 refreshClip 驱动）", () => {
  it("HTTP 403 触发：重取 bundle → 按原偏好重选同 id 轨 → 用新签名 URL 重试一次后成功", async () => {
    gateway.fetchSubtitleBundle
      .mockResolvedValueOnce({ tracks: [oldTrack], chapters: [] })
      .mockResolvedValueOnce({ tracks: [freshTrack], chapters: [] });
    gateway.fetchSubtitleBody
      .mockRejectedValueOnce(new Error("HTTP 403"))
      .mockResolvedValueOnce({ body: goodBody });

    await expect(fetcher.refreshClip()).resolves.toBeUndefined();

    // 重试链恰好各跑两次：初始抓取 + 重抓 bundle / 初始加载 + 重试加载
    expect(gateway.fetchSubtitleBundle).toHaveBeenCalledTimes(2);
    expect(gateway.fetchSubtitleBody).toHaveBeenCalledTimes(2);
    // 重抓 bundle 复用同一 bvid/cid/aid 上下文
    expect(gateway.fetchSubtitleBundle).toHaveBeenLastCalledWith(
      gateway.contentFetchJson,
      expect.objectContaining({ bvid: "BV1test000000", cid: "101", aid: "123" })
    );
    // 第二次加载用的是新 bundle 里的签名 URL（旧 URL 失效）
    expect(gateway.fetchSubtitleBody.mock.calls[0][0]).toBe(oldTrack.subtitleUrl);
    expect(gateway.fetchSubtitleBody.mock.calls[1][0]).toBe(freshTrack.subtitleUrl);
    // 字幕接受事务只落一次，选中轨即重选后的同 id 轨 + 新 URL
    expect(commit.acceptSubtitle).toHaveBeenCalledTimes(1);
    expect(commit.acceptSubtitle).toHaveBeenCalledWith(
      expect.objectContaining({
        body: goodBody,
        selectedSubtitleId: "sub-1",
        selectedSubtitleUrl: freshTrack.subtitleUrl,
        selectedSubtitleLang: "中文"
      })
    );
    // 成功收尾（fetchState/selectedUrl 由字幕接受事务落位，本文件 mock 了事务，
    // 终态断言只看状态栏文案与事务入参）。完成提示走 reader-bus "status" 通知
    //（与渲染同通道），不再直写 setStatus。
    expect(readerBus.notifyReaderPresenter).toHaveBeenLastCalledWith(
      "status",
      "抓取完成，可以复制或下载字幕。"
    );
  });

  it("SUBTITLE_DURATION_MISMATCH 触发：时长不匹配的 body 落到重试，新 bundle 重载成功", async () => {
    gateway.fetchSubtitleBundle
      .mockResolvedValueOnce({ tracks: [oldTrack], chapters: [] })
      .mockResolvedValueOnce({ tracks: [freshTrack], chapters: [] });
    // 首次 body 覆盖 10s ≪ 300s×0.22 → too-short（SUBTITLE_DURATION_MISMATCH）
    gateway.fetchSubtitleBody
      .mockResolvedValueOnce({ body: [{ from: 0, to: 10, content: "short" }] })
      .mockResolvedValueOnce({ body: goodBody });

    await expect(fetcher.refreshClip()).resolves.toBeUndefined();

    expect(gateway.fetchSubtitleBundle).toHaveBeenCalledTimes(2);
    expect(gateway.fetchSubtitleBody).toHaveBeenCalledTimes(2);
    expect(commit.acceptSubtitle).toHaveBeenCalledTimes(1);
    expect(readerBus.notifyReaderPresenter).toHaveBeenLastCalledWith(
      "status",
      "抓取完成，可以复制或下载字幕。"
    );
  });

  it("重试仍失败：只重试一次，原始错误上抛并由 refreshClip 错误路径收尾", async () => {
    gateway.fetchSubtitleBundle.mockResolvedValue({ tracks: [oldTrack], chapters: [] });
    gateway.fetchSubtitleBody.mockRejectedValue(new Error("HTTP 403"));

    await expect(fetcher.refreshClip()).resolves.toBeUndefined();

    // 恰好一次重试：bundle 两抓、body 两载，不无限循环
    expect(gateway.fetchSubtitleBundle).toHaveBeenCalledTimes(2);
    expect(gateway.fetchSubtitleBody).toHaveBeenCalledTimes(2);
    // 原始错误（HTTP 403）上抛后的统一收尾：reset(keepFetchState) + error + 文案
    expect(uiStatus.setStatus).toHaveBeenLastCalledWith("抓取失败：HTTP 403");
    expect(state.clip.subtitleFetchState).toBe("error");
    expect(state.clip.noSubtitleReason).toBe(null);
  });

  it("重抓 bundle 无任何轨道：无合适轨，抛触发重试的原始错误，不再尝试加载 body", async () => {
    gateway.fetchSubtitleBundle
      .mockResolvedValueOnce({ tracks: [oldTrack], chapters: [] })
      .mockResolvedValueOnce({ tracks: [], chapters: [] });
    gateway.fetchSubtitleBody.mockRejectedValue(new Error("HTTP 403"));

    await expect(fetcher.refreshClip()).resolves.toBeUndefined();

    expect(gateway.fetchSubtitleBundle).toHaveBeenCalledTimes(2);
    expect(gateway.fetchSubtitleBody).toHaveBeenCalledTimes(1);
    expect(uiStatus.setStatus).toHaveBeenLastCalledWith("抓取失败：HTTP 403");
    expect(state.clip.subtitleFetchState).toBe("error");
  });

  it("非重试类错误（无 HTTP 特征）不走重试链：bundle 只抓一次直接进错误路径", async () => {
    gateway.fetchSubtitleBundle.mockResolvedValue({ tracks: [oldTrack], chapters: [] });
    gateway.fetchSubtitleBody.mockRejectedValue(new Error("字幕文件为空。"));

    await expect(fetcher.refreshClip()).resolves.toBeUndefined();

    expect(gateway.fetchSubtitleBundle).toHaveBeenCalledTimes(1);
    expect(gateway.fetchSubtitleBody).toHaveBeenCalledTimes(1);
    expect(uiStatus.setStatus).toHaveBeenLastCalledWith("抓取失败：字幕文件为空。");
    expect(state.clip.subtitleFetchState).toBe("error");
  });
});
