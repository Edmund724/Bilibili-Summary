// 全局测试环境准备：
// - 重置 ESM 模块缓存（配合 vi.resetModules 实现每用例干净导入）
// - 确保 jsdom 的 location 落在 B 站阅读模式 URL 上（state.js 会读取 location.href）
// - 注入浏览器扩展 API 的通用 stub（chrome.runtime.sendMessage 等）
// - HTMLElement.prototype.click 在 jsdom 中未触发事件派发，补充为可观察的派发

import { beforeEach, vi } from "vitest";

export const READER_MODE_URL = "https://www.bilibili.com/video/BV1test000000/?boc_reader=1";
export const NORMAL_PAGE_URL = "https://www.bilibili.com/video/BV1test000000/";

function stubChromeApi() {
  const listeners = new Set();

  const chromeStub = {
    runtime: {
      lastError: null,
      sendMessage: vi.fn((_message, callback) => {
        callback?.({ ok: true });
        return undefined;
      }),
      onMessage: {
        addListener(listener) {
          listeners.add(listener);
        },
        removeListener(listener) {
          listeners.delete(listener);
        },
        hasListener(listener) {
          return listeners.has(listener);
        }
      }
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {})
      },
      sync: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {})
      },
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      }
    }
  };

  if (!globalThis.chrome) {
    vi.stubGlobal("chrome", chromeStub);
  }
  return chromeStub;
}

export function setupEnvironment() {
  stubChromeApi();

  if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.click.__bocPatched) {
    const originalClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function click() {
      if (typeof originalClick === "function") {
        originalClick.call(this);
      }
      this.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    };
    HTMLElement.prototype.click.__bocPatched = true;
  }
}

export function resetModuleState() {
  vi.resetModules();
  vi.useRealTimers();
  setupEnvironment();
  history.replaceState({}, "", NORMAL_PAGE_URL);

  // jsdom 未实现 scrollIntoView；补一个空实现避免滚动路径抛错
  if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }

  // jsdom 的 window.scrollTo / scrollBy 未实现（会打印 not implemented 并抛错），覆盖为空实现
  if (typeof window !== "undefined") {
    window.scrollTo = () => {};
    window.scrollBy = () => {};
  }

  // jsdom 无布局，getBoundingClientRect 恒为 0。给 Element 原型补默认可见矩形，
  // 让 reader 的布局判定（>240x120 等）通过；特定元素可在用例内再覆盖。
  if (typeof Element !== "undefined" && !Element.prototype.getBoundingClientRect.__bocDefaultPatched) {
    Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
      return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 450, width: 800, height: 450, toJSON: () => ({}) };
    };
    Element.prototype.getBoundingClientRect.__bocDefaultPatched = true;
  }
}

export function setLocationUrl(url) {
  history.replaceState({}, "", url);
}

setupEnvironment();
