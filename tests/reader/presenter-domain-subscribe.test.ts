// 回归（content 双实例缺陷）：reader-bus 在 content 两轮构建（scripts/build-content.js）
// 里有两份实例——常驻包 content-main.mjs 一份、懒加载区共享 chunk 一份。订阅原先
// 注册在常驻微模块 init-essentials 的 bindReaderPresenter（content.ts 调），而发布方
// （subtitle/fetcher、subtitle/commit）都在懒加载区——通知永远到不了 reader 域：
// 字幕已落账、列表已渲染（对账重渲兜住），状态行却停在「正在获取可用字幕...」，
// 永远等不到「抓取完成…」。修复：订阅随发布方搬进 reader/lifecycle.ts 的模块求值期
// （域装载即注册）。
//
// 本用例只装载 reader 域、不装载 content.ts 的常驻接线——正是生产里的实例分工
//（常驻侧订阅收不到懒加载区的通知），修复前必失败。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

vi.mock("../../extension/reader/overview.js", async (importActual) => {
  const actual = await importActual<typeof import("../../extension/reader/overview.js")>();
  return {
    ...actual,
    triggerReaderOverviewGeneration: vi.fn(() => Promise.resolve())
  };
});

let state: TestState;
let ids: typeof import("../../extension/reader/state.js").ids;
let presenter: typeof import("../../extension/reader/reader-bus.js");

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  ids = (await import("../../extension/reader/state.js")).ids;
  mountReaderSkeleton(ids);
  mountPlayerChain();
  presenter = await import("../../extension/reader/reader-bus.js");
  // 域装载：lifecycle 模块求值期注册 presenter 订阅（本用例的断言面）
  await import("../../extension/reader/index.js");
});

describe("reader 域自注册 presenter 订阅（双实例缺陷回归）", () => {
  it("status 通知直达状态行：「抓取完成…」不再丢失", () => {
    presenter.notifyReaderPresenter("status", "抓取完成，可以复制或下载字幕。");

    expect(document.getElementById(ids.readingStatus)?.textContent).toBe(
      "抓取完成，可以复制或下载字幕。"
    );
  });

  it("subtitle-ready 通知渲染字幕列表（域内处理体可达）", () => {
    state.reader.setViewOpen(true);
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];

    presenter.notifyReaderPresenter("subtitle-ready");

    expect(document.querySelectorAll(".boc-reading-item").length).toBe(1);
    // 状态行文案由同一条通知先写「抓取完成，阅读视图已同步最新字幕。」，随后
    // 播放同步 tick（startReadingViewSync）接手改写为「当前进度 …」——生产同序，
    // 故此处只断言列表（状态行路径由上一用例钉住）。
  });
});
