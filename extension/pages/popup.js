import {
  DEFAULT_SETTINGS,
  normalizeDownloadFormat,
  formatLocalDate,
  isSupportedBilibiliPage,
  sleep
} from "../core/shared-defaults.js";
import { escapeHtml, sanitizeFileName } from "../shared/string-utils.js";

const el = {
  status: document.getElementById("status"),
  message: document.getElementById("message"),
  propTitle: document.getElementById("propTitle"),
  propUrl: document.getElementById("propUrl"),
  propCreated: document.getElementById("propCreated"),
  propTags: document.getElementById("propTags"),
  subtitleSelect: document.getElementById("subtitleSelect"),
  preview: document.getElementById("preview"),
  refreshBtn: document.getElementById("refreshBtn"),
  copyBtn: document.getElementById("copyBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  readingViewBtn: document.getElementById("readingViewBtn"),
  aiBtn: document.getElementById("aiBtn"),
  settingsBtn: document.getElementById("settingsBtn")
};

let latestPayload = null;
const EXPECTED_CONTENT_SCRIPT_VERSION = chrome.runtime.getManifest().version || "";

init().catch((error) => {
  setStatus(`初始化失败：${error.message}`, true);
});

async function init() {
  bindEvents();
  await refreshFromTab();
}

function bindEvents() {
  el.refreshBtn.addEventListener("click", async () => {
    await refreshFromTab();
  });

  el.copyBtn.addEventListener("click", async () => {
    const payload = await ensurePayload();
    if (!payload?.markdown) {
      setMessage("没有可复制内容，请先刷新。");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload.markdown);
      setMessage("已复制完整 Markdown。");
    } catch (error) {
      setMessage(`复制失败：${error?.message || "无法访问剪贴板"}`);
    }
  });

  el.downloadBtn.addEventListener("click", async () => {
    const payload = await ensurePayload();
    const settings = await getSettingsFromRuntime();
    const format = normalizeDownloadFormat(settings?.downloadFormat || payload?.downloadFormat);
    const content =
      format === "txt" ? payload?.txt || payload?.subtitlePreview || "" : payload?.srt || "";
    if (!content) {
      setMessage("没有可下载字幕。");
      return;
    }
    const safeTitle = sanitizeFileName(payload.title || "bilibili-subtitle");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeTitle}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setMessage(`已下载 ${format.toUpperCase()}。`);
  });

  el.readingViewBtn?.addEventListener("click", async () => {
    const tab = await getActiveTab();
    if (!isSupportedBilibiliPage(tab?.url || "")) {
      setMessage("请先打开一个 B 站视频页。");
      return;
    }

    if (isReaderModeUrl(tab?.url || "")) {
      setStatus("正在退出阅读视图...");
      const resp = await sendToRuntime({
        type: "close-reading-view-tab",
        tabId: tab.id
      });
      if (!resp?.ok) {
        setStatus(`退出失败：${resp?.error || "未知错误"}`, true);
        setMessage(`退出失败：${resp?.error || "未知错误"}`);
        return;
      }
      setMessage("已退出阅读视图，回到普通模式。");
      setStatus("阅读视图已关闭。");
      window.setTimeout(() => window.close(), 80);
      return;
    }

    const prepResp = await sendToContent({ type: "popup-get-state" });
    if (!prepResp?.ok) {
      setStatus(prepResp?.error || "请刷新浏览器网页重试，或当前网页不支持", true);
      setMessage(prepResp?.error || "请刷新浏览器网页重试，或当前网页不支持");
      return;
    }

    setStatus("正在打开阅读视图...");
    const resp = await sendToRuntime({
      type: "open-reading-view-tab",
      url: tab.url,
      tabId: tab.id
    });
    if (!resp?.ok) {
      setStatus(`打开失败：${resp?.error || "未知错误"}`, true);
      setMessage(`打开失败：${resp?.error || "未知错误"}`);
      return;
    }
    setMessage("已在当前页面打开阅读视图。");
    setStatus("阅读视图已打开。");
    window.setTimeout(() => window.close(), 80);
  });

  el.subtitleSelect.addEventListener("change", async (event) => {
    const option = event.target.options[event.target.selectedIndex];
    const url = String(option?.value || "");
    if (!url) {
      return;
    }
    setStatus("正在切换字幕...");
    const resp = await sendToContent({
      type: "popup-select-subtitle",
      url,
      lang: String(option.dataset.lang || "unknown"),
      subtitleId: String(option.dataset.id || "")
    });
    if (!resp?.ok) {
      setStatus(`切换失败：${resp?.error || "未知错误"}`, true);
      setMessage(`切换失败：${resp?.error || "未知错误"}`);
    }
    render(resp?.payload || latestPayload);
  });

  el.settingsBtn.addEventListener("click", async () => {
    await sendToRuntime({ type: "open-options" });
  });

  el.aiBtn?.addEventListener("click", async () => {
    try {
      if (globalThis.browser?.sidebarAction?.open) {
        globalThis.browser.sidebarAction.open();
        window.setTimeout(() => window.close(), 80);
        return;
      }

      const tab = await getActiveTab();
      if (!tab?.id) {
        setStatus("找不到当前标签页。", true);
        setMessage("找不到当前标签页。");
        return;
      }

      if (chrome.sidePanel?.open) {
        await chrome.sidePanel.open({ tabId: tab.id });
      } else {
        throw new Error("当前浏览器不支持扩展侧边栏");
      }
      window.setTimeout(() => window.close(), 80);
    } catch (error) {
      setStatus(`打开侧边栏失败：${error?.message || error}`, true);
      setMessage(`打开侧边栏失败：${error?.message || error}`);
    }
  });
}

async function refreshFromTab() {
  setStatus("正在抓取...");
  const resp = await sendToContent({ type: "popup-refresh" });
  if (!resp?.ok) {
    const errorText = (resp?.error || "请在 B 站视频页使用。").replace(
      "请刷新浏览器网页重试，或当前网页不支持",
      "请刷新网页重试，或当前网页不支持"
    );
    setStatus(`抓取失败：${errorText}`, true);
    render(resp?.payload || latestPayload, { preserveStatus: true });
    return;
  }
  render(resp?.payload || latestPayload);
}

async function ensurePayload() {
  if (latestPayload) {
    return latestPayload;
  }
  const resp = await sendToContent({ type: "popup-get-state" });
  if (resp?.ok && resp.payload) {
    latestPayload = resp.payload;
  }
  return latestPayload;
}

function render(payload, { preserveStatus = false } = {}) {
  if (!payload) {
    return;
  }
  latestPayload = payload;

  if (!preserveStatus) {
    const statusText = String(payload.status || "准备就绪");
    const isErrorStatus = /失败|错误|不可用|不支持/.test(statusText);
    setStatus(statusText, isErrorStatus);
  }
  setMessage(payload.message || "");

  setText(el.propTitle, payload.title || "-");
  setText(el.propUrl, payload.url || "-");
  setText(el.propCreated, formatLocalDate());
  setText(el.propTags, payload.tags || "clippings");
  el.propTitle.title = payload.title || "";
  el.propUrl.title = payload.url || "";

  const options = payload.subtitleOptions || [];
  if (options.length === 0) {
    el.subtitleSelect.innerHTML = '<option value="">暂无字幕</option>';
    el.subtitleSelect.disabled = true;
  } else {
    el.subtitleSelect.innerHTML = options
      .map((item) => {
        const selected = item.selected ? "selected" : "";
        const aiTag = item.isAi ? " [AI]" : "";
        return `<option value="${escapeHtml(item.url)}" data-id="${escapeHtml(
          item.id || ""
        )}" data-lang="${escapeHtml(item.lang || "")}" ${selected}>${escapeHtml(
          `${item.lang || "unknown"}${aiTag}`
        )}</option>`;
      })
      .join("");
    el.subtitleSelect.disabled = false;
  }

  el.preview.value = payload.subtitlePreview || "";
}

function setText(node, text) {
  node.textContent = String(text || "");
}

function setStatus(text, isError = false) {
  el.status.textContent = String(text || "");
  el.status.classList.toggle("is-error", Boolean(isError));
}

function setMessage(text) {
  el.message.textContent = String(text || "");
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}

function isReaderModeUrl(url) {
  try {
    return new URL(url).searchParams.get("boc_reader") === "1";
  } catch {
    return false;
  }
}

async function sendToContent(message) {
  const tab = await getActiveTab();
  const tabId = tab?.id || null;
  if (!tabId) {
    throw new Error("找不到当前标签页");
  }

  try {
    return await sendMessageToTab(tabId, message);
  } catch (error) {
    if (shouldRetryAfterInjection(error) && isSupportedBilibiliPage(tab?.url || "")) {
      try {
        await ensureContentScriptReady(tabId);
        await sleep(80);
        return await sendMessageToTab(tabId, message);
      } catch (retryError) {
        error = retryError;
      }
    }

    const normalizedError = normalizeContentErrorMessage(error);
    setStatus("请在 B 站视频页使用插件。");
    setMessage(normalizedError);
    return { ok: false, error: normalizedError, payload: latestPayload };
  }
}

function normalizeContentErrorMessage(error) {
  const message = String(error?.message || "").trim();
  if (message.includes("Could not establish connection. Receiving end does not exist.")) {
    return "请刷新浏览器网页重试，或当前网页不支持";
  }
  return message || "未知错误";
}

function shouldRetryAfterInjection(error) {
  const message = String(error?.message || "");
  return message.includes("Could not establish connection. Receiving end does not exist.");
}



async function ensureContentScriptReady(tabId) {
  if (!chrome.scripting) {
    throw new Error("请刷新浏览器网页重试，或当前网页不支持");
  }

  const loadedVersion = await probeContentScriptVersion(tabId);
  if (loadedVersion === EXPECTED_CONTENT_SCRIPT_VERSION) {
    return;
  }

  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["entry/content.css"]
  });

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["entry/content-classic.js"]
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (!message.includes("Identifier 'DEFAULT_SETTINGS' has already been declared")) {
      throw error;
    }
  }

  // content.js can take a moment to finish executing; probe a few times.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      await sleep(150);
    }
    const reinjectedVersion = await probeContentScriptVersion(tabId);
    if (reinjectedVersion === EXPECTED_CONTENT_SCRIPT_VERSION) {
      return;
    }
  }

  throw new Error("扩展刚更新，请刷新当前页面后重试。");
}

async function probeContentScriptVersion(tabId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const probe = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => globalThis.__BOC_CONTENT_SCRIPT_LOADED__ || ""
      });
      const version = String(probe?.[0]?.result || "");
      if (version) {
        return version;
      }
    } catch {
      // ignore probe failures
    }
    if (attempt < 2) {
      await sleep(100);
    }
  }
  return "";
}

async function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

async function sendToRuntime(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

async function getSettingsFromRuntime() {
  try {
    const resp = await sendToRuntime({ type: "get-settings" });
    if (!resp?.ok) {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...(resp.settings || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
