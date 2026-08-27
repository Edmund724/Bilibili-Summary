import { setMessage } from "../ui/ui-renderer.js";
import { DEFAULT_SETTINGS, normalizeDownloadFormat, sleep } from "../core/shared-defaults.js";
import { state, clipState } from "../core/state.js";
import { extractBvid, computeCurrentClipSignature } from "../bilibili/video-id-shared.js";
import { getSettings, byId } from "../core/runtime.js";
import { ensureRunActive, isStaleRunError, getErrorMessage, toReadableText, isRetryableNetworkError } from "../shared/error-helpers.js";
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
import {
  loadAsrProviders,
  getAsrProviderKey
} from "../asr/asr-provider-store.js";
import { runAsrPipeline } from "../asr/pipeline.js";

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
      const asrResult = await maybeRunAsrFallback({ runId });
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
      const asrResult = await maybeRunAsrFallback({ runId });
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

// 无字幕提示（skip 分支）：基础文案 + 引导句——用户可去设置页配置语音识别
// 平台自动生成字幕。返回完整提示文案。
export function buildNoSubtitleStatusMessage(base = "当前视频无字幕。") {
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

// 无字幕轨时的语音识别回退入口。流程：
//   skip（未启用开关 / 无激活平台）→ 返回 "skip"，调用方走原有无字幕提示
//   （提示文案已追加引导句，见 applyNoSubtitleState 调用处）；
//   缓存命中 → 直接走成功收尾（不发 playurl、不下载、不转写）；
//   成功 → 塞伪轨道 + setSubtitleBody + ready + 写缓存，返回 "done"；
//   空结果 / 失败 → 落回 applyNoSubtitleState 并展示对应文案。
// runId 全程守卫：切换视频后旧任务立即中止（pipeline 内每步检查）。
async function maybeRunAsrFallback({ runId }) {
  try {
    ensureRunActive(runId);

    // 设置判定：开关未启用或没有激活平台 → skip（与现状行为一致，仅文案变化）
    const settings = state.settings || (await getSettings());
    const enabled = settings.asrAutoFallback === true;
    const activeId = String(settings.activeAsrProviderId || "").trim();
    if (!enabled || !activeId) {
      return "skip";
    }
    const providers = await loadAsrProviders();
    ensureRunActive(runId);
    const activeProvider = (providers || []).find((p) => p.id === activeId);
    if (!activeProvider) {
      return "skip";
    }

    // 组装 provider（含已存 Key），准备跑管线
    const apiKey = await getAsrProviderKey(activeId);
    ensureRunActive(runId);
    const provider = { ...activeProvider, apiKey };
    // 生效转写语言：全局 asrLanguage 设置（popup 顶部切换，默认 auto）。
    // auto 不传语言参数，交服务端自动检测。
    provider.language = settings.asrLanguage || "auto";
    const platformName = provider.name || "语音识别平台";
    const model = String(provider.model || "").trim();
    const cacheKey = getSubtitleCacheKey({
      bvid: state.clip.bvid,
      cid: state.clip.cid,
      subtitleId: `asr:${activeId}:${model}:${provider.language}`
    });

    // 缓存命中：直接收尾（校验通过才用，不通过则清掉重新生成）
    const cachedBody = await loadSubtitleFromCache(cacheKey);
    ensureRunActive(runId);
    if (cachedBody && Array.isArray(cachedBody) && cachedBody.length > 0) {
      const cachedCheck = validateSubtitleByDuration(cachedBody, state.clip.videoDuration);
      if (cachedCheck.ok) {
        clipState.setSelectedSubtitleId("asr");
        clipState.setSelectedSubtitleUrl("");
        clipState.setSelectedSubtitleLang(`语音识别（${platformName}）`);
        clipState.setSubtitleBody(cachedBody);
        clipState.setSubtitleFetchState("ready");
        await refreshDerivedContent();
        if (isReaderViewOpen()) {
          notifyReaderPresenter("subtitle-ready");
        }
        setStatus("语音识别完成（缓存命中）。");
        return "done";
      }
      logWarn("[BOC] cached asr subtitle duration mismatch, clearing cache", {
        cacheKey,
        reason: cachedCheck.reason
      });
      await clearSubtitleCacheByKey(cacheKey);
      ensureRunActive(runId);
    }

    setStatus(`无字幕轨，正在使用语音识别（${platformName}）生成字幕…`);
    broadcastSubtitleStatus("asr-transcribing");
    let emptyDiag = "";
    const body = await runAsrPipeline({
      bvid: state.clip.bvid,
      cid: state.clip.cid,
      durationSec: state.clip.videoDuration,
      provider,
      runId,
      onProgress: (msg) => setStatus(msg),
      onEmptyDiagnostic: (diagText) => {
        emptyDiag = diagText;
      }
    });
    ensureRunActive(runId);

    // 空结果：全部为空白 → 返回 "empty"，调用点呈现"未识别到语音内容"文案；
    // 有诊断信息时直接拼进状态栏，用户转述即可定位问题层
    if (!Array.isArray(body) || body.length === 0) {
      setStatus(
        `未识别到语音内容，该视频可能没有人声。${emptyDiag ? `（诊断：${emptyDiag}）` : ""}`
      );
      return "empty";
    }

    // 成功收尾：塞伪轨道 → body → ready → 派生内容 → 写缓存 → 完成提示
    clipState.setSubtitles([
      { id: "asr", lan: "asr-zh", lanDoc: `语音识别（${platformName}）`, subtitleUrl: "" },
      ...(state.clip.subtitles || [])
    ]);
    clipState.setSelectedSubtitleId("asr");
    clipState.setSelectedSubtitleUrl("");
    clipState.setSelectedSubtitleLang(`语音识别（${platformName}）`);
    clipState.setSubtitleBody(body);
    clipState.setSubtitleFetchState("ready");
    await refreshDerivedContent();
    if (isReaderViewOpen()) {
      notifyReaderPresenter("subtitle-ready");
    }
    await saveSubtitleToCache(cacheKey, body);
    setStatus(`语音识别完成，已生成 ${body.length} 条字幕。`);
    return "done";
  } catch (error) {
    // 失败兜底：错误文案进状态，不崩；落回原有无字幕状态
    if (isStaleRunError(error)) {
      throw error;
    }
    setStatus(`语音识别失败：${getErrorMessage(error)}`);
    applyNoSubtitleState();
    return "error";
  }
}


