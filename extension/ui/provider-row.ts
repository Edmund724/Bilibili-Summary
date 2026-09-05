// extension/ui/provider-row.ts
// AI 平台行与 ASR 平台行构建器的共享工厂 createProviderRow（紧凑形态，
// provider-master-detail/02）：行是纯展示 + 入口——Key 状态点 + 名称 +
// 模型名 +（ASR）选用 radio +「编辑 / 删除」两个动作，行内零输入字段。
// 编辑（预设 / baseUrl / API Key / 模型 / 测试）全部在 ui/provider-editor.js
// 的 Modal 里（01），保存走单平台 upsert（settings-panel.saveProviderSingle）。
//
// 与 01 前的平铺形态相比退役的职责：预设下拉 / 行内编辑字段收集
//（collectAiProviders / collectAsrProviders 已删，列表真相在后端）/ 连通性
// 测试与行内状态（探针随 Modal）/ 模型下拉（model-picker 随 Modal）。
// 此前 ASR 行复用 ai-provider-remove / ai-provider-status 类名的既有耦合
// 随行内状态行退役一并收口：删除按钮统一 provider-row-remove。
//
// 两行差异通过参数注入：显示名 / 模型名的解析、（ASR）选用 radio 及其
// 即时持久化回调、删除报文。行构建器只依赖参数与回调，不直接访问 DOM 全局。

import { escapeHtml } from "../shared/string-utils.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import type { BackgroundMessage, ContentScriptMessage } from "../shared/messaging-protocol.js";

// 垃圾桶图标路径：固定属性行 / 笔记段落行 / 平台行共用同一份 path 定义。
export const TRASH_ICON_PATHS: string = [
  '<path d="M4 7h16"></path>',
  '<path d="M9 3h6"></path>',
  '<path d="M10 11v6"></path>',
  '<path d="M14 11v6"></path>',
  '<path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>'
].join("");

// 行元素：HTMLElement 之上承载行级 dataset——providerId / hasSavedKey /
// currentPresetId / baseUrl（删除回收 host 权限时钩子要从行上拿到 baseUrl，
// 紧凑行没有输入框，渲染时写入）。索引签名仅为将来的动态键读写兜底。
export type ProviderRowElement = HTMLElement & Record<string, unknown>;

// 平台行条目的宽松形状：AI / ASR 两条真实配置与测试注入的字面量对象都按
// 此结构传入；行骨架只读列出的字段，其余字段（如 enabled/apiKey/type）不在
// 行内消费（编辑走 Modal 的权威现查）。
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

// 平台预设的结构子集：AiProviderPreset（core/presets）与 AsrProviderPreset
// 均按结构兼容传入。
export interface ProviderRowPreset {
  id: string;
  name: string;
  baseUrl: string;
  model?: string;
  type?: string;
  requiresKey?: boolean;
}

// 行内状态 <p> 的写入口（wireModelPicker 注入用）：行内状态行已随紧凑形态
// 退役，但 ui/provider-editor.js 的 Modal 仍以此签名接入 model-picker。
export type ProviderRowShowStatus = (
  node: HTMLElement | null | undefined,
  text: string,
  isError?: boolean
) => void;

// 删除动作前先执行的钩子（调用页注入 chrome.permissions.remove 回收 origin，
// 需要在被删行摘出 DOM 之前拿到它的 baseUrl——行 dataset 提供）。
export type ProviderRowBeforeDeleteHandler = (
  providerId: string,
  baseUrl: string
) => Promise<void> | void;

// 删除完成后的回调（ASR：删的是当前选用平台时清 activeAsrProviderId）。
export type ProviderRowHandler = (providerId: string) => Promise<void> | void;

export interface CreateProviderRowConfig {
  rowClass: string;
  editClass: string;
  removeClass: string;
  idPrefix: string;
  resolvePreset: (presets: readonly ProviderRowPreset[], presetId: string) => ProviderRowPreset | null;
  // 显示名：AI=自定义名回落预设名（拍板 Q7）；ASR=名称回落预设名/自定义
  displayName: (item: ProviderRowItem, preset: ProviderRowPreset | null) => string;
  // 显示模型名：AI=item.model；ASR=item.model ?? preset.model。空串不渲染副行
  displayModel: (item: ProviderRowItem, preset: ProviderRowPreset | null) => string;
  // （仅 ASR）选用 radio：change 即时持久化 activeAsrProviderId（平铺形态同款语义）
  buildTailFields?: (ctx: { id: string; isActive: boolean }) => string;
  wireTailExtras?: (row: ProviderRowElement, ctx: { listNode: HTMLElement }) => void;
  onRowEdit: (row: ProviderRowElement) => void;
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
  updateEmptyState: (listNode: HTMLElement, emptyNode: HTMLElement) => void;
  setDeleteHandler: (handler: ProviderRowHandler) => void;
  setBeforeDeleteHandler: (handler: ProviderRowBeforeDeleteHandler) => void;
}

export function createProviderRow({
  rowClass,
  editClass,
  removeClass,
  idPrefix,
  resolvePreset,
  displayName,
  displayModel,
  buildTailFields,
  wireTailExtras,
  onRowEdit,
  buildDeleteMessage
}: CreateProviderRowConfig): ProviderRowController {
  let onDelete: ProviderRowHandler = async () => {};
  // 删除动作前先执行的钩子（调用页注入回收 origin，需要被删行的 baseUrl）
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
    list.forEach((item) => {
      const id = String(item.id || generateId());
      const presetId = String(item.presetId || "custom");
      const preset = resolvePreset(addOptions.presets || [], presetId);
      const baseUrl = String(item.baseUrl ?? preset?.baseUrl ?? "");
      const hasSavedKey = Boolean(item.hasSavedKey);
      const isActive = String(addOptions.activeId || "") === id;

      const row = document.createElement("div") as unknown as ProviderRowElement;
      row.className = rowClass;
      row.dataset.providerId = id;
      row.dataset.hasSavedKey = hasSavedKey ? "1" : "0";
      row.dataset.currentPresetId = presetId;
      row.dataset.baseUrl = baseUrl;

      const model = displayModel(item, preset);
      row.innerHTML = `
        <div class="provider-row-line">
          <span class="provider-row-dot" data-state="${hasSavedKey ? "saved" : "missing"}" title="${hasSavedKey ? "已保存 API Key" : "未保存 API Key"}"></span>
          <span class="provider-row-name">${escapeHtml(displayName(item, preset))}</span>
          ${buildTailFields ? buildTailFields({ id, isActive }) : ""}
          <button type="button" class="${editClass}">编辑</button>
          <button type="button" class="${removeClass}" aria-label="删除" title="删除">
            <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">${TRASH_ICON_PATHS}</svg>
          </button>
        </div>
        ${model ? `<div class="provider-row-model" title="${escapeHtml(model)}">${escapeHtml(model)}</div>` : ""}
      `;

      // 编辑：打开 provider-editor Modal（回调由配置注入）
      row.querySelector(`.${editClass}`)?.addEventListener("click", () => {
        onRowEdit?.(row);
      });

      // 删除：确认后调后台删除；若删的是当前选用平台，清空选用态（onDelete 注入
      // 处理）。onBeforeDelete 在被删行摘出 DOM 之前执行，注入方据此拿到该行的
      // baseUrl 回收 host 权限（chrome.permissions.remove 不需要用户手势）；钩子
      // 报错不阻断删除。
      row.querySelector(`.${removeClass}`)?.addEventListener("click", async () => {
        if (!confirm("确定要删除这个平台吗？")) return;
        const providerId = row.dataset.providerId || "";
        try {
          await onBeforeDelete(providerId, row.dataset.baseUrl || "");
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

      wireTailExtras?.(row, { listNode });

      listNode.appendChild(row);
    });
    updateEmptyState(listNode, emptyNode);
    return list;
  }

  return {
    generateId,
    render,
    updateEmptyState,
    setDeleteHandler(handler) {
      onDelete = handler;
    },
    setBeforeDeleteHandler(handler) {
      onBeforeDelete = handler;
    }
  };
}
