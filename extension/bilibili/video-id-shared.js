// Shared pure URL / video-identity helpers (issue 02).
// Extracted from extension/url-utils.js and extension/background.js.
// These functions are pure, deterministic computations over a URL string.
// They must NOT contain any transport logic, Chrome APIs, DOM, or `state`.

export function isReaderMode(url = location.href) {
  try {
    return new URL(url).searchParams.get("boc_reader") === "1";
  } catch {
    return false;
  }
}

export function stripReaderModeUrl(url = location.href) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("boc_reader");
    return parsed.toString();
  } catch {
    return url;
  }
}

export function isWatchlaterPage(url = location.href) {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "/list/watchlater";
  } catch {
    return false;
  }
}

export function computeCurrentClipSignature(url = location.href) {
  const bvid = extractBvid(url);
  const page = extractPageIndex(url);
  return [bvid, page].map((item) => String(item || "").trim()).join("|");
}

// ===== from extension/url-utils.js =====
// extractBvid / extractPageIndex / cleanVideoUrl were re-exported verbatim by
// url-utils.js before that shallow module was merged into this one.

export function extractBvid(url) {
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

export function cleanVideoUrl(href = location.href) {
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

export function extractPageIndex(url) {
  return extractPageIndexFromUrl(url);
}

// ===== from extension/background.js =====

export function extractPageIndexFromUrl(url) {
  try {
    const page = Number(new URL(String(url || "")).searchParams.get("p") || "1");
    return Number.isFinite(page) && page > 0 ? page : 1;
  } catch {
    return 1;
  }
}

export function buildCanonicalVideoUrl(bvid, pageIndex = 1) {
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
export function buildCanonicalVideoUrlFromContext(context, currentMetaContextUrl) {
  const bvid = String(
    context?.bvid ||
      extractBvid(context?.url) ||
      extractBvid(currentMetaContextUrl) ||
      ""
  ).trim();
  if (bvid) {
    return `https://www.bilibili.com/video/${bvid}/`;
  }
  return String(context?.url || currentMetaContextUrl || "").trim();
}
