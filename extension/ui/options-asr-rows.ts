// extension/ui/options-asr-rows.ts
// 设置页"语音转写平台"区块行构建器：与 AI 平台行（options-rows.js）共用
// ui/provider-row.js 的 createProviderRow，本文件只提供 ASR 侧真实差异：
// 名称输入、可自由编辑的模型名文本输入、选用 radio、
// asr-providers-* 报文（连通性测试已直调 asr/provider-test.js，不再发消息）。
// 行内删除按钮与状态行复用 ai-provider-remove / ai-provider-status 类名
// （既有耦合，DOM 契约保持不变）。行构建器只依赖参数与回调，不直接访问 DOM 全局。

import { ASR_PROVIDER_PRESETS, type AsrProviderPreset } from "../core/presets.js";
import { escapeHtml } from "../shared/string-utils.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { testAsrConnection } from "../asr/provider-test.js";
import { createProviderRow, type ProviderRowElement, type ProviderRowItem, type ProviderRowPreset } from "./provider-row.js";
import { initCustomSelect } from "./custom-select.js";

const ASR_STATUS_SUCCESS_MIN_MS = 2000;

// 模型名字段：所有预设均为可自由编辑的文本输入（含 SiliconFlow），
// 默认值取预设 model，用户可改填任意模型名。
function buildAsrModelField(_preset: ProviderRowPreset | null, model: string): string {
  return `<input class="asr-provider-model" type="text" placeholder="模型名（如 FunAudioLLM/SenseVoiceSmall）" value="${escapeHtml(model)}" />`;
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
    // 模型名与名称无条件跟随——上一平台的模型对新平台无意义；
    // API Key 输入框清空，避免旧平台的 Key 在测试/保存时误发给新平台。
    (row.querySelector(".asr-provider-model") as HTMLInputElement).value = next.model || "";
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
  // 连通性测试直调 asr/provider-test.js（不再走 asr-providers-test 消息往返）：
  // options 页同属扩展 context，host_permissions 生效，跨域 fetch 无需 SW 中转；
  // Key 代查（重输优先、否则按 providerId 读已存 Key）收口在探针入口内。
  runTestProbe: ({ row, presets, baseUrl, apiKey, model }) => {
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
    // 仅用户重输 Key 时携带，未重输则探针按 id 读已存 Key
    if (apiKey) {
      provider.apiKey = apiKey;
    }
    return testAsrConnection(provider);
  },
  buildDeleteMessage: (providerId) => ({ type: "asr-providers-delete", providerId })
});

function convertRowPresetToCustom(row: HTMLElement): void {
  const select = row.querySelector(".asr-provider-preset") as HTMLSelectElement | null;
  if (select && select.dataset.customSelectInitialized !== "1") {
    initCustomSelect(select, "custom-select-wrapper asr-preset-wrapper");
  }
}

export function renderAsrProviders(
  listNode: HTMLElement,
  emptyNode: HTMLElement,
  items: ProviderRowItem[] | null | undefined,
  { presets = ASR_PROVIDER_PRESETS, activeId = "" }: { presets?: readonly AsrProviderPreset[]; activeId?: string } = {}
): void {
  asrProviderRow.render(listNode, emptyNode, items, { presets, activeId });
  listNode.querySelectorAll<HTMLElement>(".asr-provider-row").forEach((row) => {
    convertRowPresetToCustom(row);
  });
}

export function addAsrProviderRow(listNode: HTMLElement, emptyNode: HTMLElement, item: ProviderRowItem = {}, { presets = ASR_PROVIDER_PRESETS, activeId = "" }: { presets?: readonly AsrProviderPreset[]; activeId?: string } = {}): void {
  asrProviderRow.add(listNode, emptyNode, item, { presets, activeId });
  const rows = listNode.querySelectorAll<HTMLElement>(".asr-provider-row");
  const lastRow = rows[rows.length - 1];
  if (lastRow) {
    convertRowPresetToCustom(lastRow);
  }
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
