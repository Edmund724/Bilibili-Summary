// extension/ui/provider-editor.ts
// 平台编辑 Modal（AI / ASR 共用，provider-master-detail/01）：
// 点列表行「编辑」或「+ 添加平台」打开的面板内弹层（reader/explain-card.ts
// 先例：mask + role=dialog + Esc 文档级捕获 + 焦点进对话框）。字段全量平铺
// （预设 / 名称 / API 地址 / API Key / 模型 / 测试），底部「取消 / 保存」，
// 保存只落盘这一个平台（单平台 upsert 委托注入的 onSave——权限申请与整列表
// 落盘收口在 settings-panel.saveProviderSingle，本模块不触碰权限：手势不变式
// 测试锁定 requestProviderOriginsViaBackground 的调用方闭包恰好是
// options-rows / settings-panel 两文件）。
//
// 关闭语义（拍板 Q6）：打开时快照字段，取消 / Esc / 点遮罩 / 面板外点击先做
// dirty 对比，有改动 confirm「未保存的更改将丢失」，无改动直接关；保存成功
// 直接关。测试成功自动保存该平台（拍板 Q2 附带：能连通即说明 origin 已授权，
// 保存走 requestPermissions: false）。设置抽屉收起（hidden）时强制关闭
// （MutationObserver 自治监听，ui-renderer 无需知道本模块存在）。
//
// 模型字段复用 ui/model-picker（wrapper / toggle / dropdown 类名契约不变，
// settings-panel 的文档级外点关闭委托对 Modal 内下拉同样生效）。

import { escapeHtml } from "../shared/string-utils.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { validateAiProviders } from "../core/validators.js";
import { testAiProviderConnection } from "../ai/provider-test.js";
import { testAsrConnection } from "../asr/provider-test.js";
import { listAsrModels } from "../asr/provider-models.js";
import { buildModelPickerField, wireModelPicker } from "./model-picker.js";
import { closeAllCustomSelects, initCustomSelect } from "./custom-select.js";
import { ids } from "../reader/state.js";
import type { ProviderRowElement, ProviderRowItem, ProviderRowPreset } from "./provider-row.js";

export type ProviderEditorKind = "ai" | "asr";

// 保存回调（settings-panel 注入）：requestPermissions 区分两条来路——保存按钮
// 在手势同步链上（true，权限申请可弹窗）；测试成功后的自动保存手势已被探针的
// await 用掉（false，能连通即已授权）。返回 error 时 Modal 内状态行显示、不关。
export type ProviderEditorSave = (
  kind: ProviderEditorKind,
  upsert: ProviderRowItem,
  options: { requestPermissions: boolean }
) => Promise<{ ok: boolean; error?: string }>;

// 删除回调（settings-panel 注入，仅编辑态提供）：回收 orphan origin + 删除
// 消息 + 列表重渲都收口在 settings-panel，本模块只传目标（id + 行内 baseUrl）。
export type ProviderEditorDelete = (
  kind: ProviderEditorKind,
  target: { id: string; baseUrl: string }
) => Promise<{ ok: boolean; error?: string }>;

export interface ProviderEditorOpenOptions {
  kind: ProviderEditorKind;
  // 编辑目标（后端权威列表项，含 hasSavedKey）；缺省 = 新增空白
  item?: ProviderRowItem | null;
  presets: readonly ProviderRowPreset[];
  onSave: ProviderEditorSave;
  // 编辑态的删除入口（Modal 头部警示按钮）；缺省 = 不渲染删除按钮
  onDelete?: ProviderEditorDelete;
}

interface EditorState {
  open: boolean;
  kind: ProviderEditorKind;
  editingId: string;
  hasSavedKey: boolean;
  // 打开参数直达（collectUpsert / runTest / 预设切换读取）
  presets: readonly ProviderRowPreset[];
  onSave: ProviderEditorSave;
  onDelete: ProviderEditorDelete | null;
  // 打开时的字段快照（dirty 对比用）
  dirtySnapshot: string;
  // 代际号：测试探针/保存回执落定前比对，Modal 已关/已重开则丢弃过期回执
  generation: number;
  host: HTMLElement | null;
  observer: MutationObserver | null;
}

const state: EditorState = {
  open: false,
  kind: "ai",
  editingId: "",
  hasSavedKey: false,
  presets: [],
  onSave: async () => ({ ok: false, error: "保存回调未注入" }),
  onDelete: null,
  dirtySnapshot: "",
  generation: 0,
  host: null,
  observer: null
};

// ===== DOM 读取（host 直下的 dialog 内按类名取，open 时接线） =====

function getDialog(): HTMLElement | null {
  if (!state.host) return null;
  return state.host.querySelector<HTMLElement>(".provider-editor-dialog");
}

function readField(selector: string): string {
  const input = getDialog()?.querySelector<HTMLInputElement>(selector);
  return String(input?.value || "").trim();
}

// AI 行历史语义：未知 presetId 回落最后一个预设（自定义）；ASR 回落 null
function resolvePreset(presets: readonly ProviderRowPreset[], presetId: string, kind: ProviderEditorKind): ProviderRowPreset | null {
  const found = presets.find((p) => p.id === presetId) || null;
  if (found) return found;
  return kind === "ai" ? presets[presets.length - 1] || null : null;
}

function apiKeyPlaceholder(kind: ProviderEditorKind, preset: ProviderRowPreset | null, hasSavedKey: boolean): string {
  if (kind === "asr") {
    return hasSavedKey ? "已保存" : "API Key";
  }
  const requiresKey = preset?.requiresKey !== false;
  return hasSavedKey ? "已保存" : (requiresKey ? "API Key" : "API Key（可选）");
}

// 状态行写入口（wireModelPicker 与测试/保存共用；错误态着色走 data-error，
// 与平铺行 .ai-provider-status 的 CSS 契约同款）
function showStatus(text: string, isError = false): void {
  const statusNode = getDialog()?.querySelector<HTMLElement>(".provider-editor-status");
  if (!statusNode) return;
  statusNode.hidden = false;
  statusNode.textContent = text;
  statusNode.dataset.error = isError ? "true" : "false";
}

function statusIsError(): boolean {
  return getDialog()?.querySelector<HTMLElement>(".provider-editor-status")?.dataset.error === "true";
}

function clearStatus(): void {
  const statusNode = getDialog()?.querySelector<HTMLElement>(".provider-editor-status");
  if (!statusNode) return;
  statusNode.hidden = true;
  statusNode.textContent = "";
  statusNode.dataset.error = "false";
}

function setBusy(isBusy: boolean): void {
  getDialog()
    ?.querySelectorAll<HTMLButtonElement>(".provider-editor-test, .provider-editor-save")
    .forEach((button) => (button.disabled = isBusy));
}

// ===== dirty 快照（拍板 Q6） =====

function currentSnapshot(): string {
  return [
    getDialog()?.querySelector<HTMLSelectElement>(".provider-editor-preset")?.value || "",
    readField(".provider-editor-name"),
    readField(".provider-editor-baseurl"),
    readField(".provider-editor-apikey"),
    readField(".provider-editor-model")
  ].join("\u0000");
}

function isDirty(): boolean {
  return state.open && currentSnapshot() !== state.dirtySnapshot;
}

// ===== 关闭（幂等；force 跳过 dirty confirm） =====

export function closeProviderEditor(force = false): void {
  if (!state.open && !state.host) {
    return;
  }
  if (state.open && !force && isDirty() && !confirm("未保存的更改将丢失，确定关闭？")) {
    return;
  }
  state.generation += 1;
  state.open = false;
  state.observer?.disconnect();
  state.observer = null;
  document.removeEventListener("click", onDocumentClickCapture, true);
  document.removeEventListener("keydown", onDocumentKeyDownCapture, true);
  state.host?.remove();
  state.host = null;
}

// 取消 / Esc / 遮罩 / 面板外点击的统一关闭入口：dirty 才拦（拍板 Q6）
function requestClose(): void {
  if (isDirty() && !confirm("未保存的更改将丢失，确定关闭？")) {
    return;
  }
  closeProviderEditor(true);
}

// ===== 保存（拍板 Q2：单平台 upsert 委托注入的 onSave） =====

function collectUpsert(): { upsert: ProviderRowItem; validationError?: string } {
  const presetId = getDialog()?.querySelector<HTMLSelectElement>(".provider-editor-preset")?.value || "custom";
  const preset = resolvePreset(state.presets, presetId, state.kind);
  const name = readField(".provider-editor-name") || preset?.name || "自定义";
  const baseUrl = readField(".provider-editor-baseurl").replace(/\/+$/, "");
  const model = readField(".provider-editor-model");
  const apiKey = readField(".provider-editor-apikey");

  if (state.kind === "asr") {
    return {
      upsert: {
        id: state.editingId,
        presetId: preset?.id || "custom",
        name,
        type: preset?.type || "openai-transcriptions",
        baseUrl,
        model,
        apiKey,
        hasSavedKey: state.hasSavedKey
      }
    };
  }

  const upsert: ProviderRowItem = {
    id: state.editingId,
    presetId: preset?.id || "custom",
    name,
    baseUrl,
    model,
    requiresKey: preset?.requiresKey !== false,
    enabled: true,
    apiKey,
    hasSavedKey: state.hasSavedKey
  };
  // 单平台校验与整表保存共用 validateAiProviders（报文语义一致：baseUrl 格式 /
  // requiresKey 缺 Key / 缺模型名）。校验失败只报状态行，不关 Modal。
  const validation = validateAiProviders([upsert]);
  return validation.ok ? { upsert } : { upsert, validationError: validation.message };
}

async function save(): Promise<void> {
  const { upsert, validationError } = collectUpsert();
  if (validationError) {
    showStatus(validationError, true);
    return;
  }
  setBusy(true);
  showStatus("正在保存...");
  const generation = state.generation;
  try {
    const result = await state.onSave(state.kind, upsert, { requestPermissions: true });
    if (generation !== state.generation || !state.open) {
      return; // Modal 已关/已重开：过期回执丢弃
    }
    if (result.ok) {
      closeProviderEditor(true);
    } else {
      setBusy(false);
      showStatus(result.error || "保存失败", true);
    }
  } catch (error) {
    // void save() 会吞 rejection——任何异常都必须落到状态行，不允许无反馈
    if (generation !== state.generation || !state.open) return;
    setBusy(false);
    showStatus(`保存失败：${(error as Error).message || "未知错误"}`, true);
  }
}

// ===== 删除（编辑态，Modal 头部警示按钮；回收权限/删除消息/重渲在 onDelete） =====

async function deleteActive(): Promise<void> {
  if (!state.editingId || !state.onDelete) return;
  if (!confirm("确定要删除这个平台吗？删除后需要重新配置。")) return;
  setBusy(true);
  showStatus("正在删除...");
  const generation = state.generation;
  try {
    const result = await state.onDelete(state.kind, {
      id: state.editingId,
      baseUrl: readField(".provider-editor-baseurl")
    });
    if (generation !== state.generation || !state.open) return;
    if (result.ok) {
      closeProviderEditor(true);
    } else {
      setBusy(false);
      showStatus(result.error || "删除失败", true);
    }
  } catch (error) {
    if (generation !== state.generation || !state.open) return;
    setBusy(false);
    showStatus(`删除失败：${(error as Error).message || "未知错误"}`, true);
  }
}

// ===== 测试连接（拍板 Q2 附带：成功即自动保存该平台） =====

async function runTest(): Promise<void> {
  const baseUrl = readField(".provider-editor-baseurl");
  const model = readField(".provider-editor-model");
  if (!baseUrl) {
    showStatus("请填写 baseUrl", true);
    return;
  }
  if (!model) {
    showStatus("请填写模型名", true);
    return;
  }
  setBusy(true);
  showStatus("正在测试...");
  const generation = state.generation;
  const presetId = getDialog()?.querySelector<HTMLSelectElement>(".provider-editor-preset")?.value || "custom";
  const preset = resolvePreset(state.presets, presetId, state.kind);
  const apiKey = readField(".provider-editor-apikey");
  const name = readField(".provider-editor-name") || preset?.name || "自定义";
  // 探针直调（与平铺行同源语义，options 页本地执行免 SW 往返）；新增时
  // editingId 为空，探针按空 id 代查 Key 落空，用户重输的 Key 随参数携带。
  const resp: { ok?: boolean; error?: string } = state.kind === "ai"
    ? await testAiProviderConnection({ providerId: state.editingId, baseUrl, apiKey, model })
    : await testAsrConnection({
        id: state.editingId,
        name,
        type: preset?.type || "openai-transcriptions",
        baseUrl,
        model,
        ...(apiKey ? { apiKey } : {})
      });
  if (generation !== state.generation || !state.open) {
    return; // 过期回执：Modal 已关/已重开，不打扰
  }
  if (!resp?.ok) {
    setBusy(false);
    showStatus(`失败：${resp?.error || "未知错误"}`, true);
    return;
  }
  // 测试成功自动保存该平台：手势已被探针 await 用掉，requestPermissions: false
  //（连通即已授权）；校验失败不拦——探针都连通了没有再拦保存的道理。
  const { upsert } = collectUpsert();
  const saveResult = await state.onSave(state.kind, upsert, { requestPermissions: false });
  if (generation !== state.generation || !state.open) {
    return;
  }
  setBusy(false);
  showStatus(saveResult.ok ? "连接成功" : `连接成功，但保存失败：${saveResult.error || "未知错误"}`, !saveResult.ok);
}

// ===== 模板 =====

function editorTitle(kind: ProviderEditorKind, editing: boolean): string {
  const label = kind === "ai" ? "AI 平台" : "语音转写平台";
  return editing ? `编辑${label}` : `添加${label}`;
}

function buildDialogHtml(options: ProviderEditorOpenOptions): string {
  const item = options.item || null;
  const presets = options.presets;
  // 新增默认「自定义」（与平铺行空白行的 presetId 默认一致，baseUrl 空）；
  // 编辑按列表项 presetId（未知值由 resolvePreset 回落，AI 回落最后一个预设）
  const presetId = String(item?.presetId || "custom");
  const preset = resolvePreset(presets, presetId, options.kind);
  const hasSavedKey = Boolean(item?.hasSavedKey);
  const baseUrl = String(item?.baseUrl ?? preset?.baseUrl ?? "");
  const isAi = options.kind === "ai";
  // AI 名称是拍板 Q7 新增的可选项：历史数据 name=预设名，值留空 + 占位符展示
  // 预设名（保存时空值回落预设名）；用户自定义过（≠预设名）才回填实值。
  // ASR 名称是实值语义（与平铺行一致：初始即预设名）。
  const presetName = preset?.name || "";
  const rawName = String(item?.name || "");
  const nameValue = isAi ? (rawName && rawName !== presetName ? rawName : "") : rawName || presetName;
  const namePlaceholder = isAi ? presetName : "平台名称";
  const model = isAi ? String(item?.model || "") : String(item?.model ?? preset?.model ?? "");

  return `
    <div class="provider-editor-mask" data-provider-editor-action="close"></div>
    <section class="provider-editor-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(editorTitle(options.kind, Boolean(item?.id)))}" tabindex="-1">
      <header class="provider-editor-head">
        <span class="provider-editor-title">${escapeHtml(editorTitle(options.kind, Boolean(item?.id)))}</span>
        ${item?.id && options.onDelete ? `<button type="button" class="provider-editor-delete" data-provider-editor-action="delete" title="删除该平台">删除</button>` : ""}
      </header>
      <div class="provider-editor-body">
        <div class="provider-editor-field">
          <label class="provider-editor-label">平台预设</label>
          <select class="provider-editor-preset">
            ${presets.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === presetId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
          </select>
        </div>
        <div class="provider-editor-field">
          <label class="provider-editor-label">名称</label>
          <input class="provider-editor-name" type="text" placeholder="${escapeHtml(namePlaceholder)}" value="${escapeHtml(nameValue)}" />
        </div>
        <div class="provider-editor-field">
          <label class="provider-editor-label">API 地址</label>
          <input class="provider-editor-baseurl" type="text" required pattern="https?://.+" placeholder="baseUrl（如 https://api.openai.com/v1）" value="${escapeHtml(baseUrl)}" />
        </div>
        <div class="provider-editor-field">
          <label class="provider-editor-label">API Key</label>
          <input class="provider-editor-apikey" type="password" placeholder="${escapeHtml(apiKeyPlaceholder(options.kind, preset, hasSavedKey))}" autocomplete="off" ${!hasSavedKey && preset?.requiresKey !== false ? "required" : ""} />
        </div>
        <div class="provider-editor-field">
          <label class="provider-editor-label">模型</label>
          ${buildModelPickerField({
            inputClass: "provider-editor-model",
            placeholder: isAi ? "模型名（如 gpt-4o-mini）" : "模型名（点右侧箭头拉取可选模型）",
            value: model
          })}
        </div>
        <div class="provider-editor-testrow">
          <button type="button" class="provider-editor-test" data-provider-editor-action="test">测试</button>
          <p class="provider-editor-status" hidden></p>
        </div>
      </div>
      <footer class="provider-editor-foot">
        <button type="button" class="provider-editor-cancel" data-provider-editor-action="close">取消</button>
        <button type="button" class="provider-editor-save" data-provider-editor-action="save">保存</button>
      </footer>
    </section>
  `;
}

// ===== 挂载与全局监听 =====

// 挂载宿主：#boc-reading-view 直下（面板内弹层的最大合理范围，不在设置抽屉
// 滚动容器内——mask 不随内容滚动）。阅读视图重建时宿主随根节点一起消失，
// open 入口的幂等重置兜底状态残留。
function ensureHost(): HTMLElement | null {
  const view = document.getElementById(ids.readingView);
  if (!view) {
    return null;
  }
  const host = document.createElement("div");
  host.className = "provider-editor-host";
  view.appendChild(host);
  return host;
}

// 设置抽屉收起时强制关闭（含 dirty 改动）：抽屉被外点/齿轮收起时用户意图是
// 关掉一切，confirm 无意义。自治监听 hidden 属性变化，零跨模块状态。
function watchSettingsPanel(): void {
  const panel = document.getElementById(ids.readingSettingsPanel);
  if (!panel || typeof MutationObserver === "undefined") {
    return;
  }
  const observer = new MutationObserver(() => {
    if (panel.hidden) {
      closeProviderEditor(true);
    }
  });
  observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  state.observer = observer;
}

// 面板外点击（capture 阶段拦截）：只关 Modal 不关抽屉——ui-renderer 的抽屉
// 外点关闭是 document bubble 委托，capture 阶段 stopPropagation 后不再触发
//（一次点击只关一层）。面板内点击（含遮罩）正常冒泡：settings-panel 的
// 文档级委托照常收起 Modal 内的模型下拉。
function onDocumentClickCapture(event: MouseEvent): void {
  if (!state.open) return;
  const view = document.getElementById(ids.readingView);
  if (view && event.target instanceof Node && view.contains(event.target)) {
    return;
  }
  event.stopPropagation();
  requestClose();
}

function onDocumentKeyDownCapture(event: KeyboardEvent): void {
  if (!state.open || event.key !== "Escape") return;
  event.stopPropagation();
  requestClose();
}

// ===== 接线 =====

function wireDialog(options: ProviderEditorOpenOptions): void {
  const dialog = getDialog();
  const host = state.host;
  if (!dialog || !host) return;

  // 委托挂 host（mask 与 dialog 的共同父级）：遮罩是 dialog 的兄弟，挂 dialog
  // 上收不到遮罩点击（explain-card 同款：委托在容器上）。
  // 无条件 stopPropagation：Modal 宿主挂 #boc-reading-view 直下，在设置抽屉
  // （settingsPanel）之外——点击外传会被 ui-renderer 的抽屉外点关闭委托（判定
  // 域 settingsPanel+齿轮，document bubble）当成外点把抽屉一起收掉，随即触发
  // hidden 联动的强制关闭，保存/关闭动作被吞（一次点击只关一层）。下拉的外点
  // 收起语义（常态由 settings-panel 的文档级委托负责）在此自持。
  host.addEventListener("click", (event) => {
    event.stopPropagation();
    const target = event.target as HTMLElement;
    // 点在下拉组件（模型 picker / ASR 自定义预设）之外才收起——组件的
    // toggle/trigger/option 自带开关逻辑，点在组件内不干扰
    if (!target.closest(".ai-provider-model-wrapper") && !target.closest(".custom-select-wrapper")) {
      host.querySelectorAll<HTMLElement>(".ai-provider-model-dropdown").forEach((d) => (d.hidden = true));
      closeAllCustomSelects();
    }
    // 四个动作全部走这一条委托（按钮直连绑定曾在真实页面失效，close 是
    // 用户验证过的同源路径）；异常兜底在各 handler 内部落状态行
    const action = target.closest<HTMLElement>("[data-provider-editor-action]")?.dataset.providerEditorAction;
    if (action === "close") requestClose();
    else if (action === "save") void save();
    else if (action === "test") void runTest();
    else if (action === "delete") void deleteActive();
  });

  const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset");
  const nameInput = dialog.querySelector<HTMLInputElement>(".provider-editor-name");
  const baseUrlInput = dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl");
  const apikeyInput = dialog.querySelector<HTMLInputElement>(".provider-editor-apikey");

  // 原生约束（reader-settings.css 的 :user-invalid/:user-valid 校验态消费）：
  // 模型名字段由 model-picker 模板生成（构建器契约不含属性注入），在此补
  // required；Key 必填随预设 requiresKey 与已存 Key 态挂摘（与占位符同口径）。
  dialog.querySelector<HTMLInputElement>(".provider-editor-model")?.setAttribute("required", "");
  const syncApiKeyRequired = (preset: ProviderRowPreset | null): void => {
    if (apikeyInput) {
      apikeyInput.required = preset?.requiresKey !== false && !state.hasSavedKey;
    }
  };
  syncApiKeyRequired(resolvePreset(options.presets, presetSelect?.value || "", options.kind));

  // 预设切换：baseUrl 未改过（空或仍是上一预设默认值）才跟随（平铺行同款规则）。
  // AI 名称留过实值（≠当前预设名）视为用户自定义，切预设不覆盖；否则跟随新
  // 预设名（仅占位符与空值）。ASR 名称/模型无条件跟随、Key 清空（平铺行同款）。
  // 不代申请权限——Modal 的 host 权限在保存时统一收口（拍板 Q5 推论）。
  presetSelect?.addEventListener("change", () => {
    const next = resolvePreset(options.presets, presetSelect.value, options.kind);
    if (!next) return;
    const previous = resolvePreset(options.presets, presetSelect.dataset.previousPresetId || "", options.kind);
    const currentBaseUrl = baseUrlInput?.value.trim() || "";
    if (baseUrlInput && (!currentBaseUrl || (previous && currentBaseUrl === previous.baseUrl))) {
      baseUrlInput.value = next.baseUrl;
    }
    const modelInput = dialog.querySelector<HTMLInputElement>(".provider-editor-model");
    if (options.kind === "asr") {
      if (modelInput) modelInput.value = next.model || "";
      if (nameInput) nameInput.value = next.name || "";
      if (apikeyInput) apikeyInput.value = "";
    } else {
      const currentName = nameInput?.value.trim() || "";
      if (nameInput && (!currentName || (previous && currentName === previous.name))) {
        nameInput.value = "";
        nameInput.placeholder = next.name || "";
      }
      if (apikeyInput) {
        apikeyInput.placeholder = apiKeyPlaceholder("ai", next, state.hasSavedKey);
      }
    }
    // Key 必填随预设挂摘（requiresKey 与已存 Key 态同占位符口径）
    syncApiKeyRequired(next);
    clearStatus();
    presetSelect.dataset.previousPresetId = next.id;
  });
  if (presetSelect) {
    presetSelect.dataset.previousPresetId = presetSelect.value;
    if (options.kind === "asr") {
      initCustomSelect(presetSelect, "custom-select-wrapper provider-editor-preset-wrapper");
    }
  }

  // 输入即清错误状态行（修正输入即清错）；字段级校验态由 :user-invalid CSS
  // 随原生约束自动摘除，无需 JS 介入
  [nameInput, baseUrlInput, apikeyInput].forEach((input) => {
    input?.addEventListener("input", () => {
      if (statusIsError()) {
        clearStatus();
      }
    });
  });

  // 可达性桥（accessible-error-announcement）：:user-invalid（视觉态）与
  // aria-invalid（程序态）同拍——浏览器判定进入/退出 :user-invalid 的时刻
  //（blur 提交值 / input 修正值）同步属性，AT 与视觉在同一时刻拿到「无效」。
  // blur 不冒泡走 capture；jsdom 无 :user-invalid 判定（matches 恒 false），
  // 正向路径无法在测试网仿真，浏览器（Chrome 119+，Baseline 2023-11）按标准工作。
  const syncAriaInvalid = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.matches("input, textarea, select")) {
      return;
    }
    try {
      if (target.matches(":user-invalid")) {
        target.setAttribute("aria-invalid", "true");
      } else {
        target.removeAttribute("aria-invalid");
      }
    } catch {
      // 老内核不识别 :user-invalid（matches 抛 SyntaxError）：属性面保持不动
    }
  };
  dialog.addEventListener("blur", syncAriaInvalid, true);
  dialog.addEventListener("input", syncAriaInvalid);

  wireModelPicker(dialog as unknown as ProviderRowElement, {
    inputClass: "provider-editor-model",
    baseUrlClass: "provider-editor-baseurl",
    apiKeyClass: "provider-editor-apikey",
    statusClass: "provider-editor-status",
    showStatus: (_node, text, isError) => showStatus(text, isError),
    // AI 侧模型列表走 SW 消息（与平铺行一致）；ASR 直调 provider-models
    fetchModels: ({ baseUrl, apiKey, providerId }) => {
      if (options.kind === "asr") {
        return listAsrModels({ baseUrl, apiKey, providerId });
      }
      return sendRuntimeMessage({ type: "ai-providers-models", baseUrl, apiKey, providerId });
    }
  });

  dialog.focus({ preventScroll: true });
}

export function openProviderEditor(options: ProviderEditorOpenOptions): void {
  // 幂等重置：重复打开（编辑 A 中改开 B）先作废旧 Modal 的在飞回执与监听
  closeProviderEditor(true);
  const host = ensureHost();
  if (!host) {
    return;
  }
  state.host = host;
  state.kind = options.kind;
  state.presets = options.presets;
  state.onSave = options.onSave;
  state.onDelete = options.onDelete || null;
  state.editingId = String(options.item?.id || "");
  state.hasSavedKey = Boolean(options.item?.hasSavedKey);
  state.open = true;
  host.innerHTML = buildDialogHtml(options);
  wireDialog(options);
  state.dirtySnapshot = currentSnapshot();
  document.addEventListener("click", onDocumentClickCapture, true);
  document.addEventListener("keydown", onDocumentKeyDownCapture, true);
  watchSettingsPanel();
}

export function isProviderEditorOpen(): boolean {
  return state.open;
}
