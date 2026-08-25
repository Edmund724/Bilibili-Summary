// Shared pure URL / video-identity helpers (issue 02).
// Extracted from extension/url-utils.js and extension/background.js.
// These functions are pure, deterministic computations over a URL string.
// They must NOT contain any transport logic, Chrome APIs, DOM, or `state`.

// ===== from extension/url-utils.js =====

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
  try {
    const page = Number(new URL(url).searchParams.get("p") || "1");
    if (!Number.isFinite(page) || page <= 0) {
      return 1;
    }
    return page;
  } catch {
    return 1;
  }
}

// ===== from extension/background.js =====

export function extractBvidFromUrl(url) {
  const text = String(url || "").trim();
  const match = text.match(/\/video\/(BV[0-9A-Za-z]+)/i) || text.match(/[?&]bvid=(BV[0-9A-Za-z]+)/i);
  return match?.[1] || "";
}

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
