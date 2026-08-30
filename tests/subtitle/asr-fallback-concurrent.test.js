// 回归测试：ASR 转写进行中的并发共享语义（直测 createAsrFallback 工厂）。
// 用户症状（修复前）：一键总结无字幕长视频时转写被反复打断 → 成果既不写缓存
// 也不进总结上下文；之后单独"抓取字幕"发现无缓存、从头重转。
// 修复后行为：同视频并发调用命中进行中的转写共享同一 promise（不重启、
// runId 前进不误杀），转写成果即刻落缓存；被更新的同视频抓取顶掉时仅 UI 收尾
// 让位（发起者 reject STALE_RUN，fetcher catch 中被 isStaleRunError 吞掉），
// 成果不丢。转写与视频切换解耦后（Map<cacheKey> 共享单元）：切走视频任务照
// 跑、成果照落缓存，其它视频的并行转写各自在册、完成只清自己的键；切回原
// 视频经共享单元/缓存命中自动接上。
// mock 结构：与 asr-fallback.test.js 相同——内存版 chrome.storage.local 承载
// 真实 cache.js；字幕接受事务（acceptSubtitle / commitNoSubtitle）注入 vi.fn
// 包装的真实实现（真实落 state + 可观察调用），其余依赖为测试内构造的假依赖，
// 不经 vi.mock。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createAsrFallback } from "../../extension/asr/fallback.js";
import { state, clipState } from "../../extension/core/state.js";
import { getSubtitleCacheKey } from "../../extension/subtitle/cache.js";
import {
  acceptSubtitle as realAcceptSubtitle,
  commitNoSubtitle as realCommitNoSubtitle,
  configureCommitUi
} from "../../extension/subtitle/commit.js";

const BVID = "BV1test000000";
const CID = "101";
const VIDEO_DURATION = 300;

// 并行转写的第二个视频身份
const BVID_B = "BV1other00000";
const CID_B = "202";

const PROVIDER = {
  id: "p1",
  type: "openai-transcriptions",
  name: "本地 Whisper",
  model: "whisper-large-v3",
  supportsTimestamps: true
};

// 时长合规：videoDuration=300、minCoverageRatio=0.22、maxTo=290 ≥ 66
const TRANSCRIBED_BODY = [
  { from: 0, to: 1.2, content: "五小时转写成果" },
  { from: 1.5, to: 290, content: "第二条" }
];

function asrCacheKey({ bvid = BVID, cid = CID } = {}) {
  return getSubtitleCacheKey({
    bvid,
    cid,
    subtitleId: "asr:p1:whisper-large-v3:auto"
  });
}

function installMemoryStorage() {
  const store = new Map();
  const storage = globalThis.chrome.storage.local;
  storage.get.mockImplementation(async (keys) => {
    if (keys === null || keys === undefined) {
      return Object.fromEntries(store);
    }
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const key of list) {
      if (store.has(key)) {
        out[key] = store.get(key);
      }
    }
    return out;
  });
  storage.set.mockImplementation(async (entries) => {
    for (const [key, value] of Object.entries(entries)) {
      store.set(key, value);
    }
  });
  storage.remove.mockImplementation(async (keys) => {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      store.delete(key);
    }
  });
  return store;
}

let memoryStorage;
let deps;
let fallback;

beforeEach(() => {
  resetModuleState();
  memoryStorage = installMemoryStorage();

  // 真实 commitNoSubtitle 需要注入渲染回调 + 预览 DOM 节点（见 asr-fallback.test.js）
  configureCommitUi({
    renderMeta: vi.fn(),
    renderSubtitleSelect: vi.fn(),
    setStatus: vi.fn()
  });
  const preview = document.createElement("textarea");
  preview.id = "boc-preview";
  document.body.appendChild(preview);

  clipState.setFetchRunId(1);
  clipState.setBvid(BVID);
  clipState.setCid(CID);
  clipState.setVideoDuration(VIDEO_DURATION);
  clipState.setSubtitles([]);
  clipState.setSubtitleBody([]);
  clipState.setSubtitleFetchState("idle");
  // ASR 标量设置经设置快照供页面侧取用；provider 元数据（无 Key）走注入的
  // loadProviders（provider 列表，asrProviders 已摘出 settings），Key 组装在 offscreen
  state.settings = {
    ...state.settings,
    asrAutoFallback: true,
    activeAsrProviderId: "p1",
    asrLanguage: "auto"
  };

  deps = {
    getSettings: vi.fn(async () => state.settings),
    loadProviders: vi.fn(async () => [PROVIDER]),
    setStatus: vi.fn(),
    setMessage: vi.fn(),
    // 字幕接受事务：vi.fn 包装真实实现（真实落 state + 可观察调用）
    acceptSubtitle: vi.fn(realAcceptSubtitle),
    commitNoSubtitle: vi.fn(realCommitNoSubtitle),
    runAsrPipeline: vi.fn(async () => []),
    broadcastSubtitleStatus: vi.fn()
  };
  fallback = createAsrFallback(deps);
});

// runAsrPipeline 挂起（转写中），返回句柄数组用于逐个 resolve/reject
function stubPendingPipeline() {
  const pending = [];
  deps.runAsrPipeline.mockImplementation(() => {
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  });
  return pending;
}

// 数据键（非 LRU 索引键）中对 cacheKey 的写入次数：断言成果只落一次缓存
function cacheKeyWriteCount(cacheKey) {
  return globalThis.chrome.storage.local.set.mock.calls.filter(
    ([entries]) => entries && Object.prototype.hasOwnProperty.call(entries, cacheKey)
  ).length;
}

describe("ASR 转写中并发调用（共享转写、成果落缓存）", () => {
  it("转写 pending 时第二次调用命中共享单元：不重启、成果写缓存一次、发起者让位等待者收尾", async () => {
    const pending = stubPendingPipeline();

    // 第一次调用（例如侧边栏 init / popup-refresh #1 触发）→ 开始转写
    const first = fallback.maybeRunAsrFallback({ runId: 1 });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));

    // 转写进行中，第二次调用（侧边栏 focus/tab 切换 sync 触发的 popup-refresh #2，
    // fetchRunId 前进到 2）
    clipState.setFetchRunId(2);
    const second = fallback.maybeRunAsrFallback({ runId: 2 });
    // 等第二次调用走到"命中进行中转写"的共享等待点（全假依赖链路，短暂让步即可）
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 关键断言 1：不重启转写——runAsrPipeline 仍只被调用 1 次
    expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1);

    // 转写"完成"（几小时的成果）
    pending[0].resolve(TRANSCRIBED_BODY);

    const [firstOutcome, secondOutcome] = await Promise.allSettled([first, second]);

    // 关键断言 2：成果即刻落缓存（在 runId/UI 收尾检查之前），只写一次
    expect(cacheKeyWriteCount(asrCacheKey())).toBe(1);
    expect(memoryStorage.get(asrCacheKey())?.body).toEqual(TRANSCRIBED_BODY);

    // 关键断言 3：等待者正常收尾（ready + 完成提示）；发起者已被顶掉，其
    // STALE_RUN 在 fetcher 的 catch 中被 isStaleRunError 吞掉（此处直接体现
    // 为 reject），完成提示只出现一次
    expect(secondOutcome.status).toBe("fulfilled");
    expect(secondOutcome.value).toBe("done");
    expect(firstOutcome.status).toBe("rejected");
    expect(firstOutcome.reason).toMatchObject({ code: "STALE_RUN" });
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toEqual(TRANSCRIBED_BODY);
    const doneCount = deps.setStatus.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("语音识别完成")).length;
    expect(doneCount).toBe(1);
    // 共享单元用后清理
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(false);
  });

  it("转写完成写入缓存后，下一次调用缓存命中、不再转写（用户单独抓取不重转）", async () => {
    const pending = stubPendingPipeline();

    const first = fallback.maybeRunAsrFallback({ runId: 1 });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));
    pending[0].resolve(TRANSCRIBED_BODY);
    await first;
    expect(cacheKeyWriteCount(asrCacheKey())).toBe(1);

    // 无并发干扰时，下一次调用应命中真实写入的缓存（loadSubtitleFromCache 放行
    // 后 ready 收尾）；字幕覆盖视频时长，validateSubtitleByDuration 放行
    clipState.setFetchRunId(2);
    const result = await fallback.maybeRunAsrFallback({ runId: 2 });
    expect(result).toBe("done");
    expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1); // 未增加
    const statusCalls = deps.setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("缓存命中"))).toBe(true);
  });

  it("转写失败：asr-failed 广播发出，走无字幕出口逆事务（commit.commitNoSubtitle）", async () => {
    deps.runAsrPipeline.mockRejectedValue(new Error("音频解码失败"));

    const result = await fallback.maybeRunAsrFallback({ runId: 1 });

    expect(result).toBe("error");
    expect(deps.broadcastSubtitleStatus).toHaveBeenCalledWith("asr-failed");
    expect(deps.commitNoSubtitle).toHaveBeenCalledTimes(1);
    expect(deps.commitNoSubtitle).toHaveBeenCalledWith({ noSubtitleReason: "asr-failed", asrResult: "error" });
    expect(state.clip.subtitleFetchState).toBe("empty");
  });

  it("转写进行中走 awaitActiveAsrTranscribe（fetcher 失败兜底路径）：跟随共享转写收尾，不重复转写", async () => {
    const pending = stubPendingPipeline();

    // 第一次调用开始转写
    const first = fallback.maybeRunAsrFallback({ runId: 1 });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));

    // 辅助抓取失败路径：fetcher catch 里以新一轮 runId 等待当前视频的共享转写
    //（不清上下文，跟着共享转写一起完成；探针/等待都按 bvid/cid 匹配）
    clipState.setFetchRunId(2);
    const waiter = fallback.awaitActiveAsrTranscribe({ runId: 2, bvid: BVID, cid: CID });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1); // 等待，不重启

    // 转写"完成"：发起者 runId 过期让位，等待者完成 UI 收尾
    pending[0].resolve(TRANSCRIBED_BODY);
    await expect(waiter).resolves.toBeUndefined();
    await first.catch(() => {}); // 发起者 STALE_RUN 由 fetcher catch 吞掉

    // 关键断言：共享转写成果正常进入状态并落缓存，完成提示只出现一次
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toEqual(TRANSCRIBED_BODY);
    expect(cacheKeyWriteCount(asrCacheKey())).toBe(1);
    const doneCount = deps.setStatus.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("语音识别完成")).length;
    expect(doneCount).toBe(1);
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(false);
  });

  it("共享转写失败时 awaitActiveAsrTranscribe 静默退出（发起者路径负责文案）", async () => {
    const pending = stubPendingPipeline();

    const first = fallback.maybeRunAsrFallback({ runId: 1 });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));

    const waiter = fallback.awaitActiveAsrTranscribe({ runId: 2, bvid: BVID, cid: CID });
    pending[0].reject(new Error("音频解码失败"));

    // 等待者静默退出；发起者走自己的 catch（error 收尾）
    await expect(waiter).resolves.toBeUndefined();
    await expect(first).resolves.toBe("error");
    // 等待者不重复收尾（finishAsrFallback 未执行）；发起者的无字幕出口逆事务
    // 恰好执行一次，fetchState 落 empty（生产语义：真实 applyNoSubtitleState 同样如此）
    expect(deps.acceptSubtitle).not.toHaveBeenCalled();
    expect(deps.commitNoSubtitle).toHaveBeenCalledTimes(1);
    expect(state.clip.subtitleFetchState).toBe("empty");
  });
});

describe("转写与视频切换解耦（Map<cacheKey> 共享单元）", () => {
  it("两个不同视频的转写并行（Map 双记录）：A 完成只清 A 的键，成果与 UI 不串台", async () => {
    const pending = stubPendingPipeline();

    // 视频 A 开始转写
    const first = fallback.maybeRunAsrFallback({ runId: 1 });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(true);

    // 切到视频 B（bvid/cid 变化，A 的转写不被中止）→ B 也无字幕，开始 B 的转写
    clipState.setBvid(BVID_B);
    clipState.setCid(CID_B);
    clipState.setFetchRunId(2);
    const second = fallback.maybeRunAsrFallback({ runId: 2 });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(2));

    // Map 双记录：两个视频的转写同时在册
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(true);
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID_B, cid: CID_B })).toBe(true);

    // A 在用户停留 B 期间完成：不中止、缓存照落、终态广播照发、B 的在册状态不动
    const statusCallsBeforeA = deps.setStatus.mock.calls.length;
    pending[0].resolve(TRANSCRIBED_BODY);
    await expect(first).resolves.toBe("done");
    expect(deps.setStatus).toHaveBeenCalledTimes(statusCallsBeforeA); // A 不碰 B 的状态栏
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(false);
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID_B, cid: CID_B })).toBe(true);

    // B 完成：用户正看 B，正常收尾
    pending[1].resolve([{ from: 0, to: 250, content: "B 视频成果" }]);
    await expect(second).resolves.toBe("done");

    // 只有 B 的成果上屏；A 的成果只存在于 A 的缓存键
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toEqual([{ from: 0, to: 250, content: "B 视频成果" }]);
    expect(memoryStorage.get(asrCacheKey())?.body).toEqual(TRANSCRIBED_BODY);
    expect(memoryStorage.get(asrCacheKey({ bvid: BVID_B, cid: CID_B }))?.body).toEqual([
      { from: 0, to: 250, content: "B 视频成果" }
    ]);
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID_B, cid: CID_B })).toBe(false);
  });

  it("切走再切回原视频：共享单元命中不重启转写，新 runId 收尾自动接上", async () => {
    const pending = stubPendingPipeline();

    // 视频 A 开始转写
    const first = fallback.maybeRunAsrFallback({ runId: 1 });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));

    // 切到 B（runId 2，bvid/cid 变化；A 的转写照跑、在册不清理）
    clipState.setBvid(BVID_B);
    clipState.setCid(CID_B);
    clipState.setFetchRunId(2);
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(true);

    // 切回 A（runId 3，bvid/cid 复原）→ 无字幕 → maybeRunAsrFallback 命中共享单元
    clipState.setBvid(BVID);
    clipState.setCid(CID);
    clipState.setFetchRunId(3);
    const third = fallback.maybeRunAsrFallback({ runId: 3 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 关键断言：不重启转写（Map 按 cacheKey 命中同一 promise）
    expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1);

    pending[0].resolve(TRANSCRIBED_BODY);

    // 新 runId 收尾上屏；旧调用方（runId 1）静默让位
    await expect(third).resolves.toBe("done");
    await expect(first).rejects.toMatchObject({ code: "STALE_RUN" });

    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toEqual(TRANSCRIBED_BODY);
    expect(cacheKeyWriteCount(asrCacheKey())).toBe(1);
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(false);
  });
});
