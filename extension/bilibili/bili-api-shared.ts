// extension/bili-api-shared.ts
// Pure B站 (Bilibili) API primitives shared between the content-script side
// and the background service worker. This module centralizes reusable request
// builders, response mappers, and error helpers so both sides reuse the same
// API primitives and avoid behavior drift.
//
// Contains ONLY pure functions. It has NO transport logic (no fetch, no
// sendRuntimeMessage, no Chrome/browser APIs) and does NOT touch `state`,
// `getRuntimeVideoElement`, `window`, or the DOM.

import { toReadableText } from "../shared/error-helpers.js";

export interface HotComment {
  uname: string;
  like: number;
  message: string;
}

export function normalizeHotComments(comments: unknown, limit = 20): HotComment[] {
  if (!Array.isArray(comments)) {
    return [];
  }

  return comments
    .map((item) => ({
      uname: String((item as { uname?: unknown })?.uname || "匿名").trim() || "匿名",
      like: Number((item as { like?: unknown })?.like || 0) || 0,
      message: String((item as { message?: unknown })?.message || "").trim().slice(0, 500)
    }))
    .filter((item) => item.message)
    .slice(0, limit);
}

export interface SubtitleInfoRequest {
  source: string;
  url: string;
}

export function buildSubtitleInfoRequests({
  bvid,
  cid,
  aid
}: {
  bvid?: string | number;
  cid?: string | number;
  aid?: string | number;
}): SubtitleInfoRequest[] {
  const safeBvid = encodeURIComponent(String(bvid || ""));
  const safeCid = encodeURIComponent(String(cid || ""));
  const safeAid = encodeURIComponent(String(aid || ""));
  const requests: SubtitleInfoRequest[] = [];

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

export interface BiliApiError extends Error {
  code?: number | string;
  retryable?: boolean;
}

export function buildBiliApiError(payload: unknown, fallbackMessage: string): BiliApiError {
  const msg = toReadableText((payload as { message?: unknown })?.message, fallbackMessage);
  const error = new Error(msg) as BiliApiError;
  error.code = (payload as { code?: number | string })?.code;
  error.retryable = isRetryableError(error.code);
  return error;
}

function isRetryableError(code: number | string | undefined): boolean {
  // -509: 请求过于频繁
  // -3: 参数错误（可能是临时性的）
  // 其他负数错误码也可能是临时性的
  return code === -509 || code === -3 || (typeof code === "number" && code < 0);
}
