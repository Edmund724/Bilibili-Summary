import { state, clipState, uiState } from "./state.js";
import { DEFAULT_SETTINGS } from "./shared-defaults.js";
import { ensureUiReady, setStatus, setMessage } from "../ui/ui-renderer.js";
import {
  enterReaderMode,
  renderReadingStatus,
  waitForVideoMetadata,
  enforceNormalPageStateIfNeeded,
  isReaderViewOpen
} from "../reader/index.js";
import { resetClipState, refreshClip } from "../subtitle/fetcher.js";
import { schedulePlayerAiQuickActionSync } from "../ai/player-ai.js";
import { computeCurrentClipSignature, isReaderMode } from "../bilibili/video-id-shared.js";
import { getErrorMessage, isStaleRunError, toReadableText } from "../shared/error-helpers.js";

export function replaceReaderModeUrl(nextUrl) {
  const targetUrl = String(nextUrl || "").trim();
  if (!targetUrl || targetUrl === location.href) {
    return;
  }

  try {
    // Update clip signature BEFORE calling replaceState, because the patched
    // history.replaceState dispatches boc:urlchange synchronously, which
    // triggers handleUrlChange — if the signature hasn't been updated yet,
    // it looks like a real URL change and resets all clip state (chapters,
    // subtitles, etc.).
    clipState.setCurrentUrl(targetUrl);
    clipState.setCurrentClipSignature(computeCurrentClipSignature(targetUrl));
    history.replaceState(history.state, "", targetUrl);
    clipState.setCurrentUrl(location.href);
    clipState.setCurrentClipSignature(computeCurrentClipSignature(location.href));
  } catch (error) {
    if (shouldDebugLog()) {
      console.warn("[BOC] failed to replace reader mode url", error);
    }
  }
}

const BOC_URL_CHANGE_EVENT = "boc:urlchange";
let urlWatcherHandlerBound = false;
let urlWatcherHistoryPatched = false;

export function startUrlWatcher() {
  if (state.ui.urlWatcherStarted) {
    return;
  }
  uiState.setUrlWatcherStarted(true);

  const handleUrlChange = () => {
    const nextUrl = location.href;
    const nextSignature = computeCurrentClipSignature();
    if (nextSignature === state.clip.currentClipSignature) {
      return;
    }

    clipState.setCurrentUrl(nextUrl);
    clipState.setCurrentClipSignature(nextSignature);
    enforceNormalPageStateIfNeeded(nextUrl);
    ensureUiReady();
    resetClipState();
    schedulePlayerAiQuickActionSync();
    const shouldEnterReaderMode = isReaderMode(nextUrl);
    if (!isReaderViewOpen() && shouldEnterReaderMode) {
      document.documentElement.setAttribute("data-boc-reader-mode", "1");
      document.body.setAttribute("data-boc-reader-mode", "1");
      renderReadingStatus("检测到阅读视图跳转，正在打开阅读模式...");
      enterReaderMode().catch((error) => {
        renderReadingStatus(`阅读视图启动失败：${getErrorMessage(error)}`);
      });
      return;
    }
    if (isReaderViewOpen() || shouldEnterReaderMode) {
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
  };

  // URL 变化事件化：popstate/hashchange 加 history.pushState/replaceState
  // 补丁（原始调用后派发自定义事件），取代原先的 1200ms 轮询。
  if (!urlWatcherHandlerBound) {
    window.addEventListener("popstate", handleUrlChange);
    window.addEventListener("hashchange", handleUrlChange);
    window.addEventListener(BOC_URL_CHANGE_EVENT, handleUrlChange);
    urlWatcherHandlerBound = true;
  }
  if (!urlWatcherHistoryPatched) {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function pushState(...args) {
      const result = originalPushState.apply(this, args);
      window.dispatchEvent(new Event(BOC_URL_CHANGE_EVENT));
      return result;
    };
    history.replaceState = function replaceState(...args) {
      const result = originalReplaceState.apply(this, args);
      window.dispatchEvent(new Event(BOC_URL_CHANGE_EVENT));
      return result;
    };
    urlWatcherHistoryPatched = true;
  }
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

// 通用 offscreen 任务通道：发消息给 background 执行为单个任务创建的
// offscreen 文档（background 保证至多一个活跃文档、任务间互斥、异常透传），
// 消息结构随任务类型定。用于 ASR 音频解码（audio-bytes → typedArray）。
export function sendOffloadMessage(message) {
  return sendRuntimeMessage({ type: "offload-task", ...message });
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
