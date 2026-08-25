import { setMessage } from "./message.js";
import { DEFAULT_SETTINGS, normalizeDownloadFormat } from "./shared-defaults.js";
import { state } from "./state.js";
import { extractBvid, extractPageIndex, computeCurrentClipSignature } from "./url-utils.js";
import { getSettings, byId } from "./runtime.js";
import { ensureRunActive, isStaleRunError, getErrorMessage, toReadableText } from "./error-helpers.js";
import {
  readVideoTitle,
  readVideoAuthor,
  readUploadDate
} from "./subtitle.js";
import {
  normalizeChapters,
  buildSubtitleCandidates,
  normalizeSubtitleTracks,
  pickPreferredSubtitle
} from "./formatters.js";
import {
  extractOid,
  hasExplicitPageParam,
  pickPageFromPages,
  pickCidFromPages,
  pickDurationFromPages,
  pickPageIndexFromOid,
  moveReadingMainInline
} from "./reader-page-frame.js";
import {
  logInfo,
  logWarn,
  shouldDebugLog,
  ids,
  hydrateReaderStateFromSettings,
  applyReadingViewPresentation,
  renderReadingView,
  closeReadingView,
  updateReaderPreferences,
  renderReaderPanels,
  renderReadingInfoPanel,
  bindReaderStepperControl,
  renderReadingStatus
} from "./reader-shell.js";
import {
  syncReadingViewPlayback,
  updateReaderFollowState,
  stopReadingViewSync,
  startReadingViewSync
} from "./reader-transcript-sync.js";
import {
  stopReaderPlayerObserver,
  startReaderPlayerObserver
} from "./reader-player-host.js";
import {
  renderMeta,
  renderSubtitleSelect,
  setBusyState,
  setStatus
} from "./ui-renderer.js";
import {
  retryAsync,
  fetchVideoMeta,
  fetchSubtitleBundle,
  getSubtitleCacheKey,
  fetchSubtitleBody,
  validateSubtitleByDuration,
  clearSubtitleCacheByKey,
  saveSubtitleToCache,
  loadSubtitleFromCache
} from "./subtitle-fetch.js";
import {
  readVideoDescription
} from "./subtitle-ui.js";
import { refreshDerivedContent } from "./note-build.js";

export const BOC_VERSION = "1.1.4";

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
  state.clip.bvid = "";
  state.clip.aid = "";
  state.clip.cid = "";
  state.clip.cidSource = "";
  state.clip.pageIndex = 1;
  state.clip.pageCount = 0;
  state.clip.pageTitle = "";
  state.clip.videoDuration = 0;
  state.clip.description = "";
  state.clip.title = "";
  state.clip.author = "";
  state.clip.uploadDate = "";
  state.clip.subtitles = [];
  state.clip.selectedSubtitleId = "";
  state.clip.selectedSubtitleUrl = "";
  state.clip.selectedSubtitleLang = "";
  state.clip.subtitleBody = [];
  state.clip.subtitleFetchState = "idle";
  state.clip.chapters = [];
  state.clip.hotComments = [];
  state.clip.markdown = "";
  state.clip.srt = "";
  state.clip.txt = "";
  state.clip.currentClipSignature = computeCurrentClipSignature();
  stopReadingViewSync();
  state.reader.readingActiveSubtitleIndex = -1;
  state.reader.readingActiveChapterIndex = -1;
  state.reader.readingVideoEl = null;
  stopReaderPlayerObserver();

  renderMeta();
  renderSubtitleSelect();
  byId(ids.preview).value = "";
  setMessage("");
  if (state.reader.readingViewOpen) {
    renderReadingView();
    renderReadingStatus("请先点击“刷新抓取”加载当前视频字幕。");
  }
}

export async function refreshClip() {
  const runId = ++state.clip.fetchRunId;
  try {
    setBusyState(true);
    setMessage("");
    setStatus("正在抓取视频信息...");
    state.clip.subtitleFetchState = "loading";
    if (state.reader.readingViewOpen) {
      renderReadingView();
    }
    state.settings = await getSettings();
    ensureRunActive(runId);

    state.clip.bvid = extractBvid(location.href);
    if (!state.clip.bvid) {
      throw new Error("当前页面不是标准 BV 视频地址，无法抓取字幕。");
    }

    const pageIndex = extractPageIndex(location.href);
    const oid = extractOid(location.href);
    const hasPageParam = hasExplicitPageParam(location.href);
    const meta = await retryAsync(() => fetchVideoMeta(state.clip.bvid), 2, 250);
    ensureRunActive(runId);

    // 调试：打印 API 返回的原始数据
    logInfo("[BOC] raw meta data", {
      meta,
      defaultCid: meta.defaultCid,
      pagesCount: (meta.pages || []).length
    });

    state.clip.aid = meta.aid || "";
    state.clip.title = meta.title || readVideoTitle();
    state.clip.author = meta.author || readVideoAuthor();
    state.clip.uploadDate = meta.uploadDate || readUploadDate();
    state.clip.description = meta.description || readVideoDescription();
    state.clip.pageCount = Array.isArray(meta.pages) ? meta.pages.length : 0;
    state.clip.currentClipSignature = computeCurrentClipSignature();
    let resolvedPageIndex = pageIndex;
    if ((meta.pages || []).length > 1 && !hasPageParam) {
      const pageIndexFromOid = pickPageIndexFromOid(meta.pages, oid, {
        aid: meta.aid,
        defaultCid: meta.defaultCid
      });
      if (pageIndexFromOid > 0) {
        resolvedPageIndex = pageIndexFromOid;
        logInfo("[BOC] resolved page index from oid", {
          oid,
          resolvedPageIndex
        });
      } else {
        // B 站多分P中，P1 常见为无 ?p= 参数；watchlater 等页面可能改用 oid 标识当前分P。
        resolvedPageIndex = 1;
        logInfo("[BOC] multi-page video without p param or valid oid, fallback to P1", {
          oid
        });
      }
    }

    const currentPage = pickPageFromPages(meta.pages, resolvedPageIndex);
    state.clip.pageIndex = resolvedPageIndex;
    state.clip.pageTitle = currentPage?.part || "";
    state.clip.cid = currentPage?.cid || pickCidFromPages(meta.pages, resolvedPageIndex, meta.defaultCid);
    state.clip.cidSource = "meta-pages";
    state.clip.videoDuration = pickDurationFromPages(meta.pages, resolvedPageIndex, meta.defaultDuration);
    if (!(state.clip.videoDuration > 0)) {
      state.clip.videoDuration = readRuntimeVideoDuration();
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
    state.clip.subtitles = normalizeSubtitleTracks(subtitleBundle.tracks);
    state.clip.chapters = normalizeChapters(subtitleBundle.chapters);
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
      if (state.reader.readingViewOpen) {
        moveReadingMainInline();
        renderReadingView();
        renderReadingStatus("当前视频无字幕。");
        startReadingViewSync();
        startReaderPlayerObserver();
        syncReadingViewPlayback(true);
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
      if (state.reader.readingViewOpen) {
        moveReadingMainInline();
        renderReadingView();
        renderReadingStatus("当前视频无字幕。");
        startReadingViewSync();
        startReaderPlayerObserver();
        syncReadingViewPlayback(true);
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
      state.clip.subtitles = normalizeSubtitleTracks(subtitleBundle.tracks);
      state.clip.chapters = normalizeChapters(subtitleBundle.chapters);
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
    state.clip.subtitleFetchState = "ready";
    renderMeta();
    renderSubtitleSelect();
    if (state.reader.readingViewOpen) {
      moveReadingMainInline();
      renderReadingView();
      renderReadingStatus("抓取完成，阅读视图已同步最新字幕。");
      startReadingViewSync();
      startReaderPlayerObserver();
      syncReadingViewPlayback(true);
    }
    setStatus("抓取完成，可以复制或下载字幕。");
  } catch (error) {
    if (isStaleRunError(error)) {
      return;
    }
    state.clip.subtitleFetchState = "error";
    resetClipState();
    state.clip.subtitleFetchState = "error";
    if (state.reader.readingViewOpen) {
      renderReadingView();
    }
    if (error?.code === "SUBTITLE_DURATION_MISMATCH") {
      setStatus("抓取失败：未找到与当前视频时长匹配的字幕轨，可能该视频无可用字幕。");
      return;
    }
    console.error("[BOC][t01-diag] refreshClip error", error);
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
        state.clip.selectedSubtitleId = subtitleId ? String(subtitleId) : state.clip.selectedSubtitleId;
        state.clip.selectedSubtitleUrl = url;
        state.clip.selectedSubtitleLang = lang;
        state.clip.subtitleBody = cachedBody;
        state.clip.subtitleFetchState = "ready";
        await refreshDerivedContent();
        if (state.reader.readingViewOpen) {
          renderReadingView();
          syncReadingViewPlayback(true);
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

  state.clip.selectedSubtitleId = subtitleId ? String(subtitleId) : state.clip.selectedSubtitleId;
  state.clip.selectedSubtitleUrl = url;
  state.clip.selectedSubtitleLang = lang;
  state.clip.subtitleBody = body;
  state.clip.subtitleFetchState = "ready";
  await refreshDerivedContent();
  if (state.reader.readingViewOpen) {
    renderReadingView();
    syncReadingViewPlayback(true);
  }
}


