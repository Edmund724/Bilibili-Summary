// 设置变更测试：主题 / 字体 / 内容宽度 / 行距 / 字距等
// 通过 hydrateReaderStateFromSettings 与 updateReaderPreferences 驱动，
// 校验 data-attribute 在阅读视图、documentElement、body 三处的应用。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState, ChromeRuntimeStub } from "./reader-test-env.js";

let state: TestState;
let shell: typeof import("../../extension/reader/index.js");
let presenter: typeof import("../../extension/reader/presenter.js");
let chromeStub: ChromeRuntimeStub;

async function loadReaderModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  presenter = await import("../../extension/reader/presenter.js");
  shell = await import("../../extension/reader/index.js");
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

function makeStepper(node: HTMLElement) {
  // 与 buildReaderStepperControl 生成的按钮结构一致
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "boc-reading-stepper-btn";
  btn.dataset.value = "l";
  node.appendChild(btn);
}

// 给 4 个 stepper 控件各补一个按钮，让 renderReaderPanels 的
// renderReaderStepperState 有可操作节点。
function seedStepperButtons() {
  [
    shell.ids.readingFontScaleSelect,
    shell.ids.readingLetterSpacingSelect,
    shell.ids.readingLineHeightSelect,
    shell.ids.readingContentWidthSelect
  ].forEach((id) => {
    const node = document.getElementById(id);
    if (node) {
      makeStepper(node);
    }
  });
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadReaderModules();
  mountReaderSkeleton(shell.ids);
  seedStepperButtons();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("设置变更与 data-attribute", () => {
  it("hydrateReaderStateFromSettings：应用主题/字体/宽度等设置", () => {
    shell.hydrateReaderStateFromSettings({
      readerTheme: "dark",
      readerFontScale: "xl",
      readerLetterSpacing: "loose",
      readerLineHeight: "relaxed",
      readerContentWidth: "full",
      readerChapterVisible: false,
      readerTranscriptVisible: true
    });

    expect(state.reader.readingTheme).toBe("dark");
    expect(state.reader.readingFontScale).toBe("xl");
    expect(state.reader.readingLetterSpacing).toBe("loose");
    expect(state.reader.readingLineHeight).toBe("relaxed");
    expect(state.reader.readingContentWidth).toBe("full");
    expect(state.reader.readingChapterVisible).toBe(false);
    expect(state.reader.readingTranscriptVisible).toBe(true);
  });

  it("applyReadingViewPresentation：在视图/html/body 三处写 data-attribute", () => {
    shell.hydrateReaderStateFromSettings({
      readerTheme: "paper",
      readerFontScale: "l",
      readerLetterSpacing: "tight",
      readerLineHeight: "normal",
      readerContentWidth: "wide",
      readerChapterVisible: true,
      readerTranscriptVisible: true
    });
    shell.applyReadingViewPresentation();

    const readingView = document.getElementById(shell.ids.readingView) as HTMLElement;
    const htmlEl = document.documentElement;
    const bodyEl = document.body;

    const expected = {
      theme: "paper",
      fontScale: "l",
      letterSpacing: "tight",
      lineHeight: "normal",
      contentWidth: "wide",
      chapterVisibility: "auto",
      transcriptVisible: "1"
    };

    expect(readingView.dataset.theme).toBe(expected.theme);
    expect(readingView.dataset.fontScale).toBe(expected.fontScale);
    expect(readingView.dataset.letterSpacing).toBe(expected.letterSpacing);
    expect(readingView.dataset.lineHeight).toBe(expected.lineHeight);
    expect(readingView.dataset.contentWidth).toBe(expected.contentWidth);
    expect(readingView.dataset.chapterVisibility).toBe(expected.chapterVisibility);
    expect(readingView.dataset.transcriptVisible).toBe(expected.transcriptVisible);

    expect(htmlEl.dataset.bocReaderTheme).toBe(expected.theme);
    expect(htmlEl.dataset.bocReaderFontScale).toBe(expected.fontScale);
    expect(htmlEl.dataset.bocReaderContentWidth).toBe(expected.contentWidth);
    expect(htmlEl.dataset.bocReaderChapterVisibility).toBe(expected.chapterVisibility);

    expect(bodyEl.dataset.bocReaderTheme).toBe(expected.theme);
    expect(bodyEl.dataset.bocReaderFontScale).toBe(expected.fontScale);
    expect(bodyEl.dataset.bocReaderContentWidth).toBe(expected.contentWidth);
  });

  it("updateReaderPreferences：变更宽度/字体并持久化到 chrome.runtime", () => {
    shell.updateReaderPreferences({ readerFontScale: "xs", readerContentWidth: "narrow" }, { persist: true });

    expect(state.reader.readingFontScale).toBe("xs");
    expect(state.reader.readingContentWidth).toBe("narrow");

    const readingView = document.getElementById(shell.ids.readingView) as HTMLElement;
    expect(readingView.dataset.fontScale).toBe("xs");
    expect(readingView.dataset.contentWidth).toBe("narrow");
    expect(document.documentElement.dataset.bocReaderFontScale).toBe("xs");
    expect(document.body.dataset.bocReaderContentWidth).toBe("narrow");

    expect(chromeStub.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "save-settings" }),
      expect.any(Function)
    );
  });

  it("updateReaderPreferences：非法值被归一化", () => {
    shell.updateReaderPreferences(
      { readerFontScale: "huge", readerContentWidth: "ultra", readerTheme: "neon" },
      { persist: false }
    );

    expect(state.reader.readingFontScale).toBe("m");
    expect(state.reader.readingContentWidth).toBe("medium");
    expect(state.reader.readingTheme).toBe("light");
  });

  it("settings 变更监听：chrome.storage.onChanged 触发时刷新设置", async () => {
    // bindSettingsWatcher 在 chrome.storage.onChanged 存在时绑定
    shell.bindSettingsWatcher();
    expect(state.ui.settingsWatcherBound).toBe(true);
    expect(chromeStub.storage.onChanged.addListener).toHaveBeenCalled();
  });

  it("settings 变更后：storage.onChanged 回调应用新主题", async () => {
    shell.bindSettingsWatcher();
    const listener = chromeStub.storage.onChanged.addListener.mock.calls[0][0];

    // 让 getSettings 返回指定设置（shell.js 内部经 runtime.getSettings -> chrome.runtime.sendMessage）
    chromeStub.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message?.type === "get-settings") {
        callback?.({
          ok: true,
          settings: {
            readerTheme: "dark",
            readerFontScale: "m",
            readerLetterSpacing: "normal",
            readerLineHeight: "tight",
            readerContentWidth: "medium",
            readerChapterVisible: true,
            readerTranscriptVisible: true
          }
        });
        return undefined;
      }
      callback?.({ ok: true });
      return undefined;
    });

    listener(
      { readerTheme: { newValue: "dark" } },
      "sync"
    );
    await vi.waitFor(() => {
      expect(state.reader.readingTheme).toBe("dark");
    });

    const readingView = document.getElementById(shell.ids.readingView) as HTMLElement;
    expect(readingView.dataset.theme).toBe("dark");
  });
});
