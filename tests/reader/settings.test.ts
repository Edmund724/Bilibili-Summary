// 设置变更测试：主题 / 章节与字幕可见性
// 通过 hydrateReaderStateFromSettings 与 updateReaderPreferences 驱动，
// 校验 data-attribute 在阅读视图、documentElement、body 三处的应用。
//（digest-only-ui：排版档位机制退役，字号/字距/行距/面板宽度不再可调，
// 相关字段与 data-attribute 一并移除。）

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState, ChromeRuntimeStub } from "./reader-test-env.js";

let state: TestState;
let presentation: typeof import("../../extension/reader/presentation.js");
let lifecycle: typeof import("../../extension/reader/index.js");
let initEssentials: typeof import("../../extension/reader/init-essentials.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let presenter: typeof import("../../extension/reader/presenter.js");
let chromeStub: ChromeRuntimeStub;

async function loadReaderModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  presenter = await import("../../extension/reader/presenter.js");
  presentation = await import("../../extension/reader/presentation.js");
  initEssentials = await import("../../extension/reader/init-essentials.js");
  lifecycle = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
  chromeStub = globalThis.chrome as unknown as ChromeRuntimeStub;
  // 模拟 content.js 的接线：reader-impl 经 presenter seam 持久化/读取设置，
  // 底层仍是 chrome.runtime.sendMessage（tests/setup.js 的 stub）。
  presenter.subscribeReaderSettingsPersist(() => {
    chromeStub.runtime.sendMessage(
      { type: "save-settings", settings: state.settings },
      () => {}
    );
  });
  presenter.subscribeReaderSettingsLoad(() =>
    new Promise<Record<string, unknown>>((resolve) => {
      chromeStub.runtime.sendMessage({ type: "get-settings" }, (resp: { ok: boolean; settings?: Record<string, unknown> }) => {
        resolve(resp?.ok ? { ...(resp.settings || {}) } : {});
      });
    })
  );
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadReaderModules();
  mountReaderSkeleton(ids);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("设置变更与 data-attribute", () => {
  it("hydrateReaderStateFromSettings：应用主题/章节与字幕可见性设置", () => {
    presentation.hydrateReaderStateFromSettings({
      readerTheme: "dark",
      readerChapterVisible: false,
      readerTranscriptVisible: true
    });

    expect(state.reader.readingTheme).toBe("dark");
    expect(state.reader.readingChapterVisible).toBe(false);
    expect(state.reader.readingSubtitleVisible).toBe(true);
  });

  it("applyReadingViewPresentation：在视图/html/body 三处写 data-attribute", () => {
    presentation.hydrateReaderStateFromSettings({
      readerTheme: "paper",
      readerChapterVisible: true,
      readerTranscriptVisible: true
    });
    presentation.applyReadingViewPresentation();

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    const htmlEl = document.documentElement;
    const bodyEl = document.body;

    const expected = {
      theme: "paper",
      chapterVisibility: "auto",
      subtitleVisible: "1"
    };

    expect(readingView.dataset.theme).toBe(expected.theme);
    expect(readingView.dataset.chapterVisibility).toBe(expected.chapterVisibility);
    expect(readingView.dataset.subtitleVisible).toBe(expected.subtitleVisible);

    expect(htmlEl.dataset.bocReaderTheme).toBe(expected.theme);
    expect(htmlEl.dataset.bocReaderChapterVisibility).toBe(expected.chapterVisibility);

    expect(bodyEl.dataset.bocReaderTheme).toBe(expected.theme);
  });

  it("updateReaderPreferences：变更主题/可见性并持久化到 chrome.runtime", () => {
    lifecycle.updateReaderPreferences({ readerTheme: "dark", readerChapterVisible: false }, { persist: true });

    expect(state.reader.readingTheme).toBe("dark");
    expect(state.reader.readingChapterVisible).toBe(false);

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    expect(readingView.dataset.theme).toBe("dark");
    expect(readingView.dataset.chapterVisibility).toBe("hide");

    expect(chromeStub.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "save-settings" }),
      expect.any(Function)
    );
  });

  it("updateReaderPreferences：非法主题被归一化", () => {
    lifecycle.updateReaderPreferences(
      { readerTheme: "neon" },
      { persist: false }
    );

    expect(state.reader.readingTheme).toBe("light");
  });

  it("settings 变更监听：chrome.storage.onChanged 触发时刷新设置", async () => {
    // bindSettingsWatcher 在 chrome.storage.onChanged 存在时绑定
    initEssentials.bindSettingsWatcher();
    expect(state.ui.settingsWatcherBound).toBe(true);
    expect(chromeStub.storage.onChanged.addListener).toHaveBeenCalled();
  });

  it("settings 变更后：storage.onChanged 回调应用新主题", async () => {
    initEssentials.bindSettingsWatcher();
    const listener = chromeStub.storage.onChanged.addListener.mock.calls[0][0];

    // 让 getSettings 返回指定设置（init-essentials.js 内部经 runtime.getSettings -> chrome.runtime.sendMessage）
    chromeStub.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message?.type === "get-settings") {
        callback?.({
          ok: true,
          settings: {
            readerTheme: "dark",
            readerChapterVisible: true,
            readerTranscriptVisible: true
          }
        });
        return undefined;
      }
      callback?.({ ok: true });
      return undefined;
    });

    // 候选03：设置变更只在阅读视图打开时才应用呈现层。
    state.reader.setViewOpen(true);

    listener(
      { readerTheme: { newValue: "dark" } },
      "sync"
    );
    await vi.waitFor(() => {
      expect(state.reader.readingTheme).toBe("dark");
    });

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    await vi.waitFor(() => {
      expect(readingView.dataset.theme).toBe("dark");
    });
  });
});
