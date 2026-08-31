// timestamp-nav.ts — "assistant answer timestamp → clickable seek button" concern,
// extracted out of extension/pages/sidepanel.js (ticket 04 of sidepanel-split).
//
// Domain: ui (same dir as markdown.js / ui-renderer.js). Pure of sidepanel
// module-level state: every sidepanel dependency arrives via the injected deps
// object — no direct reads of sidepanel globals, no chrome/window imports here.
//
// NOTE (ticket 08): the seek flow reuses the sidepanel's own retrying
// `sendMessageToActiveTab` via the injected deps field (it is NOT reimplemented
// here). The tab-polling helpers `waitForTabComplete` / `delay` are sourced
// from the shared transport helpers (../shared/tab-utils.js).
//
// TIMESTAMP_PATTERN has a single home in ./markdown.js — this module imports
// it instead of keeping a parallel copy.
// Exported functions:
//   - parseTimestampToSeconds(value)            pure; "mm:ss"/"hh:mm:ss" -> seconds
//   - unwrapTimestampInlineCode(text)           pure; strips backticks around timestamp-only inline code
//   - linkifyAssistantTimestamps(root, deps)    DOM walker; swaps timestamp text nodes for seek buttons
//   - jumpToAssistantTimestamp(seconds, label, deps)  async seek; deps injected at call time

import { formatCompactTimestamp } from "../shared/string-utils.js";
import { waitForTabComplete } from "../shared/tab-utils.js";
import { isTimestampOnlyInlineCode, TIMESTAMP_PATTERN } from "./markdown.js";

export interface TimestampNavDeps {
  contextUrl?: string;
  notice?: (message: string, autoHideMs?: number) => void;
  getActiveTab?: () => Promise<{ id?: number; url?: string } | null>;
  matchContextUrl?: (tabUrl: string, targetUrl: string) => boolean;
  sendMessageToActiveTab?: (tabId: number, message: unknown) => Promise<{ ok?: boolean; error?: string } | null>;
}

function parseTimestampToSeconds(value: unknown): number {
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

export function unwrapTimestampInlineCode(text: unknown): string {
  return String(text || "").replace(/`([^`\n]+)`/g, (_, content: string) =>
    isTimestampOnlyInlineCode(content) ? content : `\`${content}\``
  );
}

export function linkifyAssistantTimestamps(root: Node | null | undefined, deps: TimestampNavDeps): void {
  if (!root) {
    return;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
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
    let match: RegExpExecArray | null;
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

async function jumpToAssistantTimestamp(
  seconds: number,
  label = "",
  deps: TimestampNavDeps = {}
): Promise<void> {
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
    const response = await deps.sendMessageToActiveTab?.(tab.id, {
      type: "sidepanel-seek-video-time",
      seconds: safeSeconds
    });
    if (!response?.ok) {
      throw new Error(response?.error || "视频时间跳转失败");
    }
  } catch (error) {
    deps.notice?.(`时间跳转失败：${(error as Error)?.message || error}`, 2600);
  }
}
