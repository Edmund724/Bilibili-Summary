// 字幕 tab 句内搜索（PR3）：大小写不敏感字面量匹配 + 命中高亮（mark）+
// 上/下一条循环导航 + 匹配计数。
//
// 与分批渲染（./batched-render.ts）的组合是本模块的核心约束：
//   - 匹配在数据层（state.clip.subtitleBody，经 getReadingSubtitleItems 与
//     渲染同源同口径）计算，天然覆盖尚未上屏的条目——计数与导航不依赖渲染进度；
//   - 「下一条/上一条」目标未渲染时经 readerPorts.flushReadingSubtitleToIndex
//     同步补渲染（与跟随/跳转的补渲染同一条路径，不许跳不过去）；
//   - 搜索激活期间后续批次上屏的条目也要带高亮：lifecycle（组装根）把本模块的
//     handleReadingSubtitleRangeAppended 注册进 batched-render 的批次回执 hook，
//     每次分批/补渲染上屏 [from, to) 即对新条目打高亮；
//   - 搜索清除/清空时把 mark 还原为纯文本（restore 后 normalize）。
//
// 状态维持：query/matches/currentIndex 收在本模块闭包，字幕 tab 隐藏（切到
// 概览/AI 对话）时 DOM 保留（display:none 不销毁），切回后高亮与导航位置原样
// 还在；renderReadingView（切轨/重渲）重建列表后由 lifecycle 在渲染尾部调
// refreshReadingSubtitleSearch({ scroll: false }) 重放高亮。
//
// 依赖方向（无环）：state 叶子 + ports 叶子 + SYNC（noteManualReaderInteraction，
// LIFECYCLE → SYNC 合法边）+ subtitle/core（与 sync.ts 同款静态边）。本模块
// 不 import lifecycle/batched-render——补渲染走显式端口，批次回执走注册 hook。

import { state } from "../core/state.js";
import { getReadingSubtitleItems } from "../subtitle/core.js";
import { ids } from "./state.js";
import { readerPorts } from "./ports.js";
import { noteManualReaderInteraction } from "./sync.js";

// 高亮与当前命中的 class 契约（reader.css 消费；search-current 为任务约定名）
const SEARCH_HIT_MARK_CLASS = "boc-reading-search-hit";
const SEARCH_CURRENT_CLASS = "search-current";
const SEARCH_TEXT_SELECTOR = ".boc-reading-text";

interface SearchRange {
  start: number;
  end: number;
}

interface SearchMatch {
  // data-index（getReadingSubtitleItems 的 item.index，与渲染条目一致）
  itemIndex: number;
  // 该条目内第几个命中（0 起）——当前命中落点 = 条目内第 ordinal 个 mark
  ordinal: number;
}

let query = "";
let matches: SearchMatch[] = [];
// itemIndex → 该条目的命中列表（批次回执与条目高亮按条目取用，免全量扫描）
let matchesByItem = new Map<number, SearchMatch[]>();
let currentIndex = -1;

function getSearchInput(): HTMLInputElement | null {
  return document.getElementById(ids.readingSearchInput) as HTMLInputElement | null;
}

function getSubtitleList(): HTMLElement | null {
  return document.getElementById(ids.readingSubtitleList);
}

function getItemNode(itemIndex: number): HTMLElement | null {
  return getSubtitleList()?.querySelector<HTMLElement>(`[data-index="${itemIndex}"]`) || null;
}

// 大小写不敏感字面量匹配（语义照搬 youtube-digest findLiteralTranscriptMatches：
// 正则元字符转义为字面量——标点是字幕文本不是表达式命令）
function findLiteralMatches(text: string, needle: string): SearchRange[] {
  const source = String(text || "");
  const target = String(needle || "").trim();
  if (!target) {
    return [];
  }
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(escaped, "gi");
  const ranges: SearchRange[] = [];
  for (const match of source.matchAll(matcher)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function computeMatches(needle: string): void {
  matches = [];
  matchesByItem = new Map();
  for (const item of getReadingSubtitleItems(state.clip.subtitleBody)) {
    const ranges = findLiteralMatches(item.content, needle);
    for (let ordinal = 0; ordinal < ranges.length; ordinal += 1) {
      const match: SearchMatch = { itemIndex: item.index, ordinal };
      matches.push(match);
      const list = matchesByItem.get(item.index);
      if (list) {
        list.push(match);
      } else {
        matchesByItem.set(item.index, [match]);
      }
    }
  }
}

// 把一条已上屏条目的文本替换为 mark 高亮。幂等：从 textContent（mark 在内时
// 拼回的仍是原文本）重算命中后整体重建，不产生嵌套 mark。返回首命中 mark。
function highlightItemNode(node: HTMLElement, needle: string): boolean {
  const textSpan = node.querySelector<HTMLElement>(SEARCH_TEXT_SELECTOR);
  if (!textSpan) {
    return false;
  }
  const raw = textSpan.textContent || "";
  const ranges = findLiteralMatches(raw, needle);
  if (ranges.length === 0) {
    return false;
  }
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      fragment.appendChild(document.createTextNode(raw.slice(cursor, range.start)));
    }
    const mark = document.createElement("mark");
    mark.className = SEARCH_HIT_MARK_CLASS;
    mark.textContent = raw.slice(range.start, range.end);
    fragment.appendChild(mark);
    cursor = range.end;
  }
  if (cursor < raw.length) {
    fragment.appendChild(document.createTextNode(raw.slice(cursor)));
  }
  textSpan.replaceChildren(fragment);
  return true;
}

// 还原高亮：mark 换回文本节点并 normalize（相邻文本节点合并），列表恢复原文本
function clearSearchHighlights(): void {
  const list = getSubtitleList();
  if (!list) {
    return;
  }
  list.querySelectorAll(`mark.${SEARCH_HIT_MARK_CLASS}`).forEach((mark) => {
    const parent = mark.parentNode;
    mark.replaceWith(document.createTextNode(mark.textContent || ""));
    parent?.normalize();
  });
  list.querySelectorAll(`.${SEARCH_CURRENT_CLASS}`).forEach((node) => {
    node.classList.remove(SEARCH_CURRENT_CLASS);
  });
}

// 对「已上屏且命中」的条目打高亮（全量；批次回执路径见 handleReadingSubtitleRangeAppended）
function applyHighlightsToRendered(needle: string): void {
  if (!needle || matches.length === 0) {
    return;
  }
  for (const itemIndex of matchesByItem.keys()) {
    const node = getItemNode(itemIndex);
    if (node) {
      highlightItemNode(node, needle);
    }
  }
}

// 当前命中落点：补渲染/翻页后把 search-current 标到对应 mark 与条目上
function revealCurrentMatch({ scroll = true }: { scroll?: boolean } = {}): void {
  const list = getSubtitleList();
  if (!list) {
    return;
  }
  list.querySelectorAll(`.${SEARCH_CURRENT_CLASS}`).forEach((node) => {
    node.classList.remove(SEARCH_CURRENT_CLASS);
  });
  const match = matches[currentIndex];
  if (!match) {
    return;
  }
  // 目标条目未上屏（分批渲染落后于匹配）：先同步补渲染再取节点——与跟随/跳转
  // 的「跳不过去」防线同一条端口路径。
  let node = getItemNode(match.itemIndex);
  if (!node) {
    readerPorts.flushReadingSubtitleToIndex(match.itemIndex);
    node = getItemNode(match.itemIndex);
  }
  if (!node) {
    return;
  }
  const mark = node.querySelectorAll(`mark.${SEARCH_HIT_MARK_CLASS}`)[match.ordinal] as HTMLElement | undefined;
  if (mark) {
    mark.classList.add(SEARCH_CURRENT_CLASS);
  }
  node.classList.add(SEARCH_CURRENT_CLASS);
  if (scroll) {
    // 搜索定位即「用户在看这里」：暂停自动跟随（与手动滚动同语义，默认 3s 后
    // 自动恢复，Follow 悬浮按钮同步出现），再把命中条目滚到视口中部。
    noteManualReaderInteraction();
    node.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function updateSearchControls(): void {
  const countNode = document.getElementById(ids.readingSearchCount);
  const prev = document.getElementById(ids.readingSearchPrevBtn) as HTMLButtonElement | null;
  const next = document.getElementById(ids.readingSearchNextBtn) as HTMLButtonElement | null;
  if (countNode) {
    countNode.textContent = !query
      ? ""
      : matches.length > 0
        ? `${currentIndex + 1} / ${matches.length}`
        : "无匹配";
  }
  if (prev) {
    prev.disabled = matches.length === 0;
  }
  if (next) {
    next.disabled = matches.length === 0;
  }
}

// 重算并重放搜索（输入变化 / renderReadingView 重渲后由 lifecycle 调用）。
// preserveIndex：重放时尽量保住当前命中序号（重渲不打断阅读位置）；输入变化
// 场景传 false 回到第一个命中。
export function refreshReadingSubtitleSearch(
  { preserveIndex = false, scroll = true }: { preserveIndex?: boolean; scroll?: boolean } = {}
): void {
  const input = getSearchInput();
  const previousIndex = currentIndex;
  clearSearchHighlights();
  matches = [];
  matchesByItem = new Map();
  currentIndex = -1;
  query = String(input?.value || "").trim();
  if (!query) {
    updateSearchControls();
    return;
  }
  computeMatches(query);
  applyHighlightsToRendered(query);
  if (matches.length > 0) {
    currentIndex = preserveIndex ? Math.min(Math.max(previousIndex, 0), matches.length - 1) : 0;
    revealCurrentMatch({ scroll });
  }
  updateSearchControls();
}

// 上/下一条循环导航（Enter=+1、Shift+Enter=-1、按钮同款），环绕像浏览器 Find。
export function moveReadingSubtitleSearch(direction: 1 | -1): void {
  if (matches.length === 0) {
    return;
  }
  currentIndex = (currentIndex + direction + matches.length) % matches.length;
  revealCurrentMatch();
  updateSearchControls();
}

// 清空搜索状态（清输入 + 还原文本 + 计数归零）。closeReadingView 的会话收尾
// 与「换视频」场景调用；输入框 DOM 常驻（tab 显隐不销毁），必须显式清值。
export function clearReadingSubtitleSearch(): void {
  const input = getSearchInput();
  if (input) {
    input.value = "";
  }
  clearSearchHighlights();
  matches = [];
  matchesByItem = new Map();
  currentIndex = -1;
  query = "";
  updateSearchControls();
}

// 批次回执（lifecycle 组装根把它注册进 batched-render 的 hook 槽）：搜索激活
// 期间，新上屏的 [fromIndex, toIndex) 条目自动带高亮——已渲染集合与匹配集合
// 的差集随每批收敛，最终与整段渲染等价。
export function handleReadingSubtitleRangeAppended(fromIndex: number, toIndex: number): void {
  if (!query || matches.length === 0) {
    return;
  }
  for (const itemIndex of matchesByItem.keys()) {
    if (itemIndex < fromIndex || itemIndex >= toIndex) {
      continue;
    }
    const node = getItemNode(itemIndex);
    if (node) {
      highlightItemNode(node, query);
    }
  }
}
