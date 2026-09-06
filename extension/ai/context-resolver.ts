// extension/ai/context-resolver.ts
// AI 对话上下文的纯网络路径适配器（arch-slim/07 收口后的角色）：仅在「无页面 /
// 无标签页」场景被消费，不持有进程内装配策略——AiContext 快照的装配知识单源在
// core/context-payload（形状/校验/签名）+ core/context-assembly（唯一装配链）。
//   resolveAiConversationContext   按任意 contextRef 经 bgFetchJson 拉取视频
//                                  元信息/字幕装配上下文：pinned 补水身份短路
//                                  未命中（无当前页面可快照）时的兜底，组合根
//                                  经 conversation-store 的 resolveAiConversationRef
//                                  接缝注入（purpose="context"）；
//   resolveAiConversationPageRef  分页信息解析（purpose="page"）。
// （原 getAiContextState 的 tab transport 随扩展页消息链策略退役，见 ticket
// arch-slim-4/01——它是 reader-get-context / clip-refresh 两条消息的唯一发送方。）
// B站抓取统一走 bilibili/gateway-core.js 的 bgFetchJson 传输叶（arch-slim-2/04 拆叶）。

import { getSubtitleCacheKey, loadSubtitleFromCache } from "../subtitle/cache.js";
import {
  fetchVideoMeta,
  fetchSubtitleBundle,
  fetchSubtitleBody,
  type VideoMeta,
  type VideoPage,
  type SubtitleTrack,
  type Chapter
} from "../bilibili/gateway.js";
import { bgFetchJson } from "../bilibili/gateway-core.js";
import {
  extractPageIndexFromUrl,
  buildCanonicalVideoUrl
} from "../bilibili/video-id-shared.js";
import {
  pickPreferredSubtitle as pickPreferredSubtitleTrack,
  normalizeSubtitleTracks
} from "../subtitle/selection.js";
import { getMergedSettings } from "../core/settings-store.js";
import { buildAiContextRef } from "./conversation.js";
import type { AiContext, HotComment, SubtitleBodyItem } from "./types.js";

// ===== 上下文解析 =====

function pickPageForAiContext(pages: VideoPage[], ref: AiContext): VideoPage | undefined {
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

export async function resolveAiConversationContext(contextRef: unknown): Promise<AiContext> {
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
  // 缓存命中免一次字幕正文下载；未命中按 gateway 现代签名只传 url、解构
  // { body }（与 subtitle/fetcher 等其余调用点同一条 contentFetchJson 通道）。
  const body = Array.isArray(cachedBody) && cachedBody.length > 0
    ? cachedBody
    : (await fetchSubtitleBody(selectedTrack.subtitleUrl)).body;
  if (!body.length) {
    throw new Error("原视频字幕为空");
  }

  const pageIndex = Number(page?.page || extractPageIndexFromUrl(ref.url || "") || 1) || 1;
  // 热评恒为空数组：gateway 现代签名 fetchHotComments(count) 按 getCurrentAid()
  // 取「当前视频」的 aid，对任意 contextRef 的网络解析会把别的视频的热评装进
  // 上下文；旧调用点（transport + aid 两参）自签名变更起实际恒返回空数组
  //（count 位被 transport 占位污染为 0 → 早退）。按现状保留空数组，可感知
  // 行为零变化；per-aid 拉取（gateway 内部的 fetchHotCommentsJson）待后续票接通。
  const hotComments: HotComment[] = [];
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
    // subtitleBundle.chapters）：供对话链回传 offscreen 后做章节对齐切段
    // （budgeter）与追问章节名检索（raw-retrieval）。旧持久化会话 ref 无此
    // 字段时为 undefined，下游 Array.isArray 守卫均已容忍。
    chapters: Array.isArray(subtitleBundle.chapters) ? (subtitleBundle.chapters as unknown as AiContext["chapters"]) : [],
    // 视频时长（分 P duration，缺省回退全片 defaultDuration）：发模型前由
    // ai/subtitle-prompt.js 的 buildSubtitlePrompt 用于 withHours（小时级时间戳）判定。
    videoDuration,
    // 字幕时间戳开关透传：offscreen 渲染 prompt 时沿用同一设置，保证与预算判定
    // 同源的渲染产物和笔记样式一致；旧数据缺失时消费方按默认 true 处理。
    includeTimestampInBody: settings?.includeTimestampInBody !== false,
    subtitleBody: body as SubtitleBodyItem[],
    subtitleOptions: tracks.map((item: SubtitleTrack) => ({
      id: String(item.id || "").trim(),
      url: String(item.subtitleUrl || "").trim(),
      lang: String(item.lanDoc || item.lan || "").trim()
    })),
    hotComments,
    isVideoContext: true
  };
}

export async function resolveAiConversationPageRef(contextRef: unknown): Promise<{
  url: string;
  bvid: string;
  cid: string;
  pageIndex: number;
  pageTitle: string;
}> {
  const ref = buildAiContextRef(contextRef);
  if (!ref.isVideoContext || !ref.bvid) {
    return {
      url: ref.url || "",
      bvid: ref.bvid || "",
      cid: ref.cid || "",
      pageIndex: Number(ref.pageIndex) > 0 ? Number(ref.pageIndex) : 1,
      pageTitle: ref.pageTitle || ""
    };
  }

  const videoMeta = await fetchVideoMeta(bgFetchJson, ref.bvid);
  const page = pickPageForAiContext(videoMeta.pages, ref);
  const pageIndex = Number(page?.page || ref.pageIndex || extractPageIndexFromUrl(ref.url || "") || 1) || 1;
  return {
    url: buildCanonicalVideoUrl(ref.bvid, pageIndex) || ref.url || "",
    bvid: ref.bvid,
    cid: String(page?.cid || ref.cid || "").trim(),
    pageIndex,
    pageTitle: String(page?.part || ref.pageTitle || "").trim()
  };
}
