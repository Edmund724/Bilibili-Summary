// sidepanel-notices.ts — 消息区提示 / 居中态 / 建议区清理 / 近底判定
//（候选5 自 sidepanel.ts 迁出）：showConversationContextNotice（消息区通知条，
// 支持自动消失与「前往设置」链接）、removeConversationContextNotice、
// showConversationContextError（居中错误块）、removeCenteredState、
// removeSuggestions（建议区节点清理）、isMessagesNearBottom（自动滚动判定）。
//
// 依赖方向（无环）：DOM 容器（messages）与 suggestionsNode 单例的读写钩子
//（getSuggestionsNode / setSuggestionsNode——该节点是 sidepanel.ts 的纯局部
// 单例，resetConversationView 重建，removeSuggestions 必须同步置空，否则
// renderSuggestions 会渲染进游离节点）经工厂 deps 注入；定时器可注入
//（生产组装点用 window.setTimeout/clearTimeout，测试手动推进）。通知条的
// 自动消失定时器（contextNoticeTimer）是本模块闭包内私有状态，随工厂实例
// 存活。本模块不 import sidepanel.ts。
export interface CreateConversationFeedbackDeps {
  messages: HTMLElement;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
  // showConversationContextError 追加居中错误块后滚动到底（chatRuntime 的
  // scrollToBottom，惰性接线）
  scrollToBottom: () => void;
  getSuggestionsNode: () => HTMLElement | null;
  setSuggestionsNode: (node: HTMLElement | null) => void;
}

export interface ConversationFeedback {
  showConversationContextNotice: (message: string, autoHideMs?: number, options?: { openSettingsAction?: boolean }) => void;
  removeConversationContextNotice: () => void;
  showConversationContextError: (message: string) => void;
  removeCenteredState: () => void;
  removeSuggestions: () => void;
  isMessagesNearBottom: (threshold?: number) => boolean;
}

export function createConversationFeedback({ messages, setTimer, clearTimer, scrollToBottom, getSuggestionsNode, setSuggestionsNode }: CreateConversationFeedbackDeps): ConversationFeedback {
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
        chrome.runtime.openOptionsPage();
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
