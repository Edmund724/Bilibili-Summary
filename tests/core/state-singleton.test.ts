// core/state 单例跨实例共享回归（content 两轮构建的双实例缺陷，第 3 项）：
//
// scripts/build-content.js 是两轮构建——轮 A 常驻单文件（content-main.mjs）、
// 轮 B 懒加载区（chunks/），共享底座在两侧各有一份实例。状态单例原先挂模块级
// 变量：常驻侧（content.ts / message-handler / ui-status）与懒加载区（fetcher /
// reader / 对话）各持一份 state，两边各写各的，跨侧读取随时可能拿到空值。修复：
// 单例挂 globalThis 槽（与 shared/messaging.ts 的页内分发槽同款先例）。
//
// 手法：vi.resetModules() 后重新 import 得到**另一个模块实例**，断言它看到的是
// 同一份状态对象——正是生产里两侧实例的分工。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

type StateModule = typeof import("../../extension/core/state.js");

let resident: StateModule;
let lazy: StateModule;

beforeEach(async () => {
  resetModuleState();
  resident = await import("../../extension/core/state.js");
  // 模拟轮 B 懒加载区那份实例
  vi.resetModules();
  lazy = await import("../../extension/core/state.js");
});

describe("core/state 单例跨实例共享", () => {
  it("两个模块实例确实不同（前提校验）", () => {
    expect(lazy).not.toBe(resident);
  });

  it("两侧拿到同一份 state / clipState / uiState（对象同一性）", () => {
    expect(lazy.state).toBe(resident.state);
    expect(lazy.clipState).toBe(resident.clipState);
    expect(lazy.uiState).toBe(resident.uiState);
    expect(lazy.state.clip).toBe(resident.clipState);
    expect(lazy.state.reader).toBe(resident.state.reader);
  });

  it("一侧写入、另一侧读到（clip 业务字段与状态行文案）", () => {
    resident.clipState.setBvid("BV1shared0000");
    resident.clipState.setSubtitleFetchState("loading");
    resident.uiState.setStatusText("正在获取可用字幕...");

    expect(lazy.state.clip.bvid).toBe("BV1shared0000");
    expect(lazy.state.clip.subtitleFetchState).toBe("loading");
    expect(lazy.state.ui.statusText).toBe("正在获取可用字幕...");

    lazy.clipState.setSubtitleBody([{ from: 0, to: 10, content: "大家好" }]);
    expect(resident.state.clip.subtitleBody).toHaveLength(1);
  });

  it("reader 视图开关跨侧可见（通知门控读的就是它）", () => {
    lazy.state.reader.setViewOpen(true);
    expect(resident.state.reader.readingViewOpen).toBe(true);
    expect(resident.state.reader).toBe(lazy.state.reader);
  });

  it("初始值由先求值的实例创建（currentUrl 读 location，两实例一致）", () => {
    expect(lazy.state.clip.currentUrl).toBe(resident.state.clip.currentUrl);
    expect(lazy.state.clip.currentUrl).toContain("/video/BV1test000000");
  });
});
