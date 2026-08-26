// extension/ui/options-rows.js
// 选项页三类行构建器（固定属性 / 笔记段落 / AI 平台）与纯验证逻辑。
// 行构建器只依赖参数与回调，不直接访问 DOM 全局；验证函数不触碰 DOM。

import {
  PRESETS,
  normalizeFixedPropertyType,
  normalizeFixedPropertyValue,
  isFixedPropertyRowEffectivelyEmpty,
  validateFixedFrontmatterProperties,
  validateNotePlaceholderSections,
  normalizeNoteSectionPosition,
  validateAiProviders
} from "../core/shared-defaults.js";
import { escapeHtml } from "../shared/string-utils.js";
import { sendRuntimeMessage } from "../core/runtime.js";

const MAX_NOTE_PLACEHOLDER_SECTIONS = 5;

const AI_PROVIDER_STATUS_SUCCESS_MIN_MS = 2000;

export function renderFixedPropertyRows(listNode, emptyNode, items) {
  listNode.innerHTML = "";
  const rows = Array.isArray(items) ? items : [];
  rows.forEach((item) => addFixedPropertyRow(listNode, emptyNode, item));
  updateFixedPropertyEmptyState(listNode, emptyNode);
}

export function addFixedPropertyRow(listNode, emptyNode, item = {}) {
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
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M4 7h16"></path>
            <path d="M9 3h6"></path>
            <path d="M10 11v6"></path>
            <path d="M14 11v6"></path>
            <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>
          </svg>
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
  const typePicker = row.querySelector(".fixed-property-type-picker");
  const typeMenu = row.querySelector(".fixed-property-type-menu");

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

function updateFixedPropertyEmptyState(listNode, emptyNode) {
  const hasRows = listNode.children.length > 0;
  emptyNode.hidden = hasRows;
}

export function collectFixedPropertyRows(listNode, { includeRow = false } = {}) {
  return Array.from(listNode.querySelectorAll(".fixed-property-row")).map((row) => {
    const type = normalizeFixedPropertyType(row.querySelector(".fixed-property-type-picker")?.getAttribute("data-type"));
    const item = {
      key: String(row.querySelector(".fixed-property-key")?.value || "").trim(),
      type,
      value: readFixedPropertyValue(row, type)
    };
    if (includeRow) {
      item.row = row;
    }
    return item;
  });
}

export function clearFixedPropertyErrors(listNode) {
  listNode.querySelectorAll(".fixed-property-key, .fixed-property-value").forEach((input) => {
    input.classList.remove("input-error");
  });
  listNode.querySelectorAll(".fixed-property-type-button").forEach((input) => {
    input.classList.remove("input-error");
  });
  listNode.querySelectorAll(".fixed-property-error").forEach((node) => {
    node.hidden = true;
    node.textContent = "";
  });
}

export function renderNoteSectionRows(listNode, emptyNode, items) {
  listNode.innerHTML = "";
  const rows = Array.isArray(items) ? items : [];
  rows.forEach((item) => addNoteSectionRow(listNode, emptyNode, item, { skipLimit: true }));
  updateNoteSectionEmptyState(listNode, emptyNode);
}

export function addNoteSectionRow(listNode, emptyNode, item = {}, { skipLimit = false } = {}) {
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
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M4 7h16"></path>
            <path d="M9 3h6"></path>
            <path d="M10 11v6"></path>
            <path d="M14 11v6"></path>
            <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>
          </svg>
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

function updateNoteSectionEmptyState(listNode, emptyNode) {
  const hasRows = listNode.children.length > 0;
  emptyNode.hidden = hasRows;
}

export function collectNoteSectionRows(listNode, { includeRow = false } = {}) {
  return Array.from(listNode.querySelectorAll(".note-section-row")).map((row) => {
    const item = {
      title: String(row.querySelector(".note-section-title")?.value || "").trim(),
      position: normalizeNoteSectionPosition(row.querySelector(".note-section-position")?.value),
      content: String(row.querySelector(".note-section-content")?.value || "").trim()
    };
    if (includeRow) {
      item.row = row;
    }
    return item;
  });
}

export function clearNoteSectionErrors(listNode) {
  listNode.querySelectorAll(".note-section-title, .note-section-content, .note-section-position").forEach((input) => {
    input.classList.remove("input-error");
  });
  listNode.querySelectorAll(".note-section-error").forEach((node) => {
    node.hidden = true;
    node.textContent = "";
  });
}

function buildNoteSectionPositionOptions(selectedPosition) {
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

function containsFrontmatterTemplateToken(value) {
  return FRONTMATTER_TEMPLATE_TOKEN_RE.test(String(value || "").trim());
}

function readFixedPropertyValue(row, _type = normalizeFixedPropertyType(row.querySelector(".fixed-property-type")?.value)) {
  return String(row.querySelector(".fixed-property-value")?.value || "").trim();
}

function buildFixedPropertyValueControl(type, value) {
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

function buildFixedPropertyTypePicker(type) {
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

function getFixedPropertyTypeLabel(type) {
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

function bindFixedPropertyValueEvents(row) {
  row.querySelectorAll(".fixed-property-value").forEach((input) => {
    input.addEventListener("input", () => clearFixedPropertyErrorState(row));
    input.addEventListener("change", () => clearFixedPropertyErrorState(row));
  });
}

function clearFixedPropertyErrorState(row) {
  row.querySelectorAll(".fixed-property-key, .fixed-property-value, .fixed-property-type-button").forEach((input) => {
    input.classList.remove("input-error");
  });
  const errorNode = row.querySelector(".fixed-property-error");
  if (errorNode) {
    errorNode.hidden = true;
    errorNode.textContent = "";
  }
}

function clearNoteSectionErrorState(row) {
  row.querySelectorAll(".note-section-title, .note-section-content, .note-section-position").forEach((input) => {
    input.classList.remove("input-error");
  });
  const errorNode = row.querySelector(".note-section-error");
  if (errorNode) {
    errorNode.hidden = true;
    errorNode.textContent = "";
  }
}

function closeAllFixedPropertyMenus(listNode) {
  listNode.querySelectorAll(".fixed-property-type-picker").forEach((picker) => {
    picker.setAttribute("data-open", "false");
    const button = picker.querySelector(".fixed-property-type-button");
    const menu = picker.querySelector(".fixed-property-type-menu");
    if (button) {
      button.setAttribute("aria-expanded", "false");
    }
    if (menu) {
      menu.hidden = true;
    }
  });
}

// ===== AI 模型平台 =====

export function renderAiProviders(listNode, emptyNode, items, { presets = PRESETS, defaultModel = "", onRenderDefaultModel = null } = {}) {
  listNode.innerHTML = "";
  const list = Array.isArray(items) ? items : [];
  list.forEach((item) => addAiProviderRow(listNode, emptyNode, item, { presets }));
  updateAiProvidersEmptyState(listNode, emptyNode);
  if (onRenderDefaultModel) {
    onRenderDefaultModel(list);
  }
}

function updateAiProvidersEmptyState(listNode, emptyNode) {
  const hasRows = listNode.children.length > 0;
  emptyNode.hidden = hasRows;
}

export function renderDefaultModelSelect(selectNode, items, defaultModel = "") {
  const list = Array.isArray(items) ? items : [];
  selectNode.innerHTML = '<option value="">未设置</option>' + list
    .map((item) => {
      const label = String(item.model || item.name || "").trim();
      return `<option value="${escapeHtml(item.id)}">${escapeHtml(label)}</option>`;
    })
    .join("");
  if (defaultModel && list.some((item) => item.id === defaultModel)) {
    selectNode.value = defaultModel;
  } else {
    selectNode.value = "";
  }
}

function generateAiProviderId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function addAiProviderRow(listNode, emptyNode, item = {}, { presets = PRESETS } = {}) {
  const id = String(item.id || generateAiProviderId());
  const presetId = String(item.presetId || "custom");
  const preset = presets.find((p) => p.id === presetId) || presets[presets.length - 1];
  const baseUrl = String(item.baseUrl ?? preset.baseUrl ?? "");
  const model = String(item.model || "");
  const requiresKey = item.requiresKey !== false && preset.requiresKey !== false;
  const hasSavedKey = Boolean(item.hasSavedKey);

  const row = document.createElement("div");
  row.className = "ai-provider-row";
  row.dataset.providerId = id;
  row.dataset.hasSavedKey = hasSavedKey ? "1" : "0";
  row.dataset.currentPresetId = presetId;
  row.innerHTML = `
    <select class="ai-provider-preset" title="平台">
      ${presets.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === presetId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
    </select>
    <input class="ai-provider-baseurl" type="text" placeholder="baseUrl（如 https://api.openai.com/v1）" value="${escapeHtml(baseUrl)}" />
    <input class="ai-provider-apikey" type="password" placeholder="${hasSavedKey ? "已保存" : (requiresKey ? "API Key" : "API Key（可选）")}" autocomplete="off" />
    <div class="ai-provider-model-wrapper">
      <input class="ai-provider-model" type="text" placeholder="模型名（如 gpt-4o-mini）" value="${escapeHtml(model)}" />
      <button type="button" class="ai-provider-model-toggle" title="从 baseUrl 拉取可用模型" aria-label="从 baseUrl 拉取可用模型">
        <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
          <path d="M6 9l6 6 6-6"></path>
        </svg>
      </button>
      <ul class="ai-provider-model-dropdown" hidden></ul>
    </div>
    <button type="button" class="secondary-btn ai-provider-test">测试</button>
    <button type="button" class="ai-provider-remove" aria-label="删除" title="删除">
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <path d="M4 7h16"></path>
        <path d="M9 3h6"></path>
        <path d="M10 11v6"></path>
        <path d="M14 11v6"></path>
        <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>
      </svg>
    </button>
    <p class="ai-provider-status" hidden></p>
  `;

  row.querySelector(".ai-provider-preset").addEventListener("change", (e) => {
    const previousPreset = presets.find((p) => p.id === row.dataset.currentPresetId) || null;
    const next = presets.find((p) => p.id === e.target.value);
    if (!next) return;
    const baseUrlInput = row.querySelector(".ai-provider-baseurl");
    const currentBaseUrl = baseUrlInput.value.trim();
    if (!currentBaseUrl || (previousPreset && currentBaseUrl === previousPreset.baseUrl)) {
      baseUrlInput.value = next.baseUrl;
    }
    const apikeyInput = row.querySelector(".ai-provider-apikey");
    apikeyInput.placeholder = row.dataset.hasSavedKey === "1"
      ? "已保存"
      : (next.requiresKey ? "API Key" : "API Key（可选）");
    row.dataset.currentPresetId = next.id;
  });

  row.querySelector(".ai-provider-remove")?.addEventListener("click", async () => {
    if (!confirm("确定要删除这个平台吗？")) return;
    if (row.dataset.providerId) {
      try {
        await sendRuntimeMessage({ type: "ai-providers-delete", providerId: row.dataset.providerId });
      } catch {}
    }
    row.remove();
    updateAiProvidersEmptyState(listNode, emptyNode);
  });

  row.querySelector(".ai-provider-test")?.addEventListener("click", async () => {
    const statusNode = row.querySelector(".ai-provider-status");
    const baseUrl = row.querySelector(".ai-provider-baseurl").value.trim();
    const apiKey = row.querySelector(".ai-provider-apikey").value.trim();
    const model = row.querySelector(".ai-provider-model").value.trim();
    if (!baseUrl) {
      showAiProviderStatus(statusNode, "请填写 baseUrl", true);
      return;
    }
    if (!model) {
      showAiProviderStatus(statusNode, "请填写模型名", true);
      return;
    }
    showAiProviderStatus(statusNode, "正在测试...");
    const resp = await sendRuntimeMessage({
      type: "ai-providers-test",
      providerId: row.dataset.providerId || "",
      baseUrl,
      apiKey,
      model
    });
    if (resp?.ok) {
      const providerId = row.dataset.providerId || "";
      try {
        await onTestSuccess(providerId);
        const newRow = listNode.querySelector(`.ai-provider-row[data-provider-id="${CSS.escape(providerId)}"]`);
        const newStatusNode = newRow?.querySelector(".ai-provider-status");
        showAiProviderStatus(newStatusNode, "连接成功");
      } catch (error) {
        showAiProviderStatus(statusNode, `连接成功，但保存失败：${error.message || "未知错误"}`, true);
      }
    } else {
      showAiProviderStatus(statusNode, `失败：${resp?.error || "未知错误"}`, true);
    }
  });

  row.querySelector(".ai-provider-model-toggle")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    const statusNode = row.querySelector(".ai-provider-status");
    const baseUrl = row.querySelector(".ai-provider-baseurl").value.trim();
    const apiKey = row.querySelector(".ai-provider-apikey").value.trim();
    const modelInput = row.querySelector(".ai-provider-model");
    const dropdown = row.querySelector(".ai-provider-model-dropdown");

    if (!baseUrl) {
      showAiProviderStatus(statusNode, "请先填写 baseUrl", true);
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
      const resp = await sendRuntimeMessage({
        type: "ai-providers-models",
        baseUrl,
        apiKey,
        providerId: row.dataset.providerId || ""
      });

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
      if (error.message && error.message.includes("port closed")) {
        li.textContent = "连接中断，请重试";
      } else {
        li.textContent = error.message || "拉取失败";
      }
      dropdown.appendChild(li);
    }
  });

  row.querySelector(".ai-provider-model")?.addEventListener("input", () => {
    const dropdown = row.querySelector(".ai-provider-model-dropdown");
    if (dropdown) dropdown.hidden = true;
  });

  row.querySelector(".ai-provider-model-dropdown")?.addEventListener("click", (e) => {
    const option = e.target.closest(".ai-provider-model-option");
    if (!option) return;
    e.stopPropagation();
    const modelInput = row.querySelector(".ai-provider-model");
    if (modelInput && option.dataset.model) {
      modelInput.value = option.dataset.model;
    }
    if (modelInput) modelInput.classList.remove("input-error");
    const dropdown = row.querySelector(".ai-provider-model-dropdown");
    if (dropdown) dropdown.hidden = true;
  });

  listNode.appendChild(row);
  updateAiProvidersEmptyState(listNode, emptyNode);
}

export function collectAiProviders(listNode, { presets = PRESETS, generateId = generateAiProviderId } = {}) {
  return Array.from(listNode.querySelectorAll(".ai-provider-row")).map((row) => {
    const presetSelect = row.querySelector(".ai-provider-preset");
    const preset = presets.find((p) => p.id === presetSelect.value) || presets[presets.length - 1];
    const apiKey = row.querySelector(".ai-provider-apikey").value.trim();
    const baseUrl = row.querySelector(".ai-provider-baseurl").value.trim().replace(/\/+$/, "");
    return {
      id: row.dataset.providerId || generateId(),
      presetId: preset.id,
      name: preset.name,
      baseUrl,
      model: row.querySelector(".ai-provider-model").value.trim(),
      requiresKey: preset.requiresKey,
      enabled: true,
      apiKey,
      hasSavedKey: row.dataset.hasSavedKey === "1"
    };
  });
}

function showAiProviderStatus(node, text, isError = false) {
  if (!node) return;
  node.hidden = false;
  node.textContent = text;
  node.dataset.error = isError ? "true" : "false";

  if (!isError && AI_PROVIDER_STATUS_SUCCESS_MIN_MS > 0) {
    const row = node.closest(".ai-provider-row");
    if (!row) return;

    if (row._aiProviderStatusTimer) clearTimeout(row._aiProviderStatusTimer);

    const inputs = row.querySelectorAll("input, button");
    const previouslyDisabled = Array.from(inputs).map((el) => el.disabled);
    inputs.forEach((el) => (el.disabled = true));

    row._aiProviderStatusTimer = setTimeout(() => {
      row._aiProviderStatusTimer = null;
      inputs.forEach((el, index) => {
        if (previouslyDisabled[index] !== undefined) el.disabled = previouslyDisabled[index];
      });
    }, AI_PROVIDER_STATUS_SUCCESS_MIN_MS);
  }
}

function closeAllModelDropdowns() {
  document.querySelectorAll(".ai-provider-model-dropdown").forEach((dropdown) => {
    dropdown.hidden = true;
  });
}

// 测试成功后回调：重新保存设置并返回新渲染的行（由 options.js 注入，避免行构建器耦合保存流程）
let onTestSuccess = async () => {};

export function setTestSuccessHandler(handler) {
  onTestSuccess = handler;
}
