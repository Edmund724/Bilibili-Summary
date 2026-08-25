import { state } from "./state.js";
import { DEFAULT_SETTINGS } from "./shared-defaults.js";
import { ensureUiReady } from "./panel.js";
import { enforceNormalPageStateIfNeeded } from "./reader-page-frame.js";
import {
  resetClipState,
  refreshClip,
  setStatus,
  setMessage
} from "./panel.js";
import {
  enterReaderMode,
  renderReadingStatus,
  waitForVideoMetadata,
  shouldDebugLog
} from "./reader-shell.js";
import { schedulePlayerAiQuickActionSync } from "./player-ai.js";
import { computeCurrentClipSignature, isReaderMode } from "./url-utils.js";
import { getErrorMessage, isStaleRunError, toReadableText } from "./error-helpers.js";

export function replaceReaderModeUrl(nextUrl) {
  const targetUrl = String(nextUrl || "").trim();
  if (!targetUrl || targetUrl === location.href) {
    return;
  }

  try {
    history.replaceState(history.state, "", targetUrl);
    state.clip.currentUrl = location.href;
    state.clip.currentClipSignature = computeCurrentClipSignature(location.href);
  } catch (error) {
    if (shouldDebugLog()) {
      console.warn("[BOC] failed to replace reader mode url", error);
    }
  }
}

export function startUrlWatcher() {
  if (state.ui.urlWatcherStarted) {
    return;
  }
  state.ui.urlWatcherStarted = true;

  window.setInterval(() => {
    const nextUrl = location.href;
    const nextSignature = computeCurrentClipSignature();
    if (nextSignature === state.clip.currentClipSignature) {
      return;
    }

    state.clip.currentUrl = nextUrl;
    state.clip.currentClipSignature = nextSignature;
    enforceNormalPageStateIfNeeded(nextUrl);
    ensureUiReady();
    resetClipState();
    schedulePlayerAiQuickActionSync();
    const shouldEnterReaderMode = isReaderMode(nextUrl);
    if (!state.reader.readingViewOpen && shouldEnterReaderMode) {
      document.documentElement.setAttribute("data-boc-reader-mode", "1");
      document.body.setAttribute("data-boc-reader-mode", "1");
      renderReadingStatus("检测到阅读视图跳转，正在打开阅读模式...");
      enterReaderMode().catch((error) => {
        renderReadingStatus(`阅读视图启动失败：${getErrorMessage(error)}`);
      });
      return;
    }
    if (state.reader.readingViewOpen || shouldEnterReaderMode) {
      renderReadingStatus("检测到视频变化，正在自动刷新字幕...");
      waitForVideoMetadata().then(() => {
        refreshClip().catch((error) => {
          if (!isStaleRunError(error)) {
            renderReadingStatus(`自动刷新失败：${getErrorMessage(error)}`);
          }
        });
      });
      return;
    }
    setStatus("检测到页面变化，请点击“刷新抓取”加载当前视频字幕。");
  }, 1200);
}

export function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(resp);
      });
    } catch (error) {
      reject(error);
    }
  });
}

export function isExtensionContextInvalidated(error) {
  const msg = String(error?.message || "");
  return msg.includes("Extension context invalidated");
}

export function requestOpenOptions() {
  sendRuntimeMessage({ type: "open-options" })
    .then((resp) => {
      if (!resp?.ok) {
        setMessage(`打开设置失败：${toReadableText(resp?.error, "未知错误")}`);
      }
    })
    .catch((error) => {
      if (isExtensionContextInvalidated(error)) {
        setMessage("扩展刚刚更新，请刷新当前页面后重试。");
        return;
      }
      setMessage(`打开设置失败：${getErrorMessage(error)}`);
    });
}

export async function getSettings(timeoutMs = 5000) {
  try {
    const timeoutPromise = new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error("getSettings timeout")), timeoutMs);
    });
    const response = await Promise.race([
      sendRuntimeMessage({ type: "get-settings" }),
      timeoutPromise
    ]);
    if (!response?.ok) {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...(response.settings || {}) };
  } catch (error) {
    console.warn("[BOC] getSettings fallback to defaults", error?.message);
    return { ...DEFAULT_SETTINGS };
  }
}

export function byId(id) {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing node: ${id}`);
  }
  return node;
}
