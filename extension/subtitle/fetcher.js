import { setMessage } from "../ui/ui-renderer.js";
import { DEFAULT_SETTINGS } from "../core/defaults.js";
import { normalizeDownloadFormat } from "../core/validators.js";
import { state, clipState } from "../core/state.js";
import { extractBvid, computeCurrentClipSignature } from "../bilibili/video-id-shared.js";
import { getSettings } from "../core/runtime.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { byId } from "../shared/dom-utils.js";
import { ensureRunActive, isStaleRunError, getErrorMessage, toReadableText, isRetryableNetworkError, retryAsync } from "../shared/error-helpers.js";
import { logInfo, logWarn } from "../shared/logging.js";
import { isReaderViewOpen } from "../reader/index.js";
import {
  readVideoTitle,
  readVideoAuthor,
  readUploadDate,
  refreshDerivedContent
} from "./core.js";
import {
  normalizeChapters,
  normalizeSubtitleTracks,
  pickPreferredSubtitle,
  sortSubtitleBodyByFrom,
  validateSubtitleByDuration
} from "./selection.js";
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
  renderMeta,
  renderSubtitleSelect,
  setBusyState,
  setStatus
} from "../ui/ui-renderer.js";
import {
  fetchVideoMeta as gatewayFetchVideoMeta,
  fetchSubtitleBundle as gatewayFetchSubtitleBundle,
  fetchSubtitleBody,
  readRuntimeVideoDuration,
  contentFetchJson
} from "../bilibili/gateway.js";
import {
  readVideoDescription,
  applyNoSubtitleState
} from "./ui.js";
// runAsrPipeline 仅作为注入实参传给 asr/fallback 工厂（回退策略簇本体已迁出；
// pipeline 传递闭包含 runtime→fetcher，不能由 fallback 直 import，故由本模块
// 作为组合根提供）。此依赖为单向边，import 环 A 不再成立。
import { runAsrPipeline } from "../asr/pipeline.js";
import { createAsrFallback } from "../asr/fallback.js";

// The fetcher is always loaded at startup through the message-handler / entry
// chain, so registering here is the only wiring needed: the reader side can
// trigger a re-fetch through the presenter seam's requestSubtitleRefresh().
subscribeSubtitleRefresh(refreshClip);

export async function fetchVideoMeta(bvid) {
  logInfo("[BOC] fetch video meta", {
    url: `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    bvid
  });
  return gatewayFetchVideoMeta(contentFetchJson, bvid);
}

export async function fetchSubtitleBundle(bvid, cid, aid = "") {
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

export async function tryLoadSubtitleCandidates(candidates, runId, forceRefresh) {
  let lastError = null;
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
      const reasonCode = toReadableText(error?.code, "");
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

export function resetClipState() {
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
  clipState.setSubtitleFetchState("idle");
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
  byId("boc-preview").value = "";
  setMessage("");
  if (isReaderViewOpen()) {
    notifyReaderPresenter("rerender");
    notifyReaderPresenter("status", "请先点击“刷新抓取”加载当前视频字幕。");
  }
}

export async function refreshClip() {
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
    clipState.setCid(pageContext.cid);
    clipState.setCidSource(pageContext.cidSource);
    clipState.setVideoDuration(pageContext.duration);
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
    let subtitleBundle = await retryAsync(
      () => fetchSubtitleBundle(state.clip.bvid, state.clip.cid, state.clip.aid),
      3,
      500
    );
    ensureRunActive(runId);
    clipState.setSubtitles(normalizeSubtitleTracks(subtitleBundle.tracks));
    clipState.setChapters(normalizeChapters(subtitleBundle.chapters));
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
      const asrResult = await asrFallback.maybeRunAsrFallback({ runId });
      if (asrResult === "done") {
        return;
      }
      // skip：未配置/开关关闭，提示带引导句；empty：未识别到语音内容
      // （文案已由 maybeRunAsrFallback 写入状态栏，这里不再覆盖）；
      // error：失败兜底（文案同样已写入）。三种都落回无字幕状态。
      applyNoSubtitleState();
      renderMeta();
      renderSubtitleSelect();
      if (isReaderViewOpen()) {
        notifyReaderPresenter("subtitle-ready", "当前视频无字幕。");
      }
      if (asrResult === "skip") {
        setStatus(buildNoSubtitleStatusMessage());
      }
      return;
    }

    // 显式点击“刷新抓取”时默认走网络，避免命中历史缓存导致字幕错位。
    const forceRefresh = true;

    const preferred = pickPreferredSubtitle(state.clip.subtitles, {
      previousId: state.clip.selectedSubtitleId,
      previousUrl: state.clip.selectedSubtitleUrl,
      previousLang: state.clip.selectedSubtitleLang
    });

    if (!preferred) {
      const asrResult = await asrFallback.maybeRunAsrFallback({ runId });
      if (asrResult === "done") {
        return;
      }
      applyNoSubtitleState();
      renderMeta();
      renderSubtitleSelect();
      if (isReaderViewOpen()) {
        notifyReaderPresenter("subtitle-ready", "当前视频无字幕。");
      }
      if (asrResult === "skip") {
        setStatus(buildNoSubtitleStatusMessage());
      }
      return;
    }

    const candidates = buildSubtitleCandidates(state.clip.subtitles, preferred);
    let selected = null;

    try {
      selected = await tryLoadSubtitleCandidates(candidates, runId, forceRefresh);
    } catch (error) {
      const message = getErrorMessage(error, "");
      if (!message.includes("HTTP") && error?.code !== "SUBTITLE_DURATION_MISMATCH") {
        throw error;
      }

      // Retry because subtitle signed URLs may expire quickly or hit rate limit.
      subtitleBundle = await retryAsync(
        () => fetchSubtitleBundle(state.clip.bvid, state.clip.cid, state.clip.aid),
        2,
        500
      );
      ensureRunActive(runId);
      clipState.setSubtitles(normalizeSubtitleTracks(subtitleBundle.tracks));
      clipState.setChapters(normalizeChapters(subtitleBundle.chapters));
      const retryPreferred = pickPreferredSubtitle(state.clip.subtitles, {
        previousId: preferred.id,
        previousUrl: preferred.subtitleUrl,
        previousLang: preferred.lanDoc || preferred.lan || ""
      });
      if (!retryPreferred) {
        throw error;
      }
      const retryCandidates = buildSubtitleCandidates(state.clip.subtitles, retryPreferred);
      selected = await tryLoadSubtitleCandidates(retryCandidates, runId, forceRefresh);
    }
    ensureRunActive(runId);
    if (selected) {
      logInfo("[BOC] selected subtitle track", {
        id: selected.id,
        lan: selected.lan,
        lanDoc: selected.lanDoc
      });
    }
    clipState.setSubtitleFetchState("ready");
    clipState.setNoSubtitleReason(null);
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
    if (asrFallback.hasActiveAsrTranscribe({ bvid: state.clip.bvid, cid: state.clip.cid })) {
      setStatus(`抓取失败：${getErrorMessage(error)}，继续等待音频转写…`);
      await asrFallback.awaitActiveAsrTranscribe({ runId, bvid: state.clip.bvid, cid: state.clip.cid });
      return;
    }
    clipState.setSubtitleFetchState("error");
    resetClipState();
    clipState.setSubtitleFetchState("error");
    if (isReaderViewOpen()) {
      notifyReaderPresenter("rerender");
    }
    if (error?.code === "SUBTITLE_DURATION_MISMATCH") {
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

export async function loadSubtitle(url, lang, runId = state.clip.fetchRunId, subtitleId = "", forceRefresh = false) {
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
        clipState.setSelectedSubtitleId(subtitleId ? String(subtitleId) : state.clip.selectedSubtitleId);
        clipState.setSelectedSubtitleUrl(url);
        clipState.setSelectedSubtitleLang(lang);
        // 候选10 批1：落 state 前稳定排序，保证「subtitleBody 按 from 升序」
        // 不变量（findActiveSubtitleIndex 二分依赖）；旧缓存条目可能无序。
        clipState.setSubtitleBody(sortSubtitleBodyByFrom(cachedBody));
        clipState.setSubtitleFetchState("ready");
        clipState.setNoSubtitleReason(null);
        await refreshDerivedContent();
        if (isReaderViewOpen()) {
          notifyReaderPresenter("subtitle-ready");
        }
        return;
      }
    }
  }

  // 从网络获取
  const subtitle = await fetchSubtitleBody(url);
  ensureRunActive(runId);
  // 候选10 批1：B站 CC 接口返回的 body 实践上有序但接口并不承诺；在这里
  // （写入端）稳定排序一次，落缓存与落 state 都是有序副本，读路径不做排序。
  const body = sortSubtitleBodyByFrom(Array.isArray(subtitle.body) ? subtitle.body : []);
  if (body.length === 0) {
    throw new Error("字幕文件为空。");
  }
  const durationCheck = validateSubtitleByDuration(body, state.clip.videoDuration);
  if (!durationCheck.ok) {
    const mismatchError = new Error("字幕时长与当前视频不匹配。");
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

  clipState.setSelectedSubtitleId(subtitleId ? String(subtitleId) : state.clip.selectedSubtitleId);
  clipState.setSelectedSubtitleUrl(url);
  clipState.setSelectedSubtitleLang(lang);
  clipState.setSubtitleBody(body);
  clipState.setSubtitleFetchState("ready");
  clipState.setNoSubtitleReason(null);
  await refreshDerivedContent();
  if (isReaderViewOpen()) {
    notifyReaderPresenter("subtitle-ready");
  }
}

// 无字幕提示（skip 分支）：基础文案 + 引导句。reason 取 clipState.noSubtitleReason
// （可显式传参覆盖）：未配置语音识别平台（no-asr-config）时引导用户去硅基流动
// 免费申请 API Key 并填入设置页；其余维持通用引导句。返回完整提示文案。
export function buildNoSubtitleStatusMessage(base = "当前视频无字幕。", reason = clipState.noSubtitleReason) {
  if (reason === "no-asr-config") {
    return `${base} 可免费申请硅基流动 API Key 并填入设置页，自动生成字幕。`;
  }
  return `${base} 可在设置页配置语音识别平台自动生成字幕。`;
}

// 把耗时阶段的变更广播给 popup / AI 侧边栏，让它们在各自等待抓取响应、
// 无法实时读取页内状态栏的情况下也能区分“抓取本地字幕”和“音频转写”。
// 仅广播阶段标记，文案由各端自行渲染；失败（扩展上下文关闭等）静默忽略。
function broadcastSubtitleStatus(phase) {
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
async function loadAsrProviderList() {
  try {
    const resp = await sendRuntimeMessage({ type: "asr-providers-list" });
    return Array.isArray(resp?.providers) ? resp.providers : [];
  } catch {
    return [];
  }
}

// ASR 回退策略簇（skip 闸门 / 缓存命中 / 并发共享去重 / 转写 / 收尾）已整体
// 迁至 asr/fallback.js（工厂 createAsrFallback，进行中的转写共享单元闭包在
// 工厂层）。此处注入运行时与 UI 依赖完成薄接线；broadcastSubtitleStatus 为
// 本模块内部函数（refreshClip 也在用），作为注入依赖传入。
const asrFallback = createAsrFallback({
  getSettings,
  loadProviders: loadAsrProviderList,
  setStatus,
  setMessage,
  applyNoSubtitleState,
  refreshDerivedContent,
  isReaderViewOpen,
  notifyReaderPresenter,
  runAsrPipeline,
  broadcastSubtitleStatus
});

// ASR 回退入口见 asr/fallback.js（createAsrFallback 工厂，本模块顶部接线为
// asrFallback 单例）。refreshClip 的无字幕出口与失败兜底经实例方法调用。

