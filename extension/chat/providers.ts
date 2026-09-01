// extension/chat/providers.ts — AI 平台加载渲染 + 思考档位（候选5 自 sidepanel.ts
// 迁出；PR5 自 extension/pages/sidepanel-providers.ts 迁入 chat 域并改造持久化
// 通道）：loadProvidersAndPrefs（providers + aiPrefs 整体加载，settings 获取走
// core 域消息）、renderModelSelect、renderThinkingLevel、setThinkingLevel、
// setSelectedProvider。
// refreshProvidersAndPrefsAfterExternalChange 的「流式则不重渲染」守卫留在
// sidepanel.ts（chatRuntime 编排职责），本模块只提供加载本体。
//
// PR5 改造（持久化通道）：SELECTED_PROVIDER_KEY / THINKING_LEVEL_KEY 从
// sidepanel 页面的 localStorage 换成 chrome.storage.local——reader 上下文与
// 扩展页 localStorage 不同源，不迁移则「选中的平台」在 reader 内每次丢失
// （盘点报告风险点 2）。aiThinkingLevel 原有的 sync settings 双持久化保留
//（读取以 settings ?? storage 为准）。过渡期迁移：loadProvidersAndPrefs 读取
// 时发现 chrome.storage 缺键且 localStorage（sidepanel 扩展页历史通道）有值
// 则一次性写入 chrome.storage，保证用户已选平台/档位不丢；迁移幂等（chrome.
// storage 有键后不再触发），reader 上下文读不到扩展 localStorage，不触发。
//
// 依赖方向（无环）：共享可变状态（providers / aiPrefs / aiThinkingLevel）直接
// import；sendRuntimeMessage（shared 传输层）、chrome.storage 抽象（可注入，
// 缺省全局 chrome.storage.local）、DOM 元素（modelSelect / thinkingBtns /
// updateModelSelectWidth 的 els 引用包）、渲染回调（renderPresetPrompts、
// persistAiPresetPrompts 惰性互引 presets 实例）经工厂 deps 注入。本模块不
// import 组合根。
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
import { sidepanelState } from "./chat-state.js";
import type { SidepanelProvider } from "./chat-state.js";
import type { ModelSelectWidthEls } from "../ui/model-select-width.js";

export const SELECTED_PROVIDER_KEY = "boc_ai_selected_provider";
export const THINKING_LEVEL_KEY = "boc_ai_thinking_level";

// chrome.storage.local 的窄视图（conversation-store 的 StorageArea 同型；
// 缺省取全局 chrome.storage.local，测试注入 fake）。
export interface ProviderPrefsStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface CreateProviderPrefsDeps {
  modelSelect: HTMLSelectElement;
  thinkingBtns: NodeListOf<HTMLElement>;
  // updateModelSelectWidth 的 els 引用包（含 toolbar/thinkingToggle/presetBtn）
  widthEls: ModelSelectWidthEls;
  renderPresetPrompts: () => void;
  // 惰性互引（组装点以箭头函数接线，回调执行时 presets 实例已存在）
  persistAiPresetPrompts: () => Promise<void>;
  // chrome.storage.local 抽象（PR5 改造：原 localStorage 通道换此注入点；
  // 缺省取全局 chrome.storage.local）
  storage?: ProviderPrefsStorage;
}

export interface ProviderPrefs {
  loadProvidersAndPrefs: (opts?: { preferredProviderId?: string }) => Promise<void>;
  renderModelSelect: (preferredProviderId?: string) => void;
  setThinkingLevel: (level: string) => Promise<void>;
  // 选中平台写入 chrome.storage.local（原 sidepanel.ts modelSelect change
  // 监听里的 localStorage.setItem 换通道）；闭包缓存同步更新供
  // renderModelSelect 的同步回退读取。
  setSelectedProvider: (providerId: string) => void;
  // 最近一次读到的 chrome.storage 选中平台（组合根在外部变更刷新时取
  // previousProviderId 用——原 localStorage.getItem 的替代）。
  getStoredSelectedProviderId: () => string;
}

// sidepanel 扩展页 localStorage 的历史值读取（过渡期迁移专用；reader 上下文
// 读不到扩展 localStorage，getItem 自然为 null，不触发迁移）。
function readLegacyLocalStorage(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

export function createProviderPrefs(deps: CreateProviderPrefsDeps): ProviderPrefs {
  const { modelSelect, thinkingBtns, widthEls } = deps;
  const storage =
    deps.storage ||
    (typeof chrome !== "undefined" && chrome?.storage?.local ? chrome.storage.local : undefined);

  // chrome.storage.local 里最近读到的选中平台 id（loadProvidersAndPrefs 异步
  // 预取 + setSelectedProvider 写入时同步更新）。renderModelSelect 的同步回退
  // 读取由该闭包缓存承接——localStorage 时代「同步读选中平台」的语义。
  let storedSelectedProviderId = "";

  // 读 chrome.storage.local 两个偏好键 + 过渡期一次性搬迁（详见文件头注）。
  // 返回值 = storage 现值 ∪ 迁移补写的 localStorage 遗留值。
  async function loadStoredPrefs(): Promise<Record<string, unknown>> {
    let stored: Record<string, unknown> = {};
    if (storage) {
      try {
        stored = (await storage.get([SELECTED_PROVIDER_KEY, THINKING_LEVEL_KEY])) || {};
      } catch {
        stored = {};
      }
    }
    const merged = { ...stored };
    const patch: Record<string, unknown> = {};
    const legacyProvider = readLegacyLocalStorage(SELECTED_PROVIDER_KEY);
    const legacyThinking = readLegacyLocalStorage(THINKING_LEVEL_KEY);
    if (!(SELECTED_PROVIDER_KEY in stored) && legacyProvider) {
      patch[SELECTED_PROVIDER_KEY] = legacyProvider;
      merged[SELECTED_PROVIDER_KEY] = legacyProvider;
    }
    if (!(THINKING_LEVEL_KEY in stored) && legacyThinking) {
      patch[THINKING_LEVEL_KEY] = legacyThinking;
      merged[THINKING_LEVEL_KEY] = legacyThinking;
    }
    if (storage && Object.keys(patch).length) {
      await storage.set(patch).catch(() => {});
    }
    return merged;
  }

  // ai-providers-list 响应里的平台条目由 SidepanelProvider（chat-state.ts）
  // 描述：id 必填，name/model/enabled 宽松可选。
  async function loadProvidersAndPrefs({ preferredProviderId = "" }: { preferredProviderId?: string } = {}): Promise<void> {
    const [providersResp, settingsResp, storedPrefs] = await Promise.all([
      sendRuntimeMessage({ type: "ai-providers-list" }),
      sendRuntimeMessage({ type: "get-settings" }).catch(() => ({ ok: false })),
      loadStoredPrefs()
    ]) as [
      { providers?: SidepanelProvider[] },
      { ok?: boolean; settings?: Partial<Settings> },
      Record<string, unknown>
    ];
    storedSelectedProviderId = String(storedPrefs[SELECTED_PROVIDER_KEY] || "").trim();
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
      settingsResp?.settings?.aiThinkingLevel ?? storedPrefs[THINKING_LEVEL_KEY]
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

    const savedProviderId = String(preferredProviderId || sidepanelState.aiPrefs.defaultModel || storedSelectedProviderId || "").trim();
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
    if (storage) {
      await storage.set({ [THINKING_LEVEL_KEY]: sidepanelState.aiThinkingLevel }).catch(() => {});
    }
    await sendRuntimeMessage({ type: "save-settings", settings: { aiThinkingLevel: sidepanelState.aiThinkingLevel } }).catch(() => null);
  }

  function setSelectedProvider(providerId: string): void {
    storedSelectedProviderId = String(providerId || "").trim();
    if (storage) {
      void storage.set({ [SELECTED_PROVIDER_KEY]: storedSelectedProviderId }).catch(() => {});
    }
  }

  function getStoredSelectedProviderId(): string {
    return storedSelectedProviderId;
  }

  return { loadProvidersAndPrefs, renderModelSelect, setThinkingLevel, setSelectedProvider, getStoredSelectedProviderId };
}
