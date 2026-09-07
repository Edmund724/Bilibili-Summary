// 对话分区 CSS 拆分守卫（arch-slim-4/07，照 reader-settings-css-split 模式）：
// reader.css 不得再含对话分区 .chat-* 规则，reader-chat.css 必须持有分区标记；
// style-injector 三件套与两个挂载点（setReaderDigestTab chat 分支同步挂载 +
// chat-tab 模块顶兜底）在场。防倒退：对话样式一旦回流主表，按需装载的 chunk
// 边就静默失效（主表常驻、分区表空挂）。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const READER_CSS = "extension/entry/styles/reader.css";
const CHAT_CSS = "extension/entry/styles/reader-chat.css";
const INJECTOR = "extension/shared/style-injector.ts";
const UI_RENDERER = "extension/ui/ui-renderer.ts";
const CHAT_TAB = "extension/reader/chat-tab.ts";
const BUILD_JS = "scripts/build.js";

// 对话分区样式标记：拆分前全部在 reader.css，拆分后只允许在 reader-chat.css。
// 不用裸串 boc-reading-chat——留守壳分区的 intent 卡（boc-reading-chat-intent-*）
// 与三 tab 共享滚动条（.boc-reading-chat .chat-messages 滚动条）合法引用同前缀。
const CHAT_MARKERS = [
  "chat-header",
  "chat-context-chip",
  "chat-thinking",
  "chat-suggestions",
  "chat-preset-",
  "chat-history-",
  "chat-center-error",
  "chat-timestamp-link",
  "chat-stop-btn"
];

describe("对话分区 CSS 拆分（arch-slim-4/07）", () => {
  it("reader.css 不含对话分区 .chat-* 规则（守卫回流）", () => {
    const text = read(READER_CSS);
    for (const marker of CHAT_MARKERS) {
      expect(text.includes(marker), `${READER_CSS} 仍含对话分区标记 ${marker}`).toBe(false);
    }
  });

  it("reader-chat.css 持有全部对话分区标记与分区头注", () => {
    const text = read(CHAT_CSS);
    for (const marker of CHAT_MARKERS) {
      expect(text.includes(marker), `${CHAT_CSS} 缺少标记 ${marker}`).toBe(true);
    }
    expect(text.includes("PR5 AI 对话 tab")).toBe(true);
  });

  it("壳常驻分区留守 reader.css（intent 卡 + 三 tab 共享滚动条）", () => {
    const text = read(READER_CSS);
    expect(text.includes("boc-reading-chat-intent")).toBe(true);
    expect(text).toMatch(/\.boc-reading-chat \.chat-messages::-webkit-scrollbar/);
  });

  it("style-injector 暴露对话表三件套（无 onload 门控）", () => {
    const injector = read(INJECTOR);
    expect(injector).toMatch(/export function ensureReaderChatStyles/);
    expect(injector).toMatch(/export function removeReaderChatStyles/);
    expect(injector).toMatch(/export function isReaderChatStylesMounted/);
    expect(injector).toMatch(/entry\/styles\/reader-chat\.css/);
    // 与设置表不同：不建 when/ready promise（grilling 决策——1-2 帧无样式窗口
    // 落在未激活的静默空态上，可接受）
    expect(injector.includes("whenReaderChatStylesReady")).toBe(false);
  });

  it("两个挂载点在场：setReaderDigestTab chat 分支 + chat-tab 模块顶兜底", () => {
    const renderer = read(UI_RENDERER);
    expect(renderer).toMatch(/if \(tab === "chat"\)\s*\{\s*ensureReaderChatStyles\(\);/);
    const chatTab = read(CHAT_TAB);
    // 模块顶层 ensure（settings-panel.ts 顶挂载先例：求值即挂表）
    expect(chatTab).toMatch(/^ensureReaderChatStyles\(\);/m);
  });

  it("build.js 持有 reader-chat.css 独立 minify 入口", () => {
    expect(read(BUILD_JS).includes("entry/styles/reader-chat.css")).toBe(true);
  });
});
