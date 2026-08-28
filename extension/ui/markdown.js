// markdown.js — pure deep module for the custom markdown rendering logic
// extracted out of extension/pages/sidepanel.js (ticket 03 of sidepanel-split).
//
// Domain: ui (same dir as ui-renderer.js). Pure: no DOM, no chrome, no window,
// no sidepanel module-level state. The ONLY external dependency is escapeHtml
// (sourced from shared/string-utils.js).
//
// Shared constants:
//   - TIMESTAMP_PATTERN: the single copy of the timestamp regex
//     (/\b\d{1,3}:\d{2}(?::\d{2})?\b/g); timestamp-nav.js imports it from here.
//   - TIMESTAMP_INLINE_CODE_REST_PATTERN: used only by isTimestampOnlyInlineCode.
import { escapeHtml } from "../shared/string-utils.js";

export const TIMESTAMP_PATTERN = /\b\d{1,3}:\d{2}(?::\d{2})?\b/g;
const TIMESTAMP_INLINE_CODE_REST_PATTERN = /^[\s,，、;；:：\-–—~～至到]+$/;

export function isTimestampOnlyInlineCode(value) {
  const text = String(value || "").trim();
  if (!text) {
    return false;
  }
  TIMESTAMP_PATTERN.lastIndex = 0;
  const hasTimestamp = TIMESTAMP_PATTERN.test(text);
  TIMESTAMP_PATTERN.lastIndex = 0;
  if (!hasTimestamp) {
    return false;
  }
  const rest = text.replace(TIMESTAMP_PATTERN, "").trim();
  TIMESTAMP_PATTERN.lastIndex = 0;
  return !rest || TIMESTAMP_INLINE_CODE_REST_PATTERN.test(rest);
}

export function renderMarkdown(text) {
  let escaped = escapeHtml(stripThinkBlocks(text));
  const codeBlocks = [];
  escaped = escaped.replace(/```([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code);
    return `\u0001BOC_CODE_${codeBlocks.length - 1}\u0001`;
  });

  const lines = escaped.split("\n");
  const out = [];
  let listType = "";
  let listStartNumber = 1;
  let paraBuf = [];

  const flushPara = () => {
    if (paraBuf.length) {
      out.push(`<p>${renderInline(paraBuf.join(" "))}</p>`);
      paraBuf = [];
    }
  };
  const closeList = () => {
    if (!listType) {
      return;
    }
    out.push(listType === "ul" ? "</ul>" : "</ol>");
    listType = "";
    listStartNumber = 1;
  };
  const openList = (nextType, startNumber = 1) => {
    if (listType === nextType && (nextType !== "ol" || listStartNumber === startNumber)) {
      return;
    }
    closeList();
    listType = nextType;
    listStartNumber = nextType === "ol" ? startNumber : 1;
    if (nextType === "ul") {
      out.push("<ul>");
      return;
    }
    out.push(startNumber > 1 ? `<ol start="${startNumber}">` : "<ol>");
  };
  const getNextListType = (startIndex) => {
    for (let index = startIndex; index < lines.length; index += 1) {
      const nextLine = lines[index].trim();
      if (!nextLine) {
        continue;
      }
      if (/^[-*+]\s+(.+)$/.test(nextLine)) {
        return "ul";
      }
      if (/^\d+\.\s+(.+)$/.test(nextLine)) {
        return "ol";
      }
      break;
    }
    return "";
  };
  const isTableSeparatorLine = (value) => /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(value);
  const isTableRowLine = (value) => /^\|.+\|$/.test(value);
  const splitTableCells = (value) =>
    value
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => renderInline(cell.trim()));

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    const codeMatch = line.match(/^\u0001BOC_CODE_(\d+)\u0001$/);
    if (codeMatch) {
      flushPara();
      closeList();
      out.push(`<pre><code>${codeBlocks[Number(codeMatch[1])]}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length + 2;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (
      isTableRowLine(line) &&
      index + 1 < lines.length &&
      isTableSeparatorLine(lines[index + 1].trim())
    ) {
      flushPara();
      closeList();
      const headers = splitTableCells(line);
      const bodyRows = [];
      index += 2;
      while (index < lines.length) {
        const tableLine = lines[index].trim();
        if (!isTableRowLine(tableLine)) {
          index -= 1;
          break;
        }
        bodyRows.push(splitTableCells(tableLine));
        index += 1;
      }
      out.push(
        `<table><thead><tr>${headers.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${
          bodyRows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")
        }</tbody></table>`
      );
      continue;
    }

    const ul = line.match(/^[-*+]\s+(.+)$/);
    if (ul) {
      flushPara();
      openList("ul");
      out.push(`<li>${renderInline(ul[1])}</li>`);
      continue;
    }

    const ol = line.match(/^(\d+)\.\s+(.+)$/);
    if (ol) {
      flushPara();
      const orderNumber = Number(ol[1]) || 1;
      openList("ol", orderNumber);
      out.push(`<li>${renderInline(ol[2])}</li>`);
      continue;
    }

    if (!line) {
      flushPara();
      if (listType && getNextListType(index + 1) === listType) {
        continue;
      }
      closeList();
      continue;
    }

    paraBuf.push(line);
  }

  flushPara();
  closeList();
  return out.join("");
}

export function renderInline(text) {
  return text
    .replace(/`([^`]+)`/g, (_, c) => (isTimestampOnlyInlineCode(c) ? c : `<code>${c}</code>`))
    .replace(/\*\*([^*\n]+)\*\*/g, (_, c) => `<strong>${c}</strong>`)
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, pre, c) => `${pre}<em>${c}</em>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
      const safeUrl = /^(https?:|mailto:|#)/i.test(u) ? u : "#";
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${t}</a>`;
    });
}

export function stripThinkBlocks(text) {
  return String(text || "")
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<\/think>/gi, "")
    .replace(/^\s*<\/?think\b[^>]*>\s*$/gim, "")
    .trim();
}
