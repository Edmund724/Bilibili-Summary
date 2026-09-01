// 候选03 常驻瘦身：setMessage / setStatus 迁入 shared/ui-status.js。
import { setMessage, setStatus } from "../shared/ui-status.js";
import { DEFAULT_SETTINGS } from "../core/defaults.js";
import { normalizeDownloadFormat } from "../core/validators.js";
import { state, clipState } from "../core/state.js";
import type { SubtitleOption } from "../core/state.js";
import { extractBvid, computeCurrentClipSignature } from "../bilibili/video-id-shared.js";
import { getSettings } from "../core/runtime.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { byId } from "../shared/dom-utils.js";
import {
  ensureRunActive,
  isStaleRunError,
  getErrorMessage,
  toReadableText,
  isRetryableNetworkError,
  retryAsync
} from "../shared/error-helpers.js";
import { logInfo, logWarn } from "../shared/logging.js";
import { createLazyLoader } from "../shared/lazy-import.js";
// isReaderViewOpen 位于 reader 状态微模块（候选04 结构归并）：纯 state 读取，
// 不再经 reader/index.js facade 静态转发（否则整条 reader 域会被拖进本链闭包）。
import { isReaderViewOpen } from "../reader/state.js";
// PR3：boc-subtitle-status 广播的进程内镜像（零依赖叶子）——reader 同进程的
// 转写中间态呈现经它读取/订阅（content script 收不到自己的 runtime 广播）。
import { publishSubtitleStatusPhase } from "../shared/subtitle-status-bus.js";
import { readVideoTitle, readVideoAuthor, readUploadDate } from "./core.js";
import {
  normalizeChapters,
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
import { notifyReaderPresenter, subscribeSubtitleRefresh } from "../reader/presenter.js";
import {
  // 候选02 分层惰性：renderMeta/renderSubtitleSelect/setBusyState 已自
  // ui-renderer 移入链层（./ui.js，见该文件头注）。setStatus/setMessage 仍在
  // ui-renderer——URL 变化编排等常驻侧路径也在用，不能随链下放。
  renderMeta,
  renderSubtitleSelect,
  setBusyState,
  readVideoDescription
} from "./ui.js";
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
import type { SubtitleTrack, Chapter, VideoMeta } from "../bilibili/gateway.js";
import type { AsrFallback, AsrProviderMeta, CreateAsrFallbackDeps } from "../asr/fallback.js";

interface SubtitleDurationMismatchError extends Error {
  code: "SUBTITLE_DURATION_MISMATCH";
  details: DurationValidationResult;
}

// ASR 域（pipeline + fallback 及其专属依赖 audio-source/offscreen-bridge.page）
// 经动态 import 按需加载（候选4 分包）：只有视频无 CC 字幕时才需要语音转写。
// runAsrPipeline 仅作为注入实参传给 asr/fallback 工厂（回退策略簇本体已迁出；
// pipeline 传递闭包含 runtime→fetcher，不能由 fallback 直 import，故由本模块
// 作为组合根提供）。此依赖为单向边，import 环 A 不再成立。分包前这些模块随
// 单文件 bundle 常驻；分包后成为动态 import 边被切进 entry/chunks/。
// 实例缓存与失败重试语义见 loadAsrFallback()。

// The fetcher is lazily loaded as part of the summarize chain (候选02 分层惰性
// ，见 subtitle/lazy.js): the presenter-seam registration below used to be a
// module-level side effect, which relied on "fetcher is always loaded at
// startup" — no longer true once the chain is on-demand. Registration now
// binds to chain loading: initSummarizeChain() runs once on the
// ensureSummarizeChain() success path (subscribeSubtitleRefresh 自带去重，
// 重复调用安全), so the reader side can trigger a re-fetch through the
// presenter seam's requestSubtitleRefresh() as soon as the chain is loaded.
export function initSummarizeChain(): void {
  subscribeSubtitleRefresh(refreshClip);
}

// 字幕接受事务的渲染/状态栏回调接线（CONTEXT.md：DOM 渲染回调由 fetcher 注入，
// 保持静态图无环）。放在模块求值期执行：本模块任何导出可被调用前必然完成，
// loadAsrFallback 注入的 commitNoSubtitle 也因此保证先接线后可用。
configureCommitUi({
  renderMeta,
  renderSubtitleSelect,
  setStatus
});

export async function fetchVideoMeta(bvid: string): Promise<VideoMeta> {
  logInfo("[BOC] fetch video meta", {
    url: `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    bvid
  });
  return gatewayFetchVideoMeta(contentFetchJson, bvid);
}

export async function fetchSubtitleBundle(
  bvid: string,
  cid: string,
  aid = ""
): Promise<{ tracks: SubtitleTrack[]; chapters: Chapter[] }> {
  logInfo("[BOC] fetch subtitles list", { bvid, cid, aid });
  try {
    return await gatewayFetchSubtitleBundle(contentFetchJson, { bvid, cid, aid });
  } catch (error) {
    logWarn("[BOC] subtitles API request failed", {
      bvid,
      cid,
      aid,
      message: getErrorMessage(error)
    });
    throw error;
  }
}

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
      ensureRunActive(runId);
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

  renderMeta();
  renderSubtitleSelect();
  (byId("boc-preview") as HTMLTextAreaElement).value = "";
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
    setBusyState(true);
    setMessage("");
    setStatus("正在抓取视频信息...");
    clipState.setSubtitleFetchState("loading");
    if (isReaderViewOpen()) {
      notifyReaderPresenter("rerender");
    }
    state.setSettings(await getSettings());
    ensureRunActive(runId);

    clipState.setBvid(extractBvid(location.href));
    if (!state.clip.bvid) {
      throw new Error("当前页面不是标准 BV 视频地址，无法抓取字幕。");
    }

    const meta = await retryAsync(() => fetchVideoMeta(state.clip.bvid), 2, 250);
    ensureRunActive(runId);

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

    setStatus("正在获取可用字幕...");
    const subtitleBundle = await retryAsync(
      () => fetchSubtitleBundle(state.clip.bvid, state.clip.cid, state.clip.aid),
      3,
      500
    );
    ensureRunActive(runId);
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

    // 无字幕时也允许进入阅读视图，只是字幕区域保持空态。
    if (state.clip.subtitles.length === 0) {
      return finishNoSubtitle(runId);
    }

    // 显式点击“刷新抓取”时默认走网络，避免命中历史缓存导致字幕错位。
    const forceRefresh = true;

    const preferred = pickPreferredSubtitle(state.clip.subtitles, {
      previousId: state.clip.selectedSubtitleId,
      previousUrl: state.clip.selectedSubtitleUrl,
      previousLang: state.clip.selectedSubtitleLang
    });

    if (!preferred) {
      return finishNoSubtitle(runId);
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
    ensureRunActive(runId);
    if (selected) {
      logInfo("[BOC] selected subtitle track", {
        id: selected.id,
        lan: selected.lan,
        lanDoc: selected.lanDoc
      });
    }
    // fetchState/reason 已由 tryLoadSubtitleCandidates → loadSubtitle 内的
    // 字幕接受事务（commit.acceptSubtitle）落位（ready + 清原因），这里不再
    // 重写；以下只做选中轨渲染与完成提示。
    renderMeta();
    renderSubtitleSelect();
    if (isReaderViewOpen()) {
      notifyReaderPresenter("subtitle-ready");
    }
    setStatus("抓取完成，可以复制或下载字幕。");
  } catch (error) {
    if (isStaleRunError(error)) {
      return;
    }
    // 当前视频有 ASR 转写进行中：本轮辅助抓取的失败绝不能清上下文（
    // resetClipState 会把 subtitleFetchState 置回 idle，等待转写的侧边栏轮询
    // 会误判"非转写中"提前放行空字幕）。改为等待共享转写结果继续收尾。
    // 探针按当前视频 bvid/cid 匹配——切走视频后仍在后台跑的其它视频转写
    // 不拦截本路径，其成果也不会串到当前 UI（转写与视频切换解耦，见
    // asr/fallback.js）。
    // ASR 域懒加载（候选4 分包）：加载失败按「无活动转写」降级继续原错误
    // 处理——chunk 加载失败绝不能掩盖原始抓取错误。加载成功后与原同步调用
    // 语义一致（awaitActiveAsrTranscribe 的异常保持原样向上抛）。
    let asrFallbackInstance: AsrFallback | null = null;
    try {
      asrFallbackInstance = await loadAsrFallback();
    } catch (asrLoadError) {
      logWarn("[BOC] asr fallback module load failed; treat as no active transcribe", asrLoadError);
    }
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
  } finally {
    if (runId === state.clip.fetchRunId) {
      setBusyState(false);
    }
  }
}

// 无字幕出口编排（refreshClip 两处守卫分支共用，原为逐行相同的两段手抄）：
// 先给 ASR 回退一个机会——done 时转写成果已在 fallback 内经字幕接受事务
//（commit.acceptSubtitle）收尾，这里直接 return；skip / empty / error 三种
// 都落回无字幕状态（逆事务 commit.commitNoSubtitle；状态栏失败/空结果文案
// 已由 fallback 各终态分支写好，事务只在 skip 分支补引导句）。STALE_RUN
//（发起前被顶掉 / 切走视频）原样上抛，由 refreshClip 的 catch 静默吞掉。
async function finishNoSubtitle(runId: number): Promise<void> {
  const asrResult = await (await loadAsrFallback()).maybeRunAsrFallback({ runId });
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
    () => fetchSubtitleBundle(state.clip.bvid, state.clip.cid, state.clip.aid),
    2,
    500
  );
  ensureRunActive(runId);
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
        ensureRunActive(runId);
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
  ensureRunActive(runId);
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

// 把耗时阶段的变更广播给 popup / AI 侧边栏，让它们在各自等待抓取响应、
// 无法实时读取页内状态栏的情况下也能区分“抓取本地字幕”和“音频转写”。
// 仅广播阶段标记，文案由各端自行渲染；失败（扩展上下文关闭等）静默忽略。
//
// PR3：chrome.runtime.sendMessage 广播**不会回送给发送方所在的 content script
// 自己**（popup/sidepanel 等扩展上下文才收得到）——reader 与本编排同进程，靠
// 监听 onMessage 拿不到相位。故此处同步把相位发布进 shared/subtitle-status-bus
// （进程内镜像叶子），reader 域的转写中间态横幅经它读取/订阅；跨上下文场景
// 仍走原 chrome 广播，行为不变。
function broadcastSubtitleStatus(phase: string): void {
  publishSubtitleStatusPhase(phase);
  try {
    const promise = chrome.runtime.sendMessage({ type: "boc-subtitle-status", phase });
    if (promise && typeof promise.catch === "function") {
      promise.catch(() => {});
    }
  } catch {
    // 静默忽略：广播失败不影响抓取主流程。
  }
}

// ASR provider 列表（provider 元数据，无 Key）经 background 的 asr-providers-list
// 读取：asrProviders 已从 settings 快照摘除（save-settings 白名单不再落盘该键，
// 写回收口在 asr-providers-save），页面侧不碰 chrome.storage provider 存储。
// 消息失败按空列表降级：回退入口据此走 no-asr-config skip，与旧行为一致。
async function loadAsrProviderList(): Promise<AsrProviderMeta[]> {
  try {
    const resp = await sendRuntimeMessage({ type: "asr-providers-list" });
    return Array.isArray((resp as { providers?: unknown }).providers) ? (resp as { providers: AsrProviderMeta[] }).providers : [];
  } catch {
    return [];
  }
}

// ASR 回退策略簇（skip 闸门 / 缓存命中 / 并发共享去重 / 转写 / 收尾）已整体
// 迁至 asr/fallback.js（工厂 createAsrFallback，进行中的转写共享单元闭包在
// 工厂层）。此处注入运行时与 UI 依赖完成薄接线；字幕接受事务的两个入口
//（acceptSubtitle / commitNoSubtitle）与 broadcastSubtitleStatus（本模块内部
// 函数，refreshClip 也在用）一并作为注入依赖传入，保持 fallback → subtitle
// 事务层无静态边（与原 applyNoSubtitleState/refreshDerivedContent 注入同款）。
//
// 懒加载边界 c：工厂实例（asrFallback 单例）原为模块顶层创建，分包后顶层
// 静态 import 会把整个 ASR 域拖回常驻 chunk，因此改为首次调用时动态 import
// 再创建，promise 缓存（shared/lazy-import.js 的 createLazyLoader，与
// lazy-player-ai/lazy-reader/summarize-chain 加载器同款）保证单例（与原模块
// 级单例语义一致）；加载失败清空缓存允许重试。
const asrFallbackLoader = createLazyLoader(() =>
  Promise.all([
    import("../asr/pipeline.js"),
    import("../asr/fallback.js")
  ]).then(([{ runAsrPipeline }, { createAsrFallback }]) =>
    createAsrFallback({
      getSettings,
      loadProviders: loadAsrProviderList,
      setStatus,
      setMessage,
      acceptSubtitle,
      commitNoSubtitle,
      runAsrPipeline,
      broadcastSubtitleStatus
    })
  )
);

function loadAsrFallback(): Promise<AsrFallback> {
  return asrFallbackLoader.load();
}

// ASR 回退入口见 asr/fallback.js（createAsrFallback 工厂，本模块经
// loadAsrFallback() 惰性获取单例）。refreshClip 的无字幕出口与失败兜底经
// 实例方法调用。
