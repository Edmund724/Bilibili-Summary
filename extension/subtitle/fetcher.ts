// 候选03 常驻瘦身：setMessage / setStatus 迁入 shared/ui-status.js。
import { setMessage, setStatus } from "../shared/ui-status.js";
import { DEFAULT_SETTINGS } from "../core/defaults.js";
import { state, clipState } from "../core/state.js";
import type { SubtitleOption } from "../core/state.js";
import { extractBvid, computeCurrentClipSignature } from "../bilibili/video-id-shared.js";
import { getSettings } from "../core/runtime.js";
import {
  ensureRunActive,
  isStaleRunError,
  getErrorMessage,
  toReadableText,
  isRetryableNetworkError,
  retryAsync
} from "../shared/error-helpers.js";
import { logInfo, logWarn } from "../shared/logging.js";
// isReaderViewOpen 位于 reader 状态微模块（候选04 结构归并）：纯 state 读取，
// 不再经 reader/index.js facade 静态转发（否则整条 reader 域会被拖进本链闭包）。
import { isReaderViewOpen } from "../reader/state.js";
import { readVideoTitle, readVideoAuthor, readUploadDate, readVideoDescription } from "./core.js";
import { normalizeChapters } from "./chapters.js";
import {
  normalizeSubtitleTracks,
  pickPreferredSubtitle,
  sortSubtitleBodyByFrom,
  validateSubtitleByDuration
} from "./selection.js";
import type { DurationValidationResult } from "./selection.js";
import {
  buildSubtitleCandidates,
  clearSubtitleCacheByKey,
  clearStaleAsrSubtitleCache,
  saveSubtitleToCache,
  loadSubtitleFromCache,
  getSubtitleCacheKey
} from "./cache.js";
import { resolvePageContext } from "../reader/page-context.js";
import { notifyReaderPresenter, subscribeSubtitleRefresh } from "../reader/reader-bus.js";
// 字幕接受事务（CONTEXT.md 域词条）：接受/无字幕出口的唯一入口。渲染与状态栏
// 回调在模块求值期注入（下方 configureCommitUi），保持 commit → 本模块/UI 层
// 无静态边。
import { acceptSubtitle, commitNoSubtitle, configureCommitUi } from "./commit.js";
import {
  fetchVideoMeta as gatewayFetchVideoMeta,
  fetchSubtitleBundle as gatewayFetchSubtitleBundle,
  fetchSubtitleBody,
  readRuntimeVideoDuration,
  contentFetchJson
} from "../bilibili/gateway.js";
import type { SubtitleTrack } from "../bilibili/gateway.js";

interface SubtitleDurationMismatchError extends Error {
  code: "SUBTITLE_DURATION_MISMATCH";
  details: DurationValidationResult;
}

// ASR 域（pipeline + fallback 及其专属依赖 audio-source/offscreen-bridge.page）
// 经动态 import 按需加载（候选4 分包）：只有视频无 CC 字幕时才需要语音转写。
// 装配组合根（provider 列表读取 + createAsrFallback deps 装配 + promise 缓存
// 单例 + broadcastSubtitleStatus）已归位 asr/active-fallback.ts
//（arch-review-2026-09/09）；本模块只经下方 loadAsrFallbackOrNull /
// finishNoSubtitle 的动态 import 边获取回退单例——此依赖为单向边，import 环 A
// 不再成立。分包前这些模块随单文件 bundle 常驻；分包后成为动态 import 边被切
// 进 entry/chunks/。实例缓存与失败重试语义见 asr/active-fallback.ts。

// The fetcher is lazily loaded as part of the summarize chain (候选02 分层惰性
// ，见 subtitle/lazy.js): the reader-bus (presenter seam) registration below used
// to be a module-level side effect, which relied on "fetcher is always loaded at
// startup" — no longer true once the chain is on-demand. Registration now
// binds to chain loading: initSummarizeChain() runs once on the
// ensureSummarizeChain() success path (subscribeSubtitleRefresh 自带去重，
// 重复调用安全), and the reader side triggers a re-fetch by ensuring the chain
// first (call site in reader/lifecycle.js) and then calling requestSubtitleRefresh().
export function initSummarizeChain(): void {
  subscribeSubtitleRefresh(refreshClip);
}

// 字幕接受事务的渲染/状态栏回调接线（CONTEXT.md：DOM 渲染回调由 fetcher 注入，
// 保持静态图无环）。放在模块求值期执行：本模块任何导出可被调用前必然完成，
// asr/active-fallback.ts 装配（loadActiveAsrFallback）注入的 commitNoSubtitle
// 也因此保证先接线后可用。
configureCommitUi({
  setStatus
});

// fetchVideoMeta / fetchSubtitleBundle 纯直通包装已删除（arch-slim-2/03）：原
// 26 行只加 logInfo/logWarn，日志下沉到 gateway 对应函数（debug 级差异），本
// 模块与 ai/context-resolver 一致直用 bilibili/gateway 的函数 + contentFetchJson。

export async function tryLoadSubtitleCandidates(
  candidates: SubtitleTrack[],
  runId: number,
  forceRefresh: boolean
): Promise<SubtitleTrack> {
  let lastError: unknown = null;
  for (const item of candidates || []) {
    try {
      logInfo("[BOC] try subtitle track", {
        id: item.id,
        lan: item.lan,
        lanDoc: item.lanDoc,
        url: item.subtitleUrl
      });
      await loadSubtitle(
        item.subtitleUrl,
        item.lanDoc || item.lan || "unknown",
        runId,
        item.id,
        forceRefresh
      );
      return item;
    } catch (error) {
      lastError = error;
      const reasonCode = toReadableText((error as { code?: unknown }).code, "");
      const reasonMessage = getErrorMessage(error, "unknown");
      const meta = {
        id: item.id,
        lan: item.lan,
        lanDoc: item.lanDoc,
        reason: reasonCode || reasonMessage
      };
      if (reasonCode === "SUBTITLE_DURATION_MISMATCH") {
        logInfo(`[BOC] subtitle track skipped ${JSON.stringify(meta)}`);
      } else {
        logWarn(`[BOC] subtitle track rejected ${JSON.stringify(meta)}`);
      }
      ensureRunActive(runId, state.clip.fetchRunId);
      continue;
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error("这个视频暂时没有可用字幕。");
}

// keepFetchState：错误路径专用（586c61b 纪律，见 sidepanel-subtitle-wait.js
// 复述）——reset 全清会把 fetchState 洗成 idle，等待转写的侧边栏轮询会误判
// "非转写中"提前放行空字幕。错误路径传 true 保留调用方随后覆写的 "error"
//（见 refreshClip catch），其余调用方（message-handler 的 URL 变化等）默认
// 全清，语义不变。
export function resetClipState({ keepFetchState = false }: { keepFetchState?: boolean } = {}): void {
  clipState.setBvid("");
  clipState.setAid("");
  clipState.setCid("");
  clipState.setCidSource("");
  clipState.setPageIndex(1);
  clipState.setPageCount(0);
  clipState.setPageTitle("");
  clipState.setVideoDuration(0);
  clipState.setDescription("");
  clipState.setTitle("");
  clipState.setAuthor("");
  clipState.setUploadDate("");
  clipState.setSubtitles([]);
  clipState.setSelectedSubtitleId("");
  clipState.setSelectedSubtitleUrl("");
  clipState.setSelectedSubtitleLang("");
  clipState.setSubtitleBody([]);
  if (!keepFetchState) {
    clipState.setSubtitleFetchState("idle");
  }
  clipState.setNoSubtitleReason(null);
  clipState.setChapters([]);
  clipState.setHotComments([]);
  clipState.setMarkdown("");
  clipState.setSrt("");
  clipState.setTxt("");
  clipState.setCurrentClipSignature(computeCurrentClipSignature());
  notifyReaderPresenter("reset");
  state.reader.setActiveSubtitleIndex(-1);
  state.reader.setActiveChapterIndex(-1);
  state.reader.readingVideoEl = null;

  setMessage("");
  if (isReaderViewOpen()) {
    notifyReaderPresenter("rerender");
    notifyReaderPresenter("status", "请先点击“刷新抓取”加载当前视频字幕。");
  }
}

export async function refreshClip(): Promise<void> {
  const runId = state.clip.fetchRunId + 1;
  clipState.setFetchRunId(runId);
  try {
    setMessage("");
    setStatus("正在抓取视频信息...");
    clipState.setSubtitleFetchState("loading");
    if (isReaderViewOpen()) {
      notifyReaderPresenter("rerender");
    }
    state.setSettings(await getSettings());
    ensureRunActive(runId, state.clip.fetchRunId);

    await resolveClipMeta(runId);

    setStatus("正在获取可用字幕...");
    const subtitleBundle = await retryAsync(
      () => gatewayFetchSubtitleBundle(contentFetchJson, {
        bvid: state.clip.bvid,
        cid: state.clip.cid,
        aid: state.clip.aid
      }),
      3,
      500
    );
    ensureRunActive(runId, state.clip.fetchRunId);
    clipState.setSubtitles(normalizeSubtitleTracks(subtitleBundle.tracks) as unknown as SubtitleOption[]);
    clipState.setChapters(normalizeChapters(subtitleBundle.chapters) as import("../core/state.js").ChapterItem[]);
    logInfo(
      "[BOC] chapters",
      state.clip.chapters.map((item) => ({
        from: item.from,
        to: item.to,
        title: item.title
      }))
    );
    logInfo(
      "[BOC] subtitle tracks",
      state.clip.subtitles.map((item) => ({
        id: item.id,
        lan: item.lan,
        lanDoc: item.lanDoc,
        url: item.subtitleUrl
      }))
    );

    // 显式点击“刷新抓取”时默认走网络，避免命中历史缓存导致字幕错位。
    const forceRefresh = true;

    const preferred = await selectSubtitleTrack(runId);
    if (!preferred) {
      return;
    }

    const candidates = buildSubtitleCandidates(state.clip.subtitles as unknown as SubtitleTrack[], preferred);
    let selected: SubtitleTrack | null = null;

    try {
      selected = await tryLoadSubtitleCandidates(candidates, runId, forceRefresh);
    } catch (error) {
      const message = getErrorMessage(error, "");
      if (!message.includes("HTTP") && (error as { code?: string }).code !== "SUBTITLE_DURATION_MISMATCH") {
        throw error;
      }

      // Retry because subtitle signed URLs may expire quickly or hit rate limit.
      selected = await retryWithFreshBundle({ retryReason: error, preferred, runId, forceRefresh });
    }
    ensureRunActive(runId, state.clip.fetchRunId);
    if (selected) {
      logInfo("[BOC] selected subtitle track", {
        id: selected.id,
        lan: selected.lan,
        lanDoc: selected.lanDoc
      });
    }
    // fetchState/reason 已由 tryLoadSubtitleCandidates → loadSubtitle 内的
    // 字幕接受事务（commit.acceptSubtitle）落位（ready + 清原因），渲染也由
    // 事务内的 subtitle-ready 通知驱动（唯一 emit 点，此处补发即双渲染），
    // 这里只做完成提示。提示走 reader-bus "status" 通知（与渲染同通道、由
    // reader 侧同序收敛），不经 setStatus 直写——直写会绕过门控，在渲染缺席
    // 时先行宣告成功（「抓取完成但显示无字幕」的文案半边）。
    notifyReaderPresenter("status", "抓取完成，可以复制或下载字幕。");
  } catch (error) {
    await handleClipFetchError(error, runId);
  }
}

// ===== refreshClip 三段纯提取（arch-review-2026-09/09，零行为变化）=====

// 段1 meta 解析：bvid 校验 → meta 抓取（带重试）→ clipState 基础信息写入 →
// 分 P / cid / duration 经 page-context seam 解析（时长缺失兜底
// readRuntimeVideoDuration，仍缺失则中止）→ resolved ids 日志。
async function resolveClipMeta(runId: number): Promise<void> {
  clipState.setBvid(extractBvid(location.href));
  if (!state.clip.bvid) {
    throw new Error("当前页面不是标准 BV 视频地址，无法抓取字幕。");
  }

  const meta = await retryAsync(() => gatewayFetchVideoMeta(contentFetchJson, state.clip.bvid), 2, 250);
  ensureRunActive(runId, state.clip.fetchRunId);

  // 调试：打印 API 返回的原始数据
  logInfo("[BOC] raw meta data", {
    meta,
    defaultCid: meta.defaultCid,
    pagesCount: (meta.pages || []).length
  });

  clipState.setAid(meta.aid || "");
  clipState.setTitle(meta.title || readVideoTitle());
  clipState.setAuthor(meta.author || readVideoAuthor());
  clipState.setUploadDate(meta.uploadDate || readUploadDate());
  clipState.setDescription(meta.description || readVideoDescription());
  clipState.setPageCount(Array.isArray(meta.pages) ? meta.pages.length : 0);
  clipState.setCurrentClipSignature(computeCurrentClipSignature());

  // 分 P / cid / duration 解析统一走 page-context seam；结果由本模块写入 state.clip。
  const pageContext = resolvePageContext(location.href, meta);
  const resolvedPageIndex = pageContext.pageIndex;
  clipState.setPageIndex(resolvedPageIndex);
  clipState.setPageTitle(pageContext.pageTitle);
  clipState.setCid(String(pageContext.cid || ""));
  clipState.setCidSource(pageContext.cidSource);
  clipState.setVideoDuration(Number(pageContext.duration || 0));
  if (!(state.clip.videoDuration > 0)) {
    clipState.setVideoDuration(readRuntimeVideoDuration());
  }
  if (!(state.clip.videoDuration > 0)) {
    throw new Error("无法获取当前视频时长，已停止抓取以避免串到错误字幕。");
  }

  logInfo("[BOC] resolved video ids", {
    url: location.href,
    aid: state.clip.aid,
    bvid: state.clip.bvid,
    cid: state.clip.cid,
    cidSource: state.clip.cidSource,
    pageIndex: resolvedPageIndex,
    videoDuration: state.clip.videoDuration
  });
}

// 段2 轨道选择：无字幕轨 / 无偏好轨两个守卫出口经 finishNoSubtitle 收尾
//（转写成果在 fallback 内经字幕接受事务落位后直接让调用方 return），返回选中
// 的偏好轨，null = 已走无字幕出口。
async function selectSubtitleTrack(runId: number): Promise<SubtitleTrack | null> {
  // 无字幕时也允许进入阅读视图，只是字幕区域保持空态。
  if (state.clip.subtitles.length === 0) {
    await finishNoSubtitle(runId);
    return null;
  }

  const preferred = pickPreferredSubtitle(state.clip.subtitles, {
    previousId: state.clip.selectedSubtitleId,
    previousUrl: state.clip.selectedSubtitleUrl,
    previousLang: state.clip.selectedSubtitleLang
  });

  if (!preferred) {
    await finishNoSubtitle(runId);
    return null;
  }
  return preferred;
}

// 段3 错误分类与 ASR 等待（refreshClip 的 catch 主体）：stale 让位 → 当前视频
// 有 ASR 转写进行中则等待共享转写继续收尾 → 其余落 reset+error 统一收尾，并按
// 错误类型分类文案（时长不匹配 vs 通用失败）。
async function handleClipFetchError(error: unknown, runId: number): Promise<void> {
  if (isStaleRunError(error)) {
    return;
  }
  // 当前视频有 ASR 转写进行中：本轮辅助抓取的失败绝不能清上下文（
  // resetClipState 会把 subtitleFetchState 置回 idle，等待转写的侧边栏轮询
  // 会误判"非转写中"提前放行空字幕）。改为等待共享转写结果继续收尾。
  // 探针按当前视频 bvid/cid 匹配——切走视频后仍在后台跑的其它视频转写
  // 不拦截本路径，其成果也不会串到当前 UI（转写与视频切换解耦，见
  // asr/fallback.js）。
  const asrFallbackInstance = await loadAsrFallbackOrNull();
  if (asrFallbackInstance?.hasActiveAsrTranscribe({ bvid: state.clip.bvid, cid: state.clip.cid })) {
    setStatus(`抓取失败：${getErrorMessage(error)}，继续等待音频转写…`);
    await asrFallbackInstance.awaitActiveAsrTranscribe({ runId, bvid: state.clip.bvid, cid: state.clip.cid });
    return;
  }
  // 586c61b 纪律：reset 全清会把 fetchState 洗回 idle（等待转写的侧边栏轮询
  // 会误判"非转写中"提前放行空字幕），错误路径以 keepFetchState 保住状态、
  // 再一次写 error，替代历史「error → reset → error」双写。
  resetClipState({ keepFetchState: true });
  clipState.setSubtitleFetchState("error");
  if (isReaderViewOpen()) {
    notifyReaderPresenter("rerender");
  }
  if ((error as { code?: string }).code === "SUBTITLE_DURATION_MISMATCH") {
    setStatus("抓取失败：未找到与当前视频时长匹配的字幕轨，可能该视频无可用字幕。");
    return;
  }
  setStatus(`抓取失败：${getErrorMessage(error)}`);
}

// 无字幕出口编排（refreshClip 两处守卫分支共用，原为逐行相同的两段手抄）：
// 先给 ASR 回退一个机会——done 时转写成果已在 fallback 内经字幕接受事务
//（commit.acceptSubtitle）收尾，这里直接 return；skip / empty / error 三种
// 都落回无字幕状态（逆事务 commit.commitNoSubtitle；状态栏失败/空结果文案
// 已由 fallback 各终态分支写好，事务只在 skip 分支补引导句）。STALE_RUN
//（发起前被顶掉 / 切走视频）原样上抛，由 refreshClip 的 catch 静默吞掉。
async function finishNoSubtitle(runId: number): Promise<void> {
  const { loadActiveAsrFallback } = await import("../asr/active-fallback.js");
  const asrResult = await (await loadActiveAsrFallback()).maybeRunAsrFallback({ runId });
  if (asrResult === "done") {
    return;
  }
  await commitNoSubtitle({ asrResult });
}

// 签名 URL 失效重试（refreshClip 的 catch 路径）：字幕签名 URL 可能快速过期
// 或触发限流，重抓 bundle 后重建轨道/章节、按原偏好重选轨并重试候选。与主
// 路径重复的 normalizeSubtitleTracks/normalizeChapters/setSubtitles/
// setChapters 四步收拢于此，避免双抄。无合适轨时抛出触发重试的原始错误，
// 交由 refreshClip 的错误路径统一收尾。
async function retryWithFreshBundle({
  retryReason,
  preferred,
  runId,
  forceRefresh
}: {
  retryReason: unknown;
  preferred: SubtitleTrack;
  runId: number;
  forceRefresh: boolean;
}): Promise<SubtitleTrack> {
  const bundle = await retryAsync(
    () =>
      gatewayFetchSubtitleBundle(contentFetchJson, {
        bvid: state.clip.bvid,
        cid: state.clip.cid,
        aid: state.clip.aid
      }),
    2,
    500
  );
  ensureRunActive(runId, state.clip.fetchRunId);
  clipState.setSubtitles(normalizeSubtitleTracks(bundle.tracks) as unknown as SubtitleOption[]);
  clipState.setChapters(normalizeChapters(bundle.chapters) as import("../core/state.js").ChapterItem[]);
  const retryPreferred = pickPreferredSubtitle(state.clip.subtitles, {
    previousId: preferred.id,
    previousUrl: preferred.subtitleUrl,
    previousLang: preferred.lanDoc || preferred.lan || ""
  });
  if (!retryPreferred) {
    throw retryReason;
  }
  const retryCandidates = buildSubtitleCandidates(state.clip.subtitles as unknown as SubtitleTrack[], retryPreferred);
  return tryLoadSubtitleCandidates(retryCandidates, runId, forceRefresh);
}

export async function loadSubtitle(
  url: string,
  lang: string,
  runId: number = state.clip.fetchRunId,
  subtitleId: string = "",
  forceRefresh: boolean = false
): Promise<void> {
  if (!url) {
    throw new Error("字幕 URL 为空。");
  }

  const cacheKey = getSubtitleCacheKey({
    bvid: state.clip.bvid,
    cid: state.clip.cid,
    subtitleId,
    subtitleUrl: url,
    lang
  });

  // 尝试从缓存读取
  if (!forceRefresh) {
    const cachedBody = await loadSubtitleFromCache(cacheKey);
    if (cachedBody && Array.isArray(cachedBody) && cachedBody.length > 0) {
      const cachedCheck = validateSubtitleByDuration(cachedBody, state.clip.videoDuration);
      if (!cachedCheck.ok) {
        logWarn("[BOC] cached subtitle duration mismatch, clearing cache", {
          cacheKey,
          reason: cachedCheck.reason
        });
        await clearSubtitleCacheByKey(cacheKey);
      } else {
        logInfo("[BOC] using cached subtitle", { cacheKey, itemCount: cachedBody.length });
        ensureRunActive(runId, state.clip.fetchRunId);
        // 字幕接受事务（commit.acceptSubtitle）：写 selected 三项 → ready →
        // 清原因 → 刷新派生 → 通知 reader，旧缓存条目可能无序，幂等稳定排序
        // 由事务单点完成（「subtitleBody 按 from 升序」不变量）。
        await acceptSubtitle({
          body: cachedBody,
          selectedSubtitleId: subtitleId ? String(subtitleId) : state.clip.selectedSubtitleId,
          selectedSubtitleUrl: url,
          selectedSubtitleLang: lang
        });
        return;
      }
    }
  }

  // 从网络获取
  const subtitle = await fetchSubtitleBody(url);
  ensureRunActive(runId, state.clip.fetchRunId);
  // 候选10 批1：B站 CC 接口返回的 body 实践上有序但接口并不承诺；在这里
  // （写入端）稳定排序一次，落缓存与落 state 都是有序副本，读路径不做排序。
  const body = sortSubtitleBodyByFrom(Array.isArray(subtitle.body) ? subtitle.body : []) as unknown[];
  if (body.length === 0) {
    throw new Error("字幕文件为空。");
  }
  const durationCheck = validateSubtitleByDuration(body, state.clip.videoDuration);
  if (!durationCheck.ok) {
    const mismatchError = new Error("字幕时长与当前视频不匹配。") as SubtitleDurationMismatchError;
    mismatchError.code = "SUBTITLE_DURATION_MISMATCH";
    mismatchError.details = durationCheck;
    throw mismatchError;
  }

  // 存入缓存（写入带 LRU 淘汰：失败先清理旧视频再重试一次）
  const saveResult = await saveSubtitleToCache(cacheKey, body);
  if (saveResult && saveResult.ok === false) {
    // 淘汰后重试仍失败：经既有消息栏一次性上浮，不阻断主流程。
    setMessage("字幕已加载，但本地缓存写入失败（已自动清理旧缓存仍失败），重启浏览器后需重新抓取。");
  }

  // 字幕接受事务（commit.acceptSubtitle）：body 已在上方落缓存前完成稳定排序
  //（事务内幂等再收口一次），写 selected 三项 → ready → 清原因 → 刷新派生 →
  // 通知 reader 全部由事务单点负责。
  await acceptSubtitle({
    body,
    selectedSubtitleId: subtitleId ? String(subtitleId) : state.clip.selectedSubtitleId,
    selectedSubtitleUrl: url,
    selectedSubtitleLang: lang
  });
}

// 无字幕提示文案（buildNoSubtitleStatusMessage）已随无字幕出口迁入
// subtitle/commit.js——它是无字幕出口事务的一部分，唯一消费点在该事务内。
//
// ASR 回退装配（broadcastSubtitleStatus / loadAsrProviderList / createAsrFallback
// deps 八项 / promise 缓存单例）已整体归位 asr/active-fallback.ts
//（arch-review-2026-09/09）。本模块只保留下方动态 import 边：加载失败按
//「无活动转写」降级（返回 null 继续原错误处理）——chunk 加载失败绝不能掩盖
// 原始抓取错误；加载成功后与原同步调用语义一致（awaitActiveAsrTranscribe 的
// 异常保持原样向上抛）。
async function loadAsrFallbackOrNull() {
  try {
    const { loadActiveAsrFallback } = await import("../asr/active-fallback.js");
    return await loadActiveAsrFallback();
  } catch (asrLoadError) {
    logWarn("[BOC] asr fallback module load failed; treat as no active transcribe", asrLoadError);
    return null;
  }
}
