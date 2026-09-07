// tests/ui/custom-select.test.js
// ui/custom-select.ts（ADR-0007：设置页下拉统一到本组件）两例最小行为测试
//（settings-ui-coherence/04）。驱动真实模块，挂载与消息总线沿用
// settings-panel-save.test.js 同款（renderReaderSettingsPanel 唯一公开入口 +
// 按 type 分发的 sendMessage stub + fireClick 单发点击）。
//
// (a) listbox 键盘语义：trigger Enter 展开 → ↓ 漫游 → Enter 选中——原生
//   select.value 写回且派生一次 bubbling change（收集链零改的根基），
//   aria-expanded / aria-selected / 焦点归位同步断言；
// (b) 段落位置校验失败的错误态归位（Q22 甲）：input-error 与 focus 落在
//   .custom-select-trigger（原生 select 已被壳 clip 隐藏），修正输入后清错
//   连带摘类。
//
// (b) 的前置态在真实链路上不可达：collectNoteSectionRows 与
// validateNotePlaceholderSections 双重归一化后 position 恒为合法位，
// applyValidationError 的 position 分支是防御分支——用 vi.doMock 让
// validateNotePlaceholderSections 返回行级失败来精确构造（mock 只裁剪校验
// 裁决，行 DOM / 收集 / 错误落位 / 清错链全部走真实模块），导入面板后立即
// doUnmock，不影响其他用例。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

function installMessageBus(overrides = {}) {
  const responders = {
    "get-settings": () => ({ ok: true, settings: {} }),
    "ai-presets-list": () => ({ ok: false }),
    "asr-presets-list": () => ({ ok: false }),
    "ai-providers-list": () => ({ ok: true, providers: [] }),
    "asr-providers-list": () => ({ ok: true, providers: [] }),
    "save-settings": () => ({ ok: true }),
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

// 单发 click（settings-panel-save.test.js 同款：jsdom 原生 click 已派发事件，
// 手动补派发会双触发）
function fireClick(node) {
  node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function addNoteRow(host) {
  fireClick(host.querySelector("#addNoteSectionBtn"));
  return host.querySelector("#noteSectionsList .note-section-row");
}

beforeEach(() => {
  resetModuleState();
});

describe("custom-select 键盘与错误态归位（settings-ui-coherence/04）", () => {
  it("(a) trigger Enter 展开 → ↓ 漫游 → Enter 选中：select.value 写回并派生一次 bubbling change", async () => {
    installMessageBus();
    const host = await mountPanel();
    const row = addNoteRow(host);
    const select = row.querySelector(".note-section-position");
    const trigger = row.querySelector(".note-section-field-position .custom-select-trigger");
    const dropdown = row.querySelector(".custom-select-dropdown");
    const options = Array.from(dropdown.querySelectorAll(".custom-select-option"));

    // ARIA 接线：trigger ↔ listbox 关联、角色与选中态
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger.getAttribute("aria-controls")).toBe(dropdown.id);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(dropdown.getAttribute("role")).toBe("listbox");
    expect(options.every((o) => o.getAttribute("role") === "option" && o.tabIndex === -1)).toBe(true);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(options[1].getAttribute("aria-selected")).toBe("false");

    const changeEvents = [];
    select.addEventListener("change", (e) => changeEvents.push(e));

    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(dropdown.hidden).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(options[0]); // 焦点给当前选中项

    options[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(options[1]); // 漫游不移出列表

    options[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(select.value).toBe("before_chapters");
    expect(changeEvents).toHaveLength(1);
    expect(changeEvents[0].bubbles).toBe(true);
    expect(dropdown.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger); // 焦点归位
    expect(trigger.textContent).toContain("章节前");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    expect(options[0].getAttribute("aria-selected")).toBe("false");
  });

  it("(b) 段落位置校验失败：input-error 与 focus 落在 trigger，修正后清错摘类", async () => {
    const sent = installMessageBus();
    vi.doMock("../../extension/core/validators.js", async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        validateNotePlaceholderSections: (items) =>
          items.length > 0
            ? { ok: false, row: items[0], message: "请选择有效的位置" }
            : actual.validateNotePlaceholderSections(items)
      };
    });
    const host = await mountPanel();
    vi.doUnmock("../../extension/core/validators.js");

    const row = addNoteRow(host);
    const select = row.querySelector(".note-section-position");
    const trigger = row.querySelector(".note-section-field-position .custom-select-trigger");

    // 行内前置态：标题非空（让位给 position 分支），原生 select 值漂移为非法空值
    row.querySelector(".note-section-title").value = "总结";
    select.value = "";

    fireClick(host.querySelector("#bocSettingsSaveBtn"));

    expect(trigger.classList.contains("input-error")).toBe(true);
    expect(document.activeElement).toBe(trigger);
    expect(row.querySelector(".note-section-title").classList.contains("input-error")).toBe(false);
    const errorNode = row.querySelector(".note-section-error");
    expect(errorNode.hidden).toBe(false);
    expect(errorNode.textContent).toBe("请选择有效的位置");
    expect(sent.some((message) => message.type === "save-settings")).toBe(false);

    // 修正输入即清错：组件写回值 + bubbling change → 行监听清错连带摘 trigger 类
    select.value = "before_chapters";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(trigger.classList.contains("input-error")).toBe(false);
    expect(errorNode.hidden).toBe(true);
    expect(errorNode.textContent).toBe("");
  });
});
