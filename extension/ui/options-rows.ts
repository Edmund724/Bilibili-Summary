// extension/ui/options-rows.ts
// 选项页三类行构建器（固定属性 / 笔记段落 / AI 平台）与纯验证逻辑。
// AI 平台行的构建本体由 ui/provider-row.js 的 createProviderRow 承担（与 ASR 行共用），
// 本文件只提供 AI 侧真实差异：模型字段形态、模型下拉拉取、报文形状（连通性
// 测试已改直调 ai/provider-test.js）与既有导出签名。
// 行构建器只依赖参数与回调，不直接访问 DOM 全局；验证函数不触碰 DOM。

import { PRESETS, type AiProviderPreset } from "../core/presets.js";
import {
  normalizeFixedPropertyType,
  normalizeFixedPropertyValue,
  isFixedPropertyRowEffectivelyEmpty,
  validateFixedFrontmatterProperties,
  validateNotePlaceholderSections,
  normalizeNoteSectionPosition,
  validateAiProviders,
  type FixedFrontmatterProperty,
  type NotePlaceholderSection
} from "../core/validators.js";
import { escapeHtml } from "../shared/string-utils.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { testAiProviderConnection } from "../ai/provider-test.js";
import {
  createProviderRow,
  TRASH_ICON_PATHS,
  type ProviderRowElement,
  type ProviderRowItem,
  type ProviderRowShowStatus
} from "./provider-row.js";

const MAX_NOTE_PLACEHOLDER_SECTIONS = 5;

const AI_PROVIDER_STATUS_SUCCESS_MIN_MS = 2000;

export function renderFixedPropertyRows(listNode: HTMLElement, emptyNode: HTMLElement, items: FixedFrontmatterProperty[] | null | undefined): void {
  listNode.innerHTML = "";
  const rows = Array.isArray(items) ? items : [];
  rows.forEach((item) => addFixedPropertyRow(listNode, emptyNode, item));
  updateFixedPropertyEmptyState(listNode, emptyNode);
}

export function addFixedPropertyRow(listNode: HTMLElement, emptyNode: HTMLElement, item: Partial<FixedFrontmatterProperty> = {}): void {
  const type = normalizeFixedPropertyType(item.type);
  const row = document.createElement("div");
  row.className = "fixed-property-row";
  row.innerHTML = `
    <div class="fixed-property-fields">
      <div class="fixed-property-field fixed-property-field-type">${buildFixedPropertyTypePicker(type)}</div>
      <div class="fixed-property-field fixed-property-field-key">
        <input class="fixed-property-key" type="text" placeholder="属性名" value="${escapeHtml(item.key)}" />
      </div>
      <div class="fixed-property-field fixed-property-field-value">
        <div class="fixed-property-value-slot">${buildFixedPropertyValueControl(type, item.value)}</div>
      </div>
      <div class="fixed-property-field fixed-property-field-remove">
        <button class="fixed-property-remove" type="button" aria-label="删除属性" title="删除属性">
          <svg viewBox="0 0 24 24" focusable="false">${TRASH_ICON_PATHS}</svg>
        </button>
      </div>
    </div>
    <p class="fixed-property-error" hidden></p>
  `;

  row.querySelector(".fixed-property-remove")?.addEventListener("click", () => {
    row.remove();
    updateFixedPropertyEmptyState(listNode, emptyNode);
  });

  const typeButton = row.querySelector(".fixed-property-type-button");
  const typePicker = row.querySelector(".fixed-property-type-picker") as HTMLElement | null;
  const typeMenu = row.querySelector(".fixed-property-type-menu") as HTMLElement | null;

  typeButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = typePicker?.dataset.open === "true";
    closeAllFixedPropertyMenus(listNode);
    if (typePicker && typeMenu && !isOpen) {
      typePicker.dataset.open = "true";
      typeButton.setAttribute("aria-expanded", "true");
      typeMenu.hidden = false;
    }
  });

  row.querySelectorAll(".fixed-property-type-option").forEach((option) => {
    option.addEventListener("click", () => {
      const nextType = normalizeFixedPropertyType(option.getAttribute("data-type"));
      const valueSlot = row.querySelector(".fixed-property-value-slot");
      if (typePicker) {
        typePicker.dataset.type = nextType;
        typePicker.dataset.open = "false";
      }
      if (typeButton) {
        typeButton.setAttribute("aria-expanded", "false");
        const labelNode = typeButton.querySelector(".fixed-property-type-label");
        if (labelNode) {
          labelNode.textContent = getFixedPropertyTypeLabel(nextType);
        }
      }
      if (typeMenu) {
        typeMenu.hidden = true;
      }
      const currentValue = readFixedPropertyValue(row);
      if (valueSlot) {
        valueSlot.innerHTML = buildFixedPropertyValueControl(nextType, currentValue);
        bindFixedPropertyValueEvents(row);
      }
      clearFixedPropertyErrorState(row);
    });
  });

  row.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", () => {
      input.classList.remove("input-error");
      clearFixedPropertyErrorState(row);
    });
  });
  bindFixedPropertyValueEvents(row);

  listNode.appendChild(row);
  updateFixedPropertyEmptyState(listNode, emptyNode);
}

function updateFixedPropertyEmptyState(listNode: HTMLElement, emptyNode: HTMLElement): void {
  const hasRows = listNode.children.length > 0;
  emptyNode.hidden = hasRows;
}

export function collectFixedPropertyRows(listNode: HTMLElement, { includeRow = false }: { includeRow?: boolean } = {}) {
  return Array.from(listNode.querySelectorAll<HTMLElement>(".fixed-property-row")).map((row) => {
    const type = normalizeFixedPropertyType(row.querySelector(".fixed-property-type-picker")?.getAttribute("data-type"));
    const item: {
      key: string;
      type: FixedFrontmatterProperty["type"];
      value: string;
      row?: HTMLElement;
    } = {
      key: String((row.querySelector(".fixed-property-key") as HTMLInputElement | null)?.value || "").trim(),
      type,
      value: readFixedPropertyValue(row, type)
    };
    if (includeRow) {
      item.row = row;
    }
    return item;
  });
}

export function clearFixedPropertyErrors(listNode: HTMLElement): void {
  listNode.querySelectorAll(".fixed-property-key, .fixed-property-value").forEach((input) => {
    input.classList.remove("input-error");
  });
  listNode.querySelectorAll(".fixed-property-type-button").forEach((input) => {
    input.classList.remove("input-error");
  });
  listNode.querySelectorAll<HTMLElement>(".fixed-property-error").forEach((node) => {
    node.hidden = true;
    node.textContent = "";
  });
}

export function renderNoteSectionRows(listNode: HTMLElement, emptyNode: HTMLElement, items: NotePlaceholderSection[] | null | undefined): void {
  listNode.innerHTML = "";
  const rows = Array.isArray(items) ? items : [];
  rows.forEach((item) => addNoteSectionRow(listNode, emptyNode, item, { skipLimit: true }));
  updateNoteSectionEmptyState(listNode, emptyNode);
}

export function addNoteSectionRow(listNode: HTMLElement, emptyNode: HTMLElement, item: Partial<NotePlaceholderSection> = {}, { skipLimit = false }: { skipLimit?: boolean } = {}): void {
  if (!skipLimit && listNode.children.length >= MAX_NOTE_PLACEHOLDER_SECTIONS) {
    emptyNode.hidden = false;
    emptyNode.textContent = `正文附加段落最多添加 ${MAX_NOTE_PLACEHOLDER_SECTIONS} 个`;
    return;
  }

  const position = normalizeNoteSectionPosition(item.position);
  const row = document.createElement("div");
  row.className = "note-section-row";
  row.innerHTML = `
    <div class="note-section-fields">
      <div class="note-section-field note-section-field-position">
        <select class="note-section-position" aria-label="段落位置">
          ${buildNoteSectionPositionOptions(position)}
        </select>
      </div>
      <div class="note-section-field note-section-field-title">
        <input class="note-section-title" type="text" placeholder="段落标题，例：总结" value="${escapeHtml(item.title)}" />
      </div>
      <div class="note-section-field note-section-field-content">
        <input class="note-section-content" type="text" placeholder="默认内容（可空）" value="${escapeHtml(item.content)}" />
      </div>
      <div class="note-section-field note-section-field-remove">
        <button class="note-section-remove" type="button" aria-label="删除段落" title="删除段落">
          <svg viewBox="0 0 24 24" focusable="false">${TRASH_ICON_PATHS}</svg>
        </button>
      </div>
    </div>
    <p class="note-section-error" hidden></p>
  `;

  row.querySelector(".note-section-remove")?.addEventListener("click", () => {
    row.remove();
    updateNoteSectionEmptyState(listNode, emptyNode);
  });

  row.querySelectorAll(".note-section-title, .note-section-content, .note-section-position").forEach((input) => {
    input.addEventListener("input", () => clearNoteSectionErrorState(row));
    input.addEventListener("change", () => clearNoteSectionErrorState(row));
  });

  listNode.appendChild(row);
  updateNoteSectionEmptyState(listNode, emptyNode);
}

function updateNoteSectionEmptyState(listNode: HTMLElement, emptyNode: HTMLElement): void {
  const hasRows = listNode.children.length > 0;
  emptyNode.hidden = hasRows;
}

export function collectNoteSectionRows(listNode: HTMLElement, { includeRow = false }: { includeRow?: boolean } = {}) {
  return Array.from(listNode.querySelectorAll<HTMLElement>(".note-section-row")).map((row) => {
    const item: {
      title: string;
      position: NotePlaceholderSection["position"];
      content: string;
      row?: HTMLElement;
    } = {
      title: String((row.querySelector(".note-section-title") as HTMLInputElement | null)?.value || "").trim(),
      position: normalizeNoteSectionPosition((row.querySelector(".note-section-position") as HTMLSelectElement | null)?.value),
      content: String((row.querySelector(".note-section-content") as HTMLInputElement | null)?.value || "").trim()
    };
    if (includeRow) {
      item.row = row;
    }
    return item;
  });
}

export function clearNoteSectionErrors(listNode: HTMLElement): void {
  listNode.querySelectorAll(".note-section-title, .note-section-content, .note-section-position").forEach((input) => {
    input.classList.remove("input-error");
  });
  listNode.querySelectorAll<HTMLElement>(".note-section-error").forEach((node) => {
    node.hidden = true;
    node.textContent = "";
  });
}

function buildNoteSectionPositionOptions(selectedPosition: unknown): string {
  const current = normalizeNoteSectionPosition(selectedPosition);
  const options = [
    { value: "before_intro", label: "简介前" },
    { value: "before_chapters", label: "章节前" },
    { value: "before_subtitle", label: "字幕前" }
  ];
  return options
    .map((item) => `<option value="${item.value}" ${item.value === current ? "selected" : ""}>${item.label}</option>`)
    .join("");
}

function readFixedPropertyValue(row: HTMLElement, _type = normalizeFixedPropertyType((row.querySelector(".fixed-property-type") as HTMLInputElement | null)?.value)): string {
  return String((row.querySelector(".fixed-property-value") as HTMLInputElement | null)?.value || "").trim();
}

function buildFixedPropertyValueControl(type: unknown, value: unknown): string {
  const normalizedType = normalizeFixedPropertyType(type);
  const placeholder =
    normalizedType === "number"
      ? "数字值"
      : normalizedType === "checkbox"
        ? "true / false"
        : normalizedType === "list"
          ? "多个值，用逗号分隔"
          : normalizedType === "date"
            ? "YYYY-MM-DD 或 {{upload_date}}"
          : "属性值";
  return `<input class="fixed-property-value" type="text" placeholder="${placeholder}" value="${escapeHtml(value)}" />`;
}

function buildFixedPropertyTypePicker(type: unknown): string {
  const normalizedType = normalizeFixedPropertyType(type);
  return `
    <div class="fixed-property-type-picker" data-type="${normalizedType}" data-open="false">
      <button class="fixed-property-type-button" type="button" aria-label="属性类型" aria-haspopup="true" aria-expanded="false">
        <span class="fixed-property-type-label">${getFixedPropertyTypeLabel(normalizedType)}</span>
        <svg viewBox="0 0 12 12" focusable="false" aria-hidden="true">
          <path d="M2.25 4.5 6 8.25 9.75 4.5"></path>
        </svg>
      </button>
      <div class="fixed-property-type-menu" hidden>
        <button class="fixed-property-type-option" type="button" data-type="text">文本</button>
        <button class="fixed-property-type-option" type="button" data-type="number">数字</button>
        <button class="fixed-property-type-option" type="button" data-type="checkbox">复选框</button>
        <button class="fixed-property-type-option" type="button" data-type="list">列表</button>
        <button class="fixed-property-type-option" type="button" data-type="date">日期</button>
      </div>
    </div>
  `;
}

function getFixedPropertyTypeLabel(type: unknown): string {
  const normalizedType = normalizeFixedPropertyType(type);
  if (normalizedType === "number") {
    return "数字";
  }
  if (normalizedType === "checkbox") {
    return "复选框";
  }
  if (normalizedType === "list") {
    return "列表";
  }
  if (normalizedType === "date") {
    return "日期";
  }
  return "文本";
}

function bindFixedPropertyValueEvents(row: HTMLElement): void {
  row.querySelectorAll(".fixed-property-value").forEach((input) => {
    input.addEventListener("input", () => clearFixedPropertyErrorState(row));
    input.addEventListener("change", () => clearFixedPropertyErrorState(row));
  });
}

function clearFixedPropertyErrorState(row: HTMLElement): void {
  row.querySelectorAll(".fixed-property-key, .fixed-property-value, .fixed-property-type-button").forEach((input) => {
    input.classList.remove("input-error");
  });
  const errorNode = row.querySelector(".fixed-property-error") as HTMLElement | null;
  if (errorNode) {
    errorNode.hidden = true;
    errorNode.textContent = "";
  }
}

function clearNoteSectionErrorState(row: HTMLElement): void {
  row.querySelectorAll(".note-section-title, .note-section-content, .note-section-position").forEach((input) => {
    input.classList.remove("input-error");
  });
  const errorNode = row.querySelector(".note-section-error") as HTMLElement | null;
  if (errorNode) {
    errorNode.hidden = true;
    errorNode.textContent = "";
  }
}

function closeAllFixedPropertyMenus(listNode: HTMLElement): void {
  listNode.querySelectorAll(".fixed-property-type-picker").forEach((picker) => {
    picker.setAttribute("data-open", "false");
    const button = picker.querySelector(".fixed-property-type-button");
    const menu = picker.querySelector(".fixed-property-type-menu") as HTMLElement | null;
    if (button) {
      button.setAttribute("aria-expanded", "false");
    }
    if (menu) {
      menu.hidden = true;
    }
  });
}

// ===== AI 模型平台 =====
// 行构建本体由 ui/provider-row.js 的 createProviderRow 承担（与 ASR 行共用），
// 此处只提供 AI 侧差异：模型字段固定为文本输入 + 下拉拉取按钮、Key 占位符
// 随 requiresKey 变化、CRUD 报文走 ai-providers-*（连通性测试直调探针模块）。导出签名保持不变。

const aiProviderRow = createProviderRow({
  rowClass: "ai-provider-row",
  presetClass: "ai-provider-preset",
  presetSelectTitle: "平台",
  baseUrlClass: "ai-provider-baseurl",
  baseUrlPlaceholder: "baseUrl（如 https://api.openai.com/v1）",
  apikeyClass: "ai-provider-apikey",
  modelClass: "ai-provider-model",
  testClass: "ai-provider-test",
  removeClass: "ai-provider-remove",
  statusClass: "ai-provider-status",
  idPrefix: "p_",
  statusSuccessMinMs: AI_PROVIDER_STATUS_SUCCESS_MIN_MS,
  statusTimerKey: "_aiProviderStatusTimer",
  resolvePreset: (presets, presetId) => presets.find((p) => p.id === presetId) || presets[presets.length - 1],
  resolveModel: (item) => String(item.model || ""),
  apiKeyPlaceholder: ({ item, preset, hasSavedKey }) => {
    const requiresKey = item.requiresKey !== false && preset?.requiresKey !== false;
    return hasSavedKey ? "已保存" : (requiresKey ? "API Key" : "API Key（可选）");
  },
  buildModelField: (preset, model) => `
    <div class="ai-provider-model-wrapper">
      <input class="ai-provider-model" type="text" placeholder="模型名（如 gpt-4o-mini）" value="${escapeHtml(model)}" />
      <button type="button" class="ai-provider-model-toggle" title="从 baseUrl 拉取可用模型" aria-label="从 baseUrl 拉取可用模型">
        <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
          <path d="M6 9l6 6 6-6"></path>
        </svg>
      </button>
      <ul class="ai-provider-model-dropdown" hidden></ul>
    </div>`,
  onPresetChange: (row, _previousPreset, next) => {
    // AI 行不清空已输 Key，只随新预设更新占位符（可选 Key 平台提示"（可选）"）
    const apikeyInput = row.querySelector(".ai-provider-apikey") as HTMLInputElement;
    apikeyInput.placeholder = row.dataset.hasSavedKey === "1"
      ? "已保存"
      : (next.requiresKey ? "API Key" : "API Key（可选）");
  },
  wireRowExtras: wireAiModelControls,
  // 连通性测试直调 ai/provider-test.js（不再走 ai-providers-test 消息往返）：
  // options 页同属扩展 context，host_permissions 生效，跨域 fetch 无需 SW 中转；
  // Key 代查（重输优先、否则按 providerId 读已存 Key）收口在探针入口内。
  runTestProbe: ({ row, baseUrl, apiKey, model }) =>
    testAiProviderConnection({
      providerId: row.dataset.providerId || "",
      baseUrl,
      apiKey,
      model
    }),
  buildDeleteMessage: (providerId) => ({ type: "ai-providers-delete", providerId })
});

// 模型下拉交互（AI 专属，经 wireRowExtras 接入工厂）：点击 toggle 从 baseUrl
// 拉取可用模型列表，选中写回输入框；手输模型或选中选项时收起下拉。
function wireAiModelControls(row: ProviderRowElement, { showStatus }: { showStatus: ProviderRowShowStatus }): void {
  row.querySelector(".ai-provider-model-toggle")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    const statusNode = row.querySelector(".ai-provider-status") as HTMLElement | null;
    const baseUrl = (row.querySelector(".ai-provider-baseurl") as HTMLInputElement).value.trim();
    const apiKey = (row.querySelector(".ai-provider-apikey") as HTMLInputElement).value.trim();
    const modelInput = row.querySelector(".ai-provider-model") as HTMLInputElement;
    const dropdown = row.querySelector(".ai-provider-model-dropdown") as HTMLElement;

    if (!baseUrl) {
      showStatus(statusNode, "请先填写 baseUrl", true);
      return;
    }

    const isAlreadyOpen = !dropdown.hidden;
    closeAllModelDropdowns();

    if (isAlreadyOpen) {
      return;
    }

    modelInput.classList.remove("input-error");
    if (statusNode) {
      statusNode.textContent = "";
      statusNode.hidden = true;
    }

    dropdown.innerHTML = "";
    dropdown.hidden = false;
    const loadingLi = document.createElement("li");
    loadingLi.className = "ai-provider-model-option ai-provider-model-loading";
    loadingLi.textContent = "正在拉取模型列表...";
    dropdown.appendChild(loadingLi);

    try {
      const resp = (await sendRuntimeMessage({
        type: "ai-providers-models",
        baseUrl,
        apiKey,
        providerId: row.dataset.providerId || ""
      })) as { ok?: boolean; models?: string[]; error?: string } | null;

      dropdown.innerHTML = "";
      if (resp?.ok && Array.isArray(resp.models) && resp.models.length > 0) {
        const currentModel = modelInput.value.trim();
        resp.models.forEach((modelId) => {
          const li = document.createElement("li");
          li.className = "ai-provider-model-option";
          li.dataset.model = modelId;
          li.textContent = modelId;
          if (modelId === currentModel) {
            li.dataset.selected = "true";
          }
          dropdown.appendChild(li);
        });
        const countLi = document.createElement("li");
        countLi.className = "ai-provider-model-count";
        countLi.textContent = `已加载 ${resp.models.length} 个模型`;
        dropdown.appendChild(countLi);
      } else if (resp?.ok) {
        const li = document.createElement("li");
        li.className = "ai-provider-model-message";
        li.textContent = "未找到可用模型";
        dropdown.appendChild(li);
      } else {
        const li = document.createElement("li");
        li.className = "ai-provider-model-message ai-provider-model-error";
        li.textContent = resp?.error || "拉取失败";
        dropdown.appendChild(li);
      }


    } catch (error) {
      dropdown.innerHTML = "";
      const li = document.createElement("li");
      li.className = "ai-provider-model-message ai-provider-model-error";
      const message = (error as Error).message;
      if (message && message.includes("port closed")) {
        li.textContent = "连接中断，请重试";
      } else {
        li.textContent = message || "拉取失败";
      }
      dropdown.appendChild(li);
    }
  });

  row.querySelector(".ai-provider-model")?.addEventListener("input", () => {
    const dropdown = row.querySelector(".ai-provider-model-dropdown") as HTMLElement | null;
    if (dropdown) dropdown.hidden = true;
  });

  row.querySelector(".ai-provider-model-dropdown")?.addEventListener("click", (e) => {
    const option = (e.target as HTMLElement).closest(".ai-provider-model-option") as HTMLElement | null;
    if (!option) return;
    e.stopPropagation();
    const modelInput = row.querySelector(".ai-provider-model");
    if (modelInput && option.dataset.model) {
      (modelInput as HTMLInputElement).value = option.dataset.model;
    }
    if (modelInput) modelInput.classList.remove("input-error");
    const dropdown = row.querySelector(".ai-provider-model-dropdown") as HTMLElement | null;
    if (dropdown) dropdown.hidden = true;
  });
}

function closeAllModelDropdowns(): void {
  document.querySelectorAll<HTMLElement>(".ai-provider-model-dropdown").forEach((dropdown) => {
    dropdown.hidden = true;
  });
}

export function renderAiProviders(
  listNode: HTMLElement,
  emptyNode: HTMLElement,
  items: ProviderRowItem[] | null | undefined,
  { presets = PRESETS }: {
    presets?: readonly AiProviderPreset[];
  } = {}
): void {
  aiProviderRow.render(listNode, emptyNode, items, { presets });
}

export function addAiProviderRow(listNode: HTMLElement, emptyNode: HTMLElement, item: ProviderRowItem = {}, { presets = PRESETS }: { presets?: readonly AiProviderPreset[] } = {}): void {
  aiProviderRow.add(listNode, emptyNode, item, { presets });
}

export function collectAiProviders(listNode: HTMLElement, { presets = PRESETS, generateId = aiProviderRow.generateId }: { presets?: readonly AiProviderPreset[]; generateId?: () => string } = {}) {
  return Array.from(listNode.querySelectorAll<HTMLElement>(".ai-provider-row")).map((row) => {
    const presetSelect = row.querySelector(".ai-provider-preset") as HTMLSelectElement;
    const preset = presets.find((p) => p.id === presetSelect.value) || presets[presets.length - 1];
    const apiKey = (row.querySelector(".ai-provider-apikey") as HTMLInputElement).value.trim();
    const baseUrl = (row.querySelector(".ai-provider-baseurl") as HTMLInputElement).value.trim().replace(/\/+$/, "");
    return {
      id: row.dataset.providerId || generateId(),
      presetId: preset.id,
      name: preset.name,
      baseUrl,
      model: (row.querySelector(".ai-provider-model") as HTMLInputElement).value.trim(),
      requiresKey: preset.requiresKey,
      enabled: true,
      apiKey,
      hasSavedKey: row.dataset.hasSavedKey === "1"
    };
  });
}

// 测试成功后回调：重新保存设置并返回新渲染的行（由 options.js 注入，避免行构建器耦合保存流程）
export function setTestSuccessHandler(handler: Parameters<typeof aiProviderRow.setTestSuccessHandler>[0]): void {
  aiProviderRow.setTestSuccessHandler(handler);
}

// 删除动作前先执行的钩子（回收 host 权限），由 options.js 注入
export function setAiBeforeDeleteHandler(handler: Parameters<typeof aiProviderRow.setBeforeDeleteHandler>[0]): void {
  aiProviderRow.setBeforeDeleteHandler(handler);
}
