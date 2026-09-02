// tests/ui/provider-row.test.js
// createProviderRow 工厂与两个真实配置（options-rows.js 的 AI 平台行 /
// options-asr-rows.js 的 ASR 平台行）的行为契约。设置页没有自动化测试，
// 本文件守住行构建器重构后的关键不变量：
// - 行结构渲染（含 ASR 复用 AI 类名 ai-provider-remove / ai-provider-status 的既有耦合）；
// - 预设切换的 baseUrl 跟随规则（未改过 baseUrl 才跟随）；
// - 测试连接：AI / ASR 行均直调对应探针模块（候选 04 拆链后均不走消息）、
//   ASR 行 provider 对象仅重输 Key 时携带 apiKey，成功状态的禁用输入 + 定时恢复；
// - 删除接线（AI 仅后台消息 / ASR 额外触发注入的 onDelete）。
// shared/messaging.js（sendRuntimeMessage，原 core/runtime.js）被整体 mock，
// 避免拖入 content script 依赖图；AI 探针模块同理 mock，隔离 fetch。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { TRASH_ICON_PATHS } from "../../extension/ui/provider-row.js";

const { sendRuntimeMessageMock, testAiProviderConnectionMock, testAsrConnectionMock } = vi.hoisted(() => ({
  sendRuntimeMessageMock: vi.fn(),
  testAiProviderConnectionMock: vi.fn(),
  testAsrConnectionMock: vi.fn()
}));

vi.mock("../../extension/shared/messaging.js", () => ({
  sendRuntimeMessage: sendRuntimeMessageMock
}));

vi.mock("../../extension/ai/provider-test.js", () => ({
  testAiProviderConnection: testAiProviderConnectionMock
}));

vi.mock("../../extension/asr/provider-test.js", () => ({
  testAsrConnection: testAsrConnectionMock
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
    model: "FunAudioLLM/SenseVoiceSmall",
    modelOptions: [{ value: "FunAudioLLM/SenseVoiceSmall", label: "SenseVoice" }]
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

// 共享垃圾桶 path：4 处行删除按钮（固定属性 / 笔记段落 / AI / ASR）共用同一份定义
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
  return Array.from(row.querySelectorAll(".ai-provider-remove svg path")).map((p) => p.getAttribute("d"));
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
  testAiProviderConnectionMock.mockReset();
  testAiProviderConnectionMock.mockImplementation(async () => ({ ok: true }));
  testAsrConnectionMock.mockReset();
  testAsrConnectionMock.mockImplementation(async () => ({ ok: true }));
  confirmMock = vi.fn(() => true);
  vi.stubGlobal("confirm", confirmMock);
});

async function loadAiRows() {
  return import("../../extension/ui/options-rows.js");
}

async function loadAsrRows() {
  return import("../../extension/ui/options-asr-rows.js");
}

describe("createProviderRow：AI 平台行（options-rows.js 配置）", () => {
  const aiItem = { id: "p1", presetId: "openai_compat", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" };

  it("渲染行结构与空态，删除按钮共用同一份垃圾桶 path 定义", async () => {
    const rows = await loadAiRows();
    const { listNode, emptyNode } = makeContainer();
    rows.renderAiProviders(listNode, emptyNode, [
      aiItem,
      { id: "p2", presetId: "ollama", baseUrl: "http://localhost:11434/v1", model: "llama3" }
    ], { presets: AI_PRESETS });

    const allRows = listNode.querySelectorAll(".ai-provider-row");
    expect(allRows).toHaveLength(2);
    expect(emptyNode.hidden).toBe(true);

    const row = allRows[0];
    expect(row.dataset.providerId).toBe("p1");
    expect(row.dataset.hasSavedKey).toBe("0");
    expect(row.dataset.currentPresetId).toBe("openai_compat");

    const presetSelect = row.querySelector("select.ai-provider-preset");
    expect(presetSelect.title).toBe("平台");
    expect(presetSelect.options).toHaveLength(3);
    expect(row.querySelector(".ai-provider-baseurl").value).toBe("https://api.openai.com/v1");
    // requiresKey: true → 占位符无"（可选）"
    expect(row.querySelector(".ai-provider-apikey").placeholder).toBe("API Key");
    expect(row.querySelector(".ai-provider-apikey").type).toBe("password");
    expect(row.querySelector(".ai-provider-model").value).toBe("gpt-4o-mini");
    expect(row.querySelector(".ai-provider-model-dropdown").hidden).toBe(true);
    expect(row.querySelector("button.secondary-btn.ai-provider-test").textContent).toBe("测试");
    expect(row.querySelector(".ai-provider-status").hidden).toBe(true);
    // 操作行：测试 / 状态 / 删除包在同一 .provider-row-actions 容器内且按此顺序
    //（同排一行呈现，删除按钮贴行尾由 CSS margin-left:auto 保证）
    const actionsRow = row.querySelector(".provider-row-actions");
    expect(actionsRow).not.toBeNull();
    expect(Array.from(actionsRow.children).map((el) => el.className)).toEqual([
      "secondary-btn ai-provider-test",
      "ai-provider-status",
      "ai-provider-remove"
    ]);
    // AI 行没有名称输入与选用 radio
    expect(row.querySelector(".ai-provider-name")).toBeNull();
    expect(row.querySelector(".asr-provider-active-radio")).toBeNull();

    expect(TRASH_ICON_PATHS).toContain('d="M4 7h16"');
    expect(readTrashPaths(row)).toEqual(TRASH_PATHS);
    // requiresKey: false 的预设 → 占位符带"（可选）"
    expect(allRows[1].querySelector(".ai-provider-apikey").placeholder).toBe("API Key（可选）");
  });

  it("渲染空列表时显示空态", async () => {
    const rows = await loadAiRows();
    const { listNode, emptyNode } = makeContainer();
    rows.renderAiProviders(listNode, emptyNode, [], { presets: AI_PRESETS });
    expect(listNode.children).toHaveLength(0);
    expect(emptyNode.hidden).toBe(false);
  });

  it("预设切换：未改过 baseUrl 才跟随新预设，Key 占位符随 requiresKey 更新", async () => {
    const rows = await loadAiRows();
    const { listNode, emptyNode } = makeContainer();
    rows.renderAiProviders(listNode, emptyNode, [aiItem], { presets: AI_PRESETS });

    const row = listNode.querySelector(".ai-provider-row");
    const select = row.querySelector(".ai-provider-preset");
    const baseUrlInput = row.querySelector(".ai-provider-baseurl");

    // 未改过 baseUrl（仍是上一预设默认值）→ 跟随新预设；占位符变"（可选）"
    select.value = "ollama";
    select.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("http://localhost:11434/v1");
    expect(row.querySelector(".ai-provider-apikey").placeholder).toBe("API Key（可选）");
    expect(row.dataset.currentPresetId).toBe("ollama");

    // 用户改过 baseUrl → 保持不动
    baseUrlInput.value = "https://my-proxy.example.com/v1";
    select.value = "openai_compat";
    select.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("https://my-proxy.example.com/v1");
    expect(row.querySelector(".ai-provider-apikey").placeholder).toBe("API Key");

    // baseUrl 为空 → 跟随
    baseUrlInput.value = "";
    select.value = "ollama";
    select.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("http://localhost:11434/v1");
  });

  it("预设切换：代申请新 baseUrl 的 host 权限（request-provider-origins），失败静默", async () => {
    const rows = await loadAiRows();
    const { listNode, emptyNode } = makeContainer();
    rows.renderAiProviders(listNode, emptyNode, [aiItem], { presets: AI_PRESETS });
    const row = listNode.querySelector(".ai-provider-row");
    const select = row.querySelector(".ai-provider-preset");

    // 切到 ollama → baseUrl 跟随后代申请该 origin 的 host 权限
    select.value = "ollama";
    select.dispatchEvent(new Event("change"));
    await flushMicrotasks();
    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({
      type: "request-provider-origins",
      baseUrls: ["http://localhost:11434/v1"]
    });

    // 自定义（baseUrl 为空）不申请
    sendRuntimeMessageMock.mockClear();
    select.value = "custom";
    select.dispatchEvent(new Event("change"));
    await flushMicrotasks();
    expect(sendRuntimeMessageMock).not.toHaveBeenCalled();

    // 代申请失败（用户拒绝/无手势）不影响预设切换本身
    sendRuntimeMessageMock.mockImplementation(async () => ({ ok: false, error: "未授权" }));
    row.querySelector(".ai-provider-baseurl").value = "https://api.openai.com/v1";
    select.value = "openai_compat";
    select.dispatchEvent(new Event("change"));
    await flushMicrotasks();
    expect(row.dataset.currentPresetId).toBe("openai_compat");
  });

  it("测试连接：直调探针（平铺入参带 providerId）+ 成功回调重渲染后，新行禁用输入并在 2 秒后恢复", async () => {
    vi.useFakeTimers();
    const rows = await loadAiRows();
    const { listNode, emptyNode } = makeContainer();
    // 与 options.js 注入的行为一致：测试成功后重新保存设置并重渲染列表
    const onTestSuccess = vi.fn(async () => {
      rows.renderAiProviders(listNode, emptyNode, [aiItem], { presets: AI_PRESETS });
    });
    rows.setTestSuccessHandler(onTestSuccess);
    rows.renderAiProviders(listNode, emptyNode, [aiItem], { presets: AI_PRESETS });

    const row = listNode.querySelector(".ai-provider-row");
    row.querySelector(".ai-provider-apikey").value = "sk-test";
    fireClick(row.querySelector(".ai-provider-test"));
    await flushMicrotasks();

    // 候选 04 拆链：探针直调（options 页本地执行），不再发 ai-providers-test 消息
    expect(testAiProviderConnectionMock).toHaveBeenCalledTimes(1);
    expect(testAiProviderConnectionMock.mock.calls[0][0]).toEqual({
      providerId: "p1",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o-mini"
    });
    expect(sendRuntimeMessageMock).not.toHaveBeenCalled();
    expect(onTestSuccess).toHaveBeenCalledWith("p1");

    // 保存回调重渲染后，按 providerId 重查到的新行显示"连接成功"并禁用输入
    const newRow = listNode.querySelector(".ai-provider-row");
    expect(newRow.dataset.providerId).toBe("p1");
    const status = newRow.querySelector(".ai-provider-status");
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("连接成功");
    expect(status.dataset.error).toBe("false");
    const disabledDuring = Array.from(newRow.querySelectorAll("input, button"));
    expect(disabledDuring.length).toBeGreaterThan(0);
    expect(disabledDuring.every((el) => el.disabled)).toBe(true);

    // statusSuccessMinMs(2000) 后恢复
    await vi.advanceTimersByTimeAsync(2000);
    expect(Array.from(newRow.querySelectorAll("input, button")).every((el) => !el.disabled)).toBe(true);
  });

  it("测试连接：缺 baseUrl / 缺模型名直接提示且不调探针；探针失败显示错误，禁用持续到恢复定时器", async () => {
    vi.useFakeTimers();
    const rows = await loadAiRows();
    const { listNode, emptyNode } = makeContainer();
    rows.renderAiProviders(listNode, emptyNode, [aiItem], { presets: AI_PRESETS });
    const row = listNode.querySelector(".ai-provider-row");
    const status = row.querySelector(".ai-provider-status");

    row.querySelector(".ai-provider-baseurl").value = "";
    fireClick(row.querySelector(".ai-provider-test"));
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("请填写 baseUrl");
    expect(status.dataset.error).toBe("true");
    expect(testAiProviderConnectionMock).not.toHaveBeenCalled();
    expect(sendRuntimeMessageMock).not.toHaveBeenCalled();

    row.querySelector(".ai-provider-baseurl").value = "https://api.openai.com/v1";
    row.querySelector(".ai-provider-model").value = "";
    fireClick(row.querySelector(".ai-provider-test"));
    expect(status.textContent).toBe("请填写模型名");
    expect(testAiProviderConnectionMock).not.toHaveBeenCalled();

    // "正在测试..."（非 error）会禁用行内输入防止重复提交；探针失败后
    // 状态行显示错误但不禁用/恢复，输入保持禁用直至恢复定时器触发
    testAiProviderConnectionMock.mockImplementation(async () => ({ ok: false, error: "quota exceeded" }));
    row.querySelector(".ai-provider-model").value = "gpt-4o-mini";
    fireClick(row.querySelector(".ai-provider-test"));
    await flushMicrotasks();
    expect(status.textContent).toBe("失败：quota exceeded");
    expect(status.dataset.error).toBe("true");
    expect(Array.from(row.querySelectorAll("input, button")).every((el) => el.disabled)).toBe(true);

    await vi.advanceTimersByTimeAsync(2000);
    expect(Array.from(row.querySelectorAll("input, button")).every((el) => !el.disabled)).toBe(true);
  });

  it("删除：确认后发后台消息并移除行、恢复空态；取消确认则不动", async () => {
    const rows = await loadAiRows();
    const { listNode, emptyNode } = makeContainer();
    rows.renderAiProviders(listNode, emptyNode, [aiItem], { presets: AI_PRESETS });
    const row = listNode.querySelector(".ai-provider-row");

    confirmMock.mockReturnValueOnce(false);
    fireClick(row.querySelector(".ai-provider-remove"));
    expect(listNode.querySelectorAll(".ai-provider-row")).toHaveLength(1);
    expect(sendRuntimeMessageMock).not.toHaveBeenCalled();

    fireClick(row.querySelector(".ai-provider-remove"));
    await flushMicrotasks();
    expect(sendRuntimeMessageMock.mock.calls[0][0]).toEqual({ type: "ai-providers-delete", providerId: "p1" });
    expect(listNode.querySelectorAll(".ai-provider-row")).toHaveLength(0);
    expect(emptyNode.hidden).toBe(false);
  });

  it("删除：确认后先同步触发 onBeforeDelete（权限回收钩子）再走后台删除；取消确认不触发", async () => {
    const rows = await loadAiRows();
    const { listNode, emptyNode } = makeContainer();
    const onBeforeDelete = vi.fn(async () => {});
    rows.setAiBeforeDeleteHandler(onBeforeDelete);
    rows.renderAiProviders(listNode, emptyNode, [aiItem], { presets: AI_PRESETS });
    const row = listNode.querySelector(".ai-provider-row");

    confirmMock.mockReturnValueOnce(false);
    fireClick(row.querySelector(".ai-provider-remove"));
    expect(onBeforeDelete).not.toHaveBeenCalled();

    fireClick(row.querySelector(".ai-provider-remove"));
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
    const onBeforeDelete = vi.fn(async () => {
      throw new Error("permissions API unavailable");
    });
    rows.setAiBeforeDeleteHandler(onBeforeDelete);
    rows.renderAiProviders(listNode, emptyNode, [aiItem], { presets: AI_PRESETS });
    const row = listNode.querySelector(".ai-provider-row");

    fireClick(row.querySelector(".ai-provider-remove"));
    await flushMicrotasks();
    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({ type: "ai-providers-delete", providerId: "p1" });
    expect(listNode.querySelectorAll(".ai-provider-row")).toHaveLength(0);
    expect(emptyNode.hidden).toBe(false);
  });

  it("模型下拉：点击 toggle 发拉取消息并填充选项，选中写回输入框", async () => {
    sendRuntimeMessageMock.mockImplementation(async () => ({ ok: true, models: ["gpt-4o-mini", "gpt-4o"] }));
    const rows = await loadAiRows();
    const { listNode, emptyNode } = makeContainer();
    rows.renderAiProviders(listNode, emptyNode, [aiItem], { presets: AI_PRESETS });
    const row = listNode.querySelector(".ai-provider-row");
    const dropdown = row.querySelector(".ai-provider-model-dropdown");

    fireClick(row.querySelector(".ai-provider-model-toggle"));
    await flushMicrotasks();
    expect(sendRuntimeMessageMock.mock.calls[0][0]).toEqual({
      type: "ai-providers-models",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      providerId: "p1"
    });
    expect(dropdown.hidden).toBe(false);
    const options = Array.from(dropdown.querySelectorAll(".ai-provider-model-option"));
    expect(options.map((li) => li.dataset.model)).toEqual(["gpt-4o-mini", "gpt-4o"]);

    fireClick(options[1]);
    expect(row.querySelector(".ai-provider-model").value).toBe("gpt-4o");
    expect(dropdown.hidden).toBe(true);
  });
});

describe("createProviderRow：ASR 平台行（options-asr-rows.js 配置）", () => {
  const asrItem = {
    id: "asr1",
    presetId: "siliconflow",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "FunAudioLLM/SenseVoiceSmall"
  };

  it("渲染行结构：名称输入 + 模型下拉 + 选用 radio，删除/状态行复用 AI 类名", async () => {
    const rows = await loadAsrRows();
    const { listNode, emptyNode } = makeContainer();
    rows.renderAsrProviders(listNode, emptyNode, [asrItem, { id: "asr2", presetId: "local-whisper" }], { presets: ASR_PRESETS, activeId: "asr2" });

    const allRows = listNode.querySelectorAll(".asr-provider-row");
    expect(allRows).toHaveLength(2);
    expect(emptyNode.hidden).toBe(true);

    const row = allRows[0];
    expect(row.dataset.currentPresetId).toBe("siliconflow");
    // 名称输入（AI 行没有），名称取自预设
    expect(row.querySelector(".asr-provider-name").value).toBe("SiliconFlow 硅基流动（免费）");
    // 预设带 modelOptions → 模型渲染为下拉框
    const modelSelect = row.querySelector("select.asr-provider-model");
    expect(modelSelect).not.toBeNull();
    expect(modelSelect.value).toBe("FunAudioLLM/SenseVoiceSmall");
    // whisper 预设无 modelOptions → 模型为文本输入，值跟随预设 model
    expect(allRows[1].querySelector("input.asr-provider-model").value).toBe("whisper-large-v3");
    // 选用 radio：activeId 命中 asr2
    const radios = listNode.querySelectorAll(".asr-provider-active-radio");
    expect(radios[0].checked).toBe(false);
    expect(radios[1].checked).toBe(true);
    expect(radios[0].closest("label").title).toBe("选用该平台自动生成字幕");
    // 既有耦合：ASR 行复用 AI 的删除按钮与状态行类名
    expect(row.querySelector("button.ai-provider-remove")).not.toBeNull();
    expect(row.querySelector(".asr-provider-remove")).toBeNull();
    expect(row.querySelector("p.ai-provider-status")).not.toBeNull();
    expect(readTrashPaths(row)).toEqual(TRASH_PATHS);
    // 测试按钮为 ASR 类名 + secondary-btn
    expect(row.querySelector("button.secondary-btn.asr-provider-test")).not.toBeNull();
  });

  it("已保存 model 不在下拉选项中时追加保留项", async () => {
    const rows = await loadAsrRows();
    const { listNode, emptyNode } = makeContainer();
    rows.renderAsrProviders(listNode, emptyNode, [{ ...asrItem, model: "legacy-model" }], { presets: ASR_PRESETS });
    const modelSelect = listNode.querySelector("select.asr-provider-model");
    expect(Array.from(modelSelect.options).map((o) => o.value)).toEqual([
      "FunAudioLLM/SenseVoiceSmall",
      "legacy-model"
    ]);
    expect(modelSelect.value).toBe("legacy-model");
  });

  it("预设切换：未改过 baseUrl 才跟随；模型字段重建、名称跟随、Key 清空", async () => {
    const rows = await loadAsrRows();
    const { listNode, emptyNode } = makeContainer();
    rows.renderAsrProviders(listNode, emptyNode, [asrItem], { presets: ASR_PRESETS });
    const row = listNode.querySelector(".asr-provider-row");
    const select = row.querySelector(".asr-provider-preset");
    const baseUrlInput = row.querySelector(".asr-provider-baseurl");
    const apikeyInput = row.querySelector(".asr-provider-apikey");
    apikeyInput.value = "sk-old";

    // 未改过 baseUrl → 跟随 whisper 预设；模型字段由下拉重建为文本输入；
    // 名称无条件跟随；Key 清空
    select.value = "local-whisper";
    select.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("http://localhost:8000/v1");
    expect(row.querySelector("select.asr-provider-model")).toBeNull();
    expect(row.querySelector("input.asr-provider-model").value).toBe("whisper-large-v3");
    expect(row.querySelector(".asr-provider-name").value).toBe("本地 Whisper 服务");
    expect(apikeyInput.value).toBe("");
    expect(row.dataset.currentPresetId).toBe("local-whisper");

    // 用户改过 baseUrl → 保持不动（切回 siliconflow 也不覆盖）
    baseUrlInput.value = "https://my-asr.example.com/v1";
    select.value = "siliconflow";
    select.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("https://my-asr.example.com/v1");
    // 模型字段重建回下拉框
    expect(row.querySelector("input.asr-provider-model")).toBeNull();
    expect(row.querySelector("select.asr-provider-model").value).toBe("FunAudioLLM/SenseVoiceSmall");
    expect(row.querySelector(".asr-provider-name").value).toBe("SiliconFlow 硅基流动（免费）");
  });

  it("测试连接：直调探针（provider 对象仅重输 Key 时携带 apiKey）；成功回调保存", async () => {
    vi.useFakeTimers();
    const rows = await loadAsrRows();
    const { listNode, emptyNode } = makeContainer();
    // 与 options.js 注入的行为一致：测试成功后重新保存设置并重渲染列表
    const onTestSuccess = vi.fn(async () => {
      rows.renderAsrProviders(listNode, emptyNode, [asrItem], { presets: ASR_PRESETS });
    });
    rows.setAsrTestSuccessHandler(onTestSuccess);
    rows.renderAsrProviders(listNode, emptyNode, [asrItem], { presets: ASR_PRESETS });
    const row = listNode.querySelector(".asr-provider-row");
    row.querySelector(".asr-provider-name").value = "我的 ASR";

    // 未重输 Key → 不携带 apiKey
    fireClick(row.querySelector(".asr-provider-test"));
    await flushMicrotasks();
    expect(testAsrConnectionMock).toHaveBeenCalledTimes(1);
    expect(testAsrConnectionMock.mock.calls[0][0]).toEqual({
      id: "asr1",
      name: "我的 ASR",
      type: "openai-transcriptions",
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "FunAudioLLM/SenseVoiceSmall"
    });
    expect(sendRuntimeMessageMock).not.toHaveBeenCalled();
    expect(onTestSuccess).toHaveBeenCalledWith("asr1");

    // 重渲染后的新行显示"连接成功"并禁用输入，2 秒后恢复
    const newRow = listNode.querySelector(".asr-provider-row");
    const status = newRow.querySelector(".ai-provider-status");
    expect(status.textContent).toBe("连接成功");
    expect(Array.from(newRow.querySelectorAll("input, button")).every((el) => el.disabled)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(Array.from(newRow.querySelectorAll("input, button")).every((el) => !el.disabled)).toBe(true);

    // 重输 Key → 携带 apiKey
    testAsrConnectionMock.mockClear();
    newRow.querySelector(".asr-provider-apikey").value = "sk-new";
    fireClick(newRow.querySelector(".asr-provider-test"));
    await flushMicrotasks();
    expect(testAsrConnectionMock.mock.calls[0][0].apiKey).toBe("sk-new");
  });

  it("删除：后台消息后触发注入的 onDelete，并恢复空态", async () => {
    const rows = await loadAsrRows();
    const { listNode, emptyNode } = makeContainer();
    const onDelete = vi.fn(async () => {});
    rows.setAsrDeleteHandler(onDelete);
    const onBeforeDelete = vi.fn(async () => {});
    rows.setAsrBeforeDeleteHandler(onBeforeDelete);
    rows.renderAsrProviders(listNode, emptyNode, [asrItem], { presets: ASR_PRESETS });
    const row = listNode.querySelector(".asr-provider-row");

    fireClick(row.querySelector(".ai-provider-remove"));
    await flushMicrotasks();
    expect(onBeforeDelete).toHaveBeenCalledWith("asr1", "https://api.siliconflow.cn/v1");
    expect(sendRuntimeMessageMock.mock.calls[0][0]).toEqual({ type: "asr-providers-delete", providerId: "asr1" });
    expect(onDelete).toHaveBeenCalledWith("asr1");
    expect(listNode.querySelectorAll(".asr-provider-row")).toHaveLength(0);
    expect(emptyNode.hidden).toBe(false);
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
});
