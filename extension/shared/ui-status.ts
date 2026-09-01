// 轻量状态栏/消息写入器（候选3 常驻瘦身）。
//
// setStatus / setMessage 原在 ui/ui-renderer.js，被 message-handler、player-ai、
// 总结链等多处引用。若继续放在 ui-renderer，该模块随面板/阅读壳一起被拖入
// 常驻闭包。本模块只负责把文案写入 state 并在 DOM 节点已存在时同步更新，
// 不依赖 UI 壳的构建，因此自身保持常驻轻量；ui/ui-renderer.js 的壳构建逻辑
// 则整体惰性化。

import { state, uiState } from "../core/state.js";
import { ids } from "../reader/state.js";

function getOptionalElement(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function setStatus(text: string): void {
  uiState.setStatusText(String(text || ""));
  const node = getOptionalElement(ids.status);
  if (node) {
    node.textContent = state.ui.statusText;
  }
}

export function setMessage(text: string): void {
  uiState.setMessageText(String(text || ""));
  const node = getOptionalElement(ids.message);
  if (node) {
    node.textContent = state.ui.messageText;
  }
}
