import { sendRuntimeMessage, isExtensionContextInvalidated } from "../core/runtime.js";
import { toReadableText } from "../shared/error-helpers.js";
import { state } from "../core/state.js";
import { getRuntimeVideoElement } from "./video-probe.js";
import { logInfo } from "../shared/logging.js";
import { fetchSubtitleBody as gatewayFetchSubtitleBody, fetchHotComments as gatewayFetchHotComments, isBiliUrl } from "../bili-gateway.js";


export function readRuntimeVideoDuration() {
  const video = getRuntimeVideoElement();
  const duration = Number(video?.duration);
  if (Number.isFinite(duration) && duration > 0) {
    return duration;
  }
  return 0;
}

export async function fetchSubtitleBody(url) {
  logInfo("[BOC] fetch subtitle body", { url });
  const body = await gatewayFetchSubtitleBody(contentFetchJson, url);
  return { body };
}

export async function fetchJson(url) {
  if (isBiliUrl(url)) {
    return fetchJsonInBackground(url);
  }

  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`请求失败：${response.status}`);
  }

  return response.json();
}

// Content-side transport seam for bili-gateway: routes B站 requests
// (api.bilibili.com / hdslb.com) through the background service worker
// (sendRuntimeMessage "fetch-json") so they carry the B站 request headers and
// bypass page CORS, falling back to a direct in-page fetch for other URLs.
// Injected into bili-gateway as `transport`.
export async function contentFetchJson(url) {
  return fetchJson(url);
}

export async function fetchJsonInBackground(url) {
  try {
    const resp = await sendRuntimeMessage({ type: "fetch-json", url });
    if (!resp?.ok) {
      throw new Error(toReadableText(resp?.error, "Background fetch failed"));
    }
    return resp.data;
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      throw new Error("扩展刚刚更新，请刷新当前页面后重试。");
    }
    throw error;
  }
}


export function getCurrentAid() {
  let aid = Number(state.clip.aid) || 0;
  if (!aid && typeof window !== "undefined") {
    try {
      aid = Number(window?.__INITIAL_STATE__?.aid) || 0;
    } catch {}
  }
  return aid;
}

export async function fetchHotComments(count = 20) {
  const safeCount = Math.max(0, Number(count) || 0);
  if (!safeCount) {
    return [];
  }

  const aid = getCurrentAid();
  if (!aid) {
    return [];
  }

  return gatewayFetchHotComments(contentFetchJson, aid, safeCount);
}
