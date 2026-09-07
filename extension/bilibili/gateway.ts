import { formatLocalDate } from "../shared/utils.js";
import { toReadableText, isExtensionContextInvalidated, getErrorMessage } from "../shared/error-helpers.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { state, clipState } from "../core/state.js";
import { getRuntimeVideoElement } from "./video-probe.js";
import { isBiliUrl } from "./gateway-core.js";
import type { JsonTransport } from "./gateway-core.js";
import { logInfo, logWarn } from "../shared/logging.js";
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

// 传输叶拆出（arch-slim-2/04）：isBiliUrl / bgFetchJson / JsonTransport 迁至
// gateway-core.ts（零 extension/ 内部依赖的叶子），SW 静态图不再经本模块拖入
// state/video-probe/selection→cache→cache-lru 链。此处 re-export 保持既有
// import 面兼容；本模块只剩页面侧编排（getCurrentAid / readRuntimeVideoDuration /
// fetchVideoMeta / fetchSubtitleBundle / fetchHotComments / fetchSubtitleBody）。
export { bgFetchJson, isBiliUrl } from "./gateway-core.js";
export type { JsonTransport } from "./gateway-core.js";

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
    // 响应形状由消息类型经 ResponseOf 推断（arch-slim-2/02）；data 为目标 JSON
    // 原文（unknown），由本函数的泛型参数 T 收口
    const resp = await sendRuntimeMessage({ type: "fetch-json", url });
    if (!resp?.ok) {
      throw new Error(toReadableText(resp?.error, "Background fetch failed"));
    }
    return resp.data as T;
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

// 热评编排单源（arch-review-2026-09/07）：「getCurrentAid 判空 → fetchHotComments(20)
// → clipState.setHotComments 落账 → 失败降级空列表 + note」序列此前在
// core/context-assembly 与 entry/message-handler 逐字手抄两份，此处收口。
// message-handler 消费它包 sendResponse 外壳；context-assembly 缺省实现直接注入。
// deps 可注入 ledger/aid/拉取替身（测试），缺省全部取本模块与 core/state 真身。
export interface HotCommentsWithLedgerDeps {
  clipState?: { setHotComments(comments: HotComment[]): void };
  getCurrentAid?: () => number;
  fetchHotComments?: (count: number) => Promise<HotComment[]>;
}

export interface HotCommentsWithLedgerOutcome {
  comments: HotComment[];
  // 降级说明（无 aid / 拉取失败）；成功路径缺省。
  note?: string;
}

export async function fetchHotCommentsWithLedger(
  deps: HotCommentsWithLedgerDeps = {}
): Promise<HotCommentsWithLedgerOutcome> {
  const ledger = deps.clipState || clipState;
  const aidOf = deps.getCurrentAid || getCurrentAid;
  const fetchComments = deps.fetchHotComments || fetchHotComments;
  try {
    if (!aidOf()) {
      ledger.setHotComments([]);
      return { comments: [], note: "无法获取视频 aid" };
    }
    const comments = await fetchComments(20);
    ledger.setHotComments(comments);
    return { comments };
  } catch (error) {
    ledger.setHotComments([]);
    return { comments: [], note: getErrorMessage(error) };
  }
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

// 日志下沉（arch-slim-2/03）：原 subtitle/fetcher.ts 的纯直通包装删除，其
// logInfo/logWarn 随之下沉到本模块（debug 级差异：日志 emitted 点从 fetcher
// 包装层移到 gateway 本体，字段与文案逐字一致）。
export async function fetchVideoMeta(transport: JsonTransport, bvid: string): Promise<VideoMeta> {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  logInfo("[BOC] fetch video meta", { url, bvid });
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
  // 日志下沉（arch-slim-2/03）：原 fetcher 包装层在整次调用失败时 logWarn 后
  // 原样重抛，这里在兜底 catch 收口，字段与文案逐字一致。
  try {
    return await fetchSubtitleBundleInner(transport, { bvid, cid, aid });
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

async function fetchSubtitleBundleInner(
  transport: JsonTransport,
  { bvid, cid, aid }: { bvid?: string | number; cid?: string | number; aid?: string | number }
): Promise<{ tracks: SubtitleTrack[]; chapters: Chapter[] }> {
  logInfo("[BOC] fetch subtitles list", { bvid, cid, aid });
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
