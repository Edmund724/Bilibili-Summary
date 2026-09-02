import { state, uiState, clipState } from "./state.js";
import { DEFAULT_SETTINGS } from "./defaults.js";

// reader-get-context 的 payload 形状 + 签名投影单源（纯模块）：字段清单、
// 组装工厂与签名键/排除清单都在 context-payload.js，本文件只喂运行时输入
//（state.clip / state.settings / location.href）并 re-export 签名函数。
import {
  createReaderContextPayload,
  computeContextStateSignature
} from "./context-payload.js";

import { startUrlWatcher, BOC_URL_CHANGE_EVENT } from "./url-watcher.js";
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

// reader 域经加载器按需引入（候选02 分层惰性）：重符号在处理器内 ensureReaderDomain()
// 后经命名空间取用；启动必需的轻符号直接从 reader 状态微模块 import
//（isReaderViewOpen=纯 state 读、enforceNormalPageStateIfNeeded=DOM 守卫、
// renderReadingStatus=状态栏文案写入），不拖入 reader 重文件。
// 阅读壳（工单 arch-slim/02）：reading-view 四个消息分支与 URL 跳转编排的
// 进入/退出事务统一委托 reader/shell.ts（enterReaderShell / exitReaderShell /
// enterReaderShellOnUrlNavigation），八步无闪变时序不再有本文件的手抄。
// （候选06：seek 的滚动暂停重置/跟随设置已收进 reader 域单入口
// seekReadingTarget 的规范序，本文件不再触碰 scroll-state 与跟随状态。）
import { ensureReaderDomain } from "./lazy-reader.js";
import {
  enterReaderShell,
  enterReaderShellOnUrlNavigation,
  exitReaderShell
} from "../reader/shell.js";
import { isReaderViewOpen, enforceNormalPageStateIfNeeded } from "../reader/state.js";
// 候选03 常驻瘦身：renderReadingStatus 已惰性化。
import { renderReadingStatus } from "./lazy-reader-presentation.js";
// 日志直接取自 shared/logging.js（不再经 reader/index.js 转发）
import { logWarn } from "../shared/logging.js";

import {
  isReaderMode,
  computeCurrentClipSignature
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

    if (message.type === "clip-refresh") {
      // 候选03：刷新抓取会写面板 DOM（resetClipState / renderMeta 等），先确保
      // UI 壳存在。首开面板/首次刷新的惰性装载开销被用户动作掩盖。
      // 本消息由背景上下文链（context-resolver 的 needsRefresh 分支）触发，
      // ensureUiReady 保证阅读视图壳可写。
      ensureUiReady()
        .then(() => ensureSummarizeChain())
        .then((chain) =>
          chain
            .refreshClip()
            .then(() => sendResponse({ ok: true, payload: chain.buildClipSnapshotPayload() }))
            .catch((error) =>
              sendResponse({ ok: false, error: getErrorMessage(error), payload: chain.buildClipSnapshotPayload() })
            )
        )
        .catch((error) => {
          // 链装载失败（清缓存重试后仍失败）：无法组装 payload，按错误口径回包
          // （context-resolver 对缺 payload 容错，回落当前上下文快照）。
          sendResponse({ ok: false, error: getErrorMessage(error) });
        });
      return true;
    }

    // 进入阅读壳（工单 arch-slim/02）：三个 reading-view 分支只做意图路由，
    // 八步无闪变时序与 restore 失同步自愈都在 reader/shell.ts 唯一实现。
    if (message.type === "reader-enter") {
      enterReaderShell({ readerUrl: String(message.readerUrl || ""), intent: "open" });
      sendResponse({ ok: true });
      return true;
    }

    // 阅读视图自愈恢复（ui/digest-button.ts 的定时自查在失同步时派发，见该文件
    // syncDigestButton）：壳完好性自查 + 先收敛再重进都在壳的 restore 档内。
    if (message.type === "reader-restore") {
      enterReaderShell({ readerUrl: String(message.readerUrl || ""), intent: "restore" });
      sendResponse({ ok: true });
      return true;
    }

    // PR5c：AI 对话入口 / player-ai 悬浮按钮的统一消费端（工单 08 决议 2）：
    // 进入壳后激活对话 tab 并（带 prompt 时）自动发送快捷提示词，全部在壳的
    // focus-chat 档内。发响应不等待事务完成（即答语义与 reader-enter 一致）。
    if (message.type === "reader-enter-chat") {
      enterReaderShell({ readerUrl: message.readerUrl ?? "", intent: "focus-chat", prompt: message.prompt ?? "" });
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

    // 退出阅读壳（工单 arch-slim/02）：reader-close 处理器退化为退出事务委托
    // （URL 收敛 → closeReadingView → 摘阅读表都在 exitReaderShell 内）。
    if (message.type === "reader-close") {
      exitReaderShell()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
      return true;
    }

    if (message.type === "reader-get-context") {
      const getContextMessage = message as ReaderGetContextMessage;
      const payload = buildReaderContextPayload();
      const signature = computeContextStateSignature(payload);
      // 候选5 签名短路：调用方（经 background 转发的对话上下文链）带着它上次收到的
      // 全量快照签名来问，content 状态没变就整份省略——不取字幕、不触发上层的
      // clip-refresh 与热评网络拉取，一次往返即返回。仅在非 forceRefresh 时生效：
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

    if (message.type === "reader-get-hot-comments") {
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

    if (message.type === "reader-seek-video-time") {
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
      // URL 跳转编排改走阅读壳（工单 arch-slim/02）：与消息意图三档共享同一条
      // 进入链（挂表 → 翻门控属性 → enterReaderMode），但无 player-ai 前奏
      //（URL 跳转没有用户点击在先，不抑制、不摘快捷按钮）；进入前播报等落地
      //（防反向覆盖 enterReaderMode 的「已就绪」文案），失败口径写状态栏。
      enterReaderShellOnUrlNavigation({
        readerUrl: nextUrl,
        announce: () => renderReadingStatus("检测到阅读视图跳转，正在打开阅读模式..."),
        onEnterFailed: (error) => {
          renderReadingStatus(`阅读视图启动失败：${getErrorMessage(error)}`);
        }
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
