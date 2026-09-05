// 概览 tab 的壳接缝（arch-slim-2/06：占位模板 + 点击委托，自 ui/ui-renderer.ts
// 下放；状态机/生成编排/点击逻辑在 reader/overview.ts——「同址」落为同域
// 两文件：壳同步绑定的接线在本叶子，域逻辑不动）。
//
// 占位为此为未生成初值：切到概览标签页会自动开始生成章节与金句（ensure
// 路径由壳的 tab 切换回调经 reader 域的 ensureReaderOverviewTab 触达）；
// reader 域装载后的渲染一律由 renderReadingOverview 整块重建。
//
// 本模块是壳可静态携带的轻叶子：只依赖 ids 表与 reader-gate 转发助手。绑定
// 随壳构建同步执行、forceRecreate 重建后随壳重绑；委托挂在渲染宿主上（内容
// 被状态机整块重建，容器不换）。

import { byId } from "../shared/dom-utils.js";
import { ids } from "./state.js";
import { withReader } from "../ui/reader-gate.js";

export function buildOverviewTabBodyHtml(): string {
  return `
              <div id="${ids.readingOverviewBody}" class="boc-reading-overview">
                <div class="boc-reading-placeholder">
                  <div class="boc-reading-placeholder-title">概览还未生成</div>
                  <p class="boc-reading-placeholder-copy">切到概览标签页会自动开始生成章节与金句。</p>
                </div>
              </div>
  `;
}

export function bindReadingOverviewEvents(): void {
  // ===== PR4 概览 tab：章节/金句点击跳播 + 重试/笔记按钮 =====
  // 事件委托挂概览渲染宿主（内容被状态机整块重建，容器不换）；逻辑在
  // reader/overview.ts（跳播复用 seekReadingTarget 通道），经 ui/reader-gate
  // 装载后转发，与章节 rail / 字幕句点击同款接线。
  const readingOverviewBody = byId(ids.readingOverviewBody);
  readingOverviewBody.addEventListener("click", (event) => {
    withReader("overview click", (reader) => reader.onReadingOverviewClick(event));
  });
}
