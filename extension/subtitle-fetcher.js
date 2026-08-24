import { setMessage } from "./message.js";
import { DEFAULT_SETTINGS, normalizeDownloadFormat, sleep, formatLocalDate } from "./shared-defaults.js";
import { state, readerState, clipState, playerAiState, uiState } from "./state.js";
import {
  getSettings,
  byId,
  cleanVideoUrl,
  sendRuntimeMessage,
  requestOpenOptions,
  extractBvid,
  extractPageIndex,
  ensureRunActive,
  isStaleRunError,
  isRetryableNetworkError,
  computeCurrentClipSignature,
  getErrorMessage,
  findReaderPlayerHost,
  getRuntimeVideoElement,
  toReadableText
} from "./router.js";
import {
  readVideoTitle,
  readVideoAuthor,
  readUploadDate,
  rebuildDerivedContent
} from "./subtitle.js";
import {
  buildSubtitlePreview,
  escapeHtml,
  validateSubtitleByDuration,
  buildSubtitleSourceKey,
  clearSubtitleCacheByKey,
  saveSubtitleToCache,
  fetchSubtitleBody,
  fetchJson,
  fetchHotComments,
  buildMarkdown,
  buildSrt,
  buildTxt,
  getCurrentAid,
  normalizeHotComments,
  buildNoteFilename,
  buildFrontMatter,
  formatTimestamp,
  formatCompactTimestamp,
  normalizeSubtitleUrl,
  normalizeSubtitleUrlForCache,
  normalizeChapters,
  shouldShowHoursInNote,
  buildChapterLines,
  buildSubtitleSectionLines,
  buildHotCommentLines,
  pushOptionalLines,
  buildNotePlaceholderLines,
  buildFolderTemplateContext,
  buildFrontmatterTemplateContext,
  buildNotePlaceholderTemplateContext,
  buildSubtitleCandidates,
  buildSubtitleInfoRequests,
  groupNotePlaceholderSections,
  getEnabledFrontmatterFields,
  getFixedFrontmatterPropertyLines,
  isAiSubtitle,
  isRetryableError,
  isYamlDateValue,
  mapChaptersFromPlayerData,
  mapSubtitleTracks,
  normalizeChapterTime,
  normalizeFolder,
  normalizeNotePlaceholderSections,
  normalizeSubtitleTracks,
  parseFrontmatterArrayItems,
  pickPreferredSubtitle,
  readRuntimeVideoDuration,
  resolveFolderTemplate,
  resolveFrontmatterTemplateValue,
  sanitizeFileName,
  sanitizeFolderTemplateValue,
  shouldShowHoursInSubtitle,
  subtitlePriority,
  buildBiliApiError,
  buildBilibiliEmbedIframe,
  formatFixedPropertyYamlLine,
  formatSubtitleLine,
  loadSubtitleFromCache
} from "./formatters.js";
import {
  schedulePlayerAiQuickActionSync
} from "./player-ai.js";
import {
  logInfo,
  logWarn,
  shouldDebugLog,
  extractOid,
  hasExplicitPageParam,
  pickPageFromPages,
  pickCidFromPages,
  pickDurationFromPages,
  pickPageIndexFromOid
} from "./reader.js";

import {
  hydrateReaderStateFromSettings,
  applyReadingViewPresentation,
  renderReadingView,
  closeReadingView,
  syncReadingViewPlayback,
  updateReaderPreferences,
  renderReaderPanels,
  renderReadingInfoPanel,
  updateReaderFollowState,
  bindReaderStepperControl,
  ids,
  stopReadingViewSync,
  stopReaderPlayerObserver,
  startReadingViewSync,
  startReaderPlayerObserver,
  moveReadingMainInline,
  renderReadingStatus
} from "./reading-view-adapter.js";

import {
  renderMeta,
  renderSubtitleSelect,
  setBusyState,
  setStatus
} from "./ui-renderer.js";

export const BOC_VERSION = "1.1.4";
export const CACHE_KEY_PREFIX = "boc_subtitle_cache_";

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
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  logInfo("[BOC] fetch video meta", { url, bvid });
  const payload = await fetchJson(url);
  if (payload.code !== 0) {
    throw new Error(toReadableText(payload?.message, "无法获取视频信息"));
  }

  const data = payload.data || {};
  const pubdate = Number(data.pubdate || 0);
  const uploadDate = pubdate > 0 ? formatLocalDate(pubdate * 1000) : "";
  const pages = Array.isArray(data.pages) ? data.pages : [];

  return {
    aid: data.aid ? String(data.aid) : "",
    title: String(data.title || ""),
    author: String(data.owner?.name || ""),
    description: String(data.desc || ""),
    uploadDate,
    defaultCid: data.cid ? String(data.cid) : "",
    defaultDuration: Number(data.duration || 0) || 0,
    pages: pages.map((item) => ({
      cid: String(item.cid || ""),
      page: Number(item.page || 0) || 0,
      part: String(item.part || "").trim(),
      duration: Number(item.duration || 0) || 0
    }))
  };
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

export async function onSubtitleChange(event) {
  const value = event.target.value;
  const option = event.target.options[event.target.selectedIndex];
  const lang = option?.dataset.lang || "unknown";
  const subtitleId = option?.dataset.id || "";
  if (!value) {
    return;
  }

  try {
    setBusyState(true);
    setStatus(`正在切换字幕：${lang}`);
    setMessage("");
    await loadSubtitle(value, lang, state.clip.fetchRunId, subtitleId);
    setStatus("字幕切换完成。");
  } catch (error) {
    if (isStaleRunError(error)) {
      return;
    }
    setStatus(`切换字幕失败：${getErrorMessage(error)}`);
  } finally {
    setBusyState(false);
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

export function getSubtitleCacheKey({ bvid, cid, subtitleId = "", subtitleUrl = "", lang = "" }) {
  const sourceKey = buildSubtitleSourceKey(subtitleId, subtitleUrl, lang);
  return `${CACHE_KEY_PREFIX}${bvid}_${cid}_${sourceKey}`;
}

export function getPopupPayload() {
  const subtitleOptions = (state.clip.subtitles || []).map((item) => {
    const label = item.lanDoc || item.lan || "unknown";
    const isAi = isAiSubtitle(item);
    const selectedById =
      state.clip.selectedSubtitleId && String(item.id) === String(state.clip.selectedSubtitleId);
    const selectedByUrl = item.subtitleUrl === state.clip.selectedSubtitleUrl;
    return {
      id: String(item.id || ""),
      url: item.subtitleUrl,
      lang: label,
      isAi,
      selected: selectedById || selectedByUrl
    };
  });

  return {
    contentVersion: BOC_VERSION,
    url: cleanVideoUrl(),
    title: state.clip.title || "",
    author: state.clip.author || "",
    uploadDate: state.clip.uploadDate || "",
    tags: String(state.settings?.tags || ""),
    status: state.ui.statusText || "",
    message: state.ui.messageText || "",
    subtitlePreview: buildSubtitlePreview(state.clip.subtitleBody || [], state.settings || DEFAULT_SETTINGS),
    markdown: state.clip.markdown || "",
    srt: state.clip.srt || "",
    txt: state.clip.txt || "",
    downloadFormat: normalizeDownloadFormat(state.settings?.downloadFormat),
    subtitleOptions
  };
}

export async function copyMarkdown() {
  state.settings = await getSettings();
  await refreshDerivedContent();
  if (!state.clip.markdown) {
    setMessage("没有可复制的内容，请先刷新抓取。");
    return;
  }

  try {
    await navigator.clipboard.writeText(state.clip.markdown);
    setMessage("Markdown 已复制到剪贴板。");
  } catch (error) {
    setMessage(`复制失败：${getErrorMessage(error)}`);
  }
}

export async function downloadSubtitle() {
  state.settings = await getSettings();
  rebuildDerivedContent();
  const format = normalizeDownloadFormat(state.settings?.downloadFormat);
  const content = format === "txt" ? state.clip.txt : state.clip.srt;
  if (!content) {
    setMessage("没有可下载的字幕，请先刷新抓取。");
    return;
  }

  const safeTitle = sanitizeFileName(state.clip.title || state.clip.bvid || "bilibili-subtitle");
  const langSuffix = sanitizeFileName(state.clip.selectedSubtitleLang || "subtitle") || "subtitle";
  const filename = `${safeTitle}.${langSuffix}.${format}`;
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  setMessage(`已下载：${filename}`);
}

export function applyNoSubtitleState() {
  state.clip.selectedSubtitleId = "";
  state.clip.selectedSubtitleUrl = "";
  state.clip.selectedSubtitleLang = "";
  state.clip.subtitleBody = [];
  state.clip.subtitleFetchState = "empty";
  state.clip.hotComments = [];
  state.clip.markdown = "";
  state.clip.srt = "";
  state.clip.txt = "";
  byId(ids.preview).value = "";
}

export function readVideoDescription() {
  const descNode = document.querySelector(
    ".desc-info-text, .video-desc .desc-info-text, .video-info-detail .text, .basic-desc-info"
  );
  return descNode?.textContent?.trim() || "";
}

export async function fetchSubtitleBundle(bvid, cid, aid = "") {
  const requests = buildSubtitleInfoRequests({ bvid, cid, aid });
  const fetchByRequest = async (request) => {
    logInfo("[BOC] fetch subtitles list", {
      source: request.source,
      url: request.url,
      bvid,
      cid,
      aid
    });

    const payload = await fetchJson(request.url);
    logInfo("[BOC] subtitles API raw response", { source: request.source, payload });
    if (payload.code !== 0) {
      throw buildBiliApiError(payload, "无法获取字幕列表");
    }

    const chapters = mapChaptersFromPlayerData(payload.data);
    const subtitles = mapSubtitleTracks(payload.data?.subtitle?.subtitles || [], request.source);
    const withUrl = subtitles.filter((item) => item.subtitleUrl);
    return { source: request.source, chapters, withUrl };
  };

  if (requests.length === 0) {
    return { tracks: [], chapters: [] };
  }

  const primaryRequest = requests[0];
  try {
    const primaryResult = await fetchByRequest(primaryRequest);
    if (primaryResult.withUrl.length > 0) {
      return { tracks: primaryResult.withUrl, chapters: primaryResult.chapters };
    }
    // 主来源成功但无字幕：直接判定无字幕，不再跨源兜底。
    return { tracks: [], chapters: primaryResult.chapters };
  } catch (primaryError) {
    logWarn("[BOC] subtitles API request failed", {
      source: primaryRequest.source,
      message: getErrorMessage(primaryError)
    });

    // 仅当主来源请求失败时才尝试次来源。
    if (requests.length > 1) {
      const secondaryRequest = requests[1];
      try {
        const secondaryResult = await fetchByRequest(secondaryRequest);
        if (secondaryResult.withUrl.length > 0) {
          logWarn("[BOC] primary subtitles source failed, using fallback source", {
            primary: primaryRequest.source,
            fallback: secondaryRequest.source
          });
          return { tracks: secondaryResult.withUrl, chapters: secondaryResult.chapters };
        }
        return { tracks: [], chapters: secondaryResult.chapters };
      } catch (secondaryError) {
        logWarn("[BOC] fallback subtitles source failed", {
          source: secondaryRequest.source,
          message: getErrorMessage(secondaryError)
        });
        throw secondaryError;
      }
    }

    throw primaryError;
  }
}

export async function refreshDerivedContent({ refreshComments = false } = {}) {
  if (state.settings?.includeHotCommentsInNote) {
    const shouldFetchComments =
      refreshComments || !Array.isArray(state.clip.hotComments) || state.clip.hotComments.length === 0;
    if (shouldFetchComments) {
      try {
        state.clip.hotComments = await fetchHotComments(20);
      } catch (error) {
        state.clip.hotComments = [];
        logWarn("[BOC] failed to fetch hot comments for note export", error);
      }
    }
  }

  rebuildDerivedContent();
}
