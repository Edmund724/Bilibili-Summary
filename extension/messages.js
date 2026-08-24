import { state } from "./state.js";
import { DEFAULT_SETTINGS } from "./shared-defaults.js";

import {
  getErrorMessage,
  replaceReaderModeUrl,
  getRuntimeVideoElement
} from "./router.js";

import {
  getPopupPayload,
  refreshClip,
  loadSubtitle,
  setStatus,
  renderSubtitleSelect,
  ensureUiReady
} from "./panel.js";

import { removePlayerAiQuickActionButton } from "./player-ai.js";

import {
  enterReaderMode,
  logWarn,
  updateReaderFollowState,
  syncReadingViewPlayback
} from "./reader.js";

import {
  getCurrentAid,
  fetchHotComments,
  buildMarkdown
} from "./formatters.js";

export function bindRuntimeEvents() {
  if (state.runtimeEventsBound) {
    return;
  }
  state.runtimeEventsBound = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }

    if (message.type === "popup-get-state") {
      sendResponse({ ok: true, payload: getPopupPayload() });
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
      loadSubtitle(url, lang, state.fetchRunId, subtitleId)
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
      state.playerAiQuickActionSuppressedUntil = Date.now() + 2500;
      removePlayerAiQuickActionButton();
      ensureUiReady();
      const readerUrl = String(message.readerUrl || "").trim();
      if (readerUrl) {
        replaceReaderModeUrl(readerUrl);
        document.documentElement.setAttribute("data-boc-reader-mode", "1");
        document.body.setAttribute("data-boc-reader-mode", "1");
      }
      if (!state.readingViewOpen) {
        enterReaderMode().catch((error) => {
          logWarn("[BOC] reading mode trigger failed", error);
        });
      }
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "sidepanel-get-context") {
      const settings = state.settings || DEFAULT_SETTINGS;
      const body = state.subtitleBody || [];
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
          title: state.title || "",
          author: state.author || "",
          uploadDate: state.uploadDate || "",
          bvid: state.bvid || "",
          cid: state.cid || "",
          aid: state.aid || "",
          pageIndex: Number(state.pageIndex) > 0 ? Number(state.pageIndex) : 1,
          pageCount: Number(state.pageCount) > 0 ? Number(state.pageCount) : 0,
          pageTitle: state.pageTitle || "",
          subtitleBody: body,
          subtitleMarkdown,
          subtitleLang: state.selectedSubtitleLang || "",
          selectedSubtitleId: state.selectedSubtitleId || "",
          selectedSubtitleUrl: state.selectedSubtitleUrl || "",
          subtitleOptions: state.subtitles || [],
          hotComments: []
        }
      });
      return false;
    }

    if (message.type === "sidepanel-get-hot-comments") {
      const count = 20;
      if (!count) {
        sendResponse({ ok: true, comments: [] });
        return false;
      }

      if (!getCurrentAid()) {
        state.hotComments = [];
        sendResponse({ ok: true, comments: [], note: "无法获取视频 aid" });
        return false;
      }

      fetchHotComments(count)
        .then((hotComments) => {
          state.hotComments = hotComments;
          sendResponse({ ok: true, comments: hotComments });
        })
        .catch((error) => {
          state.hotComments = [];
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
      if (state.readingViewOpen) {
        state.readingManualScrollPauseUntil = 0;
        state.readingNextScrollBehavior = "auto";
        updateReaderFollowState();
        syncReadingViewPlayback(true);
      }
      sendResponse({ ok: true, currentTime: nextTime });
      return false;
    }

    return false;
  });
}
