// PR3 字幕 tab「复制 / 导出」接线回归测试（真实模板 + 真实事件绑定）。
//
// 语义：复制 = 字幕纯文本（transcript，buildTxt 管线，copySubtitleTranscript）；
// 导出 = SRT/TXT（downloadSubtitle，按 downloadFormat 设置，默认 srt）。
// 逻辑全部在总结链（subtitle/ui.js），按钮经 ensureSummarizeChain 装载后调用，
// 反馈走 setMessage（digest-only-ui：宿主收敛到 #boc-reading-status）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import type { TestState } from "../reader/reader-test-env.js";

let state: TestState;
let ids: typeof import("../../extension/reader/state.js").ids;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");

let clipboardWriteText: ReturnType<typeof vi.fn>;
let clickedAnchor: HTMLAnchorElement | null = null;
let originalCreateObjectURL: unknown;
let originalRevokeObjectURL: unknown;

async function loadModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  ids = (await import("../../extension/reader/state.js")).ids;
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
}

// 单次 click 派发：测试环境 HTMLElement.prototype.click 被 patch 成
// 「jsdom 原生 + 手动 dispatch」双次派发，会让一次性反馈被第二次成功执行覆盖。
function dispatchClick(elementId: string) {
  (document.getElementById(elementId) as HTMLElement).dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true })
  );
}

// digest-only-ui：A 形态 message 节点已删除，反馈收敛到 #boc-reading-status
function messageText(): string {
  return (document.getElementById(ids.readingStatus) as HTMLElement).textContent || "";
}

function seedSubtitleBody() {
  state.clip.subtitleBody = [
    { from: 0, to: 10, content: "第一句话" },
    { from: 10, to: 30, content: "第二句话" }
  ];
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadModules();
  uiRenderer.ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
  seedSubtitleBody();

  clipboardWriteText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardWriteText },
    configurable: true
  });
  // 截获下载锚点的 click（jsdom 不实现下载导航），断言 download 文件名
  clickedAnchor = null;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clickedAnchor = this;
  });
  // 只替换 URL 的静态方法、保留 URL 构造器本体——整对象 stubGlobal 会把
  // new URL(...) 一起换掉，链路装载/取设置路径里任何 URL 构造都会崩。
  originalCreateObjectURL = (URL as unknown as Record<string, unknown>).createObjectURL;
  originalRevokeObjectURL = (URL as unknown as Record<string, unknown>).revokeObjectURL;
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:mock-subtitle");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
});

afterEach(() => {
  (URL as unknown as Record<string, unknown>).createObjectURL = originalCreateObjectURL;
  (URL as unknown as Record<string, unknown>).revokeObjectURL = originalRevokeObjectURL;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("字幕 tab 复制 / 导出（真实绑定，经 ensureSummarizeChain）", () => {
  it("点击「复制」：剪贴板写入字幕纯文本（含时间戳），反馈「字幕已复制到剪贴板」", async () => {
    dispatchClick(ids.readingCopySubtitleBtn);

    await vi.waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(1));
    const copied = String(clipboardWriteText.mock.calls[0][0]);
    // transcript 语义：含每句文本；includeTimestampInBody 默认 true → 带紧凑时间戳
    expect(copied).toContain("第一句话");
    expect(copied).toContain("第二句话");
    expect(copied).toContain("00:00");
    expect(copied).toContain("00:10");

    await vi.waitFor(() => expect(messageText()).toBe("字幕已复制到剪贴板。"));
  });

  it("无字幕时复制：反馈「没有可复制的字幕」，不写剪贴板", async () => {
    state.clip.subtitleBody = [];
    dispatchClick(ids.readingCopySubtitleBtn);

    await vi.waitFor(() => expect(messageText()).toBe("没有可复制的字幕，请先刷新抓取。"));
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  it("复制失败（剪贴板拒绝写入）：反馈「复制失败：…」", async () => {
    clipboardWriteText.mockRejectedValueOnce(new Error("denied"));
    dispatchClick(ids.readingCopySubtitleBtn);

    await vi.waitFor(() => expect(messageText()).toContain("复制失败"));
    expect(messageText()).toContain("denied");
  });

  it("点击「导出」：按默认 srt 格式触发下载并反馈文件名", async () => {
    dispatchClick(ids.readingExportSubtitleBtn);

    await vi.waitFor(() => expect(clickedAnchor).not.toBe(null));
    expect((clickedAnchor as HTMLAnchorElement | null)!.download.endsWith(".srt")).toBe(true);
    await vi.waitFor(() => expect(messageText()).toContain("已下载"));
  });

  it("无字幕时导出：反馈「没有可下载的字幕」，不触发下载", async () => {
    state.clip.subtitleBody = [];
    dispatchClick(ids.readingExportSubtitleBtn);

    await vi.waitFor(() => expect(messageText()).toBe("没有可下载的字幕，请先刷新抓取。"));
    expect(clickedAnchor).toBe(null);
  });
});
