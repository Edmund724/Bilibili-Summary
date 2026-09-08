// shared/style-injector 挂载记录跨实例共享回归（content 两轮构建的双实例缺陷，
// 最后一处）：
//
// scripts/build-content.js 是两轮构建——轮 A 常驻单文件（content-main.mjs）、
// 轮 B 懒加载区（chunks/），共享底座在两侧各有一份实例。挂载记录原先挂模块级
// Map，而挂载点本就分居两侧（常驻 entry/content.ts 的直达阅读 URL 路径、
// 懒加载区 reader/shell.ts 的进入事务）：各记各的会让同一路径被注入两个
// <link>，且一侧 removeReaderStyles 摘不掉另一侧那个（退出阅读模式后样式表
// 残留）。修复：挂载记录与设置表 ready promise 挂 globalThis 槽（与
// shared/messaging.ts 的页内分发槽同款先例）。
//
// 手法：vi.resetModules() 后重新 import 得到**另一个模块实例**，断言它认账
// 同一份挂载记录——正是生产里两侧实例的分工。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

type StyleInjector = typeof import("../../extension/shared/style-injector.js");

let resident: StyleInjector;
let lazy: StyleInjector;

function injectedLinks(): HTMLLinkElement[] {
  return Array.from(document.querySelectorAll<HTMLLinkElement>("link[data-boc-style]"));
}

beforeEach(async () => {
  resetModuleState();
  document.head.innerHTML = "";
  resident = await import("../../extension/shared/style-injector.js");
  // 模拟轮 B 懒加载区那份实例
  vi.resetModules();
  lazy = await import("../../extension/shared/style-injector.js");
});

describe("style-injector 挂载记录跨实例共享", () => {
  it("两个模块实例确实不同（前提校验）", () => {
    expect(lazy).not.toBe(resident);
  });

  it("一侧挂载、另一侧认账，且不重复注入同路径 <link>", () => {
    resident.ensureReaderStyles();
    const afterFirstMount = injectedLinks().length;
    expect(afterFirstMount).toBe(2); // reader.css + reader-gate.css

    expect(lazy.isReaderStylesMounted()).toBe(true); // 修复前为 false
    lazy.ensureReaderStyles();

    expect(injectedLinks().length).toBe(afterFirstMount); // 不再多挂一份
  });

  it("一侧移除、另一侧认账（退出阅读模式不再残留）", () => {
    lazy.ensureReaderStyles();
    expect(resident.isReaderStylesMounted()).toBe(true);

    resident.removeReaderStyles();

    expect(lazy.isReaderStylesMounted()).toBe(false);
    expect(injectedLinks().length).toBe(0);
  });

  it("player-ai / 对话分区表同表：跨实例挂载记录一致", () => {
    resident.ensurePlayerAiStyles();
    expect(lazy.isPlayerAiStylesMounted()).toBe(true);

    lazy.ensureReaderChatStyles();
    expect(resident.isReaderChatStylesMounted()).toBe(true);

    lazy.removeReaderChatStyles();
    expect(resident.isReaderChatStylesMounted()).toBe(false);
  });

  it("设置表 ready promise 跨实例同一份（whenReaderSettingsStylesReady 等的是同一个）", () => {
    resident.ensureReaderSettingsStyles();
    const residentReady = resident.whenReaderSettingsStylesReady();
    const lazyReady = lazy.whenReaderSettingsStylesReady();

    expect(lazyReady).toBe(residentReady); // 修复前懒加载区侧为 Promise.resolve() 新对象
  });
});
