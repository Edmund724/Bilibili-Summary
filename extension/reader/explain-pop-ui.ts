// 字幕 tab 选区「解释」的壳接缝（arch-slim-2/06：浮层模板 + 选区监听/定位/
// 快照 + 卡片容器委托，自 ui/ui-renderer.ts 下放；解释卡片状态机与 AI 请求
// 在 reader/explain-card.ts——「随 explain 域」的两文件同居）。
//
// 交互链：在字幕句里选中词/句 → 选区下方浮出「解释」按钮（本模块）→ 点按钮
// 调 explain-card.ts 的 openReaderExplainCard（重域，经 ui/reader-gate 的
// withReader 动态装载）→ 面板内弹卡片。卡片底部「去对话追问」才写待解释意图
//（reader/explain-intent.ts 契约），由对话 tab 消费——常驻侧不直连该契约。
//
// 本模块是壳可静态携带的轻叶子：只依赖 ids 表与 reader-gate 转发助手，动态
// 边在 reader-gate 内部（chunk 边不变形）。绑定随壳构建同步执行、
// forceRecreate 重建后随壳重绑。

import { byId } from "../shared/dom-utils.js";
import { ids } from "./state.js";
import { withReader } from "../ui/reader-gate.js";

// 选区「解释」浮层：单实例、绝对定位在 tab body（不进列表滚动容器，避免随
// 滚动裁剪/漂移），在字幕句内选中词/句后定位到选区下方。
export function buildExplainPopHtml(): string {
  return `
            <!-- 选区「解释」浮层：单实例、绝对定位在 tab body（不进列表滚动
                 容器，避免随滚动裁剪/漂移），在字幕句内选中词/句后定位到选区下方 -->
            <div id="${ids.readingExplainPop}" class="boc-reading-explain-pop" hidden>
              <button type="button" class="boc-reading-explain-btn">解释</button>
            </div>
  `;
}

// 选区「解释」卡片宿主：覆盖整个 tab body 的面板内弹层（遮罩 + 对话框），
// 内容由 reader/explain-card.ts 按状态机整块重建。
export function buildExplainCardHostHtml(): string {
  return `
            <!-- 选区「解释」卡片宿主：覆盖整个 tab body 的面板内弹层（遮罩 +
                 对话框），内容由 reader/explain-card.js 按状态机整块重建 -->
            <div id="${ids.readingExplainCard}" class="boc-reading-explain-card" hidden></div>
  `;
}

export function bindReadingExplainEvents(): void {
  // 触发条件是「在字幕句里选中了词/句」，不再是 hover。选区变化经 document
  // selectionchange 单点委托（拖选/双击/键盘选区都覆盖），只在选区落在字幕列表
  // 内时显示浮层，并定位到选区下方；选区清空/移出列表/列表滚动时隐藏。
  // 浮层挂在本 tab body（非列表滚动容器）内，不进 .boc-reading-item 的点击委托
  // 链——点「解释」不会触发点句跳转。
  const readingExplainPop = byId(ids.readingExplainPop);
  const readingExplainBtn = readingExplainPop.querySelector("button") as HTMLButtonElement;
  const readingTabBodySubtitle = byId(ids.readingTabBodySubtitle);
  const subtitleList = byId(ids.readingSubtitleList);
  // 浮层显示时快照选区（条目索引 + 选中原文）：点「解释」时不再回读
  // window.getSelection()——彼时选区可能已被浏览器折叠，且快照语义更明确。
  let pendingExplainSelection: { itemIndex: string; selection: string } | null = null;
  const hideExplainPop = () => {
    // 热路径守卫：selectionchange 对页面任何输入框的选区变化都会触发，已隐藏时
    // 直接返回，避免每次敲键盘都写一遍 DOM。
    if (readingExplainPop.hidden && !pendingExplainSelection) {
      return;
    }
    readingExplainPop.hidden = true;
    delete readingExplainPop.dataset.itemIndex;
    pendingExplainSelection = null;
  };
  // 选区矩形：jsdom 无 Range.getBoundingClientRect，取不到时退回条目矩形
  //（测试环境两者都是零矩形，定位数值不参与断言）。
  const explainAnchorRect = (range: Range, item: HTMLElement) => {
    const rect = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
    if (rect && (rect.width || rect.height || rect.top || rect.left)) {
      return rect;
    }
    return item.getBoundingClientRect();
  };
  const showExplainPopForSelection = (item: HTMLElement, range: Range, selection: string) => {
    const bodyRect = readingTabBodySubtitle.getBoundingClientRect();
    const rect = explainAnchorRect(range, item);
    pendingExplainSelection = { itemIndex: item.dataset.index || "", selection };
    readingExplainPop.dataset.itemIndex = pendingExplainSelection.itemIndex;
    // 先显形再量宽：浮层宽度随文案变化。水平位置 = 选区中点正下方居中
    //（贴左右边界时收敛回 tab body 内），垂直位置 = 选区下缘留 4px。
    readingExplainPop.hidden = false;
    const popWidth = readingExplainPop.offsetWidth || 96;
    const selectionCenter = Math.round(rect.left + rect.width / 2 - bodyRect.left);
    const maxLeft = Math.max(8, Math.round(bodyRect.width) - popWidth - 8);
    readingExplainPop.style.left = `${Math.min(Math.max(8, selectionCenter - Math.round(popWidth / 2)), maxLeft)}px`;
    readingExplainPop.style.top = `${Math.max(0, Math.round(rect.bottom - bodyRect.top) + 4)}px`;
  };
  const syncExplainPopWithSelection = () => {
    const selection = window.getSelection?.();
    const text = selection?.toString().trim() || "";
    if (!selection || !text || selection.rangeCount === 0) {
      hideExplainPop();
      return;
    }
    const range = selection.getRangeAt(0);
    const anchorNode = range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement
      : (range.startContainer as HTMLElement | null);
    const item = anchorNode?.closest?.<HTMLElement>(".boc-reading-item");
    if (!item || !subtitleList.contains(item)) {
      hideExplainPop();
      return;
    }
    showExplainPopForSelection(item, range, text);
  };
  document.addEventListener("selectionchange", syncExplainPopWithSelection);
  // 按住「解释」按钮的 mousedown 必须吃掉默认动作：否则 Chrome 会先折叠页面
  // 选区 → selectionchange 把浮层连同快照一起清掉 → click 落点时已无选区可用。
  readingExplainPop.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  subtitleList.addEventListener("scroll", hideExplainPop, { passive: true });
  subtitleList.addEventListener("pointerdown", hideExplainPop);
  readingExplainBtn.addEventListener("click", () => {
    // 从渲染条目取选中所在整句（textContent + data-seconds），不回读 state 结构——
    // 语义就是「用户看到的这句」，也避免常驻侧依赖字幕数据链。
    // 索引缺失（浮层已隐藏/重复 click）按无效处理：不回退到第 0 条。
    const snapshot = pendingExplainSelection;
    const itemIndex = Number(snapshot?.itemIndex);
    const itemNode =
      snapshot && snapshot.itemIndex !== "" && Number.isFinite(itemIndex) && itemIndex >= 0
        ? subtitleList.querySelector<HTMLElement>(`[data-index="${itemIndex}"]`)
        : null;
    const line = itemNode?.querySelector(".boc-reading-text")?.textContent?.trim() || "";
    if (!itemNode || !line || !snapshot) {
      hideExplainPop();
      return;
    }
    const payload = {
      selection: snapshot.selection,
      line,
      from: Number(itemNode.dataset.seconds || 0) || 0,
      index: itemIndex
    };
    // 收起选区高亮与浮层：解释内容已取走，页面上残留的蓝色选区只剩干扰
    window.getSelection?.()?.removeAllRanges();
    hideExplainPop();
    // 解释卡片属 reader 动态域（要发 AI 请求），经 ensure 装载后调用；
    // 装载失败只记日志（解释不可用不拖垮字幕 tab 其余交互）。
    withReader("open explain card", (reader) => reader.openReaderExplainCard(payload));
  });

  // 解释卡片内点击委托（关闭 / 重试 / 去对话追问）：宿主容器不换、内容整块
  // 重建，与概览 tab 同款容器级委托；实现在 reader/explain-card.ts。
  const readingExplainCard = byId(ids.readingExplainCard);
  readingExplainCard.addEventListener("click", (event) => {
    withReader("explain card click", (reader) => reader.onReaderExplainCardClick(event as MouseEvent));
  });
}
