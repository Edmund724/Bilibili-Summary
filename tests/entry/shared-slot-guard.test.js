// 跨实例共享槽守卫（构建期守卫的接线锁，2026-09 双实例收口）：
//
// content 是两轮构建——常驻包（轮 A）与懒加载区（轮 B）把共享底座各装一份实例。
// 跨实例共享的可变状态必须挂 globalThis 槽（先例 shared/messaging.ts 的页内
// 分发槽），否则注册与消费落在两份实例上、静默错开。scripts/build-content.js 的
// assertSharedSlotsInBothRegions 按命名约定扫源码（`*_SLOT_KEY = "__BOC_...__"`），
// 构建后断言每个槽键在常驻包与至少一个懒加载区 chunk 里都出现。
//
// 本测试锁两件事（构建期守卫本身由 npm run build 每次跑）：
//   1. 守卫函数在场、且在 selfCheck 里被调用（删掉守卫要显式改这里）；
//   2. 五个共享槽模块各自仍按约定声明槽键——少一个，构建期守卫就发现不了它。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const BUILD_CONTENT = "scripts/build-content.js";

// 槽键命名约定：守卫据此扫源码。新增共享槽模块时补进本表。
const SLOT_KEY_PATTERN = /\b[A-Z_]*SLOT_KEY\s*=\s*"__BOC_[A-Z_]+__"/;
const SLOT_MODULES = [
  "extension/shared/messaging.ts", // 页内消息分发槽（先例）
  "extension/shared/logging.ts", // 调试日志门
  "extension/reader/reader-bus.ts", // reader-bus 槽表
  "extension/core/state.ts", // 状态单例
  "extension/shared/style-injector.ts" // 样式挂载记录
];

describe("跨实例共享槽守卫（构建期接线）", () => {
  it("build-content.js 声明守卫函数并在 selfCheck 里调用", () => {
    const text = read(BUILD_CONTENT);
    expect(text.includes("function assertSharedSlotsInBothRegions()")).toBe(true);
    // selfCheck 以守卫的返回值收尾——守卫失败即 selfCheck 失败（build fail fast）
    expect(text.includes("return assertSharedSlotsInBothRegions();")).toBe(true);
    // 扫描约定与两侧判据在场（防把守卫改成只看常驻包/只看 chunk）
    expect(text.includes("SLOT_KEY_DECLARATION")).toBe(true);
    expect(text.includes("不在常驻包")).toBe(true);
    expect(text.includes("不在任何懒加载区 chunk")).toBe(true);
  });

  it("五个共享槽模块各自按约定声明槽键（少一个守卫就漏一个）", () => {
    for (const rel of SLOT_MODULES) {
      expect(SLOT_KEY_PATTERN.test(read(rel)), `${rel} 未按约定声明 *_SLOT_KEY`).toBe(true);
    }
  });

  it("测试环境清槽清单覆盖全部共享槽键（新增槽必须同步）", () => {
    const setup = read("tests/setup.js");
    const keys = [];
    for (const rel of SLOT_MODULES) {
      const match = /"(__BOC_[A-Z_]+__)"/.exec(read(rel));
      expect(match, `${rel} 未找到槽键字面量`).not.toBe(null);
      keys.push(match[1]);
    }
    for (const key of keys) {
      expect(setup.includes(`delete globalThis.${key};`), `tests/setup.js 未清 ${key}`).toBe(true);
    }
  });
});
