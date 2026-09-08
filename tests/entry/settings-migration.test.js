// entry/settings-migration.ts 单测：2026-09 AI 键默认开迁移的一次性契约
//（纯函数契约：就地变异合并对象，storage 触碰归 background 的全量写）。
//
// 覆盖：
//   - 存量显式 false（旧版本全量落盘的历史默认值）+ 旗标未置位 → 改写回
//     新默认 true + 旗标置位；
//   - 旗标已置位 → 原样返回：用户此后显式关闭的值不被后续更新翻转；
//   - 存量 true / 键缺失（默认值兜底）→ 原样返回（每次更新重跑判断均为
//     no-op，无害）；
//   - 就地变异：返回对象与入参同引用（调用方依赖此约定并入全量写）。

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { applyPlayerAiQuickActionDefaultOnMigration } from "../../extension/entry/settings-migration.js";

describe("AI 键默认开一次性迁移", () => {
  it("存量显式 false + 旗标未置位 → 改写回 true + 旗标置位", () => {
    const merged = { ...DEFAULT_SETTINGS, enablePlayerAiQuickAction: false };

    const result = applyPlayerAiQuickActionDefaultOnMigration(merged);

    expect(result).toBe(merged);
    expect(result.enablePlayerAiQuickAction).toBe(true);
    expect(result.aiBtnDefaultOnMigrated).toBe(true);
  });

  it("旗标已置位 → 原样返回：用户显式关闭的值不被翻转", () => {
    const merged = {
      ...DEFAULT_SETTINGS,
      enablePlayerAiQuickAction: false,
      aiBtnDefaultOnMigrated: true
    };

    const result = applyPlayerAiQuickActionDefaultOnMigration(merged);

    expect(result.enablePlayerAiQuickAction).toBe(false);
    expect(result.aiBtnDefaultOnMigrated).toBe(true);
  });

  it("存量 true 或键缺失（默认值兜底）→ 原样返回", () => {
    for (const syncValue of [{ enablePlayerAiQuickAction: true }, {}]) {
      const merged = { ...DEFAULT_SETTINGS, ...syncValue };

      const result = applyPlayerAiQuickActionDefaultOnMigration(merged);

      expect(result).toBe(merged);
      expect(result.aiBtnDefaultOnMigrated).toBe(DEFAULT_SETTINGS.aiBtnDefaultOnMigrated);
    }
  });

  it("新默认值为 true（迁移存在的前提：默认翻转已发生）", () => {
    expect(DEFAULT_SETTINGS.enablePlayerAiQuickAction).toBe(true);
  });
});
