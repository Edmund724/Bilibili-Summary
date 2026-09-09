// 工单 button-injection-stability/01：Digest 工具栏按钮快路径。
//
// content.ts init() 直接触发 loadDigestButton，不等 getSettings 水合——digest
// 按钮无设置键、常驻，SW 冷启动未回包时也必须已装载（此前装载挂在
// getSettings().then 尾部，SW 往返是按钮首载慢的主因之一）。参照
// player-ai-fast-path.test.js：get-settings 用 deferGetSettings 模拟永不回包，
// 装载发生了即证明没在等它。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, setLocationUrl, NORMAL_PAGE_URL } from "../setup.js";

const mocks = vi.hoisted(() => ({
  loadDigestButton: vi.fn(() => Promise.resolve({}))
}));

vi.mock("../../extension/ui/lazy-digest-button.js", () => ({
  loadDigestButton: mocks.loadDigestButton
}));

// get-settings 永不回包（回调挂起），模拟 SW 冷启动未响应。
function stubChrome() {
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: vi.fn((path) => `chrome-extension://test/${path}`),
      lastError: null,
      sendMessage: vi.fn((_message, callback) => {
        // get-settings 挂起不回包；其余消息同步回 ok
        if (_message?.type !== "get-settings") {
          callback?.({ ok: true });
        }
        return undefined;
      }),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(() => false) }
    },
    storage: {
      sync: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {})
      },
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {})
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  });
}

async function flushMicrotasks(times = 20) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  resetModuleState();
  mocks.loadDigestButton.mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("digest-button 快路径（不等 getSettings 水合）", () => {
  it("SW 冷启动（get-settings 未回包）时 digest 按钮模块已装载", async () => {
    setLocationUrl(NORMAL_PAGE_URL);
    stubChrome();

    await import("../../extension/entry/content.js");
    await flushMicrotasks();

    expect(mocks.loadDigestButton).toHaveBeenCalledTimes(1);
  });

  it("装载失败仅告警不抛出，不阻塞其余启动链", async () => {
    setLocationUrl(NORMAL_PAGE_URL);
    stubChrome();
    // 拒绝经 loadDigestButton().catch 吞掉：若 catch 缺失，本用例会以
    // unhandled rejection 失败（vitest 对未处理拒绝判败），无需额外断言。
    mocks.loadDigestButton.mockRejectedValue(new Error("chunk load failed"));

    await import("../../extension/entry/content.js");
    await flushMicrotasks();

    expect(mocks.loadDigestButton).toHaveBeenCalledTimes(1);
  });
});
