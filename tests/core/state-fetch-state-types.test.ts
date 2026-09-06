// clipState 两个并发状态字段的类型收窄验证（ticket ts-migration/13 重写版）：
// subtitleFetchState / noSubtitleReason 已收为字面量联合，集合外值（typo）在
// tsc --noEmit（typecheck 脚本覆盖 tests/**/*.ts）下编译被拒——本文件的负向
// 断言行就是验收：联合一旦放宽回 string，typecheck 会因「未使用的期望错误
// 指令」变红。各取值的运行时行为回归分别在
// tests/subtitle/fetcher-no-subtitle-reason.test.js、tests/subtitle/commit.test.js
// 与 tests/chat/no-subtitle.test.js 锁定，本文件不做行为断言。

import { describe, expect, it } from "vitest";
import type { NoSubtitleReason, SubtitleFetchState } from "../../extension/core/state.js";
import type { NoSubtitleReason as ChatNoSubtitleReason } from "../../extension/chat/no-subtitle.js";

describe("并发状态字段类型收窄（编译期负向用例）", () => {
  it("subtitleFetchState：联合外 typo 编译被拒", () => {
    // @ts-expect-error "loaidng" 不在 SubtitleFetchState 字面量联合内
    const typo: SubtitleFetchState = "loaidng";
    expect(typo).toBe("loaidng");
  });

  it("noSubtitleReason：联合外 typo 编译被拒", () => {
    // @ts-expect-error "asr-fail" 不在 NoSubtitleReason 字面量联合内
    const typo: NoSubtitleReason = "asr-fail";
    expect(typo).toBe("asr-fail");
  });

  it("chat 侧读边界类型 = core 联合 | undefined（单源不漂移）", () => {
    // 若 chat 镜像类型漂移回 string|null|undefined，typo 会被放行、负向指令变
    // 「未使用」而红——锁定单源指向 core 联合
    // @ts-expect-error "asr-fail" 不在 core 联合 | undefined 内
    const typo: ChatNoSubtitleReason = "asr-fail";
    expect(typo).toBe("asr-fail");
  });
});
