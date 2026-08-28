// 「成本护栏」纯函数模块（08 票）：
// 发起 Map-Reduce 前，若预估调用数 ≥COST_GUARD_MIN_CALLS 应向用户弹护栏提示
// 「预计约 N 次调用 / 约 X token，可取消」。预算内单次（=1 次调用）永不触发。
// 发送前弹护栏、用户可取消的 UI/消息接线由后续集成步骤负责；本模块只提供
// 阈值常量与两个纯函数，可直接复用预算器 plan.estimatedCalls / plan.estimatedTokens。

// 触发阈值：预估 ≥5 次调用才弹护栏。
export const COST_GUARD_MIN_CALLS = 5;

/**
 * 是否应弹成本护栏：estimatedCalls 为 ≥5 的有限数 → true；非数 / 负 / <5 → false。
 */
export function shouldPromptCostGuard(estimatedCalls) {
  const n = Number(estimatedCalls);
  return Number.isFinite(n) && n >= COST_GUARD_MIN_CALLS;
}

/**
 * 千分位格式化数字（如 1234567 → "1,234,567"）；非有限值回落到 "0"。
 */
export function formatThousands(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  const [intPart, fracPart] = String(Math.trunc(Math.abs(n))).split(".");
  const digits = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = n < 0 ? "-" : "";
  return fracPart ? `${sign}${digits}.${fracPart}` : `${sign}${digits}`;
}

/**
 * 构建成本护栏通知：{ shouldPrompt, message }。
 * message 形如「预计约 N 次调用 / 约 X token，可取消」（X 千分位）；
 * 与 shouldPromptCostGuard 同判，shouldPrompt 为 false 时 message 为空串。
 */
export function buildCostGuardNotice({ estimatedCalls, estimatedTokens } = {}) {
  if (!shouldPromptCostGuard(estimatedCalls)) {
    return { shouldPrompt: false, message: "" };
  }
  return {
    shouldPrompt: true,
    message: `预计约 ${estimatedCalls} 次调用 / 约 ${formatThousands(estimatedTokens)} token，可取消`
  };
}
