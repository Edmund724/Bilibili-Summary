// 候选06 端口半边：reader 域唯一显式端口（ports.js）的注册与路由纪律测试。
//
// 覆盖：
// - 单点注册后全部端口方法可路由（参数原样转发）；
// - 方法集覆盖旧 callSync 的全部真实调用名（无死槽位）；
// - 重复注册报错（防止实现被静默覆盖）；
// - 注册表缺方法 / 含未知方法键即抛错；
// - 未注册即调用端口方法抛错（替代旧槽的静默 undefined / true）。
//
// 端口注册表是模块级单态：每用例经 vi.resetModules（resetModuleState）后重新
// 动态 import 拿到全新实例，用例之间互不污染。本文件刻意不 import reader 域
// 其他模块（真实注册只发生在 lifecycle.js）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let ports;

beforeEach(async () => {
  resetModuleState();
  ports = await import("../../extension/reader/ports.js");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function validImpls() {
  return {
    noteManualReaderInteraction: vi.fn(),
    syncReadingViewPlayback: vi.fn(),
    flushReadingTranscriptToIndex: vi.fn()
  };
}

describe("reader 显式端口", () => {
  it("单点注册后，全部端口方法可路由且参数原样转发", () => {
    const impls = validImpls();
    ports.registerReaderPorts(impls);

    ports.readerPorts.noteManualReaderInteraction(5000);
    ports.readerPorts.syncReadingViewPlayback(true);
    ports.readerPorts.flushReadingTranscriptToIndex(7);

    expect(impls.noteManualReaderInteraction).toHaveBeenCalledTimes(1);
    expect(impls.noteManualReaderInteraction).toHaveBeenCalledWith(5000);
    expect(impls.syncReadingViewPlayback).toHaveBeenCalledTimes(1);
    expect(impls.syncReadingViewPlayback).toHaveBeenCalledWith(true);
    expect(impls.flushReadingTranscriptToIndex).toHaveBeenCalledTimes(1);
    expect(impls.flushReadingTranscriptToIndex).toHaveBeenCalledWith(7);
  });

  it("方法集覆盖旧 callSync 的全部真实调用名（无死槽位）", () => {
    // 旧 sync-adapter 时代实际经 callSync 路由的名字只有这两个
    //（player-host: syncReadingViewPlayback；page-frame: noteManualReaderInteraction），
    // 它们必须都是端口方法；旧注册表里其余名字从无调用点，属死注册，不进端口。
    expect(ports.READER_PORT_METHODS).toContain("syncReadingViewPlayback");
    expect(ports.READER_PORT_METHODS).toContain("noteManualReaderInteraction");
    expect(ports.readerPorts).toHaveProperty("syncReadingViewPlayback");
    expect(ports.readerPorts).toHaveProperty("noteManualReaderInteraction");
  });

  it("重复注册报错（防止实现被静默覆盖）", () => {
    ports.registerReaderPorts(validImpls());
    expect(() => ports.registerReaderPorts(validImpls())).toThrow(/重复注册/);
  });

  it("注册表缺方法即抛错（禁止静默缺实现）", () => {
    const { flushReadingTranscriptToIndex: _omitted, ...partial } = validImpls();
    expect(() => ports.registerReaderPorts(partial)).toThrow(/缺少方法.*flushReadingTranscriptToIndex/);
  });

  it("注册表含未知方法键即抛错（防拼写漂移绕过显式方法集）", () => {
    expect(() =>
      ports.registerReaderPorts({
        ...validImpls(),
        someTypoMethod: vi.fn()
      })
    ).toThrow(/未知方法.*someTypoMethod/);
  });

  it("未注册即调用端口方法抛错（不再静默 undefined/true）", () => {
    expect(() => ports.readerPorts.syncReadingViewPlayback()).toThrow(/未注册/);
    expect(() => ports.readerPorts.noteManualReaderInteraction()).toThrow(/未注册/);
    expect(() => ports.readerPorts.flushReadingTranscriptToIndex(0)).toThrow(/未注册/);
  });
});
