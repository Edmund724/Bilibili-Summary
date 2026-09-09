// Shared pure URL / video-identity helpers (issue 02).
// Extracted from extension/url-utils.js and extension/background.js.
// These functions are pure, deterministic computations over a URL string.
// They must NOT contain any transport logic, Chrome APIs, DOM, or `state`.

export function isReaderMode(url: string = location.href): boolean {
  try {
    return new URL(url).searchParams.get("boc_reader") === "1";
  } catch {
    return false;
  }
}

export function stripReaderModeUrl(url: string = location.href): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("boc_reader");
    return parsed.toString();
  } catch {
    return url;
  }
}

export function isWatchlaterPage(url: string = location.href): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "/list/watchlater";
  } catch {
    return false;
  }
}

// Unified "supported video page" predicate (arch-slim-3/riders R1): a /video/
// pathname or a watchlater list playback page. Single source shared by the
// content.ts startup gate and the digest-button self-check (previously two
// hand-copied versions of the same rule).
export function isSupportedVideoPage(url: string = location.href): boolean {
  if (isWatchlaterPage(url)) {
    return true;
  }
  try {
    return /\/video\//.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function computeCurrentClipSignature(url: string = location.href): string {
  const bvid = extractBvid(url);
  const page = extractPageIndex(url);
  return [bvid, page].map((item) => String(item || "").trim()).join("|");
}

// ===== from extension/url-utils.js =====
// extractBvid / extractPageIndex / cleanVideoUrl were re-exported verbatim by
// url-utils.js before that shallow module was merged into this one.

export function extractBvid(url: string): string {
  const match = url.match(/\/video\/(BV[0-9A-Za-z]+)/);
  if (match?.[1]) {
    return match[1];
  }

  try {
    const parsed = new URL(url);
    const fromQuery = String(parsed.searchParams.get("bvid") || "").trim();
    if (/^BV[0-9A-Za-z]+$/.test(fromQuery)) {
      return fromQuery;
    }
  } catch {
    // ignore invalid URL
  }

  return "";
}

export function cleanVideoUrl(href: string = location.href): string {
  try {
    const parsed = new URL(href);
    if (parsed.hostname !== "www.bilibili.com") {
      return href;
    }

    if (parsed.pathname === "/list/watchlater" || parsed.pathname === "/list/watchlater/") {
      const bvid = extractBvid(href);
      if (bvid) {
        return `https://www.bilibili.com/video/${bvid}/`;
      }
      return href;
    }

    const bvid = extractBvid(href);
    if (!bvid) {
      return href;
    }
    const p = parsed.searchParams.get("p");
    const qs = p ? `?p=${encodeURIComponent(p)}` : "";
    return `https://www.bilibili.com/video/${bvid}/${qs}`;
  } catch {
    return href;
  }
}

// boc_reader=1 阅读模式 URL 的唯一拼法：cleanVideoUrl 清成规范视频 URL 再加
// boc_reader=1 查询参数；非 B 站/非视频 URL 原样返回（cleanVideoUrl 语义），
// URL 解析失败回落 cleanVideoUrl 的结果，绝不抛出。
// 2026-09 工单 02-toolbar-icon-opens-digest：工具栏 action 点击（SW 侧）与页内
// Digest 按钮共用本单源——原住 bilibili/reader-url.ts，因该文件拖 core/state
// （content 侧状态单例）不能进 SW 图，而本函数是纯 URL 计算，故收编到本模块
//（reader-url.ts 保留 re-export，页内消费方不动）。
export function buildReaderModeUrl(rawUrl: string): string {
  const base = cleanVideoUrl(rawUrl);
  try {
    const parsed = new URL(base);
    parsed.searchParams.set("boc_reader", "1");
    return parsed.toString();
  } catch {
    return base;
  }
}

export function extractPageIndex(url: string): number {
  return extractPageIndexFromUrl(url);
}

// ===== from extension/background.js =====

export function extractPageIndexFromUrl(url: string): number {
  try {
    const page = Number(new URL(String(url || "")).searchParams.get("p") || "1");
    return Number.isFinite(page) && page > 0 ? page : 1;
  } catch {
    return 1;
  }
}

export function buildCanonicalVideoUrl(bvid: string, pageIndex: number | string = 1): string {
  const safeBvid = String(bvid || "").trim();
  if (!safeBvid) {
    return "";
  }
  if (Number(pageIndex) > 1) {
    return `https://www.bilibili.com/video/${safeBvid}/?p=${Number(pageIndex)}`;
  }
  return `https://www.bilibili.com/video/${safeBvid}/`;
}

// Pure variant of the former sidepanel.js buildCleanBilibiliVideoUrl.
// The original read the module-level mutable `currentConversationMeta?.contextUrl`
// as a fallback, which made it impure. Here that fallback is injected as an
// explicit `currentMetaContextUrl` argument so the function is a deterministic
// computation over its inputs.
//
// Fallback chain (preserves the original behavior exactly):
//   bvid = context?.bvid
//        || extractBvid(context?.url)
//        || extractBvid(currentMetaContextUrl)
//   if bvid -> "https://www.bilibili.com/video/${bvid}/"
//   else      -> context?.url || currentMetaContextUrl  (stringified + trimmed)
export function isSupportedBilibiliPage(url: unknown): boolean {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.hostname !== "www.bilibili.com") {
      return false;
    }
    return (
      parsed.pathname === "/list/watchlater" ||
      parsed.pathname === "/list/watchlater/" ||
      parsed.pathname.startsWith("/video/")
    );
  } catch {
    return false;
  }
}
