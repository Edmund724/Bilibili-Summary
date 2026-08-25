import { extractBvid, extractPageIndex, cleanVideoUrl } from "./video-id-shared.js";

export { extractBvid, extractPageIndex, cleanVideoUrl };

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

