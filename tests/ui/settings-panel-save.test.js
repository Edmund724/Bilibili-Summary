// ui/settings-panel.ts saveSettings 保存链与 applyValidationError 直测
//（arch-slim-2/05 测试网；provider-master-detail/02 起 saveSettings 只承载
// 其余设置项——AI/ASR 平台的收集/校验/落盘/权限申请整体移交 provider-editor
// Modal 的单平台链，见 provider-editor.test.js）。
//
// 走真实模块 + DOM 仿真（digest-button.test.js 同款）：saveSettings 未导出，
// 经唯一公开入口 renderReaderSettingsPanel 挂载面板后驱动——
// - 保存链：收集(collectFormPayload) → 校验(validateSettings) → 单路落盘
//   (save-settings)；平台相关的 request-provider-origins /
//   ai-providers-save / asr-providers-save 消息不再出自本链；
// - applyValidationError 直测：可达分支为 AI 平台校验的 message-only 分支、
//   保存开头的 clearInputErrors 联动，以及（arch-slim-2/02 修复后）row 级分支
//   的行内落位。field 分支（tags 换行）经 DOM 不可达——单行 input 的 value
//   sanitizer 会剥掉换行（jsdom 与真实浏览器一致）；row 分支曾是真 bug
//   （validators 返回的 row 是收集对象 {key,type,value,row}，产线把它当
//   HTMLElement 调 querySelector → TypeError），已由 02 票修复并在此补
//   行级落位断言（见文末与两票 Comments）。行级错误态载体是 aria-invalid
//   属性（M9 校验态现代化：原生约束表达不了的条件规则走指南 fallback 通道，
//   CSS 侧 reader-settings.css 的 [aria-invalid="true"] 规则消费）。
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

describe("saveSettings 保存链（保存按钮手势）", () => {
  it("全链成功：收集→校验→单路落盘（平台消息不再出自本链），状态条成功、busy 复位", async () => {
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
      expect(sent.some((message) => message.type === "save-settings")).toBe(true);
    });

    // provider-master-detail/02：平台收集/权限代申请/平台落盘段已整体退役，
    // 保存设置按钮只发 save-settings 一路
    const types = messageTypes(sent);
    expect(types).toContain("save-settings");
    expect(types).not.toContain("request-provider-origins");
    expect(types).not.toContain("ai-providers-save");
    expect(types).not.toContain("asr-providers-save");

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

    // 状态条与 busy 复位
    const status = lastStatus(host);
    expect(status.textContent).toBe("保存成功");
    expect(status.dataset.error).toBe("false");
    const saveBtn = host.querySelector("#bocSettingsSaveBtn");
    expect(saveBtn.disabled).toBe(false);
    expect(saveBtn.textContent).toBe("保存设置");
  });

  it("save-settings 失败：状态条报错，busy 复位", async () => {
    const sent = installMessageBus({ "save-settings": () => ({ ok: false, error: "写入失败" }) });
    const host = await mountPanel();

    fireClick(host.querySelector("#bocSettingsSaveBtn"));

    await vi.waitFor(() => {
      expect(lastStatus(host).textContent).toBe("写入失败");
    });

    expect(lastStatus(host).dataset.error).toBe("true");
    expect(host.querySelector("#bocSettingsSaveBtn").disabled).toBe(false);
    expect(host.querySelector("#bocSettingsSaveBtn").textContent).toBe("保存设置");
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
    staleKey.setAttribute("aria-invalid", "true");
    staleErrorNode.hidden = false;
    staleErrorNode.textContent = "旧错误残留";

    fireClick(host.querySelector("#addNoteSectionBtn"));
    const noteRow = host.querySelector("#noteSectionsList .note-section-row");
    const staleTitle = noteRow.querySelector(".note-section-title");
    staleTitle.setAttribute("aria-invalid", "true");

    const tags = host.querySelector("#tags");
    tags.setAttribute("aria-invalid", "true");

    fireClick(host.querySelector("#bocSettingsSaveBtn"));

    await vi.waitFor(() => {
      expect(lastStatus(host).textContent).toBe("保存成功");
    });

    // 联动：saveSettings 第一步 clearInputErrors 清掉全部旧错误态
    //（预置行 key/value 均空，validators 跳过空行，不阻断保存）
    expect(tags.getAttribute("aria-invalid")).toBeNull();
    expect(staleKey.getAttribute("aria-invalid")).toBeNull();
    expect(staleErrorNode.hidden).toBe(true);
    expect(staleErrorNode.textContent).toBe("");
    expect(staleTitle.getAttribute("aria-invalid")).toBeNull();
    expect(lastStatus(host).dataset.error).toBe("false");
    expect(sent.some((message) => message.type === "save-settings")).toBe(true);
  });

  it("tags 输入监听：input 事件即清自身错误态（修正输入即清错）", async () => {
    installMessageBus();
    const host = await mountPanel();

    const tags = host.querySelector("#tags");
    tags.setAttribute("aria-invalid", "true");
    tags.dispatchEvent(new Event("input", { bubbles: true }));

    expect(tags.getAttribute("aria-invalid")).toBeNull();
  });

  // 行级落位断言（arch-slim-2/02 补）：05 票发现的 row 级真 bug（validators
  // 返回的 row 是收集对象 {key,type,value,row}，applyValidationError 旧代码把
  // 收集对象整体当 HTMLElement 调 row.querySelector → TypeError，保存静默失败、
  // 无任何 UI 反馈）已由 02 票修复——按收集对象定位真实 DOM 行。以下三条用例
  // 在修复前会以 unhandled rejection 形式炸掉，修复后逐分支断言错误落位。
  it("固定属性行校验失败（key 缺失）：错误落位到真实 DOM 行的 key 输入框", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();

    fireClick(host.querySelector("#addFixedPropertyBtn"));
    const row = host.querySelector("#fixedPropertiesList .fixed-property-row");
    // 显式清空 key（新行的 value 属性是字面量 "undefined"，见 escapeHtml(undefined)），
    // 只填值：validateFixedFrontmatterProperties 报「请填写固定属性的属性名」
    row.querySelector(".fixed-property-key").value = "";
    row.querySelector(".fixed-property-value").value = "some-value";

    fireClick(host.querySelector("#bocSettingsSaveBtn"));

    // 行内落位：key 输入框标错并聚焦，行内错误节点显示具体文案
    const keyInput = row.querySelector(".fixed-property-key");
    expect(keyInput.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(keyInput);
    const errorNode = row.querySelector(".fixed-property-error");
    expect(errorNode.hidden).toBe(false);
    expect(errorNode.textContent).toBe("请填写固定属性的属性名");
    expect(lastStatus(host).textContent).toBe("请填写固定属性的属性名");
    expect(lastStatus(host).dataset.error).toBe("true");

    // 校验失败在权限代申请之前中止：三路落盘零发送
    expect(sent.some((message) => message.type === "request-provider-origins")).toBe(false);
    expect(sent.some((message) => message.type === "save-settings")).toBe(false);
  });

  it("固定属性行校验失败（value 缺失）：错误落位到值输入框", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();

    fireClick(host.querySelector("#addFixedPropertyBtn"));
    const row = host.querySelector("#fixedPropertiesList .fixed-property-row");
    // 填属性名、清空值（text 类型）：报「请填写固定属性的属性值」
    row.querySelector(".fixed-property-key").value = "favorite_quote";
    row.querySelector(".fixed-property-value").value = "";

    fireClick(host.querySelector("#bocSettingsSaveBtn"));

    const valueInput = row.querySelector(".fixed-property-value");
    expect(valueInput.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(valueInput);
    expect(row.querySelector(".fixed-property-key").getAttribute("aria-invalid")).toBeNull();
    const errorNode = row.querySelector(".fixed-property-error");
    expect(errorNode.hidden).toBe(false);
    expect(errorNode.textContent).toBe("请填写固定属性的属性值");
    expect(sent.some((message) => message.type === "save-settings")).toBe(false);
  });

  it("笔记段落行校验失败（标题缺失）：note-section-error 显示「请填写段落标题」", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();

    fireClick(host.querySelector("#addNoteSectionBtn"));
    const row = host.querySelector("#noteSectionsList .note-section-row");
    // 清空标题（新行的 value 属性是字面量 "undefined"）、内容非空：
    // validateNotePlaceholderSections 报「请填写段落标题」
    row.querySelector(".note-section-title").value = "";
    row.querySelector(".note-section-content").value = "默认内容";

    fireClick(host.querySelector("#bocSettingsSaveBtn"));

    const titleInput = row.querySelector(".note-section-title");
    expect(titleInput.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(titleInput);
    const errorNode = row.querySelector(".note-section-error");
    expect(errorNode.hidden).toBe(false);
    expect(errorNode.textContent).toBe("请填写段落标题");
    expect(lastStatus(host).textContent).toBe("请填写段落标题");
    expect(lastStatus(host).dataset.error).toBe("true");
    expect(sent.some((message) => message.type === "save-settings")).toBe(false);
  });

  // 缺陷与不可达记录（arch-slim-2/05 实施期发现，02 票修复，详见两票 Comments）：
  // 1. row 级分支曾是真 bug——validate* 返回的 row 是收集对象 {key,type,value,row}，
  //    applyValidationError 把它当 HTMLElement 调 row.querySelector → TypeError
  //    （未处理 rejection，保存静默失败、无任何 UI 反馈）。02 票改为按收集对象
  //    的 .row 属性定位真实 DOM 行，上方三条行级落位断言已补齐。
  // 2. tags 换行的 field 分支经 DOM 不可达——单行 input 的 value sanitizer 剥离
  //    换行（"a\nb" 落到 value 是 "ab"，jsdom 与真实浏览器一致），
  //    /[\r\n]/.test(payload.tags) 恒为 false。该分支只能在注入 payload 层触达，
  //    属防御性代码。
});

describe("设置分区渲染隔离与外点关闭委托（M15 INP）", () => {
  it("分区挂载即套 containment：content-visibility: auto + 高度占位", async () => {
    installMessageBus();
    const host = await mountPanel();

    const groups = host.querySelectorAll(".boc-set-group");
    expect(groups.length).toBeGreaterThan(0);
    groups.forEach((group) => {
      expect(group.style.contentVisibility).toBe("auto");
      expect(group.style.containIntrinsicHeight).toBe("auto 240px");
    });
  });

  it("外点关闭委托：类型菜单展开后点击面板外收起（守卫检查到开着弹层放行）", async () => {
    installMessageBus();
    const host = await mountPanel();

    fireClick(host.querySelector("#addFixedPropertyBtn"));
    const picker = host.querySelector(".fixed-property-type-picker");
    const button = picker.querySelector(".fixed-property-type-button");
    const menu = picker.querySelector(".fixed-property-type-menu");
    // 类型按钮自身监听器 stopPropagation，document 外点委托不触发（组件自开）
    fireClick(button);
    expect(picker.dataset.open).toBe("true");
    expect(menu.hidden).toBe(false);

    // 点击设置分区之外（面板宿主上）→ 外点委托收起
    fireClick(document.body);
    expect(picker.dataset.open).toBe("false");
    expect(menu.hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("常态快速通道：三类弹层全关时 document 点击零收起动作", async () => {
    installMessageBus();
    const host = await mountPanel();
    const customSelect = await import("../../extension/ui/custom-select.js");
    const spy = vi.spyOn(customSelect, "closeAllCustomSelects");

    expect(
      document.querySelector(
        '.fixed-property-type-picker[data-open="true"], .ai-provider-model-dropdown:not([hidden]), .custom-select-dropdown:not([hidden])'
      )
    ).toBeNull();
    fireClick(document.body);

    expect(spy).not.toHaveBeenCalled();
  });
});
