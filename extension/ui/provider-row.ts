// extension/ui/provider-row.ts
// AI 平台行与 ASR 平台行构建器的共享工厂 createProviderRow。
// 两套行构建器此前互为平行克隆（options-rows.js 的 AI 平台部分 / options-asr-rows.js 全文），
// 以下骨架完全一致，由工厂统一持有：
// - 行骨架：预设下拉 / baseUrl / API Key / 操作行（测试 + 行内状态 <p> + 删除，
//   三者同排一条 flex 行）/ 删除（确认 + 后台消息）；
// - 预设切换的 baseUrl 跟随规则：未改过 baseUrl（空或仍是上一预设默认值）才跟随新预设；
// - 测试连接流程：校验 → 探针（注入 runTestProbe 直调，或经运行时消息）→
//   成功后回调保存 → 重查行显示"连接成功"；
// - 成功状态：禁用行内 input/button 并在 successMinMs 后恢复（错误状态不自动恢复）；
// - 空态切换与 id 生成（仅前缀不同）。
// 真实差异通过参数注入：字段构成（headerFields / modelField / tailFields）、
// 预设解析回退、模型值解析、Key 占位符、报文形状、预设切换附加行为、行级附加接线。
// 行构建器只依赖参数与回调，不直接访问 DOM 全局。

import { escapeHtml } from "../shared/string-utils.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import type { BackgroundMessage, ContentScriptMessage } from "../shared/messaging-protocol.js";

// 垃圾桶图标路径：固定属性行 / 笔记段落行 / AI 平台行 / ASR 平台行共用同一份
// path 定义（此前在 options-rows.js 与 options-asr-rows.js 各自内联了 4 份）。
export const TRASH_ICON_PATHS: string = [
  '<path d="M4 7h16"></path>',
  '<path d="M9 3h6"></path>',
  '<path d="M10 11v6"></path>',
  '<path d="M14 11v6"></path>',
  '<path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>'
].join("");

// 行元素：HTMLElement 之上承载行级动态状态——dataset 三键
//（providerId / hasSavedKey / currentPresetId，模板渲染时写入）与 statusTimerKey
// 指定的恢复定时器槽位（showStatus 成功态写入、触发时清空）。索引签名仅
// 为 statusTimerKey 的动态键读写服务。
export type ProviderRowElement = HTMLElement & Record<string, unknown>;

// 平台行条目的宽松形状：AI / ASR 两条真实配置与测试注入的字面量对象都按
// 此结构传入；行骨架只读列出的字段，其余字段（如 enabled/apiKey/type）随
// 保存流程透传，不在骨架内消费。
export interface ProviderRowItem {
  id?: string;
  presetId?: string;
  name?: string;
  baseUrl?: string;
  model?: string;
  type?: string;
  requiresKey?: boolean;
  enabled?: boolean;
  apiKey?: string;
  hasSavedKey?: boolean;
}

// 平台预设的结构子集（工厂骨架读取 id/name/baseUrl，注入回调按需读取
// model/requiresKey/modelOptions/type）：AiProviderPreset（core/presets）与
// AsrProviderPreset 均按结构兼容传入。
export interface ProviderRowPreset {
  id: string;
  name: string;
  baseUrl: string;
  model?: string;
  type?: string;
  requiresKey?: boolean;
  modelOptions?: Array<{ value: string; label: string }>;
}

// 行内状态 <p> 的写入口（wireRowExtras 注入用）：node 允许缺失（缺失即静默）。
export type ProviderRowShowStatus = (
  node: HTMLElement | null | undefined,
  text: string,
  isError?: boolean
) => void;

// 测试成功 / 删除后回调：由调用页注入，避免行构建器耦合保存流程。
export type ProviderRowHandler = (providerId: string) => Promise<void> | void;
// 删除动作前先执行的钩子（调用页注入 chrome.permissions.remove 回收 origin，
// 需要在被删行摘出 DOM 之前拿到它的 baseUrl）。
export type ProviderRowBeforeDeleteHandler = (
  providerId: string,
  baseUrl: string
) => Promise<void> | void;

export interface CreateProviderRowConfig {
  rowClass: string;
  presetClass: string;
  presetSelectTitle: string;
  baseUrlClass: string;
  baseUrlPlaceholder: string;
  apikeyClass: string;
  modelClass: string;
  testClass: string;
  removeClass: string;
  statusClass: string;
  idPrefix: string;
  statusSuccessMinMs: number;
  statusTimerKey: string;
  resolvePreset: (presets: readonly ProviderRowPreset[], presetId: string) => ProviderRowPreset | null;
  resolveModel: (item: ProviderRowItem, preset: ProviderRowPreset | null) => string;
  apiKeyPlaceholder: (ctx: { item: ProviderRowItem; preset: ProviderRowPreset | null; hasSavedKey: boolean }) => string;
  buildHeaderFields?: (ctx: { item: ProviderRowItem; preset: ProviderRowPreset | null }) => string;
  buildModelField: (preset: ProviderRowPreset | null, model: string) => string;
  buildTailFields?: (ctx: { id: string; isActive: boolean }) => string;
  onPresetChange?: (row: ProviderRowElement, previousPreset: ProviderRowPreset | null, next: ProviderRowPreset) => void;
  wireRowExtras?: (row: ProviderRowElement, ctx: { listNode: HTMLElement; showStatus: ProviderRowShowStatus }) => void;
  buildTestPayload?: (ctx: {
    row: ProviderRowElement;
    presets: readonly ProviderRowPreset[];
    baseUrl: string;
    apiKey: string;
    model: string;
  }) => BackgroundMessage | ContentScriptMessage;
  runTestProbe?: (ctx: {
    row: ProviderRowElement;
    presets: readonly ProviderRowPreset[];
    baseUrl: string;
    apiKey: string;
    model: string;
  }) => Promise<{ ok?: boolean; error?: string }>;
  buildDeleteMessage: (providerId: string) => BackgroundMessage | ContentScriptMessage;
}

export interface ProviderRowController {
  generateId: () => string;
  render: (
    listNode: HTMLElement,
    emptyNode: HTMLElement,
    items: unknown,
    addOptions?: { presets?: readonly ProviderRowPreset[]; activeId?: string }
  ) => ProviderRowItem[];
  add: (
    listNode: HTMLElement,
    emptyNode: HTMLElement,
    item?: ProviderRowItem,
    addOptions?: { presets?: readonly ProviderRowPreset[]; activeId?: string }
  ) => void;
  showStatus: ProviderRowShowStatus;
  updateEmptyState: (listNode: HTMLElement, emptyNode: HTMLElement) => void;
  setTestSuccessHandler: (handler: ProviderRowHandler) => void;
  setDeleteHandler: (handler: ProviderRowHandler) => void;
  setBeforeDeleteHandler: (handler: ProviderRowBeforeDeleteHandler) => void;
}

export function createProviderRow({
  rowClass,
  presetClass,
  presetSelectTitle,
  baseUrlClass,
  baseUrlPlaceholder,
  apikeyClass,
  modelClass,
  testClass,
  removeClass,
  statusClass,
  idPrefix,
  statusSuccessMinMs,
  statusTimerKey,
  resolvePreset,
  resolveModel,
  apiKeyPlaceholder,
  buildHeaderFields,
  buildModelField,
  buildTailFields,
  onPresetChange,
  wireRowExtras,
  buildTestPayload,
  runTestProbe,
  buildDeleteMessage
}: CreateProviderRowConfig): ProviderRowController {
  // 测试成功 / 删除后的回调，由调用页注入，避免行构建器耦合保存流程
  let onTestSuccess: ProviderRowHandler = async () => {};
  let onDelete: ProviderRowHandler = async () => {};
  // 删除动作前先执行的钩子（调用页注入 chrome.permissions.remove 回收 origin，
  // 需要在被删行摘出 DOM 之前拿到它的 baseUrl）
  let onBeforeDelete: ProviderRowBeforeDeleteHandler = async () => {};

  function generateId(): string {
    return `${idPrefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function updateEmptyState(listNode: HTMLElement, emptyNode: HTMLElement): void {
    const hasRows = listNode.children.length > 0;
    emptyNode.hidden = hasRows;
  }

  function render(
    listNode: HTMLElement,
    emptyNode: HTMLElement,
    items: unknown,
    addOptions: { presets?: readonly ProviderRowPreset[]; activeId?: string } = {}
  ): ProviderRowItem[] {
    listNode.innerHTML = "";
    const list: ProviderRowItem[] = Array.isArray(items) ? (items as ProviderRowItem[]) : [];
    list.forEach((item) => add(listNode, emptyNode, item, addOptions));
    updateEmptyState(listNode, emptyNode);
    return list;
  }

  function add(
    listNode: HTMLElement,
    emptyNode: HTMLElement,
    item: ProviderRowItem = {},
    { presets = [], activeId = "" }: { presets?: readonly ProviderRowPreset[]; activeId?: string } = {}
  ): void {
    const id = String(item.id || generateId());
    const presetId = String(item.presetId || "custom");
    const preset = resolvePreset(presets, presetId);
    const baseUrl = String(item.baseUrl ?? preset?.baseUrl ?? "");
    const model = resolveModel(item, preset);
    const hasSavedKey = Boolean(item.hasSavedKey);
    const isActive = String(activeId || "") === id;

    const row = document.createElement("div") as unknown as ProviderRowElement;
    row.className = rowClass;
    row.dataset.providerId = id;
    row.dataset.hasSavedKey = hasSavedKey ? "1" : "0";
    row.dataset.currentPresetId = presetId;
    row.innerHTML = `
    <select class="${presetClass}" title="${presetSelectTitle}">
      ${presets.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === presetId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
    </select>
    ${buildHeaderFields ? buildHeaderFields({ item, preset }) : ""}
    <input class="${baseUrlClass}" type="text" placeholder="${baseUrlPlaceholder}" value="${escapeHtml(baseUrl)}" />
    <input class="${apikeyClass}" type="password" placeholder="${apiKeyPlaceholder({ item, preset, hasSavedKey })}" autocomplete="off" />
    ${buildModelField(preset, model)}
    ${buildTailFields ? buildTailFields({ id, isActive }) : ""}
    <div class="provider-row-actions">
      <button type="button" class="secondary-btn ${testClass}">测试</button>
      <p class="${statusClass}" hidden></p>
      <button type="button" class="${removeClass}" aria-label="删除" title="删除">
        <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">${TRASH_ICON_PATHS}</svg>
      </button>
    </div>
  `;

    // 预设切换：baseUrl 未改过（空或仍是上一预设默认值）时跟随新预设；
    // 其余字段行为（模型字段重建 / 名称跟随 / Key 清空或占位符更新）由配置注入。
    (row.querySelector(`.${presetClass}`) as HTMLSelectElement).addEventListener("change", (e) => {
      const previousPreset = presets.find((p) => p.id === row.dataset.currentPresetId) || null;
      const next = presets.find((p) => p.id === (e.target as HTMLSelectElement).value);
      if (!next) return;
      const baseUrlInput = row.querySelector(`.${baseUrlClass}`) as HTMLInputElement;
      const currentBaseUrl = baseUrlInput.value.trim();
      if (!currentBaseUrl || (previousPreset && currentBaseUrl === previousPreset.baseUrl)) {
        baseUrlInput.value = next.baseUrl;
      }
      onPresetChange?.(row, previousPreset, next);
      row.dataset.currentPresetId = next.id;
    });

    // 删除：确认后调后台删除；若删的是当前选用平台，清空选用态（onDelete 注入处理）。
    // onBeforeDelete 在被删行摘出 DOM 之前执行，注入方据此拿到该行当前的 baseUrl
    // 并回收 host 权限（chrome.permissions.remove 不需要用户手势）；钩子报错不
    // 阻断删除。
    row.querySelector(`.${removeClass}`)?.addEventListener("click", async () => {
      if (!confirm("确定要删除这个平台吗？")) return;
      const providerId = row.dataset.providerId || "";
      const baseUrl = (row.querySelector(`.${baseUrlClass}`) as HTMLInputElement | null)?.value.trim() || "";
      try {
        await onBeforeDelete(providerId, baseUrl);
      } catch {}
      if (providerId) {
        try {
          await sendRuntimeMessage(buildDeleteMessage(providerId));
        } catch {}
      }
      row.remove();
      updateEmptyState(listNode, emptyNode);
      if (typeof onDelete === "function") {
        onDelete(providerId);
      }
    });

    // 测试连接：按预设 type 走探针；成功时回调保存（由调用页注入 onTestSuccess）
    row.querySelector(`.${testClass}`)?.addEventListener("click", async () => {
      const statusNode = row.querySelector(`.${statusClass}`) as HTMLElement | null;
      const baseUrl = (row.querySelector(`.${baseUrlClass}`) as HTMLInputElement).value.trim();
      const apiKey = (row.querySelector(`.${apikeyClass}`) as HTMLInputElement).value.trim();
      const model = (row.querySelector(`.${modelClass}`) as HTMLInputElement).value.trim();
      if (!baseUrl) {
        showStatus(statusNode, "请填写 baseUrl", true);
        return;
      }
      if (!model) {
        showStatus(statusNode, "请填写模型名", true);
        return;
      }
      showStatus(statusNode, "正在测试...");
      // 探针执行可注入：AI / ASR 平台行均直调对应 provider-test.js（options
      // 页本地执行，免一次 SW 消息往返，见候选 04 拆链）；未注入时回退运行时消息。
      const resp = (runTestProbe
        ? await runTestProbe({ row, presets, baseUrl, apiKey, model })
        : await sendRuntimeMessage(buildTestPayload!({ row, presets, baseUrl, apiKey, model }))) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (resp?.ok) {
        const providerId = row.dataset.providerId || "";
        try {
          await onTestSuccess(providerId);
          const newRow = listNode.querySelector(`.${rowClass}[data-provider-id="${CSS.escape(providerId)}"]`) as HTMLElement | null;
          const newStatusNode = newRow?.querySelector(`.${statusClass}`) as HTMLElement | null | undefined;
          showStatus(newStatusNode, "连接成功");
        } catch (error) {
          showStatus(statusNode, `连接成功，但保存失败：${(error as Error).message || "未知错误"}`, true);
        }
      } else {
        showStatus(statusNode, `失败：${resp?.error || "未知错误"}`, true);
      }
    });

    wireRowExtras?.(row, { listNode, showStatus });

    listNode.appendChild(row);
    updateEmptyState(listNode, emptyNode);
  }

  // 成功状态：显示文本并在 successMinMs 后恢复被禁用的输入与按钮；错误状态不自动恢复
  function showStatus(node: HTMLElement | null | undefined, text: string, isError = false): void {
    if (!node) return;
    node.hidden = false;
    node.textContent = text;
    node.dataset.error = isError ? "true" : "false";

    if (!isError && statusSuccessMinMs > 0) {
      const row = node.closest(`.${rowClass}`) as ProviderRowElement | null;
      if (!row) return;

      if (row[statusTimerKey]) clearTimeout(row[statusTimerKey] as number);

      const inputs = row.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button");
      const previouslyDisabled = Array.from(inputs).map((el) => el.disabled);
      inputs.forEach((el) => (el.disabled = true));

      row[statusTimerKey] = setTimeout(() => {
        row[statusTimerKey] = null;
        inputs.forEach((el, index) => {
          if (previouslyDisabled[index] !== undefined) el.disabled = previouslyDisabled[index];
        });
      }, statusSuccessMinMs);
    }
  }

  return {
    generateId,
    render,
    add,
    showStatus,
    updateEmptyState,
    setTestSuccessHandler(handler) {
      onTestSuccess = handler;
    },
    setDeleteHandler(handler) {
      onDelete = handler;
    },
    setBeforeDeleteHandler(handler) {
      onBeforeDelete = handler;
    }
  };
}
