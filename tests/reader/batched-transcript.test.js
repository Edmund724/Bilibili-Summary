// 候选10 批2：阅读视图字幕列表分批渲染回归测试。
//
// 覆盖：
// - 首屏只渲染前 120 条，tail spacer 始终是列表最后一个子节点；
// - rAF 每帧追加一批直至渲染完成（fake rAF 手动 flush）；
// - 分批追加后的条目可点击跳转（事件委托在容器层，无需逐条绑定）；
// - follow 跳转到未渲染区：先同步补渲染到目标 index 再滚动（不许跳不过去）；
// - 激活计算对未渲染条目照旧（不产生高亮 DOM，条目上屏后下一拍补上高亮）；
// - 渲染期间再次 renderReadingView（切轨）：取消上一轮任务，从头分批不重不漏；
// - spacer 最终高度与整段重建一致（经 updateReadingTranscriptTailSpacer 收敛）；
// - closeReadingView 取消挂起的追加任务。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";

let state;
let shell;
let video;

// fake rAF：捕获回调 + 尊重 cancelAnimationFrame（验证取消路径）。
let rafPending;
let rafCancelled;
let rafNextId;
let originalRaf;
let originalCancelRaf;

function installFakeRaf() {
  rafPending = new Map();
  rafCancelled = [];
  rafNextId = 0;
  originalRaf = window.requestAnimationFrame;
  originalCancelRaf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (cb) => {
    rafNextId += 1;
    rafPending.set(rafNextId, cb);
    return rafNextId;
  };
  window.cancelAnimationFrame = (id) => {
    rafCancelled.push(id);
    rafPending.delete(id);
  };
}

// 执行当前已登记的 rAF 回调快照（回调内新登记的留到下一轮），直至队列清空
// 或到达轮数上限（防死循环）。回调执行即从队列移除——与真实 rAF 的出队语义
// 一致，否则旧回调积压会让队列永远排不干。
function flushAnimationFrames(maxRounds = 30) {
  let rounds = 0;
  while (rafPending.size > 0 && rounds < maxRounds) {
    const entries = [...rafPending.entries()];
    entries.forEach(([id, cb]) => {
      rafPending.delete(id);
      cb(0);
    });
    rounds += 1;
  }
  if (rafPending.size > 0) {
    throw new Error(`rAF queue did not drain after ${maxRounds} rounds`);
  }
}

function makeBody(count) {
  const body = [];
  for (let i = 0; i < count; i += 1) {
    body.push({ from: i * 2, to: i * 2 + 1.9, content: `字幕第${i}条` });
  }
  return body;
}

async function loadReaderModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state;
  shell = await import("../../extension/reader/index.js");
}

function mountSkeleton() {
  mountReaderSkeleton(shell.ids);
  video = mountPlayerChain();
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadReaderModules();
  mountSkeleton();
  installFakeRaf();
  // scrollReadingTranscriptItemIntoView 的兜底路径会调 scrollIntoView，jsdom 未实现
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  window.requestAnimationFrame = originalRaf;
  window.cancelAnimationFrame = originalCancelRaf;
  document.body.innerHTML = "";
});

function transcriptList() {
  return document.getElementById(shell.ids.readingTranscriptList);
}

function renderedItemCount() {
  return transcriptList().querySelectorAll(".boc-reading-item").length;
}

function tailSpacer() {
  const list = transcriptList();
  const spacer = document.getElementById(shell.ids.readingTranscriptTailSpacer);
  // spacer 必须始终是列表最后一个子节点（滚动定位的尾部留白依赖它）
  if (spacer && spacer.parentElement === list && spacer === list.lastElementChild) {
    return spacer;
  }
  return null;
}

describe("字幕列表分批渲染", () => {
  it("首屏只渲染前 120 条，spacer 收尾，追加任务挂起", () => {
    state.clip.subtitleBody = makeBody(800);
    shell.renderReadingView();
    expect(renderedItemCount()).toBe(120);
    expect(tailSpacer()).not.toBeNull();
    expect(rafPending.size).toBe(1); // 追加任务已登记，等待下一帧
  });

  it("rAF 每帧追加直至完成：800 条不重不漏，spacer 仍收尾", () => {
    state.clip.subtitleBody = makeBody(800);
    shell.renderReadingView();
    flushAnimationFrames();
    expect(renderedItemCount()).toBe(800);
    expect(tailSpacer()).not.toBeNull();
    // data-index 0..799 各恰好一个（不重不漏）
    const list = transcriptList();
    for (let i = 0; i < 800; i += 50) {
      expect(list.querySelectorAll(`[data-index="${i}"]`).length).toBe(1);
    }
  });

  it("分批追加后的条目可点击跳转（容器层事件委托）", () => {
    state.clip.subtitleBody = makeBody(800);
    state.reader.readingViewOpen = true;
    video.play = () => Promise.resolve(); // jsdom video 无 play，jumpReadingTarget 需要
    shell.renderReadingView();
    // 首屏 120 条里没有 index 300：先 flush 一批（120+200=320），300 上屏
    flushAnimationFrames();
    const target = transcriptList().querySelector('[data-index="300"]');
    expect(target).not.toBeNull();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "target", { value: target });
    shell.onReadingTranscriptClick(event);
    expect(video.currentTime).toBe(600); // data-seconds = 300 * 2
    expect(state.reader.readingActiveSubtitleIndex).toBe(300);
  });

  it("follow 跳转到未渲染区：同步补渲染到目标 index 再滚动，不依赖后续帧", () => {
    state.clip.subtitleBody = makeBody(800);
    state.reader.readingViewOpen = true;
    state.reader.readingAutoScroll = true;
    shell.renderReadingView();
    expect(renderedItemCount()).toBe(120); // 目标 index 600 尚未上屏

    const bound = shell.bindReadingViewVideo(video);
    expect(bound).toBe(video);
    video.play = () => Promise.resolve();
    video.currentTime = 1200; // 第 600 条（from = 600 * 2）

    // 不 flush 任何 rAF：目标必须在本拍内同步补渲染
    shell.syncReadingViewPlayback(true);

    expect(renderedItemCount()).toBeGreaterThanOrEqual(601);
    const active = transcriptList().querySelector(".boc-reading-item.is-active");
    expect(active?.dataset.index).toBe("600");
    expect(state.reader.readingActiveSubtitleIndex).toBe(600);
    // 剩余条目继续排进 rAF 队列，flush 后全量渲染完成
    flushAnimationFrames();
    expect(renderedItemCount()).toBe(800);
  });

  it("激活计算对未渲染条目照旧：不产生高亮 DOM，上屏后下一拍补上", () => {
    state.clip.subtitleBody = makeBody(800);
    state.reader.readingViewOpen = true;
    state.reader.readingAutoScroll = false; // 关闭自动滚动：只验证激活计算
    shell.renderReadingView();
    shell.bindReadingViewVideo(video);
    video.currentTime = 1200; // index 600 未渲染
    shell.syncReadingViewPlayback();
    expect(state.reader.readingActiveSubtitleIndex).toBe(600); // 计算照旧
    expect(transcriptList().querySelector(".boc-reading-item.is-active")).toBeNull(); // 无高亮 DOM

    flushAnimationFrames(); // 条目上屏
    shell.syncReadingViewPlayback(); // 下一拍：同一 index，缓存节点为 null 必然现查
    expect(transcriptList().querySelector('.boc-reading-item.is-active')?.dataset.index).toBe("600");
  });

  it("渲染期间再次 renderReadingView（切轨）：取消上一轮任务，新数据不重不漏", () => {
    state.clip.subtitleBody = makeBody(800);
    shell.renderReadingView();
    // 只 flush 一批（120 → 320），任务未完成时模拟切轨
    const snapshot = [...rafPending.values()];
    snapshot.forEach((cb) => cb(0));
    expect(renderedItemCount()).toBe(320);

    state.clip.subtitleBody = makeBody(400); // 切轨后的新字幕
    shell.renderReadingView();
    expect(rafCancelled.length).toBeGreaterThanOrEqual(1); // 旧任务被显式取消
    expect(renderedItemCount()).toBe(120); // 新数据首屏

    flushAnimationFrames();
    const list = transcriptList();
    expect(renderedItemCount()).toBe(400); // 精确等于新数据条数
    expect(list.querySelectorAll('[data-index="0"]').length).toBe(1);
    expect(list.querySelectorAll('[data-index="399"]').length).toBe(1);
    expect(list.querySelector('[data-index="400"]')).toBeNull(); // 旧任务的条目没有串进来
    expect(tailSpacer()).not.toBeNull();
  });

  it("spacer 最终高度与整段重建等价（经 updateReadingTranscriptTailSpacer 收敛）", () => {
    state.clip.subtitleBody = makeBody(800);
    shell.renderReadingView();
    flushAnimationFrames();
    const batchedHeight = tailSpacer()?.style.height;
    expect(batchedHeight).toBeTruthy();

    // 再次整段触发（同数据）：首屏 spacer 与分批收敛后的最终高度一致
    shell.renderReadingView();
    const fullRebuildHeight = tailSpacer()?.style.height;
    expect(fullRebuildHeight).toBe(batchedHeight);
    flushAnimationFrames();
    expect(tailSpacer()?.style.height).toBe(batchedHeight);
  });

  it("closeReadingView 取消挂起的追加任务，关闭后不再追加", () => {
    state.clip.subtitleBody = makeBody(800);
    state.reader.readingViewOpen = true;
    shell.renderReadingView();
    expect(rafPending.size).toBe(1);
    shell.closeReadingView();
    expect(rafPending.size).toBe(0); // 挂起回调已取消
    expect(rafCancelled.length).toBeGreaterThanOrEqual(1);
    flushAnimationFrames(); // 队列已空：不应有任何追加发生
    expect(renderedItemCount()).toBe(120);
  });
});
