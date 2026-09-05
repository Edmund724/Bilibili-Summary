// tests/ui/provider-row.test.js
// createProviderRow 工厂与两个真实配置（options-rows.js 的 AI 平台行 /
// options-asr-rows.js 的 ASR 平台行）的行为契约（provider-master-detail/02
// 紧凑形态）。行是纯展示 + 入口，本文件守住：
// - 行结构渲染：主行（Key 状态点两态 / 名称回落 /（ASR）选用 radio / 编辑 /
//   删除）+ 模型名副行（空则不渲染），行内零输入字段（编辑职责在
//   ui/provider-editor.js 的 Modal，其契约见 provider-editor.test.js）；
// - 行 dataset 四键（providerId / hasSavedKey / currentPresetId / baseUrl——
//   删除回收 host 权限的钩子要从行上拿 baseUrl）；
// - 删除接线：确认 → onBeforeDelete（权限回收钩子，带行 dataset 的 baseUrl）→
//   后台删除消息 → onDelete（ASR 清选用态）；取消确认则不动；
// - ASR 选用 radio：change 即时持久化 activeAsrProviderId 并同步选中态；
// - 「编辑」按钮回调转发 providerId。
// shared/messaging.js（sendRuntimeMessage）被整体 mock，避免拖入 content
// script 依赖图。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { TRASH_ICON_PATHS } from "../../extension/ui/provider-row.js";

const { sendRuntimeMessageMock } = vi.hoisted(() => ({
  sendRuntimeMessageMock: vi.fn()
}));

vi.mock("../../extension/shared/messaging.js", () => ({
  sendRuntimeMessage: sendRuntimeMessageMock
}));

const AI_PRESETS = [
  { id: "openai_compat", name: "OpenAI 兼容", baseUrl: "https://api.openai.com/v1", requiresKey: true },
  { id: "ollama", name: "Ollama (本地)", baseUrl: "http://localhost:11434/v1", requiresKey: false },
  { id: "custom", name: "自定义", baseUrl: "", requiresKey: true }
];

const ASR_PRESETS = [
  {
    id: "siliconflow",
    name: "SiliconFlow 硅基流动（免费）",
    type: "openai-transcriptions",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "XingChenAGI/XingChenASR-V3.2-Ultra"
  },
  {
    id: "local-whisper",
    name: "本地 Whisper 服务",
    type: "openai-transcriptions",
    baseUrl: "http://localhost:8000/v1",
    model: "whisper-large-v3"
  },
  { id: "custom", name: "自定义", type: "openai-transcriptions", baseUrl: "", model: "" }
];

// 共享垃圾桶 path：固定属性行 / 笔记段落行 / 平台行共用同一份定义
const TRASH_PATHS = [
  "M4 7h16",
  "M9 3h6",
  "M10 11v6",
  "M14 11v6",
  "M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"
];

function makeContainer() {
  const listNode = document.createElement("div");
  const emptyNode = document.createElement("p");
  document.body.append(listNode, emptyNode);
  return { listNode, emptyNode };
}

// setup.js 给 HTMLElement.prototype.click 打的补丁会派发两次事件（原生 click + 手动
// dispatch），这里改为单次显式派发，模拟真实用户的一次点击。
function fireClick(el) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function readTrashPaths(row) {
  return Array.from(row.querySelectorAll(".provider-row-remove svg path")).map((p) => p.getAttribute("d"));
}

// 纯微任务冲刷：等待行事件处理器里 await sendRuntimeMessage / 回调链走完
async function flushMicrotasks() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

let confirmMock;

beforeEach(() => {
  vi.resetModules();
  resetModuleState();
  document.body.innerHTML = "";
  sendRuntimeMessageMock.mockReset();
  sendRuntimeMessageMock.mockImplementation(async () => ({ ok: true }));
  confirmMock = vi.fn(() => true);
  vi.stubGlobal("confirm", confirmMock);
});

async function loadAiRows() {
  return import("../../extension/ui/options-rows.js");
}

async function loadAsrRows() {
  return import("../../extension/ui/options-asr-rows.js");
}

describe("createProviderRow：AI 平台行（options-rows.js 配置，紧凑形态）", () => {
  const aiItem = { id: "p1", presetId: "openai_compat", name: "我的端点", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" };

  it("渲染紧凑行结构与空态：主行 + 模型名副行，行内零输入字段", async () => {
    const rows = await loadAiRows();
    const { listNode, emptyNode } = makeContainer();
    rows.renderAiProviders(listNode, emptyNode, [
      aiItem,
      { id: "p2", presetId: "ollama", baseUrl: "http://localhost:11434/v1", model: "llama3", hasSavedKey: true }
    ], { presets: AI_PRESETS });

    const allRows = listNode.querySelectorAll(".ai-provider-row");
    expect(allRows).toHaveLength(2);
    expect(emptyNode.hidden).toBe(true);

    const row = allRows[0];
    // dataset 四键：baseUrl 供删除回收 host 权限的钩子读取
    expect(row.dataset.providerId).toBe("p1");
    expect(row.dataset.hasSavedKey).toBe("0");
    expect(row.dataset.currentPresetId).toBe("openai_compat");
    expect(row.dataset.baseUrl).toBe("https://api.openai.com/v1");

    // 主行：状态点（未存 Key=missing）+ 名称（自定义名优先）+ 编辑/删除
    const line = row.querySelector(".provider-row-line");
    expect(line).not.toBeNull();
    expect(line.querySelector(".provider-row-dot").dataset.state).toBe("missing");
    expect(line.querySelector(".provider-row-name").textContent).toBe("我的端点");
    expect(line.querySelector("button.provider-row-edit").textContent).toBe("编辑");
    expect(line.querySelector("button.provider-row-remove")).not.toBeNull();

    // 副行：模型名
    expect(row.querySelector(".provider-row-model").textContent).toBe("gpt-4o-mini");

    // 紧凑行内零输入字段（编辑职责在 provider-editor Modal）
    expect(row.querySelectorAll("input")).toHaveLength(0);
    expect(row.querySelectorAll("select")).toHaveLength(0);
    // AI 行没有选用 radio
    expect(row.querySelector(".asr-provider-active-radio")).toBeNull();
    // 垃圾桶 path 与固定属性行共用同一份定义
    expect(TRASH_ICON_PATHS).toContain('d="M4 7h16"');
    expect(readTrashPaths(row)).toEqual(TRASH_PATHS);

    // 第二行：hasSavedKey=1 → 绿点
    expect(allRows[1].querySelector(".provider-row-dot").dataset.state).toBe("saved");
  });

  it("名称回落：无自定义名回落预设名；模型名空则不渲染副行", async () => {
    const rows = await loadAiRows();
    const { listNode, emptyNode } = makeContainer();
    rows.renderAiProviders(listNode, emptyNode, [
      { id: "p1", presetId: "openai_compat", baseUrl: "https://api.openai.com/v1" },
      { id: "p2", presetId: "ollama", baseUrl: "http://localhost:11434/v1", model: "" }
    ], { presets: AI_PRESETS });

    const allRows = listNode.querySelectorAll(".ai-provider-row");
    // 名称 = 预设名（历史数据 name=预设名，拍板 Q7 的回落语义）
    expect(allRows[0].querySelector(".provider-row-name").textContent).toBe("OpenAI 兼容");
    expect(allRows[0].querySelector(".provider-row-model")).toBeNull();

    // 显式空模型同样不渲染副行
    expect(allRows[1].querySelector(".provider-row-model")).toBeNull();
  });

  it("渲染空列表时显示空态", async () => {
    const rows = await loadAiRows();
    const { listNode, emptyNode } = makeContainer();
    rows.renderAiProviders(listNode, emptyNode, [], { presets: AI_PRESETS });
    expect(listNode.children).toHaveLength(0);
    expect(emptyNode.hidden).toBe(false);
  });

  it("「编辑」按钮：回调转发行 providerId", async () => {
    const rows = await loadAiRows();
    const { listNode } = makeContainer();
    const onEdit = vi.fn();
    rows.setAiRowEditHandler(onEdit);
    rows.renderAiProviders(listNode, document.createElement("p"), [aiItem], { presets: AI_PRESETS });

    const row = listNode.querySelector(".ai-provider-row");
    fireClick(row.querySelector(".provider-row-edit"));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith("p1");
  });

  it("删除：确认后先同步触发 onBeforeDelete（带行 dataset 的 baseUrl）再走后台删除；取消确认不触发", async () => {
    const rows = await loadAiRows();
    const { listNode, emptyNode } = makeContainer();
    const onBeforeDelete = vi.fn(async () => {});
    rows.setAiBeforeDeleteHandler(onBeforeDelete);
    rows.renderAiProviders(listNode, emptyNode, [aiItem], { presets: AI_PRESETS });
    const row = listNode.querySelector(".ai-provider-row");

    confirmMock.mockReturnValueOnce(false);
    fireClick(row.querySelector(".provider-row-remove"));
    expect(onBeforeDelete).not.toHaveBeenCalled();
    expect(sendRuntimeMessageMock).not.toHaveBeenCalled();

    fireClick(row.querySelector(".provider-row-remove"));
    await flushMicrotasks();
    expect(onBeforeDelete).toHaveBeenCalledTimes(1);
    expect(onBeforeDelete).toHaveBeenCalledWith("p1", "https://api.openai.com/v1");
    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({ type: "ai-providers-delete", providerId: "p1" });
    expect(listNode.querySelectorAll(".ai-provider-row")).toHaveLength(0);
    expect(emptyNode.hidden).toBe(false);
  });

  it("删除：onBeforeDelete 抛错不阻断删除（权限回收失败可忽略）", async () => {
    const rows = await loadAiRows();
    const { listNode, emptyNode } = makeContainer();
    rows.setAiBeforeDeleteHandler(vi.fn(async () => {
      throw new Error("permissions API unavailable");
    }));
    rows.renderAiProviders(listNode, emptyNode, [aiItem], { presets: AI_PRESETS });
    const row = listNode.querySelector(".ai-provider-row");

    fireClick(row.querySelector(".provider-row-remove"));
    await flushMicrotasks();
    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({ type: "ai-providers-delete", providerId: "p1" });
    expect(listNode.querySelectorAll(".ai-provider-row")).toHaveLength(0);
    expect(emptyNode.hidden).toBe(false);
  });
});

describe("createProviderRow：ASR 平台行（options-asr-rows.js 配置，紧凑形态）", () => {
  const asrItem = {
    id: "asr1",
    presetId: "siliconflow",
    name: "我的 ASR",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "XingChenAGI/XingChenASR-V3.2-Ultra"
  };

  it("渲染紧凑行：名称 + 模型名副行（缺省回落预设 model）+ 选用 radio", async () => {
    const rows = await loadAsrRows();
    const { listNode, emptyNode } = makeContainer();
    rows.renderAsrProviders(listNode, emptyNode, [asrItem, { id: "asr2", presetId: "local-whisper", hasSavedKey: true }], { presets: ASR_PRESETS, activeId: "asr2" });

    const allRows = listNode.querySelectorAll(".asr-provider-row");
    expect(allRows).toHaveLength(2);
    expect(emptyNode.hidden).toBe(true);

    const row = allRows[0];
    expect(row.dataset.currentPresetId).toBe("siliconflow");
    expect(row.dataset.baseUrl).toBe("https://api.siliconflow.cn/v1");
    // 名称取列表项实值；模型名取已保存 model
    expect(row.querySelector(".provider-row-name").textContent).toBe("我的 ASR");
    expect(row.querySelector(".provider-row-model").textContent).toBe("XingChenAGI/XingChenASR-V3.2-Ultra");
    // whisper 预设行：无 name 字段回落预设名，模型名回落预设 model
    expect(allRows[1].querySelector(".provider-row-name").textContent).toBe("本地 Whisper 服务");
    expect(allRows[1].querySelector(".provider-row-model").textContent).toBe("whisper-large-v3");
    // 选用 radio：activeId 命中 asr2；状态点 asr2 已存 Key
    const radios = listNode.querySelectorAll(".asr-provider-active-radio");
    expect(radios[0].checked).toBe(false);
    expect(radios[1].checked).toBe(true);
    expect(radios[0].closest("label").title).toBe("选用该平台自动生成字幕");
    expect(allRows[0].querySelector(".provider-row-dot").dataset.state).toBe("missing");
    expect(allRows[1].querySelector(".provider-row-dot").dataset.state).toBe("saved");
    // 删除按钮统一 provider-row-remove（历史耦合 ai-provider-remove 已收口）
    expect(row.querySelector("button.provider-row-remove")).not.toBeNull();
    expect(row.querySelector(".ai-provider-remove")).toBeNull();
    expect(readTrashPaths(row)).toEqual(TRASH_PATHS);
  });

  it("选用 radio：change 时持久化 activeAsrProviderId 并同步选中态", async () => {
    const rows = await loadAsrRows();
    const { listNode, emptyNode } = makeContainer();
    rows.renderAsrProviders(listNode, emptyNode, [asrItem, { id: "asr2", presetId: "local-whisper" }], { presets: ASR_PRESETS });

    const radios = listNode.querySelectorAll(".asr-provider-active-radio");
    radios[1].checked = true;
    radios[1].dispatchEvent(new Event("change"));
    await flushMicrotasks();

    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({ type: "save-settings", settings: { activeAsrProviderId: "asr2" } });
    expect(radios[0].checked).toBe(false);
    expect(radios[1].checked).toBe(true);
    expect(rows.getActiveAsrProviderId(listNode)).toBe("asr2");

    rows.setActiveAsrProvider(listNode, "");
    expect(rows.getActiveAsrProviderId(listNode)).toBe("");
  });

  it("删除：后台消息后触发注入的 onDelete（删选用平台时清 activeAsrProviderId 的钩子），并恢复空态", async () => {
    const rows = await loadAsrRows();
    const { listNode, emptyNode } = makeContainer();
    const onDelete = vi.fn(async () => {});
    rows.setAsrDeleteHandler(onDelete);
    const onBeforeDelete = vi.fn(async () => {});
    rows.setAsrBeforeDeleteHandler(onBeforeDelete);
    rows.renderAsrProviders(listNode, emptyNode, [asrItem], { presets: ASR_PRESETS });
    const row = listNode.querySelector(".asr-provider-row");

    fireClick(row.querySelector(".provider-row-remove"));
    await flushMicrotasks();
    expect(onBeforeDelete).toHaveBeenCalledWith("asr1", "https://api.siliconflow.cn/v1");
    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({ type: "asr-providers-delete", providerId: "asr1" });
    expect(onDelete).toHaveBeenCalledWith("asr1");
    expect(listNode.querySelectorAll(".asr-provider-row")).toHaveLength(0);
    expect(emptyNode.hidden).toBe(false);
  });

  it("「编辑」按钮：回调转发行 providerId", async () => {
    const rows = await loadAsrRows();
    const { listNode } = makeContainer();
    const onEdit = vi.fn();
    rows.setAsrRowEditHandler(onEdit);
    rows.renderAsrProviders(listNode, document.createElement("p"), [asrItem], { presets: ASR_PRESETS });

    fireClick(listNode.querySelector(".asr-provider-row .provider-row-edit"));
    expect(onEdit).toHaveBeenCalledWith("asr1");
  });
});
