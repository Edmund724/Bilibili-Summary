// content 侧消息分发 + URL 变化编排的组合根（arch-slim-2/09 自 core/ 归位
// entry/：消息分发与页内编排是 entry 层知识，core/ 回归纯共享底座）。
import { state, uiState, clipState } from "../core/state.js";
import { DEFAULT_PLAYER_AI_QUICK_PROMPT } from "../core/defaults.js";

import { startUrlWatcher, BOC_URL_CHANGE_EVENT } from "../core/url-watcher.js";
import { ensureReaderChatTab } from "../reader/lazy-chat-tab.js";
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
// 否则仅更新 state）；ensureUiReady 经 ui/lazy-ui.js 惰性构建 UI 壳。
import { setStatus } from "../shared/ui-status.js";
import { ensureUiReady } from "../ui/lazy-ui.js";

// player-ai 经加载器按需引入（候选4 分包）：默认关闭的能力不再常驻。
// 「未加载」时按钮不可能存在，remove/sync 均可安全跳过（幂等不变量见
// ai/lazy-player-ai.js 头注）。
import { loadPlayerAi, isPlayerAiLoaded } from "../ai/lazy-player-ai.js";

// reader 域经加载器按需引入（候选02 分层惰性）：重符号在处理器内 ensureReaderDomain()
// 后经命名空间取用；启动必需的轻符号直接从 reader 状态微模块 import
//（isReaderViewOpen=纯 state 读、enforceNormalPageStateIfNeeded=DOM 守卫、
// renderReadingStatus=状态栏文案写入），不拖入 reader 重文件。
// 阅读壳（工单 arch-slim/02）：reading-view 四个消息分支与 URL 跳转编排的
// 进入/退出事务统一委托 reader/shell.ts（enterReaderShell / exitReaderShell /
// enterReaderShellOnUrlNavigation），八步无闪变时序不再有本文件的手抄。
// （候选06：seek 的滚动暂停重置/跟随设置已收进 reader 域单入口
// seekReadingTarget 的规范序，本文件不再触碰 scroll-state 与跟随状态。）
// arch-slim-2/09 shell 静态边改动态（ADR-0003 拆边）：reader/shell.ts 不再借道
// 常驻包，四个 reading-view 分支与 URL 跳转入口改经 reader/lazy-shell.js 动态
// 装载（reader-enter 本来就要装载 reader 域，shell 随行净增≈0）。
import { ensureReaderDomain } from "../reader/lazy-reader.js";
import { ensureReaderShell } from "../reader/lazy-shell.js";
import { isReaderViewOpen, enforceNormalPageStateIfNeeded } from "../reader/state.js";
// 候选03 常驻瘦身：renderReadingStatus 已惰性化。
import { renderReadingStatus } from "../reader/lazy-reader-presentation.js";
// 日志直接取自 shared/logging.js（不再经 reader/index.js 转发）
import { logWarn } from "../shared/logging.js";

import {
  isReaderMode,
  computeCurrentClipSignature
} from "../bilibili/video-id-shared.js";
import type {
  ContentScriptMessage,
  ContentScriptMessageType,
  SendResponse
} from "../shared/messaging-protocol.js";
// ReaderShellIntent 经 lazy-shell 装载边 type-only 透出（零运行时边）：shell
// 本体的静态调用方闭包由 shell-sequence 守卫锁定，本组合根只触达 lazy-shell。
import type { ReaderShellIntent } from "../reader/lazy-shell.js";
// 页内分发原语（arch-slim-2/09，与 sendRuntimeMessage 同址 shared/messaging.js）：
// ui/digest-button.ts 等页内触发源经它进同一条处理器路径，本组合根在
// bindRuntimeEvents 时把分发主体注册进去。
import { registerContentScriptDispatcher } from "../shared/messaging.js";
// 候选02 分层惰性：gateway（getCurrentAid/fetchHotComments）原被本模块与总结
// 链共享而提升为常驻静态 chunk；其常驻侧唯一消费点是热评消息处理器（异步），
// 改为处理器内动态 import 后，gateway/bili-api-shared 随总结链切进动态 chunk。

export function bindRuntimeEvents() {
  if (state.ui.runtimeEventsBound) {
    return;
  }
  uiState.setRuntimeEventsBound(true);

  // 页内源（ui/digest-button.ts 的点击 / 失同步自愈）与 runtime 监听器共用
  // 同一分发主体：注册进 shared/messaging.js 的原语槽（ui 侧只依赖 shared，
  // 不建 ui → entry 静态边），再挂 chrome.runtime.onMessage。
  registerContentScriptDispatcher(dispatchContentScriptMessage);
  chrome.runtime.onMessage.addListener((rawMessage, _sender, sendResponse: SendResponse) => {
    return dispatchContentScriptMessage(rawMessage, sendResponse);
  });
}

// onMessage 监听器的分发主体抽成可导出函数：除 runtime 消息外，页内触发源
//（ui/digest-button.ts 的工具栏按钮）也走同一处理器路径——页内源经
// shared/messaging.js 的 dispatchContentScriptMessage 原语（本函数在
// bindRuntimeEvents 时注册进去）复用同一处理逻辑（保持 handler 单源，消息
// 形状不变）。

// ===== content 侧消息处理器与路由表（arch-slim-3/04）=====

type Msg<T extends ContentScriptMessageType> = Extract<ContentScriptMessage, { type: T }>;

type ContentScriptHandler<K extends ContentScriptMessageType> = (
  message: Msg<K>,
  sendResponse: SendResponse
) => boolean;

// 进阅读壳（工单 arch-slim/02）：三个 reading-view 消息只做意图路由，八步无
// 闪变时序与 restore 失同步自愈都在 reader/shell.ts 唯一实现；消息名 → intent
// 的映射单源在下方意图表。arch-slim-2/09：shell 改经 lazy-shell 动态装载后，
// 回包时点从「同步即答」平移为「shell 模块装载完成后、进入事务发起前即答」
//——发响应仍不等待事务完成（即答语义保持）；装载失败才有 ok:false 分支
//（本地 chunk 装载 ~10ms，被消息往返掩盖）。
type ReaderShellEntryType = "reader-enter" | "reader-restore" | "reader-enter-chat";

const readerShellIntentByType: Record<ReaderShellEntryType, ReaderShellIntent> = {
  "reader-enter": "open",
  "reader-restore": "restore",
  "reader-enter-chat": "focus-chat"
};

function handleReaderShellEnter(
  message: Msg<ReaderShellEntryType>,
  sendResponse: SendResponse
): boolean {
  const intent = readerShellIntentByType[message.type];
  ensureReaderShell()
    .then((shell) => {
      if (message.type === "reader-enter-chat") {
        shell.enterReaderShell({ readerUrl: String(message.readerUrl || ""), intent, prompt: message.prompt ?? "" });
      } else {
        shell.enterReaderShell({ readerUrl: String(message.readerUrl || ""), intent });
      }
      sendResponse({ ok: true });
    })
    .catch((error) => {
      logWarn("[BOC] reading shell load failed", error);
      sendResponse({ ok: false, error: getErrorMessage(error) });
    });
  return true;
}

// player-ai 悬浮按钮语义反转的消费端（工单 08 决议 2）：阅读模式外/内点击
// 统一 = 聚焦对话 tab + 自动发送快捷提示词。进入阅读模式的编排已由
// background（triggerReaderModeInTab）完成，此处只消费。
function handlePlayerAiQuickActionChat(message: Msg<"player-ai-quick-action-chat">, sendResponse: SendResponse): boolean {
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
//（URL 收敛 → closeReadingView → 摘阅读表都在 exitReaderShell 内）。
function handleReaderClose(_message: Msg<"reader-close">, sendResponse: SendResponse): boolean {
  ensureReaderShell()
    .then((shell) => shell.exitReaderShell())
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
  return true;
}

function handleReaderGetHotComments(_message: Msg<"reader-get-hot-comments">, sendResponse: SendResponse): boolean {
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

function handleReaderSeekVideoTime(message: Msg<"reader-seek-video-time">, sendResponse: SendResponse): boolean {
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

// 编译期穷尽路由表（与 SW 侧 background.ts 的 messageHandlerTable 同款收敛，
// arch-slim-3/04）：字面量表经 satisfies 对
// { [K in ContentScriptMessageType]: ContentScriptHandler<K> } 校验——消息名
// typo / 漏注册 handler 在 typecheck 即报错（此前 9 分支 if-chain + 末尾
// return false 对此零捕获，与 SW 侧不对称）。每个条目的处理器同时按其具体
// 消息形状 Msg<K> 校验，签名与消息类型不匹配同样报错。
const contentMessageHandlerTable = {
  "reader-enter": handleReaderShellEnter,
  "reader-restore": handleReaderShellEnter,
  "reader-enter-chat": handleReaderShellEnter,
  "player-ai-quick-action-chat": handlePlayerAiQuickActionChat,
  "reader-close": handleReaderClose,
  "reader-get-hot-comments": handleReaderGetHotComments,
  "reader-seek-video-time": handleReaderSeekVideoTime
} satisfies { [K in ContentScriptMessageType]: ContentScriptHandler<K> };

const contentMessageHandlers = new Map<
  string,
  (message: ContentScriptMessage, sendResponse: SendResponse) => boolean
>(
  Object.entries(contentMessageHandlerTable) as Array<
    [string, (message: ContentScriptMessage, sendResponse: SendResponse) => boolean]
  >
);

export function dispatchContentScriptMessage(rawMessage: unknown, sendResponse: SendResponse): boolean {
  if (!rawMessage || typeof rawMessage !== "object") {
    return false;
  }
  const messageType = (rawMessage as { type?: unknown }).type;
  const handler = typeof messageType === "string" ? contentMessageHandlers.get(messageType) : undefined;
  if (!handler) {
    return false;
  }
  return handler(rawMessage as ContentScriptMessage, sendResponse);
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
      // arch-slim-2/09：shell 经 lazy-shell 动态装载，装载失败与进入失败同口径
      // 写状态栏（本地 chunk 装载 ~10ms，被跳转往返掩盖）。
      ensureReaderShell()
        .then((shell) =>
          shell.enterReaderShellOnUrlNavigation({
            readerUrl: nextUrl,
            announce: () => renderReadingStatus("检测到阅读视图跳转，正在打开阅读模式..."),
            onEnterFailed: (error) => {
              renderReadingStatus(`阅读视图启动失败：${getErrorMessage(error)}`);
            }
          })
        )
        .catch((error) => {
          logWarn("[BOC] reading shell load failed", error);
          renderReadingStatus(`阅读视图启动失败：${getErrorMessage(error)}`);
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
