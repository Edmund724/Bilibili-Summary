// model-select-width.ts — modelSelect 宽度度量（候选09 自 sidepanel.js 迁出；
// 工单 arch-review-2026-09/10 自 ui/ 搬入 chat/——三处消费全在 chat/reader 的
// 对话链（chat/providers.ts、reader/chat-tab.ts），搬家的目的是断掉 chat → ui
// 的最后一条逻辑边）。
//
// 纯 UI 度量叶子（零 import）：用离屏 canvas 按当前计算字体测量选中项文案宽，
// 叠加 "000" 兜底宽 + 36px 装饰余量，再夹在 [92, toolbar 剩余宽度] 区间内，
// 结果写回 select 的内联 width。canvas 不可用（getContext 返回 null）时退化为
// 每字符 8px 估算，行为与迁出前一致。
//
// 依赖方向：无——消费方（对话组合根/providers 工厂）在 change/resize/渲染三个
// 调用点传入其模块级 `els` 引用包（modelSelect/toolbar/thinkingToggle/presetBtn），
// 本模块不反向依赖任何页面模块，可在 jsdom 下直接单测。

// sidepanel 模块级 els 引用包中本模块关心的字段；均可缺省（缺省时走各自的
// 兜底分支：无 modelSelect 直接返回，无 toolbar 用 232 默认上限）。
export interface ModelSelectWidthEls {
  modelSelect?: HTMLSelectElement | null;
  toolbar?: HTMLElement | null;
  thinkingToggle?: HTMLElement | null;
  presetBtn?: HTMLElement | null;
}

let modelSelectMeasureCanvas: HTMLCanvasElement | null = null;
let modelSelectWidthRafId = 0;
let pendingModelSelectWidthEls: ModelSelectWidthEls | null = null;

// rAF 合帧入口（P2-3，仓内 reader/digest-host.ts 的 scheduleDigestLayout 先例）：
// resize 一帧内可触发多次，直接调用 updateModelSelectWidth 会让「读布局
//（clientWidth/offsetWidth）→ 写内联 width」在每次事件上各跑一遍，反复强制
// 布局。此处置脏 + 一帧至多跑一次，读写各发生一次。同帧重复调度以最后一次
// 传入的 els 为准（rAF 只认 fn 引用，不认形参，故显式存最新 els）。
export function scheduleModelSelectWidthUpdate(els: ModelSelectWidthEls): void {
  pendingModelSelectWidthEls = els;
  if (modelSelectWidthRafId) {
    return;
  }
  modelSelectWidthRafId = window.requestAnimationFrame(() => {
    modelSelectWidthRafId = 0;
    const target = pendingModelSelectWidthEls;
    pendingModelSelectWidthEls = null;
    if (target) {
      updateModelSelectWidth(target);
    }
  });
}

// 挂起帧无需显式作废：els 指向的壳元素随阅读模式常驻，帧回调执行时目标仍有效；
// 会话关闭只是断流，不拆 DOM。
export function updateModelSelectWidth(els: ModelSelectWidthEls): void {
  if (!els.modelSelect) {
    return;
  }
  const selectedOption = els.modelSelect.options[els.modelSelect.selectedIndex];
  const text = String(selectedOption?.textContent || "").trim() || "未配置平台";
  const computedStyle = window.getComputedStyle(els.modelSelect);
  const measuredTextWidth = measureTextWidth(text, computedStyle);
  const extraCharsWidth = measureTextWidth("000", computedStyle);
  const desiredWidth = Math.ceil(measuredTextWidth + extraCharsWidth + 36);
  const minWidth = 92;
  const maxWidth = getModelSelectMaxWidth(els);
  const nextWidth = Math.max(minWidth, Math.min(desiredWidth, maxWidth));
  els.modelSelect.style.width = `${nextWidth}px`;
}

export function measureTextWidth(text: string, style?: CSSStyleDeclaration | null): number {
  if (!modelSelectMeasureCanvas) {
    modelSelectMeasureCanvas = document.createElement("canvas");
  }
  const ctx = modelSelectMeasureCanvas.getContext("2d");
  if (!ctx) {
    return text.length * 8;
  }
  const fontStyle = style?.fontStyle || "normal";
  const fontVariant = style?.fontVariant || "normal";
  const fontWeight = style?.fontWeight || "400";
  const fontSize = style?.fontSize || "11px";
  const fontFamily = style?.fontFamily || "sans-serif";
  ctx.font = `${fontStyle} ${fontVariant} ${fontWeight} ${fontSize} ${fontFamily}`;
  return ctx.measureText(text).width;
}

function getModelSelectMaxWidth(els: ModelSelectWidthEls): number {
  const toolbar = els.toolbar;
  if (!toolbar || !els.thinkingToggle || !els.presetBtn) {
    return 232;
  }
  const style = window.getComputedStyle(toolbar);
  const gap = Number.parseFloat(style.columnGap || style.gap || "0") || 0;
  const paddingLeft = Number.parseFloat(style.paddingLeft || "0") || 0;
  const paddingRight = Number.parseFloat(style.paddingRight || "0") || 0;
  const contentWidth = toolbar.clientWidth - paddingLeft - paddingRight;
  const siblingWidth =
    els.thinkingToggle.offsetWidth + els.presetBtn.offsetWidth + gap * 2;
  return Math.max(92, Math.floor(contentWidth - siblingWidth));
}
