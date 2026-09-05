// ui/settings-panel.ts saveSettings 四段保存链与 applyValidationError 直测
//（arch-slim-2/05 测试网；此前 669 行零直测）。
//
// 走真实模块 + DOM 仿真（digest-button.test.js 同款）：saveSettings 未导出，
// 经唯一公开入口 renderReaderSettingsPanel 挂载面板后驱动——
// - 四段链：收集(collectFormPayload) → 校验(validateSettings) → host 权限代
//   申请(request-provider-origins 消息，content 语境无 chrome.permissions，
//   setup.js 的 chrome stub 恰好无 permissions 字段 → 走消息代申请分支) →
//   三路落盘(save-settings / ai-providers-save / asr-providers-save)；
// - 「测试连接成功后的自动保存复用本函数」：AI 平台行测试按钮 → mock 探针
//   成功 → onTestSuccess → saveSettings({ requestPermissions: false })，
//   断言该分支绝不发权限代申请；
// - applyValidationError 直测：可达分支为 AI 平台校验的 message-only 分支与
//   保存开头的 clearInputErrors 联动。field 分支（tags 换行）经 DOM 不可达——
//   单行 input 的 value sanitizer 会剥掉换行（jsdom 与真实浏览器一致）；row
//   分支现网是真 bug（实施期发现，见文末与票 Comments），不为它写会触发
//   unhandled rejection 的用例。
//
// chrome.runtime.sendMessage 换装成按 type 分发的消息总线（sent 记录全部出站
// 报文），loadSettings 是 fire-and-forget，mountPanel 用 vi.waitFor 等装载链
// 走完（最后一路 asr-providers-list）再操作表单。
//
// 触发点击统一走 fireClick（dispatchEvent）：tests/setup.js 的 click 补丁会让
// HTMLElement.click() 双发事件（jsdom 原生派发 + 补丁再手动派发一次），监听器
// 双触发会把保存链并发跑两趟（第二趟收集到的可能已被第一趟重渲染清空）。产线
// 监听器对 dispatchEvent 与真实点击同样响应。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_AI_SYSTEM_PROMPT, DEFAULT_INITIAL_QUICK_PROMPTS } from "../../extension/core/defaults.js";

// AI 探针 mock：测试连接按钮直调 provider-test（不经 SW 消息），固定成功
vi.mock("../../extension/ai/provider-test.js", () => ({
  testAiProviderConnection: vi.fn(async () => ({ ok: true }))
}));

function installMessageBus(overrides = {}) {
  const responders = {
    "get-settings": () => ({ ok: true, settings: {} }),
    // 预设列表返回失败 → settings-panel 回落内置 PRESETS / ASR_PROVIDER_PRESETS
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

async function mountPanel() {
  document.body.innerHTML = '<div id="boc-reading-settings-host"></div>';
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  const host = document.getElementById("boc-reading-settings-host");
  await vi.waitFor(() => {
    expect(chrome.runtime.sendMessage.mock.calls.some(([message]) => message.type === "asr-providers-list")).toBe(true);
  });
  return host;
}

function messageTypes(sent) {
  return sent.map((message) => message.type);
}

function lastStatus(host) {
  return host.querySelector("#bocSettingsStatus");
}

// 单发 click（见文件头说明）
function fireClick(node) {
  node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  resetModuleState();
});

describe("saveSettings 四段保存链（保存按钮手势，requestPermissions=true）", () => {
  it("全链成功：收集→校验→权限代申请→三路落盘有序完成，状态条成功、busy 复位", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();

    // 收集段：改表单若干值（含 trim / 布尔 / 复选组 / 数组截断口径）
    host.querySelector("#tags").value = "  clip, test  ";
    host.querySelector("#includeHotCommentsInNote").checked = true;
    host.querySelector("#enableDebugLogs").checked = true;
    host.querySelector("#aiSystemPrompt").value = "  自定义系统提示词  ";
    host.querySelector('input[name="frontmatterField"][value="author"]').checked = false;

    fireClick(host.querySelector("#bocSettingsSaveBtn"));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "asr-providers-save")).toBe(true);
    });

    // 第二段→第三段：权限代申请先于落盘（手势同步链），本用例无平台行 → 空集合
    const types = messageTypes(sent);
    expect(types).toContain("request-provider-origins");
    expect(types.indexOf("request-provider-origins")).toBeLessThan(types.indexOf("save-settings"));
    expect(sent.find((message) => message.type === "request-provider-origins").baseUrls).toEqual([]);

    // 第四段三路落盘，顺序 save-settings → ai-providers-save → asr-providers-save
    expect(types.indexOf("save-settings")).toBeLessThan(types.indexOf("ai-providers-save"));
    expect(types.indexOf("ai-providers-save")).toBeLessThan(types.indexOf("asr-providers-save"));

    const saveMessage = sent.find((message) => message.type === "save-settings");
    expect(saveMessage.settings).toMatchObject({
      tags: "clip, test",
      downloadFormat: "srt",
      includeDateInFilename: true,
      includeHotCommentsInNote: true,
      enableDebugLogs: true,
      aiSystemPrompt: "自定义系统提示词",
      frontmatterFields: expect.not.arrayContaining(["author"])
    });
    expect(saveMessage.settings.frontmatterFields).toContain("title");
    expect(saveMessage.settings.aiInitialQuickPrompts).toEqual(DEFAULT_INITIAL_QUICK_PROMPTS);
    expect(saveMessage.settings.aiPresetPrompts).toHaveLength(3);
    expect(saveMessage.settings.fixedFrontmatterProperties).toEqual([]);
    expect(saveMessage.settings.notePlaceholderSections).toEqual([]);
    expect(sent.find((message) => message.type === "ai-providers-save").providers).toEqual([]);

    // 状态条与 busy 复位
    const status = lastStatus(host);
    expect(status.textContent).toBe("保存成功");
    expect(status.dataset.error).toBe("false");
    const saveBtn = host.querySelector("#bocSettingsSaveBtn");
    expect(saveBtn.disabled).toBe(false);
    expect(saveBtn.textContent).toBe("保存设置");
  });

  it("权限代申请被拒：中止保存不落盘，状态条可操作提示，busy 未进入", async () => {
    const sent = installMessageBus({
      "request-provider-origins": () => ({ ok: false, error: "未授权 https://api.example.com/*，保存已中止" })
    });
    const host = await mountPanel();

    fireClick(host.querySelector("#bocSettingsSaveBtn"));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "request-provider-origins")).toBe(true);
    });
    await vi.waitFor(() => {
      expect(lastStatus(host).textContent).toContain("未授权");
    });

    expect(sent.some((message) => message.type === "save-settings")).toBe(false);
    expect(lastStatus(host).dataset.error).toBe("true");
    expect(host.querySelector("#bocSettingsSaveBtn").textContent).toBe("保存设置");
  });

  it("save-settings 失败：只走第一路，状态条报错，后两路不再发送，busy 复位", async () => {
    const sent = installMessageBus({ "save-settings": () => ({ ok: false, error: "写入失败" }) });
    const host = await mountPanel();

    fireClick(host.querySelector("#bocSettingsSaveBtn"));

    await vi.waitFor(() => {
      expect(lastStatus(host).textContent).toBe("写入失败");
    });

    expect(sent.some((message) => message.type === "ai-providers-save")).toBe(false);
    expect(sent.some((message) => message.type === "asr-providers-save")).toBe(false);
    expect(lastStatus(host).dataset.error).toBe("true");
    expect(host.querySelector("#bocSettingsSaveBtn").disabled).toBe(false);
    expect(host.querySelector("#bocSettingsSaveBtn").textContent).toBe("保存设置");
  });

  it("ai-providers-save 失败：主设置已保存，状态条给出部分失败文案", async () => {
    const sent = installMessageBus({ "ai-providers-save": () => ({ ok: false, error: "sync 配额不足" }) });
    const host = await mountPanel();

    fireClick(host.querySelector("#bocSettingsSaveBtn"));

    await vi.waitFor(() => {
      expect(lastStatus(host).textContent).toBe("已保存，但 AI 平台保存失败：sync 配额不足");
    });
    expect(lastStatus(host).dataset.error).toBe("true");
  });

  it("ai-providers-save 抛异常（如扩展上下文失效）：被 try/catch 捕获，状态条报错、busy 复位", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();
    // 三路落盘段在 saveSettings 的 try/catch 内：sendMessage 同步抛错经
    // sendRuntimeMessage 的 reject 传播到 catch（status 显示 error.message）
    const rawSend = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = vi.fn((message, callback) => {
      if (message.type === "ai-providers-save") {
        throw new Error("Extension context invalidated.");
      }
      return rawSend(message, callback);
    });

    fireClick(host.querySelector("#bocSettingsSaveBtn"));

    await vi.waitFor(() => {
      expect(lastStatus(host).textContent).toBe("Extension context invalidated.");
    });
    expect(lastStatus(host).dataset.error).toBe("true");
    expect(sent.some((message) => message.type === "asr-providers-save")).toBe(false);
    expect(host.querySelector("#bocSettingsSaveBtn").disabled).toBe(false);
    expect(host.querySelector("#bocSettingsSaveBtn").textContent).toBe("保存设置");
  });
});

describe("测试连接成功后的自动保存复用 saveSettings（requestPermissions=false）", () => {
  it("AI 平台探针成功：自动落盘三路报文齐全，但绝不发权限代申请", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();

    fireClick(host.querySelector("#addAiProviderBtn"));
    const row = host.querySelector("#aiProvidersList .ai-provider-row");
    row.querySelector(".ai-provider-baseurl").value = "https://api.example.com/v1";
    row.querySelector(".ai-provider-apikey").value = "sk-test";
    row.querySelector(".ai-provider-model").value = "gpt-4o-mini";

    fireClick(row.querySelector(".ai-provider-test"));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "asr-providers-save")).toBe(true);
    });

    const types = messageTypes(sent);
    expect(types).not.toContain("request-provider-origins");
    expect(types.indexOf("save-settings")).toBeLessThan(types.indexOf("ai-providers-save"));
    expect(types.indexOf("ai-providers-save")).toBeLessThan(types.indexOf("asr-providers-save"));
    // 探针入参来自该行收集
    const aiSave = sent.find((message) => message.type === "ai-providers-save");
    expect(aiSave.providers).toHaveLength(1);
    expect(aiSave.providers[0]).toMatchObject({
      baseUrl: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-test"
    });
    expect(lastStatus(host).textContent).toBe("保存成功");
    expect(lastStatus(host).dataset.error).toBe("false");
  });
});

describe("applyValidationError：可达分支直测 + clearInputErrors 联动", () => {
  it("保存开头先 clearInputErrors：预置的旧行级错误态在校验前被清空，随后全链保存成功", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();

    // 预置三类旧错误态：tags 字段、固定属性行 key + 行内错误节点、笔记段落行标题
    fireClick(host.querySelector("#addFixedPropertyBtn"));
    const fixedRow = host.querySelector("#fixedPropertiesList .fixed-property-row");
    const staleKey = fixedRow.querySelector(".fixed-property-key");
    const staleErrorNode = fixedRow.querySelector(".fixed-property-error");
    staleKey.classList.add("input-error");
    staleErrorNode.hidden = false;
    staleErrorNode.textContent = "旧错误残留";

    fireClick(host.querySelector("#addNoteSectionBtn"));
    const noteRow = host.querySelector("#noteSectionsList .note-section-row");
    const staleTitle = noteRow.querySelector(".note-section-title");
    staleTitle.classList.add("input-error");

    const tags = host.querySelector("#tags");
    tags.classList.add("input-error");

    fireClick(host.querySelector("#bocSettingsSaveBtn"));

    await vi.waitFor(() => {
      expect(lastStatus(host).textContent).toBe("保存成功");
    });

    // 联动：saveSettings 第一步 clearInputErrors 清掉全部旧错误态
    //（预置行 key/value 均空，validators 跳过空行，不阻断保存）
    expect(tags.classList.contains("input-error")).toBe(false);
    expect(staleKey.classList.contains("input-error")).toBe(false);
    expect(staleErrorNode.hidden).toBe(true);
    expect(staleErrorNode.textContent).toBe("");
    expect(staleTitle.classList.contains("input-error")).toBe(false);
    expect(lastStatus(host).dataset.error).toBe("false");
    expect(sent.some((message) => message.type === "save-settings")).toBe(true);
  });

  it("tags 输入监听：input 事件即清自身错误态（修正输入即清错）", async () => {
    installMessageBus();
    const host = await mountPanel();

    const tags = host.querySelector("#tags");
    tags.classList.add("input-error");
    tags.dispatchEvent(new Event("input", { bubbles: true }));

    expect(tags.classList.contains("input-error")).toBe(false);
  });

  it("AI 平台校验失败（message-only 分支）：不落盘，状态条显示具体平台文案", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();

    fireClick(host.querySelector("#addAiProviderBtn"));
    const row = host.querySelector("#aiProvidersList .ai-provider-row");
    row.querySelector(".ai-provider-baseurl").value = "https://api.example.com/v1";
    // requiresKey 预设 + 未填 Key：validateAiProviders 报需要 API Key
    row.querySelector(".ai-provider-model").value = "gpt-4o-mini";

    fireClick(host.querySelector("#bocSettingsSaveBtn"));

    expect(lastStatus(host).textContent).toBe("平台「自定义」需要填写 API Key");
    expect(lastStatus(host).dataset.error).toBe("true");
    expect(sent.some((message) => message.type === "request-provider-origins")).toBe(false);
    expect(sent.some((message) => message.type === "save-settings")).toBe(false);
  });

  it("baseUrl 非法（message-only 分支）：状态条报格式错误，不进入权限代申请", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();

    fireClick(host.querySelector("#addAiProviderBtn"));
    const row = host.querySelector("#aiProvidersList .ai-provider-row");
    row.querySelector(".ai-provider-baseurl").value = "not-a-url";
    row.querySelector(".ai-provider-apikey").value = "sk-test";
    row.querySelector(".ai-provider-model").value = "gpt-4o-mini";

    fireClick(host.querySelector("#bocSettingsSaveBtn"));

    expect(lastStatus(host).textContent).toBe("baseUrl 格式不正确：not-a-url");
    expect(sent.some((message) => message.type === "request-provider-origins")).toBe(false);
    expect(sent.some((message) => message.type === "save-settings")).toBe(false);
  });

  // 缺陷与不可达记录（arch-slim-2/05 实施期发现，详见票 Comments）：
  // 1. row 级分支是真 bug——validate* 返回的 row 是收集对象 {key,type,value,row}，
  //    applyValidationError 把它当 HTMLElement 调 row.querySelector → TypeError
  //    （未处理 rejection，保存静默失败、无任何 UI 反馈）。修复前不为该分支写
  //    会触发 unhandled rejection 的用例；修复后应在此补行级落位断言（key 缺失
  //    → keyInput 落位、value 缺失 → valueInput 落位、段落标题缺失 →
  //    note-section-error 显示「请填写段落标题」）。
  // 2. tags 换行的 field 分支经 DOM 不可达——单行 input 的 value sanitizer 剥离
  //    换行（"a\nb" 落到 value 是 "ab"，jsdom 与真实浏览器一致），
  //    /[\r\n]/.test(payload.tags) 恒为 false。该分支只能在注入 payload 层触达，
  //    属防御性代码。
});
