// extension/bili-gateway.js
// One deep B站 (Bilibili) fetch+map gateway, shared by the content script and the
// background service worker. It centralizes the request/response orchestration that
// previously lived in both subtitle-fetch.js and background.js, behind a transport seam.
//
// Contains ONLY pure orchestration + one pure transport (`bgFetchJson`). It has NO
// chrome.* APIs, NO DOM access, does NOT touch `state`, and does NOT call
// sendRuntimeMessage. The caller injects a `transport(url) -> Promise<json>`:
//   - content side: contentFetchJson (sendRuntimeMessage "fetch-json") from bili-api.js
//   - background side: bgFetchJson (direct fetch with B站 headers)
// so both sides share one implementation and avoid behavior drift.

import { formatLocalDate } from "./core/shared-defaults.js";
import { toReadableText } from "./shared/error-helpers.js";
import {
  buildSubtitleInfoRequests,
  buildBiliApiError,
  normalizeHotComments
} from "./bilibili/bili-api-shared.js";
import {
  mapChaptersFromPlayerData,
  mapSubtitleTracks
} from "./subtitle/selection.js";

// True for B站 request hosts (API + subtitle/CDN) that need the B站 request headers
// and should be routed through the background fetch handler. Shared by the transports.
export function isBiliUrl(url) {
  return /(?:api\.bilibili\.com|hdslb\.com)/.test(String(url || ""));
}

// ===== transport: direct fetch (background/service-worker side) =====

export async function bgFetchJson(url) {
  const headers = new Headers();
  const isBiliRequest = isBiliUrl(url);
  if (isBiliRequest) {
    headers.set("Accept", "application/json, text/plain, */*");
    headers.set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
    headers.set("Cache-Control", "no-cache");
    headers.set("Pragma", "no-cache");
  }

  const options = {
    method: "GET",
    credentials: "include",
    cache: "no-store"
  };
  if (headers.size > 0) {
    options.headers = headers;
  }
  if (isBiliRequest) {
    options.referrer = "https://www.bilibili.com/";
    options.referrerPolicy = "strict-origin-when-cross-origin";
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

// ===== gateway orchestration =====

export async function fetchVideoMeta(transport, bvid) {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  const payload = await transport(url);
  if (payload?.code !== 0) {
    throw new Error(toReadableText(payload?.message, "无法获取视频信息"));
  }

  const data = payload.data || {};
  const pubdate = Number(data.pubdate || 0);
  const uploadDate = pubdate > 0 ? formatLocalDate(pubdate * 1000) : "";
  const pages = Array.isArray(data.pages) ? data.pages : [];

  return {
    aid: String(data.aid || ""),
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

export async function fetchSubtitleBundle(transport, { bvid, cid, aid }) {
  const requests = buildSubtitleInfoRequests({ bvid, cid, aid });
  const fetchByRequest = async (request) => {
    const payload = await transport(request.url);
    if (payload?.code !== 0) {
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
    // 仅当主来源请求失败时才尝试次来源。
    if (requests.length > 1) {
      const secondaryRequest = requests[1];
      try {
        const secondaryResult = await fetchByRequest(secondaryRequest);
        if (secondaryResult.withUrl.length > 0) {
          return { tracks: secondaryResult.withUrl, chapters: secondaryResult.chapters };
        }
        return { tracks: [], chapters: secondaryResult.chapters };
      } catch (secondaryError) {
        throw secondaryError;
      }
    }

    throw primaryError;
  }
}

export async function fetchSubtitleBody(transport, url) {
  const payload = await transport(url);
  return Array.isArray(payload?.body) ? payload.body : [];
}

export async function fetchHotComments(transport, aid, count = 18) {
  const safeAid = Number(aid || 0) || 0;
  const safeCount = Math.max(0, Number(count) || 0);
  if (!safeAid || !safeCount) {
    return [];
  }

  const url = `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${safeAid}&mode=3&ps=${safeCount}&pn=1`;
  const payload = await transport(url).catch(() => null);
  const replies = Array.isArray(payload?.data?.replies) ? payload.data.replies : [];
  return normalizeHotComments(
    replies.map((item) => ({
      uname: item?.member?.uname || "匿名",
      like: item?.like || 0,
      message: item?.content?.message || ""
    })),
    safeCount
  );
}
