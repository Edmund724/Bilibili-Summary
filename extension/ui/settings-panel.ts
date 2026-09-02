// settings-panel.ts — 侧边栏设置面板（digest-only-ui）。
//
// 原独立 options 页（pages/options.{html,css,ts}）的全部设置项搬入 Digest 面板
// 的设置抽屉（ui-renderer 模板内的 #boc-reading-settings-host 容器，分节、
// 随抽屉滚动），本模块负责模板渲染、装载与保存，行为与 options 页逐条对应：
//   - 装载（get-settings）→ 渲染三类行（固定属性/笔记段落/AI/ASR 平台）；
//   - 保存（先同步收集与校验，再申请 host 权限，最后分三路落盘：
//     settings / AI 平台 / ASR 平台）。行构建与验证本体复用
//     ../ui/options-rows.ts、../ui/options-asr-rows.ts、../core/validators.ts；
//   - 平台测试（AI/ASR 探针）成功后自动落盘（requestPermissions: false）。
// 与 options 页的唯一实现差异：content script 语境没有 chrome.permissions
// API（Chromium 仅扩展自有页面/SW 可用），host 权限申请改走
// "request-provider-origins" 消息由 background SW 代为申请（手势随一次
// runtime 消息传导；SW 监听器在调用 chrome.permissions.request 前零 await）。

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
import { initCustomSelect } from "./custom-select.js";
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
  addAiProviderRow,
  collectAiProviders,
  setTestSuccessHandler,
  setAiBeforeDeleteHandler
} from "./options-rows.js";
import type { ProviderRowItem } from "./provider-row.js";
import {
  renderAsrProviders,
  addAsrProviderRow,
  collectAsrProviders,
  setActiveAsrProvider,
  getActiveAsrProviderId,
  setAsrTestSuccessHandler,
  setAsrDeleteHandler,
  setAsrBeforeDeleteHandler
} from "./options-asr-rows.js";
import {
  requestProviderOriginsViaBackground,
  revokeOrphanOrigin,
  permissionRevokeErrorMessage
} from "../core/host-permissions.js";
import { ids } from "../reader/state.js";

const NOTE_SECTION_POSITIONS = new Set(["before_intro", "before_chapters", "before_subtitle"]);

let aiPresets: AiProviderPreset[] = [];
let asrPresets: AsrProviderPreset[] = [];

// collectFormPayload 的产物形态（save-settings 报文的 settings 载荷）
interface SettingsFormPayload {
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
}

// validateSettings / validateFixedFrontmatterProperties / validateAiProviders 的
// 校验失败载体。row 由 core/validators 以 unknown 返回（DOM 行节点），在
// applyValidationError 收窄为 HTMLElement。
interface SettingsValidationResult {
  ok: boolean;
  field?: HTMLElement;
  row?: unknown;
  message?: string;
  requireContent?: boolean;
}

// ===== 模板（分节、随设置抽屉滚动） =====

function buildSettingsHtml(): string {
  return `
    <section class="boc-set-group">
      <div class="boc-set-h">AI 模型平台</div>
      <p class="boc-set-hint">支持 OpenAI 兼容协议（OpenAI / DeepSeek / Qwen / GLM / Kimi / MiniMax / Ollama 等）。在下方点击 + 添加平台，填写名称、API Base URL、API Key 与模型名称，测试连接成功后会自动保存。</p>
      <div id="aiProvidersList" class="ai-providers-list"></div>
      <p id="aiProvidersEmpty" class="ai-providers-empty">还没有配置平台，点击下方按钮添加。</p>
      <button id="addAiProviderBtn" class="add-property-btn" type="button">+ 添加平台</button>
    </section>

    <section class="boc-set-group">
      <div class="boc-set-h">语音转写平台</div>
      <p class="boc-set-hint">无字幕轨视频可通过语音识别自动生成字幕。当前选用平台将用于转写。</p>
      <div id="asrProvidersList" class="ai-providers-list"></div>
      <p id="asrProvidersEmpty" class="ai-providers-empty">还没有配置语音转写平台。点击下方添加按钮从预设创建，无字幕视频将无法自动生成字幕。</p>
      <button id="addAsrProviderBtn" class="add-property-btn" type="button">+ 添加平台</button>
      <label class="boc-set-check asr-fallback-checkbox">
        <input id="asrAutoFallback" type="checkbox" />
        无字幕时自动生成字幕
      </label>
    </section>

    <section class="boc-set-group">
      <div class="boc-set-h">AI 按钮</div>
      <label class="boc-set-check">
        <input id="enablePlayerAiQuickAction" type="checkbox" />
        在视频播放器显示 AI 按钮，点击按照预设提示词调用 AI 对话，提示词可为空
      </label>
      <textarea
        id="playerAiQuickPrompt"
        class="boc-set-textarea"
        placeholder="例如：整理这期视频的内容，输出结构化总结。"
      ></textarea>
    </section>

    <section class="boc-set-group">
      <div class="boc-set-h">AI 对话 - 系统提示词</div>
      <textarea id="aiSystemPrompt" class="boc-set-textarea" placeholder="例如：回答尽量简洁；优先总结视频观点；必要时引用字幕原话。"></textarea>
    </section>

    <section class="boc-set-group">
      <div class="boc-set-h">AI 对话 - 初始问题</div>
      <p class="boc-set-hint">新视频没有历史对话时显示，最多 4 条，留空则不显示。</p>
      <div class="boc-set-quick-prompts">
        <input class="ai-initial-quick-prompt" type="text" placeholder="快捷问题 1" />
        <input class="ai-initial-quick-prompt" type="text" placeholder="快捷问题 2" />
        <input class="ai-initial-quick-prompt" type="text" placeholder="快捷问题 3" />
        <input class="ai-initial-quick-prompt" type="text" placeholder="快捷问题 4" />
      </div>
    </section>

    <section class="boc-set-group">
      <div class="boc-set-h">导出</div>
      <div class="boc-set-row">
        <label class="boc-set-label" for="tags">默认标签（逗号分隔）</label>
        <input id="tags" class="boc-set-input" type="text" placeholder="例如：clippings,bilibili,subtitle" />
      </div>
      <div class="boc-set-row">
        <label class="boc-set-label" for="downloadFormat">下载格式</label>
        <select id="downloadFormat" class="boc-set-select">
          <option value="srt">SRT</option>
          <option value="txt">TXT</option>
        </select>
      </div>
      <label class="boc-set-check">
        <input id="includeDateInFilename" type="checkbox" />
        文件名前包含导出日期
      </label>
      <label class="boc-set-check">
        <input id="includeHotCommentsInNote" type="checkbox" />
        导出前 20 条热门评论
      </label>
      <label class="boc-set-check">
        <input id="includeTimestampInBody" type="checkbox" />
        在字幕正文中保留时间戳
      </label>
      <label class="boc-set-check">
        <input id="enableDebugLogs" type="checkbox" />
        启用调试日志（仅在排查问题时开启）
      </label>
    </section>

    <section class="boc-set-group">
      <div class="boc-set-h">笔记属性（Frontmatter）</div>
      <p class="boc-set-hint">勾选需要写入到笔记属性区（Frontmatter）的字段。</p>
      <div class="boc-set-field-grid">
        <label class="mini-checkbox"><input type="checkbox" name="frontmatterField" value="title" /> title</label>
        <label class="mini-checkbox"><input type="checkbox" name="frontmatterField" value="url" /> url</label>
        <label class="mini-checkbox"><input type="checkbox" name="frontmatterField" value="bvid" /> bvid</label>
        <label class="mini-checkbox"><input type="checkbox" name="frontmatterField" value="cid" /> cid</label>
        <label class="mini-checkbox"><input type="checkbox" name="frontmatterField" value="author" /> author</label>
        <label class="mini-checkbox"><input type="checkbox" name="frontmatterField" value="upload_date" /> upload_date</label>
        <label class="mini-checkbox"><input type="checkbox" name="frontmatterField" value="subtitle_lang" /> subtitle_lang</label>
        <label class="mini-checkbox"><input type="checkbox" name="frontmatterField" value="created" /> created</label>
        <label class="mini-checkbox"><input type="checkbox" name="frontmatterField" value="tags" /> tags</label>
      </div>
    </section>

    <section class="boc-set-group">
      <div class="boc-set-h">自定义属性</div>
      <p class="boc-set-hint">支持默认属性的变量映射，比如 {{upload_date}}、{{created}}</p>
      <div id="fixedPropertiesList" class="fixed-properties-list"></div>
      <p id="fixedPropertiesEmpty" class="fixed-properties-empty">还没有自定义属性</p>
      <button id="addFixedPropertyBtn" class="add-property-btn" type="button">+ 添加属性</button>
    </section>

    <section class="boc-set-group">
      <div class="boc-set-h">正文附加段落</div>
      <p class="boc-set-hint">在正文插入占位段落标题。默认结构：简介-章节-字幕；具体内容可留空。</p>
      <div id="noteSectionsList" class="note-sections-list"></div>
      <p id="noteSectionsEmpty" class="fixed-properties-empty">还没有正文附加段落</p>
      <button id="addNoteSectionBtn" class="add-property-btn" type="button">+ 添加段落</button>
    </section>

    <div class="boc-set-actions">
      <button id="bocSettingsSaveBtn" type="button" class="boc-set-save-btn">保存设置</button>
    </div>
    <p id="bocSettingsStatus" class="boc-set-status"></p>
  `;
}

// ===== 元素收集（模板渲染后按 id 取自宿主容器，id 与原 options 页保持一致，
// options-rows / validators 的行级选择器直接复用） =====

function collectElements(host: HTMLElement) {
  const byIdIn = <T extends HTMLElement>(id: string): T =>
    host.querySelector(`#${id}`) as T;
  return {
    tags: byIdIn<HTMLInputElement>("tags"),
    downloadFormat: byIdIn<HTMLSelectElement>("downloadFormat"),
    includeDateInFilename: byIdIn<HTMLInputElement>("includeDateInFilename"),
    includeHotCommentsInNote: byIdIn<HTMLInputElement>("includeHotCommentsInNote"),
    enablePlayerAiQuickAction: byIdIn<HTMLInputElement>("enablePlayerAiQuickAction"),
    playerAiQuickPrompt: byIdIn<HTMLTextAreaElement>("playerAiQuickPrompt"),
    includeTimestampInBody: byIdIn<HTMLInputElement>("includeTimestampInBody"),
    enableDebugLogs: byIdIn<HTMLInputElement>("enableDebugLogs"),
    frontmatterFields: host.querySelectorAll<HTMLInputElement>('input[name="frontmatterField"]'),
    fixedPropertiesList: byIdIn<HTMLElement>("fixedPropertiesList"),
    fixedPropertiesEmpty: byIdIn<HTMLElement>("fixedPropertiesEmpty"),
    addFixedPropertyBtn: byIdIn<HTMLButtonElement>("addFixedPropertyBtn"),
    noteSectionsList: byIdIn<HTMLElement>("noteSectionsList"),
    noteSectionsEmpty: byIdIn<HTMLElement>("noteSectionsEmpty"),
    addNoteSectionBtn: byIdIn<HTMLButtonElement>("addNoteSectionBtn"),
    aiProvidersList: byIdIn<HTMLElement>("aiProvidersList"),
    aiProvidersEmpty: byIdIn<HTMLElement>("aiProvidersEmpty"),
    addAiProviderBtn: byIdIn<HTMLButtonElement>("addAiProviderBtn"),
    asrProvidersList: byIdIn<HTMLElement>("asrProvidersList"),
    asrProvidersEmpty: byIdIn<HTMLElement>("asrProvidersEmpty"),
    addAsrProviderBtn: byIdIn<HTMLButtonElement>("addAsrProviderBtn"),
    asrAutoFallback: byIdIn<HTMLInputElement>("asrAutoFallback"),
    aiSystemPrompt: byIdIn<HTMLTextAreaElement>("aiSystemPrompt"),
    aiInitialQuickPrompts: host.querySelectorAll<HTMLInputElement>(".ai-initial-quick-prompt"),
    saveBtn: byIdIn<HTMLButtonElement>("bocSettingsSaveBtn"),
    status: byIdIn<HTMLElement>("bocSettingsStatus")
  };
}

type SettingsElements = ReturnType<typeof collectElements>;

// ===== 对外入口 =====

// 渲染设置面板（renderReaderPanels 打开抽屉时调用）：模板只建一次，数据每次
// 打开都重新装载（与 options 页打开即 loadSettings 的语义一致）。
export function renderReaderSettingsPanel(): void {
  const host = document.getElementById(ids.readingSettingsHost);
  if (!host) {
    return;
  }
  if (!host.dataset.bocSettingsRendered) {
    host.innerHTML = buildSettingsHtml();
    bindSettingsEvents(host);
    host.dataset.bocSettingsRendered = "1";
  }
  void loadSettings(collectElements(host));
}

// ===== 装载与保存（逻辑与 options 页逐条对应） =====

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

let presetsLoaded = false;

async function ensurePresetsLoaded(): Promise<void> {
  if (presetsLoaded) {
    return;
  }
  await Promise.all([loadAiPresets(), loadAsrPresets()]);
  presetsLoaded = true;
}

function setStatus(elements: SettingsElements, text: unknown, isError = false): void {
  elements.status.textContent = String(text || "");
  elements.status.dataset.error = isError ? "true" : "false";
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

async function loadSettings(elements: SettingsElements): Promise<void> {
  await ensurePresetsLoaded();
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
  renderInitialQuickPromptInputs(elements, settings.aiInitialQuickPrompts);
  savedAiPresetPrompts = Array.isArray(settings.aiPresetPrompts) ? settings.aiPresetPrompts : [];

  // AI 配置
  const providers = await loadAiProviders();
  renderAiProviders(elements.aiProvidersList, elements.aiProvidersEmpty, providers);

  // ASR 配置
  elements.asrAutoFallback.checked = settings.asrAutoFallback !== false;
  const asrProviders = await loadAsrProviders();
  renderAsrProviders(elements.asrProvidersList, elements.asrProvidersEmpty, asrProviders, {
    presets: asrPresets,
    activeId: settings.activeAsrProviderId || ""
  });
}

let savedAiPresetPrompts: string[] = [];

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

function collectFormPayload(elements: SettingsElements): SettingsFormPayload {
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
    aiInitialQuickPrompts: collectInitialQuickPrompts(elements),
    aiPresetPrompts: Array.isArray(savedAiPresetPrompts) ? savedAiPresetPrompts.slice(0, 12) : []
  };
}

function renderInitialQuickPromptInputs(elements: SettingsElements, value: unknown): void {
  const prompts = Array.isArray(value) ? value : DEFAULT_INITIAL_QUICK_PROMPTS;
  elements.aiInitialQuickPrompts.forEach((input, index) => {
    input.value = String(prompts[index] || "");
  });
}

function collectInitialQuickPrompts(elements: SettingsElements): string[] {
  return Array.from(elements.aiInitialQuickPrompts || [])
    .map((input) => String(input.value || "").trim())
    .slice(0, 4);
}

function validateSettings(elements: SettingsElements, payload: SettingsFormPayload): SettingsValidationResult {
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

function applyValidationError(elements: SettingsElements, validation: SettingsValidationResult): void {
  clearInputErrors(elements);
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
      setStatus(elements, validation?.message || "设置校验失败", true);
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
  setStatus(elements, validation?.message || "设置校验失败", true);
}

function clearInputErrors(elements: SettingsElements): void {
  [elements.tags].forEach((input) => {
    input?.classList.remove("input-error");
  });
  clearFixedPropertyErrors(elements.fixedPropertiesList);
  clearNoteSectionErrors(elements.noteSectionsList);
}

function setBusy(elements: SettingsElements, isBusy: boolean): void {
  elements.saveBtn.disabled = isBusy;
  elements.saveBtn.textContent = isBusy ? "处理中..." : "保存设置";
}

// 保存设置。requestPermissions 区分两条来路：只有「点击保存设置」这条同步链
// 持有用户手势，host 权限申请能弹出授权弹窗（手势随一次 runtime 消息传导到
// SW 的 chrome.permissions.request）；「测试连接」成功后的自动保存复用本函数
// 落盘，那条路的手势已被探针的 await 用掉，传 false 跳过申请——能连通即说明
// 该平台 origin 早已授权过；确实没授权的平台走探针/模型列表预检的提示。
async function saveSettings(elements: SettingsElements, { requestPermissions = true }: { requestPermissions?: boolean } = {}): Promise<void> {
  clearInputErrors(elements);
  const aiProvidersPayload = collectAiProviders(elements.aiProvidersList, { presets: aiPresets });
  const asrProvidersPayload = collectAsrProviders(elements.asrProvidersList, { presets: asrPresets });

  const payload = collectFormPayload(elements);
  const validation = validateSettings(elements, payload);
  if (!validation.ok) {
    applyValidationError(elements, validation);
    return;
  }
  const aiProvidersValidation = validateAiProviders(aiProvidersPayload);
  if (!aiProvidersValidation.ok) {
    applyValidationError(elements, aiProvidersValidation);
    return;
  }

  // 按需申请 AI/ASR 平台域名的 host 权限。收集与校验（上方）零 await，本段
  // 仍在「点击保存」的手势同步链上。用户拒绝授权则中止保存并给出可操作提示
  // ——未授权该平台无法连通测试/使用。
  if (requestPermissions) {
    const permission = await requestProviderOriginsViaBackground([
      ...aiProvidersPayload.map((provider) => provider.baseUrl),
      ...asrProvidersPayload.map((provider) => provider.baseUrl)
    ]);
    if (!permission.ok) {
      setStatus(elements, permission.error, true);
      return;
    }
  }

  setBusy(elements, true);
  try {
    const resp = (await sendRuntimeMessage({ type: "save-settings", settings: payload })) as { ok?: boolean; error?: string };
    if (!resp?.ok) {
      setStatus(elements, resp?.error || "保存失败", true);
      return;
    }
    renderFixedPropertyRows(elements.fixedPropertiesList, elements.fixedPropertiesEmpty, payload.fixedFrontmatterProperties);
    renderNoteSectionRows(elements.noteSectionsList, elements.noteSectionsEmpty, payload.notePlaceholderSections);

    // AI 平台：list 走 sync、apiKey 走 local
    const aiResp = (await sendRuntimeMessage({ type: "ai-providers-save", providers: aiProvidersPayload })) as { ok?: boolean; error?: string; providers?: ProviderRowItem[] };
    if (!aiResp?.ok) {
      setStatus(elements, `已保存，但 AI 平台保存失败：${aiResp?.error || "未知错误"}`, true);
      return;
    }
    // 用最新列表（含 hasSavedKey）重新渲染，避免误以为 Key 丢了
    renderAiProviders(elements.aiProvidersList, elements.aiProvidersEmpty, aiResp.providers || []);

    // ASR 平台：同样 list 走 sync、apiKey 走 local；空输入沿用已存 Key（后台处理）
    const asrResp = (await sendRuntimeMessage({ type: "asr-providers-save", providers: asrProvidersPayload })) as { ok?: boolean; error?: string; providers?: ProviderRowItem[] };
    if (!asrResp?.ok) {
      setStatus(elements, `已保存，但语音转写平台保存失败：${asrResp?.error || "未知错误"}`, true);
      return;
    }
    // 用最新列表（含 hasSavedKey）重新渲染，保存后界面只见掩码占位不见明文
    renderAsrProviders(elements.asrProvidersList, elements.asrProvidersEmpty, asrResp.providers || [], {
      presets: asrPresets,
      activeId: getActiveAsrProviderId(elements.asrProvidersList)
    });
    setStatus(elements, "保存成功");
  } catch (error) {
    setStatus(elements, (error as Error).message || "保存失败", true);
  } finally {
    setBusy(elements, false);
  }
}

// ===== 事件绑定（模板渲染后一次性接线） =====

function bindSettingsEvents(host: HTMLElement): void {
  const elements = collectElements(host);

  if (elements.downloadFormat) {
    initCustomSelect(elements.downloadFormat, "custom-select-wrapper boc-set-custom-select");
  }

  setTestSuccessHandler(async () => {
    await saveSettings(elements, { requestPermissions: false });
  });
  setAsrTestSuccessHandler(async () => {
    await saveSettings(elements, { requestPermissions: false });
  });
  setAsrDeleteHandler(async (providerId) => {
    if (providerId && String(getActiveAsrProviderId(elements.asrProvidersList) || "") === providerId) {
      await sendRuntimeMessage({ type: "save-settings", settings: { activeAsrProviderId: "" } });
    }
  });
  // 删除平台时回收 host 权限：AI 与 ASR 两组共用同一条判定——origin 不再被任何
  // 存活平台使用（含另一组）才 remove。回收失败不阻断删除，状态条给出可操作文案。
  const revokeOriginOnDelete = async (providerId: string, baseUrl: string): Promise<void> => {
    const providers = [
      ...collectAiProviders(elements.aiProvidersList, { presets: aiPresets }),
      ...collectAsrProviders(elements.asrProvidersList, { presets: asrPresets })
    ];
    const { origins, revoked } = await revokeOrphanOrigin({ id: providerId, baseUrl }, providers);
    if (origins.length > 0 && !revoked) {
      setStatus(elements, permissionRevokeErrorMessage(origins), true);
    }
  };
  setAiBeforeDeleteHandler(revokeOriginOnDelete);
  setAsrBeforeDeleteHandler(revokeOriginOnDelete);

  elements.saveBtn.addEventListener("click", () => saveSettings(elements));
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
    if (!(event.target instanceof Element) || !event.target.closest(".custom-select-wrapper")) {
      document.querySelectorAll<HTMLElement>(".custom-select-dropdown").forEach((dropdown) => {
        dropdown.hidden = true;
      });
    }
  });
  [elements.tags].forEach((input) => {
    input?.addEventListener("input", () => input.classList.remove("input-error"));
  });
  // ASR：总开关即时持久化
  elements.asrAutoFallback?.addEventListener("change", async () => {
    await sendRuntimeMessage({ type: "save-settings", settings: { asrAutoFallback: elements.asrAutoFallback.checked } });
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "sync" && "asrAutoFallback" in changes) {
      elements.asrAutoFallback.checked = changes.asrAutoFallback.newValue !== false;
    }
  });
}

// ===== host 权限申请 =====

// 代申请走 core/host-permissions 的单一实现 requestProviderOriginsViaBackground：
// content script 语境没有 chrome.permissions API（Chromium 该 API 仅扩展自有
// 页面/SW 可用），经 request-provider-origins 消息由 SW 代为申请；手势经一次
// runtime 消息传导，SW 监听器在调用 chrome.permissions.request 前零 await（见
// entry/background.ts handleRequestProviderOrigins，手势不变式测试
// tests/ui/options-save-gesture.test.js 扫描全部调用方与 SW 处理器）。
