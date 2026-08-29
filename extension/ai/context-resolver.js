// extension/ai/context-resolver.js
// AI 侧边栏上下文解析：拉取视频元信息 + 字幕 + 热评，构建 Markdown 字幕上下文。
// 从 extension/entry/background.js 提取的深模块，只暴露 background.js 消息处理器
// 需要调用的函数；B站抓取统一走 bilibili/gateway.js 的 bgFetchJson 传输层。

import { getSubtitleCacheKey, loadSubtitleFromCache } from "../subtitle/cache.js";
import {
  fetchVideoMeta,
  fetchSubtitleBundle,
  fetchSubtitleBody,
  fetchHotComments,
  bgFetchJson,
  isBiliUrl
} from "../bilibili/gateway.js";
import {
  extractPageIndexFromUrl,
  buildCanonicalVideoUrl,
  isSupportedBilibiliPage
} from "../bilibili/video-id-shared.js";
import {
  pickPreferredSubtitle as pickPreferredSubtitleTrack,
  normalizeSubtitleTracks
} from "../subtitle/selection.js";
import { getMergedSettings } from "../core/settings-store.js";
import { withTimeout } from "../shared/error-helpers.js";
import { buildAiContextRef } from "./conversation.js";

// ===== 页内状态（由 background.js 注入：ensureReaderContentReady / sendMessageToTab）=====
// 在消息路由中直接读取，避免把注入生命周期耦合进本模块。

// ===== 上下文解析 =====

function pickPageForAiContext(pages, ref) {
  const safePages = Array.isArray(pages) ? pages : [];
  const targetCid = String(ref?.cid || "").trim();
  if (targetCid) {
    const byCid = safePages.find((item) => String(item?.cid || "") === targetCid);
    if (byCid) {
      return byCid;
    }
  }

  const pageIndex = extractPageIndexFromUrl(ref?.url || "");
  const byPage = safePages.find((item) => Number(item?.page) === pageIndex);
  if (byPage) {
    return byPage;
  }
}

export async function resolveAiSidepanelContext(contextRef) {
  const ref = buildAiContextRef(contextRef);
  if (!ref.isVideoContext || !ref.bvid) {
    return {
      title: ref.title,
      url: ref.url,
      author: ref.author,
      uploadDate: ref.uploadDate,
      subtitleBody: [],
      hotComments: [],
      isVideoContext: false
    };
  }

  const settings = await getMergedSettings();
  const videoMeta = await fetchVideoMeta(bgFetchJson, ref.bvid);
  const page = pickPageForAiContext(videoMeta.pages, ref);
  const cid = String(page?.cid || ref.cid || videoMeta.defaultCid || "").trim();
  if (!cid) {
    throw new Error("无法定位原视频分P");
  }
  const aid = String(videoMeta.aid || ref.aid || "").trim();
  const subtitleBundle = await fetchSubtitleBundle(bgFetchJson, { bvid: ref.bvid, cid, aid });
  const tracks = normalizeSubtitleTracks(subtitleBundle.tracks || []);
  if (!tracks.length) {
    throw new Error("原视频暂时没有可用字幕");
  }
  const selectedTrack = pickPreferredSubtitleTrack(tracks, {
    previousId: ref.selectedSubtitleId,
    previousUrl: ref.selectedSubtitleUrl,
    previousLang: ref.subtitleLang
  }) || tracks[0];
  const cacheKey = getSubtitleCacheKey({
    bvid: ref.bvid,
    cid,
    subtitleId: selectedTrack.id,
    subtitleUrl: selectedTrack.subtitleUrl,
    lang: selectedTrack.lanDoc || selectedTrack.lan
  });
  const cachedBody = await loadSubtitleFromCache(cacheKey);
  const body = Array.isArray(cachedBody) && cachedBody.length > 0
    ? cachedBody
    : await fetchSubtitleBody(bgFetchJson, selectedTrack.subtitleUrl);
  if (!body.length) {
    throw new Error("原视频字幕为空");
  }

  const pageIndex = Number(page?.page || extractPageIndexFromUrl(ref.url) || 1) || 1;
  const hotComments = await fetchHotComments(bgFetchJson, aid);
  const title = String(videoMeta.title || ref.title || "").trim();
  const author = String(videoMeta.author || ref.author || "").trim();
  const uploadDate = String(videoMeta.uploadDate || ref.uploadDate || "").trim();
  const pageTitle = String(page?.part || ref.pageTitle || "").trim();
  const url = buildCanonicalVideoUrl(ref.bvid, pageIndex) || ref.url;
  const videoDuration = Number(page?.duration || videoMeta.defaultDuration || 0) || 0;

  return {
    title,
    url,
    author,
    uploadDate,
    bvid: ref.bvid,
    cid,
    aid,
    pageIndex,
    pageTitle,
    subtitleLang: String(selectedTrack.lanDoc || selectedTrack.lan || "").trim(),
    selectedSubtitleId: String(selectedTrack.id || "").trim(),
    selectedSubtitleUrl: String(selectedTrack.subtitleUrl || "").trim(),
    // 章节透传（来源与本文件 return 里的 chapters 为同一份
    // subtitleBundle.chapters）：供侧边栏回传 offscreen 后做章节对齐切段
    // （budgeter）与追问章节名检索（raw-retrieval）。旧持久化会话 ref 无此
    // 字段时为 undefined，下游 Array.isArray 守卫均已容忍。
    chapters: Array.isArray(subtitleBundle.chapters) ? subtitleBundle.chapters : [],
    // 视频时长（分 P duration，缺省回退全片 defaultDuration）：发模型前由
    // ai/subtitle-prompt.js 的 buildSubtitlePrompt 用于 withHours（小时级时间戳）判定。
    videoDuration,
    // 字幕时间戳开关透传：offscreen 渲染 prompt 时沿用同一设置，保证与预算判定
    // 同源的渲染产物和笔记样式一致；旧数据缺失时消费方按默认 true 处理。
    includeTimestampInBody: settings?.includeTimestampInBody !== false,
    subtitleBody: body,
    subtitleOptions: tracks.map((item) => ({
      id: String(item.id || "").trim(),
      url: String(item.subtitleUrl || "").trim(),
      lang: String(item.lanDoc || item.lan || "").trim()
    })),
    hotComments,
    isVideoContext: true
  };
}

export async function resolveAiSidepanelPageRef(contextRef) {
  const ref = buildAiContextRef(contextRef);
  if (!ref.isVideoContext || !ref.bvid) {
    return {
      url: ref.url,
      bvid: ref.bvid,
      cid: ref.cid,
      pageIndex: Number(ref.pageIndex) > 0 ? Number(ref.pageIndex) : 1,
      pageTitle: ref.pageTitle
    };
  }

  const videoMeta = await fetchVideoMeta(bgFetchJson, ref.bvid);
  const page = pickPageForAiContext(videoMeta.pages, ref);
  const pageIndex = Number(page?.page || ref.pageIndex || extractPageIndexFromUrl(ref.url) || 1) || 1;
  return {
    url: buildCanonicalVideoUrl(ref.bvid, pageIndex) || ref.url,
    bvid: ref.bvid,
    cid: String(page?.cid || ref.cid || "").trim(),
    pageIndex,
    pageTitle: String(page?.part || ref.pageTitle || "").trim()
  };
}

// ===== 页内状态获取（依赖注入 tabOps：ensureReaderContentReady + sendMessageToTab）=====

// popup-refresh 的响应要等 content 的 refreshClip 全程完成；无字幕长视频会
// 触发小时级 ASR 转写，消息通道撑不住这种长事务（挂起期间任何失败都会让
// 侧边栏把上下文清空、误报"不是 B 站视频页"）。限时等待，超时视为"抓取仍在
// 后台进行"，回退读取当前快照（subtitleFetchState 会告知转写进行中）。
const REFRESH_WAIT_MS = 10000;

export async function getAiSidepanelState(tabId, { forceRefresh = false, ifSignature = "" } = {}, tabOps = {}) {
  const { ensureReaderContentReady, sendMessageToTab } = tabOps;
  if (!tabId) {
    throw new Error("缺少标签页信息");
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id) {
    throw new Error("找不到当前标签页。");
  }

  if (!isSupportedBilibiliPage(tab.url)) {
    return {
      title: String(tab.title || "").trim(),
      url: String(tab.url || "").trim(),
      author: "",
      uploadDate: "",
      subtitleBody: [],
      hotComments: [],
      isVideoContext: false
    };
  }

  await ensureReaderContentReady(tab.id);

  let contextResp = await sendMessageToTab(tab.id, {
    type: "sidepanel-get-context",
    forceRefresh,
    // 候选5：透传 SP 上次全量快照的签名；content 判定状态未变时整份省略。
    // forceRefresh=true 时 content 侧忽略签名，语义不变。
    ifSignature
  });

  // 候选5 签名短路：content 状态与 SP 快照一致 → 不取字幕、不发 popup-refresh、
  // 也不拉热评（下方热评块不可达），直接向上透传 unchanged（background 原样
  // 包进 payload 回给 SP，SP 据此跳过 apply/渲染）。短路只发生在首查——后面
  // needsRefresh 分支的复查不带签名，必然回全量。
  if (contextResp?.ok && contextResp?.unchanged === true) {
    return { unchanged: true };
  }

  const hasPayload = Boolean(contextResp?.ok && contextResp?.payload);
  const hasLoadedClip = Boolean(
    contextResp?.payload?.bvid ||
    contextResp?.payload?.aid ||
    contextResp?.payload?.title
  );
  const needsRefresh =
    forceRefresh ||
    !hasPayload ||
    (!hasLoadedClip && (!Array.isArray(contextResp.payload.subtitleBody) || !contextResp.payload.subtitleBody.length));

  if (needsRefresh) {
    const refreshResp = await withTimeout(
      sendMessageToTab(tab.id, { type: "popup-refresh" }),
      REFRESH_WAIT_MS
    );
    if (!refreshResp?.ok) {
      // 超时（无响应）或 content 报错：不整体失败，回退读取当前快照。
      // 无字幕长视频的 ASR 转写以分钟/小时计，这里必须立刻返回"转写中"的
      // 可用快照，由 sidepanel 决定等待策略。
      contextResp = await sendMessageToTab(tab.id, { type: "sidepanel-get-context" });
      if (!contextResp?.ok || !contextResp?.payload) {
        throw new Error(refreshResp?.error || "当前视频上下文加载失败");
      }
    } else {
      contextResp = await sendMessageToTab(tab.id, { type: "sidepanel-get-context" });
    }
  }

  if (!contextResp?.ok || !contextResp?.payload) {
    throw new Error("当前页面上下文读取失败");
  }

  // 候选5：热评网络拉取只发生在全量路径——unchanged 已在上方提前返回，走到
  // 这里必然是全量（或 forceRefresh 后的复查），为热评多一次往返才值得。
  let hotComments = [];
  try {
    const commentsResp = await sendMessageToTab(tab.id, { type: "sidepanel-get-hot-comments" });
    if (commentsResp?.ok && Array.isArray(commentsResp.comments)) {
      hotComments = commentsResp.comments;
    }
  } catch {
    // 评论失败时静默降级，避免阻断主流程
  }

  return {
    ...contextResp.payload,
    hotComments,
    isVideoContext: true
  };
}
