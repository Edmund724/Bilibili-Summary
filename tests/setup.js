// 全局测试环境准备：
// - 重置 ESM 模块缓存（配合 vi.resetModules 实现每用例干净导入）
// - 确保 jsdom 的 location 落在 B 站阅读模式 URL 上（state.js 会读取 location.href）
// - 注入浏览器扩展 API 的通用 stub（chrome.runtime.sendMessage 等）
// 注：不再给 HTMLElement.prototype.click 打「手动补派发」补丁——jsdom 30 的原生
// click 已派发 click 事件，补丁叠加原生派发会变成双事件（arch-slim-2/08：
// timestamp-nav 测试断言恰好调用 1 次时暴露）。

import { beforeEach, vi } from "vitest";

export const READER_MODE_URL = "https://www.bilibili.com/video/BV1test000000/?boc_reader=1";
export const NORMAL_PAGE_URL = "https://www.bilibili.com/video/BV1test000000/";

function stubChromeApi() {
  const listeners = new Set();

  const chromeStub = {
    runtime: {
      lastError: null,
      // S3 分层：content 侧按需 CSS 经 chrome.runtime.getURL 挂 link（阅读表/
      // player-ai 表）；jsdom 无扩展上下文，返回占位 URL（真实值只影响 href
      // 文本，不影响断言）。守卫条件与 content-bootstrap 一致：getURL 存在才
      // 触发自动加载——本 stub 在 setup 顶层安装，所有测试文件共享。
      getURL: vi.fn((path) => `chrome-extension://test/${path}`),
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
}

// 跨实例共享槽（挂 globalThis，见 shared/messaging.ts 的页内分发槽、
// shared/logging.ts 的调试门、reader/reader-bus.ts 的槽表、core/state.ts 的
// 状态单例、shared/style-injector.ts 的挂载记录）：清空即「换干净槽」——否则
// 上一条用例的注册/状态会随 globalThis 活到下一用例。
export function clearSharedSlots() {
  delete globalThis.__BOC_CONTENT_SCRIPT_DISPATCHER__;
  delete globalThis.__BOC_LOG_GATE__;
  delete globalThis.__BOC_READER_BUS__;
  delete globalThis.__BOC_STATE__;
  delete globalThis.__BOC_STYLE_INJECTOR__;
}

// 每条用例前清一次（在文件自身的 beforeEach 之前跑）：即便某文件只调
// vi.resetModules() 不走 resetModuleState，也不会把上一条用例的槽带进来。
beforeEach(() => {
  clearSharedSlots();
});

export function resetModuleState() {
  vi.resetModules();
  vi.useRealTimers();
  setupEnvironment();
  history.replaceState({}, "", NORMAL_PAGE_URL);
  clearSharedSlots();

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

// 生成指定总字符数的字幕体：每项 charsPerItem 个字符（末项取余），from 每项 +5 秒。
// 供 AI 预算器 / Map-Reduce / 单次路径测试共享（避免各测试文件重复定义）。
export function makeSubtitleBody(totalChars, charsPerItem = 1000) {
  const items = [];
  let remaining = totalChars;
  let t = 0;
  while (remaining > 0) {
    const n = Math.min(charsPerItem, remaining);
    items.push({ from: t, to: t + 5, content: "x".repeat(n) });
    remaining -= n;
    t += 5;
  }
  return items;
}

setupEnvironment();
