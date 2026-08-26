// offscreen.js — 隐藏后台页面，负责 SSE 流式请求，避免 Side Panel 被冻结。
import { streamChat } from "../ai/client.js";

let activeAbortController = null;
let idleTimeoutId = null;
var STREAM_IDLE_TIMEOUT_MS = 90000;

function armIdleTimeout(abortController, port) {
  clearIdleTimeout();
  idleTimeoutId = setTimeout(function () {
    if (abortController && !abortController.signal.aborted) {
      abortController.abort();
      port.postMessage({
        type: "error",
        error: "请求超时（90 秒未返回任何数据），已自动中断"
      });
    }
  }, STREAM_IDLE_TIMEOUT_MS);
}

function clearIdleTimeout() {
  if (idleTimeoutId) {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = null;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== "offscreen-chat") {
    return;
  }

  port.onMessage.addListener(async (msg) => {
    if (!msg) return;
    if (msg.action === "stop") {
      abortActiveRequest();
      return;
    }
    if (msg.action !== "chat") return;

    try {
      abortActiveRequest();
      activeAbortController = new AbortController();

      const providersResp = await chrome.runtime.sendMessage({ type: "ai-providers-list" });
      const list = (providersResp?.providers || []).filter(p => p.enabled);
      const provider = list.find(p => p.id === msg.providerId) || null;
      if (!provider) {
        port.postMessage({ type: "error", error: "未找到选中的平台" });
        clearActiveRequestState();
        return;
      }

      const keysResp = await chrome.runtime.sendMessage({ type: "get-ai-provider-key", providerId: msg.providerId });
      if (!keysResp?.ok) {
        port.postMessage({ type: "error", error: keysResp?.error || "读取 API Key 失败" });
        clearActiveRequestState();
        return;
      }
      const apiKey = String(keysResp.apiKey || "").trim();
      if (provider.requiresKey !== false && !apiKey) {
        port.postMessage({ type: "error", error: "该平台 API Key 未配置" });
        clearActiveRequestState();
        return;
      }

      armIdleTimeout(activeAbortController, port);

      await streamChat({
        provider: { ...provider, apiKey },
        context: msg.context || {},
        userPrompt: msg.prompt || "",
        history: Array.isArray(msg.history) ? msg.history : [],
        thinkingLevel: msg.thinkingLevel,
        port,
        signal: activeAbortController.signal,
        onActivity: function () { armIdleTimeout(activeAbortController, port); }
      });
    } catch (e) {
      port.postMessage({ type: "error", error: String(e?.message || e) });
    } finally {
      clearIdleTimeout();
      clearActiveRequestState();
    }
  });

  port.onDisconnect.addListener(() => {
    abortActiveRequest();
    clearIdleTimeout();
    clearActiveRequestState();
  });
});

function abortActiveRequest() {
  if (activeAbortController && !activeAbortController.signal.aborted) {
    activeAbortController.abort();
  }
  activeAbortController = null;
}

function clearActiveRequestState() {
  activeAbortController = null;
}
