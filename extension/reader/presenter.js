// Reader presenter seam.
//
// Two-way decoupling channel between the reader domain and the subtitle
// fetching orchestration (subtitle/fetcher.js), plus the reader-side sink for
// runtime capabilities that must not be imported by reader-impl.js (which
// would create a static import cycle back through core/runtime.js).
//
//   fetcher → reader (data-change notifications):
//     fetcher publishes data-change notifications here instead of calling
//     reader render functions directly; the reader side (reader-impl.js)
//     registers callbacks via subscribeReaderPresenter to render on them.
//   reader → fetcher (refresh requests):
//     the reader side asks the fetcher to re-fetch via
//     requestSubtitleRefresh(); fetcher registers its refreshClip handler at
//     module load via subscribeSubtitleRefresh. This reverses the former
//     reader-impl.js → subtitle/fetcher.js import, breaking the cycle.
//   reader → runtime (capability callbacks):
//     reader-impl.js delegates capabilities that live outside the reader
//     domain (sendRuntimeMessage for settings persistence, from
//     shared/messaging.js; getSettings for the settings-change watcher, from
//     core/runtime.js) to callbacks registered by content.js, which imports
//     them itself. This keeps reader-impl.js free of any
//     static import back into core/runtime.js.
//   reader → player-ai (sync callbacks):
//     reader-impl.js delegates player-ai quick-action sync to a callback
//     registered by content.js, because importing ai/player-ai.js would pull
//     core/runtime.js (and thus an import cycle) into the reader graph.
//
// All payloads are read from the shared state at notification time, so the
// callbacks need no arguments.

import { logWarn } from "../shared/logging.js";
// 候选02 分层惰性：总结链改为按需装载后，seam 里可能暂无 refreshClip handler
// （注册时机与链装载绑定，见 subtitle/fetcher.js initSummarizeChain）。无
// handler 时先经加载器装载总结链再重读 seam。本模块只 import 加载器本身
//（常驻轻文件，动态边在其内部），不会把链拖回常驻。
import { ensureSummarizeChain } from "../subtitle/lazy.js";

const readers = [];

const subtitleRefreshHandlers = [];

let persistSettingsHandler = null;
let loadSettingsHandler = null;

export function subscribeReaderPresenter(handler) {
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
export function notifyReaderPresenter(kind, ...payload) {
  for (const handler of readers.slice()) {
    try {
      handler(kind, ...payload);
    } catch (error) {
      logWarn("[BOC] reader presenter handler failed", { kind, error });
    }
  }
}

export function subscribeSubtitleRefresh(handler) {
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
export function requestSubtitleRefresh() {
  const handler = subtitleRefreshHandlers[0];
  if (!handler) {
    // 候选02 分层惰性：链未装载 ⇒ refreshClip 未注册。先装载总结链（其
    // initSummarizeChain 会把 refreshClip 注册进 seam），再重读 handler 转发；
    // 装载失败保持「must never throw」约定，静默 resolve(undefined)。
    return ensureSummarizeChain()
      .then(() => {
        const loadedHandler = subtitleRefreshHandlers[0];
        if (!loadedHandler) {
          return undefined;
        }
        try {
          return Promise.resolve(loadedHandler());
        } catch (error) {
          logWarn("[BOC] subtitle refresh handler failed", { error });
          return undefined;
        }
      })
      .catch((error) => {
        logWarn("[BOC] subtitle refresh (summarize chain load) failed", { error });
        return undefined;
      });
  }
  try {
    return Promise.resolve(handler());
  } catch (error) {
    logWarn("[BOC] subtitle refresh handler failed", { error });
    return undefined;
  }
}

// Registers the content-script callback that persists reader settings via
// shared/messaging.js's sendRuntimeMessage. reader-impl.js calls
// persistReaderSettingsThroughSeam() instead of importing sendRuntimeMessage.
export function subscribeReaderSettingsPersist(handler) {
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
export function subscribeReaderSettingsLoad(handler) {
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
let playerAiSyncHandler = null;

export function subscribePlayerAiSync(handler) {
  playerAiSyncHandler = typeof handler === "function" ? handler : null;
}

export function requestPlayerAiSync(delayMs, options) {
  if (!playerAiSyncHandler) {
    return;
  }
  try {
    playerAiSyncHandler(delayMs, options);
  } catch (error) {
    logWarn("[BOC] player-ai sync handler failed", { error });
  }
}
