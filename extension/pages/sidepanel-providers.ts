// sidepanel-providers.ts — AI 平台加载渲染 + 思考档位（候选5 自 sidepanel.ts
// 迁出）：loadProvidersAndPrefs（providers + aiPrefs 整体加载，settings 获取走
// core 域消息）、renderModelSelect、renderThinkingLevel、setThinkingLevel。
// refreshProvidersAndPrefsAfterExternalChange 的「流式则不重渲染」守卫留在
// sidepanel.ts（chatRuntime 编排职责），本模块只提供加载本体。
//
// 依赖方向（无环）：共享可变状态（providers / aiPrefs / aiThinkingLevel）直接
// import；sendRuntimeMessage（shared 传输层）、localStorage 常量键、DOM 元素
//（modelSelect / thinkingBtns / updateModelSelectWidth 的 els 引用包）、渲染
// 回调（renderPresetPrompts、persistAiPresetPrompts 惰性互引 presets 实例）
// 经工厂 deps 注入。本模块不 import sidepanel.ts。
import {
  DEFAULT_PRESET_PROMPTS
} from "../core/defaults.js";
import type { Settings } from "../core/defaults.js";
import {
  normalizeAiInitialQuickPrompts,
  normalizeAiPresetPrompts,
  normalizeAiThinkingLevel
} from "../core/validators.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { escapeHtml } from "../shared/string-utils.js";
import { updateModelSelectWidth } from "../ui/model-select-width.js";
import { sidepanelState } from "./sidepanel-state.js";
import type { SidepanelProvider } from "./sidepanel-state.js";
import type { ModelSelectWidthEls } from "../ui/model-select-width.js";

export const SELECTED_PROVIDER_KEY = "boc_ai_selected_provider";
export const THINKING_LEVEL_KEY = "boc_ai_thinking_level";

export interface CreateProviderPrefsDeps {
  modelSelect: HTMLSelectElement;
  thinkingBtns: NodeListOf<HTMLElement>;
  // updateModelSelectWidth 的 els 引用包（含 toolbar/thinkingToggle/presetBtn）
  widthEls: ModelSelectWidthEls;
  renderPresetPrompts: () => void;
  // 惰性互引（组装点以箭头函数接线，回调执行时 presets 实例已存在）
  persistAiPresetPrompts: () => Promise<void>;
}

export interface ProviderPrefs {
  loadProvidersAndPrefs: (opts?: { preferredProviderId?: string }) => Promise<void>;
  renderModelSelect: (preferredProviderId?: string) => void;
  setThinkingLevel: (level: string) => Promise<void>;
}

export function createProviderPrefs(deps: CreateProviderPrefsDeps): ProviderPrefs {
  const { modelSelect, thinkingBtns, widthEls } = deps;

  // ai-providers-list 响应里的平台条目由 SidepanelProvider（sidepanel-state.ts）
  // 描述：id 必填，name/model/enabled 宽松可选。
  async function loadProvidersAndPrefs({ preferredProviderId = "" }: { preferredProviderId?: string } = {}): Promise<void> {
    const [providersResp, settingsResp] = await Promise.all([
      sendRuntimeMessage({ type: "ai-providers-list" }),
      sendRuntimeMessage({ type: "get-settings" }).catch(() => ({ ok: false }))
    ]) as [
      { providers?: SidepanelProvider[] },
      { ok?: boolean; settings?: Partial<Settings> }
    ];
    sidepanelState.providers = Array.isArray(providersResp?.providers)
      ? providersResp.providers.filter((p) => p.enabled)
      : [];
    sidepanelState.aiPrefs = {
      aiSystemPrompt: String(settingsResp?.settings?.aiSystemPrompt || "").trim(),
      aiInitialQuickPrompts: normalizeAiInitialQuickPrompts(settingsResp?.settings?.aiInitialQuickPrompts),
      aiPresetPrompts: normalizeAiPresetPrompts(settingsResp?.settings?.aiPresetPrompts),
      defaultModel: String(settingsResp?.settings?.defaultModel || "").trim()
    };
    sidepanelState.aiThinkingLevel = normalizeAiThinkingLevel(
      settingsResp?.settings?.aiThinkingLevel ?? localStorage.getItem(THINKING_LEVEL_KEY)
    );
    if (!sidepanelState.aiPrefs.aiPresetPrompts.length) {
      sidepanelState.aiPrefs.aiPresetPrompts = DEFAULT_PRESET_PROMPTS.slice();
      void deps.persistAiPresetPrompts();
    }
    renderModelSelect(preferredProviderId);
    renderThinkingLevel();
    deps.renderPresetPrompts();
  }

  function renderModelSelect(preferredProviderId = ""): void {
    if (!sidepanelState.providers.length) {
      modelSelect.innerHTML = '<option value="">未配置平台</option>';
      modelSelect.disabled = true;
      modelSelect.style.width = "96px";
      return;
    }

    modelSelect.innerHTML = sidepanelState.providers
      .map((p) => {
        const label = String(p.model || p.name || "").trim();
        return `<option value="${escapeHtml(p.id)}">${escapeHtml(label)}</option>`;
      })
      .join("");

    const savedProviderId = String(preferredProviderId || sidepanelState.aiPrefs.defaultModel || localStorage.getItem(SELECTED_PROVIDER_KEY) || "").trim();
    const matchedProvider = sidepanelState.providers.find((item) => item.id === savedProviderId) || sidepanelState.providers[0];
    modelSelect.value = matchedProvider?.id || "";
    modelSelect.disabled = false;
    updateModelSelectWidth(widthEls);
  }

  function renderThinkingLevel(): void {
    thinkingBtns.forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.level === sidepanelState.aiThinkingLevel);
      btn.setAttribute("aria-pressed", btn.dataset.level === sidepanelState.aiThinkingLevel ? "true" : "false");
    });
  }

  async function setThinkingLevel(level: string): Promise<void> {
    sidepanelState.aiThinkingLevel = normalizeAiThinkingLevel(level);
    renderThinkingLevel();
    localStorage.setItem(THINKING_LEVEL_KEY, sidepanelState.aiThinkingLevel);
    await sendRuntimeMessage({ type: "save-settings", settings: { aiThinkingLevel: sidepanelState.aiThinkingLevel } }).catch(() => null);
  }

  return { loadProvidersAndPrefs, renderModelSelect, setThinkingLevel };
}
