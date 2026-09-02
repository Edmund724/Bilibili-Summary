import { state } from "../core/state.js";
import { BOC_VERSION } from "../core/defaults.js";

import { isReaderMode, isWatchlaterPage } from "../bilibili/video-id-shared.js";
import { getSettings } from "../core/runtime.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { logInfo, logWarn } from "../shared/logging.js";

// 播放器 AI 模块经加载器按需引入（候选4 分包）：默认关闭的设置对应的能力
// 不再常驻，start/stop/sync 全部走 loadPlayerAi() 的动态 import。
import { loadPlayerAi, isPlayerAiLoaded } from "../core/lazy-player-ai.js";

// Digest 工具栏按钮经加载器按需引入（统一 Digest 阅读模式 PR1）：非阅读模式
// 分支与阅读模式直达分支都装载——直达分支上按钮由自查守卫恒摘除（无意义），
// 装载为的是视图失同步自愈与关闭视图后补回按钮（见 ui/digest-button.ts 头注）。
import { loadDigestButton } from "../core/lazy-digest-button.js";

// 候选03 常驻瘦身：UI 壳构建（ensureUiReady）与 reader 静态呈现层
//（hydrateReaderStateFromSettings / applyReadingViewPresentation / renderReadingStatus）
// 已惰性化，只在面板打开或进入阅读模式时加载。普通页启动路径不再构建
// #boc-root / #boc-reading-view 壳，也不应用阅读排版属性。
import { ensureUiReady } from "../core/lazy-ui.js";
// 候选02 分层惰性 + 候选03 常驻瘦身：init() 的启动符号只保留真正常驻的轻量
// 接线与页面状态守卫；设置水合/排版呈现/状态栏文案随阅读模式进入惰性装载。
import {
  installReaderDebugHelpers,
  bindSettingsWatcher,
  bindReaderPresenter
} from "../reader/init-essentials.js";
import { clearReaderModePageState, bindNormalPageStateGuard } from "../reader/state.js";
import {
  hydrateReaderStateFromSettings,
  applyReadingViewPresentation,
  renderReadingStatus
} from "../core/lazy-reader-presentation.js";
import { ensureReaderDomain } from "../core/lazy-reader.js";

import {
  subscribeReaderSettingsPersist,
  subscribeReaderSettingsLoad,
  subscribePlayerAiSync
} from "../reader/presenter.js";

import { bindRuntimeEvents, bindUrlChangeHandler } from "../core/message-handler.js";
// S3 分层：阅读表随阅读模式挂载（进入/URL 编排与 message-handler 共用同一
// 挂载器；此处 handle 启动直开路径与页内跳转路径）
import { ensureReaderStyles, removeReaderStyles } from "../shared/style-injector.js";

// lazy-player-ai.ts 的接口未覆盖 content 侧实际调用的全部方法；用局部接口
// 精确描述本文件消费的 API，避免把调用点退化成 any。
interface PlayerAiApi {
  startPlayerAiQuickAction(): void;
  stopPlayerAiQuickAction(): void;
  resetPlayerAiQuickActionRetryCount(): void;
  schedulePlayerAiQuickActionSync(delayMs?: number): void;
}

// reader/presenter.js 仍是 .js，无导出类型；本文件精确描述 seam 回调签名。
// delayMs 透传给 schedulePlayerAiQuickActionSync；options.resetRetry 重置重试计数。
type PlayerAiSyncHandler = (delayMs?: number, options?: { resetRetry?: boolean }) => void;

globalThis.__BOC_CONTENT_SCRIPT_LOADED__ = BOC_VERSION;

// 播放器 AI 开关监听只注册一次：init 在模块加载时同步执行，声明必须位于
// 其之前（避免 TDZ），标志兜底防重复注入。
let playerAiSettingsWatcherBound = false;

init();

function isSupportedUrl(): boolean {
  if (isReaderMode()) return true;
  if (isWatchlaterPage()) return true;
  if (/\/video\//.test(location.pathname)) return true;
  return false;
}

function init(): void {
  logInfo(`[BOC] content script loaded, version=${BOC_VERSION}`);
  if (!isSupportedUrl()) {
    return;
  }

  // 候选03：普通页启动不再同步构建 UI 壳。面板/阅读视图壳在首次打开/进入时
  // 经 ensureUiReady 惰性构建。
  installReaderDebugHelpers();

  const shouldEnterReaderMode = isReaderMode();
  if (shouldEnterReaderMode) {
    // S3：先挂阅读表再翻 data-boc-reader-mode 属性——属性门控是样式生效开关，
    // 表提前挂（哪怕 link 尚未加载完）不会误伤普通页面；属性翻转瞬间阅读样式
    // 已注入，无闪变窗口。
    ensureReaderStyles();
    document.documentElement.setAttribute("data-boc-reader-mode", "1");
    document.body.setAttribute("data-boc-reader-mode", "1");
  } else {
    removeReaderStyles();
    clearReaderModePageState();
  }

  bindRuntimeEvents();
  bindSettingsWatcher();
  bindReaderPresenter();
  // Reader settings persistence (sendRuntimeMessage, shared/messaging.js) and
  // loading (getSettings, core/runtime.js) are outside the reader domain;
  // reader-impl.js must not import them (import cycle), so content.js wires
  // the presenter seam callbacks here.
  subscribeReaderSettingsPersist(() => {
    sendRuntimeMessage({ type: "save-settings", settings: state.settings }).catch((error) => {
      logWarn("[BOC] failed to persist reader settings", error);
    });
  });
  subscribeReaderSettingsLoad(() => getSettings());
  // Reader triggers player-ai quick-action sync through this seam instead of
  // importing ai/player-ai.js (which would pull core/runtime.js into the
  // reader dependency graph). The delayMs argument maps to
  // schedulePlayerAiQuickActionSync(delayMs); an undefined value keeps the
  // default 120ms delay. options.resetRetry mirrors the original
  // __BOC_FORCE_SYNC_PLAYER_AI__ behavior (only the debug helper resets the
  // retry counter before syncing).
  subscribePlayerAiSync(((delayMs, options) => {
    // 未加载 = 快捷开关关闭态：按钮不存在，无需同步（start 自带初始 sync，
    // 开启后 reader 的同步请求自然恢复语义）。
    if (!isPlayerAiLoaded()) {
      return;
    }
    loadPlayerAi()
      .then((playerAi) => {
        const api = playerAi as unknown as PlayerAiApi;
        if (options && options.resetRetry) {
          api.resetPlayerAiQuickActionRetryCount();
        }
        api.schedulePlayerAiQuickActionSync(delayMs);
      })
      .catch((error) => {
        logWarn("[BOC] player-ai sync via lazy loader failed", error);
      });
  }) as PlayerAiSyncHandler);
  bindNormalPageStateGuard();
  // 播放器 AI 按钮的 layout 监听与 observer 改由 startPlayerAiQuickAction
  // 显式启动（见 getSettings().then 与 bindPlayerAiSettingsWatcher），
  // 默认关闭时不再无条件绑定。
  // URL 变化编排已搬到组合根（bindUrlChangeHandler）：监听 popstate/hashchange/
  // boc:urlchange 并按序编排；runtime.startUrlWatcher 由其内部调用，只负责
  // history 补丁与 boc:urlchange 广播。
  bindUrlChangeHandler();
  bindPlayerAiSettingsWatcher();
  // 快路径门控：按钮启停只依赖 enablePlayerAiQuickAction 单键。直连
  // chrome.storage.sync 读取（content 脚本本就有 storage 权限），绕开
  // getSettings 的 SW 往返——SW 冷启动唤醒是按钮出现慢的主因之一。读为
  // true 时先把该键同步进 state.settings（sync 门控读它，与
  // bindPlayerAiSettingsWatcher 同款写法）再启动；完整设置仍由下方
  // getSettings 水合覆盖，读失败静默回退到慢路径。
  chrome.storage.sync.get("enablePlayerAiQuickAction").then((data) => {
    if (Boolean((data as { enablePlayerAiQuickAction?: unknown })?.enablePlayerAiQuickAction)) {
      if (state.settings) {
        state.settings.enablePlayerAiQuickAction = true;
      }
      startPlayerAiQuickActionLazy();
    }
  }).catch(() => {});
  getSettings().then((settings) => {
    state.setSettings(settings);
    // 按设置显式启停：默认关闭（core/defaults.js enablePlayerAiQuickAction:
    // false）时不绑 layout 监听、不挂 observer，避免关闭态每帧空转 no-op。
    // 懒加载语义：开启才触发模块加载；关闭时模块未加载即无任何残留可清理，
    // 加载过（isPlayerAiLoaded）才需要走 stop 收尾。
    if (settings.enablePlayerAiQuickAction) {
      startPlayerAiQuickActionLazy();
    } else {
      stopPlayerAiQuickActionLazy();
    }
    if (shouldEnterReaderMode) {
      // 候选03：阅读模式直达链接才惰性装载 UI 壳 + reader 呈现层，再进入重域。
      // ensureUiReady 与 hydrate/apply 并发装载，壳构建完成后应用排版属性，
      // 最后 enterReaderMode（其内部会再次 hydrate/apply，保证状态最终一致）。
      ensureUiReady({ forceRecreate: true })
        .then(() => hydrateReaderStateFromSettings(settings))
        .then(() => applyReadingViewPresentation())
        .then(() => ensureReaderDomain())
        .then((reader) => reader.enterReaderMode())
        .catch((error) => {
          renderReadingStatus(`阅读视图启动失败：${getErrorMessage(error)}`);
        });
      // 阅读直达分支同样装载工具栏按钮模块（非阅读分支见下方 else）：装载不为
      // 按钮本身（阅读模式下自查守卫恒摘除），为视图失同步自愈与「关闭视图后
      // 补回按钮」——启动失败文案写进隐藏面板用户看不见，没有自查就真只剩刷新。
      loadDigestButton().catch((error) => {
        logWarn("[BOC] digest-button module load failed", error);
      });
    } else {
      // 统一 Digest 阅读模式 PR1：非阅读模式分支装载工具栏按钮模块。模块
      // 自管「等 hydration 稳定 → 自查注入/摘除 → 定时自查 + 失同步自愈」生命
      // 周期；阅读视图打开后由其自查守卫摘除按钮，无需在此 stop。
      loadDigestButton().catch((error) => {
        logWarn("[BOC] digest-button module load failed", error);
      });
    }
  });
}

// 播放器 AI 开关存放在 chrome.storage.sync：监听该键变更动态启停，设置切换
// 无需刷新页面即可生效。
function bindPlayerAiSettingsWatcher(): void {
  if (playerAiSettingsWatcherBound) {
    return;
  }
  playerAiSettingsWatcherBound = true;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") {
      return;
    }
    const change = changes["enablePlayerAiQuickAction"];
    if (!change) {
      return;
    }
    const enabled = Boolean(change.newValue);
    // syncPlayerAiQuickActionButton 读 state.settings，先同步该键再启停，
    // 不依赖 reader watcher（bindSettingsWatcher）的异步全量回读时序
    if (state.settings) {
      state.settings.enablePlayerAiQuickAction = enabled;
    }
    if (enabled) {
      startPlayerAiQuickActionLazy();
    } else {
      stopPlayerAiQuickActionLazy();
    }
  });
}

// ===== 懒加载边界 a（候选4 分包）：player-ai 的 start/stop 适配 =====
// 加载器语义：模块未加载时 stop/remove 都是 no-op（按钮只可能由该模块创建，
// 未加载 ⇒ 无残留），因此「关闭设置」分支只在已加载时才需要真正执行 stop。

function startPlayerAiQuickActionLazy(): void {
  loadPlayerAi()
    .then((playerAi) => {
      (playerAi as unknown as PlayerAiApi).startPlayerAiQuickAction();
    })
    .catch((error) => {
      logWarn("[BOC] player-ai module load failed (quick action not started)", error);
    });
}

function stopPlayerAiQuickActionLazy(): void {
  if (!isPlayerAiLoaded()) {
    return;
  }
  loadPlayerAi()
    .then((playerAi) => {
      (playerAi as unknown as PlayerAiApi).stopPlayerAiQuickAction();
    })
    .catch((error) => {
      logWarn("[BOC] player-ai stop after lazy load failed", error);
    });
}
