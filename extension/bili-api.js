import { sendRuntimeMessage, isExtensionContextInvalidated } from "./runtime.js";
import { toReadableText } from "./error-helpers.js";
import { state } from "./state.js";
import { getRuntimeVideoElement } from "./video-probe.js";
import { logInfo } from "./logging.js";


export function normalizeHotComments(comments, limit = 20) {
  if (!Array.isArray(comments)) {
    return [];
  }

  return comments
    .map((item) => ({
      uname: String(item?.uname || "匿名").trim() || "匿名",
      like: Number(item?.like || 0) || 0,
      message: String(item?.message || "").trim().slice(0, 500)
    }))
    .filter((item) => item.message)
    .slice(0, limit);
}


export function buildSubtitleInfoRequests({ bvid, cid, aid }) {
  const safeBvid = encodeURIComponent(String(bvid || ""));
  const safeCid = encodeURIComponent(String(cid || ""));
  const safeAid = encodeURIComponent(String(aid || ""));
  const requests = [];

  // 参考 SubBatch：优先用 aid+cid 的 wbi 接口作为主来源。
  if (aid) {
    requests.push({
      source: "player-wbi-v2",
      url:
        "https://api.bilibili.com/x/player/wbi/v2" +
        `?aid=${safeAid}` +
        `&cid=${safeCid}` +
        (bvid ? `&bvid=${safeBvid}` : "")
    });
  }

  // 仅在主来源不可用时再回退到 player-v2。
  requests.push({
    source: "player-v2",
    url:
      "https://api.bilibili.com/x/player/v2" +
      (bvid ? `?bvid=${safeBvid}` : "?") +
      `${bvid ? "&" : ""}cid=${safeCid}` +
      (aid ? `&aid=${safeAid}` : "")
  });

  return requests;
}


export function buildBiliApiError(payload, fallbackMessage) {
  const msg = toReadableText(payload?.message, fallbackMessage);
  const error = new Error(msg);
  error.code = payload?.code;
  error.retryable = isRetryableError(payload?.code);
  return error;
}


export function isRetryableError(code) {
  // -509: 请求过于频繁
  // -3: 参数错误（可能是临时性的）
  // 其他负数错误码也可能是临时性的
  return code === -509 || code === -3 || code < 0;
}


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
