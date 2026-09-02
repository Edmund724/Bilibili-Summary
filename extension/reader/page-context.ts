// Multi-page (分P) page-context resolution seam (issue 02).
//
// Collects every page / cid / oid / duration resolution path formerly spread
// across the reader layout layer into a single pure interface:
//
//   resolvePageContext(url, meta, options) -> { pageIndex, cid, cidSource, duration, pageTitle }
//
// The module is deliberately side-effect free: it never reads or writes
// `state`/`clipState`, never imports other reader modules, and only touches
// `document`/`location`/`window` through the injected `options.ctx` probes
// (defaulting to the live globals so the runtime behavior is unchanged).
// Callers are responsible for writing the returned values into state.

import { getRuntimeVideoElement as defaultGetVideo } from "../bilibili/video-probe.js";
import { extractPageIndex } from "../bilibili/video-id-shared.js";

interface PageItem {
  cid?: string | number;
  page?: string | number;
  part?: string;
  duration?: string | number;
}

interface PageContextMeta {
  aid?: string | number;
  defaultCid?: string | number;
  defaultDuration?: string | number;
  pages?: PageItem[];
}

interface PageContextCtx {
  href?: string;
  document?: { querySelector: (selector: string) => Element | null };
  __INITIAL_STATE__?: Record<string, unknown>;
  __PLAYER_STATE__?: Record<string, unknown>;
  __BILI_PLAYER__?: Record<string, unknown>;
}

interface PageContextOptions {
  ctx?: PageContextCtx;
  getVideo?: () => HTMLVideoElement | null;
  aid?: string | number;
  defaultCid?: string | number;
}

// ===== URL primitives =====

function hasExplicitPageParam(url: string) {
  try {
    return new URL(url).searchParams.has("p");
  } catch {
    return false;
  }
}

function extractOid(url: string) {
  try {
    return String(new URL(url).searchParams.get("oid") || "").trim();
  } catch {
    return "";
  }
}

function pickPageFromPages(pages: PageItem[], pageIndex: number) {
  const safePageIndex = Number(pageIndex) > 0 ? Number(pageIndex) : 1;
  const safePages = Array.isArray(pages) ? pages : [];
  const pageByIndex = safePages[safePageIndex - 1];
  if (pageByIndex?.cid) {
    return pageByIndex;
  }

  const pageByNo = safePages.find((item) => Number(item.page) === safePageIndex);
  if (pageByNo?.cid) {
    return pageByNo;
  }

  return null;
}

function pickCidFromPages(pages: PageItem[], pageIndex: number, fallbackCid: string | number = "") {
  const matchedPage = pickPageFromPages(pages, pageIndex);
  if (matchedPage?.cid) {
    return String(matchedPage.cid);
  }

  const safePages = Array.isArray(pages) ? pages : [];
  if (safePages[0]?.cid) {
    return String(safePages[0].cid);
  }

  if (fallbackCid) {
    return String(fallbackCid);
  }

  throw new Error("没有找到当前分P的 CID。");
}

function pickPageIndexFromOid(pages: PageItem[], oid: string | number, options: PageContextOptions = {}) {
  const safeOid = String(oid || "").trim();
  if (!safeOid) {
    return 0;
  }

  const safePages = Array.isArray(pages) ? pages : [];
  const pageByCid = safePages.find((item) => String(item?.cid || "") === safeOid);
  if (pageByCid?.page) {
    return Number(pageByCid.page) || 0;
  }

  // watchlater 等页面的 oid 通常是 aid 而非 cid；
  // 若 oid 与视频 aid 一致，尝试从页面状态读取当前播放分P。
  const safeAid = String(options?.aid || "").trim();
  if (safeAid && safeOid === safeAid) {
    return readCurrentPageFromPageState(safePages, options?.defaultCid, options);
  }

  return 0;
}

function readCurrentPageFromPageState(pages: PageItem[], fallbackCid: string | number = "", options: PageContextOptions = {}) {
  const safePages = Array.isArray(pages) ? pages : [];
  const { ctx = {}, getVideo = defaultGetVideo } = options;

  // 1. 优先使用 URL 中的 ?p= 参数
  try {
    const pageFromUrl = Number(new URL(ctx.href || location.href).searchParams.get("p") || "0");
    if (Number.isFinite(pageFromUrl) && pageFromUrl > 0) {
      return pageFromUrl;
    }
  } catch {
    // ignore
  }

  // 2. 其次尝试页面全局状态（watchlater 等页面通常携带播放器状态）
  try {
    const rootState = (ctx.__INITIAL_STATE__ || window?.__INITIAL_STATE__ || {}) as Record<string, unknown>;
    const playerState =
      (rootState.player || ctx.__PLAYER_STATE__ || ctx.__BILI_PLAYER__ || window?.__PLAYER_STATE__ || window?.__BILI_PLAYER__) as Record<string, unknown> | undefined;
    if (playerState) {
      const candidates = [
        playerState.page,
        playerState.pageIndex,
        playerState.currentPage,
        (playerState.data as Record<string, unknown> | undefined)?.page,
        (playerState.data as Record<string, unknown> | undefined)?.pageIndex
      ];
      for (const value of candidates) {
        const pageFromState = Number(value || "0");
        if (Number.isFinite(pageFromState) && pageFromState > 0) {
          return pageFromState;
        }
      }
    }

    const videoData = (rootState.videoData || rootState.playletInfo) as Record<string, unknown> | undefined;
    if (videoData) {
      const pageFromVideoData = Number(
        videoData.page || videoData.pageIndex || videoData.currentPage || (videoData.data as Record<string, unknown> | undefined)?.page || "0"
      );
      if (Number.isFinite(pageFromVideoData) && pageFromVideoData > 0) {
        return pageFromVideoData;
      }
      const cidFromVideoData = String(videoData.cid || (videoData.data as Record<string, unknown> | undefined)?.cid || "");
      if (cidFromVideoData) {
        const matched = safePages.find((item) => String(item?.cid || "") === cidFromVideoData);
        if (matched?.page) {
          return Number(matched.page) || 0;
        }
      }
    }
  } catch {
    // ignore
  }

  // 3. 从播放器 DOM / video currentSrc / iframe src 读取当前分P
  const pageFromDom = readPageFromPlayerDom(safePages, options);
  if (Number.isFinite(pageFromDom) && pageFromDom > 0) {
    return pageFromDom;
  }

  // 4. 最后按 defaultCid / 首页索引兜底
  if (fallbackCid) {
    const pageByCid = safePages.find((item) => String(item?.cid || "") === String(fallbackCid));
    if (pageByCid?.page) {
      return Number(pageByCid.page) || 1;
    }
  }

  return safePages.length > 0 ? 1 : 0;
}

function readPageFromPlayerDom(pages: PageItem[], options: PageContextOptions = {}) {
  const safePages = Array.isArray(pages) ? pages : [];
  const { ctx = {}, getVideo = defaultGetVideo } = options;
  const doc = ctx.document || document;

  // 3a. 从 video currentSrc / src 提取 cid / page
  try {
    const video = getVideo();
    if (video) {
      const src = String(video.currentSrc || video.src || "").trim();
      if (src) {
        const cidMatch = src.match(/[?&]cid=(\d+)/i);
        if (cidMatch) {
          const matched = safePages.find((item) => String(item?.cid || "") === cidMatch[1]);
          if (matched?.page) {
            return Number(matched.page) || 0;
          }
        }
        const pageMatch = src.match(/[?&]page=(\d+)/i);
        if (pageMatch) {
          const page = Number(pageMatch[1]);
          if (Number.isFinite(page) && page > 0) {
            return page;
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // 3b. 从播放器 iframe src 提取 page / cid
  try {
    const iframe =
      (doc.querySelector(
        "#bilibili-player iframe, .bpx-player-container iframe, iframe[src*='player.bilibili.com']"
      ) as HTMLIFrameElement | null) ||
      (doc.querySelector("iframe[src*='bilibili.com/player']") as HTMLIFrameElement | null);
    if (iframe?.src) {
      const pageMatch = iframe.src.match(/[?&]page=(\d+)/i);
      if (pageMatch) {
        const page = Number(pageMatch[1]);
        if (Number.isFinite(page) && page > 0) {
          return page;
        }
      }
      const cidMatch = iframe.src.match(/[?&]cid=(\d+)/i);
      if (cidMatch) {
        const matched = safePages.find((item) => String(item?.cid || "") === cidMatch[1]);
        if (matched?.page) {
          return Number(matched.page) || 0;
        }
      }
    }
  } catch {
    // ignore
  }

  // 3c. 从播放器控制栏/DOM 文本中推断当前分P
  try {
    const playerRoot =
      doc.querySelector(".bpx-player-control-wrap") ||
      doc.querySelector("#bilibili-player .bpx-player-control-wrap") ||
      doc.querySelector(".player-wrap");
    if (playerRoot) {
      const text = playerRoot.textContent || "";
      // 匹配类似 "P2"、"第2集"、"第02话" 等文本
      const pageMatch = text.match(/(?:^|\s|第)\s*(\d+)\s*(?:集|话|P|part)/i);
      if (pageMatch) {
        const page = Number(pageMatch[1]);
        if (Number.isFinite(page) && page > 0) {
          return page;
        }
      }
    }
  } catch {
    // ignore
  }

  return 0;
}

function pickDurationFromPages(pages: PageItem[], pageIndex: number, fallbackDuration: string | number = 0) {
  const matchedPage = pickPageFromPages(pages, pageIndex);
  if (matchedPage && Number(matchedPage.duration) > 0) {
    return Number(matchedPage.duration);
  }

  const safePages = Array.isArray(pages) ? pages : [];
  if (safePages[0] && Number(safePages[0].duration) > 0) {
    return Number(safePages[0].duration);
  }

  return Number(fallbackDuration || 0) || 0;
}

// ===== resolvePageContext seam =====
//
// Single entry point for resolving the current multi-page context:
//
//   resolvePageContext(url, meta, options)
//     -> { pageIndex, cid, cidSource, duration, pageTitle }
//
// - `meta` mirrors the shape produced by bili-gateway.fetchVideoMeta:
//   { aid, defaultCid, defaultDuration, pages: [{ cid, page, part, duration }] }.
// - `options` may inject:
//     ctx:      { href, document, __INITIAL_STATE__, __PLAYER_STATE__, __BILI_PLAYER__ }
//               (falls back to the live globals when omitted)
//     getVideo: custom video probe (defaults to getRuntimeVideoElement)
//
// Pure: returns a plain object and never writes `state`.

// Issue 06: the reader implementation keeps the page state guard's
// MutationObserver in module scope (now reader state/lifecycle modules, formerly
// reader-impl.js); the guard holds it here so the implementation can reuse it
// across lifecycle phases.
let normalPageStateObserver: MutationObserver | null = null;

export function setNormalPageStateObserver(observer: MutationObserver | null) {
  normalPageStateObserver = observer;
}

function getNormalPageStateObserver() {
  return normalPageStateObserver;
}

export function resolvePageContext(
  url: string,
  meta: PageContextMeta = {},
  options: PageContextOptions = {}
) {
  const safePages = Array.isArray(meta.pages) ? meta.pages : [];
  const defaultPageIndex = extractPageIndex(url);
  const oid = extractOid(url);
  const hasPageParam = hasExplicitPageParam(url);

  let resolvedPageIndex = defaultPageIndex;
  if (safePages.length > 1 && !hasPageParam) {
    const pageIndexFromOid = pickPageIndexFromOid(safePages, oid, {
      aid: meta.aid,
      defaultCid: meta.defaultCid,
      ...options
    });
    if (pageIndexFromOid > 0) {
      resolvedPageIndex = pageIndexFromOid;
    } else {
      // B 站多分P中，P1 常见为无 ?p= 参数；watchlater 等页面可能改用 oid 标识当前分P。
      resolvedPageIndex = 1;
    }
  }

  const currentPage = pickPageFromPages(safePages, resolvedPageIndex);
  return {
    pageIndex: resolvedPageIndex,
    cid: currentPage?.cid || pickCidFromPages(safePages, resolvedPageIndex, meta.defaultCid ?? ""),
    cidSource: "meta-pages",
    duration: pickDurationFromPages(safePages, resolvedPageIndex, meta.defaultDuration),
    pageTitle: currentPage?.part || ""
  };
}
