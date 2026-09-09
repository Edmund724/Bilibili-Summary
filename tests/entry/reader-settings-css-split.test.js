// 设置分区 CSS 拆分守卫（arch-slim-4/04，Q8 源码口径）：reader.css 不得再含
// 设置分区标记，reader-settings.css 必须持有；style-injector 三件套与
// settings-panel 顶挂载接线在场。防倒退：设置样式一旦回流主表，按需装载的
// chunk 边就静默失效（主表常驻、分区表空挂）。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const READER_CSS = "extension/entry/styles/reader.css";
const SETTINGS_CSS = "extension/entry/styles/reader-settings.css";
const INJECTOR = "extension/shared/style-injector.ts";
const SETTINGS_PANEL = "extension/ui/settings-panel.ts";
const BUILD_JS = "scripts/build.js";

// 设置分区样式标记：拆分前全部在 reader.css，拆分后只允许在 reader-settings.css
const SETTINGS_MARKERS = ["boc-reading-settings-host", "provider-editor-", "custom-select-"];

describe("设置分区 CSS 拆分（arch-slim-4/04）", () => {
  it("reader.css 不含设置分区标记（守卫回流）", () => {
    const text = read(READER_CSS);
    for (const marker of SETTINGS_MARKERS) {
      expect(text.includes(marker), `${READER_CSS} 仍含设置分区标记 ${marker}`).toBe(false);
    }
  });

  it("reader-settings.css 持有全部设置分区标记与 settings-panel 本体规则", () => {
    const text = read(SETTINGS_CSS);
    for (const marker of SETTINGS_MARKERS) {
      expect(text.includes(marker), `${SETTINGS_CSS} 缺少标记 ${marker}`).toBe(true);
    }
    expect(text.includes("boc-reading-settings-panel")).toBe(true);
  });

  it("自定义下拉样式只在阅读视图内匹配", () => {
    const selectorLines = read(SETTINGS_CSS)
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.includes(".custom-select-") && /[{,]\s*$/.test(line),
      );
    const unscopedSelectors = selectorLines.filter(
      (line) => !line.startsWith("#boc-reading-view "),
    );

    expect(selectorLines.length).toBeGreaterThan(0);
    expect(unscopedSelectors).toEqual([]);
  });

  it("壳静态模板的 settings-group 留守 reader.css（不随分区搬走）", () => {
    expect(read(READER_CSS).includes("boc-reading-settings-group")).toBe(true);
  });

  it("style-injector 暴露设置表三件套（ensure/whenReady），settings-panel 顶挂载接线", () => {
    const injector = read(INJECTOR);
    expect(injector).toMatch(/export function ensureReaderSettingsStyles/);
    expect(injector).toMatch(/export function whenReaderSettingsStylesReady/);
    expect(injector).toMatch(/entry\/styles\/reader-settings\.css/);

    const panel = read(SETTINGS_PANEL);
    // 模块顶层 ensure（player-ai.ts:29 先例：求值即挂表）
    expect(panel).toMatch(/ensureReaderSettingsStyles\(\)/);
    // 首建分支门控：等 onload ready 再渲染
    expect(panel).toMatch(/whenReaderSettingsStylesReady/);
  });

  it("build.js 持有 reader-settings.css 独立 minify 入口", () => {
    expect(read(BUILD_JS).includes("entry/styles/reader-settings.css")).toBe(true);
  });
});
