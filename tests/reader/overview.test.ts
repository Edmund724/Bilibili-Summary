// PR4 概览 tab 回归测试：状态机（reader/overview.js）+ 渲染 + 点击 seek +
// partial 重试 + 无字幕空态 + 笔记一节 + closeReadingView 清理。
//
// 手法（对齐 tests/reader 现有套路）：
//   - 真实模板/骨架（mountReaderSkeleton 补 PR4 概览渲染宿主）+ 真实状态机；
//   - vi.mock 掉 ai/analysis.js 的 runOverviewAnalysis（数据管线 PR4a 本体，
//     已有独立测试；这里只测接线与状态机迁移），其余导出（buildSubtitleSignature
//     等签名守卫用）保留真实实现；
//   - provider 解析链（get-settings / ai-providers-list / get-ai-provider-key）
//     与笔记存储（会话 + 段缓存）经 chrome stub 的 sendMessage/storage.get 注入。

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { READER_MODE_URL, makeSubtitleBody, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { OverviewAnalysis } from "../../extension/ai/analysis.js";
import type { TestState } from "./reader-test-env.d.ts";

// 数据管线 mock：runOverviewAnalysis 换成 vi.fn（每次用例自行给实现），
// resetModules 不清 mock 注册表，跨用例稳定。
vi.mock("../../extension/ai/analysis.js", async (importActual) => {
  const actual = await importActual<typeof import("../../extension/ai/analysis.js")>();
  return { ...actual, runOverviewAnalysis: vi.fn() };
});

let state: TestState;
let reader: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let statusBus: typeof import("../../extension/shared/subtitle-status-bus.js");
let runOverviewMock: Mock;

interface ChromeStub {
  runtime: { sendMessage: Mock };
  storage: { local: { get: Mock; set: Mock; remove: Mock } };
}

function chromeStub(): ChromeStub {
  return globalThis.chrome as unknown as ChromeStub;
}

async function loadModules() {
  setLocationUrl(READER_MODE_URL);
  statusBus = await import("../../extension/shared/subtitle-status-bus.js");
  state = (await import("../../extension/core/state.js")).state as TestState;
  reader = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
  const analysis = await import("../../extension/ai/analysis.js");
  runOverviewMock = vi.mocked(analysis.runOverviewAnalysis);
}

// provider 解析链与笔记生成引导消息的统一响应 stub（默认全通；extra 可对
// 特定消息类型给出覆盖响应，返回 undefined 则落回默认分支）。
function stubRuntimeMessages(extra?: (message: Record<string, unknown>) => unknown | undefined) {
  chromeStub().runtime.sendMessage.mockImplementation((message: Record<string, unknown>, callback?: (resp: unknown) => void) => {
    const respond = (resp: unknown) => {
      callback?.(resp);
      return undefined;
    };
    if (extra) {
      const overridden = extra(message);
      if (overridden !== undefined) {
        return respond(overridden);
      }
    }
    switch (message?.type) {
      case "get-settings":
        return respond({ ok: true, settings: { defaultModel: "prov-1" } });
      case "ai-providers-list":
        return respond({
          ok: true,
          providers: [{ id: "prov-1", name: "测试平台", baseUrl: "https://api.test/v1", model: "test-model", enabled: true }]
        });
      case "get-ai-provider-key":
        return respond({ ok: true, apiKey: "sk-test" });
      default:
        return respond({ ok: true });
    }
  });
}

const SAMPLE_ANALYSIS: OverviewAnalysis = {
  summary: "全片讲了测试驱动开发的三个误区。",
  chapters: [
    { from: 0, to: 120, title: "开场", summary: "为什么测试难写" },
    { from: 120, to: 300, title: "误区一", summary: " mocking 一切" }
  ],
  quotes: [
    { from: 125, content: "测试不是目的，而是反馈。" }
  ]
};

function overviewBody(): HTMLElement {
  return document.getElementById(ids.readingOverviewBody) as HTMLElement;
}

function overviewText(): string {
  return overviewBody().textContent || "";
}

// 概览渲染宿主上的手动委托（真实接线在 bindUiEvents，这里等价绑定以验证
// closest 委托与 data-seconds/data-overview-action 分流）。
function bindOverviewDelegation() {
  overviewBody().addEventListener("click", (event) => {
    reader.onReadingOverviewClick(event as MouseEvent);
  });
}

function seedClip({ chapters = [] as unknown[] } = {}) {
  state.clip.bvid = "BV1test000000";
  state.clip.cid = "1000";
  state.clip.title = "测试视频";
  state.clip.author = "作者";
  state.clip.description = "视频简介";
  state.clip.videoDuration = 300;
  state.clip.selectedSubtitleId = "sub-1";
  state.clip.selectedSubtitleUrl = "https://subtitle.test/1";
  state.clip.selectedSubtitleLang = "中文（自动）";
  state.clip.subtitleBody = [
    { from: 0, to: 10, content: "大家好" },
    { from: 10, to: 300, content: "今天讲测试" }
  ];
  state.clip.chapters = chapters as TestState["clip"]["chapters"];
  state.reader.readingViewOpen = true;
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadModules();
  mountReaderSkeleton(ids);
  mountPlayerChain();
  // storage.get 每用例显式归位（clearMocks 不清实现，防用例间串数据）
  chromeStub().storage.local.get.mockImplementation(async () => ({}));
  stubRuntimeMessages();
});

afterEach(() => {
  document.body.innerHTML = "";
  statusBus.publishSubtitleStatusPhase("idle");
  vi.restoreAllMocks();
});

describe("概览状态机与触发", () => {
  it("无字幕：不触发生成，展示诚实空态（转写中给出预期文案）", async () => {
    seedClip();
    state.clip.subtitleBody = [];

    await reader.triggerReaderOverviewGeneration();

    expect(runOverviewMock).not.toHaveBeenCalled();
    expect(overviewText()).toContain("该视频没有可用字幕");

    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    reader.renderReadingOverview();
    expect(overviewText()).toContain("概览等字幕就绪后自动生成");
  });

  it("idle 触发 → 生成 → ready 渲染：总结/章节/金句 + 上下文与 provider 入参正确", async () => {
    seedClip();
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);

    await reader.triggerReaderOverviewGeneration();

    expect(runOverviewMock).toHaveBeenCalledTimes(1);
    const args = runOverviewMock.mock.calls[0][0] as {
      provider: { apiKey?: string; baseUrl?: string; model?: string };
      context: Record<string, unknown>;
      forceRefresh?: boolean;
    };
    expect(args.provider).toEqual({ baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "test-model" });
    expect(args.forceRefresh).toBe(false);
    expect(args.context.bvid).toBe("BV1test000000");
    expect(args.context.selectedSubtitleId).toBe("sub-1");
    expect(Array.isArray(args.context.subtitleBody)).toBe(true);

    const text = overviewText();
    expect(text).toContain("总结");
    expect(text).toContain("全片讲了测试驱动开发的三个误区。");
    expect(text).toContain("开场");
    expect(text).toContain("为什么测试难写");
    expect(text).toContain("金句");
    expect(text).toContain("测试不是目的，而是反馈。");
    // 章节与金句都是可点击跳播目标
    expect(overviewBody().querySelectorAll(".boc-reading-ov-chapter").length).toBe(2);
    expect(overviewBody().querySelectorAll(".boc-reading-ov-quote").length).toBe(1);
  });

  it("生成中重复触发：复用进行中 promise，管线只发起一次；落定后 ready", async () => {
    seedClip();
    let resolveRun!: (value: OverviewAnalysis) => void;
    runOverviewMock.mockImplementation(
      () => new Promise<OverviewAnalysis>((resolve) => {
        resolveRun = resolve;
      })
    );

    const first = reader.triggerReaderOverviewGeneration();
    // provider 解析链（3 跳消息）是异步的：先等管线真正发起
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));

    const second = reader.triggerReaderOverviewGeneration();
    expect(second).toBe(first);
    expect(runOverviewMock).toHaveBeenCalledTimes(1);
    // 生成中：状态条 + 进度文案，无结果区
    expect(overviewText()).toContain("正在生成概览");

    resolveRun({ ...SAMPLE_ANALYSIS });
    await first;
    expect(overviewText()).toContain("全片讲了测试驱动开发的三个误区。");

    // 已 ready 再触发：不重跑（缓存语义由管线负责，状态机直接短路）
    await reader.triggerReaderOverviewGeneration();
    expect(runOverviewMock).toHaveBeenCalledTimes(1);
  });

  it("分段进度文案（onProgress 注入）渲染进生成中状态条", async () => {
    seedClip();
    let resolveRun!: (value: OverviewAnalysis) => void;
    runOverviewMock.mockImplementation(
      (_args, deps?: { onProgress?: (notice: string) => void }) => {
        deps?.onProgress?.("正在整理第 2/3 段（67%）");
        return new Promise<OverviewAnalysis>((resolve) => {
          resolveRun = resolve;
        });
      }
    );

    const run = reader.triggerReaderOverviewGeneration();
    await vi.waitFor(() => expect(overviewText()).toContain("正在整理第 2/3 段（67%）"));

    resolveRun({ ...SAMPLE_ANALYSIS });
    await run;
    expect(overviewText()).toContain("全片讲了测试驱动开发的三个误区。");
  });

  it("AI 分章（稿件章节为空）章节标头带「AI 生成」标注；自带章节不标", async () => {
    seedClip();
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);
    await reader.triggerReaderOverviewGeneration();
    const sectionHead = overviewBody().querySelector(".boc-reading-ov-h")?.parentElement?.textContent || "";
    // AI 分章：章节标头带标注；金句标头恒带「AI 精选」
    expect(overviewText()).toContain("AI 生成");
    expect(overviewText()).toContain("AI 精选");
    expect(sectionHead).toBeDefined();

    // 自带章节（短路径）：重开生成后不标「AI 生成」
    seedClip({ chapters: [{ title: "自带章节", from: 0 }] });
    runOverviewMock.mockClear();
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);
    await reader.triggerReaderOverviewGeneration();
    expect(runOverviewMock).toHaveBeenCalledTimes(1);
    const headings = Array.from(overviewBody().querySelectorAll(".boc-reading-ov-h")).map((node) => node.textContent || "");
    expect(headings.some((heading) => heading.includes("章节") && !heading.includes("AI 生成"))).toBe(true);
    expect(headings.some((heading) => heading.includes("金句") && heading.includes("AI 精选"))).toBe(true);
  });

  it("partial：失败区间标记条 + 重试失败区间按钮（forceRefresh 重跑）", async () => {
    seedClip();
    runOverviewMock.mockResolvedValue({
      ...SAMPLE_ANALYSIS,
      failedRanges: [{ from: 120, to: 300 }]
    });

    await reader.triggerReaderOverviewGeneration();
    expect(overviewText()).toContain("1 个分段生成失败");
    // 部分结果照常展示
    expect(overviewText()).toContain("全片讲了测试驱动开发的三个误区。");

    runOverviewMock.mockClear();
    runOverviewMock.mockResolvedValue({ ...SAMPLE_ANALYSIS });
    const retryBtn = overviewBody().querySelector<HTMLButtonElement>("button[data-overview-action='retry-failed']");
    expect(retryBtn).not.toBe(null);
    bindOverviewDelegation();
    retryBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    expect((runOverviewMock.mock.calls[0][0] as { forceRefresh?: boolean }).forceRefresh).toBe(true);
    await vi.waitFor(() => expect(overviewText()).not.toContain("个分段生成失败"));
  });

  it("error：错误条带原因 + 重试按钮；error 态切 tab 不自动重跑", async () => {
    seedClip();
    runOverviewMock.mockRejectedValue(new Error("模型请求失败"));

    await reader.triggerReaderOverviewGeneration();
    expect(overviewText()).toContain("概览生成失败");
    expect(overviewText()).toContain("模型请求失败");

    // error 态切回概览 tab：不自动重跑（重试必须显式）
    reader.ensureReaderOverviewTab();
    await Promise.resolve();
    expect(runOverviewMock).toHaveBeenCalledTimes(1);

    runOverviewMock.mockClear();
    runOverviewMock.mockResolvedValue({ ...SAMPLE_ANALYSIS });
    const retryBtn = overviewBody().querySelector<HTMLButtonElement>("button[data-overview-action='retry']");
    expect(retryBtn).not.toBe(null);
    bindOverviewDelegation();
    retryBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    expect((runOverviewMock.mock.calls[0][0] as { forceRefresh?: boolean }).forceRefresh).toBe(true);
    await vi.waitFor(() => expect(overviewText()).toContain("全片讲了测试驱动开发的三个误区。"));
  });

  it("provider 解析失败（未配置 AI 平台）落入 error 态并如实展示", async () => {
    seedClip();
    chromeStub().runtime.sendMessage.mockImplementation((_message: Record<string, unknown>, callback?: (resp: unknown) => void) => {
      callback?.({ ok: true });
      return undefined;
    });

    await reader.triggerReaderOverviewGeneration();

    expect(runOverviewMock).not.toHaveBeenCalled();
    expect(overviewText()).toContain("概览生成失败");
    expect(overviewText()).toContain("还没有配置 AI 平台");
  });
});

describe("概览点击 seek（章节/金句跳播）", () => {
  beforeEach(async () => {
    seedClip();
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);
    await reader.triggerReaderOverviewGeneration();
    bindOverviewDelegation();
  });

  it("点击章节：seekReadingTarget 通道跳播（resumePlayback 语义）", () => {
    const video = document.querySelector("video") as HTMLVideoElement;
    video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLVideoElement["play"];

    const chapter = overviewBody().querySelector<HTMLElement>(".boc-reading-ov-chapter[data-seconds='120']")!;
    chapter.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(video.currentTime).toBe(120);
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it("点击金句：右下角时间戳整卡可点，跳到金句时间", () => {
    const video = document.querySelector("video") as HTMLVideoElement;
    video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLVideoElement["play"];

    const quote = overviewBody().querySelector<HTMLElement>(".boc-reading-ov-quote")!;
    quote.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(video.currentTime).toBe(125);
  });

  it("金句卡选中文本（复制场景）时不跳转", () => {
    const video = document.querySelector("video") as HTMLVideoElement;
    const selectionSpy = vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "已选中的文字"
    } as unknown as Selection);

    const quote = overviewBody().querySelector<HTMLElement>(".boc-reading-ov-quote")!;
    quote.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(video.currentTime).toBe(0);
    selectionSpy.mockRestore();
  });
});

describe("概览 tab 切换接线（ui-renderer → ensureReaderOverviewTab）", () => {
  it("切到概览 tab：idle 自动触发生成并渲染结果", async () => {
    const uiRenderer = await import("../../extension/ui/ui-renderer.js");
    uiRenderer.ensureUiReady({ forceRecreate: true });
    seedClip();
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);
    state.reader.readingViewOpen = true;

    const tabButton = document.getElementById(ids.readingTabOverview) as HTMLButtonElement;
    tabButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(overviewText()).toContain("全片讲了测试驱动开发的三个误区。"));
  });

  it("换轨后旧产物退场：渲染收敛回未生成态，切 tab 按新签名重新生成", async () => {
    seedClip();
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);
    await reader.triggerReaderOverviewGeneration();
    expect(overviewText()).toContain("全片讲了测试驱动开发的三个误区。");

    // 换轨（签名变化）：渲染层自愈，旧概览不串轨展示
    state.clip.selectedSubtitleId = "sub-2";
    state.clip.selectedSubtitleUrl = "https://subtitle.test/2";
    reader.renderReadingOverview();
    expect(overviewText()).toContain("概览还未生成");

    runOverviewMock.mockClear();
    runOverviewMock.mockResolvedValue({ ...SAMPLE_ANALYSIS, summary: "新字幕轨的总结。" });
    reader.ensureReaderOverviewTab();
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(overviewText()).toContain("新字幕轨的总结。"));
  });
});

describe("closeReadingView 清理", () => {
  it("关闭阅读视图：概览状态归位；进行中的生成不取消，落定回执不写入新会话", async () => {
    seedClip();
    let resolveRun!: (value: OverviewAnalysis) => void;
    runOverviewMock.mockImplementation(
      () => new Promise<OverviewAnalysis>((resolve) => {
        resolveRun = resolve;
      })
    );
    void reader.triggerReaderOverviewGeneration();
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    expect(overviewText()).toContain("正在生成概览");

    reader.closeReadingView();
    expect(state.reader.readingViewOpen).toBe(false);

    // 关闭后渲染：状态机已归位（未生成诚实态）
    reader.renderReadingOverview();
    expect(overviewText()).toContain("概览还未生成");

    // 管线后台落定：回执被丢弃（generatedFor 已清），不渲染、不报错
    resolveRun({ ...SAMPLE_ANALYSIS });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(overviewText()).toContain("概览还未生成");

    // 重开（缓存命中路径由管线负责）：再次触发生成正常发起
    state.reader.readingViewOpen = true;
    runOverviewMock.mockClear();
    runOverviewMock.mockResolvedValue({ ...SAMPLE_ANALYSIS });
    await reader.triggerReaderOverviewGeneration();
    expect(runOverviewMock).toHaveBeenCalledTimes(1);
    expect(overviewText()).toContain("全片讲了测试驱动开发的三个误区。");
  });
});

describe("笔记一节", () => {
  const NOTE_MARKDOWN = "# 笔记标题\n\n第一段内容。";

  // 成稿判定（hasFinalNote）需要笔记正文 + 分段小结：会话存储给一条匹配当前
  // 视频的会话，段缓存按任意 boc_lvs_summary_ 键回一條小结。
  function seedNoteStorage({ withConversation = true, segmentSummaries = true } = {}) {
    chromeStub().storage.local.get.mockImplementation(async (keys: unknown) => {
      if (Array.isArray(keys) && keys.includes("boc_ai_conversations_v1")) {
        if (!withConversation) {
          return {};
        }
        return {
          boc_ai_conversations_v1: [
            {
              id: "conv_1",
              title: "测试视频 · 总结",
              contextKey: "video:BV1test000000|1000",
              contextRef: { bvid: "BV1test000000", cid: "1000" },
              createdAt: Date.now(),
              updatedAt: Date.now(),
              messages: [
                { role: "user", content: "总结这个视频" },
                { role: "assistant", content: NOTE_MARKDOWN }
              ]
            }
          ]
        };
      }
      if (typeof keys === "string" && keys.startsWith("boc_lvs_summary_")) {
        if (!segmentSummaries) {
          return {};
        }
        return { [keys]: { summary: "分段小结内容", timestamp: 1 } };
      }
      return {};
    });
  }

  it("hasFinalNote 成立（笔记 + 分段小结）：预览卡 + 查看完整笔记展开/收起（Markdown 渲染）", async () => {
    // Map-Reduce 路径（>100k 字符）才有分段小结段缓存
    seedClip();
    state.clip.subtitleBody = makeSubtitleBody(110000);
    seedNoteStorage();

    reader.ensureReaderOverviewTab();
    await vi.waitFor(() => expect(overviewText()).toContain("查看完整笔记"));

    expect(overviewText()).toContain("测试视频");
    expect(overviewText()).toContain("# 笔记标题");

    bindOverviewDelegation();
    const openBtn = overviewBody().querySelector<HTMLButtonElement>("button[data-overview-action='toggle-note']")!;
    openBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      const full = overviewBody().querySelector<HTMLElement>(".boc-reading-ov-note-full");
      expect(full).not.toBe(null);
      expect(full!.innerHTML).toContain("<h3>笔记标题</h3>");
      expect(full!.textContent).toContain("第一段内容。");
    });
    expect(overviewText()).toContain("收起笔记");

    const closeBtn = overviewBody().querySelector<HTMLButtonElement>("button[data-overview-action='toggle-note']")!;
    closeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(overviewBody().querySelector(".boc-reading-ov-note-full")).toBe(null));
    expect(overviewText()).toContain("查看完整笔记");
  });

  it("未成稿（无会话/无分段小结）：引导按钮走现有笔记生成链路（player-ai-quick-action）", async () => {
    seedClip();
    seedNoteStorage({ withConversation: false });

    reader.ensureReaderOverviewTab();
    await vi.waitFor(() => expect(overviewText()).toContain("完整笔记还没有生成。"));

    bindOverviewDelegation();
    const generateBtn = overviewBody().querySelector<HTMLButtonElement>("button[data-overview-action='generate-note']")!;
    expect(generateBtn).not.toBe(null);
    generateBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      const calls = chromeStub().runtime.sendMessage.mock.calls as Array<[Record<string, unknown>]>;
      expect(calls.some(([message]) => message?.type === "player-ai-quick-action")).toBe(true);
    });
    // 受理成功：如实提示生成去向，不伪造本地面板进度
    await vi.waitFor(() => expect(overviewText()).toContain("已在 AI 侧边栏发起笔记生成"));
  });

  it("短视频（预算内单次路径）无分段小结：hasFinalNote 不成立，按未成稿引导（忠实管线判定）", async () => {
    seedClip();
    // 60k 字符 → buildBudgetPlan mode=single，无段缓存可言
    state.clip.subtitleBody = makeSubtitleBody(60000);
    seedNoteStorage();

    reader.ensureReaderOverviewTab();
    await vi.waitFor(() => expect(overviewText()).toContain("完整笔记还没有生成。"));
    expect(overviewBody().querySelector("button[data-overview-action='generate-note']")).not.toBe(null);
  });

  it("发起笔记生成失败（消息链报错）：在笔记一节如实反馈", async () => {
    seedClip();
    seedNoteStorage({ withConversation: false });
    stubRuntimeMessages((message) => {
      if (message?.type === "player-ai-quick-action") {
        return { ok: false, error: "AI 按钮未开启" };
      }
      return undefined;
    });

    reader.ensureReaderOverviewTab();
    await vi.waitFor(() => expect(overviewText()).toContain("完整笔记还没有生成。"));

    bindOverviewDelegation();
    overviewBody()
      .querySelector<HTMLButtonElement>("button[data-overview-action='generate-note']")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(overviewText()).toContain("AI 按钮未开启"));
  });
});
