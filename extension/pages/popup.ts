// popup.ts — 弹出页控制器（自 popup.js 迁移，仅加类型；行为逐字节不变）。
//
// 职责：读取活动标签页的字幕快照（popup-refresh / popup-get-state）、字幕
// 切换（popup-select-subtitle）、下载/复制、阅读视图开关与 AI 对话入口。
// content 不可达时的「确保注入 + 重试」时序在 ensureContentScriptReady。
import { DEFAULT_SETTINGS } from "../core/defaults.js";
import { normalizeAsrLanguage } from "../core/presets.js";
import { normalizeDownloadFormat } from "../core/validators.js";
import { isSupportedBilibiliPage } from "../bilibili/video-id-shared.js";
import { formatLocalDate, sleep } from "../shared/utils.js";
import {
  DUPLICATE_CLASSIC_INJECTION_SENTINEL,
  RECEIVING_END_MISSING_SENTINEL,
} from "../shared/content-error-sentinels.js";
import { escapeHtml, sanitizeFileName } from "../shared/string-utils.js";
import { sendMessageToTab } from "../shared/tab-utils.js";

// content 侧 popup 消息的响应信封（payload 为页面快照）
interface ContentResponse {
  ok?: boolean;
  error?: unknown;
  payload?: PopupPayload | null;
  settings?: Partial<typeof DEFAULT_SETTINGS>;
}

// popup-get-state / popup-refresh payload 的消费侧视图（缺失字段走兜底文案）
interface PopupPayload {
  status?: unknown;
  message?: unknown;
  title?: unknown;
  url?: unknown;
  tags?: unknown;
  markdown?: unknown;
  txt?: unknown;
  srt?: unknown;
  downloadFormat?: unknown;
  subtitlePreview?: unknown;
  subtitleOptions?: PopupSubtitleOption[];
}

interface PopupSubtitleOption {
  url?: unknown;
  id?: unknown;
  lang?: unknown;
  selected?: unknown;
  isAi?: unknown;
}

const el = {
  status: document.getElementById("status") as HTMLElement,
  message: document.getElementById("message") as HTMLElement,
  propTitle: document.getElementById("propTitle") as HTMLElement,
  propUrl: document.getElementById("propUrl") as HTMLElement,
  propCreated: document.getElementById("propCreated") as HTMLElement,
  propTags: document.getElementById("propTags") as HTMLElement,
  subtitleSelect: document.getElementById("subtitleSelect") as HTMLSelectElement,
  preview: document.getElementById("preview") as HTMLTextAreaElement,
  refreshBtn: document.getElementById("refreshBtn") as HTMLButtonElement,
  copyBtn: document.getElementById("copyBtn") as HTMLButtonElement,
  downloadBtn: document.getElementById("downloadBtn") as HTMLButtonElement,
  readingViewBtn: document.getElementById("readingViewBtn") as HTMLButtonElement | null,
  aiBtn: document.getElementById("aiBtn") as HTMLButtonElement | null,
  settingsBtn: document.getElementById("settingsBtn") as HTMLButtonElement,
  asrLanguageSelect: document.getElementById("asrLanguageSelect") as HTMLSelectElement
};

let latestPayload: PopupPayload | null = null;
const EXPECTED_CONTENT_SCRIPT_VERSION = chrome.runtime.getManifest().version || "";

// 无字幕视频在做音频转写时会广播阶段，刷新等待期间据此把笼统的“正在抓取...”
// 替换为更准确的转写提示，以便用户区分抓取本地字幕与语音转写。
chrome.runtime.onMessage.addListener((message) => {
  const statusMessage = message as { type?: string; phase?: string } | null;
  if (statusMessage?.type === "boc-subtitle-status" && statusMessage.phase === "asr-transcribing") {
    setStatus("此视频无字幕，正在进行音频转写…");
  }
});

init().catch((error) => {
  setStatus(`初始化失败：${(error as Error).message}`, true);
});

async function init(): Promise<void> {
  bindEvents();
  await loadAsrLanguage();
  await refreshFromTab();
}

function bindEvents(): void {
  el.asrLanguageSelect.addEventListener("change", async () => {
    const language = el.asrLanguageSelect.value || "auto";
    try {
      const resp = (await sendToRuntime({ type: "save-settings", settings: { asrLanguage: language } })) as ContentResponse;
      if (!resp?.ok) {
        throw new Error(String(resp?.error || "保存失败"));
      }
      setMessage("转写语言已切换，点击刷新重新转写。");
    } catch (error) {
      setMessage(`语言切换失败：${(error as Error)?.message || "未知错误"}`);
      // 失败回滚下拉显示值
      await loadAsrLanguage();
    }
  });
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
      await navigator.clipboard.writeText(String(payload.markdown));
      setMessage("已复制完整 Markdown。");
    } catch (error) {
      setMessage(`复制失败：${(error as Error)?.message || "无法访问剪贴板"}`);
    }
  });

  el.downloadBtn.addEventListener("click", async () => {
    const payload = await ensurePayload();
    const settings = await getSettingsFromRuntime();
    const format = normalizeDownloadFormat(settings?.downloadFormat || payload?.downloadFormat);
    const content: BlobPart = format === "txt"
      ? (payload?.txt || payload?.subtitlePreview || "") as BlobPart
      : (payload?.srt || "") as BlobPart;
    if (!content) {
      setMessage("没有可下载字幕。");
      return;
    }
    const safeTitle = sanitizeFileName(String(payload?.title || "bilibili-subtitle"));
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
      const resp = (await sendToRuntime({
        type: "close-reading-view-tab",
        tabId: tab.id
      })) as ContentResponse;
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

    const prepResp = (await sendToContent({ type: "popup-get-state" })) as ContentResponse;
    if (!prepResp?.ok) {
      setStatus(String(prepResp?.error || "请刷新浏览器网页重试，或当前网页不支持"), true);
      setMessage(String(prepResp?.error || "请刷新浏览器网页重试，或当前网页不支持"));
      return;
    }

    setStatus("正在打开阅读视图...");
    const resp = (await sendToRuntime({
      type: "open-reading-view-tab",
      url: tab.url,
      tabId: tab.id
    })) as ContentResponse;
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
    const target = event.target as HTMLSelectElement;
    const option = target.options[target.selectedIndex];
    const url = String(option?.value || "");
    if (!url) {
      return;
    }
    setStatus("正在切换字幕...");
    const resp = (await sendToContent({
      type: "popup-select-subtitle",
      url,
      lang: String(option.dataset.lang || "unknown"),
      subtitleId: String(option.dataset.id || "")
    })) as ContentResponse;
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
      // PR5c：AI 入口改道——不再打开侧边栏（sidepanel 已摘除），走
      // popup-trigger-reading-view 同一条链先打开/进入阅读模式；激活对话 tab
      // 的意图经 background 转发为 popup-trigger-reading-chat，由 content 侧
      // 对话 seam（ensureChatTabActivated + runQuickActionPrompt）消费。
      const tab = await getActiveTab();
      if (!tab?.id) {
        setStatus("找不到当前标签页。", true);
        setMessage("找不到当前标签页。");
        return;
      }
      if (!isSupportedBilibiliPage(tab?.url || "")) {
        setMessage("请先打开一个 B 站视频页。");
        return;
      }

      const resp = (await sendToRuntime({
        type: "popup-trigger-reading-chat",
        readerUrl: isReaderModeUrl(tab?.url || "") ? "" : tab.url
      })) as ContentResponse;
      if (!resp?.ok) {
        setStatus(`打开 AI 对话失败：${resp?.error || "未知错误"}`, true);
        setMessage(`打开 AI 对话失败：${resp?.error || "未知错误"}`);
        return;
      }
      setMessage("已在阅读模式打开 AI 对话。");
      setStatus("AI 对话已打开。");
      window.setTimeout(() => window.close(), 80);
    } catch (error) {
      setStatus(`打开 AI 对话失败：${(error as Error)?.message || String(error)}`, true);
      setMessage(`打开 AI 对话失败：${(error as Error)?.message || String(error)}`);
    }
  });
}

async function refreshFromTab(): Promise<void> {
  setStatus("正在抓取...");
  const resp = (await sendToContent({ type: "popup-refresh" })) as ContentResponse;
  if (!resp?.ok) {
    const errorText = String(resp?.error || "请在 B 站视频页使用。").replace(
      "请刷新浏览器网页重试，或当前网页不支持",
      "请刷新网页重试，或当前网页不支持"
    );
    setStatus(`抓取失败：${errorText}`, true);
    render(resp?.payload || latestPayload, { preserveStatus: true });
    return;
  }
  render(resp?.payload || latestPayload);
}

// 读取已保存的转写语言档位并同步下拉显示
async function loadAsrLanguage(): Promise<void> {
  const settings = await getSettingsFromRuntime();
  const language = normalizeAsrLanguage(settings?.asrLanguage);
  el.asrLanguageSelect.value = language;
}

async function ensurePayload(): Promise<PopupPayload | null> {
  if (latestPayload) {
    return latestPayload;
  }
  const resp = (await sendToContent({ type: "popup-get-state" })) as ContentResponse;
  if (resp?.ok && resp.payload) {
    latestPayload = resp.payload;
  }
  return latestPayload;
}

function render(payload: PopupPayload | null | undefined, { preserveStatus = false }: { preserveStatus?: boolean } = {}): void {
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
  el.propTitle.title = String(payload.title || "");
  el.propUrl.title = String(payload.url || "");

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

  el.preview.value = String(payload.subtitlePreview || "");
}

function setText(node: HTMLElement, text: unknown): void {
  node.textContent = String(text || "");
}

function setStatus(text: unknown, isError = false): void {
  el.status.textContent = String(text || "");
  el.status.classList.toggle("is-error", Boolean(isError));
}

function setMessage(text: unknown): void {
  el.message.textContent = String(text || "");
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}

function isReaderModeUrl(url: string): boolean {
  try {
    return new URL(url).searchParams.get("boc_reader") === "1";
  } catch {
    return false;
  }
}

async function sendToContent(message: unknown): Promise<unknown> {
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

function normalizeContentErrorMessage(error: unknown): string {
  const message = String((error as Error)?.message || "").trim();
  if (message.includes(RECEIVING_END_MISSING_SENTINEL)) {
    return "请刷新浏览器网页重试，或当前网页不支持";
  }
  return message || "未知错误";
}

function shouldRetryAfterInjection(error: unknown): boolean {
  const message = String((error as Error)?.message || "");
  return message.includes(RECEIVING_END_MISSING_SENTINEL);
}



async function ensureContentScriptReady(tabId: number): Promise<void> {
  if (!chrome.scripting) {
    throw new Error("请刷新浏览器网页重试，或当前网页不支持");
  }

  const loadedVersion = await probeContentScriptVersion(tabId);
  if (loadedVersion === EXPECTED_CONTENT_SCRIPT_VERSION) {
    return;
  }

  // S3 分层：语义与 background.js 的修复注入一致——「确保 content 就绪」时
  // 页面可能缺失任何样式，常驻表 + 阅读表全量补齐（阅读表在阅读模式未开启时
  // 因 data-boc-reader-mode 门控静默，无副作用）。
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["entry/styles/panel.css", "entry/styles/reader.css", "entry/styles/reader-gate.css"]
  });

  try {
    await chrome.scripting.executeScript({
      // 候选4 分包后注入 classic bootstrap（见 background.js 同名注入点的注释）；
      // 哨兵在 bootstrap 顶层同步置位，主包经其异步拉起。
      target: { tabId },
      files: ["entry/content-bootstrap.iife.js"]
    });
  } catch (error) {
    const message = String((error as Error)?.message || "");
    if (!message.includes(DUPLICATE_CLASSIC_INJECTION_SENTINEL)) {
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

async function probeContentScriptVersion(tabId: number): Promise<string> {
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

async function sendToRuntime(message: unknown): Promise<unknown> {
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

async function getSettingsFromRuntime(): Promise<Partial<typeof DEFAULT_SETTINGS>> {
  try {
    const resp = (await sendToRuntime({ type: "get-settings" })) as ContentResponse;
    if (!resp?.ok) {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...(resp.settings || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
