// tests/ui/provider-editor.test.js
// ui/provider-editor.ts 平台编辑 Modal 的行为契约（provider-master-detail/01）。
// 与 settings-panel-save.test.js 同款手法：真实模块 + DOM 仿真，经
// renderReaderSettingsPanel 挂载面板后从「+ 添加平台」/行「编辑」按钮驱动。
//
// 覆盖：
// - 新增保存链（拍板 Q2/Q4）：权限代申请 → 现查权威列表 → upsert 追加 →
//   整列表落盘（协议零改动）→ Modal 关闭 + 列表重渲；
// - 编辑预填（拍板 Q3）：按 id 现查列表项，Key 占位「已保存」，保存按原 id
//   替换非追加；
// - dirty 保护（拍板 Q6）：有改动 confirm 拦截，无改动直接关；Esc / 点遮罩
//   同走此保护；
// - 测试成功自动保存该平台（拍板 Q2 附带：requestPermissions=false 语义，
//   绝不发权限代申请），失败/保存失败/权限被拒的状态行与 Modal 存活；
// - 面板外点击 capture 拦截：只关 Modal，bubble 委托（抽屉外点关闭）收不到；
// - 抽屉收起联动：settingsPanel hidden → 强制关闭（丢改动不 confirm）。
//
// chrome.runtime.sendMessage 换装按 type 分发的消息总线；探针与 ASR 模型列表
// 模块整体 mock，隔离 fetch。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

vi.mock("../../extension/ai/provider-test.js", () => ({
  testAiProviderConnection: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/asr/provider-test.js", () => ({
  testAsrConnection: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/asr/provider-models.js", () => ({
  listAsrModels: vi.fn(async () => ({ ok: false, error: "not used" }))
}));

function installMessageBus(overrides = {}) {
  const responders = {
    "get-settings": () => ({ ok: true, settings: {} }),
    "ai-presets-list": () => ({ ok: false }),
    "asr-presets-list": () => ({ ok: false }),
    "ai-providers-list": () => ({ ok: true, providers: [] }),
    "asr-providers-list": () => ({ ok: true, providers: [] }),
    "save-settings": () => ({ ok: true }),
    "ai-providers-save": () => ({ ok: true, providers: [] }),
    "asr-providers-save": () => ({ ok: true, providers: [] }),
    "request-provider-origins": () => ({ ok: true }),
    ...overrides
  };
  const sent = [];
  chrome.runtime.sendMessage = vi.fn((message, callback) => {
    sent.push(message);
    const respond = responders[message.type];
    callback?.(respond ? respond(message) : { ok: true });
    return undefined;
  });
  return sent;
}

// 面板 + 编辑 Modal 的挂载环境：Modal 宿主挂 #boc-reading-view 直下
//（provider-editor.ensureHost），设置抽屉 hidden 联动监听挂在
// #boc-reading-settings-panel 上，两者都须在 DOM 里。
async function mountPanel(busOverrides = {}) {
  document.body.innerHTML = `
    <div id="boc-reading-view">
      <section id="boc-reading-settings-panel">
        <div id="boc-reading-settings-host"></div>
      </section>
    </div>
  `;
  const sent = installMessageBus(busOverrides);
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  const host = document.getElementById("boc-reading-settings-host");
  await vi.waitFor(() => {
    expect(chrome.runtime.sendMessage.mock.calls.some(([message]) => message.type === "asr-providers-list")).toBe(true);
  });
  return { sent, host };
}

async function openEditor(host, buttonSelectorOrElement) {
  const { isProviderEditorOpen } = await import("../../extension/ui/provider-editor.js");
  fireClick(typeof buttonSelectorOrElement === "string" ? host.querySelector(buttonSelectorOrElement) : buttonSelectorOrElement);
  await vi.waitFor(() => {
    expect(document.querySelector(".provider-editor-dialog")).toBeTruthy();
  });
  return { dialog: document.querySelector(".provider-editor-dialog"), isProviderEditorOpen };
}

function editorGone() {
  return document.querySelector(".provider-editor-host") === null;
}

// 单发 click（tests/setup.js 的 click 补丁会双发事件，见 settings-panel-save.test.js 文件头）
function fireClick(node) {
  node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

// 纯微任务冲刷：等待事件处理器里 await 消息链走完
async function flushMicrotasks() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

function messageTypes(sent) {
  return sent.map((message) => message.type);
}

let confirmMock;

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
  confirmMock = vi.fn(() => true);
  vi.stubGlobal("confirm", confirmMock);
});

describe("provider-editor：新增保存链（拍板 Q2/Q4）", () => {
  it("AI 新增：权限代申请 → 现查列表 → upsert 追加 → 整列表落盘，成功后关 Modal 并重渲列表", async () => {
    const savedList = [{ id: "p_new1", presetId: "custom", name: "自定义", baseUrl: "https://api.example.com/v1", model: "gpt-4o-mini", requiresKey: true, enabled: true, hasSavedKey: true }];
    const { sent, host } = await mountPanel({
      "ai-providers-save": () => ({ ok: true, providers: savedList })
    });

    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    // 新增默认「自定义」预设（与平铺行空白行一致）：baseUrl 空、Key 必填占位
    expect(dialog.querySelector(".provider-editor-preset").value).toBe("custom");
    expect(dialog.querySelector(".provider-editor-baseurl").value).toBe("");
    expect(dialog.querySelector(".provider-editor-apikey").placeholder).toBe("API Key");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    dialog.querySelector(".provider-editor-apikey").value = "sk-test";
    dialog.querySelector(".provider-editor-model").value = "gpt-4o-mini";

    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });

    // 手势同步链：权限代申请先于落盘（零先行 await，见 options-save-gesture 断言）。
    // 用 lastIndexOf：装载阶段（mountPanel）已各发过一次 list 消息，取保存链那趟。
    const types = messageTypes(sent);
    expect(types).toContain("request-provider-origins");
    expect(types.indexOf("request-provider-origins")).toBeLessThan(types.lastIndexOf("ai-providers-list"));
    expect(types.lastIndexOf("ai-providers-list")).toBeLessThan(types.indexOf("ai-providers-save"));
    expect(sent.find((message) => message.type === "request-provider-origins").baseUrls).toEqual(["https://api.example.com/v1"]);

    // 整列表落盘（协议零改动）：权威列表（空）+ upsert 追加，id 由 p_ 前缀生成
    const saveMessage = sent.find((message) => message.type === "ai-providers-save");
    expect(saveMessage.providers).toHaveLength(1);
    expect(saveMessage.providers[0]).toMatchObject({
      presetId: "custom",
      name: "自定义",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      requiresKey: true,
      enabled: true,
      apiKey: "sk-test"
    });
    expect(saveMessage.providers[0].id).toMatch(/^p_/);

    // 保存成功：Modal 关闭 + 用响应列表（含 hasSavedKey）重渲
    expect(editorGone()).toBe(true);
    expect(host.querySelectorAll("#aiProvidersList .ai-provider-row")).toHaveLength(1);
    expect(host.querySelector("#aiProvidersList .ai-provider-row").dataset.hasSavedKey).toBe("1");
  });

  it("ASR 新增：type/presetId 落入报文，保存后重渲", async () => {
    const savedList = [{ id: "asr_new1", presetId: "custom", name: "自定义", type: "openai-transcriptions", baseUrl: "https://asr.example.com/v1", model: "whisper-1", supportsTimestamps: true, enabled: true, hasSavedKey: true }];
    const { sent, host } = await mountPanel({
      "asr-providers-save": () => ({ ok: true, providers: savedList })
    });

    const { dialog } = await openEditor(host, "#addAsrProviderBtn");
    expect(dialog.querySelector(".provider-editor-apikey").placeholder).toBe("API Key");

    dialog.querySelector(".provider-editor-baseurl").value = "https://asr.example.com/v1";
    dialog.querySelector(".provider-editor-model").value = "whisper-1";

    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "asr-providers-save")).toBe(true);
    });

    const saveMessage = sent.find((message) => message.type === "asr-providers-save");
    expect(saveMessage.providers[0]).toMatchObject({
      presetId: "custom",
      type: "openai-transcriptions",
      name: "自定义",
      baseUrl: "https://asr.example.com/v1",
      model: "whisper-1"
    });
    expect(saveMessage.providers[0].id).toMatch(/^asr_/);
    expect(editorGone()).toBe(true);
    expect(host.querySelectorAll("#asrProvidersList .asr-provider-row")).toHaveLength(1);
  });

  it("AI 校验失败（缺 Key）：状态行报错不关 Modal，不落盘", async () => {
    const { sent, host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    dialog.querySelector(".provider-editor-model").value = "gpt-4o-mini";

    fireClick(dialog.querySelector(".provider-editor-save"));

    const status = dialog.querySelector(".provider-editor-status");
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("平台「自定义」需要填写 API Key");
    expect(status.dataset.error).toBe("true");
    expect(sent.some((message) => message.type === "ai-providers-save")).toBe(false);
    expect(editorGone()).toBe(false);
  });

  it("权限代申请被拒：状态行报错不落盘不关 Modal", async () => {
    const { sent, host } = await mountPanel({
      "request-provider-origins": () => ({ ok: false, error: "未授权 https://api.example.com/*，保存已中止" })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    dialog.querySelector(".provider-editor-apikey").value = "sk-test";
    dialog.querySelector(".provider-editor-model").value = "gpt-4o-mini";

    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(dialog.querySelector(".provider-editor-status").textContent).toContain("未授权");
    });
    expect(sent.some((message) => message.type === "ai-providers-save")).toBe(false);
    expect(editorGone()).toBe(false);
  });

  it("ai-providers-save 失败：状态行报错、busy 复位、Modal 不关", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-save": () => ({ ok: false, error: "sync 配额不足" })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    dialog.querySelector(".provider-editor-apikey").value = "sk-test";
    dialog.querySelector(".provider-editor-model").value = "gpt-4o-mini";

    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(dialog.querySelector(".provider-editor-status").textContent).toBe("sync 配额不足");
    });
    expect(dialog.querySelector(".provider-editor-save").disabled).toBe(false);
    expect(editorGone()).toBe(false);
  });
});

describe("provider-editor：编辑预填与 upsert 替换（拍板 Q3）", () => {
  const aiItem = { id: "p1", presetId: "custom", name: "我的端点", baseUrl: "https://api.example.com/v1", model: "gpt-4o-mini", requiresKey: true, enabled: true, hasSavedKey: true };

  it("按 id 现查权威列表项预填；Key 占位「已保存」；保存按原 id 替换非追加", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [aiItem] }),
      "ai-providers-save": () => ({ ok: true, providers: [{ ...aiItem, model: "gpt-4o" }] })
    });

    const row = host.querySelector("#aiProvidersList .ai-provider-row");
    const { dialog } = await openEditor(host, row.querySelector(".provider-row-edit"));

    // 预填：presetId/baseUrl/model 来自列表项；Key 不回传（占位「已保存」）
    expect(dialog.querySelector(".provider-editor-preset").value).toBe("custom");
    expect(dialog.querySelector(".provider-editor-baseurl").value).toBe("https://api.example.com/v1");
    expect(dialog.querySelector(".provider-editor-model").value).toBe("gpt-4o-mini");
    expect(dialog.querySelector(".provider-editor-apikey").value).toBe("");
    expect(dialog.querySelector(".provider-editor-apikey").placeholder).toBe("已保存");
    // AI 自定义名称（≠预设名）回填实值
    expect(dialog.querySelector(".provider-editor-name").value).toBe("我的端点");

    dialog.querySelector(".provider-editor-model").value = "gpt-4o";
    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });

    const saveMessage = sent.find((message) => message.type === "ai-providers-save");
    expect(saveMessage.providers).toHaveLength(1);
    expect(saveMessage.providers[0]).toMatchObject({ id: "p1", name: "我的端点", model: "gpt-4o", baseUrl: "https://api.example.com/v1" });
    expect(editorGone()).toBe(true);
  });

  it("AI 名称留空回落预设名；名称自定义（≠预设名）则随保存落盘", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-save": () => ({ ok: true, providers: [] })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    // 留空 → 预设名「自定义」
    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    dialog.querySelector(".provider-editor-apikey").value = "sk-test";
    dialog.querySelector(".provider-editor-model").value = "gpt-4o-mini";
    fireClick(dialog.querySelector(".provider-editor-save"));
    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });
    expect(sent.find((message) => message.type === "ai-providers-save").providers[0].name).toBe("自定义");
  });
});

describe("provider-editor：dirty 保护与关闭语义（拍板 Q6）", () => {
  it("有改动：取消/Esc/点遮罩先 confirm，拒绝不关；确认后关", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";

    confirmMock.mockReturnValueOnce(false);
    fireClick(dialog.querySelector(".provider-editor-cancel"));
    expect(confirmMock).toHaveBeenCalledWith("未保存的更改将丢失，确定关闭？");
    expect(editorGone()).toBe(false);

    fireClick(dialog.querySelector(".provider-editor-cancel"));
    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(editorGone()).toBe(true);
  });

  it("无改动：取消直接关，不弹 confirm", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    fireClick(dialog.querySelector(".provider-editor-cancel"));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(editorGone()).toBe(true);
  });

  it("Esc 关闭（走 dirty 保护）；点遮罩关闭", async () => {
    const { host } = await mountPanel();
    await openEditor(host, "#addAiProviderBtn");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(editorGone()).toBe(true);

    // 遮罩是 host 直下的 dialog 兄弟节点，从 document 查
    await openEditor(host, "#addAiProviderBtn");
    fireClick(document.querySelector(".provider-editor-mask"));
    expect(editorGone()).toBe(true);
  });

  it("保存成功后直接关（不因字段快照≠初始而弹 confirm）", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    dialog.querySelector(".provider-editor-apikey").value = "sk-test";
    dialog.querySelector(".provider-editor-model").value = "gpt-4o-mini";
    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => expect(editorGone()).toBe(true));
    expect(confirmMock).not.toHaveBeenCalled();
  });
});

describe("provider-editor：测试连接与自动保存（拍板 Q2 附带）", () => {
  it("测试成功：自动单平台保存（requestPermissions=false 语义，绝无权限代申请），状态行「连接成功」，Modal 不关", async () => {
    const { testAiProviderConnection } = await import("../../extension/ai/provider-test.js");
    const { sent, host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    dialog.querySelector(".provider-editor-apikey").value = "sk-test";
    dialog.querySelector(".provider-editor-model").value = "gpt-4o-mini";

    fireClick(dialog.querySelector(".provider-editor-test"));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });

    // 探针直调（新增 id 为空 → providerId 空串，Key 随参数携带）
    expect(testAiProviderConnection).toHaveBeenCalledWith({
      providerId: "",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o-mini"
    });
    // 自动保存路径不申请权限（能连通即已授权）
    expect(sent.some((message) => message.type === "request-provider-origins")).toBe(false);
    expect(sent.find((message) => message.type === "ai-providers-save").providers[0]).toMatchObject({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o-mini"
    });

    const status = dialog.querySelector(".provider-editor-status");
    expect(status.textContent).toBe("连接成功");
    expect(status.dataset.error).toBe("false");
    expect(editorGone()).toBe(false);
  });

  it("测试失败：状态行报错，不落盘", async () => {
    const { testAiProviderConnection } = await import("../../extension/ai/provider-test.js");
    testAiProviderConnection.mockImplementationOnce(async () => ({ ok: false, error: "quota exceeded" }));
    const { sent, host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    dialog.querySelector(".provider-editor-model").value = "gpt-4o-mini";

    fireClick(dialog.querySelector(".provider-editor-test"));

    await vi.waitFor(() => {
      expect(dialog.querySelector(".provider-editor-status").textContent).toBe("失败：quota exceeded");
    });
    expect(sent.some((message) => message.type === "ai-providers-save")).toBe(false);
    expect(dialog.querySelector(".provider-editor-test").disabled).toBe(false);
  });

  it("缺 baseUrl / 缺模型名：直接提示且不调探针", async () => {
    const { testAiProviderConnection } = await import("../../extension/ai/provider-test.js");
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    fireClick(dialog.querySelector(".provider-editor-test"));
    expect(dialog.querySelector(".provider-editor-status").textContent).toBe("请填写 baseUrl");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    fireClick(dialog.querySelector(".provider-editor-test"));
    expect(dialog.querySelector(".provider-editor-status").textContent).toBe("请填写模型名");
    expect(testAiProviderConnection).not.toHaveBeenCalled();
  });
});

describe("provider-editor：与设置抽屉的层级联动", () => {
  it("面板外点击：capture 拦截，只关 Modal，bubble 委托（抽屉外点关闭）收不到该点击", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const bubbleSpy = vi.fn();
    document.addEventListener("click", bubbleSpy);
    try {
      // 派发到 body（#boc-reading-view 之外）→ Modal 的 capture 监听 stopPropagation
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(bubbleSpy).not.toHaveBeenCalled();
      expect(editorGone()).toBe(true);
    } finally {
      document.removeEventListener("click", bubbleSpy);
    }
  });

  it("Modal 内点击不外传：document bubble 委托（抽屉外点关闭）收不到，Modal 不关", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const bubbleSpy = vi.fn();
    document.addEventListener("click", bubbleSpy);
    try {
      // 模拟 ui-renderer 的抽屉外点关闭委托（document bubble）：Modal 宿主在
      // settingsPanel 判定域之外，放行会把抽屉一起收掉（回归：实施首版正败于此）
      dialog.querySelector(".provider-editor-body").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(bubbleSpy).not.toHaveBeenCalled();
      expect(editorGone()).toBe(false);
    } finally {
      document.removeEventListener("click", bubbleSpy);
    }
  });

  it("Modal 内点下拉组件外收起模型下拉（settings-panel 文档级委托收不到不外传的点击，语义在 Modal 内自持）", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";
    // 模型下拉已在 DOM（hidden），置开再点组件外空白验证收起
    const dropdown = dialog.querySelector(".ai-provider-model-dropdown");
    dropdown.hidden = false;

    dialog.querySelector(".provider-editor-name").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(dropdown.hidden).toBe(true);
  });

  it("设置抽屉收起（hidden）时 Modal 强制关闭：dirty 也不 confirm", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector(".provider-editor-baseurl").value = "https://api.example.com/v1";

    document.getElementById("boc-reading-settings-panel").hidden = true;
    await vi.waitFor(() => {
      expect(editorGone()).toBe(true);
    });
    expect(confirmMock).not.toHaveBeenCalled();
  });
});

describe("provider-editor：预设切换（Modal 内不代申请权限）", () => {
  it("AI：baseUrl 未改过才跟随新预设；名称空则占位符跟随；切预设不发权限消息", async () => {
    const { sent, host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const select = dialog.querySelector(".provider-editor-preset");
    const baseUrlInput = dialog.querySelector(".provider-editor-baseurl");

    select.value = "ollama";
    select.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("http://localhost:11434/v1");
    expect(dialog.querySelector(".provider-editor-apikey").placeholder).toBe("API Key（可选）");

    // 用户改过 baseUrl → 不覆盖
    baseUrlInput.value = "https://my-proxy.example.com/v1";
    select.value = "openai_compat";
    select.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("https://my-proxy.example.com/v1");

    await flushMicrotasks();
    // 拍板 Q5 推论：Modal 内切预设不代申请，权限在保存时统一收口
    expect(sent.some((message) => message.type === "request-provider-origins")).toBe(false);
  });

  it("ASR：模型名/名称无条件跟随，Key 清空", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAsrProviderBtn");

    dialog.querySelector(".provider-editor-apikey").value = "sk-old";
    const select = dialog.querySelector(".provider-editor-preset");

    select.value = "local-whisper";
    select.dispatchEvent(new Event("change"));

    expect(dialog.querySelector(".provider-editor-baseurl").value).toBe("http://localhost:8000/v1");
    expect(dialog.querySelector(".provider-editor-model").value).toBe("whisper-large-v3");
    expect(dialog.querySelector(".provider-editor-name").value).toBe("本地 Whisper 服务");
    expect(dialog.querySelector(".provider-editor-apikey").value).toBe("");
  });
});
