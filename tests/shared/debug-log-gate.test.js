// 调试日志门（shared/logging 的 registerDebugGate + shared/debug-log-gate 接线）：
// - logging 未注册缺省关，logWarn/logError 不出声（叶子纪律：不读 core/state）
// - registerDebugGate 生效且后注册覆盖先注册
// - registerDebugLogGate 初始读 sync、onChanged 保活；area/key 不匹配不翻转；
//   初始读失败维持关且不抛未处理拒绝
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

function freshStorageStubs() {
  chrome.storage.sync.get = vi.fn(async () => ({}));
  chrome.storage.onChanged.addListener = vi.fn();
}

function storageChangeListener() {
  return chrome.storage.onChanged.addListener.mock.calls.at(-1)?.[0];
}

describe("shared/logging 调试门", () => {
  beforeEach(() => {
    resetModuleState();
    freshStorageStubs();
  });

  it("未注册时缺省关：logWarn/logError 不出声", async () => {
    const logging = await import("../../extension/shared/logging.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(logging.shouldDebugLog()).toBe(false);
    logging.logWarn("[BOC] quiet");
    logging.logError("[BOC] quiet");
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("registerDebugGate 生效且后注册覆盖先注册", async () => {
    const logging = await import("../../extension/shared/logging.js");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    logging.registerDebugGate(() => true);
    logging.logInfo("[BOC] loud");
    expect(infoSpy).toHaveBeenCalledTimes(1);
    logging.registerDebugGate(() => false);
    logging.logInfo("[BOC] quiet again");
    expect(infoSpy).toHaveBeenCalledTimes(1);
    infoSpy.mockRestore();
  });

  it("门跨实例共享：常驻实例注册，懒加载区实例的 logWarn 也出声", async () => {
    // 两轮构建（scripts/build-content.js）把 shared 底座在懒加载区重复一份：
    // 门原先挂模块级变量，注册发生在常驻包实例（content.ts 的
    // registerDebugLogGate），抓取链/reader/对话用的懒加载区那份看不到——
    // 用户开了「调试日志」也捞不到 [BOC] 行。门改挂 globalThis 槽。
    const resident = await import("../../extension/shared/logging.js");
    resident.registerDebugGate(() => true);
    vi.resetModules();
    const lazy = await import("../../extension/shared/logging.js");
    expect(lazy).not.toBe(resident);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    lazy.logWarn("[BOC] from lazy chunk");
    expect(warnSpy).toHaveBeenCalledWith("[BOC] from lazy chunk");
    warnSpy.mockRestore();
  });
});

describe("shared/debug-log-gate 三宿主接线", () => {
  beforeEach(() => {
    resetModuleState();
    freshStorageStubs();
  });

  it("初始读 sync：enableDebugLogs=true 时门打开，logWarn 出声", async () => {
    chrome.storage.sync.get = vi.fn(async () => ({ enableDebugLogs: true }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { logWarn } = await import("../../extension/shared/logging.js");
    const { registerDebugLogGate } = await import("../../extension/shared/debug-log-gate.js");
    registerDebugLogGate();
    await vi.waitFor(() => {
      logWarn("[BOC] from offscreen");
      expect(warnSpy).toHaveBeenCalledWith("[BOC] from offscreen");
    });
    warnSpy.mockRestore();
  });

  it("onChanged 保活：sync+本键翻转开关，local/他键不翻转", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { logWarn } = await import("../../extension/shared/logging.js");
    const { registerDebugLogGate } = await import("../../extension/shared/debug-log-gate.js");
    registerDebugLogGate();
    const listener = storageChangeListener();
    expect(listener).toBeTypeOf("function");

    listener({ enableDebugLogs: { newValue: true } }, "sync");
    logWarn("[BOC] on");
    expect(warnSpy).toHaveBeenCalledWith("[BOC] on");

    listener({ enableDebugLogs: { newValue: false } }, "local");
    logWarn("[BOC] still on");
    expect(warnSpy).toHaveBeenCalledTimes(2);

    listener({ readerTheme: { newValue: "dark" } }, "sync");
    logWarn("[BOC] key ignored");
    expect(warnSpy).toHaveBeenCalledTimes(3);

    listener({ enableDebugLogs: { newValue: false } }, "sync");
    logWarn("[BOC] off");
    expect(warnSpy).toHaveBeenCalledTimes(3);
    warnSpy.mockRestore();
  });

  it("初始读失败维持关且不抛未处理拒绝", async () => {
    chrome.storage.sync.get = vi.fn(async () => {
      throw new Error("storage unavailable");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { logWarn } = await import("../../extension/shared/logging.js");
    const { registerDebugLogGate } = await import("../../extension/shared/debug-log-gate.js");
    registerDebugLogGate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    logWarn("[BOC] quiet");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
