// clipState.noSubtitleReason 字段契约测试：
// 默认 null（不拦截、走通用文案）；setter 任意归一值可写入回读。
// 各业务写入/清除点（asr/fallback.js 终态分支写入、ready/reset 清 null）的
// 行为回归分别在 tests/subtitle/asr-fallback.test.js 与
// tests/subtitle/fetcher-no-subtitle-reason.test.js 锁定。

import { beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";
import { clipState } from "../../extension/core/state.js";

describe("clipState.noSubtitleReason", () => {
  beforeEach(() => {
    resetModuleState();
  });

  it("默认 null：未知/不适用，sidepanel 走通用文案", () => {
    expect(clipState.noSubtitleReason).toBe(null);
  });

  it("setter 回读：四类归一值均可写入", () => {
    for (const reason of ["no-asr-config", "asr-disabled", "asr-failed", "asr-empty"]) {
      clipState.setNoSubtitleReason(reason);
      expect(clipState.noSubtitleReason).toBe(reason);
    }
    clipState.setNoSubtitleReason(null);
    expect(clipState.noSubtitleReason).toBe(null);
  });
});
