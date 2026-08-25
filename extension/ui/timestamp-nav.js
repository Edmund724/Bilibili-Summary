// timestamp-nav.js — "assistant answer timestamp → clickable seek button" concern,
// extracted out of extension/pages/sidepanel.js (ticket 04 of sidepanel-split).
//
// Domain: ui (same dir as markdown.js / ui-renderer.js). Pure of sidepanel
// module-level state: every sidepanel dependency arrives via the injected deps
// object `{ contextUrl, notice, getActiveTab, matchContextUrl, sendMessageToActiveTab }`
// — no direct reads of sidepanel globals, no chrome/window imports here.
//
// NOTE (ticket 08): the seek flow reuses the sidepanel's own retrying
// `sendMessageToActiveTab` via the injected deps field (it is NOT reimplemented
// here). The tab-polling helpers `waitForTabComplete` / `delay` are sourced
// from the shared transport helpers (../shared/tab-utils.js).
//
// Module-local constant:
//   - TIMESTAMP_PATTERN: moved verbatim from sidepanel.js. NOTE: markdown.js
//     keeps a deliberate PARALLEL-LOCAL copy of the same regex source (used only
//     by isTimestampOnlyInlineCode); the two must stay byte-identical.
// Exported functions:
//   - parseTimestampToSeconds(value)            pure; "mm:ss"/"hh:mm:ss" -> seconds
//   - unwrapTimestampInlineCode(text)           pure; strips backticks around timestamp-only inline code
//   - linkifyAssistantTimestamps(root, deps)    DOM walker; swaps timestamp text nodes for seek buttons
//   - jumpToAssistantTimestamp(seconds, label, deps)  async seek; deps injected at call time
//
// Internal seek flow lives here (jumpToAssistantTimestamp owns the whole seek
// flow). isTimestampOnlyInlineCode comes from ./markdown.js (its home after
// ticket 03). sendMessageToActiveTab is NOT reimplemented here — the
// retry-wrapped send is injected as a dep (sidepanel provides it).
import { formatCompactTimestamp } from "../shared/string-utils.js";
import { waitForTabComplete } from "../shared/tab-utils.js";
import { isTimestampOnlyInlineCode } from "./markdown.js";

const TIMESTAMP_PATTERN = /\b\d{1,3}:\d{2}(?::\d{2})?\b/g;

export function parseTimestampToSeconds(value) {
  const parts = String(value || "")
    .trim()
    .split(":")
    .map((item) => Number(item));
  if (!parts.length || parts.some((item) => !Number.isFinite(item) || item < 0)) {
    return 0;
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}

export function unwrapTimestampInlineCode(text) {
  return String(text || "").replace(/`([^`\n]+)`/g, (_, content) =>
    isTimestampOnlyInlineCode(content) ? content : `\`${content}\``
  );
}

export function linkifyAssistantTimestamps(root, deps) {
  if (!root) {
    return;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    const current = walker.currentNode;
    if (!(current instanceof Text)) {
      continue;
    }
    const parent = current.parentElement;
    if (!parent || parent.closest("a, code, pre, button")) {
      continue;
    }
    TIMESTAMP_PATTERN.lastIndex = 0;
    if (!TIMESTAMP_PATTERN.test(current.textContent || "")) {
      continue;
    }
    textNodes.push(current);
  }

  textNodes.forEach((node) => {
    const text = node.textContent || "";
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let hasMatch = false;
    TIMESTAMP_PATTERN.lastIndex = 0;
    let match;
    while ((match = TIMESTAMP_PATTERN.exec(text))) {
      hasMatch = true;
      if (match.index > lastIndex) {
        fragment.append(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const timestamp = match[0];
      const seconds = parseTimestampToSeconds(timestamp);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sp-timestamp-link";
      button.textContent = timestamp;
      button.setAttribute("title", `跳转到 ${timestamp}`);
      button.addEventListener("click", () => {
        void jumpToAssistantTimestamp(seconds, timestamp, deps);
      });
      fragment.append(button);
      lastIndex = match.index + timestamp.length;
    }
    if (!hasMatch) {
      return;
    }
    if (lastIndex < text.length) {
      fragment.append(document.createTextNode(text.slice(lastIndex)));
    }
    node.replaceWith(fragment);
  });
}

export async function jumpToAssistantTimestamp(seconds, label = "", deps = {}) {
  const safeSeconds = Math.max(0, Number(seconds || 0) || 0);
  const targetUrl = String(deps.contextUrl || "").trim();
  if (!targetUrl) {
    deps.notice?.("当前没有可跳转的视频上下文。", 2200);
    return;
  }

  const tab = await deps.getActiveTab?.().catch(() => null);
  if (!tab?.id) {
    deps.notice?.("找不到当前标签页。", 2200);
    return;
  }

  deps.notice?.(`正在跳转到 ${label || formatCompactTimestamp(safeSeconds, safeSeconds >= 3600)}...`, 1800);

  try {
    const sameVideo = deps.matchContextUrl?.(tab.url || "", targetUrl);
    if (!sameVideo) {
      await chrome.tabs.update(tab.id, { url: targetUrl });
      await waitForTabComplete(tab.id);
    }
    const response = await deps.sendMessageToActiveTab(tab.id, {
      type: "sidepanel-seek-video-time",
      seconds: safeSeconds
    });
    if (!response?.ok) {
      throw new Error(response?.error || "视频时间跳转失败");
    }
  } catch (error) {
    deps.notice?.(`时间跳转失败：${error?.message || error}`, 2600);
  }
}
