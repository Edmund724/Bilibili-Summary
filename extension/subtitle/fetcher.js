import { setMessage } from "../ui/ui-message.js";
import { DEFAULT_SETTINGS, normalizeDownloadFormat, sleep } from "../core/shared-defaults.js";
import { state, clipState } from "../core/state.js";
import { extractBvid, computeCurrentClipSignature } from "../bilibili/url-utils.js";
import { getSettings, byId } from "../core/runtime.js";
import { ensureRunActive, isStaleRunError, getErrorMessage, toReadableText, isRetryableNetworkError } from "../shared/error-helpers.js";
import { logInfo, logWarn } from "../shared/logging.js";
import { isReaderViewOpen } from "../reader/index.js";
import {
  readVideoTitle,
  readVideoAuthor,
  readUploadDate
} from "./core.js";
import {
  normalizeChapters,
  normalizeSubtitleTracks,
  pickPreferredSubtitle,
  validateSubtitleByDuration
} from "./selection.js";
import {
  buildSubtitleCandidates,
  clearSubtitleCacheByKey,
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
import { refreshDerivedContent } from "../notes/build.js";

// The fetcher is always loaded at startup through the message-handler / entry
// chain, so registering here is the only wiring needed: the reader side can
// trigger a re-fetch through the presenter seam's requestSubtitleRefresh().
subscribeSubtitleRefresh(refreshClip);

export async function retryAsync(task, retries = 1, delayMs = 180) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const isNetworkError = isRetryableNetworkError(error);
      const isRetryable = error?.retryable === true;
      if (!isNetworkError && !isRetryable) {
        throw error;
      }
      if (attempt >= retries) {
        throw error;
      }
      const backoffDelay = Math.min(delayMs * Math.pow(2, attempt - 1), 5000);
      logInfo(`[BOC] retrying after ${backoffDelay}ms, attempt ${attempt + 1}/${retries}`, {
        error: getErrorMessage(error),
        code: error.code
      });
      await sleep(backoffDelay);
    }
  }
  throw lastError || new Error("Unknown retry error");
}

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
      applyNoSubtitleState();
      renderMeta();
      renderSubtitleSelect();
      if (isReaderViewOpen()) {
        notifyReaderPresenter("subtitle-ready", "当前视频无字幕。");
      }
      setStatus("当前视频无字幕。");
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
      applyNoSubtitleState();
      renderMeta();
      renderSubtitleSelect();
      if (isReaderViewOpen()) {
        notifyReaderPresenter("subtitle-ready", "当前视频无字幕。");
      }
      setStatus("当前视频无字幕。");
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
        clipState.setSubtitleBody(cachedBody);
        clipState.setSubtitleFetchState("ready");
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
  const body = Array.isArray(subtitle.body) ? subtitle.body : [];
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

  // 存入缓存
  await saveSubtitleToCache(cacheKey, body);

  clipState.setSelectedSubtitleId(subtitleId ? String(subtitleId) : state.clip.selectedSubtitleId);
  clipState.setSelectedSubtitleUrl(url);
  clipState.setSelectedSubtitleLang(lang);
  clipState.setSubtitleBody(body);
  clipState.setSubtitleFetchState("ready");
  await refreshDerivedContent();
  if (isReaderViewOpen()) {
    notifyReaderPresenter("subtitle-ready");
  }
}


