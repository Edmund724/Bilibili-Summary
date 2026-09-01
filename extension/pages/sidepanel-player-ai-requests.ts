// sidepanel-player-ai-requests.ts — 播放器 AI 快捷动作的消费侧（候选09 自
// sidepanel.js 迁出）。
//
// content 侧播放器 AI 面板点击快捷动作后写入 chrome.storage.local 的
// PLAYER_AI_QUICK_ACTION_STORAGE_KEY 请求（{ id, prompt, tabId, createdAt }），
// 本模块负责 sidepanel 侧的完整消费时序：
//   - normalizePlayerAiQuickActionRequest：手写校验/归一化（id/tabId 必填，
//     prompt/createdAt 宽松兜底），非法请求返回 null；
//   - consumePendingPlayerAiQuickAction：init 收尾读一次待处理请求并消费
//    （fromStorageChange=false 分支：重读最新请求防竞态——storage 变化路径
//     已把最新值带进参数，init 路径消费前需复核 id 未被更新请求顶掉）；
//   - handlePlayerAiQuickActionRequest：storage.onChanged 路径的消费体
//    （tabId 与当前活动标签不符即忽略；按路径做去重/清除后发起对话）。
//
// 依赖方向（无环叶子）：core/defaults 纯常量 + shared/messaging 无（本模块
// 直连 chrome.storage）；sidepanel 编排层依赖（getActiveTab/startNewConversation/
// sendMessage/输入框/autosize）经工厂 deps 注入，与 pages/* 其余子模块
// （createChatRuntime / createConversationStore / createSubtitleWaiter）同构。
// 本模块不 import sidepanel.js。
import { PLAYER_AI_QUICK_ACTION_STORAGE_KEY } from "../core/defaults.js";

// storage 里的快捷动作请求的归一化形态
export interface PlayerAiQuickActionRequest {
  id: string;
  prompt: string;
  tabId: number;
  createdAt: number;
}

export function normalizePlayerAiQuickActionRequest(value: unknown): PlayerAiQuickActionRequest | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const id = String(raw.id || "").trim();
  const prompt = String(raw.prompt || "").trim();
  const tabId = Number(raw.tabId || 0) || 0;
  if (!id || !tabId) {
    return null;
  }
  return {
    id,
    prompt,
    tabId,
    createdAt: Number(raw.createdAt) || Date.now()
  };
}

export interface CreatePlayerAiQuickActionsDeps {
  getActiveTab: () => Promise<{ id?: number; url?: string } | null>;
  startNewConversation: () => Promise<void> | void;
  sendMessage: () => Promise<void> | void;
  input: HTMLTextAreaElement;
  autosizeInput: () => void;
}

export function createPlayerAiQuickActions({
  getActiveTab,
  startNewConversation,
  sendMessage,
  input,
  autosizeInput
}: CreatePlayerAiQuickActionsDeps) {
  async function handlePlayerAiQuickActionRequest(
    value: unknown,
    { fromStorageChange = true }: { fromStorageChange?: boolean } = {}
  ): Promise<boolean> {
    const request = normalizePlayerAiQuickActionRequest(value);
    if (!request) {
      return false;
    }

    const activeTab = await getActiveTab().catch(() => null);
    if (activeTab?.id && request.tabId !== activeTab.id) {
      return false;
    }

    if (fromStorageChange) {
      await chrome.storage.local.remove(PLAYER_AI_QUICK_ACTION_STORAGE_KEY).catch(() => null);
    } else {
      const latest = await chrome.storage.local.get([PLAYER_AI_QUICK_ACTION_STORAGE_KEY]).catch(() => ({}) as Record<string, unknown>);
      const latestRecord = latest?.[PLAYER_AI_QUICK_ACTION_STORAGE_KEY] as { id?: unknown } | undefined;
      const latestId = String(latestRecord?.id || "").trim();
      if (latestId && latestId !== request.id) {
        return false;
      }
      await chrome.storage.local.remove(PLAYER_AI_QUICK_ACTION_STORAGE_KEY).catch(() => null);
    }

    await runPlayerAiQuickActionPrompt(request.prompt);
    return true;
  }

  async function runPlayerAiQuickActionPrompt(prompt: unknown): Promise<void> {
    const text = String(prompt || "").trim();
    if (!text) {
      autosizeInput();
      input?.focus?.();
      return;
    }
    await startNewConversation();
    input.value = text;
    autosizeInput();
    await sendMessage();
  }

  async function consumePendingPlayerAiQuickAction(): Promise<boolean> {
    const data = await chrome.storage.local.get([PLAYER_AI_QUICK_ACTION_STORAGE_KEY]).catch(() => ({}) as Record<string, unknown>);
    const request = normalizePlayerAiQuickActionRequest(data?.[PLAYER_AI_QUICK_ACTION_STORAGE_KEY]);
    if (!request) {
      return false;
    }
    return handlePlayerAiQuickActionRequest(request, { fromStorageChange: false });
  }

  return { consumePendingPlayerAiQuickAction, handlePlayerAiQuickActionRequest };
}
