// 候选4 守卫批：player-ai 显式启停生命周期。
// - 设置关闭 → 不挂 observer、不绑 window layout 监听（默认 false 不启动）
// - 设置开启 → observer 启动、layout 监听挂上；start 幂等
// - stop → 宿主上的游标监听按同一引用摘除、retry 定时器清理、按钮移除
// - storage.onChanged 里 enablePlayerAiQuickAction true→false→true 正确启停
//
// chrome stub 采用内存实现（参照 tests/setup.js / tests/reader 模式）：
// runtime.sendMessage 回调同步返回 get-settings 结果，
// storage.onChanged 收集 listener 由 emitStorageChange 手动派发。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, setLocationUrl, NORMAL_PAGE_URL } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";

const storageChangeListeners = new Set();

// 当前用例的内存设置引用：stubChrome 写入，emitStorageChange 更新并派发。
let activeSettingsRef = null;

// 本用例期望的"当前设置"（与 DEFAULT_SETTINGS 合并后由
// get-settings 回读返回，模拟 background 的 normalizeSettings 兜底）。
// runtime.getURL 已由 setup.js 的通用 chrome stub 提供（S3 分层样式挂载用），
// 这里沿用；startPlayerAiQuickAction 会触发 ensurePlayerAiStyles 挂 link。
function stubChrome(settings) {
  activeSettingsRef = { current: { ...settings } };
  const runtime = {
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
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
      hasListener: vi.fn(() => false)
    }
  };
  vi.stubGlobal("chrome", { runtime, storage: {
      sync: {
        get: vi.fn(async () => ({ ...activeSettingsRef.current })),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {})
      },
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {})
      },
      onChanged: {
        addListener: vi.fn((listener) => {
          storageChangeListeners.add(listener);
        }),
        removeListener: vi.fn((listener) => {
          storageChangeListeners.delete(listener);
        })
      }
    }
  });
  return { runtime };
}

// 派发 storage 变更并同步内存中的"当前设置"，模拟真实 sync storage 的读写一致
// （reader watcher 的异步全量回读会拿到与 onChanged 相同的新值）。
function emitStorageChange(key, newValue) {
  activeSettingsRef.current = { ...activeSettingsRef.current, [key]: newValue };
  const changes = { [key]: { newValue } };
  for (const listener of [...storageChangeListeners]) {
    listener(changes, "sync");
  }
}

// content.js 顶层即执行 init()；getSettings().then 是微任务链（stub 回调同步），
// 穿透若干层微任务后设置即已应用。
//
// 候选4 分包：content.js 经 core/lazy-player-ai.js 动态加载 player-ai（默认
// 关闭的设置不再静态常驻），因此这里先 await 加载器 promise（单例缓存）把
// 模块预热到位，再穿透微任务让 start/stop 的 then 回调落地。
async function flushMicrotasks(times = 20) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function loadContentScript(settings) {
  setLocationUrl(NORMAL_PAGE_URL);
  // S3 分层：player-ai 模块顶层即挂样式 link（ensurePlayerAiStyles），
  // 挂载用的 runtime.getURL 引用与断言无关。
  stubChrome(settings);
  await import("../../extension/entry/content.js");
  // 预热懒加载的 player-ai 模块（loadPlayerAi 返回缓存的同一 promise）；
  // 模块加载本身不挂 observer/监听，不影响「设置关闭」用例的断言。
  const { loadPlayerAi } = await import("../../extension/core/lazy-player-ai.js");
  await loadPlayerAi();
  await flushMicrotasks();
  return (await import("../../extension/core/state.js")).state;
}

function makePlayerDom() {
  document.body.innerHTML = `
    <div class="bpx-player-container">
      <button type="button" aria-label="字幕" title="字幕">CC</button>
    </div>`;
  return document.querySelector(".bpx-player-container");
}

beforeEach(() => {
  storageChangeListeners.clear();
  resetModuleState();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("player-ai 启停守卫", () => {
  it("设置关闭 → 不挂 observer、不绑 window layout 监听", async () => {
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    const state = await loadContentScript({ enablePlayerAiQuickAction: false });

    expect(state.playerAi.playerAiQuickActionObserver).toBeNull();
    expect(state.playerAi.playerAiQuickActionLayoutBound).toBe(false);
    expect(windowAddSpy.mock.calls.some(([type]) => type === "resize")).toBe(false);
    expect(document.getElementById("boc-player-ai-quick-action")).toBeNull();
  });

  it("设置开启 → observe 被调、layout 监听挂上", async () => {
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    const documentAddSpy = vi.spyOn(document, "addEventListener");
    const state = await loadContentScript({ enablePlayerAiQuickAction: true });

    expect(state.playerAi.playerAiQuickActionObserver).not.toBeNull();
    expect(state.playerAi.playerAiQuickActionLayoutBound).toBe(true);
    expect(windowAddSpy.mock.calls.some(([type]) => type === "resize")).toBe(true);
    expect(windowAddSpy.mock.calls.some(([type]) => type === "pageshow")).toBe(true);
    expect(documentAddSpy.mock.calls.some(([type]) => type === "fullscreenchange")).toBe(true);
  });

  it("start 幂等：重复调用不重复绑 observer 与监听", async () => {
    const state = await loadContentScript({ enablePlayerAiQuickAction: true });
    // loadContentScript 的 preload 与这里的 import 为同一模块实例；vitest 对
    // 已加载模块的重复 import 返回缓存（诊断实测），此处拿真实命名空间（非
    // doMock 产物，后者的依赖图会被 doMock 的 import 拦截带偏）
    const { startPlayerAiQuickAction } = await import("../../extension/ai/player-ai.js");
    const observerBefore = state.playerAi.playerAiQuickActionObserver;
    const windowAddSpy = vi.spyOn(window, "addEventListener");

    startPlayerAiQuickAction();

    expect(state.playerAi.playerAiQuickActionObserver).toBe(observerBefore);
    expect(windowAddSpy.mock.calls.some(([type]) => type === "resize")).toBe(false);
  });

  it("stop → 宿主上的游标监听按同一引用摘除、按钮移除、layout 监听解绑", async () => {
    const host = makePlayerDom();
    // spy 必须在 import content.js（可能触发初始 sync）之前装上，
    // 否则初始挂载的游标绑定会逃过捕获
    const hostAddSpy = vi.spyOn(host, "addEventListener");
    const hostRemoveSpy = vi.spyOn(host, "removeEventListener");
    const state = await loadContentScript({ enablePlayerAiQuickAction: true });
    const { schedulePlayerAiQuickActionSync, stopPlayerAiQuickAction } = await import("../../extension/ai/player-ai.js");

    schedulePlayerAiQuickActionSync(0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const button = document.getElementById("boc-player-ai-quick-action");
    expect(button).not.toBeNull();
    const wrap = button.closest(".boc-player-ai-wrap");
    // 游标监听已绑：mousemove 应点亮按钮
    host.dispatchEvent(new MouseEvent("mousemove"));
    expect(wrap.classList.contains("is-active")).toBe(true);

    const cursorTypes = ["mousemove", "mouseenter", "mouseleave", "pointermove"];
    const cursorBinds = hostAddSpy.mock.calls.filter(([type]) => cursorTypes.includes(type));
    expect(cursorBinds.length).toBe(4);

    stopPlayerAiQuickAction();

    expect(document.getElementById("boc-player-ai-quick-action")).toBeNull();
    expect(document.querySelector(".boc-player-ai-wrap")).toBeNull();
    expect(state.playerAi.playerAiQuickActionObserver).toBeNull();
    expect(state.playerAi.playerAiQuickActionLayoutBound).toBe(false);
    // 4 个游标 handler 均以绑定时的同一引用被 removeEventListener 摘除
    for (const [type, handler] of cursorBinds) {
      expect(hostRemoveSpy.mock.calls.some(([t, h]) => t === type && h === handler)).toBe(true);
    }
  });

  it("游标监听防重挂守卫：同一 host 不重复绑", async () => {
    const host = makePlayerDom();
    const hostAddSpy = vi.spyOn(host, "addEventListener");
    const state = await loadContentScript({ enablePlayerAiQuickAction: true });
    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");

    schedulePlayerAiQuickActionSync(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.getElementById("boc-player-ai-quick-action")).not.toBeNull();

    // 再次 sync（按钮已挂载路径）：不应重复绑游标监听
    schedulePlayerAiQuickActionSync(0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const mousemoveBinds = hostAddSpy.mock.calls.filter(([type]) => type === "mousemove");
    expect(mousemoveBinds.length).toBe(1);
    expect(state.playerAi.playerAiQuickActionLayoutBound).toBe(true);
  });

  it("stop → retry 定时器清理，stop 后不再触发挂载", async () => {
    vi.useFakeTimers();
    // 只有容器、无字幕控件 → sync 挂载失败进入 retry 退避
    document.body.innerHTML = `<div class="bpx-player-container"></div>`;
    const state = await loadContentScript({ enablePlayerAiQuickAction: true });
    const { schedulePlayerAiQuickActionSync, stopPlayerAiQuickAction } = await import("../../extension/ai/player-ai.js");

    // 手动 sync 会 clear 掉 start 的初始 120ms 定时器并立即执行一次 sync
    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(1);

    // 挂载失败已进入 retry：sync 定时器为 260ms 退避定时器
    expect(document.getElementById("boc-player-ai-quick-action")).toBeNull();
    expect(state.playerAi.playerAiQuickActionSyncTimer).not.toBe(0);

    stopPlayerAiQuickAction();
    expect(state.playerAi.playerAiQuickActionSyncTimer).toBe(0);

    // 推进 3 秒：retry 定时器已清，不会再触发挂载
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.getElementById("boc-player-ai-quick-action")).toBeNull();
    expect(state.playerAi.playerAiQuickActionSyncTimer).toBe(0);
  });

  it("storage.onChanged：enablePlayerAiQuickAction true→false→true 正确启停", async () => {
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    const windowRemoveSpy = vi.spyOn(window, "removeEventListener");
    const state = await loadContentScript({ enablePlayerAiQuickAction: false });

    // 初始关闭：已 stop
    expect(state.playerAi.playerAiQuickActionObserver).toBeNull();
    expect(state.playerAi.playerAiQuickActionLayoutBound).toBe(false);

    // false → true：启动 observer 与监听，并同步 state.settings
    // （懒加载接线：start 经 loadPlayerAi().then 异步执行，先穿透微任务再断言）
    emitStorageChange("enablePlayerAiQuickAction", true);
    await flushMicrotasks();
    expect(state.settings.enablePlayerAiQuickAction).toBe(true);
    expect(state.playerAi.playerAiQuickActionObserver).not.toBeNull();
    expect(state.playerAi.playerAiQuickActionLayoutBound).toBe(true);
    const resizeBinds = windowAddSpy.mock.calls.filter(([type]) => type === "resize");
    expect(resizeBinds.length).toBe(1);

    // true → false：observer 断开、layout 监听按同一引用摘除
    emitStorageChange("enablePlayerAiQuickAction", false);
    await flushMicrotasks();
    expect(state.settings.enablePlayerAiQuickAction).toBe(false);
    expect(state.playerAi.playerAiQuickActionObserver).toBeNull();
    expect(state.playerAi.playerAiQuickActionLayoutBound).toBe(false);
    const [, resizeHandler] = resizeBinds[0];
    expect(
      windowRemoveSpy.mock.calls.some(([type, handler]) => type === "resize" && handler === resizeHandler)
    ).toBe(true);

    // false → true：再次启动
    emitStorageChange("enablePlayerAiQuickAction", true);
    await flushMicrotasks();
    expect(state.playerAi.playerAiQuickActionObserver).not.toBeNull();
    expect(state.playerAi.playerAiQuickActionLayoutBound).toBe(true);
    expect(windowAddSpy.mock.calls.filter(([type]) => type === "resize").length).toBe(2);
  });
});
