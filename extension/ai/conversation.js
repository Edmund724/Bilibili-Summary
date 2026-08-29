// conversation.js
// 会话生命周期 + 上下文 key 计算的纯函数模块（Candidate 7 抽取）。
// 作为经典脚本加载，不依赖任何外部状态或 Chrome API。

import { extractBvid, extractPageIndexFromUrl } from "../bilibili/video-id-shared.js";

export const MAX_SAVED_CONVERSATIONS = 60;

// ============ 上下文 key ============

export function buildContextKey(payload) {
  if (!payload) {
    return "";
  }
  const bvid = String(payload.bvid || "").trim();
  const cid = String(payload.cid || "").trim();
  const aid = String(payload.aid || "").trim();
  if (bvid || cid || aid) {
    return `video:${bvid}|${cid || aid}`;
  }
  const normalizedUrl = normalizeContextUrlForKey(payload.url);
  return normalizedUrl ? `url:${normalizedUrl}` : "";
}

export function normalizeContextUrlForKey(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  try {
    const parsed = new URL(text);
    parsed.hash = "";
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return text;
  }
}

// ============ 会话规范化 ============

export function normalizeConversations(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const messages = Array.isArray(item?.messages)
        ? item.messages
            .filter((msg) => msg && (msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string")
            .map((msg) => ({ role: msg.role, content: String(msg.content) }))
        : [];
      const id = String(item?.id || "").trim();
      if (!id || !messages.length) {
        return null;
      }
      const contextTitle = String(item?.contextTitle || "").trim();
      const contextRef = buildAiContextRef(item?.contextRef || item?.contextSnapshot || item);
      const contextUrl = String(item?.contextUrl || "").trim();
      return {
        id,
        title: normalizeConversationTitle(item?.title, contextTitle, contextRef, contextUrl),
        contextKey: resolveConversationStorageKey(item?.contextKey, contextRef, contextUrl),
        contextTitle,
        contextUrl,
        isVideoContext: item?.isVideoContext !== false,
        createdAt: Number(item?.createdAt) || Date.now(),
        updatedAt: Number(item?.updatedAt) || Date.now(),
        contextRef,
        messages
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_SAVED_CONVERSATIONS);
}

export function resolveConversationStorageKey(rawKey, contextRef, contextUrl = "") {
  const normalizedRefKey = buildContextKey(contextRef);
  if (normalizedRefKey) {
    return normalizedRefKey;
  }
  const normalizedUrlKey = buildContextKey({ url: contextUrl });
  if (normalizedUrlKey) {
    return normalizedUrlKey;
  }
  return String(rawKey || "").trim();
}

// ============ 上下文引用 ============

// AI 上下文 ref 单一构造器：15 字段（14 个视频身份/字幕轨字段 + chapters）。
// 原三份手写挑选清单（context-resolver 的解析入参归一化、会话持久化 contextRef、
// 占位上下文）统一收敛于此；bvid 缺失时从 url 回落提取；chapters 为数组时
// 透传、缺失/非法时 undefined（消费方均以 Array.isArray 容忍，旧持久化会话
// 的 ref 无此字段也自然落到 undefined）。
export function buildAiContextRef(context) {
  const value = context && typeof context === "object" ? context : {};
  const url = String(value.url || "").trim();
  return {
    title: String(value.title || "").trim(),
    url,
    author: String(value.author || "").trim(),
    uploadDate: String(value.uploadDate || "").trim(),
    bvid: String(value.bvid || extractBvid(url) || "").trim(),
    cid: String(value.cid || "").trim(),
    aid: String(value.aid || "").trim(),
    pageIndex: Number(value.pageIndex) > 0 ? Number(value.pageIndex) : 1,
    pageCount: Number(value.pageCount) > 0 ? Number(value.pageCount) : 0,
    pageTitle: String(value.pageTitle || "").trim(),
    subtitleLang: String(value.subtitleLang || "").trim(),
    selectedSubtitleId: String(value.selectedSubtitleId || "").trim(),
    selectedSubtitleUrl: String(value.selectedSubtitleUrl || "").trim(),
    chapters: Array.isArray(value.chapters) ? value.chapters : undefined,
    isVideoContext: value.isVideoContext !== false
  };
}

export function buildContextPlaceholder(ref) {
  if (!ref || typeof ref !== "object") {
    return null;
  }
  return {
    ...buildAiContextRef(ref),
    subtitleMarkdown: "",
    hotComments: []
  };
}

// ============ 标题 ============

export function buildConversationTitle(context) {
  const rawTitle = String(context?.title || "当前页面").trim() || "当前页面";
  const baseTitle = extractConversationBaseTitle(rawTitle);
  return appendConversationPageSuffix(baseTitle, context);
}

export function normalizeConversationTitle(title, contextTitle = "", contextRef = null, contextUrl = "") {
  const preferredTitle = String(contextTitle || "").trim() || String(title || "").trim();
  const baseTitle = extractConversationBaseTitle(preferredTitle);
  return appendConversationPageSuffix(baseTitle || "历史对话", contextRef || { url: contextUrl });
}

export function extractConversationBaseTitle(title) {
  const raw = String(title || "").trim();
  if (!raw) {
    return "当前页面";
  }
  const normalizedRaw = raw.replace(/-P\d+$/i, "").trim();
  const parts = normalizedRaw
    .split(/\s+[|｜]\s+|\s+-\s+|\s+[—–]\s+|\s+[·•]\s+|\r?\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return parts[0] || normalizedRaw;
}

export function buildConversationTitleDisplay(title, maxChars = 22) {
  const value = String(title || "").trim();
  const match = value.match(/^(.*?)(-P\d+)$/i);
  if (!match) {
    return {
      main: value.length > maxChars ? `${value.slice(0, maxChars)}...` : value,
      suffix: ""
    };
  }

  const suffix = String(match[2] || "").trim();
  const baseTitle = String(match[1] || "").trim();
  const reservedChars = Math.max(suffix.length + 3, 6);
  const availableChars = Math.max(maxChars - reservedChars, 8);
  return {
    main: baseTitle.length > availableChars ? `${baseTitle.slice(0, availableChars)}...` : baseTitle,
    suffix
  };
}

export function appendConversationPageSuffix(title, context) {
  const baseTitle = String(title || "").trim() || "历史对话";
  const existingSuffixMatch = baseTitle.match(/-P\d+$/i);
  const cleanTitle = existingSuffixMatch ? baseTitle.replace(/-P\d+$/i, "").trim() : baseTitle;
  const pageSuffix = extractConversationPageSuffix(context);
  return pageSuffix ? `${cleanTitle}${pageSuffix}` : cleanTitle;
}

export function extractConversationPageSuffix(context) {
  const pageIndex = Number(context?.pageIndex || context?.page || 0) || extractPageIndexFromUrl(context?.url);
  return pageIndex > 1 ? `-P${pageIndex}` : "";
}

// ============ ID / 时间 ============

export function generateConversationId() {
  return `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function formatConversationTimestamp(value) {
  const date = new Date(Number(value) || Date.now());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

// ============ 匹配 / 比较 ============

export function doesConversationMatchCurrentContext(conversation, currentRef, targetContextKey = "") {
  if (!conversation) {
    return false;
  }
  const normalizedConversationKey = resolveConversationStorageKey(
    conversation.contextKey,
    conversation.contextRef,
    conversation.contextUrl
  );
  const normalizedTargetKey = String(targetContextKey || buildContextKey(currentRef)).trim();
  if (normalizedConversationKey && normalizedTargetKey && normalizedConversationKey === normalizedTargetKey) {
    return true;
  }

  const conversationUrl = String(conversation.contextUrl || conversation.contextRef?.url || "").trim();
  const currentUrl = String(currentRef?.url || "").trim();
  if (conversationUrl && currentUrl) {
    return doesTabMatchContextUrl(currentUrl, conversationUrl);
  }
  return false;
}

export function doesTabMatchContextUrl(tabUrl, targetUrl) {
  const current = extractVideoIdentity(tabUrl);
  const target = extractVideoIdentity(targetUrl);
  if (!current.bvid || !target.bvid) {
    return String(tabUrl || "").trim() === String(targetUrl || "").trim();
  }
  return current.bvid === target.bvid && current.page === target.page;
}

export function extractVideoIdentity(url) {
  const text = String(url || "").trim();
  const bvid = extractBvid(text);
  let page = 1;
  try {
    page = Number(new URL(text).searchParams.get("p") || "1");
    if (!Number.isFinite(page) || page <= 0) {
      page = 1;
    }
  } catch {
    page = 1;
  }
  return {
    bvid: String(bvid || "").trim(),
    page
  };
}


