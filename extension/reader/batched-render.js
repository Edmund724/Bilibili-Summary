// Reader 分批渲染状态机（候选10 批2 自 lifecycle.js 迁出）。
//
// 长视频字幕可达 1500+ 条，renderReadingView 原先整段模板字符串 join 后一次性
// innerHTML，主线程被 DOM 解析卡死数百毫秒（且随后立即读 scrollHeight /
// clientHeight 强制布局）。现改为首屏只渲染前 TRANSCRIPT_FIRST_BATCH 条，其余
// 经 rAF 每帧追加 TRANSCRIPT_APPEND_BATCH 条：
//   - 事件委托在容器层（ui-renderer 绑定 + sync.js closest 委托），追加的节点
//     天然可交互，无需逐条重绑；
//   - 每批追加后调 updateReadingTranscriptTailSpacer 廉价收敛 spacer（其内部
//     带脏检查），全部渲染完成后的最终布局与整段重建等价；
//   - 跳转/跟随目标未上屏时经 ensureReadingTranscriptRenderedUpTo 同步补渲染
//     （由 lifecycle.js 的 registerReaderPorts 单点注册进显式端口，供 sync.js
//     经 readerPorts.flushReadingTranscriptToIndex 回调）；
//   - 渲染期间再次 renderReadingView（切轨/重进阅读模式）先取消上一轮任务。
// 章节列表量小（几十条），保持整段渲染不变。
//
// 依赖方向（无环叶子）：shared 字符串工具 + page-frame 的 ids/尾部留白。
// 首屏批与任务启动入口（buildReadingTranscriptItemHtml /
// startReadingTranscriptAppendTask / cancelReadingTranscriptAppend /
// ensureReadingTranscriptRenderedUpTo / TRANSCRIPT_FIRST_BATCH）由 lifecycle.js
// 的 renderReadingView/closeReadingView/端口注册调用；本模块不 import lifecycle。
import { escapeHtml, formatCompactTimestamp } from "../shared/string-utils.js";
import { ids, updateReadingTranscriptTailSpacer } from "./page-frame.js";

const TRANSCRIPT_FIRST_BATCH = 120;
const TRANSCRIPT_APPEND_BATCH = 200;

// 进行中的追加任务：{ listEl, items, cursor, withHours }。listEl 持有列表容器
// 引用（innerHTML 重建不更换容器元素，容器身份稳定；再次 renderReadingView 会
// 先 cancel 旧任务，不存在旧任务写新列表的窗口）。
let transcriptAppendTask = null;
let transcriptAppendRafId = 0;

export function buildReadingTranscriptItemHtml(item, withHours) {
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
function insertReadingTranscriptRange(listEl, items, from, to, withHours) {
  if (to <= from) {
    return;
  }
  let html = "";
  for (let i = from; i < to; i += 1) {
    html += buildReadingTranscriptItemHtml(items[i], withHours);
  }
  const spacer = document.getElementById(ids.readingTranscriptTailSpacer);
  if (spacer && spacer.parentElement === listEl) {
    spacer.insertAdjacentHTML("beforebegin", html);
  } else {
    // spacer 缺失（异常形态）时退化为尾部追加，不影响条目可用性
    listEl.insertAdjacentHTML("beforeend", html);
  }
}

export function cancelReadingTranscriptAppend() {
  if (transcriptAppendRafId) {
    window.cancelAnimationFrame(transcriptAppendRafId);
    transcriptAppendRafId = 0;
  }
  transcriptAppendTask = null;
}

function scheduleReadingTranscriptAppend() {
  if (transcriptAppendRafId) {
    return;
  }
  transcriptAppendRafId = window.requestAnimationFrame(appendReadingTranscriptBatch);
}

function appendReadingTranscriptBatch() {
  transcriptAppendRafId = 0;
  const task = transcriptAppendTask;
  if (!task) {
    return;
  }
  // 列表容器已脱离文档（阅读视图整体被移除/测试 teardown）：任务作废，
  // 等下一次 renderReadingView 重建。
  if (!task.listEl?.isConnected) {
    transcriptAppendTask = null;
    return;
  }
  const end = Math.min(task.items.length, task.cursor + TRANSCRIPT_APPEND_BATCH);
  insertReadingTranscriptRange(task.listEl, task.items, task.cursor, end, task.withHours);
  task.cursor = end;
  // 每批追加后廉价收敛 spacer 高度（内部脏检查：高度没变只多一次 clientHeight 读）
  updateReadingTranscriptTailSpacer();
  if (task.cursor < task.items.length) {
    scheduleReadingTranscriptAppend();
  } else {
    transcriptAppendTask = null;
  }
}

// 跳转/跟随定位的同步补渲染：把 [cursor, targetIndex] 一次性上屏后返回 true，
// 剩余条目继续走 rAF 分批。目标已在屏内（或无进行中任务）时原样返回 true，
// 调用方（sync.js）随后照常 querySelector。
export function ensureReadingTranscriptRenderedUpTo(targetIndex) {
  const task = transcriptAppendTask;
  if (!task) {
    // 无任务：要么列表为空（无目标可渲染，调用方 querySelector 落空等同旧行为），
    // 要么已全部上屏
    return true;
  }
  if (!task.listEl?.isConnected) {
    transcriptAppendTask = null;
    return true;
  }
  if (targetIndex < task.cursor) {
    return true;
  }
  const end = Math.min(task.items.length, targetIndex + 1);
  insertReadingTranscriptRange(task.listEl, task.items, task.cursor, end, task.withHours);
  task.cursor = end;
  updateReadingTranscriptTailSpacer();
  if (task.cursor >= task.items.length) {
    transcriptAppendTask = null;
  } else {
    scheduleReadingTranscriptAppend();
  }
  return true;
}

// renderReadingView（lifecycle.js）在首屏批之后启动追加任务的入口：原先是
// 直接给 transcriptAppendTask 赋值再调 scheduleReadingTranscriptAppend 的两行
// 内联语句，任务状态随状态机迁入本模块后收拢为单点入口，行为逐字一致。
export function startReadingTranscriptAppendTask(task) {
  transcriptAppendTask = task;
  scheduleReadingTranscriptAppend();
}

export { TRANSCRIPT_FIRST_BATCH };
