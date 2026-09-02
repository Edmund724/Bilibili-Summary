// reader/chat-lists.ts — 对话 tab 三列表渲染 + 预设提示词插入（PR5 自
// extension/pages/sidepanel-lists.ts 重建：逻辑照抄（renderSuggestions /
// renderPresetPrompts / renderHistoryList / insertPresetPrompt 的每个分支与
// 事件语义逐字一致），DOM 壳换新——元素经 deps 注入 reader 的 readingChat* id
// 节点，class 名沿用 .chat-*（样式段随对话区并入 reader.css，token 化三主题）。
//
// 与 sidepanel 孪生模块的取舍：过渡期并存（工单 08 决议），sidepanel 摘除时
// 本文件成为唯一实现，届时把 tests/reader/chat-lists.test.ts 的断言接回即可。
// 逻辑改动零容忍：任何行为差异先改 sidepanel 孪生并同步到这里。
//
// 依赖方向（无环）：共享可变状态（../chat/chat-state）与 ai/conversation 纯辅助
// 直接 import；DOM 元素、会话动作、预设 CRUD、布局回调、建议点击发送、
// suggestionsNode 单例钩子经工厂 deps 注入。本模块不 import 组合根。
import {
  doesConversationMatchCurrentContext,
  doesTabMatchContextUrl,
  formatConversationTimestamp,
  buildConversationTitleDisplay
} from "../ai/conversation.js";
import { escapeHtml } from "../shared/string-utils.js";
import { normalizeAiInitialQuickPrompts } from "../core/validators.js";
import { chatSessionState } from "../chat/chat-state.js";

export interface CreateReaderChatListsDeps {
  presetList: HTMLElement;
  historyList: HTMLElement;
  historyClearBtn: HTMLButtonElement | null;
  input: HTMLTextAreaElement;
  // 会话动作（conversation-store 实例的窄接口）
  applyById: (id: string) => void;
  deleteById: (id: string) => Promise<void>;
  // 预设 CRUD（../chat/presets 实例的窄接口）
  removePresetPrompt: (index: number) => Promise<void>;
  // 布局 / 发送回调（组合根提供）
  autosizeInput: () => void;
  onSuggestionClick: (prompt: string) => void;
  // suggestionsNode 单例 getter（组合根持有）
  getSuggestionsNode: () => HTMLElement | null;
  // 惰性互引（组装点以箭头函数接线，回调执行时实例已存在）
  insertPresetPrompt: (prompt: string) => void;
  hidePresetPopover: () => void;
  hideHistoryPopover: () => void;
}

export interface ReaderChatLists {
  renderSuggestions: () => void;
  renderPresetPrompts: () => void;
  renderHistoryList: () => void;
  insertPresetPrompt: (prompt: string) => void;
}

export function createReaderChatLists(deps: CreateReaderChatListsDeps): ReaderChatLists {
  const { presetList, historyList, historyClearBtn, input, getSuggestionsNode } = deps;

  function renderSuggestions(): void {
    const suggestionsNode = getSuggestionsNode();
    if (!suggestionsNode) {
      return;
    }
    if (!chatSessionState.contextData || !chatSessionState.providers.length || chatSessionState.chatHistory.length || chatSessionState.contextData.isVideoContext === false) {
      suggestionsNode.innerHTML = "";
      return;
    }
    const prompts = normalizeAiInitialQuickPrompts(chatSessionState.aiPrefs.aiInitialQuickPrompts).filter(Boolean);
    suggestionsNode.innerHTML = prompts
      .map((prompt) => `<button type="button" class="chat-chip">${escapeHtml(prompt)}</button>`)
      .join("");
    suggestionsNode.querySelectorAll(".chat-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        input.value = btn.textContent || "";
        deps.autosizeInput();
        deps.onSuggestionClick(btn.textContent || "");
      });
    });
  }

  function renderPresetPrompts(): void {
    if (!presetList) {
      return;
    }
    const prompts = Array.isArray(chatSessionState.aiPrefs.aiPresetPrompts) ? chatSessionState.aiPrefs.aiPresetPrompts : [];
    if (!prompts.length) {
      presetList.innerHTML = '<span class="chat-preset-empty">还没有预设提示词</span>';
      return;
    }
    presetList.innerHTML = prompts
      .map((prompt, index) => `
        <span class="chat-preset-item">
          <button type="button" class="chat-preset-chip" data-index="${index}" title="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>
          <button type="button" class="chat-preset-remove" data-index="${index}" aria-label="删除预设提示词">×</button>
        </span>
      `)
      .join("");
    presetList.querySelectorAll(".chat-preset-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const index = Number(btn.getAttribute("data-index") || -1);
        deps.insertPresetPrompt(prompts[index] || "");
        deps.hidePresetPopover();
      });
    });
    presetList.querySelectorAll(".chat-preset-remove").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const index = Number(btn.getAttribute("data-index") || -1);
        await deps.removePresetPrompt(index);
      });
    });
  }

  function renderHistoryList(): void {
    if (!historyList) {
      return;
    }
    if (historyClearBtn) {
      historyClearBtn.hidden = chatSessionState.savedConversations.length === 0;
    }
    if (!chatSessionState.savedConversations.length) {
      historyList.innerHTML = '<span class="chat-history-empty">还没有历史对话</span>';
      return;
    }

    const liveVideoRef = chatSessionState.liveContextData?.isVideoContext ? chatSessionState.liveContextData : null;
    const canHighlightLiveMatches = Boolean(
      liveVideoRef &&
      chatSessionState.currentConversationMeta?.pinnedContext &&
      chatSessionState.currentConversationMeta?.contextUrl &&
      !doesTabMatchContextUrl(liveVideoRef.url || chatSessionState.liveTabUrl, chatSessionState.currentConversationMeta.contextUrl || "")
    );

    historyList.innerHTML = chatSessionState.savedConversations
      .map((conversation) => {
        const isActive = conversation.id === chatSessionState.currentConversationId;
        const isLiveMatch = Boolean(
          !isActive &&
          canHighlightLiveMatches &&
          doesConversationMatchCurrentContext(conversation, liveVideoRef, chatSessionState.liveContextKey)
        );
        const metaText = formatConversationTimestamp(conversation.updatedAt || conversation.createdAt);
        const titleDisplay = buildConversationTitleDisplay(conversation.title, 30);
        return `
          <div class="chat-history-item ${isActive ? "is-active" : ""} ${isLiveMatch ? "is-live-match" : ""}" data-id="${escapeHtml(conversation.id)}">
            <button type="button" class="chat-history-open" data-id="${escapeHtml(conversation.id)}">
              <span class="chat-history-title" title="${escapeHtml(conversation.title)}">
                <span class="chat-history-title-main">${escapeHtml(titleDisplay.main)}</span>
                ${titleDisplay.suffix ? `<span class="chat-history-title-suffix">${escapeHtml(titleDisplay.suffix)}</span>` : ""}
              </span>
              <span class="chat-history-meta" title="${escapeHtml(metaText)}">${escapeHtml(metaText)}</span>
            </button>
            <button type="button" class="chat-history-remove" data-id="${escapeHtml(conversation.id)}" aria-label="删除历史对话">×</button>
          </div>
        `;
      })
      .join("");

    historyList.querySelectorAll(".chat-history-open").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = String(btn.getAttribute("data-id") || "");
        deps.applyById(id);
        deps.hideHistoryPopover();
      });
    });

    historyList.querySelectorAll(".chat-history-remove").forEach((btn) => {
      btn.addEventListener("click", async (event) => {
        event.stopPropagation();
        const id = String(btn.getAttribute("data-id") || "");
        await deps.deleteById(id);
      });
    });
  }

  function insertPresetPrompt(prompt: string): void {
    const text = String(prompt || "").trim();
    if (!text) {
      return;
    }
    const current = input.value.trim();
    input.value = current ? `${current}\n${text}` : text;
    input.focus();
    deps.autosizeInput();
  }

  return { renderSuggestions, renderPresetPrompts, renderHistoryList, insertPresetPrompt };
}
