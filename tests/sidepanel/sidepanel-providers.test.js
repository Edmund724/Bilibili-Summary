// tests/sidepanel/sidepanel-providers.test.js
// createProviderPrefs（AI 平台加载渲染 + 思考档位）行为契约（候选5 拆分直测）。
//
// 覆盖：
// - loadProvidersAndPrefs：双消息（ai-providers-list + get-settings）并行拉取、
//   enabled 过滤、aiPrefs 归一化落 sidepanelState、空预设回落 DEFAULT_PRESET_
//   PROMPTS 并触发持久化、渲染回调（modelSelect/思考档位/预设列表）；
// - renderModelSelect：无平台 → disabled +「未配置平台」；有平台 → 按优先级
//   preferredProviderId > aiPrefs.defaultModel > localStorage 选中；
// - setThinkingLevel：归一化 + 渲染 + localStorage 双写 + save-settings 单键。
//
// 模板同 tests/sidepanel/sidepanel-presets.test.js：vi.hoisted mock
// shared/messaging；resetModules 切纪元后同纪元 import sidepanelState。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const { sendRuntimeMessageMock } = vi.hoisted(() => ({
  sendRuntimeMessageMock: vi.fn()
}));

vi.mock("../../extension/shared/messaging.js", () => ({
  sendRuntimeMessage: sendRuntimeMessageMock
}));

let createProviderPrefs;
let sidepanelState;

async function importModule() {
  const module = await import("../../extension/pages/sidepanel-providers.js");
  const state = (await import("../../extension/pages/sidepanel-state.js")).sidepanelState;
  createProviderPrefs = module.createProviderPrefs;
  sidepanelState = state;
}

function makeHarness() {
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
    persistAiPresetPrompts: vi.fn(async () => {})
  };
  const providerPrefs = createProviderPrefs(deps);
  return { modelSelect, thinkingBtns, deps, providerPrefs };
}

beforeEach(async () => {
  resetModuleState();
  sendRuntimeMessageMock.mockReset();
  sendRuntimeMessageMock.mockImplementation(async () => ({ ok: true }));
  localStorage.clear();
  await importModule();
});

describe("loadProvidersAndPrefs", () => {
  it("双消息并行拉取，enabled 过滤后写 sidepanelState，并触发三路渲染", async () => {
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
    const { deps, providerPrefs } = makeHarness();

    await providerPrefs.loadProvidersAndPrefs();

    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({ type: "ai-providers-list" });
    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({ type: "get-settings" });
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

  it("aiThinkingLevel 兜底读 localStorage（settings 缺省时）", async () => {
    localStorage.setItem("boc_ai_thinking_level", "high");
    sendRuntimeMessageMock.mockImplementation(async (message) => {
      if (message.type === "ai-providers-list") {
        return { providers: [{ id: "p1", enabled: true }] };
      }
      return { ok: true, settings: {} };
    });
    const { providerPrefs } = makeHarness();

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

  it("preferredProviderId 优先于 aiPrefs.defaultModel 与 localStorage", () => {
    sidepanelState.providers = [
      { id: "p1", name: "平台一", enabled: true },
      { id: "p2", name: "平台二", enabled: true }
    ];
    sidepanelState.aiPrefs.defaultModel = "p2";
    localStorage.setItem("boc_ai_selected_provider", "p2");
    const { modelSelect, providerPrefs } = makeHarness();

    providerPrefs.renderModelSelect("p1");

    expect(modelSelect.value).toBe("p1");
  });

  it("无 preferred：回落 defaultModel，再回落 localStorage", () => {
    sidepanelState.providers = [
      { id: "p1", name: "平台一", enabled: true },
      { id: "p2", name: "平台二", enabled: true }
    ];
    sidepanelState.aiPrefs.defaultModel = "";
    localStorage.setItem("boc_ai_selected_provider", "p2");
    const { modelSelect, providerPrefs } = makeHarness();

    providerPrefs.renderModelSelect();

    expect(modelSelect.value).toBe("p2");
  });
});

describe("setThinkingLevel", () => {
  it("归一化 + 渲染 + localStorage 双写 + save-settings 单键", async () => {
    const { thinkingBtns, providerPrefs } = makeHarness();

    await providerPrefs.setThinkingLevel("high");

    expect(sidepanelState.aiThinkingLevel).toBe("high");
    expect(localStorage.getItem("boc_ai_thinking_level")).toBe("high");
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
