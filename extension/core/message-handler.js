import { state, uiState, playerAiState, clipState } from "./state.js";
import { DEFAULT_SETTINGS } from "./defaults.js";

import { startUrlWatcher, BOC_URL_CHANGE_EVENT } from "./url-watcher.js";
import { replaceReaderModeUrl } from "../bilibili/reader-url.js";
import {
  getErrorMessage,
  isStaleRunError
} from "../shared/error-helpers.js";

// 候选02 分层惰性：video-probe（getRuntimeVideoElement/findReaderPlayerHost）
// 原被本模块与 reader 域共享而提升为常驻静态 chunk；其常驻侧唯一消费点是
// seek 联动处理器（异步），改为处理器内动态 import 后随 reader 域/总结链
// 切进动态 chunk（详见 sidepanel-seek-video-time 处理器）。

// 总结链（fetcher/ui + notes/render）经加载器按需引入（候选02 分层惰性）：
// 链内符号一律 ensureSummarizeChain().then((chain) => chain.xxx())。一键总结
// 热路径上的装载是本地 chunk 动态 import（~10ms），被消息往返掩盖。
import { ensureSummarizeChain } from "../subtitle/lazy.js";
import { setStatus, ensureUiReady } from "../ui/ui-renderer.js";

// player-ai 经加载器按需引入（候选4 分包）：默认关闭的能力不再常驻。
// 「未加载」时按钮不可能存在，remove/sync 均可安全跳过（幂等不变量见
// lazy-player-ai.js 头注）。
import { loadPlayerAi, isPlayerAiLoaded } from "./lazy-player-ai.js";

// reader 域经加载器按需引入（候选02 分层惰性）：重符号（enterReaderMode 等）
// 在处理器内 ensureReaderDomain() 后经命名空间取用；启动必需的轻符号直接从
// 常驻微模块 import（isReaderViewOpen=纯 state 读、enforceNormalPageState-
// IfNeeded=DOM 守卫、renderReadingStatus=状态栏文案写入），不拖入 reader 重文件。
// （候选06：seek 的滚动暂停重置/跟随设置已收进 reader 域单入口
// seekReadingTarget 的规范序，本文件不再触碰 scroll-state 与跟随状态。）
import { ensureReaderDomain } from "./lazy-reader.js";
import { isReaderViewOpen } from "../reader/view-state.js";
import { enforceNormalPageStateIfNeeded } from "../reader/page-state.js";
import { renderReadingStatus } from "../reader/presentation.js";
// 日志直接取自 shared/logging.js（不再经 reader/index.js 转发）
import { logWarn } from "../shared/logging.js";

import {
  isReaderMode,
  computeCurrentClipSignature,
  stripReaderModeUrl
} from "../bilibili/video-id-shared.js";
// 候选02 分层惰性：gateway（getCurrentAid/fetchHotComments）原被本模块与总结
// 链共享而提升为常驻静态 chunk；其常驻侧唯一消费点是热评消息处理器（异步），
// 改为处理器内动态 import 后，gateway/bili-api-shared 随总结链切进动态 chunk。

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
      // 候选02：getPopupPayload 属总结链层，经 ensure 装载后组装（热路径本地
      // 动态 import ~10ms）。装载失败回错误（popup 对缺 payload 有兜底渲染）。
      ensureSummarizeChain()
        .then((chain) => sendResponse({ ok: true, payload: chain.getPopupPayload() }))
        .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
      return true;
    }

    if (message.type === "popup-refresh") {
      ensureSummarizeChain()
        .then((chain) =>
          chain
            .refreshClip()
            .then(() => sendResponse({ ok: true, payload: chain.getPopupPayload() }))
            .catch((error) =>
              sendResponse({ ok: false, error: getErrorMessage(error), payload: chain.getPopupPayload() })
            )
        )
        .catch((error) => {
          // 链装载失败（清缓存重试后仍失败）：无法组装 payload，按错误口径回包
          // （popup / context-resolver 均对缺 payload 容错，回落 sidepanel 快照）。
          sendResponse({ ok: false, error: getErrorMessage(error) });
        });
      return true;
    }

    if (message.type === "popup-select-subtitle") {
      const url = String(message.url || "").trim();
      const lang = String(message.lang || "unknown");
      const subtitleId = String(message.subtitleId || "");
      if (!url) {
        // 候选02：错误路径的 payload 同样取自链层，经 ensure 装载后回包。
        ensureSummarizeChain()
          .then((chain) =>
            sendResponse({ ok: false, error: "Missing subtitle URL", payload: chain.getPopupPayload() })
          )
          .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
        return true;
      }
      ensureSummarizeChain()
        .then((chain) =>
          chain
            .loadSubtitle(url, lang, state.clip.fetchRunId, subtitleId)
            .then(() => {
              setStatus("字幕切换完成。");
              // renderSubtitleSelect 已随总结链下放（候选02）：渲染「抓取结果」
              // 的函数在链层，经同一 chain 门面调用。
              chain.renderSubtitleSelect();
              sendResponse({ ok: true, payload: chain.getPopupPayload() });
            })
            .catch((error) =>
              sendResponse({ ok: false, error: getErrorMessage(error), payload: chain.getPopupPayload() })
            )
        )
        .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
      return true;
    }

    if (message.type === "popup-trigger-reading-view") {
      playerAiState.setSuppressedUntil(Date.now() + 2500);
      // 原为同步 remove；懒加载后「未加载 ⇒ 无按钮」可直接跳过，已加载时经
      // promise 移除（延后一个 tick，视觉无差异）。失败静默：移除按钮失败
      // 不应阻断阅读模式打开，且 suppressedUntil 已保证按钮短期不再弹出。
      if (isPlayerAiLoaded()) {
        loadPlayerAi()
          .then((playerAi) => playerAi.removePlayerAiQuickActionButton())
          .catch(() => {});
      }
      ensureUiReady();
      const readerUrl = String(message.readerUrl || "").trim();
      if (readerUrl) {
        replaceReaderModeUrl(readerUrl);
        document.documentElement.setAttribute("data-boc-reader-mode", "1");
        document.body.setAttribute("data-boc-reader-mode", "1");
      }
      if (!isReaderViewOpen()) {
        // 候选02：enterReaderMode 属 reader 重域，经 ensureReaderDomain 装载后
        // 进入（点击路径的本地动态装载对用户无感）。
        ensureReaderDomain()
          .then((reader) => reader.enterReaderMode())
          .catch((error) => {
            logWarn("[BOC] reading mode trigger failed", error);
          });
      }
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "popup-close-reading-view") {
      // URL 改写保持同步（与旧行为一致地先收敛地址栏）；closeReadingView 属
      // reader 重域，经 ensure 装载后执行（视图开着 ⇒ 域几乎必然已装载，此处
      // 只是兜底直开路径）。
      try {
        if (isReaderMode()) {
          replaceReaderModeUrl(stripReaderModeUrl(location.href));
        }
      } catch (error) {
        sendResponse({ ok: false, error: getErrorMessage(error) });
        return false;
      }
      ensureReaderDomain()
        .then((reader) => {
          reader.closeReadingView();
          sendResponse({ ok: true });
        })
        .catch((error) => {
          sendResponse({ ok: false, error: getErrorMessage(error) });
        });
      return true;
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
      // gateway 动态装载（候选02，见文件头 import 注）：本地 chunk 加载 ~10ms，
      // 被热评网络往返掩盖。装载失败与「无法获取 aid」同型降级：空列表 + note。
      import("../bilibili/gateway.js")
        .then(({ getCurrentAid, fetchHotComments }) => {
          if (!getCurrentAid()) {
            clipState.setHotComments([]);
            sendResponse({ ok: true, comments: [], note: "无法获取视频 aid" });
            return;
          }
          return fetchHotComments(20)
            .then((hotComments) => {
              clipState.setHotComments(hotComments);
              sendResponse({ ok: true, comments: hotComments });
            })
            .catch((error) => {
              clipState.setHotComments([]);
              sendResponse({ ok: true, comments: [], note: String(error?.message || error) });
            });
        })
        .catch((error) => {
          clipState.setHotComments([]);
          sendResponse({ ok: true, comments: [], note: String(error?.message || error) });
        });
      return true;
    }

    if (message.type === "sidepanel-seek-video-time") {
      // video-probe 动态装载（候选02，见文件头 import 注）：本地 chunk ~10ms，
      // 被用户点击到执行的时间差掩盖；响应形状与搬迁前一致（ok/currentTime）。
      // 候选06 seek 深入口：reader 开着时定位收敛为 reader 域单入口
      // seekReadingTarget（规范序：清暂停 → 设跟随 → currentTime → 同步），
      // resumePlayback:false = 暂停中不自动播放（与旧侧栏行为等价）；reader
      // 未开时保持旧行为：只 seek 视频，正在播放才续播，不触碰 reader 状态。
      import("../bilibili/video-probe.js")
        .then(async ({ getRuntimeVideoElement }) => {
          const video = getRuntimeVideoElement();
          if (!video) {
            sendResponse({ ok: false, error: "当前页面没有找到可联动的视频播放器。" });
            return;
          }
          if (isReaderViewOpen()) {
            // 视图开 ⇒ 域已装载（ensure 即命中缓存）；装载/执行失败统一走
            // 下方 catch 的错误口径回包。
            const reader = await ensureReaderDomain();
            const seekedTo = reader.seekReadingTarget(message.seconds, { resumePlayback: false });
            if (seekedTo === null) {
              // reader 域内未绑定到视频（与无视频同型降级）。
              sendResponse({ ok: false, error: "当前页面没有找到可联动的视频播放器。" });
              return;
            }
            sendResponse({ ok: true, currentTime: seekedTo });
            return;
          }
          const seconds = Number(message.seconds);
          const nextTime = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
          const wasPaused = Boolean(video.paused);
          video.currentTime = nextTime;
          if (!wasPaused) {
            video.play().catch(() => {});
          }
          sendResponse({ ok: true, currentTime: nextTime });
        })
        .catch((error) => {
          sendResponse({ ok: false, error: getErrorMessage(error) });
        });
      return true;
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
    // 候选02：resetClipState 属总结链层，经 ensure 装载后执行。装载/执行失败
    // 记日志不中断编排（后续 reader 分支与状态提示仍需走到）。
    ensureSummarizeChain()
      .then((chain) => chain.resetClipState())
      .catch((error) => {
        logWarn("[BOC] clip state reset after URL change failed", error);
      });
    // player-ai 按钮同步（原为同步调用）：懒加载后「已加载/加载中才请求」，
    // 未加载（快捷开关关闭态）跳过——player-ai start 自带初始 sync，开启后
    // 的 URL 变化自会恢复同步，行为等价。
    if (isPlayerAiLoaded()) {
      loadPlayerAi()
        .then((playerAi) => playerAi.schedulePlayerAiQuickActionSync())
        .catch(() => {});
    }
    const shouldEnterReaderMode = isReaderMode(nextUrl);
    if (!isReaderViewOpen() && shouldEnterReaderMode) {
      document.documentElement.setAttribute("data-boc-reader-mode", "1");
      document.body.setAttribute("data-boc-reader-mode", "1");
      // renderReadingStatus 为常驻微模块（presentation.js）的轻函数，直接写
      // 状态栏；enterReaderMode 属 reader 重域，经 ensureReaderDomain 装载后进入。
      renderReadingStatus("检测到阅读视图跳转，正在打开阅读模式...");
      ensureReaderDomain()
        .then((reader) => reader.enterReaderMode())
        .catch((error) => {
          renderReadingStatus(`阅读视图启动失败：${getErrorMessage(error)}`);
        });
      return;
    }
    if (isReaderViewOpen() || shouldEnterReaderMode) {
      // 走到本分支的前提是视图已开或正要进入阅读模式：前者满足「视图开 ⇒ 域
      // 已装载」不变式，后者已由上一分支发起装载，ensure 均命中同一 promise。
      renderReadingStatus("检测到视频变化，正在自动刷新字幕...");
      ensureReaderDomain()
        .then((reader) => {
          reader.waitForVideoMetadata().then(() => {
            // 候选02：refreshClip 属总结链层，经 ensureSummarizeChain 装载后刷新。
            ensureSummarizeChain()
              .then((chain) => chain.refreshClip())
              .catch((error) => {
                if (!isStaleRunError(error)) {
                  renderReadingStatus(`自动刷新失败：${getErrorMessage(error)}`);
                }
              });
          });
        })
        .catch((error) => {
          if (!isStaleRunError(error)) {
            renderReadingStatus(`自动刷新失败：${getErrorMessage(error)}`);
          }
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
