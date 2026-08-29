// extension/ui/provider-row.js
// AI 平台行与 ASR 平台行构建器的共享工厂 createProviderRow。
// 两套行构建器此前互为平行克隆（options-rows.js 的 AI 平台部分 / options-asr-rows.js 全文），
// 以下骨架完全一致，由工厂统一持有：
// - 行骨架：预设下拉 / baseUrl / API Key / 测试 / 删除（确认 + 后台消息）/ 行内状态 <p>；
// - 预设切换的 baseUrl 跟随规则：未改过 baseUrl（空或仍是上一预设默认值）才跟随新预设；
// - 测试连接流程：校验 → 探针消息 → 成功后回调保存 → 重查行显示"连接成功"；
// - 成功状态：禁用行内 input/button 并在 successMinMs 后恢复（错误状态不自动恢复）；
// - 空态切换与 id 生成（仅前缀不同）。
// 真实差异通过参数注入：字段构成（headerFields / modelField / tailFields）、
// 预设解析回退、模型值解析、Key 占位符、报文形状、预设切换附加行为、行级附加接线。
// 行构建器只依赖参数与回调，不直接访问 DOM 全局。

import { escapeHtml } from "../shared/string-utils.js";
import { sendRuntimeMessage } from "../shared/messaging.js";

// 垃圾桶图标路径：固定属性行 / 笔记段落行 / AI 平台行 / ASR 平台行共用同一份
// path 定义（此前在 options-rows.js 与 options-asr-rows.js 各自内联了 4 份）。
export const TRASH_ICON_PATHS = [
  '<path d="M4 7h16"></path>',
  '<path d="M9 3h6"></path>',
  '<path d="M10 11v6"></path>',
  '<path d="M14 11v6"></path>',
  '<path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>'
].join("");

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
  buildDeleteMessage
}) {
  // 测试成功 / 删除后的回调，由调用页注入，避免行构建器耦合保存流程
  let onTestSuccess = async () => {};
  let onDelete = async () => {};

  function generateId() {
    return `${idPrefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function updateEmptyState(listNode, emptyNode) {
    const hasRows = listNode.children.length > 0;
    emptyNode.hidden = hasRows;
  }

  function render(listNode, emptyNode, items, addOptions = {}) {
    listNode.innerHTML = "";
    const list = Array.isArray(items) ? items : [];
    list.forEach((item) => add(listNode, emptyNode, item, addOptions));
    updateEmptyState(listNode, emptyNode);
    return list;
  }

  function add(listNode, emptyNode, item = {}, { presets = [], activeId = "" } = {}) {
    const id = String(item.id || generateId());
    const presetId = String(item.presetId || "custom");
    const preset = resolvePreset(presets, presetId);
    const baseUrl = String(item.baseUrl ?? preset?.baseUrl ?? "");
    const model = resolveModel(item, preset);
    const hasSavedKey = Boolean(item.hasSavedKey);
    const isActive = String(activeId || "") === id;

    const row = document.createElement("div");
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
    <button type="button" class="secondary-btn ${testClass}">测试</button>
    <button type="button" class="${removeClass}" aria-label="删除" title="删除">
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">${TRASH_ICON_PATHS}</svg>
    </button>
    <p class="${statusClass}" hidden></p>
  `;

    // 预设切换：baseUrl 未改过（空或仍是上一预设默认值）时跟随新预设；
    // 其余字段行为（模型字段重建 / 名称跟随 / Key 清空或占位符更新）由配置注入。
    row.querySelector(`.${presetClass}`).addEventListener("change", (e) => {
      const previousPreset = presets.find((p) => p.id === row.dataset.currentPresetId) || null;
      const next = presets.find((p) => p.id === e.target.value);
      if (!next) return;
      const baseUrlInput = row.querySelector(`.${baseUrlClass}`);
      const currentBaseUrl = baseUrlInput.value.trim();
      if (!currentBaseUrl || (previousPreset && currentBaseUrl === previousPreset.baseUrl)) {
        baseUrlInput.value = next.baseUrl;
      }
      onPresetChange?.(row, previousPreset, next);
      row.dataset.currentPresetId = next.id;
    });

    // 删除：确认后调后台删除；若删的是当前选用平台，清空选用态（onDelete 注入处理）
    row.querySelector(`.${removeClass}`)?.addEventListener("click", async () => {
      if (!confirm("确定要删除这个平台吗？")) return;
      const providerId = row.dataset.providerId || "";
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
      const statusNode = row.querySelector(`.${statusClass}`);
      const baseUrl = row.querySelector(`.${baseUrlClass}`).value.trim();
      const apiKey = row.querySelector(`.${apikeyClass}`).value.trim();
      const model = row.querySelector(`.${modelClass}`).value.trim();
      if (!baseUrl) {
        showStatus(statusNode, "请填写 baseUrl", true);
        return;
      }
      if (!model) {
        showStatus(statusNode, "请填写模型名", true);
        return;
      }
      showStatus(statusNode, "正在测试...");
      const resp = await sendRuntimeMessage(buildTestPayload({ row, presets, baseUrl, apiKey, model }));
      if (resp?.ok) {
        const providerId = row.dataset.providerId || "";
        try {
          await onTestSuccess(providerId);
          const newRow = listNode.querySelector(`.${rowClass}[data-provider-id="${CSS.escape(providerId)}"]`);
          const newStatusNode = newRow?.querySelector(`.${statusClass}`);
          showStatus(newStatusNode, "连接成功");
        } catch (error) {
          showStatus(statusNode, `连接成功，但保存失败：${error.message || "未知错误"}`, true);
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
  function showStatus(node, text, isError = false) {
    if (!node) return;
    node.hidden = false;
    node.textContent = text;
    node.dataset.error = isError ? "true" : "false";

    if (!isError && statusSuccessMinMs > 0) {
      const row = node.closest(`.${rowClass}`);
      if (!row) return;

      if (row[statusTimerKey]) clearTimeout(row[statusTimerKey]);

      const inputs = row.querySelectorAll("input, button");
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
    }
  };
}
