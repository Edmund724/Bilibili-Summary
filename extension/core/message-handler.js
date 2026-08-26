import { state, uiState, playerAiState, clipState } from "./state.js";
import { DEFAULT_SETTINGS } from "./shared-defaults.js";

import {
  replaceReaderModeUrl
} from "./runtime.js";
import {
  getErrorMessage
} from "../shared/error-helpers.js";
import {
  getRuntimeVideoElement
} from "../bilibili/video-probe.js";

import { getPopupPayload } from "../subtitle/ui.js";
import { refreshClip, loadSubtitle } from "../subtitle/fetcher.js";
import { setStatus, renderSubtitleSelect, ensureUiReady } from "../ui/ui-renderer.js";

import { removePlayerAiQuickActionButton } from "../ai/player-ai.js";

import {
  updateReaderFollowState,
  syncReadingViewPlayback,
  enterReaderMode,
  closeReadingView,
  logWarn,
  isReaderViewOpen,
  resetManualScrollPause
} from "../reader/index.js";

import {
  isReaderMode,
  stripReaderModeUrl
} from "../bilibili/video-id-shared.js";

import {
  getCurrentAid,
  fetchHotComments
} from "../bilibili/gateway.js";
import { buildMarkdown } from "../notes/render.js";

export function bindRuntimeEvents() {
  if (state.ui.runtimeEventsBound) {
    return;
  }
  uiState.setRuntimeEventsBound(true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }

    if (message.type === "popup-get-state") {
      const payload = getPopupPayload();
      sendResponse({ ok: true, payload });
      return false;
    }

    if (message.type === "popup-refresh") {
      refreshClip()
        .then(() => sendResponse({ ok: true, payload: getPopupPayload() }))
        .catch((error) =>
          sendResponse({ ok: false, error: getErrorMessage(error), payload: getPopupPayload() })
        );
      return true;
    }

    if (message.type === "popup-select-subtitle") {
      const url = String(message.url || "").trim();
      const lang = String(message.lang || "unknown");
      const subtitleId = String(message.subtitleId || "");
      if (!url) {
        sendResponse({ ok: false, error: "Missing subtitle URL", payload: getPopupPayload() });
        return false;
      }
      loadSubtitle(url, lang, state.clip.fetchRunId, subtitleId)
        .then(() => {
          setStatus("字幕切换完成。");
          renderSubtitleSelect();
          sendResponse({ ok: true, payload: getPopupPayload() });
        })
        .catch((error) =>
          sendResponse({ ok: false, error: getErrorMessage(error), payload: getPopupPayload() })
        );
      return true;
    }

    if (message.type === "popup-trigger-reading-view") {
      playerAiState.setSuppressedUntil(Date.now() + 2500);
      removePlayerAiQuickActionButton();
      ensureUiReady();
      const readerUrl = String(message.readerUrl || "").trim();
      if (readerUrl) {
        replaceReaderModeUrl(readerUrl);
        document.documentElement.setAttribute("data-boc-reader-mode", "1");
        document.body.setAttribute("data-boc-reader-mode", "1");
      }
      if (!isReaderViewOpen()) {
        enterReaderMode().catch((error) => {
          logWarn("[BOC] reading mode trigger failed", error);
        });
      }
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "popup-close-reading-view") {
      try {
        if (isReaderMode()) {
          replaceReaderModeUrl(stripReaderModeUrl(location.href));
        }
        closeReadingView();
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: getErrorMessage(error) });
      }
      return false;
    }

    if (message.type === "sidepanel-get-context") {
      const settings = state.settings || DEFAULT_SETTINGS;
      const body = state.clip.subtitleBody || [];
      let subtitleMarkdown = "";
      try {
        subtitleMarkdown = body.length
          ? buildMarkdown(state, body, { ...settings, includeHotCommentsInNote: false })
          : "";
      } catch (e) {
        subtitleMarkdown = "";
        logWarn("[BOC] sidepanel-get-context: buildMarkdown failed", e);
      }
      sendResponse({
        ok: true,
        payload: {
          url: location.href,
          title: state.clip.title || "",
          author: state.clip.author || "",
          uploadDate: state.clip.uploadDate || "",
          bvid: state.clip.bvid || "",
          cid: state.clip.cid || "",
          aid: state.clip.aid || "",
          pageIndex: Number(state.clip.pageIndex) > 0 ? Number(state.clip.pageIndex) : 1,
          pageCount: Number(state.clip.pageCount) > 0 ? Number(state.clip.pageCount) : 0,
          pageTitle: state.clip.pageTitle || "",
          subtitleBody: body,
          subtitleMarkdown,
          subtitleLang: state.clip.selectedSubtitleLang || "",
          selectedSubtitleId: state.clip.selectedSubtitleId || "",
          selectedSubtitleUrl: state.clip.selectedSubtitleUrl || "",
          subtitleOptions: state.clip.subtitles || [],
          hotComments: []
        }
      });
      return false;
    }

    if (message.type === "sidepanel-get-hot-comments") {
      if (!getCurrentAid()) {
        clipState.setHotComments([]);
        sendResponse({ ok: true, comments: [], note: "无法获取视频 aid" });
        return false;
      }

      fetchHotComments(20)
        .then((hotComments) => {
          clipState.setHotComments(hotComments);
          sendResponse({ ok: true, comments: hotComments });
        })
        .catch((error) => {
          clipState.setHotComments([]);
          sendResponse({ ok: true, comments: [], note: String(error?.message || error) });
        });
      return true;
    }

    if (message.type === "sidepanel-seek-video-time") {
      const seconds = Number(message.seconds);
      const video = getRuntimeVideoElement();
      if (!video) {
        sendResponse({ ok: false, error: "当前页面没有找到可联动的视频播放器。" });
        return false;
      }
      const nextTime = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
      const wasPaused = Boolean(video.paused);
      video.currentTime = nextTime;
      if (!wasPaused) {
        video.play().catch(() => {});
      }
      if (isReaderViewOpen()) {
        resetManualScrollPause();
        state.reader.setNextScrollBehavior("auto");
        updateReaderFollowState();
        syncReadingViewPlayback(true);
      }
      sendResponse({ ok: true, currentTime: nextTime });
      return false;
    }

    return false;
  });
}
