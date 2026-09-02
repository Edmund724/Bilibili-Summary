import { BOC_VERSION } from "../core/defaults.js";
import { loadSubtitle } from "./fetcher.js";
import { buildSubtitlePreview, buildTxt } from "../notes/render.js";
import { isAiSubtitle } from "./selection.js";
import { sanitizeFileName, escapeHtml } from "../shared/string-utils.js";
import { cleanVideoUrl } from "../bilibili/video-id-shared.js";
import { getSettings } from "../core/runtime.js";
import { getErrorMessage, isStaleRunError } from "../shared/error-helpers.js";
import { DEFAULT_SETTINGS } from "../core/defaults.js";
import { normalizeDownloadFormat } from "../core/validators.js";
import { state } from "../core/state.js";
// 候选03 常驻瘦身：setMessage / setStatus 迁入 shared/ui-status.js。
import { setMessage, setStatus } from "../shared/ui-status.js";
// ids 为 reader 状态微模块（候选04 结构归并）：纯常量表，不经 reader/index.js
// facade 转发（否则总结链会静态拖起整个 reader 域）。
import { refreshDerivedContent, rebuildDerivedContent } from "./core.js";

// ===== 链层交互（候选02 分层惰性：自 ui/ui-renderer.js 移入） =====
//
// copyMarkdown / copySubtitleTranscript / downloadSubtitle / onSubtitleChange /
// buildClipSnapshotPayload 只服务总结链与面板交互，留在 ui-renderer（常驻）会把它对
// selection.js（isAiSubtitle）及 cache/cache-lru 的依赖一并拖回常驻。
// setStatus/setMessage 仍在 shared/ui-status：URL 变化编排与本模块错误提示在
// 启动期使用。
//（digest-only-ui：经典侧栏面板删除后，renderMeta / renderSubtitleSelect /
// setBusyState 三件「抓取结果渲染」已无目标节点——阅读视图的元信息/字幕轨由
// reader 域的 renderReadingView/renderReadingSubtitleSelect 渲染，本节移除。）

export async function onSubtitleChange(event: Event): Promise<void> {
  const target = event.target as HTMLSelectElement;
  const value = target.value;
  const option = target.options[target.selectedIndex];
  const lang = option?.dataset.lang || "unknown";
  const subtitleId = option?.dataset.id || "";
  if (!value) {
    return;
  }

  try {
    setStatus(`正在切换字幕：${lang}`);
    setMessage("");
    await loadSubtitle(value, lang, state.clip.fetchRunId, subtitleId);
    setStatus("字幕切换完成。");
  } catch (error) {
    if (isStaleRunError(error)) {
      return;
    }
    setStatus(`切换字幕失败：${getErrorMessage(error)}`);
  }
}

export async function copyMarkdown(): Promise<void> {
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

// 阅读模式字幕 tab 的「复制」（PR3 接线）：复制字幕纯文本——transcript 语义，
// 与 TXT 导出同一渲染管线（buildTxt，按 includeTimestampInBody 设置决定是否带
// 时间戳）；与 copyMarkdown（复制完整 Markdown 笔记）语义区分。取数与反馈
// 风格照抄 copyMarkdown，逻辑零新增。
export async function copySubtitleTranscript(): Promise<void> {
  state.setSettings(await getSettings());
  const text = buildTxt(state.clip.subtitleBody, state.settings);
  if (!text) {
    setMessage("没有可复制的字幕，请先刷新抓取。");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    setMessage("字幕已复制到剪贴板。");
  } catch (error) {
    setMessage(`复制失败：${getErrorMessage(error)}`);
  }
}

export async function downloadSubtitle(): Promise<void> {
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

export function buildClipSnapshotPayload(): Record<string, unknown> {
  const subtitleOptions = (state.clip.subtitles || []).map((item) => {
    const label = item.lanDoc || item.lan || "unknown";
    const isAi = isAiSubtitle(item);
    const selectedById =
      state.clip.selectedSubtitleId && String(item.id || "") === String(state.clip.selectedSubtitleId);
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

export function readVideoDescription(): string {
  const descNode = document.querySelector(
    ".desc-info-text, .video-desc .desc-info-text, .video-info-detail .text, .basic-desc-info"
  );
  return descNode?.textContent?.trim() || "";
}
