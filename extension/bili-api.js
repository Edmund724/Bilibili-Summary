import { sendRuntimeMessage, isExtensionContextInvalidated } from "./runtime.js";
import { toReadableText } from "./error-helpers.js";
import { state } from "./state.js";
import { getRuntimeVideoElement } from "./video-probe.js";
import { logInfo } from "./logging.js";
import { normalizeHotComments } from "./bili-api-shared.js";


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
  return fetchJsonInBackground(url);
}

export async function fetchJson(url) {
  if (typeof url === "string" && url.startsWith("https://api.bilibili.com/")) {
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

  const url = `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=3&ps=${safeCount}&pn=1`;
  const resp = await sendRuntimeMessage({ type: "fetch-json", url });
  if (!resp?.ok) {
    throw new Error(resp?.error || "评论接口失败");
  }

  const replies = Array.isArray(resp?.data?.data?.replies) ? resp.data.data.replies : [];
  return normalizeHotComments(
    replies.map((item) => ({
      uname: item?.member?.uname || "匿名",
      like: item?.like || 0,
      message: item?.content?.message || ""
    })),
    safeCount
  );
}
