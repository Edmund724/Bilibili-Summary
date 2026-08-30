// fetcher.js 无字幕原因（noSubtitleReason）与状态栏文案测试。
//
// 覆盖三块契约：
//   - resetClipState：无字幕原因清 null（切视频/失败清上下文不留陈旧原因）；
//     keepFetchState 参数保留当前 fetchState（586c61b 纪律：错误路径不得把
//     状态洗回 idle，见 refreshClip catch 与 sidepanel-subtitle-wait.js）。
//   - loadSubtitle 两条 ready 路径（缓存命中 / 网络成功）：ready 收尾清 null，
//     且两条路径都经字幕接受事务（commit.acceptSubtitle，vi.fn 包装真实实现
//     可观察调用）；缓存命中喂乱序 body，锁「接受事务单点稳定排序」。
//   - buildNoSubtitleStatusMessage 的文案契约已随事务迁入
//     tests/subtitle/commit.test.js（文案属无字幕出口事务的一部分）。
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
// 字幕接受事务：fetcher 静态引用的真实实现用 vi.fn 包一层（真实落 state +
// 可观察调用），保持「调用了 commit」可断言。configureCommitUi 保持真实导出
//（fetcher 模块求值期接线用）。
vi.mock("../../extension/subtitle/commit.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    acceptSubtitle: vi.fn(actual.acceptSubtitle),
    commitNoSubtitle: vi.fn(actual.commitNoSubtitle)
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
// 候选02 分层惰性：renderMeta/renderSubtitleSelect/setBusyState 已自
// ui/ui-renderer.js 移入 subtitle/ui.js，fetcher 的 import 随之指向本模块，
// mock 需补齐这三个导出。（applyNoSubtitleState 已迁入 subtitle/commit.js，
// 不再是 ui.js 的导出。）
vi.mock("../../extension/subtitle/ui.js", () => ({
  readVideoDescription: vi.fn(() => ""),
  renderMeta: vi.fn(),
  renderSubtitleSelect: vi.fn(),
  setBusyState: vi.fn()
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

// 被测对象（mocked fetcher 命名空间展开自 actual，resetClipState/loadSubtitle
// 均为真实实现）与被 mock 的 gateway.fetchSubtitleBody、commit.acceptSubtitle
import * as fetcher from "../../extension/subtitle/fetcher.js";
import { fetchSubtitleBody as fetchBodyMock } from "../../extension/bilibili/gateway.js";
import {
  loadSubtitleFromCache,
  saveSubtitleToCache,
  clearSubtitleCacheByKey
} from "../../extension/subtitle/cache.js";
import { setMessage } from "../../extension/ui/ui-renderer.js";
import { acceptSubtitle } from "../../extension/subtitle/commit.js";

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
  saveSubtitleToCache.mockReset();
  saveSubtitleToCache.mockResolvedValue(undefined);
  clearSubtitleCacheByKey.mockReset();
  clearSubtitleCacheByKey.mockResolvedValue(undefined);
  setMessage.mockClear();
  acceptSubtitle.mockClear();
});

// buildNoSubtitleStatusMessage 的文案契约已随无字幕出口事务迁至
// tests/subtitle/commit.test.js（fetcher 不再导出该函数）。

describe("noSubtitleReason 清除点", () => {
  it("resetClipState：陈旧原因清 null", () => {
    clipState.setSubtitleFetchState("empty");
    clipState.setNoSubtitleReason("asr-empty");
    expect(clipState.noSubtitleReason).toBe("asr-empty");

    fetcher.resetClipState();

    expect(clipState.noSubtitleReason).toBe(null);
    expect(clipState.subtitleFetchState).toBe("idle");
  });

  it("resetClipState({ keepFetchState: true })：保留当前 fetchState（586c61b：错误路径不得洗回 idle）", () => {
    clipState.setSubtitleFetchState("loading");

    fetcher.resetClipState({ keepFetchState: true });

    // 其余字段照常全清，仅 fetchState 保留给调用方覆写（refreshClip catch 写 error）
    expect(clipState.subtitleFetchState).toBe("loading");
    expect(clipState.subtitleBody).toEqual([]);
    expect(clipState.noSubtitleReason).toBe(null);
    expect(clipState.subtitles).toEqual([]);
  });

  it("loadSubtitle 缓存命中 ready：陈旧原因清 null，且经字幕接受事务（乱序缓存条目被稳定排序）", async () => {
    clipState.setNoSubtitleReason("no-asr-config");
    // 旧缓存条目可能无序：接受事务单点负责排序（findActiveSubtitleIndex 二分依赖）
    const unsortedBody = [SUBTITLE_BODY[2], SUBTITLE_BODY[0], SUBTITLE_BODY[1]];
    loadSubtitleFromCache.mockResolvedValue(unsortedBody);

    await fetcher.loadSubtitle("https://example.com/sub.json", "中文", 0, "track-1", false);

    expect(clipState.subtitleFetchState).toBe("ready");
    expect(clipState.subtitleBody).toEqual(SUBTITLE_BODY);
    expect(clipState.noSubtitleReason).toBe(null);
    // 调用了 commit.acceptSubtitle（fetcher 不再手抄接受序列）
    expect(acceptSubtitle).toHaveBeenCalledTimes(1);
    expect(acceptSubtitle).toHaveBeenCalledWith({
      body: unsortedBody,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文"
    });
    // 缓存命中不发网络请求
    expect(fetchBodyMock).not.toHaveBeenCalled();
  });

  it("loadSubtitle 网络成功 ready：陈旧原因清 null，且经字幕接受事务", async () => {
    clipState.setNoSubtitleReason("asr-failed");
    fetchBodyMock.mockResolvedValue({ body: SUBTITLE_BODY });

    await fetcher.loadSubtitle("https://example.com/sub.json", "中文", 0, "track-1", true);

    expect(clipState.subtitleFetchState).toBe("ready");
    expect(clipState.subtitleBody).toEqual(SUBTITLE_BODY);
    expect(clipState.noSubtitleReason).toBe(null);
    expect(acceptSubtitle).toHaveBeenCalledTimes(1);
    expect(acceptSubtitle).toHaveBeenCalledWith({
      body: SUBTITLE_BODY,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文"
    });
    expect(fetchBodyMock).toHaveBeenCalledWith("https://example.com/sub.json");
  });
});

// loadSubtitleFromCache 在 beforeEach 已归位为 null；其余 mock 按用例覆写
describe("loadSubtitle 缓存边界行为（重构前后不变）", () => {
  it("网络成功但缓存写失败（LRU 淘汰后重试仍失败）：setMessage 一次性上浮，接受事务照常收尾", async () => {
    saveSubtitleToCache.mockResolvedValue({ ok: false });
    fetchBodyMock.mockResolvedValue({ body: SUBTITLE_BODY });

    await fetcher.loadSubtitle("https://example.com/sub.json", "中文", 0, "track-1", true);

    expect(setMessage).toHaveBeenCalledWith(
      "字幕已加载，但本地缓存写入失败（已自动清理旧缓存仍失败），重启浏览器后需重新抓取。"
    );
    // 缓存失败不阻断主流程：接受事务照常落位
    expect(acceptSubtitle).toHaveBeenCalledTimes(1);
    expect(clipState.subtitleFetchState).toBe("ready");
    // 有序副本落缓存（缓存写入前的调用方预备排序，仅此一处例外）
    expect(saveSubtitleToCache).toHaveBeenCalledWith("boc_subtitle_cache_test", SUBTITLE_BODY);
  });

  it("缓存命中但时长不匹配：清缓存后走网络重抓", async () => {
    // 过短字幕：videoDuration=300、maxTo=10 < 66 → too-short
    loadSubtitleFromCache.mockResolvedValue([{ from: 0, to: 10, content: "过短" }]);
    fetchBodyMock.mockResolvedValue({ body: SUBTITLE_BODY });

    await fetcher.loadSubtitle("https://example.com/sub.json", "中文", 0, "track-1", false);

    expect(clearSubtitleCacheByKey).toHaveBeenCalledWith("boc_subtitle_cache_test");
    // 时长不匹配的缓存条目不进 state；网络重抓经接受事务落位
    expect(clipState.subtitleBody).toEqual(SUBTITLE_BODY);
    expect(clipState.subtitleFetchState).toBe("ready");
    expect(fetchBodyMock).toHaveBeenCalledWith("https://example.com/sub.json");
  });
});

describe("586c61b 回归：refreshClip 错误路径的 fetchState 保持 error", () => {
  it("抓取失败收尾 resetClipState({ keepFetchState: true }) 后 fetchState 为 error（不被洗回 idle）", async () => {
    // 单一模块纪元（见文件头注释）：断言的 clipState 与 fetcher 闭包内同一实例。
    // fetchVideoMeta 抛错 → refreshClip catch → 无活动转写 → keepFetchState
    // reset + 一次写 error。若 reset 把状态洗回 idle，等待转写的 sidepanel
    // 轮询会误判"非转写中"提前放行空字幕（586c61b 原始 bug）。
    clipState.setSubtitleFetchState("loading");
    fetcher.fetchVideoMeta.mockRejectedValue(new Error("meta down"));

    await expect(fetcher.refreshClip()).resolves.toBeUndefined();

    expect(clipState.subtitleFetchState).toBe("error");
    // 其余上下文照常清空（reset 的全清语义不变）
    expect(clipState.bvid).toBe("");
    expect(clipState.subtitleBody).toEqual([]);
    // ASR fallback 模块装载失败会被降级为「无活动转写」继续原错误处理；
    // 无论装载成败，最终文案都是抓取失败提示
    expect(clipState.noSubtitleReason).toBe(null);
  });
});
