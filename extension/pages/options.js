import {
  DEFAULT_SETTINGS,
  DEFAULT_INITIAL_QUICK_PROMPTS,
  PRESETS,
  ASR_PROVIDER_PRESETS,
  normalizeDownloadFormat,
  normalizePlayerAiQuickPrompt,
  normalizeFixedFrontmatterProperties,
  normalizeNotePlaceholderSections,
  validateFixedFrontmatterProperties,
  validateNotePlaceholderSections,
  validateAiProviders
} from "../core/shared-defaults.js";
import { sendRuntimeMessage } from "../core/runtime.js";
import {
  renderFixedPropertyRows,
  addFixedPropertyRow,
  collectFixedPropertyRows,
  clearFixedPropertyErrors,
  renderNoteSectionRows,
  addNoteSectionRow,
  collectNoteSectionRows,
  clearNoteSectionErrors,
  renderAiProviders,
  renderDefaultModelSelect,
  addAiProviderRow,
  collectAiProviders,
  setTestSuccessHandler
} from "../ui/options-rows.js";
import {
  renderAsrProviders,
  addAsrProviderRow,
  collectAsrProviders,
  setActiveAsrProvider,
  getActiveAsrProviderId,
  setAsrTestSuccessHandler,
  setAsrDeleteHandler
} from "../ui/options-asr-rows.js";

const NOTE_SECTION_POSITIONS = new Set(["before_intro", "before_chapters", "before_subtitle"]);

let aiPresets = [];
let asrPresets = [];

async function loadAiPresets() {
  try {
    const resp = await sendRuntimeMessage({ type: "ai-presets-list" });
    if (resp?.ok && Array.isArray(resp.presets)) {
      aiPresets = resp.presets;
      return;
    }
  } catch {
    // fallback to built-in list when background is unreachable
  }

  aiPresets = PRESETS.slice();
}

async function loadAsrPresets() {
  try {
    const resp = await sendRuntimeMessage({ type: "asr-presets-list" });
    if (resp?.ok && Array.isArray(resp.presets)) {
      asrPresets = resp.presets;
      return;
    }
  } catch {
    // fallback to built-in list when background is unreachable
  }

  asrPresets = ASR_PROVIDER_PRESETS.slice();
}

const elements = {
  tags: document.getElementById("tags"),
  downloadFormat: document.getElementById("downloadFormat"),
  includeDateInFilename: document.getElementById("includeDateInFilename"),
  includeHotCommentsInNote: document.getElementById("includeHotCommentsInNote"),
  enablePlayerAiQuickAction: document.getElementById("enablePlayerAiQuickAction"),
  playerAiQuickPrompt: document.getElementById("playerAiQuickPrompt"),
  includeTimestampInBody: document.getElementById("includeTimestampInBody"),
  enableDebugLogs: document.getElementById("enableDebugLogs"),
  frontmatterFields: document.querySelectorAll('input[name="frontmatterField"]'),
  fixedPropertiesList: document.getElementById("fixedPropertiesList"),
  fixedPropertiesEmpty: document.getElementById("fixedPropertiesEmpty"),
  addFixedPropertyBtn: document.getElementById("addFixedPropertyBtn"),
  noteSectionsList: document.getElementById("noteSectionsList"),
  noteSectionsEmpty: document.getElementById("noteSectionsEmpty"),
  addNoteSectionBtn: document.getElementById("addNoteSectionBtn"),
  aiProvidersList: document.getElementById("aiProvidersList"),
  aiProvidersEmpty: document.getElementById("aiProvidersEmpty"),
  addAiProviderBtn: document.getElementById("addAiProviderBtn"),
  defaultModel: document.getElementById("defaultModel"),
  asrProvidersList: document.getElementById("asrProvidersList"),
  asrProvidersEmpty: document.getElementById("asrProvidersEmpty"),
  addAsrProviderBtn: document.getElementById("addAsrProviderBtn"),
  asrAutoFallback: document.getElementById("asrAutoFallback"),
  aiSystemPrompt: document.getElementById("aiSystemPrompt"),
  aiInitialQuickPrompts: document.querySelectorAll(".ai-initial-quick-prompt"),
  saveBtn: document.getElementById("saveBtn"),
  status: document.getElementById("status")
};

let savedAiPresetPrompts = [];

init();

async function init() {
  await loadAiPresets();
  await loadAsrPresets();
  setTestSuccessHandler(async (providerId) => {
    await saveSettings();
    return providerId;
  });
  setAsrTestSuccessHandler(async () => {
    await saveSettings();
  });
  setAsrDeleteHandler(async (providerId) => {
    if (providerId && String(getActiveAsrProviderId(elements.asrProvidersList) || "") === providerId) {
      await sendRuntimeMessage({ type: "save-settings", settings: { activeAsrProviderId: "" } });
    }
  });
  loadSettings();
  elements.saveBtn.addEventListener("click", saveSettings);
  elements.addFixedPropertyBtn.addEventListener("click", () => addFixedPropertyRow(elements.fixedPropertiesList, elements.fixedPropertiesEmpty));
  elements.addNoteSectionBtn.addEventListener("click", () => addNoteSectionRow(elements.noteSectionsList, elements.noteSectionsEmpty));
  elements.addAiProviderBtn.addEventListener("click", () => addAiProviderRow(elements.aiProvidersList, elements.aiProvidersEmpty, {}, { presets: aiPresets }));
  elements.addAsrProviderBtn.addEventListener("click", () => addAsrProviderRow(elements.asrProvidersList, elements.asrProvidersEmpty, {}, { presets: asrPresets }));
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest(".fixed-property-type-picker")) {
      elements.fixedPropertiesList.querySelectorAll(".fixed-property-type-picker").forEach((picker) => {
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
    if (!(event.target instanceof Element) || !event.target.closest(".ai-provider-model-wrapper")) {
      document.querySelectorAll(".ai-provider-model-dropdown").forEach((dropdown) => {
        dropdown.hidden = true;
      });
    }
  });
  [elements.tags].forEach((input) => {
    input?.addEventListener("input", () => input.classList.remove("input-error"));
  });
  elements.defaultModel?.addEventListener("change", async () => {
    const defaultModel = String(elements.defaultModel?.value || "").trim();
    await sendRuntimeMessage({ type: "save-settings", settings: { defaultModel } });
    const providers = await loadAiProviders();
    renderAiProviders(elements.aiProvidersList, elements.aiProvidersEmpty, providers, { defaultModel, onRenderDefaultModel: (list) => renderDefaultModelSelect(elements.defaultModel, list, defaultModel) });
  });
  // ASR：总开关即时持久化
  elements.asrAutoFallback?.addEventListener("change", async () => {
    await sendRuntimeMessage({ type: "save-settings", settings: { asrAutoFallback: elements.asrAutoFallback.checked } });
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "sync" && "defaultModel" in changes) {
      const next = String(changes.defaultModel.newValue || "").trim();
      if (next !== (elements.defaultModel?.value || "").trim()) {
        elements.defaultModel.value = next;
        loadAiProviders().then((providers) => {
          renderAiProviders(elements.aiProvidersList, elements.aiProvidersEmpty, providers, { defaultModel: next, onRenderDefaultModel: (list) => renderDefaultModelSelect(elements.defaultModel, list, next) });
        });
      }
    }
    if (areaName === "sync" && "asrAutoFallback" in changes) {
      elements.asrAutoFallback.checked = changes.asrAutoFallback.newValue !== false;
    }
  });
}

async function loadSettings() {
  const settings = await getSettings();
  elements.tags.value = settings.tags || "";
  elements.downloadFormat.value = normalizeDownloadFormat(settings.downloadFormat);
  elements.includeDateInFilename.checked = settings.includeDateInFilename !== false;
  elements.includeHotCommentsInNote.checked = Boolean(settings.includeHotCommentsInNote);
  elements.enablePlayerAiQuickAction.checked = Boolean(settings.enablePlayerAiQuickAction);
  elements.playerAiQuickPrompt.value = String(settings.playerAiQuickPrompt || "");
  elements.includeTimestampInBody.checked = Boolean(settings.includeTimestampInBody);
  elements.enableDebugLogs.checked = Boolean(settings.enableDebugLogs);
  const selectedFields = new Set(settings.frontmatterFields || DEFAULT_SETTINGS.frontmatterFields);
  elements.frontmatterFields.forEach((checkbox) => {
    checkbox.checked = selectedFields.has(checkbox.value);
  });
  renderFixedPropertyRows(elements.fixedPropertiesList, elements.fixedPropertiesEmpty, settings.fixedFrontmatterProperties);
  renderNoteSectionRows(elements.noteSectionsList, elements.noteSectionsEmpty, settings.notePlaceholderSections);
  elements.aiSystemPrompt.value = settings.aiSystemPrompt || "";
  renderInitialQuickPromptInputs(settings.aiInitialQuickPrompts);
  savedAiPresetPrompts = Array.isArray(settings.aiPresetPrompts) ? settings.aiPresetPrompts : [];

  // AI 配置
  const providers = await loadAiProviders();
  renderAiProviders(elements.aiProvidersList, elements.aiProvidersEmpty, providers, { defaultModel: settings.defaultModel, onRenderDefaultModel: (list) => renderDefaultModelSelect(elements.defaultModel, list, settings.defaultModel) });

  // ASR 配置
  elements.asrAutoFallback.checked = settings.asrAutoFallback !== false;
  const asrProviders = await loadAsrProviders();
  renderAsrProviders(elements.asrProvidersList, elements.asrProvidersEmpty, asrProviders, {
    presets: asrPresets,
    activeId: settings.activeAsrProviderId || ""
  });
}

async function saveSettings() {
  clearInputErrors();
  const payload = collectFormPayload();
  const validation = validateSettings(payload);
  if (!validation.ok) {
    applyValidationError(validation);
    return;
  }
  const aiProvidersPayload = collectAiProviders(elements.aiProvidersList, { presets: aiPresets });
  const aiProvidersValidation = validateAiProviders(aiProvidersPayload);
  if (!aiProvidersValidation.ok) {
    applyValidationError(aiProvidersValidation);
    return;
  }

  setBusy(true);
  try {
    const resp = await sendRuntimeMessage({ type: "save-settings", settings: payload });
    if (!resp?.ok) {
      setStatus(resp?.error || "保存失败", true);
      return;
    }
    renderFixedPropertyRows(elements.fixedPropertiesList, elements.fixedPropertiesEmpty, payload.fixedFrontmatterProperties);
    renderNoteSectionRows(elements.noteSectionsList, elements.noteSectionsEmpty, payload.notePlaceholderSections);

    // AI 平台：list 走 sync、apiKey 走 local
    const aiResp = await sendRuntimeMessage({ type: "ai-providers-save", providers: aiProvidersPayload });
    if (!aiResp?.ok) {
      setStatus(`已保存，但 AI 平台保存失败：${aiResp?.error || "未知错误"}`, true);
      return;
    }
    // 用最新列表（含 hasSavedKey）重新渲染，避免误以为 Key 丢了
    renderAiProviders(elements.aiProvidersList, elements.aiProvidersEmpty, aiResp.providers || [], { defaultModel: payload.defaultModel, onRenderDefaultModel: (list) => renderDefaultModelSelect(elements.defaultModel, list, payload.defaultModel) });

    // ASR 平台：同样 list 走 sync、apiKey 走 local；空输入沿用已存 Key（后台处理）
    const asrPayload = collectAsrProviders(elements.asrProvidersList, { presets: asrPresets });
    const asrResp = await sendRuntimeMessage({ type: "asr-providers-save", providers: asrPayload });
    if (!asrResp?.ok) {
      setStatus(`已保存，但语音转写平台保存失败：${asrResp?.error || "未知错误"}`, true);
      return;
    }
    // 用最新列表（含 hasSavedKey）重新渲染，保存后界面只见掩码占位不见明文
    renderAsrProviders(elements.asrProvidersList, elements.asrProvidersEmpty, asrResp.providers || [], {
      presets: asrPresets,
      activeId: getActiveAsrProviderId(elements.asrProvidersList)
    });
    setStatus("保存成功");
  } catch (error) {
    setStatus(error.message || "保存失败", true);
  } finally {
    setBusy(false);
  }
}

async function getSettings() {
  try {
    const resp = await sendRuntimeMessage({ type: "get-settings" });
    if (!resp?.ok) {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...(resp.settings || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function setStatus(text, isError = false) {
  elements.status.textContent = text;
  elements.status.dataset.error = isError ? "true" : "false";
}

function collectFormPayload() {
  const selectedFields = Array.from(elements.frontmatterFields)
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.value);

  return {
    tags: elements.tags.value.trim(),
    downloadFormat: normalizeDownloadFormat(elements.downloadFormat.value),
    includeDateInFilename: elements.includeDateInFilename.checked,
    includeHotCommentsInNote: elements.includeHotCommentsInNote.checked,
    enablePlayerAiQuickAction: elements.enablePlayerAiQuickAction.checked,
    playerAiQuickPrompt: normalizePlayerAiQuickPrompt(elements.playerAiQuickPrompt.value),
    includeTimestampInBody: elements.includeTimestampInBody.checked,
    enableDebugLogs: elements.enableDebugLogs.checked,
    frontmatterFields: selectedFields,
    fixedFrontmatterProperties: normalizeFixedFrontmatterProperties(collectFixedPropertyRows(elements.fixedPropertiesList)),
    notePlaceholderSections: normalizeNotePlaceholderSections(collectNoteSectionRows(elements.noteSectionsList)),
    aiSystemPrompt: String(elements.aiSystemPrompt?.value || "").trim(),
    aiInitialQuickPrompts: collectInitialQuickPrompts(),
    aiPresetPrompts: Array.isArray(savedAiPresetPrompts) ? savedAiPresetPrompts.slice(0, 12) : [],
    defaultModel: String(elements.defaultModel?.value || "").trim()
  };
}

function renderInitialQuickPromptInputs(value) {
  const prompts = Array.isArray(value) ? value : DEFAULT_INITIAL_QUICK_PROMPTS;
  elements.aiInitialQuickPrompts.forEach((input, index) => {
    input.value = String(prompts[index] || "");
  });
}

function collectInitialQuickPrompts() {
  return Array.from(elements.aiInitialQuickPrompts || [])
    .map((input) => String(input.value || "").trim())
    .slice(0, 4);
}

function validateSettings(payload) {
  if (/[\r\n]/.test(payload.tags)) {
    return { ok: false, field: elements.tags, message: "默认标签请使用逗号分隔，不要换行" };
  }

  const fixedPropertyValidation = validateFixedFrontmatterProperties(collectFixedPropertyRows(elements.fixedPropertiesList, { includeRow: true }));
  if (!fixedPropertyValidation.ok) {
    return fixedPropertyValidation;
  }

  const noteSectionValidation = validateNotePlaceholderSections(collectNoteSectionRows(elements.noteSectionsList, { includeRow: true }));
  if (!noteSectionValidation.ok) {
    return noteSectionValidation;
  }

  return { ok: true };
}

function applyValidationError(validation) {
  clearInputErrors();
  if (validation?.field) {
    validation.field.classList.add("input-error");
    validation.field.focus();
  }
  if (validation?.row) {
    const keyInput = validation.row.querySelector(".fixed-property-key");
    const valueInput = validation.row.querySelector(".fixed-property-value");
    const titleInput = validation.row.querySelector(".note-section-title");
    const contentInput = validation.row.querySelector(".note-section-content");
    const positionSelect = validation.row.querySelector(".note-section-position");
    const noteSectionErrorNode = validation.row.querySelector(".note-section-error");
    if (titleInput || contentInput || positionSelect) {
      if (titleInput && !String(titleInput.value || "").trim()) {
        titleInput.classList.add("input-error");
        titleInput.focus();
      } else if (positionSelect && !NOTE_SECTION_POSITIONS.has(String(positionSelect.value || "").trim())) {
        positionSelect.classList.add("input-error");
        positionSelect.focus();
      } else if (contentInput && validation.requireContent) {
        contentInput.classList.add("input-error");
        contentInput.focus();
      } else if (titleInput) {
        titleInput.classList.add("input-error");
        titleInput.focus();
      }
      if (noteSectionErrorNode) {
        noteSectionErrorNode.hidden = false;
        noteSectionErrorNode.textContent = validation.message || "正文附加段落校验失败";
      }
      setStatus(validation?.message || "设置校验失败", true);
      return;
    }
    if (keyInput && !String(keyInput.value || "").trim()) {
      keyInput.classList.add("input-error");
      keyInput.focus();
    } else if (valueInput && !String(valueInput.value || "").trim()) {
      valueInput.classList.add("input-error");
      valueInput.focus();
    } else if (keyInput) {
      keyInput.classList.add("input-error");
      keyInput.focus();
    }

    const errorNode = validation.row.querySelector(".fixed-property-error");
    if (errorNode) {
      errorNode.hidden = false;
      errorNode.textContent = validation.message || "固定属性校验失败";
    }
  }
  setStatus(validation?.message || "设置校验失败", true);
}

function clearInputErrors() {
  [elements.tags].forEach((input) => {
    input?.classList.remove("input-error");
  });
  clearFixedPropertyErrors(elements.fixedPropertiesList);
  clearNoteSectionErrors(elements.noteSectionsList);
}

function setBusy(isBusy) {
  elements.saveBtn.disabled = isBusy;
  elements.saveBtn.textContent = isBusy ? "处理中..." : "保存设置";
}

async function loadAiProviders() {
  try {
    const resp = await sendRuntimeMessage({ type: "ai-providers-list" });
    if (!resp?.ok) return [];
    return Array.isArray(resp.providers) ? resp.providers : [];
  } catch {
    return [];
  }
}

async function loadAsrProviders() {
  try {
    const resp = await sendRuntimeMessage({ type: "asr-providers-list" });
    if (!resp?.ok) return [];
    return Array.isArray(resp.providers) ? resp.providers : [];
  } catch {
    return [];
  }
}
