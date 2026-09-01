// options.js 保存路径的「用户手势」不变式测试（S2 收紧 host_permissions）。
//
// chrome.permissions.request 只在渲染进程仍持有用户手势时才允许弹窗；从 click
// 到 request 之间只要多插一个 await，Chrome 就以「缺少用户手势」拒绝，表现为
// 点保存永远弹不出授权框。这个约束没法在 jsdom 里跑（chrome.permissions 是
// 真实扩展 API，测试环境只有 mock），所以这里照 tests/core/message-handler-
// signature.test.js 的先例直接扫源码，机械锁住两条：
// 1. saveSettings 函数体从开头到 requestProviderOrigins 调用之间零 await；
// 2. 保存按钮的 click 监听直调 saveSettings，中间不垫 await。
//
// 断言刻意只认「await 的位置」而不认变量名/文案，改注释、换字段名都不该红。

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 去块注释与行注释（与既有源码扫描测试同一口径），避免注释里的 await 误判
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

// 注意：URL 参数必须走变量传入，不能写 new URL("<字面量>", import.meta.url)——
// Vite 会把字面量形式改写成资源 URL，jsdom 下解析成 https:// 开头而 fileURLToPath 报错。
// TS 渐进迁移期间源文件可能是 .js 或 .ts，缺失时回退到另一扩展名（与
// tests/core/message-handler-signature.test.js 的 readSource 同一口径）。
function readOptionsSource() {
  const relativePath = "../../extension/pages/options.js";
  const jsUrl = new URL(relativePath, import.meta.url);
  const url = existsSync(fileURLToPath(jsUrl))
    ? jsUrl
    : new URL(relativePath.replace(/\.js$/, ".ts"), import.meta.url);
  return stripComments(readFileSync(fileURLToPath(url), "utf8"));
}

describe("saveSettings 的手势同步链", () => {
  it("从函数体开头到 requestProviderOrigins 之间没有先行 await", () => {
    const source = readOptionsSource();
    const start = source.indexOf("async function saveSettings(");
    const request = source.indexOf("requestProviderOrigins(", start);
    expect(start).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(start);

    const prefix = source.slice(start, request);
    // 紧贴调用自己的那个 await 不算先行 await（await f() 里 f 仍在同一同步任务里
    // 被调用），但要求它确实直接附着在本次调用上；在此之前的任何 await 都会让
    // chrome.permissions.request 丢手势，必须红。
    expect(/(?:^|[\s(=])await\s*$/.test(prefix), "requestProviderOrigins 应被直接 await").toBe(true);
    const before = prefix.replace(/\s*await\s*$/, "");
    expect(before.match(/\bawait\b/g) || [], "申请权限之前不得有先行 await").toEqual([]);
  });

  it("保存按钮 click 监听直调 saveSettings（不先 await 任何东西）", () => {
    const source = readOptionsSource();
    const binding = source.match(/saveBtn\.addEventListener\(\s*"click"([\s\S]{0,120}?)\);/);
    expect(binding, "找不到 saveBtn 的 click 绑定").toBeTruthy();
    expect(binding[1]).toContain("saveSettings(");
    expect(/\bawait\b/.test(binding[1])).toBe(false);
  });

  it("非手势来路（测试连接成功后的自动保存）显式关闭权限申请", () => {
    const source = readOptionsSource();
    for (const hook of ["setTestSuccessHandler(", "setAsrTestSuccessHandler("]) {
      const start = source.indexOf(hook);
      expect(start, `找不到 ${hook}`).toBeGreaterThan(-1);
      const body = source.slice(start, start + 200);
      expect(body).toContain("saveSettings({ requestPermissions: false })");
    }
  });
});
