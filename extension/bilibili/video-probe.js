import { state } from "../core/state.js";

export function findReaderPlayerHost(video) {
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

export function isIgnoredReaderVideoCandidate(video) {
  if (!video) {
    return true;
  }
  const host = findReaderPlayerHost(video);
  const blockedSelector = [
    "[data-boc-reader-hidden='1']",
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

export function getRuntimeVideoElement() {
  if (state.reader.readingVideoEl?.isConnected) {
    const currentHost = findReaderPlayerHost(state.reader.readingVideoEl);
    const currentRect = state.reader.readingVideoEl.getBoundingClientRect();
    if (
      currentHost?.isConnected &&
      currentRect.width > 120 &&
      currentRect.height > 68 &&
      !isIgnoredReaderVideoCandidate(state.reader.readingVideoEl)
    ) {
      return state.reader.readingVideoEl;
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
        (item === state.reader.readingVideoEl ? 500 : 0);
      return { item, rect, score };
    })
    .filter(({ rect }) => rect.width > 240 && rect.height > 120)
    .sort((a, b) => b.score - a.score)[0];

  return visible?.item || candidates[0] || null;
}
