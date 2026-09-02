import { state } from "../core/state.js";

export function findReaderPlayerHost(video: Element | null | undefined): Element | null {
  if (!video) {
    return null;
  }

  return (
    video.closest(".bpx-player-container") ||
    video.closest(".bpx-player-video-area") ||
    video.closest("#bilibili-player") ||
    video.parentElement
  );
}

function isIgnoredReaderVideoCandidate(video: Element | null | undefined): boolean {
  if (!video) {
    return true;
  }
  const host = findReaderPlayerHost(video);
  const blockedSelector = [
    ".bpx-player-mini-warp",
    ".bpx-player-mini-close",
    ".bpx-player-ending-panel",
    ".bpx-player-ending-related",
    "[class*='mini-player']",
    "[class*='picture-in-picture']",
    "[class*='adcard']",
    ".ad-report",
    "[class*='ad-report']",
    ".video-page-card-small",
    ".video-page-special-card-small",
    ".feed-card",
    ".bili-video-card"
  ].join(", ");
  return Boolean(video.closest(blockedSelector) || host?.closest?.(blockedSelector));
}

// 上次命中的视频元素的 WeakRef 快速缓存：getRuntimeVideoElement 在同步周期
// 内会被调用 20+ 次，缓存命中可跳过整次 querySelectorAll("video")。
let cachedVideoRef: WeakRef<HTMLVideoElement> | null = null;

export function getRuntimeVideoElement(): HTMLVideoElement | null {
  if (cachedVideoRef) {
    const cached = cachedVideoRef.deref();
    if (cached?.isConnected && !isIgnoredReaderVideoCandidate(cached)) {
      return cached;
    }
  }

  const readingVideoEl = state.reader.readingVideoEl as HTMLVideoElement | null | undefined;
  if (readingVideoEl?.isConnected) {
    const currentHost = findReaderPlayerHost(readingVideoEl);
    const currentRect = readingVideoEl.getBoundingClientRect();
    if (
      currentHost?.isConnected &&
      currentRect.width > 120 &&
      currentRect.height > 68 &&
      !isIgnoredReaderVideoCandidate(readingVideoEl)
    ) {
      cachedVideoRef = new WeakRef(readingVideoEl);
      return readingVideoEl;
    }
  }

  const candidates = Array.from(document.querySelectorAll("video")).filter(
    (item) => item.isConnected && !isIgnoredReaderVideoCandidate(item)
  );
  if (candidates.length === 0) {
    return null;
  }

  const visible = candidates
    .map((item) => {
      const rect = item.getBoundingClientRect();
      const host = findReaderPlayerHost(item);
      const inPlayer = Boolean(
        host &&
          (host.matches?.("#bilibili-player, .bpx-player-container, .bpx-player-video-area") ||
            host.querySelector?.(".bpx-player-video-area"))
      );
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const score =
        area +
        (inPlayer ? 1000000 : 0) +
        (!item.paused ? 20000 : 0) +
        Number(item.readyState || 0) * 2000 +
        (item.currentSrc ? 10000 : 0) +
        (item === readingVideoEl ? 500 : 0);
      return { item, rect, score };
    })
    .filter(({ rect }) => rect.width > 240 && rect.height > 120)
    .sort((a, b) => b.score - a.score)[0];

  const result = visible?.item || candidates[0] || null;
  if (result) {
    cachedVideoRef = new WeakRef(result);
  }
  return result;
}
