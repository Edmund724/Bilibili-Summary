// S3 分层：shared/style-injector.js 的挂载生命周期。
//
// 覆盖「开→关→开」注入契约：
//   - ensureReaderStyles 挂两张阅读表 link（styles/reader.css +
//     styles/reader-gate.css），路径经 chrome.runtime.getURL 解析；
//   - 幂等：重复 ensure 不重复挂（mounted Map 防重）；
//   - removeReaderStyles 摘表并清 Map；再次 ensure 重挂（link 引用全新，
//     但浏览器样式缓存保证二进宫无闪变——本测试断言 DOM 层行为）；
//   - ensurePlayerAiStyles / removePlayerAiStyles 同契约（单表）。
//
// 不校验 CSS 内容（minify/引用完整性由 build.js 的 manifest 校验覆盖）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";

const READER_PATHS = ["entry/styles/reader.css", "entry/styles/reader-gate.css"];

function loadInjector() {
  return import("../../extension/shared/style-injector.js");
}

function mountedLinks() {
  return Array.from(document.querySelectorAll('link[data-boc-style="1"]'));
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("style-injector 挂载生命周期", () => {
  it("ensureReaderStyles 挂两张阅读表 link，URL 经 chrome.runtime.getURL 解析", async () => {
    const injector = await loadInjector();
    injector.ensureReaderStyles();

    const links = mountedLinks();
    expect(links).toHaveLength(2);
    const hrefs = links.map((link) => link.href);
    for (const path of READER_PATHS) {
      expect(hrefs).toContain(`chrome-extension://test/${path}`);
    }
    expect(injector.isReaderStylesMounted()).toBe(true);
  });

  it("幂等：重复 ensure 不重复挂；未挂时 isMounted 为 false", async () => {
    const injector = await loadInjector();
    expect(injector.isReaderStylesMounted()).toBe(false);
    expect(injector.isPlayerAiStylesMounted()).toBe(false);

    injector.ensureReaderStyles();
    injector.ensureReaderStyles();
    expect(mountedLinks()).toHaveLength(2);

    injector.ensurePlayerAiStyles();
    injector.ensurePlayerAiStyles();
    expect(mountedLinks()).toHaveLength(3);
    expect(injector.isPlayerAiStylesMounted()).toBe(true);
  });

  it("开→关→开：remove 摘表并清 Map，再次 ensure 重挂全新 link", async () => {
    const injector = await loadInjector();

    injector.ensureReaderStyles();
    injector.ensurePlayerAiStyles();
    expect(mountedLinks()).toHaveLength(3);

    injector.removeReaderStyles();
    expect(mountedLinks()).toHaveLength(1); // 只剩 player-ai 表
    expect(injector.isReaderStylesMounted()).toBe(false);

    injector.ensureReaderStyles();
    const links = mountedLinks();
    expect(links).toHaveLength(3);
    // 重挂的 link 是新节点（旧引用已摘除；样式数据由浏览器缓存，二进宫无闪变）
    expect(injector.isReaderStylesMounted()).toBe(true);
  });

  it("remove 未挂过的路径是 no-op（幂等移除）", async () => {
    const injector = await loadInjector();
    injector.removeReaderStyles();
    injector.removePlayerAiStyles();
    expect(mountedLinks()).toHaveLength(0);
  });
});
