importScripts('defaults.js');

const DEFAULT_SYNC_SETTINGS = {
  tags: "clippings,bilibili",
  downloadFormat: "srt",
  includeDateInFilename: true,
  includeHotCommentsInNote: false,
  enablePlayerAiQuickAction: false,
  playerAiQuickPrompt: DEFAULT_PLAYER_AI_QUICK_PROMPT,
  includeTimestampInBody: true,
  enableDebugLogs: false,
  readerTheme: "light",
  readerFontScale: "m",
  readerLetterSpacing: "normal",
  readerLineHeight: "tight",
  readerContentWidth: "medium",
  readerChapterVisibility: "show",
  readerTranscriptVisible: true,
  frontmatterFields: [
    "title",
    "url",
    "bvid",
    "cid",
    "author",
    "upload_date",
    "subtitle_lang",
    "created",
    "tags"
  ],
  fixedFrontmatterProperties: [],
  notePlaceholderSections: [],
  aiSystemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
  aiInitialQuickPrompts: DEFAULT_INITIAL_QUICK_PROMPTS.slice(),
  aiPresetPrompts: DEFAULT_PRESET_PROMPTS.slice(),
  defaultModel: ""
};

const EXPECTED_CONTENT_SCRIPT_VERSION = chrome.runtime.getManifest().version || "";

chrome.runtime.onInstalled.addListener(async () => {
  await initializeSettingsStorage();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url) return;
  if (!isSupportedBilibiliPage(tab.url)) return;

  try {
    const loadedVersion = await probeContentScriptVersion(tabId);
    if (loadedVersion !== EXPECTED_CONTENT_SCRIPT_VERSION) {
      await injectReaderContent(tabId);
    }
  } catch (error) {
    // ignore injection failure; user may need a hard refresh
  }
});

async function ensureReaderContentReady(tabId) {
  if (!chrome.scripting || !tabId) {
    return;
  }

  const loadedVersion = await probeContentScriptVersion(tabId);
  if (loadedVersion === EXPECTED_CONTENT_SCRIPT_VERSION) {
    return;
  }

  await injectReaderContent(tabId);
  const reinjectedVersion = await probeContentScriptVersion(tabId);
  if (reinjectedVersion === EXPECTED_CONTENT_SCRIPT_VERSION) {
    return;
  }

  if (loadedVersion && loadedVersion !== EXPECTED_CONTENT_SCRIPT_VERSION) {
    await chrome.tabs.reload(tabId);
    const ready = await waitForTabComplete(tabId);
    if (!ready) {
      throw new Error("扩展更新后页面未及时恢复，请刷新浏览器网页重试");
    }
    await sleep(120);
    await injectReaderContent(tabId);
    const reloadedVersion = await probeContentScriptVersion(tabId);
    if (reloadedVersion === EXPECTED_CONTENT_SCRIPT_VERSION) {
      return;
    }
  }

  throw new Error("扩展脚本未能和当前页面同步，请刷新浏览器网页重试");
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeContentScriptVersion(tabId) {
  try {
    const probe = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__BOC_CONTENT_SCRIPT_LOADED__ || ""
    });
    return String(probe?.[0]?.result || "");
  } catch {
    return "";
  }
}

async function injectReaderContent(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content.css"]
  });

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (!message.includes("Identifier 'DEFAULT_SETTINGS' has already been declared")) {
      throw error;
    }
  }
}

async function waitForTabComplete(tabId, retries = 40, delayMs = 250) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") {
      return true;
    }
    await sleep(delayMs);
  }
  return false;
}

async function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

async function triggerReaderModeInTab(tabId, readerUrl = "", retries = 12, delayMs = 300) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (attempt > 0) {
      await sleep(delayMs);
    }

    try {
      const response = await sendMessageToTab(tabId, {
        type: "popup-trigger-reading-view",
        readerUrl
      });
      if (response?.ok) {
        return true;
      }
    } catch (error) {
      const message = String(error?.message || "");
      if (message.includes("Could not establish connection. Receiving end does not exist.")) {
        try {
          await ensureReaderContentReady(tabId);
        } catch {
          // keep retrying
        }
        continue;
      }
    }
  }

  return false;
}



async function getAiSidepanelState(tabId, { forceRefresh = false } = {}) {
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
      subtitleMarkdown: "",
      subtitleBody: [],
      hotComments: [],
      isVideoContext: false
    };
  }

  await ensureReaderContentReady(tab.id);

  let contextResp = await sendMessageToTab(tab.id, { type: "sidepanel-get-context" });
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
    const refreshResp = await sendMessageToTab(tab.id, { type: "popup-refresh" });
    if (!refreshResp?.ok) {
      throw new Error(refreshResp?.error || "当前视频上下文加载失败");
    }
    contextResp = await sendMessageToTab(tab.id, { type: "sidepanel-get-context" });
  }

  if (!contextResp?.ok || !contextResp?.payload) {
    throw new Error("当前页面上下文读取失败");
  }

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

async function openAiSidepanelForTab(tabId) {
  if (globalThis.browser?.sidebarAction?.open) {
    await Promise.resolve(globalThis.browser.sidebarAction.open());
    return;
  }

  if (chrome.sidePanel?.open) {
    await chrome.sidePanel.open({ tabId });
    return;
  }

  throw new Error("当前浏览器不支持扩展侧边栏");
}

function buildPlayerAiQuickActionRequest(tabId, prompt) {
  const createdAt = Date.now();
  return {
    id: `player-ai-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    tabId: Number(tabId || 0) || 0,
    prompt: normalizePlayerAiQuickPrompt(prompt),
    createdAt
  };
}

function normalizeAiContextRef(ref) {
  const value = ref && typeof ref === "object" ? ref : {};
  return {
    title: String(value.title || "").trim(),
    url: String(value.url || "").trim(),
    author: String(value.author || "").trim(),
    uploadDate: String(value.uploadDate || "").trim(),
    bvid: String(value.bvid || extractBvidFromUrl(value.url) || "").trim(),
    cid: String(value.cid || "").trim(),
    aid: String(value.aid || "").trim(),
    pageIndex: Number(value.pageIndex) > 0 ? Number(value.pageIndex) : 1,
    pageCount: Number(value.pageCount) > 0 ? Number(value.pageCount) : 0,
    pageTitle: String(value.pageTitle || "").trim(),
    subtitleLang: String(value.subtitleLang || "").trim(),
    selectedSubtitleId: String(value.selectedSubtitleId || "").trim(),
    selectedSubtitleUrl: String(value.selectedSubtitleUrl || "").trim(),
    isVideoContext: value.isVideoContext !== false
  };
}

function extractBvidFromUrl(url) {
  const text = String(url || "").trim();
  const match = text.match(/\/video\/(BV[0-9A-Za-z]+)/i) || text.match(/[?&]bvid=(BV[0-9A-Za-z]+)/i);
  return match?.[1] || "";
}



function extractPageIndexFromUrl(url) {
  try {
    const page = Number(new URL(String(url || "")).searchParams.get("p") || "1");
    return Number.isFinite(page) && page > 0 ? page : 1;
  } catch {
    return 1;
  }
}

function buildCanonicalVideoUrl(bvid, pageIndex = 1) {
  const safeBvid = String(bvid || "").trim();
  if (!safeBvid) {
    return "";
  }
  if (Number(pageIndex) > 1) {
    return `https://www.bilibili.com/video/${safeBvid}/?p=${Number(pageIndex)}`;
  }
  return `https://www.bilibili.com/video/${safeBvid}/`;
}

function createBiliHeaders(url) {
  const headers = new Headers();
  const isBiliRequest = /(?:api\.bilibili\.com|hdslb\.com)/.test(String(url || ""));
  if (isBiliRequest) {
    headers.set("Accept", "application/json, text/plain, */*");
    headers.set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
    headers.set("Cache-Control", "no-cache");
    headers.set("Pragma", "no-cache");
  }
  return headers;
}

async function fetchJsonForAi(url) {
  const headers = createBiliHeaders(url);
  const options = {
    method: "GET",
    credentials: "include",
    cache: "no-store"
  };
  if (headers.size > 0) {
    options.headers = headers;
  }
  if (/(?:api\.bilibili\.com|hdslb\.com)/.test(String(url || ""))) {
    options.referrer = "https://www.bilibili.com/";
    options.referrerPolicy = "strict-origin-when-cross-origin";
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchBiliVideoMetaByBvid(bvid) {
  const payload = await fetchJsonForAi(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  if (payload?.code !== 0) {
    throw new Error(String(payload?.message || "无法获取视频信息"));
  }

  const data = payload.data || {};
  const pages = Array.isArray(data.pages) ? data.pages : [];
  return {
    aid: String(data.aid || "").trim(),
    title: String(data.title || "").trim(),
    author: String(data.owner?.name || "").trim(),
    uploadDate: Number(data.pubdate) > 0 ? formatLocalDate(Number(data.pubdate) * 1000) : "",
    defaultCid: String(data.cid || "").trim(),
    defaultDuration: Number(data.duration || 0) || 0,
    pages: pages.map((item) => ({
      cid: String(item?.cid || "").trim(),
      page: Number(item?.page || 0) || 0,
      part: String(item?.part || "").trim(),
      duration: Number(item?.duration || 0) || 0
    }))
  };
}

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

  return safePages[0] || null;
}

function buildSubtitleInfoRequests({ bvid, cid, aid }) {
  const safeBvid = encodeURIComponent(String(bvid || ""));
  const safeCid = encodeURIComponent(String(cid || ""));
  const safeAid = encodeURIComponent(String(aid || ""));
  const requests = [];

  if (aid) {
    requests.push({
      source: "player-wbi-v2",
      url:
        "https://api.bilibili.com/x/player/wbi/v2" +
        `?aid=${safeAid}` +
        `&cid=${safeCid}` +
        (bvid ? `&bvid=${safeBvid}` : "")
    });
  }

  requests.push({
    source: "player-v2",
    url:
      "https://api.bilibili.com/x/player/v2" +
      (bvid ? `?bvid=${safeBvid}` : "?") +
      `${bvid ? "&" : ""}cid=${safeCid}` +
      (aid ? `&aid=${safeAid}` : "")
  });

  return requests;
}

function mapSubtitleTracks(subtitles, source = "unknown") {
  return (subtitles || []).map((item) => ({
    id: item?.id === undefined || item?.id === null ? "" : String(item.id),
    lan: item?.lan || "",
    lanDoc: item?.lan_doc || "",
    subtitleUrl: normalizeSubtitleUrl(item?.subtitle_url || ""),
    source
  }));
}

function normalizeSubtitleUrl(url) {
  const text = String(url || "").trim();
  if (!text) {
    return "";
  }
  if (text.startsWith("//")) {
    return `https:${text}`;
  }
  return text;
}

function mapChaptersFromPlayerData(data) {
  const raw = Array.isArray(data?.view_points) ? data.view_points : [];
  return normalizeChapters(
    raw.map((item) => ({
      title: String(item?.content || item?.title || item?.label || "").trim(),
      from: normalizeChapterTime(item?.from ?? item?.start ?? item?.start_time),
      to: normalizeChapterTime(item?.to ?? item?.end ?? item?.end_time)
    }))
  );
}

function normalizeChapterTime(value) {
  if (value === undefined || value === null || value === "") {
    return 0;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return 0;
  }
  return num > 60 * 60 * 24 ? num / 1000 : num;
}

function normalizeChapters(chapters) {
  const normalized = (chapters || [])
    .map((item) => ({
      title: String(item?.title || "").trim(),
      from: Number(item?.from || 0) || 0,
      to: Number(item?.to || 0) || 0
    }))
    .filter((item) => item.title && item.from >= 0)
    .sort((a, b) => a.from - b.from);

  const unique = [];
  const seen = new Set();
  normalized.forEach((item) => {
    const key = `${Math.floor(item.from * 10)}|${item.title.toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    unique.push(item);
  });
  return unique;
}

function normalizeSubtitleTracks(subtitles) {
  return [...(subtitles || [])].sort((a, b) => {
    const priorityGap = subtitlePriority(a) - subtitlePriority(b);
    if (priorityGap !== 0) {
      return priorityGap;
    }
    return String(a.subtitleUrl || "").localeCompare(String(b.subtitleUrl || ""));
  });
}

function subtitlePriority(item) {
  const lan = String(item?.lan || "").toLowerCase();
  const label = String(item?.lanDoc || "").toLowerCase();
  if (lan === "zh-cn" || lan === "zh-hans") return 0;
  if (lan === "zh") return 1;
  if (lan.includes("zh")) return 2;
  if (label.includes("中文")) return 3;
  if (lan === "en" || lan === "en-us" || lan === "en-gb") return 10;
  if (lan.includes("en")) return 11;
  if (label.includes("英文") || label.includes("英语") || label.includes("english")) return 12;
  return 50;
}

function normalizeSubtitleUrlForCache(url) {
  const text = String(url || "").trim();
  if (!text) {
    return "";
  }
  try {
    const parsed = new URL(text);
    const path = parsed.pathname.replace(/[^\w/.-]+/g, "_");
    return `${parsed.hostname}${path}`;
  } catch {
    return text.replace(/[^\w/.-]+/g, "_");
  }
}

function pickPreferredSubtitleTrack(subtitles, { previousId = "", previousUrl = "", previousLang = "" } = {}) {
  const tracks = subtitles || [];
  if (!tracks.length) {
    return null;
  }

  if (previousId) {
    const byId = tracks.find((item) => String(item.id || "") === String(previousId));
    if (byId) {
      return byId;
    }
  }

  const normalizedUrl = normalizeSubtitleUrlForCache(previousUrl);
  if (normalizedUrl) {
    const byUrl = tracks.find((item) => normalizeSubtitleUrlForCache(item.subtitleUrl) === normalizedUrl);
    if (byUrl) {
      return byUrl;
    }
  }

  const normalizedLang = String(previousLang || "").trim().toLowerCase();
  if (normalizedLang) {
    const byLang = tracks.find((item) => String(item.lanDoc || item.lan || "").trim().toLowerCase() === normalizedLang);
    if (byLang) {
      return byLang;
    }
  }

  return tracks[0];
}

async function fetchBiliSubtitleBundle({ bvid, cid, aid }) {
  const requests = buildSubtitleInfoRequests({ bvid, cid, aid });
  for (const request of requests) {
    let payload = null;
    try {
      payload = await fetchJsonForAi(request.url);
    } catch {
      continue;
    }
    if (payload?.code !== 0) {
      continue;
    }
    const tracks = mapSubtitleTracks(payload.data?.subtitle?.subtitles || [], request.source).filter((item) => item.subtitleUrl);
    return {
      tracks,
      chapters: mapChaptersFromPlayerData(payload.data)
    };
  }
  throw new Error("无法获取字幕列表");
}

async function fetchBiliSubtitleBody(url) {
  const payload = await fetchJsonForAi(url);
  return Array.isArray(payload?.body) ? payload.body : [];
}

async function fetchBiliHotComments(aid, count = 18) {
  const safeAid = Number(aid || 0) || 0;
  if (!safeAid) {
    return [];
  }
  const url = `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${safeAid}&mode=3&ps=${count}&pn=1`;
  const payload = await fetchJsonForAi(url).catch(() => null);
  const replies = Array.isArray(payload?.data?.replies) ? payload.data.replies : [];
  return replies.slice(0, count).map((item) => ({
    uname: item?.member?.uname || "匿名",
    like: item?.like || 0,
    message: String(item?.content?.message || "").slice(0, 500)
  }));
}

function shouldShowHoursInAiNote(meta, body) {
  const subtitleMaxTo = (body || []).reduce((max, item) => Math.max(max, Number(item?.to || 0) || 0), 0);
  const chapterMaxTo = (meta?.chapters || []).reduce((max, item) => Math.max(max, Number(item?.from || 0) || 0, Number(item?.to || 0) || 0), 0);
  const duration = Number(meta?.videoDuration || 0) || 0;
  return Math.max(subtitleMaxTo, chapterMaxTo, duration) >= 3600;
}

function formatCompactTimestamp(seconds, withHours) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const hour = Math.floor(safe / 3600);
  const minute = Math.floor((safe % 3600) / 60);
  const second = safe % 60;
  if (withHours) {
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  }
  const totalMinutes = Math.floor(safe / 60);
  return `${String(totalMinutes).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function buildAiSubtitleLine(item, includeTimestampInBody, withHours) {
  const text = String(item?.content || "").trim();
  if (!text) {
    return "";
  }
  if (!includeTimestampInBody) {
    return text;
  }
  return `\`${formatCompactTimestamp(item.from, withHours)}\` ${text}`;
}

function buildAiSubtitleSectionLines(body, chapters, includeTimestampInBody, withHours) {
  const subtitleItems = (body || [])
    .map((item, index) => ({ ...item, _index: index, text: String(item?.content || "").trim() }))
    .filter((item) => item.text);
  if (!subtitleItems.length) {
    return ["（暂无字幕）"];
  }

  if (!Array.isArray(chapters) || !chapters.length) {
    return subtitleItems.map((item) => buildAiSubtitleLine(item, includeTimestampInBody, withHours));
  }

  const lines = [];
  const usedIndexes = new Set();
  chapters.forEach((chapter, idx) => {
    const start = Number(chapter.from || 0) || 0;
    const next = chapters[idx + 1];
    const chapterTo = Number(chapter.to || 0) || 0;
    let end = Infinity;
    if (next && Number(next.from) > start) {
      end = Number(next.from);
    } else if (chapterTo > start) {
      end = chapterTo;
    }
    const sectionItems = subtitleItems.filter((item) => {
      const from = Number(item.from || 0) || 0;
      return from + 0.001 >= start && (end === Infinity ? true : from < end);
    });
    if (!sectionItems.length) {
      return;
    }
    const chapterStamp = includeTimestampInBody ? ` \`${formatCompactTimestamp(start, withHours)}\`` : "";
    lines.push(`### ${chapter.title}${chapterStamp}`, "");
    sectionItems.forEach((item) => {
      usedIndexes.add(item._index);
      lines.push(buildAiSubtitleLine(item, includeTimestampInBody, withHours));
    });
    lines.push("");
  });

  const remaining = subtitleItems.filter((item) => !usedIndexes.has(item._index));
  if (remaining.length) {
    lines.push("### 其他片段", "");
    remaining.forEach((item) => lines.push(buildAiSubtitleLine(item, includeTimestampInBody, withHours)));
  }

  while (lines.length && !lines[lines.length - 1]) {
    lines.pop();
  }
  return lines;
}

function buildAiConversationMarkdown(meta, body, settings) {
  const includeTimestampInBody = settings?.includeTimestampInBody !== false;
  const withHours = shouldShowHoursInAiNote(meta, body);
  const lines = [];
  const chapters = Array.isArray(meta?.chapters) ? meta.chapters : [];
  if (chapters.length) {
    lines.push("## 章节", "");
    chapters.forEach((item) => {
      const stamp = includeTimestampInBody ? `\`${formatCompactTimestamp(item.from, withHours)}\` ` : "";
      lines.push(`- ${stamp}${item.title}`);
    });
    lines.push("");
  }
  lines.push("## 字幕", "", ...buildAiSubtitleSectionLines(body, chapters, includeTimestampInBody, withHours));
  return lines.join("\n");
}

async function resolveAiSidepanelContext(contextRef) {
  const ref = normalizeAiContextRef(contextRef);
  if (!ref.isVideoContext || !ref.bvid) {
    return {
      title: ref.title,
      url: ref.url,
      author: ref.author,
      uploadDate: ref.uploadDate,
      subtitleMarkdown: "",
      subtitleBody: [],
      hotComments: [],
      isVideoContext: false
    };
  }

  const settings = await getMergedSettings();
  const videoMeta = await fetchBiliVideoMetaByBvid(ref.bvid);
  const page = pickPageForAiContext(videoMeta.pages, ref);
  const cid = String(page?.cid || ref.cid || videoMeta.defaultCid || "").trim();
  if (!cid) {
    throw new Error("无法定位原视频分P");
  }
  const aid = String(videoMeta.aid || ref.aid || "").trim();
  const subtitleBundle = await fetchBiliSubtitleBundle({ bvid: ref.bvid, cid, aid });
  const tracks = normalizeSubtitleTracks(subtitleBundle.tracks || []);
  if (!tracks.length) {
    throw new Error("原视频暂时没有可用字幕");
  }
  const selectedTrack = pickPreferredSubtitleTrack(tracks, {
    previousId: ref.selectedSubtitleId,
    previousUrl: ref.selectedSubtitleUrl,
    previousLang: ref.subtitleLang
  }) || tracks[0];
  const body = await fetchBiliSubtitleBody(selectedTrack.subtitleUrl);
  if (!body.length) {
    throw new Error("原视频字幕为空");
  }

  const pageIndex = Number(page?.page || extractPageIndexFromUrl(ref.url) || 1) || 1;
  const hotComments = await fetchBiliHotComments(aid);
  const title = String(videoMeta.title || ref.title || "").trim();
  const author = String(videoMeta.author || ref.author || "").trim();
  const uploadDate = String(videoMeta.uploadDate || ref.uploadDate || "").trim();
  const pageTitle = String(page?.part || ref.pageTitle || "").trim();
  const url = buildCanonicalVideoUrl(ref.bvid, pageIndex) || ref.url;
  const contextMeta = {
    title,
    chapters: subtitleBundle.chapters || [],
    videoDuration: Number(page?.duration || videoMeta.defaultDuration || 0) || 0
  };

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
    subtitleBody: body,
    subtitleMarkdown: buildAiConversationMarkdown(contextMeta, body, settings),
    subtitleOptions: tracks.map((item) => ({
      id: String(item.id || "").trim(),
      url: String(item.subtitleUrl || "").trim(),
      lang: String(item.lanDoc || item.lan || "").trim()
    })),
    hotComments,
    isVideoContext: true
  };
}

async function resolveAiSidepanelPageRef(contextRef) {
  const ref = normalizeAiContextRef(contextRef);
  if (!ref.isVideoContext || !ref.bvid) {
    return {
      url: ref.url,
      bvid: ref.bvid,
      cid: ref.cid,
      pageIndex: Number(ref.pageIndex) > 0 ? Number(ref.pageIndex) : 1,
      pageTitle: ref.pageTitle
    };
  }

  const videoMeta = await fetchBiliVideoMetaByBvid(ref.bvid);
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.type === "get-settings") {
    getMergedSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "save-settings") {
    saveSettings(message.settings || {})
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "open-options") {
    chrome.tabs
      .create({ url: chrome.runtime.getURL("options.html") })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "player-ai-quick-action") {
    const tabId = Number(message.tabId || sender?.tab?.id || 0) || 0;
    if (!tabId) {
      sendResponse({ ok: false, error: "找不到当前标签页。" });
      return false;
    }

    const openPromise = openAiSidepanelForTab(tabId);
    getMergedSettings()
      .then(async (settings) => {
        if (!settings.enablePlayerAiQuickAction) {
          throw new Error("AI 按钮未开启");
        }
        await openPromise;
        const request = buildPlayerAiQuickActionRequest(tabId, settings.playerAiQuickPrompt);
        await chrome.storage.local.set({ [PLAYER_AI_QUICK_ACTION_STORAGE_KEY]: request });
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message || "打开 AI 侧边栏失败" }));
    return true;
  }

  if (message.type === "open-reading-view-tab") {
    const url = String(message.url || "").trim();
    const tabId = Number(message.tabId || 0) || 0;
    if (!url) {
      sendResponse({ ok: false, error: "缺少视频地址" });
      return false;
    }
    if (!tabId) {
      sendResponse({ ok: false, error: "缺少标签页信息" });
      return false;
    }

    let readerUrl = "";
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== "www.bilibili.com") {
        throw new Error("当前网页不是 B 站视频页");
      }
      parsed.searchParams.set("boc_reader", "1");
      readerUrl = parsed.toString();
    } catch (error) {
      sendResponse({ ok: false, error: error.message || "阅读视图地址无效" });
      return false;
    }

    ensureReaderContentReady(tabId)
      .then(() => triggerReaderModeInTab(tabId, readerUrl))
      .then((triggered) => {
        if (!triggered) {
          throw new Error("阅读视图触发失败，请刷新浏览器网页重试");
        }
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "fetch-json") {
    const url = typeof message.url === "string" ? message.url : "";
    if (!url) {
      sendResponse({ ok: false, error: "Missing subtitle URL" });
      return false;
    }

    const isBiliRequest = /(?:api\.bilibili\.com|hdslb\.com)/.test(url);
    const headers = new Headers();
    if (isBiliRequest) {
      headers.set("Accept", "application/json, text/plain, */*");
      headers.set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
      headers.set("Cache-Control", "no-cache");
      headers.set("Pragma", "no-cache");
    }

    const fetchOptions = {
      method: "GET",
      credentials: "include",
      cache: "no-store"
    };
    if (headers.size > 0) {
      fetchOptions.headers = headers;
    }
    if (isBiliRequest) {
      fetchOptions.referrer = "https://www.bilibili.com/";
      fetchOptions.referrerPolicy = "strict-origin-when-cross-origin";
    }

    fetch(url, fetchOptions)
      .then(async (response) => {
        if (!response.ok) {
          sendResponse({ ok: false, error: `HTTP ${response.status}` });
          return;
        }

        const text = await response.text();
        try {
          const data = JSON.parse(text);
          sendResponse({ ok: true, data });
        } catch {
          sendResponse({ ok: false, error: "Invalid JSON response" });
        }
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-providers-list") {
    loadAiProviders()
      .then((items) => sendResponse({ ok: true, providers: items }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "get-ai-provider-key") {
    const providerId = String(message.providerId || "").trim();
    if (!providerId) {
      sendResponse({ ok: false, error: "缺少 providerId" });
      return false;
    }
    loadAiProviderKeys()
      .then((keys) => {
        const apiKey = String(keys[providerId] || "").trim();
        sendResponse({ ok: true, apiKey });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-providers-save") {
    saveAiProviders(message.providers || [])
      .then((items) => sendResponse({ ok: true, providers: items }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-provider-set-key") {
    saveAiProviderKey(String(message.providerId || ""), String(message.apiKey || ""))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-providers-delete") {
    deleteAiProvider(String(message.providerId || ""))
      .then((items) => sendResponse({ ok: true, providers: items }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-providers-test") {
    const baseUrl = String(message.baseUrl || "").trim();
    const providerId = String(message.providerId || "").trim();
    const model = String(message.model || "").trim();
    if (!baseUrl) {
      sendResponse({ ok: false, error: "请填写 baseUrl" });
      return false;
    }
    Promise.resolve()
      .then(async () => {
        const directApiKey = String(message.apiKey || "").trim();
        if (directApiKey) {
          return directApiKey;
        }
        if (!providerId) {
          return "";
        }
        const keys = await loadAiProviderKeys();
        return String(keys[providerId] || "").trim();
      })
      .then((apiKey) => testAiConnection({ baseUrl, apiKey, model }))
      .then((resp) => sendResponse(resp))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-providers-models") {
    try {
      const baseUrl = String(message.baseUrl || "").trim();
      const apiKey = String(message.apiKey || "").trim();
      const providerId = String(message.providerId || "").trim();
      if (!baseUrl) {
        sendResponse({ ok: false, error: "请填写 baseUrl" });
        return true;
      }
      const normalizedBaseUrl = baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
      const headers = { Accept: "application/json" };
      let timer = null;
      let responded = false;

      const respond = (payload) => {
        try {
          if (responded) {
            console.warn("[ai-providers-models] duplicate respond ignored");
            return;
          }
          responded = true;
          if (timer) { clearTimeout(timer); timer = null; }
          console.log("[ai-providers-models] responding", payload);
          sendResponse(payload);
        } catch (err) {
          console.error("[ai-providers-models] sendResponse failed", err);
        }
      };

      console.log("[ai-providers-models] fetching", normalizedBaseUrl, "providerId", providerId, "hasApiKey", Boolean(apiKey));

      Promise.resolve()
        .then(async () => {
          if (apiKey) return apiKey;
          if (!providerId) return "";
          const keys = await loadAiProviderKeys();
          return String(keys[providerId] || "").trim();
        })
        .then((resolvedKey) => {
          if (resolvedKey) headers["Authorization"] = `Bearer ${resolvedKey}`;
          const controller = new AbortController();
          timer = setTimeout(() => controller.abort(), 15000);
          console.log("[ai-providers-models] requesting", `${normalizedBaseUrl}/v1/models`);
          return fetch(`${normalizedBaseUrl}/v1/models`, { headers, method: "GET", signal: controller.signal })
            .then((resp) => {
              console.log("[ai-providers-models] response status", resp.status, resp.statusText);
              if (!resp.ok) {
                return resp.text().then((text) => {
                  throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
                });
              }
              return resp.json().then((data) => ({ ok: true, data })).catch((err) => {
                throw new Error(`无法解析模型列表：${err?.message || String(err)}`);
              });
            })
            .then(({ data }) => {
              const models = [];
              if (Array.isArray(data?.data)) {
                for (const item of data.data) {
                  if (item?.id) models.push(String(item.id));
                }
              }
              console.log("[ai-providers-models] parsed models", models.length);
              return models;
            });
        })
        .then((models) => respond({ ok: true, models }))
        .catch((error) => {
          console.error("[ai-providers-models] fetch error", error);
          if (error?.name === "AbortError") {
            respond({ ok: false, error: "请求超时，请检查 baseUrl 或稍后重试" });
          } else {
            respond({ ok: false, error: error?.message || String(error) });
          }
        });

      // Safety net: ensure we always respond within the timeout window.
      timer = setTimeout(() => {
        console.warn("[ai-providers-models] safety net triggered");
        respond({ ok: false, error: "请求超时，请检查 baseUrl 或稍后重试" });
      }, 16000);
    } catch (error) {
      console.error("[ai-providers-models] handler error", error);
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return true;
  }

  if (message.type === "ai-sidepanel-get-state") {
    const tabId = Number(message.tabId || 0) || 0;
    const forceRefresh = message.forceRefresh === true;
    getAiSidepanelState(tabId, { forceRefresh })
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-sidepanel-resolve-context") {
    resolveAiSidepanelContext(message.contextRef || {})
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-sidepanel-resolve-page-ref") {
    resolveAiSidepanelPageRef(message.contextRef || {})
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== "sidepanel-chat") {
    return;
  }

  let activeAbortController = null;
  let activeAbortMeta = null;
  let firstTokenTimeoutId = 0;

  const clearActiveRequestState = () => {
    if (firstTokenTimeoutId) {
      clearTimeout(firstTokenTimeoutId);
      firstTokenTimeoutId = 0;
    }
    activeAbortController = null;
    activeAbortMeta = null;
  };

  const abortActiveRequest = (meta = null) => {
    activeAbortMeta = meta;
    if (firstTokenTimeoutId) {
      clearTimeout(firstTokenTimeoutId);
      firstTokenTimeoutId = 0;
    }
    if (activeAbortController && !activeAbortController.signal.aborted) {
      activeAbortController.abort();
    }
  };

  // 空闲看门狗：STREAM_IDLE_TIMEOUT_MS 内没有任何数据（思考/正文都算）就中断。
  // 每次有数据到达都重新武装，因此思考模型长思考不会被误杀，真正卡死也不会无限等待。
  const armFirstDataTimeout = () => {
    if (firstTokenTimeoutId) {
      clearTimeout(firstTokenTimeoutId);
      firstTokenTimeoutId = 0;
    }
    firstTokenTimeoutId = setTimeout(() => {
      abortActiveRequest({ type: "timeout", reason: "请求超时（90 秒未返回任何数据），已自动中断" });
    }, STREAM_IDLE_TIMEOUT_MS);
  };

  port.onDisconnect.addListener(() => {
    abortActiveRequest({ type: "silent" });
    clearActiveRequestState();
  });

  port.onMessage.addListener(async (msg) => {
    if (!msg) return;
    if (msg.action === "stop") {
      abortActiveRequest({ type: "stopped", reason: "已停止生成" });
      return;
    }
    if (msg.action !== "chat") return;

    try {
      abortActiveRequest({ type: "silent" });
      clearActiveRequestState();
      activeAbortController = new AbortController();
      armFirstDataTimeout();
      const providers = await loadAiProviders();
      const provider = providers.find((p) => p.id === msg.providerId);
      if (!provider) {
        port.postMessage({ type: "error", error: "未找到选中的平台" });
        clearActiveRequestState();
        return;
      }
      const keys = await loadAiProviderKeys();
      const apiKey = keys[provider.id] || "";
      if (provider.requiresKey !== false && !apiKey) {
        port.postMessage({ type: "error", error: "该平台 API Key 未配置" });
        clearActiveRequestState();
        return;
      }
      await streamChat({
        provider: { ...provider, apiKey },
        context: msg.context || {},
        userPrompt: msg.prompt || "",
        history: Array.isArray(msg.history) ? msg.history : [],
        port,
        signal: activeAbortController.signal,
        getAbortMeta: () => activeAbortMeta,
        onActivity: () => armFirstDataTimeout()
      });
    } catch (e) {
      port.postMessage({ type: "error", error: String(e?.message || e) });
    } finally {
      clearActiveRequestState();
    }
  });
});

async function initializeSettingsStorage() {
  const syncCurrent = await chrome.storage.sync.get(DEFAULT_SYNC_SETTINGS);
  await chrome.storage.sync.set({ ...DEFAULT_SYNC_SETTINGS, ...syncCurrent });
}

async function getMergedSettings() {
  const syncSettings = await chrome.storage.sync.get(DEFAULT_SYNC_SETTINGS);

  const merged = { ...DEFAULT_SYNC_SETTINGS, ...syncSettings };
  merged.downloadFormat = normalizeDownloadFormat(merged.downloadFormat);
  merged.includeHotCommentsInNote = normalizeIncludeHotCommentsInNote(merged.includeHotCommentsInNote);
  merged.enablePlayerAiQuickAction = normalizeEnablePlayerAiQuickAction(merged.enablePlayerAiQuickAction);
  merged.playerAiQuickPrompt = normalizePlayerAiQuickPrompt(merged.playerAiQuickPrompt);
  merged.readerTheme = normalizeReaderTheme(merged.readerTheme);
  merged.readerFontScale = normalizeReaderFontScale(merged.readerFontScale);
  merged.readerLetterSpacing = normalizeReaderLetterSpacing(merged.readerLetterSpacing ?? merged.readerLineHeight);
  merged.readerLineHeight = normalizeReaderLineHeight(merged.readerLineHeight);
  merged.readerContentWidth = normalizeReaderContentWidth(merged.readerContentWidth);
  merged.readerChapterVisibility = normalizeReaderChapterVisibility(merged.readerChapterVisibility);
  merged.readerTranscriptVisible = normalizeReaderTranscriptVisible(merged.readerTranscriptVisible);
  merged.fixedFrontmatterProperties = normalizeFixedFrontmatterProperties(merged.fixedFrontmatterProperties);
  merged.notePlaceholderSections = normalizeNotePlaceholderSections(merged.notePlaceholderSections);
  merged.aiSystemPrompt = normalizeAiSystemPrompt(merged.aiSystemPrompt);
  merged.aiInitialQuickPrompts = normalizeAiInitialQuickPrompts(merged.aiInitialQuickPrompts);
  merged.aiPresetPrompts = normalizeAiPresetPrompts(merged.aiPresetPrompts);
  merged.defaultModel = normalizeDefaultModel(merged.defaultModel);

  return merged;
}

async function saveSettings(settings) {
  const payload = settings && typeof settings === "object" ? settings : {};
  const syncPayload = { ...payload };
  syncPayload.downloadFormat = normalizeDownloadFormat(syncPayload.downloadFormat);
  syncPayload.includeHotCommentsInNote = normalizeIncludeHotCommentsInNote(syncPayload.includeHotCommentsInNote);
  syncPayload.enablePlayerAiQuickAction = normalizeEnablePlayerAiQuickAction(syncPayload.enablePlayerAiQuickAction);
  syncPayload.playerAiQuickPrompt = normalizePlayerAiQuickPrompt(syncPayload.playerAiQuickPrompt);
  syncPayload.readerTheme = normalizeReaderTheme(syncPayload.readerTheme);
  syncPayload.readerFontScale = normalizeReaderFontScale(syncPayload.readerFontScale);
  syncPayload.readerLetterSpacing = normalizeReaderLetterSpacing(
    syncPayload.readerLetterSpacing ?? syncPayload.readerLineHeight
  );
  syncPayload.readerLineHeight = normalizeReaderLineHeight(syncPayload.readerLineHeight);
  syncPayload.readerContentWidth = normalizeReaderContentWidth(syncPayload.readerContentWidth);
  syncPayload.readerChapterVisibility = normalizeReaderChapterVisibility(syncPayload.readerChapterVisibility);
  syncPayload.readerTranscriptVisible = normalizeReaderTranscriptVisible(syncPayload.readerTranscriptVisible);
  syncPayload.fixedFrontmatterProperties = normalizeFixedFrontmatterProperties(syncPayload.fixedFrontmatterProperties);
  syncPayload.notePlaceholderSections = normalizeNotePlaceholderSections(syncPayload.notePlaceholderSections);
  syncPayload.aiSystemPrompt = normalizeAiSystemPrompt(syncPayload.aiSystemPrompt);
  syncPayload.aiInitialQuickPrompts = normalizeAiInitialQuickPrompts(syncPayload.aiInitialQuickPrompts);
  syncPayload.aiPresetPrompts = normalizeAiPresetPrompts(syncPayload.aiPresetPrompts);
  syncPayload.defaultModel = normalizeDefaultModel(syncPayload.defaultModel);

  await chrome.storage.sync.set(syncPayload);
}
function normalizeNotePlaceholderSections(items) {


  const allowedPositions = new Set(["before_intro", "before_chapters", "before_subtitle"]);
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => {
      const title = toString(item?.title).trim();
      const content = toString(item?.content).trim();
      const position = allowedPositions.has(toString(item?.position).trim())
        ? toString(item?.position).trim()
        : "before_intro";
      return {
        title,
        position,
        content
      };
    })
    .filter((item) => item.title)
    .slice(0, 5);
}


// ===== AI 模型平台存储 =====

const AI_PROVIDER_KEYS_STORAGE = "aiProviderKeys";

function normalizeAiProvider(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || "").trim();
  if (!id) return null;
  return {
    id,
    presetId: String(item.presetId || "custom"),
    name: String(item.name || "自定义").trim() || "自定义",
    baseUrl: String(item.baseUrl || "").trim().replace(/\/+$/, ""),
    model: String(item.model || "").trim(),
    requiresKey: item.requiresKey !== false,
    enabled: item.enabled !== false
  };
}

async function loadAiProviders() {
  const [syncData, keys] = await Promise.all([
    chrome.storage.sync.get(["aiProviders"]),
    loadAiProviderKeys()
  ]);
  const list = Array.isArray(syncData.aiProviders) ? syncData.aiProviders : [];
  return list
    .map(normalizeAiProvider)
    .filter(Boolean)
    .map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
}

async function saveAiProviders(items) {
  const rawList = Array.isArray(items) ? items : [];
  const keys = await loadAiProviderKeys();
  const nextList = [];
  for (const raw of rawList) {
    const normalized = normalizeAiProvider(raw);
    if (!normalized) continue;
    nextList.push(normalized);
    const incomingKey = String(raw?.apiKey || "").trim();
    if (incomingKey) {
      keys[normalized.id] = incomingKey;
    }
  }
  await Promise.all([
    chrome.storage.sync.set({ aiProviders: nextList }),
    chrome.storage.local.set({ [AI_PROVIDER_KEYS_STORAGE]: keys })
  ]);
  // 返回带 hasSavedKey 的列表，方便前端渲染占位
  return nextList.map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
}

async function deleteAiProvider(providerId) {
  const list = await loadAiProviders();
  const next = list.filter((p) => p.id !== providerId);
  await chrome.storage.sync.set({ aiProviders: next });
  const keys = await loadAiProviderKeys();
  if (keys && providerId in keys) {
    delete keys[providerId];
    await chrome.storage.local.set({ [AI_PROVIDER_KEYS_STORAGE]: keys });
  }
  return next;
}

async function loadAiProviderKeys() {
  const localData = await chrome.storage.local.get([AI_PROVIDER_KEYS_STORAGE]);
  const keys = localData?.[AI_PROVIDER_KEYS_STORAGE];
  return keys && typeof keys === "object" ? keys : {};
}

async function saveAiProviderKey(providerId, apiKey) {
  const keys = await loadAiProviderKeys();
  const trimmed = String(apiKey || "").trim();
  if (trimmed) {
    keys[providerId] = trimmed;
  } else {
    delete keys[providerId];
  }
  await chrome.storage.local.set({ [AI_PROVIDER_KEYS_STORAGE]: keys });
  return keys;
}

// ===== AI 调用（内联实现，避免 service worker 跨文件 import） =====

function buildAiMessages({ context, userPrompt, history, systemPrompt }) {
  const ctx = context || {};
  const hasVideoContext = Boolean(ctx.isVideoContext);
  const sections = hasVideoContext
    ? [
        `你是一个 B 站视频助手。当前用户正在看一个视频，标题：「${ctx.title || "未知"}」`,
        `作者：${ctx.author || "未知"} | 上传日期：${ctx.uploadDate || "未知"}`
      ]
    : [
        "你是一个通用 AI 助手。",
        "当前对话没有页面上下文，请仅基于用户消息和历史对话回答。"
      ];

  if (ctx.subtitleMarkdown) {
    sections.push(`以下是视频的字幕全文：\n\n${ctx.subtitleMarkdown}`);
  } else if (hasVideoContext) {
    sections.push("（暂无字幕）");
  }
  if (hasVideoContext && Array.isArray(ctx.hotComments) && ctx.hotComments.length) {
    const block = ctx.hotComments
      .map((c, i) => `${i + 1}. ${c.uname || "匿名"}（赞 ${c.like || 0}）: ${c.message || ""}`)
      .join("\n");
    sections.push(`以下是按热度排序的前 ${ctx.hotComments.length} 条热门评论：\n\n${block}`);
  }
  const customSystemPrompt = normalizeAiSystemPrompt(systemPrompt);
  if (customSystemPrompt) {
    sections.push(`以下是额外系统要求：\n${customSystemPrompt}`);
  }
  return [
    { role: "system", content: sections.join("\n\n") },
    ...(Array.isArray(history) ? history.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") : []),
    { role: "user", content: String(userPrompt || "") }
  ];
}

function clipAiSubtitle(markdown) {
  return String(markdown || "");
}

async function* parseOpenAISSE(response) {
  if (!response || !response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.length ? lines.pop() : "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      if (!data) continue;
      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta || {};
        // 思考模型（如 Kimi k2.x / DeepSeek R1）在正式回答前会先输出 reasoning_content，
        // 这段时间 content 为空——必须单独转发，否则界面会长时间无任何反馈。
        const reasoning = delta.reasoning_content;
        if (reasoning) yield { type: "reasoning", data: String(reasoning) };
        const content = delta.content;
        if (content) yield { type: "content", data: String(content) };
      } catch {}
    }
  }
}

// onActivity：每当流式响应有任何数据（思考或正文）到达时回调，用于重新武装空闲看门狗。
async function streamChat({ provider, context, userPrompt, history, port, signal, getAbortMeta, onActivity }) {
  if (!port) return;
  const baseUrl = String(provider?.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    port.postMessage({ type: "error", error: "baseUrl 未配置" });
    return;
  }
  if (!provider.model) {
    port.postMessage({ type: "error", error: "模型未配置" });
    return;
  }

  const messages = buildAiMessages({
    context: { ...context, subtitleMarkdown: clipAiSubtitle(context?.subtitleMarkdown) },
    userPrompt,
    history,
    systemPrompt: context?.aiSystemPrompt || ""
  });

  const headers = { "Content-Type": "application/json" };
  if (provider.apiKey) {
    headers["Authorization"] = `Bearer ${provider.apiKey}`;
  }

  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model: provider.model,
        messages,
        stream: true
      })
    });
  } catch (e) {
    port.postMessage({ type: "error", error: `网络错误：${e?.message || e}` });
    return;
  }

  if (!response.ok) {
    let detail = "";
    try { detail = (await response.text()).slice(0, 200); } catch {}
    port.postMessage({ type: "error", error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` });
    return;
  }

  try {
    // 首个数据块（无论思考还是正文）到达即视为“服务端已响应”
    for await (const chunk of parseOpenAISSE(response)) {
      onActivity?.();
      if (chunk.type === "reasoning") {
        port.postMessage({ type: "reasoning", data: chunk.data });
      } else {
        port.postMessage({ type: "token", data: chunk.data });
      }
    }
    port.postMessage({ type: "done" });
  } catch (e) {
    if (signal?.aborted) {
      const abortMeta = typeof getAbortMeta === "function" ? getAbortMeta() : null;
      if (abortMeta?.type === "stopped") {
        port.postMessage({ type: "stopped", reason: abortMeta.reason || "已停止生成" });
        return;
      }
      if (abortMeta?.type === "timeout") {
        port.postMessage({ type: "error", error: abortMeta.reason || "请求超时，已自动中断" });
        return;
      }
      return;
    }
    port.postMessage({ type: "error", error: String(e?.message || e) });
  }
}

async function testAiConnection({ baseUrl, apiKey, model }) {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  const normalizedModel = String(model || "").trim();
  if (!normalizedBaseUrl) {
    return { ok: false, error: "请填写 baseUrl" };
  }
  if (!normalizedModel) {
    return { ok: false, error: "请填写模型名" };
  }

  const headers = { Accept: "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  return probeAiChatCompletion({
    baseUrl: normalizedBaseUrl,
    apiKey,
    model: normalizedModel,
    headers
  });
}

async function probeAiChatCompletion({ baseUrl, apiKey, model, headers }) {
  const requestHeaders = headers || { Accept: "application/json" };
  if (apiKey && !requestHeaders.Authorization) {
    requestHeaders.Authorization = `Bearer ${apiKey}`;
  }
  requestHeaders["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }]
      })
    });
  } catch (error) {
    return { ok: false, error: `无法连接：${error?.message || error}` };
  }

  if (response.ok) {
    return { ok: true };
  }

  let detail = "";
  try {
    detail = (await response.text()).slice(0, 200);
  } catch {}
  return { ok: false, error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
}
