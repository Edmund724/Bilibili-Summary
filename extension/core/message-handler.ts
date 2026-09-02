import { state, uiState, clipState } from "./state.js";
import { suppressUntil } from "../ai/player-ai-state.js";
import { DEFAULT_SETTINGS } from "./defaults.js";

// reader-get-context 的 payload 形状 + 签名投影单源（纯模块）：字段清单、
// 组装工厂与签名键/排除清单都在 context-payload.js，本文件只喂运行时输入
//（state.clip / state.settings / location.href）并 re-export 签名函数。
import {
  createReaderContextPayload,
  computeContextStateSignature
} from "./context-payload.js";

import { startUrlWatcher, BOC_URL_CHANGE_EVENT } from "./url-watcher.js";
import { replaceReaderModeUrl } from "../bilibili/reader-url.js";
import { ensureReaderChatTab } from "./lazy-chat-tab.js";
import { DEFAULT_PLAYER_AI_QUICK_PROMPT } from "./defaults.js";
import {
  getErrorMessage,
  isStaleRunError
} from "../shared/error-helpers.js";

// 候选02 分层惰性：video-probe（getRuntimeVideoElement/findReaderPlayerHost）
// 原被本模块与 reader 域共享而提升为常驻静态 chunk；其常驻侧唯一消费点是
// seek 联动处理器（异步），改为处理器内动态 import 后随 reader 域/总结链
// 切进动态 chunk（详见 reader-seek-video-time 处理器）。

// 总结链（fetcher/ui + notes/render）经加载器按需引入（候选02 分层惰性）：
// 链内符号一律 ensureSummarizeChain().then((chain) => chain.xxx())。一键总结
// 热路径上的装载是本地 chunk 动态 import（~10ms），被消息往返掩盖。
import { ensureSummarizeChain } from "../subtitle/lazy.js";
// 候选03 常驻瘦身：setStatus 迁入 shared/ui-status.js（DOM 节点存在时写入，
// 否则仅更新 state）；ensureUiReady 经 core/lazy-ui.js 惰性构建 UI 壳。
import { setStatus } from "../shared/ui-status.js";
import { ensureUiReady } from "./lazy-ui.js";

// player-ai 经加载器按需引入（候选4 分包）：默认关闭的能力不再常驻。
// 「未加载」时按钮不可能存在，remove/sync 均可安全跳过（幂等不变量见
// lazy-player-ai.js 头注）。
import { loadPlayerAi, isPlayerAiLoaded } from "./lazy-player-ai.js";

// reader 域经加载器按需引入（候选02 分层惰性）：重符号（enterReaderMode 等）
// 在处理器内 ensureReaderDomain() 后经命名空间取用；启动必需的轻符号直接从
// reader 状态微模块 import（isReaderViewOpen=纯 state 读、enforceNormalPageState-
// IfNeeded=DOM 守卫、renderReadingStatus=状态栏文案写入），不拖入 reader 重文件。
// （候选06：seek 的滚动暂停重置/跟随设置已收进 reader 域单入口
// seekReadingTarget 的规范序，本文件不再触碰 scroll-state 与跟随状态。）
import { ensureReaderDomain } from "./lazy-reader.js";
import { ids, isReaderViewOpen, enforceNormalPageStateIfNeeded } from "../reader/state.js";
// 候选03 常驻瘦身：renderReadingStatus 已惰性化。
import { renderReadingStatus } from "./lazy-reader-presentation.js";
// 日志直接取自 shared/logging.js（不再经 reader/index.js 转发）
import { logWarn } from "../shared/logging.js";
// S3 分层：阅读表随阅读模式挂载/移除（打开/关闭/URL 跳转编排三处共用）
import { ensureReaderStyles, removeReaderStyles } from "../shared/style-injector.js";

import {
  isReaderMode,
  cleanVideoUrl,
  computeCurrentClipSignature,
  stripReaderModeUrl
} from "../bilibili/video-id-shared.js";
import type {
  ContentScriptMessage,
  ReaderGetContextMessage,
  SendResponse
} from "../shared/messaging-protocol.js";
// 候选02 分层惰性：gateway（getCurrentAid/fetchHotComments）原被本模块与总结
// 链共享而提升为常驻静态 chunk；其常驻侧唯一消费点是热评消息处理器（异步），
// 改为处理器内动态 import 后，gateway/bili-api-shared 随总结链切进动态 chunk。

export function bindRuntimeEvents() {
  if (state.ui.runtimeEventsBound) {
    return;
  }
  uiState.setRuntimeEventsBound(true);

  chrome.runtime.onMessage.addListener((rawMessage, _sender, sendResponse: SendResponse) => {
    return dispatchContentScriptMessage(rawMessage, sendResponse);
  });
}

// 空 readerUrl 的语义是「已在阅读模式内，只聚焦/激活」。但 background 的
// player-ai / reading-chat 链在视图未开时也传空串（triggerReaderModeInTab 的
// 空 readerUrl 参数）——此时必须用当前地址兜底构造阅读 URL，否则 URL 改写、
// 阅读表与 data-boc-reader-mode 门控全被跳过，enterReaderMode 落在无样式的
// 半进入态（页面布局微变但阅读模式不出现）。拼法与 ui/digest-button.ts
// buildReaderUrl 一致（cleanVideoUrl 清成规范 URL 再加 boc_reader=1）。
function resolveReaderEntryUrl(readerUrl: string): string {
  if (readerUrl || isReaderViewOpen()) {
    return readerUrl;
  }
  const base = cleanVideoUrl(location.href);
  try {
    const parsed = new URL(base);
    parsed.searchParams.set("boc_reader", "1");
    return parsed.toString();
  } catch {
    return base;
  }
}

// onMessage 监听器的分发主体抽成可导出函数：除 runtime 消息外，页内触发源
//（ui/digest-button.ts 的工具栏按钮）也走同一处理器路径——content script 的
// chrome.runtime.sendMessage 不会回环到本文档自己的监听器，页内源必须直接
// 调用分发主体才能复用同一处理逻辑（保持 handler 单源，消息形状不变）。
export function dispatchContentScriptMessage(
  rawMessage: unknown,
  sendResponse: SendResponse
): boolean {
  {
    if (!rawMessage || typeof rawMessage !== "object") {
      return false;
    }
    const message = rawMessage as ContentScriptMessage;

    if (message.type === "popup-get-state") {
      // 候选02：getPopupPayload 属总结链层，经 ensure 装载后组装（热路径本地
      // 动态 import ~10ms）。装载失败回错误（popup 对缺 payload 有兜底渲染）。
      // digest-only-ui：popup 页面已删除，popup-* 消息仅剩 background 的阅读
      // 上下文链（context-resolver/chat 内核）在用，处理器保留以维持该链路。
      ensureSummarizeChain()
        .then((chain) => sendResponse({ ok: true, payload: chain.getPopupPayload() }))
        .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
      return true;
    }

    if (message.type === "popup-refresh") {
      // 候选03：刷新抓取会写面板 DOM（resetClipState / renderMeta 等），先确保
      // UI 壳存在。首开面板/首次刷新的惰性装载开销被用户动作掩盖。
      // digest-only-ui：popup 已删除，本消息由背景上下文链（context-resolver
      // 的 needsRefresh 分支）触发，ensureUiReady 保证阅读视图壳可写。
      ensureUiReady()
        .then(() => ensureSummarizeChain())
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
          // （popup / context-resolver 均对缺 payload 容错，回落当前上下文快照）。
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
      // 候选03：字幕切换会渲染面板 DOM，先确保 UI 壳存在。
      ensureUiReady()
        .then(() => ensureSummarizeChain())
        .then((chain) =>
          chain
            .loadSubtitle(url, lang, state.clip.fetchRunId, subtitleId)
            .then(() => {
              setStatus("字幕切换完成。");
              // digest-only-ui：popup 已删除；字幕切换后的阅读视图渲染由
              // presenter seam 的 subtitle-ready 通知驱动（renderReadingView），
              // 不再回写 popup 的下拉。
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
      suppressUntil(Date.now() + 2500);
      // 原为同步 remove；懒加载后「未加载 ⇒ 无按钮」可直接跳过，已加载时经
      // promise 移除（延后一个 tick，视觉无差异）。失败静默：移除按钮失败
      // 不应阻断阅读模式打开，且 suppressedUntil 已保证按钮短期不再弹出。
      if (isPlayerAiLoaded()) {
        loadPlayerAi()
          .then((playerAi) => playerAi.removePlayerAiQuickActionButton())
          .catch(() => {});
      }
      const readerUrl = resolveReaderEntryUrl(String(message.readerUrl || "").trim());
      // 候选03：先确保 UI 壳存在，再设置阅读模式属性并进入重域。ensureUiReady
      // 与后续 reader 操作串成同一 promise 链，避免并发触发导致壳构建两次。
      ensureUiReady().then(() => {
        if (readerUrl) {
          replaceReaderModeUrl(readerUrl);
          // S3：先挂阅读表再翻属性（无闪变时序，见 content.js 同款注释）
          ensureReaderStyles();
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
      });
      sendResponse({ ok: true });
      return true;
    }

    // 阅读视图自愈恢复（ui/digest-button.ts 的定时自查在失同步时派发，见该文件
    // syncDigestButton）。两种失同步：
    //   - URL 带 boc_reader=1 而视图没开：直达进入链在页面上半途失败（如 SW
    //     报文丢失、动态装载异常），失败文案写进隐藏面板用户看不见；
    //   - 状态开着而壳失整：面板壳被页面重渲染整树摘走，readingViewOpen 卡在
    //     true，digest 按钮被自查守卫永久压住——表现为「侧边栏和按钮一起消失，
    //     只能刷新」。closeReadingView 顶部才置状态、取壳节点失败会先抛错，所以
    //     收敛前必须先 ensureUiReady 把壳补回来。
    // 收敛后与 popup-trigger-reading-view 走同一条进入链（URL 改写 + 阅读表 +
    // 门控属性 + enterReaderMode）；重开会话态由各 tab 的恢复路径接管（对话从
    // 会话历史恢复、概览读缓存）。
    if (message.type === "popup-restore-reading-view") {
      suppressUntil(Date.now() + 2500);
      ensureUiReady().then(async () => {
        if (isReaderViewOpen()) {
          const shell = document.getElementById(ids.readingView);
          const shellIntact = Boolean(
            shell?.isConnected &&
              shell.classList.contains("open") &&
              shell.getAttribute("data-boc-reader-ready") !== "0" &&
              document.body.getAttribute("data-boc-reader-mode") === "1" &&
              document.documentElement.getAttribute("data-boc-reader-mode") === "1"
          );
          if (!shellIntact) {
            await ensureReaderDomain()
              .then((reader) => reader.closeReadingView())
              .catch((error) => {
                logWarn("[BOC] reading view restore: close failed", error);
              });
          }
        }
        const readerUrl = resolveReaderEntryUrl(String(message.readerUrl || "").trim());
        if (readerUrl) {
          replaceReaderModeUrl(readerUrl);
          // S3：先挂阅读表再翻属性（无闪变时序，见 popup-trigger-reading-view 同款注释）
          ensureReaderStyles();
          document.documentElement.setAttribute("data-boc-reader-mode", "1");
          document.body.setAttribute("data-boc-reader-mode", "1");
        }
        if (!isReaderViewOpen()) {
          await ensureReaderDomain()
            .then((reader) => reader.enterReaderMode())
            .catch((error) => {
              logWarn("[BOC] reading view restore failed", error);
            });
        }
      }).catch((error) => {
        logWarn("[BOC] reading view restore failed", error);
      });
      sendResponse({ ok: true });
      return true;
    }

    // PR5c：popup AI 入口 / player-ai 悬浮按钮的统一消费端（工单 08 决议 2）——
    // 先确保 reader shell（popup-trigger-reading-view 同款：URL 改写 + 阅读表 +
    // reader-mode 属性 + enterReaderMode），再激活对话 tab 并（带 prompt 时）
    // 自动发送快捷提示词。快捷动作路径传 consumeIntent:false（与快捷发送互不
    // 踩踏）；无 prompt 则只定位/聚焦对话 tab。发响应不等待 enterReaderMode
    // 完成（与 popup-trigger-reading-view 的即答语义一致）。
    if (message.type === "popup-trigger-reading-chat") {
      suppressUntil(Date.now() + 2500);
      if (isPlayerAiLoaded()) {
        loadPlayerAi()
          .then((playerAi) => playerAi.removePlayerAiQuickActionButton())
          .catch(() => {});
      }
      const readerUrl = resolveReaderEntryUrl(String(message.readerUrl || "").trim());
      const prompt = String(message.prompt || "").trim();
      ensureUiReady().then(async () => {
        if (readerUrl) {
          replaceReaderModeUrl(readerUrl);
          // S3：先挂阅读表再翻属性（无闪变时序，见 content.js 同款注释）
          ensureReaderStyles();
          document.documentElement.setAttribute("data-boc-reader-mode", "1");
          document.body.setAttribute("data-boc-reader-mode", "1");
        }
        if (!isReaderViewOpen()) {
          // 候选02：enterReaderMode 属 reader 重域，经 ensureReaderDomain 装载后
          // 进入（点击路径的本地动态装载对用户无感）。
          await ensureReaderDomain().then((reader) => reader.enterReaderMode());
        }
        const chat = await ensureReaderChatTab();
        if (prompt) {
          await chat.runQuickActionPrompt(prompt);
        } else {
          await chat.ensureChatTabActivated({ consumeIntent: false });
        }
      }).catch((error) => {
        logWarn("[BOC] reading chat trigger failed", error);
      });
      sendResponse({ ok: true });
      return true;
    }

    // player-ai 悬浮按钮语义反转的消费端（工单 08 决议 2）：阅读模式外/内点击
    // 统一 = 聚焦对话 tab + 自动发送快捷提示词。进入阅读模式的编排已由
    // background（triggerReaderModeInTab）完成，此处只消费。
    if (message.type === "player-ai-quick-action-chat") {
      const prompt = String(message.prompt || "").trim() || DEFAULT_PLAYER_AI_QUICK_PROMPT;
      ensureUiReady()
        .then(() => ensureReaderChatTab())
        .then((chat) => chat.runQuickActionPrompt(prompt))
        .catch((error) => {
          logWarn("[BOC] player-ai quick action chat failed", error);
        });
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
          // S3：关闭后移除阅读表——门控样式随属性清除已停止生效，摘表进一步
          // 释放级联；下次进入重挂（link 数据在浏览器缓存，二进宫无闪变）。
          removeReaderStyles();
          sendResponse({ ok: true });
        })
        .catch((error) => {
          sendResponse({ ok: false, error: getErrorMessage(error) });
        });
      return true;
    }

// PR5c：消息类型改 reader 中性命名（原 sidepanel-*，sidepanel 页面已摘除）；
// 旧名保留为兼容别名走同一处理器——存量构建的 options/popup 页面或缓存的
// background bundle 可能仍以旧名发送，别名在下一个发布周期后移除。
    if (
      message.type === "reader-get-context" ||
      (message as { type?: string }).type === "sidepanel-get-context"
    ) {
      const getContextMessage = message as ReaderGetContextMessage;
      const payload = buildReaderContextPayload();
      const signature = computeContextStateSignature(payload);
      // 候选5 签名短路：调用方（经 background 转发的对话上下文链）带着它上次收到的
      // 全量快照签名来问，content 状态没变就整份省略——不取字幕、不触发上层的
      // popup-refresh 与热评网络拉取，一次往返即返回。仅在非 forceRefresh 时生效：
      // 手动刷新/URL 变化语义上是明确要求全网络重拉。旧调用方不带 ifSignature
      // （空串）自然走全量路径，向后兼容。
      if (
        getContextMessage.forceRefresh !== true &&
        typeof getContextMessage.ifSignature === "string" &&
        getContextMessage.ifSignature &&
        getContextMessage.ifSignature === signature
      ) {
        sendResponse({ ok: true, unchanged: true, signature });
        return false;
      }
      // 全量路径：payload 附 signature，调用方存下来供下一轮 ifSignature 使用。
      sendResponse({ ok: true, payload: { ...payload, signature } });
      return false;
    }

    if (
      message.type === "reader-get-hot-comments" ||
      (message as { type?: string }).type === "sidepanel-get-hot-comments"
    ) {
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

    if (
      message.type === "reader-seek-video-time" ||
      (message as { type?: string }).type === "sidepanel-seek-video-time"
    ) {
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
            const seekedTo = reader.seekReadingTarget(message.seconds ?? 0, { resumePlayback: false });
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
  }
}

// ============================================================
// reader-get-context：payload 组装 + 状态签名（候选5 上下文同步瘦身）
// ============================================================

// reader-get-context 的全量 payload 组装：字段清单/组装/缺省口径全部单源在
// core/context-payload.js（createReaderContextPayload），本壳只注入运行时
// 输入。抽出成函数（而非处理器内联）的唯一原因是签名短路要先拿到 payload 才能
// 算签名。
function buildReaderContextPayload() {
  return createReaderContextPayload({
    clip: state.clip,
    settings: state.settings || DEFAULT_SETTINGS,
    url: location.href
  });
}

// 签名实现与「哪些字段参与/排除失效判定」的知识单源在 context-payload.js
//（签名从 payload 字段清单的投影表派生）；此处 re-export 维持既有导入面。
export { computeContextStateSignature };

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
    // 候选03：UI 壳惰性构建。URL 变化后需要先确保壳存在，再执行依赖壳的逻辑
    //（resetClipState 会清空面板内容；阅读模式进入依赖阅读视图壳）。
    ensureUiReady().then(() => {
      // 候选02：resetClipState 属总结链层，经 ensure 装载后执行。装载/执行失败
      // 记日志不中断编排（后续 reader 分支与状态提示仍需走到）。
      ensureSummarizeChain()
        .then((chain) => chain.resetClipState())
        .catch((error) => {
          logWarn("[BOC] clip state reset after URL change failed", error);
        });
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
      // S3：先挂阅读表再翻属性（无闪变时序，见 content.js 同款注释）
      ensureReaderStyles();
      document.documentElement.setAttribute("data-boc-reader-mode", "1");
      document.body.setAttribute("data-boc-reader-mode", "1");
      // 候选03：renderReadingStatus 已惰性化；壳构建与呈现层装载完成后写状态栏。
      Promise.all([ensureUiReady(), renderReadingStatus("检测到阅读视图跳转，正在打开阅读模式...")])
        .catch(() => {})
        .then(() => {
          ensureReaderDomain()
            .then((reader) => reader.enterReaderMode())
            .catch((error) => {
              renderReadingStatus(`阅读视图启动失败：${getErrorMessage(error)}`);
            });
        });
      return;
    }
    if (isReaderViewOpen() || shouldEnterReaderMode) {
      // 走到本分支的前提是视图已开或正要进入阅读模式：前者满足「视图开 ⇒ 域
      // 已装载」不变式，后者已由上一分支发起装载，ensure 均命中同一 promise。
      renderReadingStatus("检测到视频变化，正在自动刷新字幕...")
        .catch(() => {})
        .then(() => {
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
