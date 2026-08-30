// model-select-width.js — modelSelect 宽度度量（候选09 自 sidepanel.js 迁出）。
//
// 纯 UI 度量叶子（零 import）：用离屏 canvas 按当前计算字体测量选中项文案宽，
// 叠加 "000" 兜底宽 + 36px 装饰余量，再夹在 [92, toolbar 剩余宽度] 区间内，
// 结果写回 select 的内联 width。canvas 不可用（getContext 返回 null）时退化为
// 每字符 8px 估算，行为与迁出前一致。
//
// 依赖方向：无——侧面板（sidepanel.js）在 change/resize/渲染三个调用点传入
// 其模块级 `els` 引用包（modelSelect/toolbar/thinkingToggle/presetBtn），本
// 模块不反向依赖任何页面模块，可在 jsdom 下直接单测。
let modelSelectMeasureCanvas = null;

export function updateModelSelectWidth(els) {
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

export function measureTextWidth(text, style) {
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

function getModelSelectMaxWidth(els) {
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
