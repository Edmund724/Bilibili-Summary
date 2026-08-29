// shouldCloseAfterAsrTask（offscreen 文档 asr-decode 终态自关判定）纯函数测试：
// - 聊天端口数为 0 → 关（自关，释放渲染进程）
// - 还有聊天端口 → 保留
// - 计数异常（NaN/undefined）→ 保守保留

import { describe, expect, it } from "vitest";
import { shouldCloseAfterAsrTask } from "../../extension/entry/offscreen-lifecycle.js";

describe("shouldCloseAfterAsrTask", () => {
  it("聊天端口数为 0 → 关", () => {
    expect(shouldCloseAfterAsrTask(0)).toBe(true);
  });

  it("还有存活聊天端口 → 保留", () => {
    expect(shouldCloseAfterAsrTask(1)).toBe(false);
    expect(shouldCloseAfterAsrTask(3)).toBe(false);
  });

  it("计数异常（NaN/undefined）→ 保守保留文档", () => {
    expect(shouldCloseAfterAsrTask(NaN)).toBe(false);
    expect(shouldCloseAfterAsrTask(undefined)).toBe(false);
  });
});
