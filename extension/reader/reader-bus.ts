// Reader reader-bus（reader 域的双向消息总线 seam；arch-slim-2/03 自
// presenter.ts 改名——它不呈现任何东西，"presenter" 会被误归入 presentation
// 家族。导出符号名（subscribeReaderPresenter/notifyReaderPresenter 等历史
// API 名）保持不变，改名只动文件与导航口径）。
//
// Two-way decoupling channel between the reader domain and the subtitle
// fetching orchestration (subtitle/fetcher.js), plus the reader-side sink for
// runtime capabilities that must not be imported by the reader domain (which
// would create a static import cycle back through core/runtime.js).
//
//   fetcher → reader (data-change notifications):
//     fetcher publishes data-change notifications here instead of calling
//     reader render functions directly; the reader side (reader/lifecycle.js)
//     registers callbacks via subscribeReaderPresenter to render on them.
//   reader → fetcher (refresh requests):
//     the reader side asks the fetcher to re-fetch via
//     requestSubtitleRefresh(); fetcher registers its refreshClip handler at
//     module load via subscribeSubtitleRefresh. This reverses the former
//     reader-impl.js → subtitle/fetcher.js import, breaking the cycle.
//   reader → runtime (capability callbacks):
//     the reader domain delegates capabilities that live outside it
//     (sendRuntimeMessage for settings persistence, from
//     shared/messaging.js; getSettings for the settings-change watcher, from
//     core/runtime.js) to callbacks registered by content.js, which imports
//     them itself. This keeps the reader domain free of any
//     static import back into core/runtime.js.
//   reader → player-ai (sync callbacks):
//     the reader domain delegates player-ai quick-action sync to a callback
//     registered by content.js, because importing ai/player-ai.js would pull
//     core/runtime.js (and thus an import cycle) into the reader graph.
//   reader → ui 壳 (shell commands):
//     reader 侧三处对 ui 壳交互的回头调（lifecycle enterReaderMode 的 tab 重置、
//     explain-card「去对话追问」的切 tab + 激活、chat-tab 快捷动作定位与空态
//     「前往设置」）改发具名命令 requestUiCommand(name, payload?)；ui-renderer
//     在模块装载时经 subscribeUiCommand 注册单 handler 执行壳操作。reader 域
//     从此不再静态 import ui/ui-renderer（arch-review-2026-09/10 依赖反向边
//     清零），壳缺失（未装载/命令名未注册）时命令静默丢弃——与原先 DOM 缺失
//     时 setter 空转同形。
//
// All payloads are read from the shared state at notification time, so the
// callbacks need no arguments.

import { logWarn } from "../shared/logging.js";

type ReaderPresenterHandler = (kind: string, ...payload: unknown[]) => void;
type SubtitleRefreshHandler = () => unknown;
type SettingsPersistHandler = () => void;
type SettingsLoadHandler = () => unknown;
type PlayerAiSyncHandler = (delayMs?: number, options?: { resetRetry?: boolean }) => void;
type UiCommandHandler = (name: string, payload?: unknown) => void;

const readers: ReaderPresenterHandler[] = [];

const subtitleRefreshHandlers: SubtitleRefreshHandler[] = [];

let persistSettingsHandler: SettingsPersistHandler | null = null;
let loadSettingsHandler: SettingsLoadHandler | null = null;

export function subscribeReaderPresenter(handler: ReaderPresenterHandler) {
  if (typeof handler !== "function") {
    return () => {};
  }
  if (readers.indexOf(handler) === -1) {
    readers.push(handler);
  }
  return function unsubscribeReaderPresenter() {
    const index = readers.indexOf(handler);
    if (index !== -1) {
      readers.splice(index, 1);
    }
  };
}

// 通知签名：(kind, ...payload)。payload 透传给 reader 侧 handler——fetcher 的
// "subtitle-ready" 会带状态栏文案（如"当前视频无字幕。"），"status" 带提示文本；
// 历史上这里只转发 kind，第二参被丢弃、阅读视图永远显示默认文案。单参调用
// （reset/rerender/无文案的 subtitle-ready）行为不变。
export function notifyReaderPresenter(kind: string, ...payload: unknown[]) {
  for (const handler of readers.slice()) {
    try {
      handler(kind, ...payload);
    } catch (error) {
      logWarn("[BOC] reader presenter handler failed", { kind, error });
    }
  }
}

export function subscribeSubtitleRefresh(handler: SubtitleRefreshHandler) {
  if (typeof handler !== "function") {
    return () => {};
  }
  if (subtitleRefreshHandlers.indexOf(handler) === -1) {
    subtitleRefreshHandlers.push(handler);
  }
  return function unsubscribeSubtitleRefresh() {
    const index = subtitleRefreshHandlers.indexOf(handler);
    if (index !== -1) {
      subtitleRefreshHandlers.splice(index, 1);
    }
  };
}

// Asks the subtitle fetcher to re-fetch the current clip. Resolves with the
// handler's return value (a Promise), or with undefined when no handler is
// registered yet — must never throw.
//
// 纯转发（arch-slim-2/03）：原内嵌的 ensureSummarizeChain() 懒装载触达已移到
// 调用方（reader/lifecycle.js 的 maybeRefreshReaderSubtitleInBackground 先
// ensure 总结链再调本函数）——本 seam 恢复「只传话」的窄形状，与其他三个
// 能力槽（settings persist/load、player-ai sync）同形。
export function requestSubtitleRefresh(): Promise<unknown> {
  const handler = subtitleRefreshHandlers[0];
  if (!handler) {
    return Promise.resolve(undefined);
  }
  try {
    return Promise.resolve(handler());
  } catch (error) {
    logWarn("[BOC] subtitle refresh handler failed", { error });
    return Promise.resolve(undefined);
  }
}

// Registers the content-script callback that persists reader settings via
// shared/messaging.js's sendRuntimeMessage. reader-impl.js calls
// persistReaderSettingsThroughSeam() instead of importing sendRuntimeMessage.
export function subscribeReaderSettingsPersist(handler: SettingsPersistHandler) {
  persistSettingsHandler = typeof handler === "function" ? handler : null;
}

export function persistReaderSettingsThroughSeam() {
  if (!persistSettingsHandler) {
    return;
  }
  try {
    persistSettingsHandler();
  } catch (error) {
    logWarn("[BOC] reader settings persist handler failed", { error });
  }
}

// Registers the content-script callback that loads settings via
// core/runtime.js's getSettings (a Promise). reader-impl.js's settings-change
// watcher delegates through here instead of importing getSettings.
export function subscribeReaderSettingsLoad(handler: SettingsLoadHandler) {
  loadSettingsHandler = typeof handler === "function" ? handler : null;
}

export function loadReaderSettingsThroughSeam() {
  if (!loadSettingsHandler) {
    return Promise.resolve(null);
  }
  try {
    return Promise.resolve(loadSettingsHandler());
  } catch (error) {
    logWarn("[BOC] reader settings load handler failed", { error });
    return Promise.resolve(null);
  }
}

// Registers the content-script callback that syncs the player AI quick-action
// button (ai/player-ai.js). reader-impl.js must not import ai/player-ai.js
// (it would pull core/runtime.js back into the reader dependency graph), so
// the debug helper and settings watcher delegate through this seam instead.
let playerAiSyncHandler: PlayerAiSyncHandler | null = null;

export function subscribePlayerAiSync(handler: PlayerAiSyncHandler) {
  playerAiSyncHandler = typeof handler === "function" ? handler : null;
}

export function requestPlayerAiSync(delayMs?: number, options?: { resetRetry?: boolean }) {
  if (!playerAiSyncHandler) {
    return;
  }
  try {
    playerAiSyncHandler(delayMs, options);
  } catch (error) {
    logWarn("[BOC] player-ai sync handler failed", { error });
  }
}

// Registers the ui-renderer callback that executes shell commands (tab
// reset/switch, settings drawer). reader 域经 requestUiCommand 发命令而不静态
// import ui-renderer（依赖反向边清零，arch-review-2026-09/10）；单 handler 槽，
// 与 settings persist/load、player-ai sync 两个能力槽同形。
let uiCommandHandler: UiCommandHandler | null = null;

export function subscribeUiCommand(handler: UiCommandHandler) {
  uiCommandHandler = typeof handler === "function" ? handler : null;
}

// 壳命令纯转发（fire-and-forget）：壳未装载（无 handler）或命令名未识别时静默
// 丢弃——reader 域发命令早于壳装载是合法时序（原 ui-renderer setter 在 DOM 缺失
// 时同样空转）。handler 内异常只记日志不上抛。
export function requestUiCommand(name: string, payload?: unknown) {
  if (!uiCommandHandler) {
    return;
  }
  try {
    uiCommandHandler(name, payload);
  } catch (error) {
    logWarn("[BOC] ui command handler failed", { name, error });
  }
}
