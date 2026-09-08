// 页内消息分发原语（shared/messaging.ts 的注册槽 + 转发）回归锁：
// - 未注册时分发返回 false（与「无人处理」同义）；
// - 注册后分发路由到分发主体，回包与返回值透传；
// - 注册槽挂 globalThis 而非模块级变量——两轮构建把 shared 底座在轮 B
//   懒 chunk 区重复一份（content-main 与 chunks/ 各一个 messaging 实例），
//   模块级槽会让懒 chunk 里的页内源（ui/digest-button.ts 点击/自愈）永远
//   看不到常驻包实例上的注册，静默无反应；本用例直接断言槽住在 globalThis
//   的固定键上，防回退。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const SLOT_KEY = "__BOC_CONTENT_SCRIPT_DISPATCHER__";

describe("shared/messaging 页内分发原语", () => {
  beforeEach(() => {
    resetModuleState();
    delete (globalThis as Record<string, unknown>)[SLOT_KEY];
  });

  it("未注册时分发返回 false，globalThis 槽为空", async () => {
    const { dispatchContentScriptMessage } = await import("../../extension/shared/messaging.js");
    expect(dispatchContentScriptMessage({ type: "reader-enter" }, () => {})).toBe(false);
    expect((globalThis as Record<string, unknown>)[SLOT_KEY]).toBeUndefined();
  });

  it("注册写入 globalThis 槽，分发经槽路由到分发主体", async () => {
    const { registerContentScriptDispatcher, dispatchContentScriptMessage } = await import(
      "../../extension/shared/messaging.js"
    );
    const dispatcher = vi.fn(() => true);
    registerContentScriptDispatcher(dispatcher);
    expect((globalThis as Record<string, unknown>)[SLOT_KEY]).toBe(dispatcher);
    const sendResponse = vi.fn();
    const message = { type: "reader-enter", readerUrl: "https://www.bilibili.com/video/BV1?boc_reader=1" };
    expect(dispatchContentScriptMessage(message, sendResponse)).toBe(true);
    expect(dispatcher).toHaveBeenCalledWith(message, sendResponse);
  });
});
