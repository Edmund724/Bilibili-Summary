// reader/chat-notices.ts — 对话 tab 消息区提示 / 居中态 / 建议区清理 / 近底判定
//（PR5 自 extension/pages/sidepanel-notices.ts 重建：逻辑照抄（通知条去重、
// textContent 防注入、自动消失定时器、居中错误块、suggestionsNode 同步置空、
// 近底阈值），DOM 壳换新——容器经 deps 注入 reader 的 readingChatMessages，
// class 名沿用 .sp-context-notice / .sp-center-error / .sp-suggestions）。
//
// 唯一语义改造（盘点报告 §1.1 notices 判定行）：「前往设置」链接在 reader
//（content script）语境下没有 chrome.runtime.openOptionsPage；digest-only-ui
// 起 open-options 消息与独立设置页已删除，链接点击经 deps.onOpenSettings
// 回调打开侧边栏设置抽屉（生产组装点在 reader/chat-tab.ts 注入，转发到
// ui-renderer 的 openReaderSettingsPanel）。
//
// 依赖方向（无环）：DOM 容器与 suggestionsNode 单例的读写钩子经工厂 deps 注入；
// 定时器可注入（生产组装点用 window.setTimeout/clearTimeout，测试手动推进）。
// 通知条自动消失定时器是本模块闭包私有状态。本模块不 import 组合根。

export interface CreateReaderChatFeedbackDeps {
  messages: HTMLElement;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
  // showConversationContextError 追加居中错误块后滚动到底（chatRuntime 的
  // scrollToBottom，惰性接线）
  scrollToBottom: () => void;
  getSuggestionsNode: () => HTMLElement | null;
  setSuggestionsNode: (node: HTMLElement | null) => void;
  // 通知条「前往设置」链接的点击回调（打开侧边栏设置抽屉）
  onOpenSettings: () => void;
}

export interface ReaderChatFeedback {
  showConversationContextNotice: (message: string, autoHideMs?: number, options?: { openSettingsAction?: boolean }) => void;
  removeConversationContextNotice: () => void;
  showConversationContextError: (message: string) => void;
  removeCenteredState: () => void;
  removeSuggestions: () => void;
  isMessagesNearBottom: (threshold?: number) => boolean;
}

export function createReaderChatFeedback({ messages, setTimer, clearTimer, scrollToBottom, getSuggestionsNode, setSuggestionsNode, onOpenSettings }: CreateReaderChatFeedbackDeps): ReaderChatFeedback {
  // 通知条自动消失定时器（闭包私有单例；0 = 无挂起定时器）
  let contextNoticeTimer = 0;

  function showConversationContextNotice(message: string, autoHideMs = 0, { openSettingsAction = false }: { openSettingsAction?: boolean } = {}): void {
    removeConversationContextNotice();
    const notice = document.createElement("div");
    notice.className = "sp-context-notice";
    notice.textContent = String(message || "").trim();
    if (openSettingsAction) {
      const link = document.createElement("a");
      link.href = "#";
      link.textContent = "前往设置";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        onOpenSettings();
      });
      notice.appendChild(document.createTextNode(" "));
      notice.appendChild(link);
    }
    messages.prepend(notice);
    if (autoHideMs > 0) {
      contextNoticeTimer = setTimer(() => {
        removeConversationContextNotice();
      }, autoHideMs);
    }
  }

  function removeConversationContextNotice(): void {
    if (contextNoticeTimer) {
      clearTimer(contextNoticeTimer);
      contextNoticeTimer = 0;
    }
    messages.querySelectorAll(".sp-context-notice").forEach((node) => node.remove());
  }

  function showConversationContextError(message: string): void {
    if (!String(message || "").trim()) {
      return;
    }
    removeConversationContextNotice();
    removeCenteredState();
    const stateNode = document.createElement("div");
    stateNode.className = "sp-center-error";
    stateNode.textContent = String(message);
    messages.appendChild(stateNode);
    scrollToBottom();
  }

  function removeCenteredState(): void {
    messages.querySelectorAll(".sp-center-error").forEach((node) => node.remove());
  }

  function removeSuggestions(): void {
    getSuggestionsNode()?.remove();
    setSuggestionsNode(null);
  }

  function isMessagesNearBottom(threshold = 56): boolean {
    const { scrollTop, scrollHeight, clientHeight } = messages;
    return scrollHeight - (scrollTop + clientHeight) <= threshold;
  }

  return {
    showConversationContextNotice,
    removeConversationContextNotice,
    showConversationContextError,
    removeCenteredState,
    removeSuggestions,
    isMessagesNearBottom
  };
}
