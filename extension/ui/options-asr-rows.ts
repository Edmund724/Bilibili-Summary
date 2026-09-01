// extension/ui/options-asr-rows.ts
// 设置页"语音转写平台"区块行构建器：与 AI 平台行（options-rows.js）共用
// ui/provider-row.js 的 createProviderRow，本文件只提供 ASR 侧真实差异：
// 名称输入、模型字段随预设 modelOptions 在下拉/文本间切换、选用 radio、
// asr-providers-* 报文。行内删除按钮与状态行复用 ai-provider-remove /
// ai-provider-status 类名（既有耦合，DOM 契约保持不变）。
// 行构建器只依赖参数与回调，不直接访问 DOM 全局。

import { ASR_PROVIDER_PRESETS, type AsrProviderPreset } from "../core/presets.js";
import { escapeHtml } from "../shared/string-utils.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { createProviderRow, type ProviderRowElement, type ProviderRowItem, type ProviderRowPreset } from "./provider-row.js";

const ASR_STATUS_SUCCESS_MIN_MS = 2000;

// 模型名字段：预设带 modelOptions 时渲染为下拉框（如 SiliconFlow 的 ASR 模型），
// 否则保持可自由编辑的文本输入，供本地 Whisper / 自定义端点使用。
function buildAsrModelField(preset: ProviderRowPreset | null, model: string): string {
  const rawOptions = preset?.modelOptions;
  const modelOptions = Array.isArray(rawOptions) && rawOptions.length > 0 ? rawOptions : null;
  if (!modelOptions) {
    return `<input class="asr-provider-model" type="text" placeholder="模型名（如 FunAudioLLM/SenseVoiceSmall）" value="${escapeHtml(model)}" />`;
  }
  const valueSet = new Set(modelOptions.map((o) => String(o?.value ?? "")));
  let optionsHtml = modelOptions.map((o) => {
    const value = String(o?.value ?? "");
    return `<option value="${escapeHtml(value)}" ${value === model ? "selected" : ""}>${escapeHtml(o?.label ?? value)}</option>`;
  }).join("");
  // 已保存的 model 不在下拉选项里（如旧版 FunAudioLLM/SenseVoiceSmall）时，
  // 追加一项以保留原值，避免保存时被静默替换成默认选项。
  if (model && !valueSet.has(model)) {
    optionsHtml += `<option value="${escapeHtml(model)}" selected>${escapeHtml(model)}</option>`;
  }
  return `<select class="asr-provider-model" title="模型名">${optionsHtml}</select>`;
}

const asrProviderRow = createProviderRow({
  rowClass: "asr-provider-row",
  presetClass: "asr-provider-preset",
  presetSelectTitle: "平台预设",
  baseUrlClass: "asr-provider-baseurl",
  baseUrlPlaceholder: "baseUrl（如 https://api.siliconflow.cn/v1）",
  apikeyClass: "asr-provider-apikey",
  modelClass: "asr-provider-model",
  testClass: "asr-provider-test",
  removeClass: "ai-provider-remove",
  statusClass: "ai-provider-status",
  idPrefix: "asr_",
  statusSuccessMinMs: ASR_STATUS_SUCCESS_MIN_MS,
  statusTimerKey: "_asrStatusTimer",
  resolvePreset: (presets, presetId) => presets.find((p) => p.id === presetId) || null,
  resolveModel: (item, preset) => String(item.model ?? preset?.model ?? ""),
  apiKeyPlaceholder: ({ hasSavedKey }) => (hasSavedKey ? "已保存" : "API Key"),
  buildHeaderFields: ({ item, preset }) => {
    const name = String(item.name || preset?.name || "自定义");
    return `<input class="asr-provider-name" type="text" placeholder="平台名称" value="${escapeHtml(name)}" />`;
  },
  buildModelField: buildAsrModelField,
  buildTailFields: ({ isActive }) => `
    <label class="asr-provider-active" title="选用该平台自动生成字幕">
      <input class="asr-provider-active-radio" type="radio" name="asrActiveProvider" ${isActive ? "checked" : ""} />
      选用
    </label>`,
  onPresetChange: (row, _previousPreset, next) => {
    // 模型名随预设切换重建：带 modelOptions 的预设渲染为下拉框，否则为文本输入；
    // 模型名与名称无条件跟随——上一平台的模型对新平台无意义；
    // API Key 输入框清空，避免旧平台的 Key 在测试/保存时误发给新平台。
    row.querySelector(".asr-provider-model")!.outerHTML = buildAsrModelField(next, next.model || "");
    (row.querySelector(".asr-provider-name") as HTMLInputElement).value = next.name || "";
    (row.querySelector(".asr-provider-apikey") as HTMLInputElement).value = "";
  },
  wireRowExtras: (row, { listNode }) => {
    // 选用：即时持久化 activeAsrProviderId
    row.querySelector(".asr-provider-active-radio")?.addEventListener("change", async () => {
      if (!(row.querySelector(".asr-provider-active-radio") as HTMLInputElement).checked) return;
      const providerId = row.dataset.providerId || "";
      try {
        await sendRuntimeMessage({ type: "save-settings", settings: { activeAsrProviderId: providerId } });
      } catch {}
      setActiveAsrProvider(listNode, providerId);
    });
  },
  buildTestPayload: ({ row, presets, baseUrl, apiKey, model }) => {
    const preset = presets.find((p) => p.id === row.dataset.currentPresetId) || null;
    const provider: {
      id: string;
      name: string;
      type: string;
      baseUrl: string;
      model: string;
      apiKey?: string;
    } = {
      id: row.dataset.providerId || "",
      name: (row.querySelector(".asr-provider-name") as HTMLInputElement).value.trim() || "自定义",
      type: preset?.type || "openai-transcriptions",
      baseUrl,
      model
    };
    // 仅用户重输 Key 时携带，未重输则后台按 id 读已存 Key
    if (apiKey) {
      provider.apiKey = apiKey;
    }
    return { type: "asr-providers-test", provider };
  },
  buildDeleteMessage: (providerId) => ({ type: "asr-providers-delete", providerId })
});

export function renderAsrProviders(
  listNode: HTMLElement,
  emptyNode: HTMLElement,
  items: ProviderRowItem[] | null | undefined,
  { presets = ASR_PROVIDER_PRESETS, activeId = "" }: { presets?: readonly AsrProviderPreset[]; activeId?: string } = {}
): void {
  asrProviderRow.render(listNode, emptyNode, items, { presets, activeId });
}

export function addAsrProviderRow(listNode: HTMLElement, emptyNode: HTMLElement, item: ProviderRowItem = {}, { presets = ASR_PROVIDER_PRESETS, activeId = "" }: { presets?: readonly AsrProviderPreset[]; activeId?: string } = {}): void {
  asrProviderRow.add(listNode, emptyNode, item, { presets, activeId });
}

export function collectAsrProviders(listNode: HTMLElement, { presets = ASR_PROVIDER_PRESETS, generateId = asrProviderRow.generateId }: { presets?: readonly AsrProviderPreset[]; generateId?: () => string } = {}) {
  return Array.from(listNode.querySelectorAll<HTMLElement>(".asr-provider-row")).map((row) => {
    const presetSelect = row.querySelector(".asr-provider-preset") as HTMLSelectElement;
    const preset = presets.find((p) => p.id === presetSelect.value) || null;
    const apiKey = (row.querySelector(".asr-provider-apikey") as HTMLInputElement).value.trim();
    return {
      id: row.dataset.providerId || generateId(),
      presetId: preset?.id || "custom",
      name: (row.querySelector(".asr-provider-name") as HTMLInputElement).value.trim() || preset?.name || "自定义",
      type: preset?.type || "openai-transcriptions",
      baseUrl: (row.querySelector(".asr-provider-baseurl") as HTMLInputElement).value.trim().replace(/\/+$/, ""),
      model: (row.querySelector(".asr-provider-model") as HTMLInputElement).value.trim(),
      apiKey,
      hasSavedKey: row.dataset.hasSavedKey === "1"
    };
  });
}

// 把列表里 radio 选中态同步到指定平台 id（传空串则全部取消）
export function setActiveAsrProvider(listNode: HTMLElement, activeId: string): void {
  const target = String(activeId || "");
  listNode.querySelectorAll<HTMLInputElement>(".asr-provider-active-radio").forEach((radio) => {
    const row = radio.closest(".asr-provider-row") as HTMLElement | null;
    radio.checked = Boolean(row && row.dataset.providerId === target);
  });
}

// 当前列表选中的平台 id（无则空串）
export function getActiveAsrProviderId(listNode: HTMLElement): string {
  const checked = listNode.querySelector<HTMLInputElement>(".asr-provider-active-radio:checked");
  const row = checked?.closest(".asr-provider-row") as HTMLElement | null;
  return row?.dataset.providerId || "";
}

// 测试成功 / 删除后的回调，由 options.js 注入，避免行构建器耦合保存流程
export function setAsrTestSuccessHandler(handler: Parameters<typeof asrProviderRow.setTestSuccessHandler>[0]): void {
  asrProviderRow.setTestSuccessHandler(handler);
}

export function setAsrDeleteHandler(handler: Parameters<typeof asrProviderRow.setDeleteHandler>[0]): void {
  asrProviderRow.setDeleteHandler(handler);
}

// 删除动作前先执行的钩子（回收 host 权限），由 options.js 注入
export function setAsrBeforeDeleteHandler(handler: Parameters<typeof asrProviderRow.setBeforeDeleteHandler>[0]): void {
  asrProviderRow.setBeforeDeleteHandler(handler);
}
