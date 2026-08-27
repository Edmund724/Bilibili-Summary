// extension/ui/options-asr-rows.js
// 设置页"语音转写平台"区块行构建器，平行克隆自 options-rows.js 的 AI 平台部分：
// 预设下拉 → 自动填充 baseUrl/model/type；name 可编辑；Key 密码输入（已存时占位"已保存"）；
// 编辑/删除（确认）/测试连接；radio 选择当前选用平台；行内状态行复用 ai-provider-status 样式。
// 行构建器只依赖参数与回调，不直接访问 DOM 全局。

import { ASR_PROVIDER_PRESETS, ASR_LANGUAGE_OPTIONS } from "../core/shared-defaults.js";
import { escapeHtml } from "../shared/string-utils.js";
import { sendRuntimeMessage } from "../core/runtime.js";

const ASR_STATUS_SUCCESS_MIN_MS = 2000;

function generateAsrProviderId() {
  return `asr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function renderAsrProviders(listNode, emptyNode, items, { presets = ASR_PROVIDER_PRESETS, activeId = "" } = {}) {
  listNode.innerHTML = "";
  const list = Array.isArray(items) ? items : [];
  list.forEach((item) => addAsrProviderRow(listNode, emptyNode, item, { presets, activeId }));
  updateAsrProvidersEmptyState(listNode, emptyNode);
}

function updateAsrProvidersEmptyState(listNode, emptyNode) {
  const hasRows = listNode.children.length > 0;
  emptyNode.hidden = hasRows;
}

// 模型名字段：预设带 modelOptions 时渲染为下拉框（如 SiliconFlow 的 ASR 模型），
// 否则保持可自由编辑的文本输入，供本地 Whisper / 自定义端点使用。
function buildAsrModelField(preset, model) {
  const modelOptions = Array.isArray(preset?.modelOptions) && preset.modelOptions.length > 0
    ? preset.modelOptions
    : null;
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

// 转写语言档位下拉：auto（自动检测）/ zh / en。英文视频必须选 English——
// SiliconFlow 辰星 / SenseVoice 只有传 ?language=english 才走英文转写，
// 否则纯英文音频静默返回空文本（表现为"未识别到语音内容"）。
function buildAsrLanguageField(language) {
  const current = String(language || "auto");
  const optionsHtml = ASR_LANGUAGE_OPTIONS.map((o) => {
    const value = String(o?.value ?? "");
    return `<option value="${escapeHtml(value)}" ${value === current ? "selected" : ""}>${escapeHtml(o?.label ?? value)}</option>`;
  }).join("");
  return `<select class="asr-provider-language" title="转写语言">${optionsHtml}</select>`;
}

export function addAsrProviderRow(listNode, emptyNode, item = {}, { presets = ASR_PROVIDER_PRESETS, activeId = "" } = {}) {
  const id = String(item.id || generateAsrProviderId());
  const presetId = String(item.presetId || "custom");
  const preset = presets.find((p) => p.id === presetId) || null;
  const baseUrl = String(item.baseUrl ?? preset?.baseUrl ?? "");
  const name = String(item.name || preset?.name || "自定义");
  const model = String(item.model ?? preset?.model ?? "");
  const hasSavedKey = Boolean(item.hasSavedKey);
  const isActive = String(activeId || "") === id;

  const row = document.createElement("div");
  row.className = "asr-provider-row";
  row.dataset.providerId = id;
  row.dataset.hasSavedKey = hasSavedKey ? "1" : "0";
  row.dataset.currentPresetId = presetId;
  row.innerHTML = `
    <select class="asr-provider-preset" title="平台预设">
      ${presets.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === presetId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
    </select>
    <input class="asr-provider-name" type="text" placeholder="平台名称" value="${escapeHtml(name)}" />
    <input class="asr-provider-baseurl" type="text" placeholder="baseUrl（如 https://api.siliconflow.cn/v1）" value="${escapeHtml(baseUrl)}" />
    <input class="asr-provider-apikey" type="password" placeholder="${hasSavedKey ? "已保存" : "API Key"}" autocomplete="off" />
    ${buildAsrModelField(preset, model)}
    ${buildAsrLanguageField(item.language)}
    <label class="asr-provider-active" title="选用该平台自动生成字幕">
      <input class="asr-provider-active-radio" type="radio" name="asrActiveProvider" ${isActive ? "checked" : ""} />
      选用
    </label>
    <button type="button" class="secondary-btn asr-provider-test">测试</button>
    <button type="button" class="ai-provider-remove" aria-label="删除" title="删除">
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <path d="M4 7h16"></path>
        <path d="M9 3h6"></path>
        <path d="M10 11v6"></path>
        <path d="M14 11v6"></path>
        <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>
      </svg>
    </button>
    <p class="ai-provider-status" hidden></p>
  `;

  // 预设切换：baseUrl 未改过（空或仍是上一预设默认值）时跟随新预设；
  // 模型名与名称无条件跟随——上一平台的模型对新平台无意义；
  // API Key 输入框清空，避免旧平台的 Key 在测试/保存时误发给新平台。
  row.querySelector(".asr-provider-preset").addEventListener("change", (e) => {
    const previousPreset = presets.find((p) => p.id === row.dataset.currentPresetId) || null;
    const next = presets.find((p) => p.id === e.target.value);
    if (!next) return;
    const baseUrlInput = row.querySelector(".asr-provider-baseurl");
    const currentBaseUrl = baseUrlInput.value.trim();
    if (!currentBaseUrl || (previousPreset && currentBaseUrl === previousPreset.baseUrl)) {
      baseUrlInput.value = next.baseUrl;
    }
    // 模型名随预设切换重建：带 modelOptions 的预设渲染为下拉框，否则为文本输入。
    row.querySelector(".asr-provider-model").outerHTML = buildAsrModelField(next, next.model || "");
    // 语言档位随预设切换回落预设默认值（SiliconFlow 默认 zh，其余 auto）。
    const languageSelect = row.querySelector(".asr-provider-language");
    if (languageSelect) {
      languageSelect.value = next?.language || "auto";
    }
    row.querySelector(".asr-provider-name").value = next.name || "";
    row.querySelector(".asr-provider-apikey").value = "";
    row.dataset.currentPresetId = next.id;
  });

  // 测试连接：按 type 走票 01 探针；成功时回调保存（由 options.js 注入 setAsrTestSuccessHandler）
  row.querySelector(".asr-provider-test")?.addEventListener("click", async () => {
    const statusNode = row.querySelector(".ai-provider-status");
    const baseUrl = row.querySelector(".asr-provider-baseurl").value.trim();
    const apiKey = row.querySelector(".asr-provider-apikey").value.trim();
    const model = row.querySelector(".asr-provider-model").value.trim();
    if (!baseUrl) {
      showAsrProviderStatus(statusNode, "请填写 baseUrl", true);
      return;
    }
    if (!model) {
      showAsrProviderStatus(statusNode, "请填写模型名", true);
      return;
    }
    showAsrProviderStatus(statusNode, "正在测试...");
    const preset = presets.find((p) => p.id === row.dataset.currentPresetId) || null;
    const provider = {
      id: row.dataset.providerId || "",
      name: row.querySelector(".asr-provider-name").value.trim() || "自定义",
      type: preset?.type || "openai-transcriptions",
      baseUrl,
      model
    };
    // 仅用户重输 Key 时携带，未重输则后台按 id 读已存 Key
    if (apiKey) {
      provider.apiKey = apiKey;
    }
    const resp = await sendRuntimeMessage({ type: "asr-providers-test", provider });
    if (resp?.ok) {
      const providerId = row.dataset.providerId || "";
      try {
        await onTestSuccess(providerId);
        const newRow = listNode.querySelector(`.asr-provider-row[data-provider-id="${CSS.escape(providerId)}"]`);
        const newStatusNode = newRow?.querySelector(".ai-provider-status");
        showAsrProviderStatus(newStatusNode, "连接成功");
      } catch (error) {
        showAsrProviderStatus(statusNode, `连接成功，但保存失败：${error.message || "未知错误"}`, true);
      }
    } else {
      showAsrProviderStatus(statusNode, `失败：${resp?.error || "未知错误"}`, true);
    }
  });

  // 删除：确认后调后台删除；若删的是当前选用平台，清空 activeAsrProviderId（onDelete 注入处理）
  row.querySelector(".ai-provider-remove")?.addEventListener("click", async () => {
    if (!confirm("确定要删除这个平台吗？")) return;
    const providerId = row.dataset.providerId || "";
    if (providerId) {
      try {
        await sendRuntimeMessage({ type: "asr-providers-delete", providerId });
      } catch {}
    }
    row.remove();
    updateAsrProvidersEmptyState(listNode, emptyNode);
    if (typeof onDelete === "function") {
      onDelete(providerId);
    }
  });

  // 选用：即时持久化 activeAsrProviderId
  row.querySelector(".asr-provider-active-radio")?.addEventListener("change", async () => {
    if (!row.querySelector(".asr-provider-active-radio").checked) return;
    const providerId = row.dataset.providerId || "";
    try {
      await sendRuntimeMessage({ type: "save-settings", settings: { activeAsrProviderId: providerId } });
    } catch {}
    setActiveAsrProvider(listNode, providerId);
  });

  listNode.appendChild(row);
  updateAsrProvidersEmptyState(listNode, emptyNode);
}

export function collectAsrProviders(listNode, { presets = ASR_PROVIDER_PRESETS, generateId = generateAsrProviderId } = {}) {
  return Array.from(listNode.querySelectorAll(".asr-provider-row")).map((row) => {
    const presetSelect = row.querySelector(".asr-provider-preset");
    const preset = presets.find((p) => p.id === presetSelect.value) || null;
    const apiKey = row.querySelector(".asr-provider-apikey").value.trim();
    const language = String(row.querySelector(".asr-provider-language")?.value || "auto");
    return {
      id: row.dataset.providerId || generateId(),
      presetId: preset?.id || "custom",
      name: row.querySelector(".asr-provider-name").value.trim() || preset?.name || "自定义",
      type: preset?.type || "openai-transcriptions",
      baseUrl: row.querySelector(".asr-provider-baseurl").value.trim().replace(/\/+$/, ""),
      model: row.querySelector(".asr-provider-model").value.trim(),
      // 语言档位：auto 回落预设默认值（SiliconFlow 预设默认 zh，其余 auto），
      // 保证英文视频切到 English 后不会被下一次保存静默重置。
      language: language === "auto" ? (preset?.language || "auto") : language,
      apiKey,
      hasSavedKey: row.dataset.hasSavedKey === "1"
    };
  });
}

// 把列表里 radio 选中态同步到指定平台 id（传空串则全部取消）
export function setActiveAsrProvider(listNode, activeId) {
  const target = String(activeId || "");
  listNode.querySelectorAll(".asr-provider-active-radio").forEach((radio) => {
    const row = radio.closest(".asr-provider-row");
    radio.checked = Boolean(row && row.dataset.providerId === target);
  });
}

// 当前列表选中的平台 id（无则空串）
export function getActiveAsrProviderId(listNode) {
  const checked = listNode.querySelector(".asr-provider-active-radio:checked");
  const row = checked?.closest(".asr-provider-row");
  return row?.dataset.providerId || "";
}

function showAsrProviderStatus(node, text, isError = false) {
  if (!node) return;
  node.hidden = false;
  node.textContent = text;
  node.dataset.error = isError ? "true" : "false";

  if (!isError && ASR_STATUS_SUCCESS_MIN_MS > 0) {
    const row = node.closest(".asr-provider-row");
    if (!row) return;

    if (row._asrStatusTimer) clearTimeout(row._asrStatusTimer);

    const inputs = row.querySelectorAll("input, button");
    const previouslyDisabled = Array.from(inputs).map((el) => el.disabled);
    inputs.forEach((el) => (el.disabled = true));

    row._asrStatusTimer = setTimeout(() => {
      row._asrStatusTimer = null;
      inputs.forEach((el, index) => {
        if (previouslyDisabled[index] !== undefined) el.disabled = previouslyDisabled[index];
      });
    }, ASR_STATUS_SUCCESS_MIN_MS);
  }
}

// 测试成功 / 删除后的回调，由 options.js 注入，避免行构建器耦合保存流程
let onTestSuccess = async () => {};
let onDelete = async () => {};

export function setAsrTestSuccessHandler(handler) {
  onTestSuccess = handler;
}

export function setAsrDeleteHandler(handler) {
  onDelete = handler;
}
