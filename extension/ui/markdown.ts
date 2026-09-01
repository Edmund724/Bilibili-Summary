// markdown.ts — pure deep module for the custom markdown rendering logic
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

export function isTimestampOnlyInlineCode(value: unknown): boolean {
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

export function renderMarkdown(text: string): string {
  let escaped = escapeHtml(stripThinkBlocks(text));
  const codeBlocks: string[] = [];
  escaped = escaped.replace(/```([\s\S]*?)```/g, (_, code: string) => {
    codeBlocks.push(code);
    return `\u0001BOC_CODE_${codeBlocks.length - 1}\u0001`;
  });

  const lines = escaped.split("\n");
  const out: string[] = [];
  let listType = "";
  let listStartNumber = 1;
  let paraBuf: string[] = [];

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
  const openList = (nextType: string, startNumber = 1) => {
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
  const getNextListType = (startIndex: number) => {
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
  const isTableSeparatorLine = (value: string) => /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(value);
  const isTableRowLine = (value: string) => /^\|.+\|$/.test(value);
  const splitTableCells = (value: string) =>
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
      const bodyRows: string[][] = [];
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

// splitMarkdownTail — 流式增量渲染的切分纯函数：把文本切成"已稳定的前缀块"
// 与"仍在增长的末块"，调用方对 stable 只在其增长时渲染一次，tail 每帧重渲染。
//
// 切分规则：
//   1. 只在"空行连续段"的起点切（连续空行按一个边界处理），且该空行段之后
//      必须还有非空行——排除文末换行产生的尾随空行，保证 stable 随流式追加
//      只增不减、不会因尾随空行出现又消失而来回抖动；取满足条件的最后一个
//      切点（最后一个空行边界）。
//   2. 切点之前围栏必须闭合。围栏开合判定与 renderMarkdown 的 ``` 成对摘出
//      （/```([\s\S]*?)```/g 按出现顺序两两配对）一致：``` 每出现一次开/闭
//      一次，前缀内累计出现奇数次即处于未闭合围栏中（escapeHtml 不改写
//      反引号，转义前后计数一致）。
//   3. 找不到满足条件的切点（全文无空行，或所有空行边界都落在未闭合围栏内）
//      时安全退化：stableText 为空串、tailText 为全文，等价于全量渲染。
// 切点落在空行上，而 markdown 的块级结构（标题/表格/列表/段落）都以空行或
// 单换行为界且不跨空行延续成块，因此 renderMarkdown(stable) 与
// renderMarkdown(tail) 堆叠渲染与 renderMarkdown(全文) 等价。
export function splitMarkdownTail(text: unknown): { stableText: string; tailText: string } {
  const source = String(text || "");
  const lines = source.split("\n");
  let lastNonBlank = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() !== "") {
      lastNonBlank = index;
      break;
    }
  }
  if (lastNonBlank < 0) {
    return { stableText: "", tailText: source };
  }
  let fenceOpen = false;
  let cut = -1;
  for (let index = 0; index < lastNonBlank; index += 1) {
    const line = lines[index];
    const blank = line.trim() === "";
    if (blank && !fenceOpen && (index === 0 || lines[index - 1].trim() !== "")) {
      cut = index; // 循环上界 lastNonBlank 保证该空行段之后仍有非空行
    }
    const fences = line.match(/```/g);
    if (fences && fences.length % 2 === 1) {
      fenceOpen = !fenceOpen;
    }
  }
  if (cut < 0) {
    return { stableText: "", tailText: source };
  }
  return {
    stableText: lines.slice(0, cut).join("\n"),
    tailText: lines.slice(cut).join("\n")
  };
}

function renderInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, (_, c: string) => (isTimestampOnlyInlineCode(c) ? c : `<code>${c}</code>`))
    .replace(/\*\*([^*\n]+)\*\*/g, (_, c: string) => `<strong>${c}</strong>`)
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, pre: string, c: string) => `${pre}<em>${c}</em>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t: string, u: string) => {
      const safeUrl = /^(https?:|mailto:|#)/i.test(u) ? u : "#";
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${t}</a>`;
    });
}

export function stripThinkBlocks(text: unknown): string {
  return String(text || "")
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<\/think>/gi, "")
    .replace(/^\s*<\/?think\b[^>]*>\s*$/gim, "")
    .trim();
}
