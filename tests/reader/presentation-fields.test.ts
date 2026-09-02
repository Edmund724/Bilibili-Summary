// 候选06 属性表半边：reader 呈现属性单一事实源（presentation-fields.js）不变量。
//
// 五个消费方（presentation 写入 / lifecycle close 移除 / page-state 守卫清理与
// 两份 attributeFilter / init-essentials storage 监听键）全部改为从表派生后，
// 本文件守住表自身的契约：
//   A. 表结构不变量（id 唯一 / 目标与 dataset 键派生一致 / 标志齐全）
//   B. 派生清单与表标志一致；close 与守卫两份移除清单的「真实差异」显式断言
//   C. storage 键 ↔ 字段一一对应，且全部落在 DEFAULT_SETTINGS 键面
//   D. 源码扫描：消费方与 CSS 中出现的每个 data-boc-* 属性要么在表里、
//      要么在 LOCAL_FLAG_ATTRIBUTES（防止手抄清单复活）
//   E. 行为：apply 真的写全 writtenByApply 字段；close 真的清全 clearOnClose
//      字段（含走样修正的 subtitle-visible）；守卫真的收敛 body 全集

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaderPresentationField } from "../../extension/reader/presentation-fields.js";
import {
  READER_PRESENTATION_FIELDS,
  READER_APPLY_FIELDS,
  READER_CLOSE_ATTRS,
  READER_GUARD_CLEAR_ATTRS,
  READER_GUARD_FILTER,
  READER_SETTINGS_WATCH_KEYS,
  LOCAL_FLAG_ATTRIBUTES
} from "../../extension/reader/presentation-fields.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { NORMAL_PAGE_URL, READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mockPlayerRects, mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

const TARGETS = ["html", "body", "readingView"] as const;
const VALID_KINDS = new Set(["presentation", "derived", "enter-flag", "view-flag", "settings"]);

// 连字符属性名 → dataset 驼峰键（浏览器 dataset 语义：去 "data-"，余下按 "-"
// 分段、首段原样、后继段首字母大写）。
function attrToDatasetKey(attr: string) {
  return attr
    .slice("data-".length)
    .split("-")
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

type AttrFlag = "clearOnClose" | "clearOnGuard" | "watchedByGuard";
type AttrTarget = "html" | "body" | "readingView";

// 按标志 × 目标从表手工推导属性清单（与 presentation-fields.js 的派生函数
// 独立实现，用于交叉验证；readingView 列同样要求 clearViewOnClose）。
function deriveAttrs(flag: AttrFlag, target: AttrTarget) {
  return READER_PRESENTATION_FIELDS
    .filter((field) => field[flag] && field.targets[target])
    .filter((field) => target !== "readingView" || field.clearViewOnClose)
    .map((field) => field.targets[target] as string);
}

// 表声明过的全部连字符属性名（含 readingView 短名）。
function allDeclaredAttrs() {
  return new Set(
    READER_PRESENTATION_FIELDS.flatMap((field) =>
      Object.values(field.targets).filter(Boolean)
    ) as string[]
  );
}

function targetNode(target: AttrTarget) {
  if (target === "html") return document.documentElement;
  if (target === "body") return document.body;
  return document.getElementById(ids.readingView) as HTMLElement;
}

let ids: Record<string, string>;
let shell: typeof import("../../extension/reader/index.js");
let presentation: typeof import("../../extension/reader/presentation.js");
let state: TestState;

async function loadModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  shell = await import("../../extension/reader/index.js");
  presentation = await import("../../extension/reader/presentation.js");
  ids = (await import("../../extension/reader/state.js")).ids;
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-boc-reader-mode");
  document.body.removeAttribute("data-boc-reader-mode");
  await loadModules();
  mountReaderSkeleton(ids);
  mountPlayerChain();
  mockPlayerRects();
});

afterEach(async () => {
  try {
    shell.stopReadingViewSync();
  } catch {
    // ignore
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("A. 表结构不变量", () => {
  it("id 在表内唯一", () => {
    const idsInTable = READER_PRESENTATION_FIELDS.map((field) => field.id);
    expect(new Set(idsInTable).size).toBe(idsInTable.length);
  });

  it("每个字段 targets/datasetKeys 三键齐全，且 dataset 键与属性名派生一致", () => {
    for (const field of READER_PRESENTATION_FIELDS) {
      for (const target of TARGETS) {
        expect(field.targets, `${field.id}.targets`).toHaveProperty(target);
        expect(field.datasetKeys, `${field.id}.datasetKeys`).toHaveProperty(target);
        // 有属性名必有 dataset 键，反之亦然（dataset 键是属性名的读写形态）
        expect(Boolean(field.targets[target])).toBe(Boolean(field.datasetKeys[target]));
        if (field.targets[target]) {
          expect(
            field.datasetKeys[target],
            `${field.id}.datasetKeys.${target} 应为 ${field.targets[target]} 的 dataset 形式`
          ).toBe(attrToDatasetKey(field.targets[target]));
        }
      }
    }
  });

  it("kind 取值合法；无任何落位目标的字段必须是 settings 键；writtenByApply ⇔ readValue", () => {
    for (const field of READER_PRESENTATION_FIELDS) {
      expect(VALID_KINDS.has(field.kind), `${field.id}.kind=${field.kind}`).toBe(true);
      const hasAnyTarget = Object.values(field.targets).some(Boolean);
      if (!hasAnyTarget) {
        expect(field.kind, `${field.id} 无落位目标，应为 settings 键`).toBe("settings");
        expect(field.storageKey, `${field.id} settings 键必须有 storageKey`).toBeTruthy();
      }
      if (field.writtenByApply) {
        expect(typeof field.readValue, `${field.id} 声明 apply 写入则必须有 readValue`).toBe("function");
      } else {
        expect(field.readValue, `${field.id} 不经 apply 写入则 readValue 应为 null`).toBe(null);
      }
    }
  });

  it("watchedByGuard/clearOnGuard/clearOnClose/clearViewOnClose 布尔标志齐全", () => {
    for (const field of READER_PRESENTATION_FIELDS) {
      for (const flag of ["watchedByGuard", "clearOnGuard", "clearOnClose", "clearViewOnClose"] as const) {
        expect(typeof field[flag], `${field.id}.${flag}`).toBe("boolean");
      }
      // clearViewOnClose 只对有 readingView 落位的字段有语义
      if (!field.targets.readingView) {
        expect(field.clearViewOnClose, `${field.id} 无 readingView 落位，clearViewOnClose 应为 false`).toBe(false);
      }
    }
  });
});

describe("B. 派生清单与表标志一致（真实差异显式化）", () => {
  it("三份派生清单与按标志手工推导一致（含顺序）", () => {
    for (const target of TARGETS) {
      expect(READER_CLOSE_ATTRS[target]).toEqual(deriveAttrs("clearOnClose", target));
      expect(READER_GUARD_CLEAR_ATTRS[target]).toEqual(deriveAttrs("clearOnGuard", target));
      expect(READER_GUARD_FILTER[target]).toEqual(deriveAttrs("watchedByGuard", target));
    }
  });

  it("守卫 filter 与守卫清理覆盖同一属性集（filter 存在的意义就是触发收敛清理）", () => {
    for (const target of ["html", "body"] as const) {
      expect([...READER_GUARD_FILTER[target]].sort()).toEqual([...READER_GUARD_CLEAR_ATTRS[target]].sort());
    }
  });

  it("修正锚点：subtitle-visible 同时在 close 与守卫两份清理清单（html/body）", () => {
    for (const target of ["html", "body"] as const) {
      expect(READER_CLOSE_ATTRS[target]).toContain("data-boc-reader-subtitle-visible");
      expect(READER_GUARD_CLEAR_ATTRS[target]).toContain("data-boc-reader-subtitle-visible");
    }
  });

  it("超集锚点：守卫 body 清单与 html 清单对称，仅差 reading-active（body 独有）", () => {
    const bodyOnly = READER_GUARD_CLEAR_ATTRS.body.filter((attr) => !READER_GUARD_CLEAR_ATTRS.html.includes(attr));
    expect(bodyOnly).toEqual(["data-boc-reading-active"]);
    const htmlOnly = READER_GUARD_CLEAR_ATTRS.html.filter((attr) => !READER_GUARD_CLEAR_ATTRS.body.includes(attr));
    expect(htmlOnly).toEqual([]);
  });

  it("close 与守卫的真实差异：close 额外清视图内标志 follow，守卫永不触碰视图", () => {
    expect(READER_CLOSE_ATTRS.readingView).toEqual(["data-boc-reader-follow"]);
    expect(READER_GUARD_CLEAR_ATTRS.readingView).toEqual([]);
    expect(READER_GUARD_FILTER.readingView).toEqual([]);
    // html/body 侧修正后两份清单完全一致（旧差异：close 漏 subtitle-visible、
    // 守卫 body 过窄——均已按正确超集对齐）
    expect(READER_CLOSE_ATTRS.html).toEqual(READER_GUARD_CLEAR_ATTRS.html);
    expect(READER_CLOSE_ATTRS.body).toEqual(READER_GUARD_CLEAR_ATTRS.body);
  });

  it("监听键集合包含实际读写键 readerChapterVisible 与旧键 readerChapterVisibility", () => {
    expect(READER_SETTINGS_WATCH_KEYS).toContain("readerChapterVisible");
    expect(READER_SETTINGS_WATCH_KEYS).toContain("readerChapterVisibility");
    expect(READER_SETTINGS_WATCH_KEYS).toContain("enablePlayerAiQuickAction");
    expect(READER_SETTINGS_WATCH_KEYS).toContain("playerAiQuickPrompt");
    expect(new Set(READER_SETTINGS_WATCH_KEYS).size).toBe(READER_SETTINGS_WATCH_KEYS.length);
  });
});

describe("C. storage 键 ↔ 字段一一对应", () => {
  it("全部 storageKey/legacyStorageKey 落在 DEFAULT_SETTINGS 键面内", () => {
    const settingsKeys = new Set(Object.keys(DEFAULT_SETTINGS));
    for (const field of READER_PRESENTATION_FIELDS) {
      if (field.storageKey) {
        expect(settingsKeys.has(field.storageKey), `${field.id}.storageKey=${field.storageKey}`).toBe(true);
      }
      if (field.legacyStorageKey) {
        expect(settingsKeys.has(field.legacyStorageKey), `${field.id}.legacyStorageKey=${field.legacyStorageKey}`).toBe(true);
      }
    }
  });

  it("storageKey/legacyStorageKey 全局唯一（监听键集合因此无重复覆盖）", () => {
    const keys = READER_PRESENTATION_FIELDS.flatMap((field) =>
      [field.storageKey, field.legacyStorageKey].filter(Boolean)
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(READER_SETTINGS_WATCH_KEYS.sort()).toEqual([...new Set(keys)].sort());
  });

  it("presentation 字段必有 storageKey；非 settings 字段必有落位目标", () => {
    for (const field of READER_PRESENTATION_FIELDS) {
      if (field.kind === "presentation") {
        expect(field.storageKey, `${field.id} 排版字段应绑定 storage 键`).toBeTruthy();
      }
      if (field.kind !== "settings") {
        expect(
          Object.values(field.targets).some(Boolean),
          `${field.id} 非 settings 字段应有落位目标`
        ).toBe(true);
      }
    }
  });
});

describe("D. 源码扫描：data-boc-* 属性字面量必须登记在案", () => {
  // 覆盖四个表驱动消费方 + 仍然直写 mode 的组合根/消息处理器 + CSS/模板/探针
  // 消费方。page-frame / sync 属端口半边的并行改造区，其属性均为
  // LOCAL 局部标志（keep/hidden 等），不纳入扫描面。
  const SCANNED_FILES = [
    "extension/reader/presentation.ts",
    "extension/reader/lifecycle.ts",
    "extension/reader/state.ts",
    "extension/reader/init-essentials.ts",
    "extension/entry/content.ts",
    "extension/core/message-handler.ts",
    "extension/ui/ui-renderer.ts",
    "extension/bilibili/video-probe.ts",
    "extension/entry/styles/reader-gate.css"
  ];
  const ATTR_PATTERN = /data-boc-(?:reader|reading)-[a-z-]+/g;

  it("扫描文件中出现的属性全部在表内或 LOCAL_FLAG_ATTRIBUTES 中", () => {
    const known = new Set([...allDeclaredAttrs(), ...LOCAL_FLAG_ATTRIBUTES]);
    for (const relPath of SCANNED_FILES) {
      const source = readFileSync(resolve(process.cwd(), relPath), "utf8");
      const found: string[] = [...new Set(source.match(ATTR_PATTERN) || [])];
      for (const attr of found) {
        expect(
          known.has(attr),
          `${relPath} 出现未登记属性 ${attr}：要么进 presentation-fields.js 主表，要么进 LOCAL_FLAG_ATTRIBUTES`
        ).toBe(true);
      }
    }
  });

  it("消费方不再手抄清单：page-state 与 init-essentials 中已无属性/监听键字面量", () => {
    for (const relPath of ["extension/reader/state.ts", "extension/reader/init-essentials.ts"]) {
      const source = readFileSync(resolve(process.cwd(), relPath), "utf8");
      expect(source.match(ATTR_PATTERN), `${relPath} 不应再出现属性字面量`).toBe(null);
      expect(source.includes("changes.reader"), `${relPath} 不应手抄 reader 监听键`).toBe(false);
    }
  });
});

describe("E. 行为：表声明的职责与 DOM 真实读写一致", () => {
  it("E1. apply 写全 writtenByApply 字段的三处目标，且不触碰其他字段", () => {
    state.reader.setTheme("dark");
    state.reader.setFontScale("xl");
    state.reader.setLetterSpacing("loose");
    state.reader.setLineHeight("loose");
    state.reader.setContentWidth("full");
    state.reader.setChapterVisible(false);
    state.reader.setSubtitleVisible(false);

    // 非 apply 字段预置值：apply 不得清除/覆写它们
    document.documentElement.setAttribute("data-boc-reader-mode", "1");
    document.body.setAttribute("data-boc-reading-active", "1");
    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    readingView.setAttribute("data-boc-reader-follow", "manual");
    readingView.setAttribute("data-has-chapters", "1");

    presentation.applyReadingViewPresentation();

    for (const field of READER_APPLY_FIELDS) {
      const expected = field.readValue!(state.reader);
      for (const target of TARGETS) {
        expect(
          targetNode(target).getAttribute(field.targets[target]!)!,
          `${field.id} @ ${target}`
        ).toBe(expected);
      }
    }
    // apply 不负责的字段原值保持
    expect(document.documentElement.getAttribute("data-boc-reader-mode")).toBe("1");
    expect(document.body.getAttribute("data-boc-reading-active")).toBe("1");
    expect(readingView.getAttribute("data-boc-reader-follow")).toBe("manual");
    expect(readingView.getAttribute("data-has-chapters")).toBe("1");
  });

  it("E2. closeReadingView 清全 clearOnClose 字段（含走样修正的 subtitle-visible）", async () => {
    state.clip.chapters = [{ title: "开场", from: 0 }];
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
    // 组合根语义：进入前 mode 由 content.js/message-handler 写
    document.documentElement.setAttribute("data-boc-reader-mode", "1");
    document.body.setAttribute("data-boc-reader-mode", "1");

    await shell.enterReaderMode();
    // 进入后确认属性确实已落位（否则 close 断言空转）
    expect(document.documentElement.getAttribute("data-boc-reader-subtitle-visible")).toBeTruthy();
    expect(document.documentElement.getAttribute("data-boc-reader-has-chapters")).toBeTruthy();
    expect(document.body.getAttribute("data-boc-reading-active")).toBe("1");

    shell.closeReadingView();
    await new Promise((resolve) => setTimeout(resolve, 150));

    for (const target of TARGETS) {
      for (const attr of READER_CLOSE_ATTRS[target]) {
        expect(
          targetNode(target).getAttribute(attr),
          `close 后 ${target} 的 ${attr} 应被清除`
        ).toBe(null);
      }
    }
  });

  it("E3. 守卫收敛：body 全集属性在非阅读页被清（filter 加宽生效），视图内 follow 不受守卫管辖", async () => {
    setLocationUrl(NORMAL_PAGE_URL);
    const pageState = await import("../../extension/reader/state.js");
    pageState.bindNormalPageStateGuard();

    // 旧 body filter 只有 3 项，theme/subtitle-visible 写入不触发收敛；
    // 表派生后为全集，写入即收敛清除。
    document.body.setAttribute("data-boc-reader-theme", "dark");
    document.body.setAttribute("data-boc-reader-subtitle-visible", "0");
    document.documentElement.setAttribute("data-boc-reader-subtitle-visible", "0");

    await vi.waitFor(() => {
      expect(document.body.getAttribute("data-boc-reader-theme")).toBe(null);
      expect(document.body.getAttribute("data-boc-reader-subtitle-visible")).toBe(null);
      expect(document.documentElement.getAttribute("data-boc-reader-subtitle-visible")).toBe(null);
    });

    // follow 是视图内标志（watchedByGuard=false）：守卫不监听也不清理
    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    readingView.setAttribute("data-boc-reader-follow", "manual");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readingView.getAttribute("data-boc-reader-follow")).toBe("manual");
  });
});
