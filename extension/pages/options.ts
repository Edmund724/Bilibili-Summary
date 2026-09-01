// options.ts — 选项页控制器（自 options.js 迁移，仅加类型；行为逐字节不变）。
//
// 装载设置（get-settings）→ 渲染三类行（固定属性/笔记段落/AI/ASR 平台）→
// 保存（先同步收集与校验，再在「点击保存」的用户手势同步链上申请 host 权限，
// 最后分三路落盘：settings / AI 平台 / ASR 平台）。行构建与验证本体在
// ../ui/options-rows.ts、../ui/options-asr-rows.ts、../core/validators.ts。
import { DEFAULT_SETTINGS, DEFAULT_INITIAL_QUICK_PROMPTS } from "../core/defaults.js";
import type { FixedFrontmatterProperty, NotePlaceholderSection } from "../core/validators.js";
import { PRESETS, ASR_PROVIDER_PRESETS } from "../core/presets.js";
import type { AiProviderPreset, AsrProviderPreset } from "../core/presets.js";
import {
  normalizeDownloadFormat,
  normalizePlayerAiQuickPrompt,
  normalizeFixedFrontmatterProperties,
  normalizeNotePlaceholderSections,
  validateFixedFrontmatterProperties,
  validateNotePlaceholderSections,
  validateAiProviders
} from "../core/validators.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
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
  setTestSuccessHandler,
  setAiBeforeDeleteHandler
} from "../ui/options-rows.js";
import type { ProviderRowItem } from "../ui/provider-row.js";
import {
  renderAsrProviders,
  addAsrProviderRow,
  collectAsrProviders,
  setActiveAsrProvider,
  getActiveAsrProviderId,
  setAsrTestSuccessHandler,
  setAsrDeleteHandler,
  setAsrBeforeDeleteHandler
} from "../ui/options-asr-rows.js";
import {
  requestProviderOrigins,
  revokeOrphanOrigin,
  permissionRevokeErrorMessage
} from "../core/host-permissions.js";

const NOTE_SECTION_POSITIONS = new Set(["before_intro", "before_chapters", "before_subtitle"]);

let aiPresets: AiProviderPreset[] = [];
let asrPresets: AsrProviderPreset[] = [];

async function loadAiPresets(): Promise<void> {
  try {
    const resp = (await sendRuntimeMessage({ type: "ai-presets-list" })) as { ok?: boolean; presets?: AiProviderPreset[] };
    if (resp?.ok && Array.isArray(resp.presets)) {
      aiPresets = resp.presets;
      return;
    }
  } catch {
    // fallback to built-in list when background is unreachable
  }

  aiPresets = PRESETS.slice();
}

async function loadAsrPresets(): Promise<void> {
  try {
    const resp = (await sendRuntimeMessage({ type: "asr-presets-list" })) as { ok?: boolean; presets?: AsrProviderPreset[] };
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
  tags: document.getElementById("tags") as HTMLInputElement,
  downloadFormat: document.getElementById("downloadFormat") as HTMLSelectElement,
  includeDateInFilename: document.getElementById("includeDateInFilename") as HTMLInputElement,
  includeHotCommentsInNote: document.getElementById("includeHotCommentsInNote") as HTMLInputElement,
  enablePlayerAiQuickAction: document.getElementById("enablePlayerAiQuickAction") as HTMLInputElement,
  playerAiQuickPrompt: document.getElementById("playerAiQuickPrompt") as HTMLInputElement,
  includeTimestampInBody: document.getElementById("includeTimestampInBody") as HTMLInputElement,
  enableDebugLogs: document.getElementById("enableDebugLogs") as HTMLInputElement,
  frontmatterFields: document.querySelectorAll<HTMLInputElement>('input[name="frontmatterField"]'),
  fixedPropertiesList: document.getElementById("fixedPropertiesList") as HTMLElement,
  fixedPropertiesEmpty: document.getElementById("fixedPropertiesEmpty") as HTMLElement,
  addFixedPropertyBtn: document.getElementById("addFixedPropertyBtn") as HTMLButtonElement,
  noteSectionsList: document.getElementById("noteSectionsList") as HTMLElement,
  noteSectionsEmpty: document.getElementById("noteSectionsEmpty") as HTMLElement,
  addNoteSectionBtn: document.getElementById("addNoteSectionBtn") as HTMLButtonElement,
  aiProvidersList: document.getElementById("aiProvidersList") as HTMLElement,
  aiProvidersEmpty: document.getElementById("aiProvidersEmpty") as HTMLElement,
  addAiProviderBtn: document.getElementById("addAiProviderBtn") as HTMLButtonElement,
  defaultModel: document.getElementById("defaultModel") as HTMLSelectElement,
  asrProvidersList: document.getElementById("asrProvidersList") as HTMLElement,
  asrProvidersEmpty: document.getElementById("asrProvidersEmpty") as HTMLElement,
  addAsrProviderBtn: document.getElementById("addAsrProviderBtn") as HTMLButtonElement,
  asrAutoFallback: document.getElementById("asrAutoFallback") as HTMLInputElement,
  aiSystemPrompt: document.getElementById("aiSystemPrompt") as HTMLTextAreaElement,
  aiInitialQuickPrompts: document.querySelectorAll<HTMLInputElement>(".ai-initial-quick-prompt"),
  saveBtn: document.getElementById("saveBtn") as HTMLButtonElement,
  status: document.getElementById("status") as HTMLElement
};

// collectFormPayload 的产物形态（save-settings 报文的 settings 载荷）
interface OptionsFormPayload {
  tags: string;
  downloadFormat: string;
  includeDateInFilename: boolean;
  includeHotCommentsInNote: boolean;
  enablePlayerAiQuickAction: boolean;
  playerAiQuickPrompt: string;
  includeTimestampInBody: boolean;
  enableDebugLogs: boolean;
  frontmatterFields: string[];
  fixedFrontmatterProperties: FixedFrontmatterProperty[];
  notePlaceholderSections: NotePlaceholderSection[];
  aiSystemPrompt: string;
  aiInitialQuickPrompts: string[];
  aiPresetPrompts: string[];
  defaultModel: string;
}

// validateSettings / validateFixedFrontmatterProperties / validateAiProviders 的
// 校验失败载体。row 由 core/validators 以 unknown 返回（DOM 行节点），在
// applyValidationError 收窄为 HTMLElement。
interface OptionsValidationResult {
  ok: boolean;
  field?: HTMLElement;
  row?: unknown;
  message?: string;
  requireContent?: boolean;
}

let savedAiPresetPrompts: string[] = [];

init();

async function init(): Promise<void> {
  await loadAiPresets();
  await loadAsrPresets();
  setTestSuccessHandler(async (providerId) => {
    // 探针已成功 → 该平台 origin 必已授权；此路无用户手势，不再申请（见 saveSettings）
    // 旧实现曾 return providerId；ProviderRowHandler 契约为 void 且 provider-row
    // 侧 await 后不消费返回值，落盘成功即连接成功。
    await saveSettings({ requestPermissions: false });
  });
  setAsrTestSuccessHandler(async () => {
    await saveSettings({ requestPermissions: false });
  });
  setAsrDeleteHandler(async (providerId) => {
    if (providerId && String(getActiveAsrProviderId(elements.asrProvidersList) || "") === providerId) {
      await sendRuntimeMessage({ type: "save-settings", settings: { activeAsrProviderId: "" } });
    }
  });
  // 删除平台时回收 host 权限：AI 与 ASR 两组共用同一条判定——origin 不再被任何
  // 存活平台使用（含另一组）才 remove。权限本就不在（当初拒绝过授权）静默跳过，
  // 回收失败不阻断删除：平台已从存储与列表移除，权限残留只影响提示，状态条给出
  // 可操作文案。（chrome.permissions.remove 不需要用户手势，钩子放在删除消息
  // 之前只为「先回收、后删除」这一顺序可读。）
  const revokeOriginOnDelete = async (providerId: string, baseUrl: string): Promise<void> => {
    const providers = [
      ...collectAiProviders(elements.aiProvidersList, { presets: aiPresets }),
      ...collectAsrProviders(elements.asrProvidersList, { presets: asrPresets })
    ];
    const { origins, revoked } = await revokeOrphanOrigin({ id: providerId, baseUrl }, providers);
    if (origins.length > 0 && !revoked) {
      setStatus(permissionRevokeErrorMessage(origins), true);
    }
  };
  setAiBeforeDeleteHandler(revokeOriginOnDelete);
  setAsrBeforeDeleteHandler(revokeOriginOnDelete);
  loadSettings();
  // 保存按钮：这条同步调用链上的 chrome.permissions.request 才拿得到用户手势
  elements.saveBtn.addEventListener("click", () => saveSettings());
  elements.addFixedPropertyBtn.addEventListener("click", () => addFixedPropertyRow(elements.fixedPropertiesList, elements.fixedPropertiesEmpty));
  elements.addNoteSectionBtn.addEventListener("click", () => addNoteSectionRow(elements.noteSectionsList, elements.noteSectionsEmpty));
  elements.addAiProviderBtn.addEventListener("click", () => addAiProviderRow(elements.aiProvidersList, elements.aiProvidersEmpty, {}, { presets: aiPresets }));
  elements.addAsrProviderBtn.addEventListener("click", () => addAsrProviderRow(elements.asrProvidersList, elements.asrProvidersEmpty, {}, { presets: asrPresets }));
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest(".fixed-property-type-picker")) {
      elements.fixedPropertiesList.querySelectorAll<HTMLElement>(".fixed-property-type-picker").forEach((picker) => {
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
    if (!(event.target instanceof Element) || !event.target.closest(".ai-provider-model-wrapper")) {
      document.querySelectorAll<HTMLElement>(".ai-provider-model-dropdown").forEach((dropdown) => {
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

async function loadSettings(): Promise<void> {
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

// 保存设置。requestPermissions 区分两条来路：只有「点击保存设置」这条同步链持有
// 用户手势，chrome.permissions.request 能弹窗；「测试连接」成功后也复用本函数落盘
// （见下方 setTestSuccessHandler），那条路已被探针的 await 用掉手势，此时申请必被
// Chrome 以「缺少用户手势」拒绝、把正常保存误判成「未授权」而中止，故传 false 跳过。
// 跳过的代价是空的：能连通即说明该平台 origin 早已在点保存时授出；确实没授权的平台
// 走 core/host-permissions.js 的探针/模型列表预检，回「请在保存时允许权限」提示。
async function saveSettings({ requestPermissions = true }: { requestPermissions?: boolean } = {}): Promise<void> {
  clearInputErrors();
  const aiProvidersPayload = collectAiProviders(elements.aiProvidersList, { presets: aiPresets });
  const asrProvidersPayload = collectAsrProviders(elements.asrProvidersList, { presets: asrPresets });

  const payload = collectFormPayload();
  const validation = validateSettings(payload);
  if (!validation.ok) {
    applyValidationError(validation);
    return;
  }
  const aiProvidersValidation = validateAiProviders(aiProvidersPayload);
  if (!aiProvidersValidation.ok) {
    applyValidationError(aiProvidersValidation);
    return;
  }

  // 按需申请 AI/ASR 平台域名的 host 权限（见 saveSettings 头部注释：只有点保存
  // 这条路有用户手势）。上面全是同步收集与同步校验（零 await），所以本行仍在
  // 「点击保存」的同步调用链上、chrome.permissions.request 拿得到用户手势；一次
  // 手势只够一次弹窗，故把两组平台的所有 origin 去重后合并成单次申请。校验先行
  // 可避免为格式非法的 baseUrl 弹窗。用户拒绝授权则中止保存并给出可操作提示——
  // 未授权该平台无法连通测试/使用。编辑改过 baseUrl 时新 origin 一并申请。
  if (requestPermissions) {
    const permission = await requestProviderOrigins([
      ...aiProvidersPayload.map((provider) => provider.baseUrl),
      ...asrProvidersPayload.map((provider) => provider.baseUrl)
    ]);
    if (!permission.ok) {
      setStatus(permission.error, true);
      return;
    }
  }

  setBusy(true);
  try {
    const resp = (await sendRuntimeMessage({ type: "save-settings", settings: payload })) as { ok?: boolean; error?: string };
    if (!resp?.ok) {
      setStatus(resp?.error || "保存失败", true);
      return;
    }
    renderFixedPropertyRows(elements.fixedPropertiesList, elements.fixedPropertiesEmpty, payload.fixedFrontmatterProperties);
    renderNoteSectionRows(elements.noteSectionsList, elements.noteSectionsEmpty, payload.notePlaceholderSections);

    // AI 平台：list 走 sync、apiKey 走 local
    const aiResp = (await sendRuntimeMessage({ type: "ai-providers-save", providers: aiProvidersPayload })) as { ok?: boolean; error?: string; providers?: ProviderRowItem[] };
    if (!aiResp?.ok) {
      setStatus(`已保存，但 AI 平台保存失败：${aiResp?.error || "未知错误"}`, true);
      return;
    }
    // 用最新列表（含 hasSavedKey）重新渲染，避免误以为 Key 丢了
    renderAiProviders(elements.aiProvidersList, elements.aiProvidersEmpty, aiResp.providers || [], { defaultModel: payload.defaultModel, onRenderDefaultModel: (list) => renderDefaultModelSelect(elements.defaultModel, list, payload.defaultModel) });

    // ASR 平台：同样 list 走 sync、apiKey 走 local；空输入沿用已存 Key（后台处理）
    const asrResp = (await sendRuntimeMessage({ type: "asr-providers-save", providers: asrProvidersPayload })) as { ok?: boolean; error?: string; providers?: ProviderRowItem[] };
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
    setStatus((error as Error).message || "保存失败", true);
  } finally {
    setBusy(false);
  }
}

async function getSettings(): Promise<typeof DEFAULT_SETTINGS> {
  try {
    const resp = (await sendRuntimeMessage({ type: "get-settings" })) as { ok?: boolean; settings?: Partial<typeof DEFAULT_SETTINGS> };
    if (!resp?.ok) {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...(resp.settings || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function setStatus(text: unknown, isError = false): void {
  elements.status.textContent = String(text || "");
  elements.status.dataset.error = isError ? "true" : "false";
}

function collectFormPayload(): OptionsFormPayload {
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

function renderInitialQuickPromptInputs(value: unknown): void {
  const prompts = Array.isArray(value) ? value : DEFAULT_INITIAL_QUICK_PROMPTS;
  elements.aiInitialQuickPrompts.forEach((input, index) => {
    input.value = String(prompts[index] || "");
  });
}

function collectInitialQuickPrompts(): string[] {
  return Array.from(elements.aiInitialQuickPrompts || [])
    .map((input) => String(input.value || "").trim())
    .slice(0, 4);
}

function validateSettings(payload: OptionsFormPayload): OptionsValidationResult {
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

function applyValidationError(validation: OptionsValidationResult): void {
  clearInputErrors();
  if (validation?.field) {
    validation.field.classList.add("input-error");
    validation.field.focus();
  }
  if (validation?.row) {
    const row = validation.row as HTMLElement;
    const keyInput = row.querySelector<HTMLInputElement>(".fixed-property-key");
    const valueInput = row.querySelector<HTMLInputElement>(".fixed-property-value");
    const titleInput = row.querySelector<HTMLInputElement>(".note-section-title");
    const contentInput = row.querySelector<HTMLInputElement>(".note-section-content");
    const positionSelect = row.querySelector<HTMLSelectElement>(".note-section-position");
    const noteSectionErrorNode = row.querySelector<HTMLElement>(".note-section-error");
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

    const errorNode = row.querySelector<HTMLElement>(".fixed-property-error");
    if (errorNode) {
      errorNode.hidden = false;
      errorNode.textContent = validation.message || "固定属性校验失败";
    }
  }
  setStatus(validation?.message || "设置校验失败", true);
}

function clearInputErrors(): void {
  [elements.tags].forEach((input) => {
    input?.classList.remove("input-error");
  });
  clearFixedPropertyErrors(elements.fixedPropertiesList);
  clearNoteSectionErrors(elements.noteSectionsList);
}

function setBusy(isBusy: boolean): void {
  elements.saveBtn.disabled = isBusy;
  elements.saveBtn.textContent = isBusy ? "处理中..." : "保存设置";
}

async function loadAiProviders(): Promise<ProviderRowItem[]> {
  try {
    const resp = (await sendRuntimeMessage({ type: "ai-providers-list" })) as { ok?: boolean; providers?: ProviderRowItem[] };
    if (!resp?.ok) return [];
    return Array.isArray(resp.providers) ? resp.providers : [];
  } catch {
    return [];
  }
}

async function loadAsrProviders(): Promise<ProviderRowItem[]> {
  try {
    const resp = (await sendRuntimeMessage({ type: "asr-providers-list" })) as { ok?: boolean; providers?: ProviderRowItem[] };
    if (!resp?.ok) return [];
    return Array.isArray(resp.providers) ? resp.providers : [];
  } catch {
    return [];
  }
}
