// 阅读壳序列唯一性扫描（工单 arch-slim/02 验收标准 1）：
// 全仓不得出现「进入阅读 shell 序列」的第二份手抄——八步无闪变时序
// （suppressUntil → 摘播放器快捷按钮 → resolveReaderEntryUrl → ensureUiReady →
// replaceReaderModeUrl → ensureReaderStyles → 翻 body/html 门控属性 →
// enterReaderMode）与退出逆事务只允许存在于 reader/shell.ts 一个实现。
//
// 扫描口径（源码文本级，tests/ 不在扫描范围）：
//  1. shell.ts 必须包含全部时序关键词（实现在场）；
//  2. replaceReaderModeUrl 的调用只允许出现在 shell.ts（reader-url.ts 仅为定义）；
//  3. 门控属性 setAttribute 写入只允许出现在 shell.ts 与 entry/content.ts
//     （后者是启动直达路径的同步预置翻转：先于设置水合把门控翻好，不属于
//     进入事务的八步时序，见工单 Comments）；
//  4. ensureReaderStyles 的调用只允许出现在 shell.ts 与 entry/content.ts（同上）；
//  5. enterReaderShell / exitReaderShell 只允许定义在 shell.ts；
//  6. 壳的调用方闭包 = message-handler（消息路由）+ ui-renderer（关闭按钮）+
//     digest-button（失同步守卫判定）三处，新增调用方须显式扩圈。
//
// 用 .js 落地：扫描要读 node:fs/node:path，tsconfig 未含 node 类型（与工单 01
// 的手势不变式扫描测试同款选择）。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const EXTENSION_ROOT = join(process.cwd(), "extension");

function listSourceFiles(dir) {
  const result = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      result.push(...listSourceFiles(full));
      continue;
    }
    if (/\.(ts|js)$/.test(entry)) {
      result.push(full);
    }
  }
  return result;
}

const sourceFileMap = new Map(
  listSourceFiles(EXTENSION_ROOT).map((file) => [
    relative(EXTENSION_ROOT, file).split(sep).join("/"),
    readFileSync(file, "utf8")
  ])
);
const read = (file) => sourceFileMap.get(file) ?? "";

const SHELL = "reader/shell.ts";

// 时序关键词：八步进入链 + 退出逆事务 + 壳完好性自查的实现在场证明
const SHELL_SEQUENCE_KEYWORDS = [
  "suppressUntil",
  "removePlayerAiQuickActionButton",
  "resolveReaderEntryUrl",
  "ensureUiReady",
  "replaceReaderModeUrl",
  "ensureReaderStyles",
  'setAttribute("data-boc-reader-mode"',
  "enterReaderMode",
  "closeReadingView",
  "removeReaderStyles",
  "isReaderShellIntact"
];

// 允许调用 replaceReaderModeUrl 的文件（reader-url.ts 是定义处，非调用）
const REPLACE_URL_ALLOWED = new Set(["bilibili/reader-url.ts", SHELL]);
// 门控属性写入的允许集（content.ts 为启动直达路径的同步预置翻转，非八步时序）
const GATE_ATTR_ALLOWED = new Set(["entry/content.ts", SHELL]);
// ensureReaderStyles 的允许集（style-injector.ts 是定义处，非调用）
const STYLES_ALLOWED = new Set(["shared/style-injector.ts", "entry/content.ts", SHELL]);
// 壳的调用方闭包
const SHELL_CALLERS = new Set([
  "core/message-handler.ts",
  "ui/ui-renderer.ts",
  "ui/digest-button.ts"
]);

describe("阅读壳序列唯一性（arch-slim/02 验收标准 1）", () => {
  it("reader/shell.ts 包含八步进入链与退出逆事务的全部时序关键词", () => {
    const text = read(SHELL);
    for (const keyword of SHELL_SEQUENCE_KEYWORDS) {
      expect(text.includes(keyword), `${SHELL} 缺少时序关键词 ${keyword}`).toBe(true);
    }
  });

  it("replaceReaderModeUrl 的调用只存在于 reader/shell.ts（URL 改写步骤唯一）", () => {
    const callers = [...sourceFileMap.keys()]
      .filter((file) => /replaceReaderModeUrl\s*\(/.test(read(file)))
      .sort();
    for (const file of callers) {
      expect(REPLACE_URL_ALLOWED.has(file), `replaceReaderModeUrl 出现在许可集之外：${file}`).toBe(true);
    }
    expect(callers).toContain(SHELL);
  });

  it("data-boc-reader-mode 门控属性写入只存在于 shell.ts 与启动预置（content.ts）", () => {
    const writers = [...sourceFileMap.keys()]
      .filter((file) => /setAttribute\("data-boc-reader-mode"/.test(read(file)))
      .sort();
    for (const file of writers) {
      expect(GATE_ATTR_ALLOWED.has(file), `门控属性写入出现在许可集之外：${file}`).toBe(true);
    }
    expect(writers).toContain(SHELL);
  });

  it("ensureReaderStyles 的调用只存在于 shell.ts 与启动预置（content.ts），style-injector 为定义处", () => {
    const callers = [...sourceFileMap.keys()]
      .filter((file) => /ensureReaderStyles\s*\(/.test(read(file)))
      .sort();
    for (const file of callers) {
      expect(STYLES_ALLOWED.has(file), `ensureReaderStyles 调用出现在许可集之外：${file}`).toBe(true);
    }
    expect(callers).toContain(SHELL);
  });

  it("enterReaderShell / exitReaderShell 只定义在 reader/shell.ts", () => {
    const definitions = [...sourceFileMap.keys()]
      .filter((file) => /export\s+(async\s+)?function\s+(enter|exit)ReaderShell/.test(read(file)))
      .sort();
    expect(definitions).toEqual([SHELL]);
  });

  it("壳的调用方闭包：message-handler / ui-renderer / digest-button 三处", () => {
    const importers = [...sourceFileMap.keys()]
      .filter((file) => /["'][^"']*reader\/shell\.js["']/.test(read(file)))
      .sort();
    expect(importers).toEqual([...SHELL_CALLERS].sort());
  });
});
