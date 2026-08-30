import { BOC_VERSION } from "../core/defaults.js";
import { loadSubtitle } from "./fetcher.js";
import { buildSubtitlePreview } from "../notes/render.js";
import { isAiSubtitle } from "./selection.js";
import { sanitizeFileName, escapeHtml } from "../shared/string-utils.js";
import { cleanVideoUrl } from "../bilibili/video-id-shared.js";
import { getSettings } from "../core/runtime.js";
import { byId } from "../shared/dom-utils.js";
import { getErrorMessage, isStaleRunError } from "../shared/error-helpers.js";
import { DEFAULT_SETTINGS } from "../core/defaults.js";
import { normalizeDownloadFormat } from "../core/validators.js";
import { state } from "../core/state.js";
import { setMessage } from "../ui/ui-renderer.js";
// ids 为常驻微模块（候选02 分层惰性）：纯常量表，不经 reader/index.js facade
// 转发（否则总结链会静态拖起整个 reader 域）。
import { ids } from "../reader/ids.js";
import { refreshDerivedContent, rebuildDerivedContent } from "./core.js";
import { setStatus } from "../ui/ui-renderer.js";

// ===== 抓取结果渲染（候选02 分层惰性：自 ui/ui-renderer.js 移入） =====
//
// renderMeta / renderSubtitleSelect / setBusyState 只渲染「抓取结果」（视频属性、
// 字幕轨列表、忙碌态），唯一调用方是总结链（fetcher 的抓取收尾/重置）与本模块
// 的交互回调——留在 ui-renderer（常驻）会把它对 selection.js（isAiSubtitle）及
// cache/cache-lru 的依赖一并拖回常驻。setStatus/setMessage 仍在 ui-renderer：
// URL 变化编排与本模块错误提示在启动期使用。
export function setBusyState(disabled) {
  byId(ids.copyBtn).disabled = disabled;
  byId(ids.downloadBtn).disabled = disabled;
  byId(ids.refreshBtn).disabled = disabled;
  byId(ids.settingsBtn).disabled = disabled;
  byId(ids.subtitleSelect).disabled = disabled || state.clip.subtitles.length === 0;
}

export function renderMeta() {
  const meta = byId(ids.meta);
  if (!state.clip.bvid) {
    meta.innerHTML = '<div class="boc-meta-item">尚未抓取视频信息</div>';
    return;
  }

  const subtitleCount = state.clip.subtitles.length;
  meta.innerHTML = `
    <div class="boc-meta-item"><strong>标题：</strong>${escapeHtml(state.clip.title)}</div>
    <div class="boc-meta-item"><strong>URL：</strong>${escapeHtml(cleanVideoUrl())}</div>
    <div class="boc-meta-item"><strong>作者：</strong>${escapeHtml(state.clip.author || "未知")}</div>
    <div class="boc-meta-item"><strong>日期：</strong>${escapeHtml(state.clip.uploadDate || "未知")}</div>
    <div class="boc-meta-item"><strong>字幕轨：</strong>${subtitleCount}</div>
  `;
}

export function renderSubtitleSelect() {
  const select = byId(ids.subtitleSelect);
  const subtitles = state.clip.subtitles || [];

  if (subtitles.length === 0) {
    select.innerHTML = '<option value="">暂无字幕</option>';
    select.disabled = true;
    return;
  }

  select.innerHTML = subtitles
    .map((item) => {
      const selectedById =
        state.clip.selectedSubtitleId && String(item.id) === String(state.clip.selectedSubtitleId);
      const selectedByUrl = item.subtitleUrl === state.clip.selectedSubtitleUrl;
      const selected = selectedById || selectedByUrl ? "selected" : "";
      const label = item.lanDoc || item.lan || "unknown";
      const isAi = isAiSubtitle(item);
      const aiTag = isAi ? " [AI自动]" : "";
      const optionLabel = `${label}${aiTag}`;
      return `<option value="${escapeHtml(item.subtitleUrl)}" data-lang="${escapeHtml(
        label
      )}" data-id="${escapeHtml(String(item.id || ""))}" data-isai="${isAi}" ${selected}>${escapeHtml(
        optionLabel
      )}</option>`;
    })
    .join("");
  select.disabled = false;
}

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

// applyNoSubtitleState 已迁入 subtitle/commit.js（commitNoSubtitle，无字幕出口
// 逆事务的唯一实现，CONTEXT.md「字幕接受」词条）——清空选中态/body/派生内容
// 与预览 DOM 属该事务，调用点（fetcher 的 finishNoSubtitle、asr/fallback 的
// 失败出口）一律改走 commit。

export function readVideoDescription() {
  const descNode = document.querySelector(
    ".desc-info-text, .video-desc .desc-info-text, .video-info-detail .text, .basic-desc-info"
  );
  return descNode?.textContent?.trim() || "";
}
