// Reader 分批渲染状态机（候选10 批2 自 lifecycle.js 迁出）。
//
// 长视频字幕可达 1500+ 条，renderReadingView 原先整段模板字符串 join 后一次性
// innerHTML，主线程被 DOM 解析卡死数百毫秒（且随后立即读 scrollHeight /
// clientHeight 强制布局）。现改为首屏只渲染前 SUBTITLE_FIRST_BATCH 条，其余
// 经 rAF 每帧追加 TRANSCRIPT_APPEND_BATCH 条：
//   - 事件委托在容器层（ui-renderer 绑定 + sync.js closest 委托），追加的节点
//     天然可交互，无需逐条重绑；
//   - 每批追加后调 updateReadingSubtitleTailSpacer 廉价收敛 spacer（其内部
//     带脏检查），全部渲染完成后的最终布局与整段重建等价；
//   - 跳转/跟随目标未上屏时经 ensureReadingSubtitleRenderedUpTo 同步补渲染
//     （由 lifecycle.js 的 registerReaderPorts 单点注册进显式端口，供 sync.js
//     经 readerPorts.flushReadingSubtitleToIndex 回调）；
//   - 渲染期间再次 renderReadingView（切轨/重进阅读模式）先取消上一轮任务。
// 章节列表量小（几十条），保持整段渲染不变。
//
// 依赖方向（无环叶子）：shared 字符串工具 + page-frame 的 ids/尾部留白。
// 首屏批与任务启动入口（buildReadingSubtitleItemHtml /
// startReadingSubtitleAppendTask / cancelReadingSubtitleAppend /
// ensureReadingSubtitleRenderedUpTo / SUBTITLE_FIRST_BATCH）由 lifecycle.js
// 的 renderReadingView/closeReadingView/端口注册调用；本模块不 import lifecycle。
import { escapeHtml, formatCompactTimestamp } from "../shared/string-utils.js";
import { ids } from "./state.js";
import { updateReadingSubtitleTailSpacer } from "./page-frame.js";
import type { ReadingSubtitleItem } from "../subtitle/core.js";

const SUBTITLE_FIRST_BATCH = 120;
const TRANSCRIPT_APPEND_BATCH = 200;

interface SubtitleAppendTask {
  listEl: HTMLElement;
  items: ReadingSubtitleItem[];
  cursor: number;
  withHours: boolean;
}

// 进行中的追加任务：{ listEl, items, cursor, withHours }。listEl 持有列表容器
// 引用（innerHTML 重建不更换容器元素，容器身份稳定；再次 renderReadingView 会
// 先 cancel 旧任务，不存在旧任务写新列表的窗口）。
let subtitleAppendTask: SubtitleAppendTask | null = null;
let subtitleAppendRafId = 0;

export function buildReadingSubtitleItemHtml(item: ReadingSubtitleItem, withHours: boolean) {
  return `
    <button
      type="button"
      class="boc-reading-item"
      data-index="${item.index}"
      data-seconds="${item.from}"
    >
      <span class="boc-reading-time">${escapeHtml(
        formatCompactTimestamp(item.from, withHours)
      )}</span>
      <span class="boc-reading-text">${escapeHtml(item.content)}</span>
    </button>
  `;
}

// 把 items[from, to) 追加进列表。tail spacer 必须始终是列表最后一个子节点
// （滚动定位的尾部留白依赖它），因此插入点固定在 spacer 之前。
function insertReadingSubtitleRange(
  listEl: HTMLElement,
  items: ReadingSubtitleItem[],
  from: number,
  to: number,
  withHours: boolean
) {
  if (to <= from) {
    return;
  }
  let html = "";
  for (let i = from; i < to; i += 1) {
    html += buildReadingSubtitleItemHtml(items[i], withHours);
  }
  const spacer = document.getElementById(ids.readingSubtitleTailSpacer);
  if (spacer && spacer.parentElement === listEl) {
    spacer.insertAdjacentHTML("beforebegin", html);
  } else {
    // spacer 缺失（异常形态）时退化为尾部追加，不影响条目可用性
    listEl.insertAdjacentHTML("beforeend", html);
  }
}

// ===== 批次回执 hook（PR3 句内搜索） =====
//
// 搜索激活期间，后续批次上屏的条目也要带上命中高亮。渲染状态机不 import 搜索
// 模块（会成环：搜索补渲染又要走本状态机的 flush 入口），改用单槽 hook：
// lifecycle（reader 域组装根，与 registerReaderPorts 同款单点注册位）在模块求值
// 时把 subtitle-search 的 handleReadingSubtitleRangeAppended 注册进来，每次
// [from, to) 上屏后同步通知；注册方异常被吞掉，绝不影响渲染主流程。
type ReadingSubtitleBatchHook = (fromIndex: number, toIndex: number) => void;

let batchAppendedHook: ReadingSubtitleBatchHook | null = null;

export function setReadingSubtitleBatchHook(hook: ReadingSubtitleBatchHook | null): void {
  batchAppendedHook = typeof hook === "function" ? hook : null;
}

function notifyReadingSubtitleBatchAppended(fromIndex: number, toIndex: number): void {
  if (toIndex <= fromIndex || !batchAppendedHook) {
    return;
  }
  try {
    batchAppendedHook(fromIndex, toIndex);
  } catch {
    // 高亮回执失败不影响渲染主流程
  }
}

export function cancelReadingSubtitleAppend() {
  if (subtitleAppendRafId) {
    window.cancelAnimationFrame(subtitleAppendRafId);
    subtitleAppendRafId = 0;
  }
  subtitleAppendTask = null;
}

function scheduleReadingSubtitleAppend() {
  if (subtitleAppendRafId) {
    return;
  }
  subtitleAppendRafId = window.requestAnimationFrame(appendReadingSubtitleBatch);
}

function appendReadingSubtitleBatch() {
  subtitleAppendRafId = 0;
  const task = subtitleAppendTask;
  if (!task) {
    return;
  }
  // 列表容器已脱离文档（阅读视图整体被移除/测试 teardown）：任务作废，
  // 等下一次 renderReadingView 重建。
  if (!task.listEl?.isConnected) {
    subtitleAppendTask = null;
    return;
  }
  const end = Math.min(task.items.length, task.cursor + TRANSCRIPT_APPEND_BATCH);
  const batchFrom = task.cursor;
  insertReadingSubtitleRange(task.listEl, task.items, task.cursor, end, task.withHours);
  task.cursor = end;
  // 每批追加后廉价收敛 spacer 高度（内部脏检查：高度没变只多一次 clientHeight 读）
  updateReadingSubtitleTailSpacer();
  // 批次回执：搜索激活时给本批条目补高亮（hook 内部吞异常）
  notifyReadingSubtitleBatchAppended(batchFrom, end);
  if (task.cursor < task.items.length) {
    scheduleReadingSubtitleAppend();
  } else {
    subtitleAppendTask = null;
  }
}

// 跳转/跟随定位的同步补渲染：把 [cursor, targetIndex] 一次性上屏后返回 true，
// 剩余条目继续走 rAF 分批。目标已在屏内（或无进行中任务）时原样返回 true，
// 调用方（sync.js）随后照常 querySelector。
export function ensureReadingSubtitleRenderedUpTo(targetIndex: number) {
  const task = subtitleAppendTask;
  if (!task) {
    // 无任务：要么列表为空（无目标可渲染，调用方 querySelector 落空等同旧行为），
    // 要么已全部上屏
    return true;
  }
  if (!task.listEl?.isConnected) {
    subtitleAppendTask = null;
    return true;
  }
  if (targetIndex < task.cursor) {
    return true;
  }
  const end = Math.min(task.items.length, targetIndex + 1);
  const flushFrom = task.cursor;
  insertReadingSubtitleRange(task.listEl, task.items, task.cursor, end, task.withHours);
  task.cursor = end;
  updateReadingSubtitleTailSpacer();
  // 批次回执：同步补渲染出的条目同样要带搜索高亮（跳转落点即命中时，当前命中
  // 标记由搜索模块在补渲染后现查落位）
  notifyReadingSubtitleBatchAppended(flushFrom, end);
  if (task.cursor >= task.items.length) {
    subtitleAppendTask = null;
  } else {
    scheduleReadingSubtitleAppend();
  }
  return true;
}

// renderReadingView（lifecycle.js）在首屏批之后启动追加任务的入口：原先是
// 直接给 subtitleAppendTask 赋值再调 scheduleReadingSubtitleAppend 的两行
// 内联语句，任务状态随状态机迁入本模块后收拢为单点入口，行为逐字一致。
export function startReadingSubtitleAppendTask(task: SubtitleAppendTask) {
  subtitleAppendTask = task;
  scheduleReadingSubtitleAppend();
}

export { SUBTITLE_FIRST_BATCH };
