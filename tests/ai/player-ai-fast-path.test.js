// 候选3 常驻瘦身：AI 按钮快路径不等待 UI 壳 / reader 呈现层装载。
//
// content.js 的 storage.sync 快路径（enablePlayerAiQuickAction）与
// startPlayerAiQuickActionLazy 链路必须在 getSettings 回包前启动 player-ai，
// 且不能触发 ensureUiReady / hydrateReaderStateFromSettings /
// applyReadingViewPresentation 的惰性装载。本测试把这三个惰性装载器 mock
// 为永不 resolve 的 promise，验证 player-ai 仍能在普通页正常启动。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, setLocationUrl, NORMAL_PAGE_URL } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
// playerAiState 须按用例动态获取：beforeEach 的 vi.resetModules() 会换模块
// 纪元，静态 import 拿到的实例与生产代码（动态 import 加载）不是同一对象。
let playerAiState = null;
async function getPlayerAiState() {
  playerAiState = (await import("../../extension/ai/player-ai-state.js")).playerAiState;
  return playerAiState;
}

// 候选03：把惰性 UI 壳与 reader 呈现层 mock 为永不 resolve。若 AI 快路径依赖
// 它们，player-ai 启动就会挂死。
vi.mock("../../extension/core/lazy-ui.js", () => ({
  ensureUiReady: vi.fn(() => new Promise(() => {}))
}));
vi.mock("../../extension/core/lazy-reader-presentation.js", () => ({
  hydrateReaderStateFromSettings: vi.fn(() => new Promise(() => {})),
  applyReadingViewPresentation: vi.fn(() => new Promise(() => {})),
  renderReadingStatus: vi.fn(() => new Promise(() => {}))
}));

import { ensureUiReady } from "../../extension/core/lazy-ui.js";
import {
  hydrateReaderStateFromSettings,
  applyReadingViewPresentation,
  renderReadingStatus
} from "../../extension/core/lazy-reader-presentation.js";

const storageChangeListeners = new Set();
let activeSettingsRef = null;

function stubChrome(settings) {
  activeSettingsRef = { current: { ...settings } };
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: vi.fn((path) => `chrome-extension://test/${path}`),
      lastError: null,
      sendMessage: vi.fn((message, callback) => {
        if (message?.type === "get-settings") {
          callback?.({
            ok: true,
            settings: { ...DEFAULT_SETTINGS, ...activeSettingsRef.current }
          });
        } else {
          callback?.({ ok: true });
        }
        return undefined;
      }),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(() => false) }
    },
    storage: {
      sync: {
        get: vi.fn(async () => ({ ...activeSettingsRef.current })),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {})
      },
      onChanged: {
        addListener: vi.fn((listener) => storageChangeListeners.add(listener)),
        removeListener: vi.fn((listener) => storageChangeListeners.delete(listener))
      }
    }
  });
}

async function flushMicrotasks(times = 20) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  storageChangeListeners.clear();
  resetModuleState();
  ensureUiReady.mockClear();
  hydrateReaderStateFromSettings.mockClear();
  applyReadingViewPresentation.mockClear();
  renderReadingStatus.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("player-ai 快路径与惰性装载解耦", () => {
  it("普通页 + 开关开启：observer/layout 启动，不触发 UI 壳 / reader 呈现层装载", async () => {
    setLocationUrl(NORMAL_PAGE_URL);
    stubChrome({ enablePlayerAiQuickAction: true });

    await import("../../extension/entry/content.js");
    const { loadPlayerAi } = await import("../../extension/core/lazy-player-ai.js");
    await loadPlayerAi();
    await flushMicrotasks();
    const state = (await import("../../extension/core/state.js")).state;
    await getPlayerAiState();

    expect(state.settings.enablePlayerAiQuickAction).toBe(true);
    expect(playerAiState.playerAiQuickActionObserver).not.toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(true);

    // 红线：AI 按钮快路径不等待 ui-renderer / reader 呈现层。
    expect(ensureUiReady).not.toHaveBeenCalled();
    expect(hydrateReaderStateFromSettings).not.toHaveBeenCalled();
    expect(applyReadingViewPresentation).not.toHaveBeenCalled();
    expect(renderReadingStatus).not.toHaveBeenCalled();
  });

  it("storage.onChanged false→true：同样不触发惰性 UI / reader 装载", async () => {
    setLocationUrl(NORMAL_PAGE_URL);
    stubChrome({ enablePlayerAiQuickAction: false });

    await import("../../extension/entry/content.js");
    const { loadPlayerAi } = await import("../../extension/core/lazy-player-ai.js");
    await flushMicrotasks();

    // content.js 注册了两个 storage 监听：bindSettingsWatcher（0）与
    // bindPlayerAiSettingsWatcher（1）。后者才是启停 player-ai 的监听。
    const listener = chrome.storage.onChanged.addListener.mock.calls[1][0];
    activeSettingsRef.current = { ...activeSettingsRef.current, enablePlayerAiQuickAction: true };
    listener({ enablePlayerAiQuickAction: { newValue: true } }, "sync");

    await loadPlayerAi();
    await flushMicrotasks(40);
    const state = (await import("../../extension/core/state.js")).state;
    await getPlayerAiState();

    expect(state.settings.enablePlayerAiQuickAction).toBe(true);
    expect(playerAiState.playerAiQuickActionObserver).not.toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(true);

    expect(ensureUiReady).not.toHaveBeenCalled();
    expect(hydrateReaderStateFromSettings).not.toHaveBeenCalled();
    expect(applyReadingViewPresentation).not.toHaveBeenCalled();
    expect(renderReadingStatus).not.toHaveBeenCalled();
  });
});
