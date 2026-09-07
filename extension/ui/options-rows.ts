// extension/ui/options-rows.ts
// 选项页三类行构建器（固定属性 / 笔记段落 / AI 平台）与纯验证逻辑。
// AI 平台行的构建本体由 ui/provider-row.js 的 createProviderRow 承担（与 ASR 行
// 共用，provider-master-detail/02 起为紧凑形态：行是纯展示 + 编辑/删除入口，
// 编辑字段与连通性测试全部在 ui/provider-editor.js 的 Modal 里，保存走单平台
// upsert）。本文件只提供 AI 侧真实差异：显示名/模型名解析与既有导出签名。
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
import { initCustomSelect } from "./custom-select.js";
import {
  createProviderRow,
  TRASH_ICON_PATHS,
  type ProviderRowItem
} from "./provider-row.js";

const MAX_NOTE_PLACEHOLDER_SECTIONS = 5;

// 行「编辑」按钮回调（provider-master-detail/01）：由 settings-panel 注入
// （打开 provider-editor Modal 并现查权威列表项），本模块只转发 providerId。
let onAiRowEdit: (providerId: string) => void = () => {};

export function setAiRowEditHandler(handler: (providerId: string) => void): void {
  onAiRowEdit = handler;
}

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

  // 段落位置换自定义下拉（ADR-0007）：三条重渲来路（loadSettings / 保存成功
  // 回填 / + 添加段落）全部经本函数，在此一处接线；值仍落在原生 select，
  // 收集链零改。幂等守卫保证重渲不会重复接管。
  const positionSelect = row.querySelector<HTMLSelectElement>(".note-section-position");
  if (positionSelect) {
    initCustomSelect(positionSelect, "custom-select-wrapper");
  }

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
  // 段落位置的 input-error 落在组件 trigger 上（Q22 甲），清错连带摘除
  listNode.querySelectorAll<HTMLElement>(".note-section-row .custom-select-trigger").forEach((trigger) => {
    trigger.classList.remove("input-error");
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
  // 段落位置的 input-error 落在组件 trigger 上（Q22 甲），清错连带摘除
  row.querySelectorAll<HTMLElement>(".custom-select-trigger").forEach((trigger) => {
    trigger.classList.remove("input-error");
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

// ===== AI 模型平台（紧凑行，provider-master-detail/02） =====
// 行构建本体由 ui/provider-row.js 的 createProviderRow 承担（与 ASR 行共用），
// 此处只提供 AI 侧差异：显示名（自定义名回落预设名，拍板 Q7）/ 模型名解析 /
// 删除报文。编辑、连通性测试、模型目录拉取全在 ui/provider-editor.js 的 Modal。

const aiProviderRow = createProviderRow({
  rowClass: "ai-provider-row",
  editClass: "provider-row-edit",
  removeClass: "provider-row-remove",
  idPrefix: "p_",
  resolvePreset: (presets, presetId) => presets.find((p) => p.id === presetId) || presets[presets.length - 1],
  displayName: (item, preset) => String(item.name || preset?.name || "自定义"),
  displayModel: (item) => String(item.model || ""),
  onRowEdit: (row) => onAiRowEdit(row.dataset.providerId || ""),
  buildDeleteMessage: (providerId) => ({ type: "ai-providers-delete", providerId })
});

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

// 新平台 id 生成（provider-master-detail/01：provider-editor Modal 保存新增时
// 由 settings-panel.saveProviderSingle 调用，沿用平铺行的 id 格式 p_*）
export function generateAiProviderId(): string {
  return aiProviderRow.generateId();
}

// 删除动作前先执行的钩子（回收 host 权限），由 options.js 注入
export function setAiBeforeDeleteHandler(handler: Parameters<typeof aiProviderRow.setBeforeDeleteHandler>[0]): void {
  aiProviderRow.setBeforeDeleteHandler(handler);
}
