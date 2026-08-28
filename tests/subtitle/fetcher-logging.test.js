// fetcher.js 日志依赖回归测试（诊断回路 Phase 2）。
//
// 背景：fetcher.js 调用了 logInfo / logWarn，但头部 import 块缺失
// `import { logInfo, logWarn } from "../shared/logging.js"`。
// esbuild 把 logInfo 当作自由全局变量，构建不报错，运行时才抛
// ReferenceError: logInfo is not defined。
//
// 本测试只 mock 掉 fetcher.js 的 DOM 接线 / fetch / 笔记构建等重依赖，
// 保留 state、error-helpers、url-utils、selection 等轻量真实模块，
// 通过真实代码路径走到 logInfo / logWarn 调用。
// 修复（补上 import）后本测试应转绿；当前（未修复）必须红在
// `logInfo is not defined` 上。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

// 顶层副作用 subscribeSubtitleRefresh(refreshClip) 需要 presenter 提供该函数。
vi.mock("../../extension/reader/presenter.js", () => ({
  subscribeSubtitleRefresh: vi.fn(),
  notifyReaderPresenter: vi.fn()
}));
// ui-message.js 已合入 ui-renderer.js，setMessage 直接从 ui-renderer mock。
vi.mock("../../extension/ui/ui-renderer.js", () => ({
  renderMeta: vi.fn(),
  renderSubtitleSelect: vi.fn(),
  setBusyState: vi.fn(),
  setStatus: vi.fn(),
  setMessage: vi.fn()
}));
vi.mock("../../extension/subtitle/fetcher.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    retryAsync: vi.fn((fn) => fn()),
    fetchVideoMeta: vi.fn(),
    fetchSubtitleBundle: vi.fn()
  };
});
vi.mock("../../extension/bilibili/gateway.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchSubtitleBody: vi.fn(),
    readRuntimeVideoDuration: vi.fn(() => 300)
  };
});
vi.mock("../../extension/reader/page-context.js", () => ({
  resolvePageContext: vi.fn(() => ({ pageIndex: 1, cid: "101", cidSource: "test", pageTitle: "P1", duration: 300 }))
}));
// notes/build.js 已合入 subtitle/core.js，refreshDerivedContent 的 mock 改挂到 core.js。
// core.js 引入 notes/render.js 链、ui.js 引入 notes/render.js / reader/index.js 链，
// cache.js 引入真实 logging.js——这些均非本回路目标，mock 掉以保持信号精确。
vi.mock("../../extension/subtitle/core.js", () => ({
  readVideoTitle: vi.fn(() => "测试标题"),
  readVideoAuthor: vi.fn(() => "测试作者"),
  readUploadDate: vi.fn(() => "2026-01-01"),
  refreshDerivedContent: vi.fn(async () => {})
}));
vi.mock("../../extension/subtitle/ui.js", () => ({
  applyNoSubtitleState: vi.fn(),
  readVideoDescription: vi.fn(() => "")
}));
vi.mock("../../extension/subtitle/cache.js", () => ({
  buildSubtitleCandidates: vi.fn((tracks, preferred) => {
    const list = [preferred];
    for (const item of tracks || []) {
      if (item !== preferred) {
        list.push(item);
      }
    }
    return list;
  }),
  clearSubtitleCacheByKey: vi.fn(async () => {}),
  saveSubtitleToCache: vi.fn(async () => {}),
  loadSubtitleFromCache: vi.fn(async () => null),
  getSubtitleCacheKey: vi.fn(() => "boc_subtitle_cache_test")
}));

// 以下依赖保持真实加载：state / defaults / validators / utils / url-utils / error-helpers
// / runtime / selection 仅依赖纯函数或 state。
//（若这些模块的 import 链被进一步破坏，这里会暴露为“红在别处”。）

let fetcher;
let fetchBodyMock;

beforeEach(async () => {
  resetModuleState();
  fetcher = await import("../../extension/subtitle/fetcher.js");
  fetchBodyMock = (await import("../../extension/bilibili/gateway.js")).fetchSubtitleBody;
  fetchBodyMock.mockReset();

  // 测试桩：vitest 的 ESM 变换把 logWarn 这类未绑定标识符回退到全局对象
  // 查找（这与浏览器/esbuild 行为一致），因此把桩挂在 globalThis 上，让
  // logInfo（第 57 行）成为唯一自由变量——否则它抛出的 ReferenceError
  // 会被第 84 行的 logWarn ReferenceError 掩盖（后者恰好是真实生产报错
  // 链；回归已由下方 refreshClip 用例覆盖）。
  Object.defineProperty(globalThis, "logWarn", { value: vi.fn(), configurable: true });
});

describe("tryLoadSubtitleCandidates 日志路径", () => {
  it("单候选成功：logInfo 不再抛 ReferenceError（修复后通过）", async () => {
    fetchBodyMock.mockResolvedValue({ body: [{ from: 0, to: 10, content: "hello" }] });

    const candidate = { id: "1", lan: "zh-CN", lanDoc: "中文", subtitleUrl: "https://example.com/sub.json" };
    const result = await fetcher.tryLoadSubtitleCandidates([candidate], 0, false);

    expect(result).toBe(candidate);
    expect(fetchBodyMock).toHaveBeenCalledWith(candidate.subtitleUrl);
  });

  it("候选失败：logWarn 不再抛 ReferenceError（修复后通过）", async () => {
    fetchBodyMock.mockRejectedValue(new Error("network down"));

    await expect(
      fetcher.tryLoadSubtitleCandidates(
        [{ id: "1", lan: "zh-CN", subtitleUrl: "https://example.com/sub.json" }],
        0,
        false
      )
    ).rejects.toThrow("network down");
  });

  it("refreshClip 外层路径：错误被安全捕获（复现用户症状）", async () => {
    // resetClipState（真实代码）通过 byId("boc-preview") 写空值，需该 DOM 节点。
    const preview = document.createElement("textarea");
    preview.id = "boc-preview";
    document.body.appendChild(preview);

    // 让 fetchVideoMeta 抛错，使 refreshClip 在 logInfo 出现之前就失败——若
    // 错误路径依赖未定义的 logInfo，这里会 reject 而不是 resolve。
    const fetchMetaMock = (await import("../../extension/subtitle/fetcher.js")).fetchVideoMeta;
    fetchMetaMock.mockRejectedValue(new Error("meta down"));

    await expect(fetcher.refreshClip()).resolves.toBeUndefined();
  });
});
