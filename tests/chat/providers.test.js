// tests/chat/providers.test.js
// createProviderPrefs（AI 平台加载渲染 + 思考档位）行为契约（候选5 拆分直测；
// PR5 自 tests/sidepanel/sidepanel-providers.test.js 随迁并适配持久化通道改造：
// localStorage → chrome.storage.local，通道断言随改造更新，渲染/归一化断言不变）。
//
// 覆盖：
// - loadProvidersAndPrefs：双消息（ai-providers-list + get-settings）+ storage
//   读取并行、enabled 过滤、aiPrefs 归一化落 sidepanelState、空预设回落
//   DEFAULT_PRESET_PROMPTS 并触发持久化、渲染回调（modelSelect/思考档位/预设
//   列表）；
// - renderModelSelect：无平台 → disabled +「未配置平台」；有平台 → 按优先级
//   preferredProviderId > aiPrefs.defaultModel > chrome.storage 选中（闭包缓存）；
// - setThinkingLevel：归一化 + 渲染 + chrome.storage 写 + save-settings 单键；
// - 过渡期迁移：chrome.storage 缺键且 localStorage 有值 → 一次性写入；
//   chrome.storage 已有键时不覆盖（幂等）。
//
// 模板同 tests/chat/presets.test.js：vi.hoisted mock shared/messaging；
// resetModules 切纪元后同纪元 import chat-state 单例；storage fake 注入 deps。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const { sendRuntimeMessageMock } = vi.hoisted(() => ({
  sendRuntimeMessageMock: vi.fn()
}));

vi.mock("../../extension/shared/messaging.js", () => ({
  sendRuntimeMessage: sendRuntimeMessageMock
}));

const SELECTED_PROVIDER_KEY = "boc_ai_selected_provider";
const THINKING_LEVEL_KEY = "boc_ai_thinking_level";

let createProviderPrefs;
let sidepanelState;

async function importModule() {
  const module = await import("../../extension/chat/providers.js");
  const state = (await import("../../extension/chat/chat-state.js")).sidepanelState;
  createProviderPrefs = module.createProviderPrefs;
  sidepanelState = state;
}

// chrome.storage.local fake（conversation-store 测试同款手法：Map 底座 + 记录
// 调用的 get/set）
function makeStorageFake(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: vi.fn(async (keys) =>
      Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)]))
    ),
    set: vi.fn(async (items) => {
      for (const [k, v] of Object.entries(items)) {
        data.set(k, v);
      }
    })
  };
}

function makeHarness(storage = makeStorageFake()) {
  const modelSelect = document.createElement("select");
  document.body.appendChild(modelSelect);
  const thinkingBtns = ["off", "low", "high"].map((level) => {
    const btn = document.createElement("button");
    btn.dataset.level = level;
    document.body.appendChild(btn);
    return btn;
  });
  const deps = {
    modelSelect,
    thinkingBtns,
    widthEls: { modelSelect },
    renderPresetPrompts: vi.fn(),
    persistAiPresetPrompts: vi.fn(async () => {}),
    storage
  };
  const providerPrefs = createProviderPrefs(deps);
  return { modelSelect, thinkingBtns, deps, providerPrefs, storage };
}

beforeEach(async () => {
  resetModuleState();
  sendRuntimeMessageMock.mockReset();
  sendRuntimeMessageMock.mockImplementation(async () => ({ ok: true }));
  localStorage.clear();
  await importModule();
});

describe("loadProvidersAndPrefs", () => {
  it("双消息并行拉取 + storage 读取，enabled 过滤后写 sidepanelState，并触发三路渲染", async () => {
    sendRuntimeMessageMock.mockImplementation(async (message) => {
      if (message.type === "ai-providers-list") {
        return { providers: [
          { id: "p1", name: "平台一", enabled: true },
          { id: "p2", name: "平台二", enabled: false },
          { id: "p3", model: "模型三", enabled: true }
        ] };
      }
      return { ok: true, settings: {
        aiSystemPrompt: "  系统提示  ",
        aiInitialQuickPrompts: ["快速一"],
        aiPresetPrompts: ["预设一"],
        defaultModel: "p3",
        aiThinkingLevel: "low"
      } };
    });
    const { deps, providerPrefs, storage } = makeHarness();

    await providerPrefs.loadProvidersAndPrefs();

    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({ type: "ai-providers-list" });
    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({ type: "get-settings" });
    expect(storage.get).toHaveBeenCalledWith([SELECTED_PROVIDER_KEY, THINKING_LEVEL_KEY]);
    expect(sidepanelState.providers.map((p) => p.id)).toEqual(["p1", "p3"]);
    expect(sidepanelState.aiPrefs).toEqual({
      aiSystemPrompt: "系统提示",
      aiInitialQuickPrompts: ["快速一"],
      aiPresetPrompts: ["预设一"],
      defaultModel: "p3"
    });
    expect(sidepanelState.aiThinkingLevel).toBe("low");
    expect(deps.renderPresetPrompts).toHaveBeenCalledTimes(1);
    expect(deps.persistAiPresetPrompts).not.toHaveBeenCalled();
    // 默认选中 defaultModel 对应平台
    expect(deps.modelSelect.value).toBe("p3");
    expect(deps.modelSelect.disabled).toBe(false);
    // 思考档位高亮 low
    expect(deps.thinkingBtns.map((btn) => btn.classList.contains("is-active"))).toEqual([false, true, false]);
  });

  it("空预设回落 DEFAULT_PRESET_PROMPTS 并触发持久化", async () => {
    sendRuntimeMessageMock.mockImplementation(async (message) => {
      if (message.type === "ai-providers-list") {
        return { providers: [{ id: "p1", enabled: true }] };
      }
      return { ok: true, settings: {} };
    });
    const { deps, providerPrefs } = makeHarness();

    await providerPrefs.loadProvidersAndPrefs();

    expect(sidepanelState.aiPrefs.aiPresetPrompts.length).toBeGreaterThan(0);
    expect(deps.persistAiPresetPrompts).toHaveBeenCalledTimes(1);
  });

  it("get-settings 失败不阻断：aiPrefs 全走默认兜底", async () => {
    sendRuntimeMessageMock.mockImplementation(async (message) => {
      if (message.type === "ai-providers-list") {
        return { providers: [{ id: "p1", enabled: true }] };
      }
      throw new Error("settings 通道断开");
    });
    const { providerPrefs } = makeHarness();

    await expect(providerPrefs.loadProvidersAndPrefs()).resolves.toBeUndefined();

    expect(sidepanelState.aiPrefs.aiSystemPrompt).toBe("");
    expect(sidepanelState.aiThinkingLevel).toBe("off");
  });

  it("aiThinkingLevel 兜底读 chrome.storage（settings 缺省时）", async () => {
    const storage = makeStorageFake({ [THINKING_LEVEL_KEY]: "high" });
    sendRuntimeMessageMock.mockImplementation(async (message) => {
      if (message.type === "ai-providers-list") {
        return { providers: [{ id: "p1", enabled: true }] };
      }
      return { ok: true, settings: {} };
    });
    const { providerPrefs } = makeHarness(storage);

    await providerPrefs.loadProvidersAndPrefs();

    expect(sidepanelState.aiThinkingLevel).toBe("high");
  });
});

describe("renderModelSelect", () => {
  it("无平台：disabled + 「未配置平台」占位", () => {
    sidepanelState.providers = [];
    const { modelSelect, providerPrefs } = makeHarness();

    providerPrefs.renderModelSelect();

    expect(modelSelect.disabled).toBe(true);
    expect(modelSelect.innerHTML).toContain("未配置平台");
  });

  it("preferredProviderId 优先于 aiPrefs.defaultModel 与 chrome.storage 选中", () => {
    sidepanelState.providers = [
      { id: "p1", name: "平台一", enabled: true },
      { id: "p2", name: "平台二", enabled: true }
    ];
    sidepanelState.aiPrefs.defaultModel = "p2";
    const storage = makeStorageFake({ [SELECTED_PROVIDER_KEY]: "p2" });
    const { modelSelect, providerPrefs } = makeHarness(storage);

    providerPrefs.renderModelSelect("p1");

    expect(modelSelect.value).toBe("p1");
  });

  it("无 preferred：回落 defaultModel，再回落 chrome.storage 选中（经 load 预取的闭包缓存）", async () => {
    sendRuntimeMessageMock.mockImplementation(async (message) => {
      if (message.type === "ai-providers-list") {
        return { providers: [
          { id: "p1", name: "平台一", enabled: true },
          { id: "p2", name: "平台二", enabled: true }
        ] };
      }
      return { ok: true, settings: { defaultModel: "" } };
    });
    const storage = makeStorageFake({ [SELECTED_PROVIDER_KEY]: "p2" });
    const { modelSelect, providerPrefs } = makeHarness(storage);

    await providerPrefs.loadProvidersAndPrefs();

    expect(modelSelect.value).toBe("p2");
  });

  it("闭包缓存未预取（未经过 loadProvidersAndPrefs）时回退到首个平台", () => {
    sidepanelState.providers = [
      { id: "p1", name: "平台一", enabled: true },
      { id: "p2", name: "平台二", enabled: true }
    ];
    const { modelSelect, providerPrefs } = makeHarness();

    providerPrefs.renderModelSelect();

    expect(modelSelect.value).toBe("p1");
  });
});

describe("setThinkingLevel", () => {
  it("归一化 + 渲染 + chrome.storage 写 + save-settings 单键", async () => {
    const { thinkingBtns, providerPrefs, storage } = makeHarness();

    await providerPrefs.setThinkingLevel("high");

    expect(sidepanelState.aiThinkingLevel).toBe("high");
    expect(storage.set).toHaveBeenCalledWith({ [THINKING_LEVEL_KEY]: "high" });
    expect(storage.data.get(THINKING_LEVEL_KEY)).toBe("high");
    // 通道已换：不再写 localStorage
    expect(localStorage.getItem(THINKING_LEVEL_KEY)).toBeNull();
    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({
      type: "save-settings",
      settings: { aiThinkingLevel: "high" }
    });
    expect(thinkingBtns.map((btn) => btn.classList.contains("is-active"))).toEqual([false, false, true]);
    expect(thinkingBtns.map((btn) => btn.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
  });

  it("非法档位归一化为 off", async () => {
    const { providerPrefs } = makeHarness();

    await providerPrefs.setThinkingLevel("ultra");

    expect(sidepanelState.aiThinkingLevel).toBe("off");
  });
});

describe("setSelectedProvider / getStoredSelectedProviderId", () => {
  it("写入 chrome.storage.local 并同步更新闭包缓存", () => {
    const { providerPrefs, storage } = makeHarness();

    providerPrefs.setSelectedProvider("p9");

    expect(storage.set).toHaveBeenCalledWith({ [SELECTED_PROVIDER_KEY]: "p9" });
    expect(storage.data.get(SELECTED_PROVIDER_KEY)).toBe("p9");
    expect(providerPrefs.getStoredSelectedProviderId()).toBe("p9");
  });
});

describe("过渡期迁移（localStorage → chrome.storage.local）", () => {
  it("chrome.storage 缺键且 localStorage 有值 → 一次性写入 chrome.storage 并生效", async () => {
    localStorage.setItem(SELECTED_PROVIDER_KEY, "p9");
    localStorage.setItem(THINKING_LEVEL_KEY, "low");
    sendRuntimeMessageMock.mockImplementation(async (message) => {
      if (message.type === "ai-providers-list") {
        return { providers: [{ id: "p9", name: "平台九", enabled: true }] };
      }
      return { ok: true, settings: {} };
    });
    const { providerPrefs, storage } = makeHarness();

    await providerPrefs.loadProvidersAndPrefs();

    // 两键一次搬迁写库
    expect(storage.set).toHaveBeenCalledWith({
      [SELECTED_PROVIDER_KEY]: "p9",
      [THINKING_LEVEL_KEY]: "low"
    });
    expect(storage.data.get(SELECTED_PROVIDER_KEY)).toBe("p9");
    expect(storage.data.get(THINKING_LEVEL_KEY)).toBe("low");
    // 迁移后的值即刻生效：选中平台与思考档位按搬迁值渲染
    expect(providerPrefs.getStoredSelectedProviderId()).toBe("p9");
    expect(sidepanelState.aiThinkingLevel).toBe("low");
  });

  it("chrome.storage 已有键时不被 localStorage 覆盖（迁移幂等）", async () => {
    localStorage.setItem(SELECTED_PROVIDER_KEY, "p-legacy");
    localStorage.setItem(THINKING_LEVEL_KEY, "low");
    sendRuntimeMessageMock.mockImplementation(async (message) => {
      if (message.type === "ai-providers-list") {
        return { providers: [{ id: "p1", enabled: true }] };
      }
      return { ok: true, settings: { aiThinkingLevel: "high" } };
    });
    const { providerPrefs, storage } = makeHarness(makeStorageFake({ [SELECTED_PROVIDER_KEY]: "p1" }));

    await providerPrefs.loadProvidersAndPrefs();

    // 选中平台 storage 已有 → 不搬迁不覆盖
    const providerPatches = storage.set.mock.calls.filter((call) => SELECTED_PROVIDER_KEY in call[0]);
    expect(providerPatches).toHaveLength(0);
    expect(providerPrefs.getStoredSelectedProviderId()).toBe("p1");
  });
});
