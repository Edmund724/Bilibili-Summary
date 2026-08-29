import { state, uiState, playerAiState, clipState } from "./state.js";
import { DEFAULT_SETTINGS } from "./defaults.js";

import { startUrlWatcher, BOC_URL_CHANGE_EVENT } from "./url-watcher.js";
import { replaceReaderModeUrl } from "../bilibili/reader-url.js";
import {
  getErrorMessage,
  isStaleRunError
} from "../shared/error-helpers.js";
import {
  getRuntimeVideoElement
} from "../bilibili/video-probe.js";

import { getPopupPayload } from "../subtitle/ui.js";
import { refreshClip, loadSubtitle, resetClipState } from "../subtitle/fetcher.js";
import { setStatus, renderSubtitleSelect, ensureUiReady } from "../ui/ui-renderer.js";

import {
  removePlayerAiQuickActionButton,
  schedulePlayerAiQuickActionSync
} from "../ai/player-ai.js";

import {
  updateReaderFollowState,
  syncReadingViewPlayback,
  enterReaderMode,
  closeReadingView,
  isReaderViewOpen,
  renderReadingStatus,
  waitForVideoMetadata,
  enforceNormalPageStateIfNeeded
} from "../reader/index.js";
// 滚动暂停重置位于 reader 域的共享叶子模块（不再经 reader/index.js 转发）
import { resetManualScrollPause } from "../reader/scroll-state.js";
// 日志直接取自 shared/logging.js（不再经 reader/index.js 转发）
import { logWarn } from "../shared/logging.js";

import {
  isReaderMode,
  computeCurrentClipSignature,
  stripReaderModeUrl
} from "../bilibili/video-id-shared.js";

import {
  getCurrentAid,
  fetchHotComments
} from "../bilibili/gateway.js";

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
      const payload = buildSidepanelContextPayload();
      const signature = computeSidepanelStateSignature(payload);
      // 候选5 签名短路：调用方（经 background 转发的 sidepanel）带着它上次收到的
      // 全量快照签名来问，content 状态没变就整份省略——不取字幕、不触发上层的
      // popup-refresh 与热评网络拉取，一次往返即返回。仅在非 forceRefresh 时生效：
      // 手动刷新/URL 变化语义上是明确要求全网络重拉。旧调用方不带 ifSignature
      // （空串）自然走全量路径，向后兼容。
      if (
        message.forceRefresh !== true &&
        typeof message.ifSignature === "string" &&
        message.ifSignature &&
        message.ifSignature === signature
      ) {
        sendResponse({ ok: true, unchanged: true, signature });
        return false;
      }
      // 全量路径：payload 附 signature，调用方存下来供下一轮 ifSignature 使用。
      sendResponse({ ok: true, payload: { ...payload, signature } });
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

// ============================================================
// sidepanel-get-context：payload 组装 + 状态签名（候选5 上下文同步瘦身）
// ============================================================

// sidepanel-get-context 的全量 payload 组装（原处理器内联字面量原样抽出）：
// 抽出的唯一原因是签名短路要先拿到 payload 才能算签名，字段与搬迁前逐字一致。
function buildSidepanelContextPayload() {
  const settings = state.settings || DEFAULT_SETTINGS;
  const body = state.clip.subtitleBody || [];
  return {
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
    // 视频时长（fetcher 经 page-context seam 写入 state.clip.videoDuration）：
    // offscreen 渲染 prompt 时用于 withHours（小时级时间戳）判定。
    videoDuration: Number(state.clip.videoDuration || 0) || 0,
    // 字幕时间戳开关透传：offscreen 渲染 prompt 时沿用同一设置；缺失按默认 true。
    includeTimestampInBody: settings?.includeTimestampInBody !== false,
    // idle/loading/ready/error：loading 且 subtitleBody 为空表示抓取
    // （可能含小时级 ASR 转写）仍在进行，sidepanel 据此等待而非把
    // 空字幕直接发给模型。
    subtitleFetchState: state.clip.subtitleFetchState || "idle",
    // empty 时的无字幕原因归类（null | "no-asr-config" | "asr-disabled" |
    // "asr-failed" | "asr-empty"），sidepanel 拦截总结发送时按原因提示。
    noSubtitleReason: state.clip.noSubtitleReason || null,
    subtitleLang: state.clip.selectedSubtitleLang || "",
    selectedSubtitleId: state.clip.selectedSubtitleId || "",
    selectedSubtitleUrl: state.clip.selectedSubtitleUrl || "",
    subtitleOptions: state.clip.subtitles || [],
    // 章节透传（fetcher 写入 state.clip.chapters）：供侧边栏回传 offscreen
    // 后做章节对齐切段（budgeter）与追问章节名检索（raw-retrieval）。
    chapters: Array.isArray(state.clip.chapters) ? state.clip.chapters : [],
    hotComments: []
  };
}

// 候选5：SP 上下文同步瘦身的签名判定（纯函数，可测）。输入是
// buildSidepanelContextPayload 产物（即 SP 持有快照的 shape），字段覆盖
// SP 消费的全部可变状态；签名相同 ⇒ 重发全量对 SP 是纯冗余——
// applyContextPayload 本就按 contextKey 去重不重渲染，但整份字幕体的
// 消息传输与上层热评的网络拉取照跑。
// 刻意不纳入 hotComments / url / title / noSubtitleReason：
//   - hotComments 由 background 按需拉取（unchanged 时整体跳过）；
//   - url/title 随视频切换必然带动 bvid/cid 变化，纳入只会制造假阳性刷新；
//   - noSubtitleReason 与 subtitleFetchState 同源变化（empty 收尾时两者同时
//     落定），跟随 fetchState 即可。
// 索引型数组只取长度不取内容：同 id 字幕重拉产生的等长新数组视为未变，
// 与 SP 侧 contextKey 的去重语义一致。
export function computeSidepanelStateSignature(snapshot) {
  const safe = snapshot && typeof snapshot === "object" ? snapshot : {};
  const body = Array.isArray(safe.subtitleBody) ? safe.subtitleBody : [];
  const options = Array.isArray(safe.subtitleOptions) ? safe.subtitleOptions : [];
  const chapters = Array.isArray(safe.chapters) ? safe.chapters : [];
  // cid 为空回退 aid：无 cid 的场景（老数据/异常页）仍有稳定键
  const cid = String(safe.cid || "").trim() || String(safe.aid || "").trim();
  return [
    String(safe.bvid || "").trim(),
    cid,
    Number(safe.pageIndex) > 0 ? Number(safe.pageIndex) : 1,
    String(safe.subtitleFetchState || "idle"),
    body.length,
    String(safe.selectedSubtitleId || "").trim(),
    options.length,
    chapters.length,
    safe.includeTimestampInBody !== false ? "1" : "0",
    String(safe.subtitleLang || "").trim()
  ].join("|");
}

// URL 变化编排（自 core/runtime.js 搬入）：core/url-watcher.js 只负责给 history
// 打补丁并广播 boc:urlchange（纯机制），本组合根监听 popstate/hashchange/
// boc:urlchange，按原顺序编排：更新 clip 签名 → 恢复普通页状态 → 确保 UI →
// 重置 clip → player-ai 按钮同步 → reader 同步/字幕刷新。行为与顺序与搬迁前完全一致。
let urlChangeHandlerBound = false;

export function bindUrlChangeHandler() {
  if (urlChangeHandlerBound) {
    return;
  }
  urlChangeHandlerBound = true;

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

  // 先注册监听，再由 startUrlWatcher 安装 history 补丁——与搬迁前
  // startUrlWatcher 内部「监听在前、补丁在后」的顺序保持一致。
  window.addEventListener("popstate", handleUrlChange);
  window.addEventListener("hashchange", handleUrlChange);
  window.addEventListener(BOC_URL_CHANGE_EVENT, handleUrlChange);
  startUrlWatcher();
}
