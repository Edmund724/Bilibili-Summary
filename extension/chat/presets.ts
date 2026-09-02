// extension/chat/presets.ts — 预设提示词 CRUD + 双存储同步（候选09 自 sidepanel.js
// 迁出；PR5 自 extension/pages/sidepanel-presets.ts 迁入 chat 域，逻辑零语义改动）。
//
// 预设提示词有两份真相，本模块负责两份的同步写：
//   1. chatSessionState.aiPrefs.aiPresetPrompts（内存镜像，渲染层直接读）；
//   2. sync settings 的 aiPresetPrompts 字段（只写 aiPresetPrompts 单键：
//      background 的 saveSettings 按 key 合并写，不读全量，杜绝与其它写方
//      ——content reader 设置、选项页——交错时的丢写）；
// 12 条上限的截断在 add（slice(0, 12)）与 persist（slice(0, 12)）两侧各自生效，
// 语义与迁出前一致。
//
// 依赖方向（无环）：chat-state 共享状态与 shared/messaging 传输层直接
// import；渲染回调（renderPresetPrompts）与输入框元素（presetInput）经工厂
// deps 注入，与 chat/* 其余子模块同构。本模块不 import sidepanel.js。
import { sendRuntimeMessage } from "../shared/messaging.js";
import { chatSessionState } from "./chat-state.js";

export interface CreatePresetPromptsDeps {
  presetInput: HTMLInputElement;
  renderPresetPrompts: () => void;
}

export interface PresetPrompts {
  addPresetPrompt: () => Promise<void>;
  removePresetPrompt: (index: number) => Promise<void>;
  persistAiPresetPrompts: () => Promise<void>;
}

export function createPresetPrompts({ presetInput, renderPresetPrompts }: CreatePresetPromptsDeps): PresetPrompts {
  async function addPresetPrompt(): Promise<void> {
    const text = String(presetInput.value || "").trim();
    if (!text) {
      return;
    }
    const nextPrompts = [...(chatSessionState.aiPrefs.aiPresetPrompts || [])];
    if (!nextPrompts.includes(text)) {
      nextPrompts.push(text);
    }
    chatSessionState.aiPrefs.aiPresetPrompts = nextPrompts.slice(0, 12);
    await persistAiPresetPrompts();
    presetInput.value = "";
    renderPresetPrompts();
  }

  async function removePresetPrompt(index: number): Promise<void> {
    if (index < 0) {
      return;
    }
    chatSessionState.aiPrefs.aiPresetPrompts = (chatSessionState.aiPrefs.aiPresetPrompts || []).filter((_, itemIndex) => itemIndex !== index);
    await persistAiPresetPrompts();
    renderPresetPrompts();
  }

  async function persistAiPresetPrompts(): Promise<void> {
    await sendRuntimeMessage({
      type: "save-settings",
      settings: { aiPresetPrompts: (chatSessionState.aiPrefs.aiPresetPrompts || []).slice(0, 12) }
    }).catch(() => null);
  }

  return { addPresetPrompt, removePresetPrompt, persistAiPresetPrompts };
}
