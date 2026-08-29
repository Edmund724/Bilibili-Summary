// asr/fallback.js 的 ASR 回退策略簇回归测试（直测 createAsrFallback 工厂）。
// 依赖注入 seam：cache/cache-lru 直 import 真实模块，跑在测试内构造的内存版
// chrome.storage.local（Map 承载，支持 get(null) 全量枚举）之上；runAsrPipeline、
// getSettings、loadProviders（provider 列表，provider-store 形状）与 UI 回调
// （setStatus / setMessage / applyNoSubtitleState / refreshDerivedContent /
// isReaderViewOpen / notifyReaderPresenter / broadcastSubtitleStatus）全部为
// 测试内构造的假依赖。不经 vi.mock 间接测 fetcher 内部。
// provider 元数据（name/model）经注入的 loadProviders 取（asrProviders 已摘出
// settings——列表归 provider-store，Key 不再进页面——组装移到 offscreen）；
// 重点断言：skip 闸门（开关关 / 无激活平台 / 平台不在 provider 列表 / offscreen
// asr-skip）、缓存命中（时长校验过 → done；不过 → 清缓存重新生成）、空结果诊
// 断、错误路径（asr-failed 广播 + applyNoSubtitleState）、成功路径（写缓存 +
// clearStaleAsrSubtitleCache 孤儿清理 + 伪轨道收尾）、stale run。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createAsrFallback } from "../../extension/asr/fallback.js";
import { state, clipState } from "../../extension/core/state.js";
import { getSubtitleCacheKey, saveSubtitleToCache } from "../../extension/subtitle/cache.js";

const BVID = "BV1test000000";
const CID = "101";
const VIDEO_DURATION = 300;
const RUN_ID = 1;

const PROVIDER = {
  id: "p1",
  type: "openai-transcriptions",
  name: "本地 Whisper",
  model: "whisper-large-v3",
  supportsTimestamps: true
};

// 时长合规字幕体：videoDuration=300 时 minCoverageRatio=0.22，maxTo=290 ≥ 66。
const TRANSCRIBED_BODY = [
  { from: 0, to: 1.2, content: "你好" },
  { from: 1.5, to: 2.4, content: "世界" },
  { from: 3, to: 290, content: "收尾长句" }
];

// 当前 provider/model/language 组合下的 ASR 缓存键（与 fallback 内部规则一致，
// 用真实 getSubtitleCacheKey 计算——同时锁住缓存键规则零变化）。
function asrCacheKey({ providerId = "p1", model = "whisper-large-v3", lang = "auto" } = {}) {
  return getSubtitleCacheKey({
    bvid: BVID,
    cid: CID,
    subtitleId: `asr:${providerId}:${model}:${lang}`
  });
}

// 内存版 chrome.storage.local：真实 cache.js / cache-lru.js 跑在 Map 之上
//（cache-lru 需要 get(null) 全量枚举，见其模块注释的测试约定）。
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

// 预置缓存条目（镜像 cache.js 的写入形状 { body, timestamp }）
async function seedCache(key, body) {
  await globalThis.chrome.storage.local.set({ [key]: { body, timestamp: Date.now() } });
}

function buildDeps(overrides = {}) {
  return {
    getSettings: vi.fn(async () => state.settings),
    loadProviders: vi.fn(async () => [PROVIDER]),
    setStatus: vi.fn(),
    setMessage: vi.fn(),
    applyNoSubtitleState: vi.fn(),
    refreshDerivedContent: vi.fn(async () => {}),
    isReaderViewOpen: vi.fn(() => false),
    notifyReaderPresenter: vi.fn(),
    runAsrPipeline: vi.fn(async () => []),
    broadcastSubtitleStatus: vi.fn(),
    ...overrides
  };
}

let memoryStorage;
let deps;
let fallback;

beforeEach(() => {
  resetModuleState();
  memoryStorage = installMemoryStorage();

  clipState.setFetchRunId(RUN_ID);
  clipState.setBvid(BVID);
  clipState.setCid(CID);
  clipState.setVideoDuration(VIDEO_DURATION);
  clipState.setSubtitles([]);
  clipState.setSubtitleBody([]);
  clipState.setSubtitleFetchState("idle");
  // ASR 标量设置经设置快照供页面侧取用；provider 元数据走注入的 loadProviders
  state.settings = {
    ...state.settings,
    asrAutoFallback: true,
    activeAsrProviderId: "p1",
    asrLanguage: "auto"
  };

  deps = buildDeps();
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

describe("maybeRunAsrFallback skip 闸门", () => {
  it("开关关闭（settings.asrAutoFallback=false）：返回 skip，快速出口先于任务发起", async () => {
    state.settings.asrAutoFallback = false;

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("skip");
    expect(deps.runAsrPipeline).not.toHaveBeenCalled();
    expect(deps.broadcastSubtitleStatus).not.toHaveBeenCalled();
    expect(deps.applyNoSubtitleState).not.toHaveBeenCalled();
    // 无字幕原因：转写开关未开启（sidepanel 按此提示引导开启）
    expect(clipState.noSubtitleReason).toBe("asr-disabled");
  });

  it("无激活平台（settings.activeAsrProviderId 为空）：返回 skip", async () => {
    state.settings.activeAsrProviderId = "";

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("skip");
    expect(deps.runAsrPipeline).not.toHaveBeenCalled();
    expect(deps.broadcastSubtitleStatus).not.toHaveBeenCalled();
    // 无字幕原因：未配置语音识别平台
    expect(clipState.noSubtitleReason).toBe("no-asr-config");
  });

  it("激活平台 id 不在 provider 列表（loadProviders）中：返回 skip", async () => {
    deps.loadProviders.mockResolvedValue([{ id: "other", type: "openai-transcriptions", name: "其他" }]);

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("skip");
    expect(deps.runAsrPipeline).not.toHaveBeenCalled();
    expect(clipState.noSubtitleReason).toBe("no-asr-config");
  });

  it("offscreen 配置级 asr-skip：静默返回 skip，补 asr-done 终态广播解除等待标志", async () => {
    // 页面设置闸门放行后，offscreen 侧运行时配置缺失/关闭（Key 组装在
    // offscreen，页面无感）→ pipeline 以 code "asr-skip" reject
    deps.runAsrPipeline.mockRejectedValue(
      Object.assign(new Error("没有激活的语音识别平台"), { code: "asr-skip" })
    );

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("skip");
    expect(deps.applyNoSubtitleState).not.toHaveBeenCalled();
    // asr-transcribing 已广播（转写提示已展示），asr-skip 静默跳过必须补
    // 终态广播，否则 sidepanel 一键总结的 asrTranscribingActive 卡死
    expect(deps.broadcastSubtitleStatus.mock.calls.map((c) => c[0])).toEqual([
      "asr-transcribing",
      "asr-done"
    ]);
  });

  it("offscreen asr-skip 携带结构化 reason：随错误落 clipState.noSubtitleReason", async () => {
    // 开关关（asr-disabled）
    deps.runAsrPipeline.mockRejectedValue(
      Object.assign(new Error("ASR 自动回退未开启"), { code: "asr-skip", reason: "asr-disabled" })
    );
    await expect(fallback.maybeRunAsrFallback({ runId: RUN_ID })).resolves.toBe("skip");
    expect(clipState.noSubtitleReason).toBe("asr-disabled");

    // 无激活平台（no-asr-config）
    deps.runAsrPipeline.mockRejectedValue(
      Object.assign(new Error("没有激活的语音识别平台"), { code: "asr-skip", reason: "no-asr-config" })
    );
    await expect(fallback.maybeRunAsrFallback({ runId: RUN_ID })).resolves.toBe("skip");
    expect(clipState.noSubtitleReason).toBe("no-asr-config");
  });

  it("offscreen asr-skip 无 reason（config 消息失败/超时）：原因归 null（未知）", async () => {
    // 页面闸门已写过的旧原因被显式归 null，sidepanel 展示通用文案
    clipState.setNoSubtitleReason("asr-disabled");
    deps.runAsrPipeline.mockRejectedValue(
      Object.assign(new Error("get-asr-runtime-config timeout"), { code: "asr-skip" })
    );

    await expect(fallback.maybeRunAsrFallback({ runId: RUN_ID })).resolves.toBe("skip");

    expect(clipState.noSubtitleReason).toBe(null);
  });
});

describe("maybeRunAsrFallback 成功与缓存", () => {
  it("配置齐全：管线产出字幕 → 伪轨道 + ready + 写缓存 + 清理旧 ASR 变体 + asr-done 广播", async () => {
    // 预放同视频另一 provider/model 的过期 ASR 变体键：成功后应被孤儿清理。
    // 经真实写路径落盘（saveSubtitleToCache 记录 LRU 索引键面——孤儿清理按
    // 索引定点枚举，与生产写入来源一致）
    const staleVariantKey = asrCacheKey({ providerId: "p1", model: "whisper-old" });
    await saveSubtitleToCache(staleVariantKey, [{ from: 0, to: 5, content: "旧变体" }]);
    // 预放陈旧的无字幕原因：字幕就绪后必须清 null
    clipState.setNoSubtitleReason("asr-empty");
    deps.runAsrPipeline.mockResolvedValue(TRANSCRIBED_BODY);

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("done");
    expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1);
    // 页面侧不再传 provider/Key/durationSec（provider+Key 组装移到 offscreen）；
    // 语言档位来自设置快照、模型来自 provider 列表，只体现为缓存键
    const pipelineArgs = deps.runAsrPipeline.mock.calls[0][0];
    expect(pipelineArgs).toEqual(
      expect.objectContaining({
        bvid: BVID,
        cid: CID
      })
    );
    expect(pipelineArgs.provider).toBeUndefined();
    expect(pipelineArgs.durationSec).toBeUndefined();
    // 守卫链整体移除：pipeline 不再接收 runId/isStale（UI 门控留在 fallback）
    expect(pipelineArgs.runId).toBeUndefined();
    expect(pipelineArgs.isStale).toBeUndefined();

    // 伪轨道收尾：subtitles 首项为 asr 伪轨，body/选中态/ready 全部落位
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toEqual(TRANSCRIBED_BODY);
    // ready 收尾清除无字幕原因
    expect(clipState.noSubtitleReason).toBe(null);
    expect(state.clip.subtitles[0]).toEqual({
      id: "asr",
      lan: "asr-zh",
      lanDoc: "语音识别（本地 Whisper）",
      subtitleUrl: ""
    });
    expect(state.clip.selectedSubtitleId).toBe("asr");
    expect(state.clip.selectedSubtitleLang).toBe("语音识别（本地 Whisper）");

    // 成果落缓存 + 孤儿清理：新键写入、旧变体被移除
    const cacheKey = asrCacheKey();
    expect(memoryStorage.get(cacheKey)?.body).toEqual(TRANSCRIBED_BODY);
    expect(memoryStorage.has(staleVariantKey)).toBe(false);

    // 阶段广播：转写中 → 完成
    expect(deps.broadcastSubtitleStatus.mock.calls.map((c) => c[0])).toEqual([
      "asr-transcribing",
      "asr-done"
    ]);
    const statusCalls = deps.setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("语音识别完成，已生成 3 条字幕。"))).toBe(true);
  });

  it("阅读视图打开时收尾通知 presenter：subtitle-ready", async () => {
    deps.isReaderViewOpen.mockReturnValue(true);
    deps.runAsrPipeline.mockResolvedValue(TRANSCRIBED_BODY);

    await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(deps.notifyReaderPresenter).toHaveBeenCalledWith("subtitle-ready");
  });

  it("缓存命中（时长校验过）：不转写、不写缓存，直接 done 收尾", async () => {
    const cachedBody = [
      { from: 0, to: 1, content: "缓存句" },
      { from: 2, to: 290, content: "足够长的缓存字幕" }
    ];
    await seedCache(asrCacheKey(), cachedBody);
    // 预放陈旧的无字幕原因：缓存命中 ready 收尾必须清 null
    clipState.setNoSubtitleReason("asr-failed");

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("done");
    expect(deps.runAsrPipeline).not.toHaveBeenCalled();
    expect(deps.broadcastSubtitleStatus).not.toHaveBeenCalled(); // 缓存命中不发阶段广播
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toEqual(cachedBody);
    expect(clipState.noSubtitleReason).toBe(null);
    const statusCalls = deps.setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("缓存命中"))).toBe(true);
  });

  it("缓存命中但时长校验不过：清缓存并重新转写生成", async () => {
    const cacheKey = asrCacheKey();
    // 过短字幕：videoDuration=300、maxTo=10 < 66 → too-short
    await seedCache(cacheKey, [{ from: 0, to: 10, content: "过短" }]);
    deps.runAsrPipeline.mockResolvedValue(TRANSCRIBED_BODY);

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("done");
    expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1); // 校验不过 → 重生成
    // 旧键先被清理，随后被新成果重新写入
    expect(memoryStorage.get(cacheKey)?.body).toEqual(TRANSCRIBED_BODY);
  });

  it("写缓存失败（LRU 淘汰后重试仍失败）：setMessage 一次性上浮，不阻断收尾", async () => {
    // storage.set 恒失败 → writeWithEviction 返回 ok:false → setMessage 上浮
    globalThis.chrome.storage.local.set.mockRejectedValue(new Error("quota exceeded"));
    deps.runAsrPipeline.mockResolvedValue(TRANSCRIBED_BODY);

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("done");
    expect(deps.setMessage).toHaveBeenCalledWith(
      "语音识别结果已生成，但本地缓存写入失败（已自动清理旧缓存仍失败），仅本次会话有效。"
    );
    // 写失败时孤儿清理不执行、收尾不受影响
    expect(state.clip.subtitleFetchState).toBe("ready");
  });
});

describe("maybeRunAsrFallback 空结果与失败", () => {
  it("空结果：文案「未识别到语音内容」+ asr-done 广播，不写缓存", async () => {
    deps.runAsrPipeline.mockResolvedValue([]);

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("empty");
    const statusCalls = deps.setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("未识别到语音内容"))).toBe(true);
    expect(deps.broadcastSubtitleStatus).toHaveBeenCalledWith("asr-done");
    expect(deps.applyNoSubtitleState).not.toHaveBeenCalled(); // empty 由调用点收尾
    expect(memoryStorage.has(asrCacheKey())).toBe(false);
    // 无字幕原因：未识别到语音内容
    expect(clipState.noSubtitleReason).toBe("asr-empty");
  });

  it("空结果带诊断：onEmptyDiagnostic 的信息拼进状态栏", async () => {
    deps.runAsrPipeline.mockImplementation(async ({ onEmptyDiagnostic }) => {
      onEmptyDiagnostic("音频解码为空");
      return [];
    });

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("empty");
    const statusCalls = deps.setStatus.mock.calls.map((c) => String(c[0]));
    expect(
      statusCalls.some((s) => s.includes("未识别到语音内容") && s.includes("（诊断：音频解码为空）"))
    ).toBe(true);
  });

  it("管线失败：语音识别失败文案 + asr-failed 广播 + applyNoSubtitleState，不崩", async () => {
    deps.runAsrPipeline.mockRejectedValue(new Error("音频解码失败"));

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("error");
    const statusCalls = deps.setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("语音识别失败：音频解码失败"))).toBe(true);
    expect(deps.broadcastSubtitleStatus).toHaveBeenCalledWith("asr-failed");
    expect(deps.applyNoSubtitleState).toHaveBeenCalledTimes(1);
    // 无字幕原因：语音识别失败
    expect(clipState.noSubtitleReason).toBe("asr-failed");
  });

  it("stale run（转写中切换视频）：任务不中止、缓存照落、asr-done 照发、UI 零写入", async () => {
    const pending = stubPendingPipeline();
    const promise = fallback.maybeRunAsrFallback({ runId: RUN_ID });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));

    // 切视频前的 UI 写入基线（发起阶段的转写提示）
    const statusCallsAtSwitch = deps.setStatus.mock.calls.length;
    const messageCallsAtSwitch = deps.setMessage.mock.calls.length;
    const refreshCallsAtSwitch = deps.refreshDerivedContent.mock.calls.length;

    // 换视频：bvid 变化 → isStale 判真；任务不再被中止，转写照常到站
    clipState.setBvid("BV1other");
    clipState.setFetchRunId(2);
    pending[0].resolve(TRANSCRIBED_BODY);

    await expect(promise).resolves.toBe("done");

    // 成果仍即刻落缓存（键绑定发起时的 bvid/cid，与当前 UI 无关）
    expect(memoryStorage.get(asrCacheKey())?.body).toEqual(TRANSCRIBED_BODY);
    // 终态广播照发：sidepanel 的全局 asrTranscribingActive 标志归位
    expect(deps.broadcastSubtitleStatus.mock.calls.map((c) => c[0])).toEqual([
      "asr-transcribing",
      "asr-done"
    ]);
    // UI 零写入：切走后不碰状态栏/消息栏/clipState/reader（不执行 finishAsrFallback）
    expect(deps.setStatus).toHaveBeenCalledTimes(statusCallsAtSwitch);
    expect(deps.setMessage).toHaveBeenCalledTimes(messageCallsAtSwitch);
    expect(deps.refreshDerivedContent).toHaveBeenCalledTimes(refreshCallsAtSwitch);
    expect(deps.applyNoSubtitleState).not.toHaveBeenCalled();
    expect(deps.notifyReaderPresenter).not.toHaveBeenCalled();
    expect(state.clip.subtitleFetchState).toBe("idle");
  });

  it("stale run（切视频后空结果到站）：asr-done 照发、UI 零写入，调用方静默让位", async () => {
    const pending = stubPendingPipeline();
    const promise = fallback.maybeRunAsrFallback({ runId: RUN_ID });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));

    const statusCallsAtSwitch = deps.setStatus.mock.calls.length;
    clipState.setBvid("BV1other");
    clipState.setFetchRunId(2);
    pending[0].resolve([]);

    await expect(promise).rejects.toMatchObject({ code: "STALE_RUN" });

    expect(deps.broadcastSubtitleStatus.mock.calls.map((c) => c[0])).toEqual([
      "asr-transcribing",
      "asr-done"
    ]);
    // 空结果文案不上新视频状态栏
    expect(deps.setStatus).toHaveBeenCalledTimes(statusCallsAtSwitch);
    expect(deps.applyNoSubtitleState).not.toHaveBeenCalled();
    expect(memoryStorage.has(asrCacheKey())).toBe(false);
  });

  it("stale run（切视频后失败到站）：asr-failed 照发、UI 零写入", async () => {
    const pending = stubPendingPipeline();
    const promise = fallback.maybeRunAsrFallback({ runId: RUN_ID });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));

    const statusCallsAtSwitch = deps.setStatus.mock.calls.length;
    clipState.setBvid("BV1other");
    clipState.setFetchRunId(2);
    pending[0].reject(new Error("音频解码失败"));

    await expect(promise).rejects.toMatchObject({ code: "STALE_RUN" });

    expect(deps.broadcastSubtitleStatus.mock.calls.map((c) => c[0])).toEqual([
      "asr-transcribing",
      "asr-failed"
    ]);
    expect(deps.setStatus).toHaveBeenCalledTimes(statusCallsAtSwitch);
    expect(deps.applyNoSubtitleState).not.toHaveBeenCalled();
  });

  it("stale 进度门控：转写中切视频，onProgress 不再触发 setStatus", async () => {
    let progress = null;
    let resolvePipeline = null;
    deps.runAsrPipeline.mockImplementation(
      ({ onProgress }) =>
        new Promise((resolve) => {
          progress = onProgress;
          resolvePipeline = resolve;
        })
    );
    const promise = fallback.maybeRunAsrFallback({ runId: RUN_ID });
    await vi.waitFor(() => expect(progress).toBeTruthy());

    // fresh 阶段：进度文案照常上状态栏（现状行为不变）
    progress("语音识别中 1 片…");
    const callsAfterFresh = deps.setStatus.mock.calls.length;
    expect(String(deps.setStatus.mock.calls[callsAfterFresh - 1][0])).toContain("语音识别中 1 片…");

    // 切视频后：进度不再触发 setStatus（新视频状态栏不被旧任务污染）
    clipState.setBvid("BV1other");
    clipState.setFetchRunId(2);
    progress("语音识别中 2 片…");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.setStatus.mock.calls.length).toBe(callsAfterFresh);

    // 任务本身照常到站：缓存照落、零 UI 收尾
    resolvePipeline(TRANSCRIBED_BODY);
    await expect(promise).resolves.toBe("done");
    expect(memoryStorage.get(asrCacheKey())?.body).toEqual(TRANSCRIBED_BODY);
  });

  it("非 stale 的 runId 过期（未发起转写前的守卫）：直接抛 STALE_RUN", async () => {
    await expect(fallback.maybeRunAsrFallback({ runId: 999 })).rejects.toMatchObject({
      code: "STALE_RUN"
    });
    expect(deps.runAsrPipeline).not.toHaveBeenCalled();
    expect(deps.broadcastSubtitleStatus).not.toHaveBeenCalled();
  });
});

describe("工厂单元导出", () => {
  it("hasActiveAsrTranscribe：无转写为 false，发起后为 true，完成清理后回到 false", async () => {
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(false);

    const pending = stubPendingPipeline();
    const promise = fallback.maybeRunAsrFallback({ runId: RUN_ID });
    await vi.waitFor(() =>
      expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(true)
    );

    pending[0].resolve(TRANSCRIBED_BODY);
    await promise;
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(false);
  });

  it("awaitActiveAsrTranscribe：无进行中转写时静默返回，不触碰 UI", async () => {
    await expect(
      fallback.awaitActiveAsrTranscribe({ runId: RUN_ID, bvid: BVID, cid: CID })
    ).resolves.toBeUndefined();
    expect(deps.setStatus).not.toHaveBeenCalled();
    expect(deps.broadcastSubtitleStatus).not.toHaveBeenCalled();
  });
});
