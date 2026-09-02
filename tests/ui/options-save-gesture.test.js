// host 权限代申请的「用户手势」不变式测试（S2 收紧 host_permissions）。
//
// chrome.permissions.request 只在渲染进程仍持有用户手势时才允许弹窗；从手势
// 事件到 request 之间只要多插一个 await，Chrome 就以「缺少用户手势」拒绝，
// 表现为点保存/切平台永远弹不出授权框。这个约束没法在 jsdom 里跑
// （chrome.permissions 是真实扩展 API，测试环境只有 mock），所以这里照
// tests/core/message-handler-signature.test.js 的先例直接扫源码。
//
// 代申请已收口为 core/host-permissions.ts 的单一实现
// requestProviderOriginsViaBackground（content script 语境无 chrome.permissions
// API，经 request-provider-origins 消息由 SW 代为申请；扩展页面语境直调）。
// 手势链条上的每一环都必须零先行 await，本文件锁定三段：
// 1. 全部调用方闭包：调用单一实现的文件恰好是设置面板保存链与 AI 平台行
//    预设切换链两处——新调用方出现时必须把它的手势链断言加进本文件；
// 2. 每个调用方：从手势函数入口到代申请调用之间零先行 await（保存链的调用
//    被直接 await；预设切换链 fire-and-forget，失败静默）；
// 3. SW 处理器（handleRequestProviderOrigins）：从入口到
//    chrome.permissions.request 之间零 await——手势经一次 runtime 消息传导，
//    SW 侧垫任何 await 都会让弹窗被 Chrome 拒绝。
//
// 另锁两条设置面板侧的既有契约：保存按钮 click 直调 saveSettings（中间不垫
// await）；非手势来路（AI/ASR 行「测试连接」成功后的自动保存）显式关闭权限
// 申请——那条路的手势已被探针的 await 用掉。
//
// 断言刻意只认「await 的位置」而不认变量名/文案，改注释、换字段名都不该红。

import { existsSync, readdirSync, readFileSync } from "node:fs";
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
// 源文件已是 .ts；写法上保留 existsSync 双后缀回退（与 tests/core/
// message-handler-signature.test.js 的 readSource 同一口径）。
function readSource(relativePath) {
  const jsUrl = new URL(relativePath, import.meta.url);
  const url = existsSync(fileURLToPath(jsUrl))
    ? jsUrl
    : new URL(relativePath.replace(/\.js$/, ".ts"), import.meta.url);
  return stripComments(readFileSync(fileURLToPath(url), "utf8"));
}

// extension/ 下全部 .ts/.js 源文件（相对 tests/ui/ 的 ../../extension 前缀）
function listExtensionSources() {
  // 根路径同样走变量传入（同 readSource：字面量会被 Vite 改写成资源 URL）
  const relativeRoot = "../../extension";
  const root = fileURLToPath(new URL(relativeRoot, import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|js)$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

describe("host 权限代申请：单一实现与调用方闭包", () => {
  it("requestProviderOriginsViaBackground 只在 core/host-permissions.ts 定义（ui/ 的重复实现已退役）", () => {
    const core = readSource("../../extension/core/host-permissions.js");
    expect(core).toContain("export async function requestProviderOriginsViaBackground(");
    for (const file of listExtensionSources()) {
      if (file.endsWith("/core/host-permissions.ts") || file.endsWith("/core/host-permissions.js")) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      expect(
        /function requestProviderOriginsViaBackground\s*\(/.test(source),
        `requestProviderOriginsViaBackground 不得在他处重复定义：${file}`
      ).toBe(false);
    }
  });

  it("调用方闭包：恰好是设置面板保存链（settings-panel）与 AI 平台行预设切换链（options-rows）", () => {
    const callers = listExtensionSources()
      .filter((file) => !file.endsWith("/core/host-permissions.ts") && !file.endsWith("/core/host-permissions.js"))
      .filter((file) => /requestProviderOriginsViaBackground\s*\(/.test(readFileSync(file, "utf8")))
      .map((file) => file.replace(/^.*\/extension\//, "extension/"))
      .sort();
    expect(callers).toEqual([
      "extension/ui/options-rows.ts",
      "extension/ui/settings-panel.ts"
    ]);
  });
});

describe("调用方手势同步链（调用前零先行 await）", () => {
  it("settings-panel saveSettings：函数体开头到权限申请调用之间没有先行 await", () => {
    const source = readSource("../../extension/ui/settings-panel.js");
    const start = source.indexOf("async function saveSettings(");
    const request = source.indexOf("requestProviderOriginsViaBackground(", start);
    expect(start).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(start);

    const prefix = source.slice(start, request);
    // 紧贴调用自己的那个 await 不算先行 await（await f() 里 f 仍在同一同步任务里
    // 被调用），但要求它确实直接附着在本次调用上；在此之前的任何 await 都会让
    // chrome.permissions.request 丢手势，必须红。
    expect(/(?:^|[\s(=])await\s*$/.test(prefix), "requestProviderOriginsViaBackground 应被直接 await").toBe(true);
    const before = prefix.replace(/\s*await\s*$/, "");
    expect(before.match(/\bawait\b/g) || [], "申请权限之前不得有先行 await").toEqual([]);
  });

  it("options-rows onPresetChange：预设切换处理器到权限申请调用之间零 await", () => {
    const source = readSource("../../extension/ui/options-rows.js");
    const start = source.indexOf("onPresetChange:");
    const request = source.indexOf("requestProviderOriginsViaBackground(", start);
    expect(start).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(start);

    // change 事件即用户手势：处理器是同步箭头函数，任何先行 await 都会把
    // runtime 消息发出前的手势链垫断（表现为切平台弹不出授权框）。
    const prefix = source.slice(start, request);
    expect(prefix.match(/\bawait\b/g) || [], "预设切换的申请之前不得有 await").toEqual([]);
  });
});

describe("SW 处理器零 await（手势经 runtime 消息传导的最后一环）", () => {
  it("handleRequestProviderOrigins：入口到 chrome.permissions.request 之间零 await", () => {
    const source = readSource("../../extension/entry/background.js");
    const start = source.indexOf("function handleRequestProviderOrigins(");
    const request = source.indexOf(".request({ origins })", start);
    expect(start).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(start);

    const prefix = source.slice(start, request);
    expect(prefix.match(/\bawait\b/g) || [], "SW 处理器在申请权限前不得有 await").toEqual([]);
  });
});

describe("设置面板保存链的既有契约", () => {
  it("保存按钮 click 监听直调 saveSettings（不先 await 任何东西）", () => {
    const source = readSource("../../extension/ui/settings-panel.js");
    const binding = source.match(/saveBtn\.addEventListener\(\s*"click"([\s\S]{0,120}?)\);/);
    expect(binding, "找不到 saveBtn 的 click 绑定").toBeTruthy();
    expect(binding[1]).toContain("saveSettings(");
    expect(/\bawait\b/.test(binding[1])).toBe(false);
  });

  it("非手势来路（测试连接成功后的自动保存）显式关闭权限申请", () => {
    const source = readSource("../../extension/ui/settings-panel.js");
    for (const hook of ["setTestSuccessHandler(", "setAsrTestSuccessHandler("]) {
      const start = source.indexOf(hook);
      expect(start, `找不到 ${hook}`).toBeGreaterThan(-1);
      const body = source.slice(start, start + 200);
      expect(body).toContain("saveSettings(elements, { requestPermissions: false })");
    }
  });
});
