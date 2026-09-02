// reader/chat-lists.ts — 对话 tab 三列表渲染 + 预设提示词插入（PR5 自
// extension/pages/sidepanel-lists.ts 重建：逻辑照抄（renderSuggestions /
// renderPresetPrompts / renderHistoryList / insertPresetPrompt 的每个分支与
// 事件语义逐字一致），DOM 壳换新——元素经 deps 注入 reader 的 readingChat* id
// 节点，class 名沿用 .sp-*（样式段随对话区并入 reader.css，token 化三主题）。
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
import { sidepanelState } from "../chat/chat-state.js";

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
    if (!sidepanelState.contextData || !sidepanelState.providers.length || sidepanelState.chatHistory.length || sidepanelState.contextData.isVideoContext === false) {
      suggestionsNode.innerHTML = "";
      return;
    }
    const prompts = normalizeAiInitialQuickPrompts(sidepanelState.aiPrefs.aiInitialQuickPrompts).filter(Boolean);
    suggestionsNode.innerHTML = prompts
      .map((prompt) => `<button type="button" class="sp-chip">${escapeHtml(prompt)}</button>`)
      .join("");
    suggestionsNode.querySelectorAll(".sp-chip").forEach((btn) => {
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
    const prompts = Array.isArray(sidepanelState.aiPrefs.aiPresetPrompts) ? sidepanelState.aiPrefs.aiPresetPrompts : [];
    if (!prompts.length) {
      presetList.innerHTML = '<span class="sp-preset-empty">还没有预设提示词</span>';
      return;
    }
    presetList.innerHTML = prompts
      .map((prompt, index) => `
        <span class="sp-preset-item">
          <button type="button" class="sp-preset-chip" data-index="${index}" title="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>
          <button type="button" class="sp-preset-remove" data-index="${index}" aria-label="删除预设提示词">×</button>
        </span>
      `)
      .join("");
    presetList.querySelectorAll(".sp-preset-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const index = Number(btn.getAttribute("data-index") || -1);
        deps.insertPresetPrompt(prompts[index] || "");
        deps.hidePresetPopover();
      });
    });
    presetList.querySelectorAll(".sp-preset-remove").forEach((btn) => {
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
      historyClearBtn.hidden = sidepanelState.savedConversations.length === 0;
    }
    if (!sidepanelState.savedConversations.length) {
      historyList.innerHTML = '<span class="sp-history-empty">还没有历史对话</span>';
      return;
    }

    const liveVideoRef = sidepanelState.liveContextData?.isVideoContext ? sidepanelState.liveContextData : null;
    const canHighlightLiveMatches = Boolean(
      liveVideoRef &&
      sidepanelState.currentConversationMeta?.pinnedContext &&
      sidepanelState.currentConversationMeta?.contextUrl &&
      !doesTabMatchContextUrl(liveVideoRef.url || sidepanelState.liveTabUrl, sidepanelState.currentConversationMeta.contextUrl || "")
    );

    historyList.innerHTML = sidepanelState.savedConversations
      .map((conversation) => {
        const isActive = conversation.id === sidepanelState.currentConversationId;
        const isLiveMatch = Boolean(
          !isActive &&
          canHighlightLiveMatches &&
          doesConversationMatchCurrentContext(conversation, liveVideoRef, sidepanelState.liveContextKey)
        );
        const metaText = formatConversationTimestamp(conversation.updatedAt || conversation.createdAt);
        const titleDisplay = buildConversationTitleDisplay(conversation.title, 30);
        return `
          <div class="sp-history-item ${isActive ? "is-active" : ""} ${isLiveMatch ? "is-live-match" : ""}" data-id="${escapeHtml(conversation.id)}">
            <button type="button" class="sp-history-open" data-id="${escapeHtml(conversation.id)}">
              <span class="sp-history-title" title="${escapeHtml(conversation.title)}">
                <span class="sp-history-title-main">${escapeHtml(titleDisplay.main)}</span>
                ${titleDisplay.suffix ? `<span class="sp-history-title-suffix">${escapeHtml(titleDisplay.suffix)}</span>` : ""}
              </span>
              <span class="sp-history-meta" title="${escapeHtml(metaText)}">${escapeHtml(metaText)}</span>
            </button>
            <button type="button" class="sp-history-remove" data-id="${escapeHtml(conversation.id)}" aria-label="删除历史对话">×</button>
          </div>
        `;
      })
      .join("");

    historyList.querySelectorAll(".sp-history-open").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = String(btn.getAttribute("data-id") || "");
        deps.applyById(id);
        deps.hideHistoryPopover();
      });
    });

    historyList.querySelectorAll(".sp-history-remove").forEach((btn) => {
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
