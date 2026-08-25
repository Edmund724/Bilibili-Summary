import { sleep, formatLocalDate } from "./shared-defaults.js";
import { toReadableText, getErrorMessage, isRetryableNetworkError } from "./error-helpers.js";
import { logInfo, logWarn } from "./reader-shell.js";
import { state } from "./state.js";
import { fetchJson } from "./bili-api.js";
import {
  buildSubtitleInfoRequests,
  buildBiliApiError
} from "./bili-api-shared.js";
import { buildSubtitleSourceKey } from "./subtitle-cache.js";
import {
  mapChaptersFromPlayerData,
  mapSubtitleTracks
} from "./subtitle-selection.js";

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

export function getSubtitleCacheKey({ bvid, cid, subtitleId = "", subtitleUrl = "", lang = "" }) {
  const sourceKey = buildSubtitleSourceKey(subtitleId, subtitleUrl, lang);
  return `${CACHE_KEY_PREFIX}${bvid}_${cid}_${sourceKey}`;
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
