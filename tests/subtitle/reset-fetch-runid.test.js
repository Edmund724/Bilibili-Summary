// 回归测试（M23 / finding resetClipState×refreshClip runId 协调）：
// B 站 SPA 内快速换片时，URL 变化编排先同步递增 fetchRunId（entry/message-handler
// 的 handleUrlChange）再 resetClipState；在飞的旧视频 refreshClip 落定后必须在
// 字幕接受事务门口自检代次让位，不得把旧字幕写进已重置的 state。
//
// 三层锁：
//   1. 事务级——commit.acceptSubtitle / commitNoSubtitle 的可选 runId 自检：
//      代次已被推进时抛 STALE_RUN，且零 state 写入、零派生刷新、零通知；
//      未传 runId（asr/fallback 收尾路径）行为不变。
//   2. 编排级——真实 refreshClip 全链路：旧 run 在「网络抓取 → 提交」的
//      await 窗口（落缓存）被 reset+递增插队，到站后在事务门口让位；
//      对照组证明同一链路无干扰时正常提交（red-capable）。
//   3. URL 变化同步递增本身的回归见 tests/reader/url-change-runid.test.ts。
//
// mock 结构：与 fetcher-retry.test.js 同款 vi.mock（gateway/page-context/core/
// ui-status/reader-bus mock 掉，state/selection/error-helpers 保持真实）；
// commit.js 保持真实——runId 自检是被测对象，不能 mock。cache.js 仅 mock
// saveSubtitleToCache/loadSubtitleFromCache 两个落盘口（前者用可控 promise
// 精确复现「提交前 await 窗口」的竞态时序），键构造/候选构建走真实实现。

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
  const actual = await importOriginal();
  return {
    ...actual,
    saveSubtitleToCache: vi.fn(async () => ({ ok: true })),
    loadSubtitleFromCache: vi.fn(async () => null)
  };
});

// 与 asr-fallback-concurrent.test.js 同款时长合规体：videoDuration=300、maxTo=290
const GOOD_BODY = [
  { from: 0, to: 1.2, content: "第一条" },
  { from: 1.5, to: 290, content: "第二条" }
];
const TRACK = { id: "sub-1", lan: "zh-CN", lanDoc: "中文", subtitleUrl: "https://i0.hdslb.com/sub.json" };

function createPending() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let fetcher;
let state;
let clipState;
let gateway;
let cache;
let uiStatus;
let core;

async function importEpoch() {
  fetcher = await import("../../extension/subtitle/fetcher.js");
  const stateModule = await import("../../extension/core/state.js");
  state = stateModule.state;
  clipState = stateModule.clipState;
  gateway = await import("../../extension/bilibili/gateway.js");
  cache = await import("../../extension/subtitle/cache.js");
  uiStatus = await import("../../extension/shared/ui-status.js");
  core = await import("../../extension/subtitle/core.js");

  gateway.fetchVideoMeta.mockReset().mockResolvedValue({
    aid: "123",
    title: "测试标题",
    author: "测试作者",
    description: "测试简介",
    defaultCid: "101",
    defaultDuration: 300,
    pages: [{ cid: "101", page: 1, part: "P1", duration: 300 }]
  });
  gateway.fetchSubtitleBundle.mockReset().mockResolvedValue({ tracks: [TRACK], chapters: [] });
  gateway.fetchSubtitleBody.mockReset();
  gateway.readRuntimeVideoDuration.mockReset().mockReturnValue(300);
  cache.saveSubtitleToCache.mockReset().mockResolvedValue({ ok: true });
  cache.loadSubtitleFromCache.mockReset().mockResolvedValue(null);
  uiStatus.setStatus.mockReset();
  uiStatus.setMessage.mockReset();
  core.refreshDerivedContent.mockReset().mockResolvedValue(undefined);
}

beforeEach(async () => {
  resetModuleState();
  await importEpoch();
});

describe("事务级 runId 自检（commit.acceptSubtitle / commitNoSubtitle）", () => {
  it("代次已被推进（runId 过期）→ STALE_RUN 让位：零 state 写入、零派生刷新、零通知", async () => {
    clipState.setFetchRunId(2);

    await expect(
      accept({
        runId: 1
      })
    ).rejects.toMatchObject({ code: "STALE_RUN" });

    expect(state.clip.selectedSubtitleId).toBe("");
    expect(state.clip.selectedSubtitleUrl).toBe("");
    expect(state.clip.selectedSubtitleLang).toBe("");
    expect(state.clip.subtitleBody).toEqual([]);
    expect(state.clip.subtitleFetchState).toBe("idle");
    expect(core.refreshDerivedContent).not.toHaveBeenCalled();
    const { notifyReaderPresenter } = await import("../../extension/reader/reader-bus.js");
    expect(notifyReaderPresenter).not.toHaveBeenCalled();
  });

  it("runId 与当前代次一致 → 正常提交（ready + 派生刷新 + 通知）", async () => {
    clipState.setFetchRunId(2);

    await accept({ runId: 2 });

    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody.map((item) => item.content)).toEqual(["第一条", "第二条"]);
    expect(core.refreshDerivedContent).toHaveBeenCalledTimes(1);
  });

  it("未传 runId → 不校验直接提交（asr/fallback 收尾路径行为不变）", async () => {
    clipState.setFetchRunId(7);

    await accept({});

    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toHaveLength(2);
  });

  it("commitNoSubtitle 同型：代次已被推进 → STALE_RUN 且 state 不动；当前代次 → 正常落 empty", async () => {
    const { commitNoSubtitle, configureCommitUi } = await import("../../extension/subtitle/commit.js");
    configureCommitUi({ setStatus: uiStatus.setStatus });

    // 预放已接受态：过期出口不得清掉它
    clipState.setSubtitleFetchState("ready");
    clipState.setSubtitleBody(GOOD_BODY);
    clipState.setFetchRunId(3);

    await expect(commitNoSubtitle({ asrResult: "empty", runId: 2 })).rejects.toMatchObject({ code: "STALE_RUN" });
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toEqual(GOOD_BODY);

    await expect(commitNoSubtitle({ asrResult: "empty", runId: 3 })).resolves.toBeUndefined();
    expect(state.clip.subtitleFetchState).toBe("empty");
    expect(state.clip.subtitleBody).toEqual([]);
  });
});

// 字幕接受事务（真实实现）快捷调用
function accept({ runId }) {
  return import("../../extension/subtitle/commit.js").then(({ acceptSubtitle }) =>
    acceptSubtitle({
      body: [...GOOD_BODY].reverse(),
      selectedSubtitleId: "sub-1",
      selectedSubtitleUrl: TRACK.subtitleUrl,
      selectedSubtitleLang: "中文",
      ...(runId !== undefined ? { runId } : {})
    })
  );
}

describe("resetClipState × 在飞 refreshClip 竞态（端到端）", () => {
  async function driveRefreshClipToCommitWindow() {
    // 旧视频抓取 run 1：走到「网络抓取完成 → 落缓存」的提交前 await 窗口。
    // 落缓存口从一开始就挂可控 promise——提交窗口只在 save 挂起期间敞开，
    // 插队（reset+递增）必须发生在窗口内才能命中事务门口的自检。
    clipState.setFetchRunId(1);
    clipState.setVideoDuration(300);
    const bodyPending = createPending();
    gateway.fetchSubtitleBody.mockImplementation(() => bodyPending.promise);
    const savePending = createPending();
    cache.saveSubtitleToCache.mockImplementation(() => savePending.promise);
    const run = fetcher.refreshClip();
    await vi.waitFor(() => expect(gateway.fetchSubtitleBody).toHaveBeenCalledTimes(1));
    bodyPending.resolve({ body: GOOD_BODY });
    await vi.waitFor(() => expect(cache.saveSubtitleToCache).toHaveBeenCalledTimes(1));
    return { run, savePending };
  }

  it("reset+递增插队后旧字幕到站：事务门口 STALE_RUN 让位，state 保持 reset 干净态", async () => {
    const { run, savePending } = await driveRefreshClipToCommitWindow();

    // 模拟 URL 变化编排（message-handler.handleUrlChange 的顺序）：同步递增代次
    // → resetClipState 全清。注意 refreshClip 起跑时已自增（fetchRunId=2、run 的
    // runId=2），编排递增后为 3——与生产一致的相对递增。
    clipState.setFetchRunId(clipState.fetchRunId + 1);
    fetcher.resetClipState();

    savePending.resolve({ ok: true });
    // STALE_RUN 被 refreshClip 的 catch 静默吞掉（isStaleRunError 分支）
    await expect(run).resolves.toBeUndefined();

    // 关键断言：旧视频字幕没有写进已重置的 state
    expect(state.clip.subtitleBody).toEqual([]);
    expect(state.clip.subtitleFetchState).toBe("idle");
    expect(state.clip.selectedSubtitleId).toBe("");
    expect(state.clip.selectedSubtitleUrl).toBe("");
    expect(state.clip.title).toBe("");
    // 让位路径零错误文案（「抓取失败」不落状态栏）
    const statusTexts = uiStatus.setStatus.mock.calls.map((call) => String(call[0]));
    expect(statusTexts.some((text) => text.includes("抓取失败"))).toBe(false);
  });

  it("对照组：同一链路无 reset 插队时正常提交（证明竞态用例 red-capable）", async () => {
    const { run, savePending } = await driveRefreshClipToCommitWindow();

    savePending.resolve({ ok: true });
    await expect(run).resolves.toBeUndefined();

    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody.map((item) => item.content)).toEqual(["第一条", "第二条"]);
    expect(state.clip.selectedSubtitleId).toBe("sub-1");
  });
});
