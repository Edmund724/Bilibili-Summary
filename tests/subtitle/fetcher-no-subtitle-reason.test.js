// fetcher.js 无字幕原因（noSubtitleReason）与状态栏文案测试。
//
// 覆盖三块契约：
//   - buildNoSubtitleStatusMessage：按 clipState.noSubtitleReason 出文案——
//     no-asr-config 引导"免费申请硅基流动 API Key 并填入设置页"；其余原因
//     （asr-disabled / asr-failed / asr-empty / null 未知）维持通用引导句；
//     显式 base / reason 参数仍生效。
//   - resetClipState：无字幕原因清 null（切视频/失败清上下文不留陈旧原因）。
//   - loadSubtitle 两条 ready 路径（缓存命中 / 网络成功）：ready 收尾清 null。
// mock 结构与 fetcher-logging.test.js 相同：重依赖 mock，state/selection/
// validators 等轻量模块真实加载。
// 注意：本文件全程单一模块纪元（beforeEach 不做 vi.resetModules，只清环境），
// 保证测试断言的 clipState 与 fetcher.js（vi.mock 的 importOriginal 副本）
// 闭包内的是同一实例——resetModules 会让两者分属不同纪元、状态断言全部落空。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, setupEnvironment } from "../setup.js";
import { clipState } from "../../extension/core/state.js";

// 顶层副作用 subscribeSubtitleRefresh(refreshClip) 需要 presenter 提供该函数。
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
vi.mock("../../extension/subtitle/fetcher.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchVideoMeta: vi.fn(),
    fetchSubtitleBundle: vi.fn()
  };
});
vi.mock("../../extension/bilibili/gateway.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
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
vi.mock("../../extension/subtitle/cache.js", () => ({
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
  saveSubtitleToCache: vi.fn(async () => {}),
  loadSubtitleFromCache: vi.fn(async () => null),
  getSubtitleCacheKey: vi.fn(() => "boc_subtitle_cache_test")
}));

// 被测对象（mocked fetcher 命名空间展开自 actual，resetClipState/loadSubtitle/
// buildNoSubtitleStatusMessage 均为真实实现）与被 mock 的 gateway.fetchSubtitleBody
import * as fetcher from "../../extension/subtitle/fetcher.js";
import { fetchSubtitleBody as fetchBodyMock } from "../../extension/bilibili/gateway.js";
import { loadSubtitleFromCache } from "../../extension/subtitle/cache.js";

// 时长合规字幕体：videoDuration=300 时 minCoverageRatio=0.22，maxTo=290 ≥ 66
const SUBTITLE_BODY = [
  { from: 0, to: 1.2, content: "你好" },
  { from: 1.5, to: 2.4, content: "世界" },
  { from: 3, to: 290, content: "收尾长句" }
];

beforeEach(() => {
  // 单一模块纪元：只重置环境与 DOM，不 resetModules（理由见文件头注释）
  setupEnvironment();
  history.replaceState({}, "", NORMAL_PAGE_URL);
  document.body.innerHTML = "";
  // resetClipState（真实代码）通过 byId("boc-preview") 写空值，需该 DOM 节点
  const preview = document.createElement("textarea");
  preview.id = "boc-preview";
  document.body.appendChild(preview);

  clipState.setBvid("BV1test000000");
  clipState.setCid("101");
  clipState.setVideoDuration(300);
  clipState.setFetchRunId(0);

  // 单一纪元下 mock 实现会跨用例保留：显式归位，避免用例间相互污染
  loadSubtitleFromCache.mockReset();
  loadSubtitleFromCache.mockResolvedValue(null);
  fetchBodyMock.mockReset();
});

describe("buildNoSubtitleStatusMessage 按 reason 出文案", () => {
  it("no-asr-config：引导免费申请硅基流动 API Key 并填入设置页", () => {
    clipState.setNoSubtitleReason("no-asr-config");
    expect(fetcher.buildNoSubtitleStatusMessage()).toBe(
      "当前视频无字幕。 可免费申请硅基流动 API Key 并填入设置页，自动生成字幕。"
    );
  });

  it("其余原因与未知（asr-disabled/asr-failed/asr-empty/null）：维持通用引导句", () => {
    for (const reason of ["asr-disabled", "asr-failed", "asr-empty", null]) {
      clipState.setNoSubtitleReason(reason);
      expect(fetcher.buildNoSubtitleStatusMessage()).toBe(
        "当前视频无字幕。 可在设置页配置语音识别平台自动生成字幕。"
      );
    }
  });

  it("显式 base 参数仍生效（reason 默认读 clipState）", () => {
    clipState.setNoSubtitleReason("no-asr-config");
    expect(fetcher.buildNoSubtitleStatusMessage("这个视频没有字幕。")).toBe(
      "这个视频没有字幕。 可免费申请硅基流动 API Key 并填入设置页，自动生成字幕。"
    );
    // 显式 reason 覆盖 clipState
    expect(fetcher.buildNoSubtitleStatusMessage("当前视频无字幕。", "asr-empty")).toBe(
      "当前视频无字幕。 可在设置页配置语音识别平台自动生成字幕。"
    );
  });
});

describe("noSubtitleReason 清除点", () => {
  it("resetClipState：陈旧原因清 null", () => {
    clipState.setSubtitleFetchState("empty");
    clipState.setNoSubtitleReason("asr-empty");
    expect(clipState.noSubtitleReason).toBe("asr-empty");

    fetcher.resetClipState();

    expect(clipState.noSubtitleReason).toBe(null);
    expect(clipState.subtitleFetchState).toBe("idle");
  });

  it("loadSubtitle 缓存命中 ready：陈旧原因清 null", async () => {
    clipState.setNoSubtitleReason("no-asr-config");
    loadSubtitleFromCache.mockResolvedValue(SUBTITLE_BODY);

    await fetcher.loadSubtitle("https://example.com/sub.json", "中文", 0, "track-1", false);

    expect(clipState.subtitleFetchState).toBe("ready");
    expect(clipState.subtitleBody).toEqual(SUBTITLE_BODY);
    expect(clipState.noSubtitleReason).toBe(null);
    // 缓存命中不发网络请求
    expect(fetchBodyMock).not.toHaveBeenCalled();
  });

  it("loadSubtitle 网络成功 ready：陈旧原因清 null", async () => {
    clipState.setNoSubtitleReason("asr-failed");
    fetchBodyMock.mockResolvedValue({ body: SUBTITLE_BODY });

    await fetcher.loadSubtitle("https://example.com/sub.json", "中文", 0, "track-1", true);

    expect(clipState.subtitleFetchState).toBe("ready");
    expect(clipState.subtitleBody).toEqual(SUBTITLE_BODY);
    expect(clipState.noSubtitleReason).toBe(null);
    expect(fetchBodyMock).toHaveBeenCalledWith("https://example.com/sub.json");
  });
});
