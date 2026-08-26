import { BOC_VERSION } from "../core/shared-defaults.js";
import { loadSubtitle } from "./fetcher.js";
import { buildSubtitlePreview } from "../notes/render.js";
import { isAiSubtitle } from "./selection.js";
import { sanitizeFileName } from "../shared/string-utils.js";
import { cleanVideoUrl } from "../bilibili/video-id-shared.js";
import { getSettings, byId } from "../core/runtime.js";
import { getErrorMessage, isStaleRunError } from "../shared/error-helpers.js";
import { DEFAULT_SETTINGS, normalizeDownloadFormat } from "../core/shared-defaults.js";
import { state, clipState } from "../core/state.js";
import { setMessage } from "../ui/ui-renderer.js";
import { ids } from "../reader/index.js";
import { refreshDerivedContent, rebuildDerivedContent } from "./core.js";
import { setBusyState, setStatus } from "../ui/ui-renderer.js";

export async function onSubtitleChange(event) {
  const value = event.target.value;
  const option = event.target.options[event.target.selectedIndex];
  const lang = option?.dataset.lang || "unknown";
  const subtitleId = option?.dataset.id || "";
  if (!value) {
    return;
  }

  try {
    setBusyState(true);
    setStatus(`正在切换字幕：${lang}`);
    setMessage("");
    await loadSubtitle(value, lang, state.clip.fetchRunId, subtitleId);
    setStatus("字幕切换完成。");
  } catch (error) {
    if (isStaleRunError(error)) {
      return;
    }
    setStatus(`切换字幕失败：${getErrorMessage(error)}`);
  } finally {
    setBusyState(false);
  }
}

export async function copyMarkdown() {
  state.setSettings(await getSettings());
  await refreshDerivedContent();
  if (!state.clip.markdown) {
    setMessage("没有可复制的内容，请先刷新抓取。");
    return;
  }

  try {
    await navigator.clipboard.writeText(state.clip.markdown);
    setMessage("Markdown 已复制到剪贴板。");
  } catch (error) {
    setMessage(`复制失败：${getErrorMessage(error)}`);
  }
}

export async function downloadSubtitle() {
  state.setSettings(await getSettings());
  rebuildDerivedContent();
  const format = normalizeDownloadFormat(state.settings?.downloadFormat);
  const content = format === "txt" ? state.clip.txt : state.clip.srt;
  if (!content) {
    setMessage("没有可下载的字幕，请先刷新抓取。");
    return;
  }

  const safeTitle = sanitizeFileName(state.clip.title || state.clip.bvid || "bilibili-subtitle");
  const langSuffix = sanitizeFileName(state.clip.selectedSubtitleLang || "subtitle") || "subtitle";
  const filename = `${safeTitle}.${langSuffix}.${format}`;
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  setMessage(`已下载：${filename}`);
}

export function getPopupPayload() {
  const subtitleOptions = (state.clip.subtitles || []).map((item) => {
    const label = item.lanDoc || item.lan || "unknown";
    const isAi = isAiSubtitle(item);
    const selectedById =
      state.clip.selectedSubtitleId && String(item.id) === String(state.clip.selectedSubtitleId);
    const selectedByUrl = item.subtitleUrl === state.clip.selectedSubtitleUrl;
    return {
      id: String(item.id || ""),
      url: item.subtitleUrl,
      lang: label,
      isAi,
      selected: selectedById || selectedByUrl
    };
  });

  return {
    contentVersion: BOC_VERSION,
    url: cleanVideoUrl(),
    title: state.clip.title || "",
    author: state.clip.author || "",
    uploadDate: state.clip.uploadDate || "",
    tags: String(state.settings?.tags || ""),
    status: state.ui.statusText || "",
    message: state.ui.messageText || "",
    subtitlePreview: buildSubtitlePreview(state.clip.subtitleBody || [], state.settings || DEFAULT_SETTINGS),
    markdown: state.clip.markdown || "",
    srt: state.clip.srt || "",
    txt: state.clip.txt || "",
    downloadFormat: normalizeDownloadFormat(state.settings?.downloadFormat),
    subtitleOptions
  };
}

export function applyNoSubtitleState() {
  clipState.setSelectedSubtitleId("");
  clipState.setSelectedSubtitleUrl("");
  clipState.setSelectedSubtitleLang("");
  clipState.setSubtitleBody([]);
  clipState.setSubtitleFetchState("empty");
  clipState.setHotComments([]);
  clipState.setMarkdown("");
  clipState.setSrt("");
  clipState.setTxt("");
  byId(ids.preview).value = "";
}

export function readVideoDescription() {
  const descNode = document.querySelector(
    ".desc-info-text, .video-desc .desc-info-text, .video-info-detail .text, .basic-desc-info"
  );
  return descNode?.textContent?.trim() || "";
}
