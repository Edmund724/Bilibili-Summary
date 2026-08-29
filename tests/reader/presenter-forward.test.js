// reader/presenter.js 的 notifyReaderPresenter 参数透传测试。
//
// 回归背景（q5a）：notifyReaderPresenter 原先只转发 kind，fetcher 传的
// "subtitle-ready, 当前视频无字幕。" 第二参被丢弃、阅读视图永远显示默认文案
// （「抓取完成，阅读视图已同步最新字幕。」）。修复为 (kind, ...payload) 全量
// 透传：消费方 reader/lifecycle.js bindReaderPresenter 的 handler 本就是
// (kind, text) 签名。单参调用（reset/rerender/无文案 subtitle-ready）行为不变，
// handler 异常仍被隔离不中断其余 handler。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let presenter;
let received;

beforeEach(async () => {
  resetModuleState();
  // resetModules 后动态导入：每个用例拿到全新的 presenter 模块（readers
  // 注册表清空），避免跨用例的 handler 累积污染断言。
  presenter = await import("../../extension/reader/presenter.js");
  received = [];
  presenter.subscribeReaderPresenter((...args) => {
    received.push(args);
  });
});

describe("notifyReaderPresenter 透传", () => {
  it("subtitle-ready + 状态文案：第二参透传给 reader 侧 handler", () => {
    presenter.notifyReaderPresenter("subtitle-ready", "当前视频无字幕。");

    expect(received).toEqual([["subtitle-ready", "当前视频无字幕。"]]);
  });

  it("status 提示文本：第二参透传（resetClipState 的「请先点击刷新抓取」提示可达阅读视图）", () => {
    presenter.notifyReaderPresenter("status", "请先点击“刷新抓取”加载当前视频字幕。");

    expect(received).toEqual([["status", "请先点击“刷新抓取”加载当前视频字幕。"]]);
  });

  it("单参调用行为不变：handler 收到 (kind)，无多余实参", () => {
    presenter.notifyReaderPresenter("reset");
    presenter.notifyReaderPresenter("rerender");
    presenter.notifyReaderPresenter("subtitle-ready");

    expect(received).toEqual([["reset"], ["rerender"], ["subtitle-ready"]]);
  });

  it("多参透传：超出两位的 payload 原样展开", () => {
    presenter.notifyReaderPresenter("custom", "a", 2, { b: 3 });

    expect(received).toEqual([["custom", "a", 2, { b: 3 }]]);
  });

  it("handler 抛错被隔离：不影响其余 handler（含第二参场景）", () => {
    const failing = vi.fn(() => {
      throw new Error("boom");
    });
    const ok = vi.fn();
    presenter.subscribeReaderPresenter(failing);
    presenter.subscribeReaderPresenter(ok);

    expect(() => presenter.notifyReaderPresenter("subtitle-ready", "当前视频无字幕。")).not.toThrow();
    expect(ok).toHaveBeenCalledWith("subtitle-ready", "当前视频无字幕。");
  });
});
