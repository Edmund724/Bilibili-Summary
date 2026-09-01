// sidepanel-popovers.ts — 预设/历史两个 popover 的开合与文档级外点关闭
//（候选5 自 sidepanel.ts 迁出）：togglePresetPopover、hidePresetPopover、
// toggleHistoryPopover、hideHistoryPopover、handleDocumentClick。
//
// 依赖方向（无环）：DOM 元素（两个 popover、两个按钮、预设输入框）与开合
// 时的列表刷新回调（renderPresetPrompts / renderHistoryList）经工厂 deps
// 注入；文档级 click 监听的挂载/卸载由组装点（sidepanel.ts bindEvents）负责，
// 本模块只暴露 handleDocumentClick 供其绑定。本模块不 import sidepanel.ts。
export interface CreatePopoversDeps {
  presetPopover: HTMLElement;
  historyPopover: HTMLElement;
  presetBtn: HTMLElement;
  historyBtn: HTMLElement;
  presetInput: HTMLInputElement;
  renderPresetPrompts: () => void;
  renderHistoryList: () => void;
}

export interface Popovers {
  togglePresetPopover: (event?: Event) => void;
  hidePresetPopover: () => void;
  toggleHistoryPopover: (event?: Event) => void;
  hideHistoryPopover: () => void;
  handleDocumentClick: (event: MouseEvent) => void;
}

export function createPopovers(deps: CreatePopoversDeps): Popovers {
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

  function handleDocumentClick(event: MouseEvent): void {
    if (presetPopover.hidden && historyPopover.hidden) {
      return;
    }
    if (!(event.target instanceof Element)) {
      hidePresetPopover();
      hideHistoryPopover();
      return;
    }
    if (event.target.closest("#spPresetPopover") || event.target.closest("#spPresetBtn")) {
      return;
    }
    if (event.target.closest("#spHistoryPopover") || event.target.closest("#spHistoryBtn")) {
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
