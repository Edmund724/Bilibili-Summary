// reader/chat-popovers.ts — 对话 tab 预设/历史两个 popover 的开合与文档级外点
// 关闭（PR5 自 extension/pages/sidepanel-popovers.ts 重建：toggle/hide 与
// handleDocumentClick 的判定分支逐字一致）。
//
// 两处换壳（盘点报告 §1.1 popovers 判定行 + 风险 6 决议）：
//   1. 外点关闭的 id 选择器换 reader 的 readingChat* id（原 #sp* 硬编码）；
//   2. handleDocumentClick 不再自挂 document 监听——经 reader/chat-tab-bridge.ts
//      的注册槽并入 ui-renderer 的单一文档级委托（防双监听互踩）。本模块只暴露
//      handleDocumentClick 供组合根注册（组合根负责注册/摘除时机）。
import { ids } from "./state.js";

export interface CreateReaderChatPopoversDeps {
  presetPopover: HTMLElement;
  historyPopover: HTMLElement;
  presetBtn: HTMLElement;
  historyBtn: HTMLElement;
  presetInput: HTMLInputElement;
  renderPresetPrompts: () => void;
  renderHistoryList: () => void;
}

export interface ReaderChatPopovers {
  togglePresetPopover: (event?: Event) => void;
  hidePresetPopover: () => void;
  toggleHistoryPopover: (event?: Event) => void;
  hideHistoryPopover: () => void;
  handleDocumentClick: (event: MouseEvent) => void;
}

export function createReaderChatPopovers(deps: CreateReaderChatPopoversDeps): ReaderChatPopovers {
  const { presetPopover, historyPopover, presetInput } = deps;

  function togglePresetPopover(event?: Event): void {
    event?.stopPropagation();
    hideHistoryPopover();
    const willShow = presetPopover.hidden;
    presetPopover.hidden = !willShow;
    if (willShow) {
      deps.renderPresetPrompts();
      presetInput.value = "";
      presetInput.focus();
    }
  }

  function hidePresetPopover(): void {
    presetPopover.hidden = true;
  }

  function toggleHistoryPopover(event?: Event): void {
    event?.stopPropagation();
    hidePresetPopover();
    const willShow = historyPopover.hidden;
    historyPopover.hidden = !willShow;
    if (willShow) {
      deps.renderHistoryList();
    }
  }

  function hideHistoryPopover(): void {
    historyPopover.hidden = true;
  }

  // 外点关闭（由组合根经 chat-tab-bridge 注册进 ui-renderer 的单一文档级委托）：
  // 判定分支与 sidepanel 孪生逐字一致，仅 id 选择器换 readingChat* 前缀。
  function handleDocumentClick(event: MouseEvent): void {
    if (presetPopover.hidden && historyPopover.hidden) {
      return;
    }
    if (!(event.target instanceof Element)) {
      hidePresetPopover();
      hideHistoryPopover();
      return;
    }
    if (event.target.closest(`#${ids.readingChatPresetPopover}`) || event.target.closest(`#${ids.readingChatPresetBtn}`)) {
      return;
    }
    if (event.target.closest(`#${ids.readingChatHistoryPopover}`) || event.target.closest(`#${ids.readingChatHistoryBtn}`)) {
      return;
    }
    hidePresetPopover();
    hideHistoryPopover();
  }

  return {
    togglePresetPopover,
    hidePresetPopover,
    toggleHistoryPopover,
    hideHistoryPopover,
    handleDocumentClick
  };
}
