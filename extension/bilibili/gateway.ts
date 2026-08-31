import { formatLocalDate } from "../shared/utils.js";
import { toReadableText, isExtensionContextInvalidated } from "../shared/error-helpers.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { state } from "../core/state.js";
import { getRuntimeVideoElement } from "./video-probe.js";
import { logInfo } from "../shared/logging.js";
import {
  buildSubtitleInfoRequests,
  buildBiliApiError,
  normalizeHotComments,
  type HotComment,
  type SubtitleInfoRequest
} from "./bili-api-shared.js";
import {
  mapChaptersFromPlayerData,
  mapSubtitleTracks
} from "../subtitle/selection.js";

declare global {
  interface Window {
    __INITIAL_STATE__?: { aid?: unknown };
  }
}

export type JsonTransport = (url: string) => Promise<unknown>;

// True for B站 request hosts (API + subtitle/CDN) that need the B站 request headers
// and should be routed through the background fetch handler. Shared by the transports.
export function isBiliUrl(url: unknown): boolean {
  try {
    const parsed = new URL(String(url || ""));
    const host = parsed.hostname;
    return host === "api.bilibili.com" || host.endsWith(".hdslb.com");
  } catch {
    return false;
  }
}

// ===== transports =====

export async function bgFetchJson<T = unknown>(url: string): Promise<T> {
  const headers = new Headers();
  const isBiliRequest = isBiliUrl(url);
  if (isBiliRequest) {
    headers.set("Accept", "application/json, text/plain, */*");
    headers.set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
    headers.set("Cache-Control", "no-cache");
    headers.set("Pragma", "no-cache");
  }

  const options: RequestInit = {
    method: "GET",
    credentials: "include",
    cache: "no-store"
  };
  if ((headers as unknown as { size: number }).size > 0) {
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
  return response.json() as Promise<T>;
}

async function fetchJson<T = unknown>(url: string): Promise<T> {
  if (isBiliUrl(url)) {
    return fetchJsonInBackground<T>(url);
  }

  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`请求失败：${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function contentFetchJson<T = unknown>(url: string): Promise<T> {
  return fetchJson<T>(url);
}

async function fetchJsonInBackground<T = unknown>(url: string): Promise<T> {
  try {
    const resp = await sendRuntimeMessage({ type: "fetch-json", url });
    const respLike = resp as { ok?: unknown; error?: unknown; data?: unknown };
    if (!respLike?.ok) {
      throw new Error(toReadableText(respLike?.error, "Background fetch failed"));
    }
    return respLike.data as T;
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      throw new Error("扩展刚刚更新，请刷新当前页面后重试。");
    }
    throw error;
  }
}

// ===== content-side adapters =====

export function getCurrentAid(): number {
  let aid = Number(state.clip.aid) || 0;
  if (!aid && typeof window !== "undefined") {
    try {
      aid = Number(window.__INITIAL_STATE__?.aid) || 0;
    } catch {}
  }
  return aid;
}

export function readRuntimeVideoDuration(): number {
  const video = getRuntimeVideoElement();
  const duration = Number(video?.duration);
  if (Number.isFinite(duration) && duration > 0) {
    return duration;
  }
  return 0;
}

export async function fetchSubtitleBody<T = unknown>(url: string): Promise<{ body: T[] }> {
  logInfo("[BOC] fetch subtitle body", { url });
  const body = await fetchSubtitleBodyJson<T>(contentFetchJson, url);
  return { body };
}

export async function fetchHotComments(count = 20): Promise<HotComment[]> {
  const safeCount = Math.max(0, Number(count) || 0);
  if (!safeCount) {
    return [];
  }

  const aid = getCurrentAid();
  if (!aid) {
    return [];
  }

  return fetchHotCommentsJson(contentFetchJson, aid, safeCount);
}

// ===== gateway orchestration =====

export interface VideoPage {
  cid: string;
  page: number;
  part: string;
  duration: number;
}

export interface VideoMeta {
  aid: string;
  title: string;
  author: string;
  description: string;
  uploadDate: string;
  defaultCid: string;
  defaultDuration: number;
  pages: VideoPage[];
}

export async function fetchVideoMeta(transport: JsonTransport, bvid: string): Promise<VideoMeta> {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  const payload = await transport(url);
  if ((payload as { code?: unknown })?.code !== 0) {
    throw new Error(toReadableText((payload as { message?: unknown })?.message, "无法获取视频信息"));
  }

  const data = (payload as { data?: Record<string, unknown> }).data || {};
  const pubdate = Number(data.pubdate || 0);
  const uploadDate = pubdate > 0 ? formatLocalDate(pubdate * 1000) : "";
  const pages = Array.isArray(data.pages) ? data.pages : [];

  return {
    aid: String(data.aid || ""),
    title: String(data.title || ""),
    author: String((data.owner as { name?: unknown })?.name || ""),
    description: String(data.desc || ""),
    uploadDate,
    defaultCid: data.cid ? String(data.cid) : "",
    defaultDuration: Number(data.duration || 0) || 0,
    pages: pages.map((item) => ({
      cid: String((item as { cid?: unknown })?.cid || ""),
      page: Number((item as { page?: unknown })?.page || 0) || 0,
      part: String((item as { part?: unknown })?.part || "").trim(),
      duration: Number((item as { duration?: unknown })?.duration || 0) || 0
    }))
  };
}

export interface SubtitleTrack {
  id: string;
  lan: string;
  lanDoc: string;
  subtitleUrl: string;
  source: string;
}

export interface Chapter {
  title: string;
  from: number;
  to: number;
  source: string;
}

export async function fetchSubtitleBundle(
  transport: JsonTransport,
  { bvid, cid, aid }: { bvid?: string | number; cid?: string | number; aid?: string | number }
): Promise<{ tracks: SubtitleTrack[]; chapters: Chapter[] }> {
  const requests: SubtitleInfoRequest[] = buildSubtitleInfoRequests({ bvid, cid, aid });

  const fetchByRequest = async (request: SubtitleInfoRequest) => {
    const payload = await transport(request.url);
    if ((payload as { code?: unknown })?.code !== 0) {
      throw buildBiliApiError(payload, "无法获取字幕列表");
    }

    const chapters = mapChaptersFromPlayerData((payload as { data?: unknown }).data) as Chapter[];
    const subtitles = mapSubtitleTracks(
      ((payload as { data?: { subtitle?: { subtitles?: unknown } } }).data?.subtitle?.subtitles || []) as unknown[],
      request.source
    ) as SubtitleTrack[];
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

async function fetchSubtitleBodyJson<T>(transport: JsonTransport, url: string): Promise<T[]> {
  const payload = await transport(url);
  return Array.isArray((payload as { body?: unknown })?.body) ? (payload as { body: T[] }).body : [];
}

async function fetchHotCommentsJson(
  transport: JsonTransport,
  aid: number | string,
  count = 18
): Promise<HotComment[]> {
  const safeAid = Number(aid || 0) || 0;
  const safeCount = Math.max(0, Number(count) || 0);
  if (!safeAid || !safeCount) {
    return [];
  }

  const url = `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${safeAid}&mode=3&ps=${safeCount}&pn=1`;
  const payload = await transport(url).catch(() => null);
  const replies = Array.isArray(
    (payload as { data?: { replies?: unknown } })?.data?.replies
  )
    ? (payload as { data: { replies: unknown[] } }).data.replies
    : [];
  return normalizeHotComments(
    replies.map((item) => ({
      uname: (item as { member?: { uname?: unknown } })?.member?.uname || "匿名",
      like: (item as { like?: unknown })?.like || 0,
      message: (item as { content?: { message?: unknown } })?.content?.message || ""
    })),
    safeCount
  );
}
