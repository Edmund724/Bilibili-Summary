// tests/sidepanel/sidepanel-presets.test.js
// createPresetPrompts（预设提示词 CRUD + 双存储同步）行为契约。
//
// bug ⑦ 回归核心：persistAiPresetPrompts 原本 get-settings 读全量 →
// save-settings 写回全量，两条跨进程消息之间有读改写窗口，与其它写方
// （content reader 设置 / 选项页）交错时会用旧全量覆盖对方刚写入的键
// （丢的是其它设置键，如 readerTheme，不是 aiPresetPrompts 本身）。
// 修复后只发 save-settings 单键 { aiPresetPrompts }，不再发 get-settings：
// background 的 saveSettings 按 key 合并写（白名单过滤，不读全量），
// 并发写方互不覆盖。
//
// 覆盖：
// - addPresetPrompt：只发 save-settings 且 settings 只含 aiPresetPrompts
//   一个键（不发 get-settings——修复的核心证据）；
// - removePresetPrompt：同样只发单键 save-settings；
// - 12 条截断仍生效（add 第 13 条时 slice(0, 12)）；
// - 去重仍生效（重复文本不重复入列）；
// - save-settings 失败（reject）不抛错、内存镜像仍已更新（.catch 吞错）。
//
// 模块纪元注意：sidepanel-state 是模块级单例（含 DEFAULT_PRESET_PROMPTS
// 初始镜像），beforeEach 里 resetModules 后与被测模块同纪元导入，并手动
// 重置 aiPrefs.aiPresetPrompts。
//
// shared/messaging.js 整体 vi.mock，避免拖入 chrome.runtime.sendMessage
// 真实封装；每用例通过 sendRuntimeMessageMock 断言消息载荷（含"未发出"）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const { sendRuntimeMessageMock } = vi.hoisted(() => ({
  sendRuntimeMessageMock: vi.fn()
}));

vi.mock("../../extension/shared/messaging.js", () => ({
  sendRuntimeMessage: sendRuntimeMessageMock
}));

const DEFAULTS = ["生成视频摘要和结论", "按章节整理视频内容", "生成带时间轴的笔记"];

let createPresetPrompts;
let sidepanelState;

// 组装工厂 + 重置模块级单例（与 provider-row.test.js 同构：resetModules
// 后同纪元导入被测模块与其状态模块）
async function makePresets() {
  const module = await import("../../extension/chat/presets.js");
  const state = (await import("../../extension/chat/chat-state.js")).sidepanelState;
  state.aiPrefs.aiPresetPrompts = [];
  createPresetPrompts = module.createPresetPrompts;
  sidepanelState = state;
  return createPresetPrompts({
    presetInput: { value: "" },
    renderPresetPrompts: vi.fn()
  });
}

function presetInputWith(value) {
  return { value };
}

beforeEach(async () => {
  resetModuleState();
  sendRuntimeMessageMock.mockReset();
  sendRuntimeMessageMock.mockImplementation(async () => ({ ok: true }));
  await makePresets();
});

describe("preset prompts 持久化（bug ⑦ 回归：单键写，不读改写）", () => {
  it("addPresetPrompt 只发 save-settings 且 settings 只含 aiPresetPrompts 一个键（不再发 get-settings）", async () => {
    const presets = createPresetPrompts({
      presetInput: presetInputWith("  自定义提示词  "),
      renderPresetPrompts: vi.fn()
    });

    await presets.addPresetPrompt();

    expect(sendRuntimeMessageMock).toHaveBeenCalledTimes(1);
    expect(sendRuntimeMessageMock.mock.calls[0][0]).toEqual({
      type: "save-settings",
      settings: { aiPresetPrompts: ["自定义提示词"] }
    });
    expect(sendRuntimeMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "get-settings" })
    );
  });

  it("removePresetPrompt 只发单键 save-settings（不发 get-settings）", async () => {
    sidepanelState.aiPrefs.aiPresetPrompts = [...DEFAULTS];
    const presets = createPresetPrompts({
      presetInput: presetInputWith(""),
      renderPresetPrompts: vi.fn()
    });

    await presets.removePresetPrompt(1);

    expect(sendRuntimeMessageMock).toHaveBeenCalledTimes(1);
    expect(sendRuntimeMessageMock.mock.calls[0][0]).toEqual({
      type: "save-settings",
      settings: { aiPresetPrompts: ["生成视频摘要和结论", "生成带时间轴的笔记"] }
    });
    expect(sendRuntimeMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "get-settings" })
    );
  });

  it("12 条截断仍生效：add 第 13 条时持久化与内存镜像都 slice(0, 12)", async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `预设${i + 1}`);
    sidepanelState.aiPrefs.aiPresetPrompts = twelve;
    const presets = createPresetPrompts({
      presetInput: presetInputWith("第十三条"),
      renderPresetPrompts: vi.fn()
    });

    await presets.addPresetPrompt();

    expect(sidepanelState.aiPrefs.aiPresetPrompts).toHaveLength(12);
    expect(sendRuntimeMessageMock.mock.calls[0][0]).toEqual({
      type: "save-settings",
      settings: { aiPresetPrompts: twelve }
    });
  });

  it("去重仍生效：重复文本不重复入列，持久化只发一次全量", async () => {
    sidepanelState.aiPrefs.aiPresetPrompts = [...DEFAULTS];
    const presets = createPresetPrompts({
      presetInput: presetInputWith("按章节整理视频内容"),
      renderPresetPrompts: vi.fn()
    });

    await presets.addPresetPrompt();

    expect(sidepanelState.aiPrefs.aiPresetPrompts).toEqual(DEFAULTS);
    expect(sendRuntimeMessageMock).toHaveBeenCalledTimes(1);
    expect(sendRuntimeMessageMock.mock.calls[0][0]).toEqual({
      type: "save-settings",
      settings: { aiPresetPrompts: DEFAULTS }
    });
  });

  it("save-settings 失败（reject）不抛错，内存镜像仍已更新", async () => {
    sendRuntimeMessageMock.mockImplementation(async () => {
      throw new Error("runtime 消息通道断开");
    });
    const presets = createPresetPrompts({
      presetInput: presetInputWith("自定义提示词"),
      renderPresetPrompts: vi.fn()
    });

    await expect(presets.addPresetPrompt()).resolves.toBeUndefined();

    expect(sidepanelState.aiPrefs.aiPresetPrompts).toEqual(["自定义提示词"]);
    expect(sendRuntimeMessageMock).toHaveBeenCalledTimes(1);
    expect(sendRuntimeMessageMock.mock.calls[0][0]).toEqual({
      type: "save-settings",
      settings: { aiPresetPrompts: ["自定义提示词"] }
    });
  });

  it("空白输入不触发任何持久化", async () => {
    const presets = createPresetPrompts({
      presetInput: presetInputWith("   "),
      renderPresetPrompts: vi.fn()
    });

    await presets.addPresetPrompt();

    expect(sendRuntimeMessageMock).not.toHaveBeenCalled();
  });
});
