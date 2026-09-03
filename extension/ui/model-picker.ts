// extension/ui/model-picker.ts
// 模型名「文本输入 + 下拉拉取」组合控件：AI 平台行（options-rows.js）与
// ASR 平台行（options-asr-rows.js）共用。点击 toggle 从 baseUrl 拉取可用
// 模型列表，选中写回输入框；手输模型或选中选项时收起下拉。
//
// DOM 契约沿用 AI 侧既有类名（ai-provider-model-wrapper / -toggle /
// -dropdown / -option / -message / -error / -loading / -count），reader.css
// 样式与 settings-panel 的全局收起逻辑（点外部关闭 .ai-provider-model-dropdown）
// 因此对两侧同时生效——与 ASR 行复用 ai-provider-remove / ai-provider-status
// 的既有耦合同理。只有输入框类名按行型注入（ai-provider-model /
// asr-provider-model），供收集/探针逻辑按行型取值。

import { escapeHtml } from "../shared/string-utils.js";
import type { ProviderRowElement, ProviderRowShowStatus } from "./provider-row.js";

export interface ModelPickerFieldOptions {
  inputClass: string;
  placeholder: string;
  value: string;
}

export function buildModelPickerField({ inputClass, placeholder, value }: ModelPickerFieldOptions): string {
  return `
    <div class="ai-provider-model-wrapper">
      <input class="${inputClass}" type="text" placeholder="${placeholder}" value="${escapeHtml(value)}" />
      <button type="button" class="ai-provider-model-toggle" title="从 baseUrl 拉取可用模型" aria-label="从 baseUrl 拉取可用模型">
        <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
          <path d="M6 9l6 6 6-6"></path>
        </svg>
      </button>
      <ul class="ai-provider-model-dropdown" hidden></ul>
    </div>`;
}

export interface ModelPickerFetchContext {
  baseUrl: string;
  apiKey: string;
  providerId: string;
}

export interface ModelPickerFetchResult {
  ok?: boolean;
  models?: string[];
  error?: string;
}

export interface WireModelPickerOptions {
  inputClass: string;
  baseUrlClass: string;
  apiKeyClass: string;
  statusClass: string;
  showStatus: ProviderRowShowStatus;
  fetchModels: (ctx: ModelPickerFetchContext) => Promise<ModelPickerFetchResult | null>;
}

export function wireModelPicker(
  row: ProviderRowElement,
  { inputClass, baseUrlClass, apiKeyClass, statusClass, showStatus, fetchModels }: WireModelPickerOptions
): void {
  row.querySelector(".ai-provider-model-toggle")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    const statusNode = row.querySelector(`.${statusClass}`) as HTMLElement | null;
    const baseUrl = (row.querySelector(`.${baseUrlClass}`) as HTMLInputElement).value.trim();
    const apiKey = (row.querySelector(`.${apiKeyClass}`) as HTMLInputElement).value.trim();
    const modelInput = row.querySelector(`.${inputClass}`) as HTMLInputElement;
    const dropdown = row.querySelector(".ai-provider-model-dropdown") as HTMLElement;

    if (!baseUrl) {
      showStatus(statusNode, "请先填写 baseUrl", true);
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
      const resp = await fetchModels({
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
      const message = (error as Error).message;
      if (message && message.includes("port closed")) {
        li.textContent = "连接中断，请重试";
      } else {
        li.textContent = message || "拉取失败";
      }
      dropdown.appendChild(li);
    }
  });

  row.querySelector(`.${inputClass}`)?.addEventListener("input", () => {
    const dropdown = row.querySelector(".ai-provider-model-dropdown") as HTMLElement | null;
    if (dropdown) dropdown.hidden = true;
  });

  row.querySelector(".ai-provider-model-dropdown")?.addEventListener("click", (e) => {
    const option = (e.target as HTMLElement).closest(".ai-provider-model-option") as HTMLElement | null;
    if (!option) return;
    e.stopPropagation();
    const modelInput = row.querySelector(`.${inputClass}`);
    if (modelInput && option.dataset.model) {
      (modelInput as HTMLInputElement).value = option.dataset.model;
    }
    if (modelInput) modelInput.classList.remove("input-error");
    const dropdown = row.querySelector(".ai-provider-model-dropdown") as HTMLElement | null;
    if (dropdown) dropdown.hidden = true;
  });
}

export function closeAllModelDropdowns(): void {
  document.querySelectorAll<HTMLElement>(".ai-provider-model-dropdown").forEach((dropdown) => {
    dropdown.hidden = true;
  });
}
