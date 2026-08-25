// paste.js — "assistant answer as note section" paste normalization, extracted
// out of extension/pages/sidepanel.js (ticket 06 of sidepanel-split).
//
// Domain: notes (same dir as render.js). Pure: no DOM/chrome access, no
// sidepanel module-level state.
//
// Exported functions:
//   - normalizeMarkdownForSectionPaste(raw, baseLevel=2)  pure; re-levels markdown
//     headings for a note section and unwraps timestamp-only inline code
//
// Dependency: unwrapTimestampInlineCode lives in extension/ui/timestamp-nav.js
// (ticket 04); it is imported below.
import { unwrapTimestampInlineCode } from "../ui/timestamp-nav.js";

export function normalizeMarkdownForSectionPaste(raw, baseLevel = 2) {
  const shift = Math.max(0, Number(baseLevel) || 0);
  const lines = String(raw || "").split("\n");
  const normalized = [];
  let inFence = false;

  lines.forEach((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      normalized.push(line);
      return;
    }

    if (inFence) {
      normalized.push(line);
      return;
    }

    const pasteLine = unwrapTimestampInlineCode(line);
    const headingMatch = pasteLine.match(/^(\s*)(#{1,3})(\s+.*)$/);
    if (!headingMatch) {
      normalized.push(pasteLine);
      return;
    }

    const [, indent, hashes, suffix] = headingMatch;
    normalized.push(`${indent}${"#".repeat(hashes.length + shift)}${suffix}`);
  });

  return normalized.join("\n");
}
