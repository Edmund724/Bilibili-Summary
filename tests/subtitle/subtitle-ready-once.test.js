// 字幕就绪通知「全程恰一次」链级防回焊锁（#3 subtitle-ready 单点收口）。
//
// refreshClip 全程（网络新抓 → loadSubtitle → 字幕接受事务）只允许 emit 一次
// "subtitle-ready"：事务内（commit.acceptSubtitle）是唯一 emit 点，fetcher 编排
// 层历史上补发过一次，导致同一事件触发两遍全套渲染（renderReadingView +
// startReadingViewSync + 概览触发）。本锁与 commit.test.js（事务侧单发）、
// presenter-forward.test.ts（转发形状）互补：链上任何一处补发都会在此变红；
// 事务侧若被摘除通知则 commit.test.js 变红。
//
// 依赖处理走 fetcher-retry.test.js 同款 vi.mock：网络边界（gateway）、页面
// 上下文、派生内容刷新（subtitle/core）、缓存落盘口（cache）全部 mock，
// commit / reader-bus / state / selection 保持真实——reader-bus 的
// notifyReaderPresenter 用 importOriginal 包 vi.fn 计数，语义不变。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";

vi.mock("../../extension/bilibili/gateway.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchVideoMeta: vi.fn(),
    fetchSubtitleBundle: vi.fn(),
    fetchSubtitleBody: vi.fn(),
    readRuntimeVideoDuration: vi.fn(() => 300),
    contentFetchJson: vi.fn()
  };
});
vi.mock("../../extension/reader/page-context.js", () => ({
  resolvePageContext: vi.fn(() => ({ pageIndex: 1, cid: "101", cidSource: "test", pageTitle: "P1", duration: 300 }))
}));
vi.mock("../../extension/subtitle/core.js", () => ({
  readVideoTitle: vi.fn(() => ""),
  readVideoAuthor: vi.fn(() => ""),
  readUploadDate: vi.fn(() => ""),
  readVideoDescription: vi.fn(() => ""),
  refreshDerivedContent: vi.fn(async () => {})
}));
vi.mock("../../extension/subtitle/cache.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    saveSubtitleToCache: vi.fn(async () => ({ ok: true })),
    loadSubtitleFromCache: vi.fn(async () => null),
    clearSubtitleCacheByKey: vi.fn(async () => {}),
    clearStaleAsrSubtitleCache: vi.fn(async () => {})
  };
});
vi.mock("../../extension/core/runtime.js", () => ({
  getSettings: vi.fn(async () => ({}))
}));
vi.mock("../../extension/shared/messaging.js", () => ({
  sendRuntimeMessage: vi.fn(async () => null)
}));
vi.mock("../../extension/reader/reader-bus.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    notifyReaderPresenter: vi.fn(actual.notifyReaderPresenter)
  };
});

describe("字幕就绪通知全程恰一次（链级防回焊锁）", () => {
  let fetcher;
  let state;
  let notifyReaderPresenter;

  beforeEach(async () => {
    resetModuleState();
    setLocationUrl(READER_MODE_URL);
    const gateway = await import("../../extension/bilibili/gateway.js");
    gateway.fetchVideoMeta.mockResolvedValue({
      aid: "aid1",
      title: "测试视频",
      author: "UP",
      uploadDate: "2026-01-01",
      description: "",
      pages: [{}],
      defaultCid: "101"
    });
    gateway.fetchSubtitleBundle.mockResolvedValue({
      tracks: [{ id: "s1", lan: "zh-CN", lanDoc: "中文（自动）", subtitleUrl: "https://fake.subtitle/url.json" }],
      chapters: []
    });
    gateway.fetchSubtitleBody.mockResolvedValue({
      body: [
        { from: 0, to: 140, content: "大家好" },
        { from: 140, to: 280, content: "开始今天的话题" }
      ]
    });
    const bus = await import("../../extension/reader/reader-bus.js");
    notifyReaderPresenter = bus.notifyReaderPresenter;
    notifyReaderPresenter.mockClear();
    state = (await import("../../extension/core/state.js")).state;
    state.reader.setViewOpen(true);
    fetcher = await import("../../extension/subtitle/fetcher.js");
  });

  it("refreshClip 网络新抓全程只 emit 一次 subtitle-ready", async () => {
    await fetcher.refreshClip();

    const readyCalls = notifyReaderPresenter.mock.calls.filter((call) => call[0] === "subtitle-ready");
    expect(readyCalls).toHaveLength(1);
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toHaveLength(2);
  });
});
